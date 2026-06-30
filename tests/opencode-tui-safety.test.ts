/**
 * No-regression tests for the TUI corruption blindaje applied in tasks 01 and 02.
 *
 * Covers:
 * 1. Engram plugin hooks resolve without throwing when payloads are malformed
 *    (missing output.context / output.system / output.parts, undefined input.tool).
 * 2. GoalModePlugin returns {} without throwing when JORGEX_GOAL_DB is outside
 *    the allowed ~/.jorgex-stack/goals directory.
 */

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engram } from "../stack/plugins/opencode/engram.js";
import { GoalModePlugin } from "../stack/plugins/opencode/goal-plugin.js";

// ─── Saved env vars — restored after each test ───────────────────────────────

const originalEngramBin = process.env.ENGRAM_BIN;
const originalGoalDb = process.env.JORGEX_GOAL_DB;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();

  if (originalEngramBin === undefined) delete process.env.ENGRAM_BIN;
  else process.env.ENGRAM_BIN = originalEngramBin;

  if (originalGoalDb === undefined) delete process.env.JORGEX_GOAL_DB;
  else process.env.JORGEX_GOAL_DB = originalGoalDb;
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

// ─── GoalModePlugin — fail-safe initialisation ───────────────────────────────

describe("GoalModePlugin — fail-safe when JORGEX_GOAL_DB is outside allowed directory", () => {
  it("returns empty hooks object instead of throwing when DB path is rejected", async () => {
    // Point the DB to a temp path that is NOT inside ~/.jorgex-stack/goals.
    // resolveGoalDatabasePath() throws for any path outside that directory.
    // The GoalModePlugin try/catch must catch this and return {}.
    process.env.JORGEX_GOAL_DB = path.join(os.tmpdir(), "jx-safety-test-outside.sqlite");
    await expect(
      GoalModePlugin({ directory: process.cwd() } as any),
    ).resolves.toEqual({});
  });
});

// no cubierto: verificar que extractProjectName invoca Bun.spawnSync con
// stderr:"ignore". El stub de spawnSync captura llamadas pero asertear el
// segundo argumento exacto resulta frágil con el nivel actual de stubbing
// (Bun.spawnSync es llamado con múltiples patrones de args internamente).
// Se omite deliberadamente para evitar un falso verde que acople el test a
// detalles de implementación internos.
