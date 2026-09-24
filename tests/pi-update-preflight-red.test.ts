// Coverage for safe deliberate `update --agents pi` preflight.
//
// Desired GREEN contract in src/lib/pi-runtime.ts `preparePiRuntimeSystem` for
// operation "update" with targetDir undefined:
// - Validate engramBin absolute + detected.executable absolute; fail closed otherwise.
// - FIRST offline-auth the existing managed schema1 receipt from the fake
//   HOME/agent via `verifyOfflineManagedPiRelease` (mocked spy here; the unit
//   gate is already real-FS tested): the gate must receive the exact
//   receiptJson/settingsJson bytes read from the sandbox plus engramBin and a
//   `verifyManagedArtifact` callback wired to the real `verifyCachedPiArtifact`
//   (homeDir/downloadsDir). No mkdir/download/network may happen before it.
// - Only on gate ok call the existing `preparePiManagedInstall` preflight with
//   { homeDir, agentDir, downloadsDir } sandboxed under the fake HOME (agentDir
//   inside homeDir, downloadsDir absolute inside homeDir but outside agentDir,
//   never the real HOME); the preflight returns the prepared object itself
//   ({ candidate, stageDir, evidence, ... }) and the system returns
//   { candidate: result.candidate, prepared: result }.
// - When the gate denies, return its blocked reason with no preflight call, no
//   mkdir, no fetch, and original receipt/settings/foreign bytes stable.
// - With targetDir defined, never touch network: fail closed as blocked
//   target-dir before any gate/preflight/fetch.
//
// Topology (os.tmpdir sandbox only, never real HOME, no network):
// - fakeHome = sandbox/home (os.homedir spy), fakeAgentDir = fakeHome/agent
//   via PI_CODING_AGENT_DIR (scoped restoration), receipt at
//   fakeHome/.jorgex-stack/pi-receipt.json (outside agentDir, as the spec
//   requires), settings at fakeAgentDir/settings.json with the single exact
//   managed object { source, skills: [], prompts: [] }, foreign package file
//   under fakeAgentDir/npm/node_modules/foreign-pkg that must survive.
// - engramBin/piExecutable are absolute files under sandbox/bin.
// - global fetch is replaced with a recording thrower; gate-before-preflight
//   ordering plus no-downloads-mkdir on denied prove gate-before-mkdir/network
//   without spying ESM fs (vitest cannot spy node:fs mkdirSync).
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyOfflineManagedPiRelease: vi.fn(),
  preparePiManagedInstall: vi.fn(),
}));

vi.mock("../src/lib/pi-package-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-package-lifecycle.js")>();
  return { ...actual, verifyOfflineManagedPiRelease: mocks.verifyOfflineManagedPiRelease };
});

vi.mock("../src/lib/pi-install-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-install-preflight.js")>();
  return { ...actual, preparePiManagedInstall: mocks.preparePiManagedInstall };
});

const OLD_VERSION = "9.9.8";
const NEW_VERSION = "9.9.9";
const OLD_SOURCE = `npm:jorgex-pi@${OLD_VERSION}`;

type Sandbox = {
  sandbox: string;
  fakeHome: string;
  fakeAgentDir: string;
  receiptPath: string;
  settingsPath: string;
  foreignFile: string;
  engramBin: string;
  piExecutable: string;
  receiptJson: string;
  settingsJson: string;
  foreignBefore: string;
};

const sandboxes: string[] = [];
let homedirSpy: { mockRestore(): void } | null = null;
const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
const holder = globalThis as unknown as { fetch?: unknown };
let originalFetch: unknown = undefined;

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function setupSandbox(): Sandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-update-preflight-"));
  sandboxes.push(sandbox);
  const fakeHome = path.join(sandbox, "home");
  const fakeAgentDir = path.join(fakeHome, "agent");
  const receiptDir = path.join(fakeHome, ".jorgex-stack");
  const receiptPath = path.join(receiptDir, "pi-receipt.json");
  const settingsPath = path.join(fakeAgentDir, "settings.json");
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.mkdirSync(fakeAgentDir, { recursive: true });
  fs.mkdirSync(path.join(sandbox, "bin"), { recursive: true });

  const engramBin = path.join(sandbox, "bin", "engram");
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
  const piExecutable = path.join(sandbox, "bin", "pi");
  fs.writeFileSync(piExecutable, "#!/bin/sh\nexit 0\n");
  expect(path.isAbsolute(engramBin)).toBe(true);
  expect(path.isAbsolute(piExecutable)).toBe(true);

  const foreignDir = path.join(fakeAgentDir, "npm", "node_modules", "foreign-pkg");
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignFile = path.join(foreignDir, "index.js");
  fs.writeFileSync(foreignFile, "// foreign - must survive\nmodule.exports='foreign';\n");

  const receipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: "jorgex-pi", version: OLD_VERSION, source: OLD_SOURCE },
      tarball: {
        bytes: 32,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      provenance: { commit: "c".repeat(40) },
    },
    scope: { kind: "real", codingAgentDir: fakeAgentDir },
    engram: { binary: engramBin },
    managedPackage: {
      releaseDir: path.join(fakeAgentDir, "npm", "jorgex-pi-managed", "releases", "old-id"),
      linkPath: path.join(fakeAgentDir, "npm", "node_modules", "jorgex-pi"),
      backupDir: path.join(fakeAgentDir, "stage-deadbeef", "pi-agent", ".activate-backup"),
      lockSha256: "d".repeat(64),
      treeSha256: "e".repeat(64),
      dependencies: [],
    },
  };
  const receiptJson = JSON.stringify(receipt);
  const settingsJson = JSON.stringify({ packages: [{ source: OLD_SOURCE, skills: [], prompts: [] }] });
  fs.writeFileSync(receiptPath, `${receiptJson}\n`);
  fs.writeFileSync(settingsPath, settingsJson);

  // The receipt must live outside the agent dir; the agent dir must live
  // inside the fake HOME; nothing may point at the real HOME.
  expect(path.resolve(receiptPath).startsWith(path.resolve(fakeAgentDir) + path.sep)).toBe(false);
  expect(isStrictChild(fakeAgentDir, fakeHome)).toBe(true);
  expect(path.resolve(fakeHome).startsWith(path.resolve(os.tmpdir()))).toBe(true);

  return {
    sandbox,
    fakeHome,
    fakeAgentDir,
    receiptPath,
    settingsPath,
    foreignFile,
    engramBin,
    piExecutable,
    receiptJson,
    settingsJson,
    foreignBefore: fs.readFileSync(foreignFile, "utf8"),
  };
}

function stripNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      collectStrings((value as Record<string, unknown>)[key], into);
    }
  }
}

function expectSandboxedPreflightPaths(sandbox: Sandbox, paths: unknown): void {
  const record = paths as Record<string, unknown>;
  expect(record["homeDir"]).toBe(sandbox.fakeHome);
  expect(record["agentDir"]).toBe(sandbox.fakeAgentDir);
  expect(record["piExecutable"]).toBe(sandbox.piExecutable);
  const downloadsDir = record["downloadsDir"];
  expect(typeof downloadsDir).toBe("string");
  const downloads = downloadsDir as string;
  expect(path.isAbsolute(downloads)).toBe(true);
  expect(isStrictChild(downloads, sandbox.fakeHome)).toBe(true);
  expect(path.resolve(downloads) === path.resolve(sandbox.fakeAgentDir)).toBe(false);
  expect(isStrictChild(downloads, sandbox.fakeAgentDir)).toBe(false);
  // Sandboxed under the tmp sandbox root (never the real user HOME).
  expect(isStrictChild(downloads, sandbox.sandbox)).toBe(true);
  expect(path.resolve(sandbox.sandbox).startsWith(path.resolve(os.tmpdir()))).toBe(true);
}

beforeEach(() => {
  mocks.verifyOfflineManagedPiRelease.mockReset();
  mocks.preparePiManagedInstall.mockReset();
  originalFetch = holder.fetch;
});

afterEach(() => {
  holder.fetch = originalFetch;
  if (homedirSpy !== null) {
    homedirSpy.mockRestore();
    homedirSpy = null;
  }
  if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pi update preflight (preparePiRuntimeSystem update)", () => {
  it("authenticates the existing managed receipt before any mkdir/download/network and returns candidate+prepared on ok", async () => {
    const sandbox = setupSandbox();
    process.env["PI_CODING_AGENT_DIR"] = sandbox.fakeAgentDir;
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(sandbox.fakeHome);

    const events: string[] = [];
    const fetchCalls: string[] = [];
    holder.fetch = (...args: unknown[]) => {
      events.push("fetch");
      fetchCalls.push(String((args[0] as string | undefined) ?? "fetch"));
      throw new Error("network forbidden in update preflight test");
    };

    const synthCandidate = { package: { name: "jorgex-pi", version: NEW_VERSION, source: `npm:jorgex-pi@${NEW_VERSION}` } };
    const synthPrepared = {
      candidate: synthCandidate,
      stageDir: path.join(sandbox.fakeAgentDir, "stage-preflight"),
      evidence: { lockSha256: "f".repeat(64), treeSha256: "a".repeat(64), dependencies: [] },
    };

    mocks.verifyOfflineManagedPiRelease.mockImplementation((input: unknown, deps: unknown) => {
      events.push("verify");
      const strings: string[] = [];
      collectStrings(input, strings);
      // The gate must see the exact sandbox bytes (newline-stripped accepted).
      expect(strings).toContainEqual(sandbox.receiptJson);
      expect(strings).toContainEqual(stripNewline(sandbox.receiptJson));
      expect(strings).toContainEqual(sandbox.settingsJson);
      expect(strings).toContainEqual(sandbox.engramBin);
      expect(strings).toContainEqual(sandbox.fakeAgentDir);
      const record = deps as Record<string, unknown>;
      // The offline cached-tgz callback must be provided (wired to the real
      // verifyCachedPiArtifact in GREEN); it must be callable offline.
      expect(typeof record["verifyManagedArtifact"]).toBe("function");
      const parsed = JSON.parse(sandbox.receiptJson) as unknown;
      const probe = (record["verifyManagedArtifact"] as (receipt: unknown) => unknown)(parsed);
      expect(typeof probe).toBe("boolean");
      return { kind: "ok", receipt: JSON.parse(sandbox.receiptJson), realRoot: sandbox.fakeAgentDir };
    });
    mocks.preparePiManagedInstall.mockImplementation(async (paths: unknown) => {
      events.push("preflight");
      expectSandboxedPreflightPaths(sandbox, paths);
      return synthPrepared;
    });

    const { preparePiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const result = (await preparePiRuntimeSystem({
      operation: "update",
      targetDir: undefined,
      engramBin: sandbox.engramBin,
      detected: { executable: sandbox.piExecutable, version: "0.87.1" },
    })) as unknown as Record<string, unknown>;

    expect(mocks.verifyOfflineManagedPiRelease).toHaveBeenCalledTimes(1);
    expect(mocks.preparePiManagedInstall).toHaveBeenCalledTimes(1);
    expect(events).toContain("verify");
    expect(events).toContain("preflight");
    // The offline gate runs before the network-capable preflight (where any
    // mkdir/download would happen); fetch itself never runs (mocked preflight).
    expect(events.indexOf("verify")).toBeLessThan(events.indexOf("preflight"));
    expect(fetchCalls).toEqual([]);
    expect(events).not.toContain("fetch");

    // Return both the resolved candidate and its verified prepared stage.
    expect(result).toEqual({ candidate: synthPrepared.candidate, prepared: synthPrepared });
    expect(sandbox.fakeHome.startsWith(path.resolve(os.tmpdir()))).toBe(true);
  });

  it("returns the gate block without preflight/mkdir/network and leaves receipt/settings/foreign stable on denied", async () => {
    const sandbox = setupSandbox();
    process.env["PI_CODING_AGENT_DIR"] = sandbox.fakeAgentDir;
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(sandbox.fakeHome);

    const beforeReceipt = fs.readFileSync(sandbox.receiptPath, "utf8");
    const beforeSettings = fs.readFileSync(sandbox.settingsPath, "utf8");
    const beforeForeign = fs.readFileSync(sandbox.foreignFile, "utf8");
    const events: string[] = [];
    const fetchCalls: string[] = [];
    holder.fetch = (...args: unknown[]) => {
      events.push("fetch");
      fetchCalls.push(String((args[0] as string | undefined) ?? "fetch"));
      throw new Error("network forbidden in update preflight test");
    };

    mocks.verifyOfflineManagedPiRelease.mockImplementation(() => {
      events.push("verify");
      return { kind: "blocked", reason: "receipt-untrusted" };
    });
    mocks.preparePiManagedInstall.mockImplementation(async () => {
      events.push("preflight");
      throw new Error("preflight must not run when the offline gate denies");
    });

    const { preparePiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const result = (await preparePiRuntimeSystem({
      operation: "update",
      targetDir: undefined,
      engramBin: sandbox.engramBin,
      detected: { executable: sandbox.piExecutable, version: "0.87.1" },
    })) as unknown as Record<string, unknown>;

    expect(mocks.verifyOfflineManagedPiRelease).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["verify"]);
    expect(mocks.preparePiManagedInstall).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
    // No downloads mkdir happened after the denied gate: the homedir-derived
    // downloads location must still be absent.
    expect(fs.existsSync(path.join(sandbox.fakeHome, ".jorgex-stack", "packages"))).toBe(false);
    expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
    expect(fs.readFileSync(sandbox.receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readFileSync(sandbox.settingsPath, "utf8")).toBe(beforeSettings);
    expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toBe(beforeForeign);
  });

  it("fails closed for targetDir without gate/preflight/network", async () => {
    const sandbox = setupSandbox();
    process.env["PI_CODING_AGENT_DIR"] = sandbox.fakeAgentDir;
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(sandbox.fakeHome);

    const beforeReceipt = fs.readFileSync(sandbox.receiptPath, "utf8");
    const beforeSettings = fs.readFileSync(sandbox.settingsPath, "utf8");
    const events: string[] = [];
    holder.fetch = () => {
      events.push("fetch");
      throw new Error("network forbidden for targetDir update preflight");
    };
    mocks.verifyOfflineManagedPiRelease.mockImplementation(() => {
      events.push("verify");
      return { kind: "ok", receipt: JSON.parse(sandbox.receiptJson), realRoot: sandbox.fakeAgentDir };
    });
    mocks.preparePiManagedInstall.mockImplementation(async () => {
      events.push("preflight");
      throw new Error("preflight must never run with targetDir");
    });

    const { preparePiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const targetDir = path.join(sandbox.sandbox, "target");
    fs.mkdirSync(targetDir, { recursive: true });
    const result = (await preparePiRuntimeSystem({
      operation: "update",
      targetDir,
      engramBin: sandbox.engramBin,
      detected: { executable: sandbox.piExecutable, version: "0.87.1" },
    })) as unknown as Record<string, unknown>;

    expect(result).toMatchObject({ kind: "blocked" });
    expect(JSON.stringify(result)).toMatch(/target-dir/);
    expect(mocks.preparePiManagedInstall).not.toHaveBeenCalled();
    expect(mocks.verifyOfflineManagedPiRelease).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(fs.readFileSync(sandbox.receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readFileSync(sandbox.settingsPath, "utf8")).toBe(beforeSettings);
  });
});
