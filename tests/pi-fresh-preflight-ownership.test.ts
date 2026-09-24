// RED: fresh install preflight must fail closed when the owned entry probe is
// unreadable (EACCES) with no receipt.
//
// Desired GREEN contract in src/lib/pi-runtime.ts `preparePiRuntimeSystem`
// (operation "install", targetDir undefined): the cheap absence guard reads
// `dataDir()/pi-receipt.json` and, when absent, lstats the single owned entry
// `agentDir/npm/node_modules/jorgex-pi` read-only (never follow). An EACCES
// on that entry probe must block fail-closed BEFORE any costly external
// network as `{ kind: "blocked", reason: "unowned-entry-unreadable", remedy }`
// with no preflight/fetch/download-dir mkdir. The current guard catches the
// lstat error and silently CONTINUES to mkdir/download/install preflight,
// contrary to fail-closed.
//
// Topology (os.tmpdir sandbox only, never real HOME, no network):
// - sandbox/home is the fake HOME (os.homedir spy); sandbox/home/agent is the
//   fake PI_CODING_AGENT_DIR (scoped env restoration); sandbox/home/.jorgex-stack
//   is the fake dataDir (src/lib/paths.js mock); receipt absent by construction.
// - engramBin/piExecutable are absolute files under sandbox/bin.
// - fs.lstatSync spy throws EACCES only on the active entry path and delegates
//   to the original otherwise (so the receipt-absent probe stays truthful).
// - preparePiManagedInstall mock throws a sentinel if called (must not run);
//   global fetch is a recording thrower (must not run); the homedir-derived
//   downloads dir must stay absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxes: string[] = [];
let homedirSpy: { mockRestore(): void } | null = null;
let lstatSpy: { mockRestore(): void } | null = null;
const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
const holder = globalThis as unknown as { fetch?: unknown };
let originalFetch: unknown = undefined;

afterEach(() => {
  holder.fetch = originalFetch;
  originalFetch = undefined;
  if (homedirSpy !== null) {
    homedirSpy.mockRestore();
    homedirSpy = null;
  }
  if (lstatSpy !== null) {
    lstatSpy.mockRestore();
    lstatSpy = null;
  }
  if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
  vi.doUnmock("../src/lib/paths.js");
  vi.doUnmock("../src/lib/pi-install-preflight.js");
  vi.resetModules();
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pi fresh preflight ownership (unreadable entry fail-closed)", () => {
  it("blocks EACCES on the owned entry with no receipt before preflight/fetch/mkdir", async () => {
    const realTmp = path.resolve(os.tmpdir());
    const sandbox = fs.mkdtempSync(path.join(realTmp, "jx-pi-fresh-preflight-"));
    sandboxes.push(sandbox);
    const fakeHome = path.join(sandbox, "home");
    const fakeAgentDir = path.join(fakeHome, "agent");
    const fakeDataDir = path.join(fakeHome, ".jorgex-stack");
    const receiptPath = path.join(fakeDataDir, "pi-receipt.json");
    const activeEntry = path.join(fakeAgentDir, "npm", "node_modules", "jorgex-pi");
    const downloadsDir = path.join(fakeDataDir, "packages");
    fs.mkdirSync(fakeAgentDir, { recursive: true });
    fs.mkdirSync(fakeDataDir, { recursive: true });
    fs.mkdirSync(path.join(sandbox, "bin"), { recursive: true });
    const engramBin = path.join(sandbox, "bin", "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
    const piExecutable = path.join(sandbox, "bin", "pi");
    fs.writeFileSync(piExecutable, "#!/bin/sh\nexit 0\n");
    expect(path.isAbsolute(engramBin)).toBe(true);
    expect(path.isAbsolute(piExecutable)).toBe(true);

    // Fresh state: no receipt, so the guard must probe the owned entry.
    expect(fs.existsSync(receiptPath)).toBe(false);
    // Sandbox never escapes to the real user HOME.
    expect(path.resolve(fakeHome).startsWith(realTmp)).toBe(true);
    expect(path.resolve(fakeDataDir).startsWith(path.resolve(fakeHome) + path.sep)).toBe(true);
    expect(path.resolve(fakeAgentDir).startsWith(path.resolve(fakeHome) + path.sep)).toBe(true);

    process.env["PI_CODING_AGENT_DIR"] = fakeAgentDir;
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const fetchCalls: string[] = [];
    originalFetch = holder.fetch;
    holder.fetch = (...args: unknown[]) => {
      fetchCalls.push(String((args[0] as string | undefined) ?? "fetch"));
      throw new Error("network forbidden in fresh preflight ownership test");
    };

    const prepareCalls: unknown[] = [];
    const sentinel = new Error("sentinel-preflight-must-not-run");
    const mockPrepare = vi.fn(async (paths: unknown) => {
      prepareCalls.push(paths);
      throw sentinel;
    });

    vi.resetModules();
    vi.doMock("../src/lib/paths.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/paths.js")>(
        "../src/lib/paths.js",
      );
      return { ...actual, HOME: fakeHome, dataDir: () => fakeDataDir };
    });
    vi.doMock("../src/lib/pi-install-preflight.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-install-preflight.js")>(
        "../src/lib/pi-install-preflight.js",
      );
      return { ...actual, preparePiManagedInstall: mockPrepare };
    });

    // lstat spy AFTER resetModules/doMock so the fresh pi-runtime import shares
    // the same node:fs instance: EACCES only on the active entry, truthful
    // delegation otherwise (receipt-absent probe returns undefined).
    const originalLstat = fs.lstatSync.bind(fs);
    const eacces = new Error(`EACCES: permission denied, lstat '${activeEntry}'`) as NodeJS.ErrnoException;
    eacces.code = "EACCES";
    lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((target: unknown, opts: unknown) => {
      if (typeof target === "string" && path.resolve(target) === path.resolve(activeEntry)) {
        throw eacces;
      }
      return (originalLstat as (p: string, o: unknown) => unknown)(target as string, opts);
    }) as typeof fs.lstatSync);

    const { preparePiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const result = (await preparePiRuntimeSystem({
      operation: "install",
      targetDir: undefined,
      engramBin,
      detected: { executable: piExecutable, version: "0.87.1" },
    })) as unknown as Record<string, unknown>;

    // Fail-closed BEFORE any costly external network: unreadable ownership
    // blocks with a visible reason + remedy.
    expect(result).toMatchObject({ kind: "blocked", reason: "unowned-entry-unreadable" });
    expect(typeof result["remedy"]).toBe("string");
    expect(String(result["remedy"])).toMatch(/Pi no quedó activado/);

    // No acquisition side effects: no preflight, no fetch, no downloads mkdir.
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(prepareCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(fs.existsSync(downloadsDir)).toBe(false);
  });
});
