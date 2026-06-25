import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engram, resolveEngramBin } from "../stack/plugins/opencode/engram.js";

const originalEngramBin = process.env.ENGRAM_BIN;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalEngramBin === undefined) delete process.env.ENGRAM_BIN;
  else process.env.ENGRAM_BIN = originalEngramBin;
});

function stubBun(options: {
  which?: string | null;
  remoteUrl?: string;
  manifestExists?: boolean;
} = {}) {
  const spawn = vi.fn();
  const exists = vi.fn(async () => options.manifestExists ?? false);

  vi.stubGlobal("Bun", {
    which: vi.fn(() => options.which ?? null),
    spawnSync: vi.fn((args: string[]) => {
      if (args[3] === "remote") {
        return {
          exitCode: options.remoteUrl ? 0 : 1,
          stdout: options.remoteUrl ?? "",
        };
      }

      return { exitCode: 1, stdout: "" };
    }),
    spawn,
    file: vi.fn(() => ({
      exists,
    })),
  });

  return { spawn, exists };
}

describe("resolveEngramBin", () => {
  it("prefiere process.env.ENGRAM_BIN sobre Bun.which y el path inyectado", () => {
    process.env.ENGRAM_BIN = "env-engram";
    stubBun({ which: "bun-engram" });

    expect(resolveEngramBin("installer-engram")).toBe("env-engram");
  });

  it("usa Bun.which antes que el path inyectado", () => {
    stubBun({ which: "bun-engram" });

    expect(resolveEngramBin("installer-engram")).toBe("bun-engram");
  });

  it("usa el binario del instalador antes que el fallback cuando Bun.which no encuentra engram", () => {
    stubBun({ which: null });

    expect(resolveEngramBin("installer-engram")).toBe("installer-engram");
    expect(resolveEngramBin()).toBe("engram");
  });
});

describe("Engram session registration", () => {
  it("reintenta POST /sessions cuando recibe ok:false con un body JSON", async () => {
    stubBun({ remoteUrl: "https://github.com/jorgehn98/demo.git" });
    let sessionPosts = 0;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ ok: true }) } as any;
      }

      if (url.endsWith("/sessions")) {
        sessionPosts += 1;
        return {
          ok: false,
          json: async () => ({ ok: false, error: "duplicate session" }),
        } as any;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const plugin = await Engram({ directory: "C:\\repo\\demo" } as any);
    const event = {
      type: "session.created",
      properties: {
        info: {
          id: "session-1",
          parentID: null,
          title: "Chat",
        },
      },
    };

    await plugin.event({ event } as any);
    await plugin.event({ event } as any);

    expect(fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl).endsWith("/sessions"))).toHaveLength(2);
  });

  it("usa el binario resuelto para serve y sync --import", async () => {
    const { spawn } = stubBun({
      which: "resolved-engram",
      remoteUrl: "https://github.com/jorgehn98/demo.git",
      manifestExists: true,
    });

    vi.stubGlobal("setTimeout", ((callback: (...args: any[]) => void) => {
      callback();
      return 0 as any;
    }) as any);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return { ok: false, json: async () => ({ ok: false }) } as any;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Engram({ directory: "C:\\repo\\demo" } as any);

    expect(spawn).toHaveBeenCalledWith([
      "resolved-engram",
      "serve",
    ], expect.objectContaining({
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }));

    expect(spawn).toHaveBeenCalledWith([
      "resolved-engram",
      "sync",
      "--import",
    ], expect.objectContaining({
      cwd: "C:\\repo\\demo",
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }));
  });
});
