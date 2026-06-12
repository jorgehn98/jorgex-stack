import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  latestGithubRelease,
  latestGithubCommit,
  downloadRepoTarball,
  githubRateLimited,
  ghPresentButTokenFailed,
  __resetGithubState,
} from "../src/lib/github.js";

/**
 * Resuelve la ruta al ejecutable tar que entiende rutas Windows nativas.
 * En Windows con Git-MSYS instalado, "tar" apunta al tar MSYS que interpreta
 * "C:" como hostname de red y falla. El bsdtar del sistema (System32) sí
 * acepta rutas Windows. En Linux/macOS devuelve "tar" directamente.
 */
function resolveWindowsTar(): string {
  if (process.platform !== "win32") return "tar";
  const winTar = [process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe"].join(
    path.sep,
  );
  try {
    execFileSync(winTar, ["--version"], { stdio: "pipe" });
    return winTar;
  } catch {
    return "tar"; // fallback
  }
}

const TAR = resolveWindowsTar();

/**
 * Crea un fixture .tar.gz real con un directorio raíz rootName/ para simular
 * el formato de descarga de GitHub (GitHub empaqueta como "repo-sha/...").
 * Usa el tar resuelto por resolveWindowsTar() para manejar rutas Windows.
 */
function makeFixtureTarball(rootDir: string, tarPath: string, rootName: string): void {
  execFileSync(TAR, ["-czf", tarPath, "-C", path.dirname(rootDir), rootName], { stdio: "pipe" });
}

/**
 * PATH con el directorio del tar correcto al frente.
 * downloadRepoTarball llama a execFileSync("tar", ...) sin env explícito, por lo
 * que hereda process.env.PATH. Stubeando PATH ponemos el bsdtar de System32 antes
 * del tar MSYS de Git para que la extracción en los tests también funcione.
 */
function pathWithWindowsTar(): string {
  if (process.platform !== "win32") return process.env["PATH"] ?? "";
  const sys32 = [process.env["SystemRoot"] ?? "C:\\Windows", "System32"].join(path.sep);
  return sys32 + path.delimiter + (process.env["PATH"] ?? "");
}

// ---------------------------------------------------------------------------
// Único archivo del repo autorizado a usar vi.stubGlobal / vi.stubEnv.
// afterEach SIEMPRE restaura globals y env para no contaminar otros tests.
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  __resetGithubState();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-github-test-"));
  // Anular env vars de token presentes en la máquina del CI / desarrollador
  // para que los tests de "sin token" no fallen por variables heredadas.
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  // En Windows, poner el bsdtar de System32 antes del tar MSYS de Git para
  // que downloadRepoTarball pueda extraer con rutas Windows nativas.
  vi.stubEnv("PATH", pathWithWindowsTar());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// latestGithubRelease
// ---------------------------------------------------------------------------

describe("latestGithubRelease", () => {
  it('200 con tag_name "v1.2.3" → "1.2.3" (strip v)', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBe("1.2.3");
  });

  it('200 con tag_name "1.2.3" (sin v) → "1.2.3"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "1.2.3" }), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBe("1.2.3");
  });

  it("200 sin tag_name → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
  });

  it("500 → null, githubRateLimited() === false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(false);
  });

  it("403 → null Y githubRateLimited() === true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 403 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(true);
  });

  it("429 → null Y githubRateLimited() === true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(true);
  });

  it("fetch lanza → null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// latestGithubCommit
// ---------------------------------------------------------------------------

describe("latestGithubCommit", () => {
  it('200 [{sha: "abc123"}] → "abc123"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ sha: "abc123" }]), { status: 200 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBe("abc123");
  });

  it("200 [] (lista vacía) → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBeNull();
  });

  it("!ok → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token por cabeceras
// Observamos el token a través de las cabeceras que recibe el fetch stubeado,
// llamando a latestGithubRelease como punto de entrada público.
// ---------------------------------------------------------------------------

describe("token: precedencia y caché", () => {
  it("GH_TOKEN='aaa' + GITHUB_TOKEN='bbb' → Authorization Bearer aaa (GH_TOKEN gana)", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer aaa");
  });

  it("solo GITHUB_TOKEN='bbb' → Authorization Bearer bbb", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer bbb");
  });

  it("GH_TOKEN con espacios '  ccc  ' → Bearer ccc (trim aplicado)", async () => {
    vi.stubEnv("GH_TOKEN", "  ccc  ");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer ccc");
  });

  it("caché: segunda llamada usa token congelado aunque cambie el env", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await latestGithubRelease("owner/repo");
    // Cambiamos el env DESPUÉS de que el token ya esté cacheado
    vi.stubEnv("GH_TOKEN", "zzz");
    // Segunda llamada — debe seguir usando "aaa"
    await latestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer aaa");
  });

  it("tras __resetGithubState(), el token se recalcula con el env actual", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await latestGithubRelease("owner/repo");
    // Reset + cambio de env
    __resetGithubState();
    vi.stubEnv("GH_TOKEN", "zzz");
    // Tras el reset, debe leer "zzz"
    await latestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer zzz");
  });

  it("sin env vars y PATH vacío (gh no encontrado) → sin header Authorization, ghPresentButTokenFailed() === false", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    // PATH vacío para que lookPath("gh") no encuentre nada
    vi.stubEnv("PATH", "");
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
    expect(ghPresentButTokenFailed()).toBe(false);
  });

  // La rama "gh auth token" real no se cubre con vi.mock porque githubToken() es
  // privada (solo observable por headers) y mockear lookPath/runDetectedBin
  // requeriría inyección de dependencias o vi.mock del módulo interno.
  // Documentado como deliberadamente no cubierto.
});

// ---------------------------------------------------------------------------
// downloadRepoTarball — reasons de fallo
// ---------------------------------------------------------------------------

describe("downloadRepoTarball: reasons de fallo", () => {
  it("403 → ok:false, reason contiene 'HTTP 403' y 'rate limit', githubRateLimited()===true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("HTTP 403");
      expect(result.reason).toContain("rate limit");
    }
    expect(githubRateLimited()).toBe(true);
    // destDir limpiado tras fallo
    expect(fs.existsSync(destDir)).toBe(false);
  });

  it("200 con body null → ok:false, reason 'respuesta HTTP sin cuerpo'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("respuesta HTTP sin cuerpo");
    }
  });

  it("fetch lanza TimeoutError → ok:false, reason 'timeout de descarga (120s)'", async () => {
    const timeoutErr = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout de descarga (120s)");
    }
  });

  it("fetch lanza Error normal → ok:false, reason empieza por 'fallo de red:'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.startsWith("fallo de red:")).toBe(true);
    }
  });

  it("validateSubdir='../fuera' → ok:false, reason contiene 'escapa del destino'", async () => {
    // Necesitamos que fetch devuelva un tarball válido para llegar a la validación del subdir.
    // Creamos un tarball mínimo real.
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "file.txt"), "hola\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir, "../fuera");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("escapa del destino");
    }
  });

  it("validateSubdir='no-existe' → { ok:true, validated:false } (subdir ausente, sin crash)", async () => {
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "file.txt"), "hola\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir, "no-existe");

    expect(result).toEqual({ ok: true, validated: false });
  });
});

// ---------------------------------------------------------------------------
// downloadRepoTarball — happy path con tarball real
// ---------------------------------------------------------------------------

describe("downloadRepoTarball: happy path", () => {
  it("tarball válido → { ok:true, validated:true } y archivos extraídos presentes (strip-components)", async () => {
    // Crea el fixture: un tar.gz con directorio raíz "repo-abc123/" (simula el formato de GitHub)
    // --strip-components=1 eliminará ese prefijo al extraer, dejando solo el contenido.
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "README.md"), "# test\n");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export {};\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result).toEqual({ ok: true, validated: true });
    // strip-components=1: los archivos deben estar directamente bajo destDir, sin el prefijo repo-abc123/
    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
  });
});
