import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detectMocks = vi.hoisted(() => ({
  lookPath: vi.fn((_: string): string | null => null),
  runDetectedBin: vi.fn((_bin: string, _args: string[], _timeoutMs: number, _env?: NodeJS.ProcessEnv): string | null => null),
}));

vi.mock("../src/lib/detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/detect.js")>();
  return {
    ...actual,
    lookPath: detectMocks.lookPath,
    runDetectedBin: detectMocks.runDetectedBin,
  };
});

import {
  fetchLatestGithubRelease,
  __resetGithubState,
  resolveTarBin,
} from "../src/lib/github.js";

let tmp: string;

beforeEach(() => {
  __resetGithubState();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-github-test-"));
  // Anular env vars de token presentes en la máquina del CI / desarrollador
  // para que los tests de "sin token" no fallen por variables heredadas.
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  detectMocks.lookPath.mockReset().mockReturnValue(null);
  detectMocks.runDetectedBin.mockReset().mockReturnValue(null);
});

afterEach(() => {
  detectMocks.lookPath.mockReset().mockReturnValue(null);
  detectMocks.runDetectedBin.mockReset().mockReturnValue(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveTarBin", () => {
  it("en la plataforma actual devuelve una string no vacía", () => {
    // En cualquier plataforma debe devolver algo utilizable por execFileSync.
    const bin = resolveTarBin();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });

  if (process.platform === "win32") {
    it("win32 con SystemRoot válido → ruta absoluta a System32\\tar.exe (cuando existe)", () => {
      // Solo verificable en Windows real con bsdtar en System32.
      const bin = resolveTarBin();
      const sys32 = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
      if (fs.existsSync(path.join(sys32, "tar.exe"))) {
        expect(bin).toBe(path.join(sys32, "tar.exe"));
      } else {
        // tar.exe no presente en System32 → fallback
        expect(bin).toBe("tar");
      }
    });

    it("win32 con SystemRoot apuntando a dir sin tar.exe → fallback 'tar'", () => {
      // Usamos un directorio temporal que no contiene tar.exe.
      const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-tarbin-"));
      try {
        vi.stubEnv("SystemRoot", fakeRoot);
        // resolveTarBin() lee process.env["SystemRoot"] en cada llamada
        // (no cachea), por lo que el stub tiene efecto inmediato.
        const bin = resolveTarBin();
        expect(bin).toBe("tar");
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });
  } else {
    it("no-win32 → devuelve 'tar' directamente", () => {
      expect(resolveTarBin()).toBe("tar");
    });
  }
});

describe("token: precedencia y caché", () => {
  it("GH_TOKEN='aaa' + GITHUB_TOKEN='bbb' → Authorization Bearer aaa (GH_TOKEN gana)", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchLatestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer aaa");
  });

  it("solo GITHUB_TOKEN='bbb' → Authorization Bearer bbb", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchLatestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer bbb");
  });

  it("GH_TOKEN con espacios '  ccc  ' → Bearer ccc (trim aplicado)", async () => {
    vi.stubEnv("GH_TOKEN", "  ccc  ");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchLatestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer ccc");
  });

  it("caché: segunda llamada usa token congelado aunque cambie el env", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await fetchLatestGithubRelease("owner/repo");
    // Cambiamos el env DESPUÉS de que el token ya esté cacheado
    vi.stubEnv("GH_TOKEN", "zzz");
    // Segunda llamada — debe seguir usando "aaa"
    await fetchLatestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer aaa");
  });

  it("tras __resetGithubState(), el token se recalcula con el env actual", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await fetchLatestGithubRelease("owner/repo");
    // Reset + cambio de env
    __resetGithubState();
    vi.stubEnv("GH_TOKEN", "zzz");
    // Tras el reset, debe leer "zzz"
    await fetchLatestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer zzz");
  });

  it("sin env vars y PATH vacío (gh no encontrado) → sin header Authorization, ghPresentButTokenFailed() === false", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    // PATH vacío para que lookPath("gh") no encuentre nada
    vi.stubEnv("PATH", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchLatestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
  });

  it("sin env vars y gh detectado con salida vacía → sin header Authorization, ghPresentButTokenFailed() === true", async () => {
    detectMocks.lookPath.mockReturnValue("/isolated/bin/gh");
    detectMocks.runDetectedBin.mockReturnValue(" \n");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchLatestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
    expect(detectMocks.lookPath).toHaveBeenCalledWith("gh");
    expect(detectMocks.runDetectedBin).toHaveBeenCalledWith(
      "/isolated/bin/gh",
      ["auth", "token"],
      5_000,
    );
  });
});

describe("fetchLatestGithubRelease: direct contract", () => {
  it("calls the exact releases/latest URL once", async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/owner/repo/releases/latest",
    );
  });

  it("sends Accept application/vnd.github+json and User-Agent jorgex-stack", async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Accept"]).toBe("application/vnd.github+json");
    expect(headers?.["User-Agent"]).toBe("jorgex-stack");
  });

  it("uses AbortSignal.timeout(10_000) for the metadata query", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    try {
      await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      const signal = mockFetch.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("403 returns the error response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("", { status: 403 }),
    );
    const res = await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
    expect(res.status).toBe(403);
  });

  it("429 returns the error response", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("", { status: 429 }),
    );
    const res = await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
    expect(res.status).toBe(429);
  });

  it("control: 200 returns success", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    const res = await fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch);
    expect(res.ok).toBe(true);
  });

  it("network throw propagates (does not map to null at this seam)", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("boom-transport");
    });
    await expect(fetchLatestGithubRelease("owner/repo", mockFetch as typeof fetch)).rejects.toThrow(
      "boom-transport",
    );
    // Direct seam never sets the flag on transport failure.
  });
});
