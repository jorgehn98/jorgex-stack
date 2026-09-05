/**
 * No-regression tests for the TUI corruption blindaje applied in tasks 01 and 02.
 *
 * Covers:
 * 1. Engram plugin hooks resolve without throwing when payloads are malformed
 *    (missing output.context / output.system / output.parts, undefined input.tool).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engram } from "../stack/plugins/opencode/engram.js";

// ─── Saved env vars — restored after each test ───────────────────────────────

const originalEngramBin = process.env.ENGRAM_BIN;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();

  if (originalEngramBin === undefined) delete process.env.ENGRAM_BIN;
  else process.env.ENGRAM_BIN = originalEngramBin;
});

// ─── Stub helpers ─────────────────────────────────────────────────────────────

/**
 * Stubs Bun and fetch in a way that lets the Engram plugin initialise without
 * trying to launch a real binary or reach a real HTTP server.
 *
 * - Health check returns ok:true so the plugin skips the Bun.spawn path.
 * - All other fetch calls return ok:false (engramFetch returns null → safe).
 * - Bun.spawnSync (used by extractProjectName git calls) returns exitCode:1
 *   so the project name falls back to the directory basename.
 * - Bun.file().exists() returns false so the sync-import path is skipped.
 */
function stubBunAndFetchForSafety() {
  vi.stubGlobal("Bun", {
    which: vi.fn(() => null),
    spawnSync: vi.fn(() => ({ exitCode: 1, stdout: "" })),
    spawn: vi.fn(),
    file: vi.fn(() => ({ exists: vi.fn(async () => false) })),
  });

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/health")) {
      return { ok: true, json: async () => ({ ok: true }) } as any;
    }
    // All other Engram HTTP calls (POST /sessions, GET /context, etc.) return
    // not-ok so engramFetch returns null instead of throwing.
    return { ok: false, json: async () => null } as any;
  }));
}

// ─── Engram hooks — malformed payload safety ──────────────────────────────────

describe("Engram plugin hooks — no propagation on malformed payloads", () => {
  it("experimental.session.compacting resolves when output has no context array", async () => {
    stubBunAndFetchForSafety();
    const plugin = await Engram({ directory: process.cwd() } as any);
    // Before the blindaje: output.context.push(...) would throw TypeError.
    // After: the safe() wrapper catches and swallows it.
    await expect(
      plugin["experimental.session.compacting"]!({ sessionID: "s" }, {} as any),
    ).resolves.toBeUndefined();
  });

  it("experimental.chat.system.transform resolves when output.system is undefined", async () => {
    stubBunAndFetchForSafety();
    const plugin = await Engram({ directory: process.cwd() } as any);
    // output.system.length throws if output.system is undefined.
    await expect(
      plugin["experimental.chat.system.transform"]!({}, {} as any),
    ).resolves.toBeUndefined();
  });

  it("chat.message resolves when output has no parts array", async () => {
    stubBunAndFetchForSafety();
    const plugin = await Engram({ directory: process.cwd() } as any);
    // output.parts.filter(...) throws if output.parts is undefined.
    await expect(
      plugin["chat.message"]!({ sessionID: "s" }, {} as any),
    ).resolves.toBeUndefined();
  });

  it("tool.execute.after resolves when input.tool is undefined", async () => {
    stubBunAndFetchForSafety();
    const plugin = await Engram({ directory: process.cwd() } as any);
    // input.tool.toLowerCase() throws if input.tool is undefined.
    // Output is a plain string to avoid any secondary null-deref in the hook body.
    await expect(
      plugin["tool.execute.after"]!({ sessionID: "s" } as any, "x" as any),
    ).resolves.toBeUndefined();
  });
});

// no cubierto: verificar que extractProjectName invoca Bun.spawnSync con
// stderr:"ignore". El stub de spawnSync captura llamadas pero asertear el
// segundo argumento exacto resulta frágil con el nivel actual de stubbing
// (Bun.spawnSync es llamado con múltiples patrones de args internamente).
// Se omite deliberadamente para evitar un falso verde que acople el test a
// detalles de implementación internos.

// ─── Engram plugin hooks — error logging ────────────────────────────────────

describe("Engram plugin hooks — error logging to OpenCode TUI", () => {
  it("logs hook errors to app.log with service, level, message and serialized extra", async () => {
    const appLog = vi.fn();
    stubBunAndFetchForSafety();
    const plugin = await Engram({
      directory: process.cwd(),
      client: { app: { log: appLog } },
    } as any);

    // Force a throw: experimental.session.compacting expects output.context to be an array.
    // Passing {} makes output.context undefined → TypeError on output.context.push(…).
    await expect(
      plugin["experimental.session.compacting"]!({ sessionID: "s" }, {} as any),
    ).resolves.toBeUndefined();

    // logToOpenCode calls log.call(app, …) synchronously before its first await,
    // so by the time the hook promise resolves the call is already recorded.
    expect(appLog).toHaveBeenCalledOnce();
    const arg = appLog.mock.calls[0]![0] as {
      body: { service: string; level: string; message: string; extra: unknown };
    };
    expect(arg.body.service).toBe("engram");
    expect(arg.body.level).toBe("error");
    expect(arg.body.message).toContain("experimental.session.compacting");
    expect(arg.body.extra).toMatchObject({ message: expect.any(String), stack: expect.any(String) });
  });

  it("app.log that rejects does not produce an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const rejectionHandler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", rejectionHandler);

    stubBunAndFetchForSafety();
    const plugin = await Engram({
      directory: process.cwd(),
      client: { app: { log: () => Promise.reject(new Error("ipc closed")) } },
    } as any);

    try {
      await expect(
        plugin["experimental.session.compacting"]!({ sessionID: "s" }, {} as any),
      ).resolves.toBeUndefined();

      // One microtask tick: logToOpenCode's internal try/catch absorbs the rejection
      // before Node.js can classify it as unhandled.
      await Promise.resolve();

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", rejectionHandler);
    }
  });
});

// ─── Engram plugin hooks — event with absent properties ─────────────────────

describe("Engram plugin hooks — event with absent properties", () => {
  it("event hook resolves cleanly when properties field is absent from the payload", async () => {
    stubBunAndFetchForSafety();
    const plugin = await Engram({ directory: process.cwd() } as any);

    // Before the fix: accessing event.properties.info.id without optional chaining
    // would throw TypeError when properties is undefined.
    // After the fix: optional chaining handles the absent field gracefully.
    await expect(
      plugin.event!({ event: { type: "session.created" } }),
    ).resolves.toBeUndefined();
  });
});
