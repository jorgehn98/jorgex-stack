import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { inventoryTreeSha256, materializeStagedPiRuntimeDependencies } from "../src/lib/pi-staged-lock.js";
import { stageVerifiedPiTarball } from "../src/lib/pi-release-stage.js";
import { buildStagedPiCandidate } from "../src/lib/pi-candidate.js";
import { inspectPiHostVersion } from "../src/lib/pi-host-version.js";
import { runPiStageProcess } from "../src/lib/pi-stage-process.js";
import type { PiProviderPackage } from "../src/lib/pi-provider-activation.js";
import {
  isInstalledNativePackage,
  parseNativeMcpAuthorityStrict,
  removeNativeMcpEntries,
  restoreOwnedWrite,
  writeNativeMcpConfig,
} from "../src/lib/pi-native-mcp.js";
import {
  reconcileNativeAuthorityAfterCleanup,
  runNativePiMcpPhase,
} from "../src/lib/pi-native-phase.js";

/**
 * Native consumer phase (`runNativePiMcpPhase`) at the real-FS seam;
 * entrypoints exist as regular files but are never imported.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const HEX = "a".repeat(64);
const NATIVE_CONTRACT = {
  schemaVersion: 1,
  capability: "mcp-native-v1",
  transport: "native",
  configurationPath: "PI_CODING_AGENT_DIR/mcp.json",
  packageReceiptPath: "HOME/.jorgex-stack/pi-receipt.json",
  projectionReceiptPath: "HOME/.jorgex-stack/pi-projection-receipt.json",
  authorityField: "mcpNative",
  servers: ["engram", "context7", "chrome-devtools"],
  definitions: {
    entrypoint: "extensions/mcp-engram.mjs",
    digestExport: "digestNativeMcpDefinition",
    devtoolsExport: "resolveNativeDevtoolsDefinition",
  },
  ownership: {
    entrypoint: "extensions/native-mcp.mjs",
    export: "inspectNativeMcpOwnership",
  },
} as const;

interface Fixture {
  readonly root: string;
  readonly homeDir: string;
  readonly agentDir: string;
  readonly stageDir: string;
  readonly engramBin: string;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-native-phase-"));
  roots.push(root);
  return {
    root,
    homeDir: path.join(root, "home"),
    agentDir: path.join(root, "agent"),
    stageDir: path.join(root, "stage"),
    engramBin: path.join(root, "bin", "engram"),
  };
}

/** A contract-valid stage; the entrypoints exist as regular files but are never imported. */
function stageWithContract(f: Fixture, contract: unknown = NATIVE_CONTRACT): string {
  const packageRoot = path.join(f.stageDir, "npm", "node_modules", "jorgex-pi");
  fs.mkdirSync(path.join(packageRoot, "contract"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "contract", "native-mcp.v1.json"), JSON.stringify(contract));
  for (const entrypoint of ["extensions/mcp-engram.mjs", "extensions/native-mcp.mjs"]) {
    fs.writeFileSync(path.join(packageRoot, entrypoint), 'throw new Error("must not execute");\n');
  }
  return f.stageDir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function managedReceipt(f: Fixture): void {
  writeJson(path.join(f.homeDir, ".jorgex-stack", "pi-receipt.json"), {
    schemaVersion: 1,
    state: "installed",
    candidate: { package: { name: "jorgex-pi", version: "0.8.40", source: "npm:jorgex-pi@0.8.40" } },
    scope: { codingAgentDir: f.agentDir },
    managedPackage: {},
  });
}

function projectionReceipt(f: Fixture, mcpNative: unknown): void {
  writeJson(path.join(f.homeDir, ".jorgex-stack", "pi-projection-receipt.json"), {
    schemaVersion: 1,
    scope: { kind: "real", home: f.homeDir, codingAgentDir: f.agentDir, receiptFile: path.join(f.homeDir, ".jorgex-stack", "pi-projection-receipt.json") },
    owned: [],
    mcpNative,
  });
}

function writeMcp(agentDir: string, servers: Record<string, unknown>): void {
  writeJson(path.join(agentDir, "mcp.json"), { mcpServers: servers });
}

const phaseInput = (f: Fixture, fresh: boolean) => ({
  homeDir: f.homeDir,
  agentDir: f.agentDir,
  engramBin: f.engramBin,
  piExecutable: process.execPath,
  stageDir: f.stageDir,
  fresh,
});

describe("[T75] native MCP phase blocks before any effect", () => {
  it("rejects a stage that does not carry the validated native contract", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.stageDir, "npm", "node_modules", "jorgex-pi"), { recursive: true });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-contract-invalid" });
    expect(fs.existsSync(f.agentDir)).toBe(false);
  });

  it("rejects a stage whose contract drifts from the Stack native policy", async () => {
    const f = fixture();
    stageWithContract(f, { ...NATIVE_CONTRACT, transport: "legacy" });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-contract-invalid" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks a fresh install when a managed receipt already exists", async () => {
    const f = fixture();
    stageWithContract(f);
    managedReceipt(f);
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-fresh-conflict" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks an update without the authenticated managed receipt", async () => {
    const f = fixture();
    stageWithContract(f);
    const result = await runNativePiMcpPhase(phaseInput(f, false));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-update-unauthenticated" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks an update whose managed receipt is malformed", async () => {
    const f = fixture();
    stageWithContract(f);
    fs.mkdirSync(path.join(f.homeDir, ".jorgex-stack"), { recursive: true });
    fs.writeFileSync(path.join(f.homeDir, ".jorgex-stack", "pi-receipt.json"), "{ not json");
    const result = await runNativePiMcpPhase(phaseInput(f, false));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-state-invalid" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks a malformed granular native authority instead of inventing absence", async () => {
    const f = fixture();
    stageWithContract(f);
    projectionReceipt(f, { schemaVersion: 1, entries: { engram: { definitionSha256: "not-a-digest" } } });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-state-invalid" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks a native authority whose scope does not match the target", async () => {
    const f = fixture();
    stageWithContract(f);
    writeJson(path.join(f.homeDir, ".jorgex-stack", "pi-projection-receipt.json"), {
      schemaVersion: 1,
      scope: { kind: "real", home: path.join(f.root, "elsewhere"), codingAgentDir: f.agentDir, receiptFile: "x" },
      owned: [],
      mcpNative: { schemaVersion: 1, entries: { engram: { definitionSha256: HEX } } },
    });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-state-invalid" });
  });

  it("blocks a claimed native server that is missing from mcp.json instead of recreating it", async () => {
    const f = fixture();
    stageWithContract(f);
    managedReceipt(f);
    projectionReceipt(f, { schemaVersion: 1, entries: { engram: { definitionSha256: HEX } } });
    const result = await runNativePiMcpPhase(phaseInput(f, false));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-claimed-absent" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("blocks an unowned context7 entry instead of adopting it by identity", async () => {
    const f = fixture();
    stageWithContract(f);
    writeMcp(f.agentDir, { context7: { url: "https://mcp.context7.com/mcp" } });
    const before = fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8");
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-config-conflict" });
    expect(fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8")).toBe(before);
  });

  it("blocks an unowned engram entry whose definition differs from the official one", async () => {
    const f = fixture();
    stageWithContract(f);
    writeMcp(f.agentDir, { engram: { command: "/somewhere/else/engram", args: ["mcp", "--tools=agent"] } });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-config-conflict" });
  });

  it("blocks a non-record existing native entry", async () => {
    const f = fixture();
    stageWithContract(f);
    writeMcp(f.agentDir, { engram: "not-an-object" });
    const result = await runNativePiMcpPhase(phaseInput(f, true));
    expect(result).toMatchObject({ kind: "blocked", reason: "native-config-conflict" });
  });
});

describe("[T77] native target isolation scope", () => {
  it("rejects an injected provider stage without an explicit target scope", async () => {
    const f = fixture();
    stageWithContract(f);
    const result = await runNativePiMcpPhase({
      ...phaseInput(f, true),
      providerStage: buildProviderStage(f.root, "injected"),
    });
    expect(result).toMatchObject({ kind: "blocked", reason: "native-provider-stage-requires-target" });
    expect(fs.existsSync(path.join(f.agentDir, "mcp.json"))).toBe(false);
  });

  it("rejects a target scope whose home/agent do not resolve to the canonical relation", async () => {
    const f = fixture();
    stageWithContract(f);
    const target = path.join(f.root, "target");
    fs.mkdirSync(target, { recursive: true });
    const result = await runNativePiMcpPhase({
      homeDir: path.join(target, "elsewhere"),
      agentDir: path.join(target, "pi-agent"),
      engramBin: f.engramBin,
      piExecutable: process.execPath,
      stageDir: f.stageDir,
      fresh: true,
      bootstrapDirs: true,
      targetDir: target,
      providerStage: buildProviderStage(target, "injected"),
    });
    expect(result).toMatchObject({ kind: "blocked", reason: "native-target-scope-mismatch" });
    expect(fs.existsSync(path.join(target, "pi-agent"))).toBe(false);
  });

  it("rejects a target root that is a symlink before any effect", async () => {
    const f = fixture();
    stageWithContract(f);
    const real = path.join(f.root, "real-target");
    fs.mkdirSync(path.join(real, "home"), { recursive: true });
    fs.mkdirSync(path.join(real, "pi-agent"), { recursive: true });
    const link = path.join(f.root, "link-target");
    fs.symlinkSync(real, link, "dir");
    const result = await runNativePiMcpPhase({
      homeDir: path.join(link, "home"),
      agentDir: path.join(link, "pi-agent"),
      engramBin: f.engramBin,
      piExecutable: process.execPath,
      stageDir: f.stageDir,
      fresh: true,
      bootstrapDirs: true,
      targetDir: link,
      providerStage: buildProviderStage(real, "injected"),
    });
    expect(result).toMatchObject({ kind: "blocked", reason: "native-target-scope-invalid" });
    expect(fs.existsSync(path.join(link, "pi-agent", "mcp.json"))).toBe(false);
  });

  it("rejects an injected provider stage that escapes the validated target root", async () => {
    const f = fixture();
    stageWithContract(f);
    const target = path.join(f.root, "target");
    fs.mkdirSync(target, { recursive: true });
    const result = await runNativePiMcpPhase({
      homeDir: path.join(target, "home"),
      agentDir: path.join(target, "pi-agent"),
      engramBin: f.engramBin,
      piExecutable: process.execPath,
      stageDir: f.stageDir,
      fresh: true,
      bootstrapDirs: true,
      targetDir: target,
      providerStage: buildProviderStage(f.root, "outside"),
    });
    expect(result).toMatchObject({ kind: "blocked", reason: "native-provider-stage-invalid" });
    expect(fs.existsSync(path.join(target, "pi-agent"))).toBe(false);
  });
});

describe("[T75] native granular authority and config file IO", () => {
  it("strictly parses the granular authority and rejects malformed shapes", () => {
    expect(parseNativeMcpAuthorityStrict(undefined)).toBeNull();
    expect(parseNativeMcpAuthorityStrict({ schemaVersion: 1, entries: { engram: { definitionSha256: HEX, cleanupSha256: HEX } } }))
      .toEqual({ schemaVersion: 1, entries: { engram: { definitionSha256: HEX, cleanupSha256: HEX } } });
    for (const bad of [
      { schemaVersion: 2, entries: {} },
      { schemaVersion: 1, entries: { unknown: { definitionSha256: HEX } } },
      { schemaVersion: 1, entries: { engram: { definitionSha256: "short" } } },
      { schemaVersion: 1, entries: { engram: { definitionSha256: HEX, cleanupSha256: "x" } } },
      { schemaVersion: 1, entries: { engram: { definitionSha256: HEX, extra: true } } },
      { schemaVersion: 1, entries: { engram: { definitionSha256: HEX, cleanupSha256: HEX, extra: true } } },
    ]) {
      expect(() => parseNativeMcpAuthorityStrict(bad)).toThrow(/pi-native-mcp/);
    }
  });

  it("refuses to write mcp.json when the bytes changed concurrently and preserves them", () => {
    const f = fixture();
    fs.mkdirSync(f.agentDir, { recursive: true });
    writeMcp(f.agentDir, { foreign: { command: "keep" } });
    const snapshot = { file: path.join(f.agentDir, "mcp.json"), raw: fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8"), parsed: JSON.parse(fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8")) as Record<string, unknown>, servers: {} };
    const concurrent = `${JSON.stringify({ mcpServers: { foreign: { command: "concurrent" } } }, null, 2)}\n`;
    fs.writeFileSync(path.join(f.agentDir, "mcp.json"), concurrent);
    expect(() => writeNativeMcpConfig({
      agentDir: f.agentDir,
      servers: [{ name: "engram", entry: { command: f.engramBin, args: ["mcp", "--tools=agent"] }, created: true }],
      expectedRaw: snapshot.raw,
      expectedParsed: snapshot.parsed,
    })).toThrow(/changed concurrently/);
    expect(fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8")).toBe(concurrent);
  });

  it("writes the native servers, preserves every other key, and reads back its own bytes", () => {
    const f = fixture();
    fs.mkdirSync(f.agentDir, { recursive: true });
    writeJson(path.join(f.agentDir, "mcp.json"), { theme: "keep", mcpServers: { foreign: { command: "keep" } } });
    const raw = fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8");
    const result = writeNativeMcpConfig({
      agentDir: f.agentDir,
      servers: [
        { name: "engram", entry: { command: f.engramBin, args: ["mcp", "--tools=agent"] }, created: true },
        { name: "context7", entry: { url: "https://mcp.context7.com/mcp" }, created: true },
      ],
      expectedRaw: raw,
      expectedParsed: JSON.parse(raw) as Record<string, unknown>,
      backupRoot: path.join(f.root, "backups"),
    });
    const written = JSON.parse(fs.readFileSync(result.file, "utf8")) as Record<string, unknown>;
    expect(written.theme).toBe("keep");
    expect(written.mcpServers).toEqual({
      foreign: { command: "keep" },
      engram: { command: f.engramBin, args: ["mcp", "--tools=agent"] },
      context7: { url: "https://mcp.context7.com/mcp" },
    });
    expect(result.previousRaw).toBe(raw);
    expect(result.writtenRaw).toBe(fs.readFileSync(result.file, "utf8"));
  });

  it("removes only the named native entries and keeps foreign servers", () => {
    const f = fixture();
    fs.mkdirSync(f.agentDir, { recursive: true });
    writeMcp(f.agentDir, {
      engram: { command: f.engramBin, args: ["mcp", "--tools=agent"] },
      context7: { url: "https://mcp.context7.com/mcp" },
      foreign: { command: "keep" },
    });
    const raw = fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8");
    removeNativeMcpEntries({
      agentDir: f.agentDir,
      names: ["engram"],
      expectedRaw: raw,
      expectedParsed: JSON.parse(raw) as Record<string, unknown>,
    });
    expect(JSON.parse(fs.readFileSync(path.join(f.agentDir, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { context7: { url: "https://mcp.context7.com/mcp" }, foreign: { command: "keep" } },
    });
  });

  it("restores previous bytes only while the file still holds this write", () => {
    const f = fixture();
    fs.mkdirSync(f.agentDir, { recursive: true });
    const file = path.join(f.agentDir, "mcp.json");
    fs.writeFileSync(file, "own");
    expect(restoreOwnedWrite(file, "own", "previous")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("previous");
    fs.writeFileSync(file, "someone else");
    expect(restoreOwnedWrite(file, "own", "previous")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("someone else");
  });
});

describe("[T75] native uninstall authority reconciliation", () => {
  it("drops removed claims and releases cleanup stamps on retained personalized entries", () => {
    const f = fixture();
    const receiptFile = path.join(f.homeDir, ".jorgex-stack", "pi-projection-receipt.json");
    writeJson(receiptFile, {
      schemaVersion: 1,
      scope: { kind: "real", home: f.homeDir, codingAgentDir: f.agentDir, receiptFile },
      owned: ["/kept/owned"],
      devtools: { sha256: HEX },
      mcpNative: { schemaVersion: 1, entries: {
        engram: { definitionSha256: HEX, cleanupSha256: HEX },
        context7: { definitionSha256: HEX, cleanupSha256: HEX },
        "chrome-devtools": { definitionSha256: HEX },
      } },
    });
    reconcileNativeAuthorityAfterCleanup({
      homeDir: f.homeDir,
      agentDir: f.agentDir,
      removable: ["engram"],
      ownership: {
        servers: {
          engram: { state: "managed", cleanupEligible: true, availability: "configured" },
          context7: { state: "managed", cleanupEligible: false, availability: "configured" },
          "chrome-devtools": { state: "unowned", cleanupEligible: false, availability: "configured" },
        },
        package: { state: "verified" },
        connection: "not-verified",
      },
      backupRoot: path.join(f.root, "backups"),
    });
    const next = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
    expect(next.owned).toEqual(["/kept/owned"]);
    expect(next.devtools).toEqual({ sha256: HEX });
    expect(next.mcpNative).toEqual({ schemaVersion: 1, entries: {
      context7: { definitionSha256: HEX },
      "chrome-devtools": { definitionSha256: HEX },
    } });
  });

  it("is a no-op when the projection receipt is absent", () => {
    const f = fixture();
    const absent = { state: "absent", cleanupEligible: false, availability: "unavailable" } as const;
    expect(() => reconcileNativeAuthorityAfterCleanup({
      homeDir: f.homeDir,
      agentDir: f.agentDir,
      removable: ["engram"],
      ownership: { servers: { engram: absent, context7: absent, "chrome-devtools": absent }, package: { state: "not-required" }, connection: "not-verified" },
    })).not.toThrow();
    expect(fs.existsSync(path.join(f.homeDir, ".jorgex-stack", "pi-projection-receipt.json"))).toBe(false);
  });
});

// --- Managed native selection: legacy owned installs stay legacy ------------
//
// `resolveActivePiEntry` reports the canonical managed entry link as an owned
// install. The legacy managed layout *is* exactly that link pointing at a
// release whose root contract never declared the native transport, so the
// selection must read the root contract and keep it out of the native branch.
// A release that does declare `mcp-native-v1`/`mcpNative` must still block when
// its `contract/native-mcp.v1.json` is missing or malformed — the selection is
// not allowed to blanket `catch -> false`.
//
// The root-contract shapes below are explicit test fixtures that state the
// metadata intent under test; they are not a claim about the real publisher.

const LEGACY_ROOT_CONTRACT = {
  schemaVersion: 1,
  package: { name: "jorgex-pi", version: "0.8.38", source: "npm:jorgex-pi@0.8.38" },
  capabilities: ["foundation-contract-v1", "stack-snapshot-v2"],
} as const;

const NATIVE_ROOT_CONTRACT = {
  ...LEGACY_ROOT_CONTRACT,
  capabilities: [...LEGACY_ROOT_CONTRACT.capabilities, "mcp-native-v1"],
  mcpNative: { schemaVersion: 1, contractPath: "contract/native-mcp.v1.json" },
} as const;

describe("[T77] managed native selection keeps legacy owned installs out of the native branch", () => {
  it("treats an owned legacy release as legacy and still blocks a native-declared release whose native contract is missing or malformed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-managed-legacy-"));
    roots.push(root);
    const target = path.join(root, "target");
    const agentDir = path.join(target, "pi-agent");
    const npmDir = path.join(agentDir, "npm");
    const nodeModules = path.join(npmDir, "node_modules");
    const linkPath = path.join(nodeModules, "jorgex-pi");
    const releaseId = "b".repeat(64);
    const releasePackageRoot = path.join(npmDir, "jorgex-pi-managed", "releases", releaseId, "node_modules", "jorgex-pi");
    fs.mkdirSync(nodeModules, { recursive: true });

    // Canonical owned topology: one relative link into a real release root.
    const ownRelease = (contract: unknown, nativeFile: "absent" | "malformed" | "valid"): void => {
      fs.rmSync(releasePackageRoot, { recursive: true, force: true });
      fs.rmSync(linkPath, { force: true });
      fs.mkdirSync(path.join(releasePackageRoot, "contract"), { recursive: true });
      writeJson(path.join(releasePackageRoot, "package.json"), { name: "jorgex-pi", version: "0.8.38" });
      writeJson(path.join(releasePackageRoot, "contract", "jorgex-pi.v1.json"), contract);
      if (nativeFile === "malformed") {
        writeJson(path.join(releasePackageRoot, "contract", "native-mcp.v1.json"), { schemaVersion: 1, capability: "mcp-native-v1" });
      } else if (nativeFile === "valid") {
        fs.mkdirSync(path.join(releasePackageRoot, "extensions"), { recursive: true });
        writeJson(path.join(releasePackageRoot, "contract", "native-mcp.v1.json"), NATIVE_CONTRACT);
        for (const entrypoint of [NATIVE_CONTRACT.definitions.entrypoint, NATIVE_CONTRACT.ownership.entrypoint]) {
          fs.writeFileSync(path.join(releasePackageRoot, entrypoint), 'throw new Error("must not execute");\n');
        }
      }
      const relative = path.relative(nodeModules, releasePackageRoot);
      expect(relative.startsWith("..")).toBe(true);
      fs.symlinkSync(relative, linkPath, "dir");
    };

    // The package/projection sub-systems are doubles: this test proves the
    // native selection, and nothing here may read the real HOME or run Pi.
    vi.resetModules();
    const benignPackage = vi.fn(async () => ({
      kind: "blocked" as const,
      reason: "test-benign",
      remedy: "subsystem double; the managed native selection is what this test proves.",
    }));
    vi.doMock("../src/lib/pi-runtime.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/pi-runtime.js")>("../src/lib/pi-runtime.js")),
      runPiRuntimeSystem: benignPackage,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/pi-projection-lifecycle.js")>("../src/lib/pi-projection-lifecycle.js")),
      preparePiProjectionUninstallSystem: () => ({ kind: "blocked" as const, reason: "test-benign", remedy: "subsystem double." }),
    }));
    try {
      const managed = await import("../src/lib/pi-managed-runtime.js") as typeof import("../src/lib/pi-managed-runtime.js");
      const detected = { executable: process.execPath, version: "0.0.0" };
      const run = (operation: "doctor" | "sync" | "models" | "uninstall") =>
        managed.runManagedPiSystem({ operation, targetDir: target, nativeLayout: true, detected, engramBin: null });

      // (1) Strict control: a native-declared release still blocks when its
      // native contract file is missing or malformed — the selection is not
      // allowed to blanket `catch -> false`.
      ownRelease(NATIVE_ROOT_CONTRACT, "absent");
      expect(() => isInstalledNativePackage(agentDir)).toThrow();
      expect(await run("doctor")).toMatchObject({ kind: "blocked", reason: "native-installed-invalid" });
      ownRelease(NATIVE_ROOT_CONTRACT, "malformed");
      expect(() => isInstalledNativePackage(agentDir)).toThrow();
      expect(await run("doctor")).toMatchObject({ kind: "blocked", reason: "native-installed-invalid" });

      // (2) Independent positive: a valid native release still selects native.
      ownRelease(NATIVE_ROOT_CONTRACT, "valid");
      expect(isInstalledNativePackage(agentDir)).toBe(true);

      // (3) Regression: an owned legacy release selects the legacy branch.
      ownRelease(LEGACY_ROOT_CONTRACT, "absent");
      expect(isInstalledNativePackage(agentDir)).toBe(false);
      for (const operation of ["doctor", "sync", "models", "uninstall"] as const) {
        const result = await run(operation);
        expect(result, `${operation}: ${JSON.stringify(result)}`).not.toMatchObject({ reason: "native-installed-invalid" });
      }
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.resetModules();
    }
  });
});

// --- Live authoritative flow against the observed published artifact --------
//
// Skipped only when NO live configuration is present. When any of
// JORGEX_PI_LIVE_ARTIFACT / PI_TEST_CANDIDATE / PI_TEST_HOST / JORGEX_PI_BIN is
// set, the configuration must be complete and valid: a missing artifact, a
// malformed candidate, or an unresolved host CLI throws instead of skipping, so
// a misconfigured CI lane falls closed. The Pi CLI is resolved from the
// already-acquired `PI_TEST_HOST` node_modules/.bin layout (the same binding
// `pi-linked-smoke-live` uses), never from a personal install. The digest and
// ownership exports come from the real artifact, never a vendored copy.

interface LiveIdentity {
  readonly version: string;
  readonly integrity: string;
  readonly sha256: string;
  readonly sha512: string;
  readonly bytes: number;
  readonly tarballUrl: string;
}

const PI_0840_IDENTITY: LiveIdentity = {
  version: "0.8.40",
  integrity: "sha512-4XCx7isCiwvRLcIIPZvjP1wfjuAR6AvblfqCjbLwQUUtC7+X/73U8feXC7x3xryjCNp3K99rMIUUQqn4BgpzLQ==",
  sha256: "51747ae0c643c6bff3fdf9b6639bcbc65426305cce2b46de3c2d0a49dcf61b26",
  sha512: "",
  bytes: 316551,
  tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.40.tgz",
};

function readCandidateIdentity(file: string): LiveIdentity {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const version = parsed.version, integrity = parsed.integrity, sha256 = parsed.sha256, sha512 = parsed.sha512, bytes = parsed.bytes, tarballUrl = parsed.tarballUrl;
  if (typeof version !== "string" || typeof integrity !== "string" || typeof sha256 !== "string"
    || typeof sha512 !== "string" || typeof bytes !== "number" || typeof tarballUrl !== "string") {
    throw new Error("live native verification: PI_TEST_CANDIDATE is malformed");
  }
  return { version, integrity, sha256, sha512, bytes, tarballUrl };
}

interface LiveEnv {
  readonly artifactPath: string;
  readonly piExecutable: string;
  readonly identity: LiveIdentity;
}

function resolveLiveEnv(): LiveEnv | null {
  const artifactPath = process.env.JORGEX_PI_LIVE_ARTIFACT;
  const explicitBin = process.env.JORGEX_PI_BIN;
  const host = process.env.PI_TEST_HOST;
  const candidate = process.env.PI_TEST_CANDIDATE;
  if (artifactPath === undefined && explicitBin === undefined && host === undefined && candidate === undefined) {
    return null;
  }
  if (artifactPath === undefined || !fs.existsSync(artifactPath)) {
    throw new Error(`live native verification: JORGEX_PI_LIVE_ARTIFACT must point at the acquired tarball (${artifactPath ?? "unset"})`);
  }
  const piExecutable = explicitBin ?? (host !== undefined
    ? path.join(host, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi")
    : undefined);
  if (piExecutable === undefined || !fs.existsSync(piExecutable)) {
    throw new Error(`live native verification: no Pi CLI resolved (${piExecutable ?? "set JORGEX_PI_BIN or PI_TEST_HOST"})`);
  }
  return { artifactPath, piExecutable, identity: candidate !== undefined ? readCandidateIdentity(candidate) : PI_0840_IDENTITY };
}

const LIVE = resolveLiveEnv();

/** A verified provider stage double: the acquisition boundary, not the FS contract. */
function buildProviderStage(homeDir: string, suffix: string): { stageDir: string; packages: PiProviderPackage[] } {
  const stageDir = path.join(homeDir, `provider-stage-${suffix}`);
  const packageRoot = path.join(stageDir, "gentle-engram", "pi-agent", "npm", "node_modules", "gentle-engram");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "gentle-engram", version: "9.1.0", bin: { "gentle-engram": "cli.js" } }));
  fs.writeFileSync(path.join(packageRoot, "cli.js"), "new");
  return {
    stageDir,
    packages: [{
      name: "gentle-engram",
      version: "9.1.0",
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      packageRoot,
      treeSha256: inventoryTreeSha256(packageRoot),
      bins: { "gentle-engram": "cli.js" },
    }],
  };
}

function managedReceiptAt(homeDir: string, agentDir: string): void {
  writeJson(path.join(homeDir, ".jorgex-stack", "pi-receipt.json"), {
    schemaVersion: 1,
    state: "installed",
    candidate: { package: { name: "jorgex-pi", version: LIVE!.identity.version, source: `npm:jorgex-pi@${LIVE!.identity.version}` } },
    scope: { codingAgentDir: agentDir },
    managedPackage: {},
  });
}

interface LiveStage {
  readonly stageDir: string;
  readonly artifact: { path: string; bytes: number; sha256: string; sha512: string };
  readonly release: { version: string; tarballUrl: string; integrity: string };
  readonly evidence: { lockSha256: string; treeSha256: string; dependencies: Array<{ name: string; version: string; integrity: string }> };
}

let liveRoot = "";
let liveStage: LiveStage | undefined;

(LIVE === null ? describe.skip : describe)("[T77] native consumer against the observed published Pi artifact", () => {
  beforeAll(async () => {
    liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-native-live-"));
    const bytes = fs.readFileSync(LIVE!.artifactPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sha512 = createHash("sha512").update(bytes).digest();
    if (sha256 !== LIVE!.identity.sha256 || bytes.length !== LIVE!.identity.bytes
      || `sha512-${sha512.toString("base64")}` !== LIVE!.identity.integrity
      || (LIVE!.identity.sha512 !== "" && sha512.toString("hex") !== LIVE!.identity.sha512)) {
      throw new Error("live artifact does not match its observed identity");
    }
    const artifact = { path: path.resolve(LIVE!.artifactPath), bytes: bytes.length, sha256, sha512: sha512.toString("hex") };
    const release = { version: LIVE!.identity.version, tarballUrl: LIVE!.identity.tarballUrl, integrity: LIVE!.identity.integrity };
    const installHome = path.join(liveRoot, "install-home");
    const installAgent = path.join(installHome, "agent");
    fs.mkdirSync(installAgent, { recursive: true });
    const staged = await stageVerifiedPiTarball(
      { homeDir: installHome, agentDir: installAgent, piExecutable: LIVE!.piExecutable, artifact, release },
      runPiStageProcess,
    );
    liveStage = { stageDir: staged.stageDir, artifact, release, evidence: staged.evidence };
  }, 600_000);

  afterAll(() => {
    if (liveRoot !== "") fs.rmSync(liveRoot, { recursive: true, force: true });
  });

  function targetScope(label: string): { target: string; homeDir: string; agentDir: string } {
    const target = path.join(liveRoot, `target-${label}`);
    fs.mkdirSync(target, { recursive: true });
    return { target, homeDir: path.join(target, "home"), agentDir: path.join(target, "pi-agent") };
  }

  it("runs a target-fresh native install with real digests and reconciles cleanup on update", async () => {
    const { target, homeDir, agentDir } = targetScope("phase");
    const engramBin = path.join(liveRoot, "bin", "engram");
    const fresh = await runNativePiMcpPhase({
      homeDir, agentDir, engramBin, piExecutable: LIVE!.piExecutable, stageDir: liveStage!.stageDir,
      fresh: true, bootstrapDirs: true, targetDir: target,
      providerStage: buildProviderStage(target, "phase-fresh"),
    });
    expect(fresh.kind, JSON.stringify(fresh)).toBe("ready");
    if (fresh.kind !== "ready") return;
    expect(fresh.gentleVersion).toBe("9.1.0");
    expect(fresh.authority.entries.engram?.definitionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.authority.entries.context7?.definitionSha256).toMatch(/^[0-9a-f]{64}$/);
    const mcp = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers.engram).toEqual({ command: engramBin, args: ["mcp", "--tools=agent"] });
    expect(mcp.mcpServers.context7).toEqual({ url: "https://mcp.context7.com/mcp" });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")))
      .toEqual({ packages: ["npm:gentle-engram@9.1.0"] });

    const projectionReceiptFile = path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");
    const publishAuthority = (authority: unknown): void => {
      writeJson(projectionReceiptFile, {
        schemaVersion: 1,
        scope: { kind: "target-dir", home: homeDir, codingAgentDir: agentDir, receiptFile: projectionReceiptFile },
        owned: [],
        mcpNative: authority,
      });
    };
    publishAuthority(fresh.authority);
    managedReceiptAt(homeDir, agentDir);

    const unchanged = await runNativePiMcpPhase({
      homeDir, agentDir, engramBin, piExecutable: LIVE!.piExecutable, stageDir: liveStage!.stageDir,
      fresh: false, targetDir: target, providerStage: buildProviderStage(target, "phase-update-unchanged"),
    });
    expect(unchanged).toMatchObject({ kind: "ready" });
    if (unchanged.kind !== "ready") return;
    expect(unchanged.authority.entries.engram?.cleanupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(unchanged.authority.entries.context7?.cleanupSha256).toMatch(/^[0-9a-f]{64}$/);
    publishAuthority(unchanged.authority);

    const mcpPath = path.join(agentDir, "mcp.json");
    const withPrefs = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    withPrefs.mcpServers.engram!.exposure = "always";
    withPrefs.mcpServers.engram!.enabled = true;
    withPrefs.mcpServers.context7!.headers = { Authorization: "user-secret" };
    fs.writeFileSync(mcpPath, `${JSON.stringify(withPrefs, null, 2)}\n`);
    const update = await runNativePiMcpPhase({
      homeDir, agentDir, engramBin, piExecutable: LIVE!.piExecutable, stageDir: liveStage!.stageDir,
      fresh: false, targetDir: target, providerStage: buildProviderStage(target, "phase-update"),
    });
    expect(update).toMatchObject({ kind: "ready" });
    if (update.kind !== "ready") return;
    const after = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(after.mcpServers.engram!.exposure).toBe("always");
    expect(after.mcpServers.engram!.enabled).toBe(true);
    expect(after.mcpServers.context7!.headers).toEqual({ Authorization: "user-secret" });
    expect(update.authority.entries.engram?.cleanupSha256).toBeUndefined();
    expect(update.authority.entries.context7?.cleanupSha256).toBeUndefined();
  }, 600_000);

  it("runs the managed install, update and uninstall with checker ordering and eligible-only cleanup", async () => {
    const { target, homeDir, agentDir } = targetScope("managed");
    fs.mkdirSync(agentDir, { recursive: true });
    const modules = path.join(agentDir, "npm", "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    // Foreign and unregistered-adapter state must survive install/update/uninstall.
    fs.mkdirSync(path.join(modules, "foreign"));
    fs.writeFileSync(path.join(modules, "foreign", "keep"), "foreign bytes");
    const adapterRoot = path.join(modules, "pi-mcp-adapter");
    fs.mkdirSync(adapterRoot);
    fs.writeFileSync(path.join(adapterRoot, "cli.js"), "adapter");
    const binDir = path.join(modules, ".bin");
    fs.mkdirSync(binDir);
    const adapterWrapper = path.join(binDir, "pi-mcp-adapter");
    const adapterTarget = path.relative(binDir, path.join(adapterRoot, "cli.js"));
    fs.symlinkSync(adapterTarget, adapterWrapper);

    const hostVersion = inspectPiHostVersion(LIVE!.piExecutable).version ?? "0.0.0";
    const preparedFor = async () => {
      const staged = await stageVerifiedPiTarball(
        { homeDir: target, agentDir, piExecutable: LIVE!.piExecutable, artifact: liveStage!.artifact, release: liveStage!.release },
        runPiStageProcess,
      );
      const candidate = buildStagedPiCandidate({
        stageDir: staged.stageDir, release: liveStage!.release, artifact: liveStage!.artifact,
        commit: "a".repeat(40), hostVersion, evidence: staged.evidence,
      });
      const prepared = {
        candidate, artifact: liveStage!.artifact, release: liveStage!.release, stageDir: staged.stageDir,
        evidence: staged.evidence, sourceAlias: `npm:jorgex-pi@file:${liveStage!.artifact.path}`,
      };
      return { candidate, prepared };
    };
    const install = await preparedFor();

    const order: string[] = [];
    let authorityPublishedBeforeSync = false;
    let linkPresentAtDeactivation = false;
    let engramCleanedBeforeDeactivation = false;
    let personalizedContext7RetainedBeforeDeactivation = false;
    let context7CleanupReleasedBeforeDeactivation = false;
    const projectionReceipt = path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");
    const mcpPath = path.join(agentDir, "mcp.json");
    const activeEntry = path.join(modules, "jorgex-pi");
    const readServers = (): Record<string, Record<string, unknown>> => {
      if (!fs.existsSync(mcpPath)) return {};
      return (JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
    };

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-runtime.js")>("../src/lib/pi-runtime.js");
      return {
        ...actual,
        runPiRuntimeSystem: async (runtimeInput: Parameters<typeof actual.runPiRuntimeSystem>[0]) => {
          order.push(`package:${runtimeInput.operation}`);
          if (runtimeInput.operation === "sync") {
            const receipt = fs.existsSync(projectionReceipt)
              ? JSON.parse(fs.readFileSync(projectionReceipt, "utf8")) as { mcpNative?: { entries?: Record<string, unknown> } }
              : null;
            authorityPublishedBeforeSync = Object.keys(receipt?.mcpNative?.entries ?? {}).length > 0;
          }
          if (runtimeInput.operation === "uninstall") {
            // The cleanup checker must already have run while the private link
            // still exists, removing only the full-stamp entry and releasing the
            // cleanup stamp of the retained personalized one.
            linkPresentAtDeactivation = fs.lstatSync(activeEntry, { throwIfNoEntry: false }) !== undefined;
            const servers = readServers();
            engramCleanedBeforeDeactivation = servers.engram === undefined;
            personalizedContext7RetainedBeforeDeactivation = servers.context7?.headers !== undefined
              && (servers.context7.headers as Record<string, unknown>).Authorization === "user-secret";
            const authority = fs.existsSync(projectionReceipt)
              ? JSON.parse(fs.readFileSync(projectionReceipt, "utf8")) as { mcpNative?: { entries?: Record<string, { cleanupSha256?: string }> } }
              : null;
            context7CleanupReleasedBeforeDeactivation = authority?.mcpNative?.entries?.engram === undefined
              && authority?.mcpNative?.entries?.context7?.cleanupSha256 === undefined;
          }
          return await actual.runPiRuntimeSystem(runtimeInput);
        },
      };
    });
    vi.doMock("../src/lib/pi-projection-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-projection-lifecycle.js")>("../src/lib/pi-projection-lifecycle.js");
      return {
        ...actual,
        runPiProjectionLifecycleSystem: (projectionInput: Parameters<typeof actual.runPiProjectionLifecycleSystem>[0]) => {
          order.push(`projection:${projectionInput.operation}`);
          return actual.runPiProjectionLifecycleSystem(projectionInput);
        },
      };
    });
    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as typeof import("../src/lib/pi-managed-runtime.js");
      const engramBin = path.join(liveRoot, "bin", "engram");
      const detected = { executable: LIVE!.piExecutable, version: hostVersion };
      const writingStyle = { sourcePath: path.join(liveRoot, "writing-style.md"), content: "Estilo sintético de verificación." };

      // 1) Fresh managed install: authority published before the checker+sync.
      const installed = await mod.runManagedPiSystem({
        operation: "install", targetDir: target, nativeLayout: true,
        candidate: install.candidate, prepared: install.prepared,
        nativeProviderStage: buildProviderStage(target, "lifecycle-install"),
        detected, engramBin, writingStyle,
      });
      expect(installed, JSON.stringify(installed)).toMatchObject({ kind: "installed" });
      expect(order).toEqual(["package:install", "projection:install", "package:sync", "projection:sync"]);
      expect(authorityPublishedBeforeSync).toBe(true);
      expect(fs.lstatSync(activeEntry).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(activeEntry)).toContain(path.join("jorgex-pi-managed", "releases"));
      const mainReceipt = JSON.parse(fs.readFileSync(path.join(homeDir, ".jorgex-stack", "pi-receipt.json"), "utf8")) as {
        state: string; candidate?: { package?: { version?: string } };
      };
      expect(mainReceipt.state).toBe("installed");
      expect(mainReceipt.candidate?.package?.version).toBe(LIVE!.identity.version);
      const cached = path.join(homeDir, ".jorgex-stack", "packages", `jorgex-pi-${LIVE!.identity.version}.tgz`);
      expect(fs.existsSync(cached)).toBe(true);
      expect(createHash("sha256").update(fs.readFileSync(cached)).digest("hex")).toBe(LIVE!.identity.sha256);
      const afterInstall = JSON.parse(fs.readFileSync(projectionReceipt, "utf8")) as { mcpNative?: { entries?: Record<string, unknown> } };
      expect(Object.keys(afterInstall.mcpNative?.entries ?? {}).sort()).toEqual(["context7", "engram"]);

      // 2) Managed update: authority retained, personalization preserved.
      order.length = 0;
      const update = await preparedFor();
      const updated = await mod.runManagedPiSystem({
        operation: "update", targetDir: target, nativeLayout: true,
        candidate: update.candidate, prepared: update.prepared,
        nativeProviderStage: buildProviderStage(target, "lifecycle-update"),
        detected, engramBin, writingStyle,
      });
      expect(["updated", "installed", "healthy"], JSON.stringify(updated)).toContain((updated as { kind: string }).kind);
      expect(order.length).toBeGreaterThan(0);
      const afterUpdate = JSON.parse(fs.readFileSync(projectionReceipt, "utf8")) as { mcpNative?: { entries?: Record<string, unknown> } };
      expect(Object.keys(afterUpdate.mcpNative?.entries ?? {}).sort()).toEqual(["context7", "engram"]);
      const updateReceipt = JSON.parse(fs.readFileSync(path.join(homeDir, ".jorgex-stack", "pi-receipt.json"), "utf8")) as { state: string };
      expect(updateReceipt.state).toBe("installed");

      // 3) Personalize Context7, then uninstall: the cleanup checker runs while
      // the link is still present, removes only the full-stamp entry, retains
      // and releases the personalized one.
      const withPrefs = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
      withPrefs.mcpServers.context7!.headers = { Authorization: "user-secret" };
      fs.writeFileSync(mcpPath, `${JSON.stringify(withPrefs, null, 2)}\n`);

      order.length = 0;
      const uninstalled = await mod.runManagedPiSystem({ operation: "uninstall", targetDir: target, nativeLayout: true, detected, engramBin });
      expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ kind: "uninstalled" });
      expect(linkPresentAtDeactivation).toBe(true);
      expect(engramCleanedBeforeDeactivation).toBe(true);
      expect(personalizedContext7RetainedBeforeDeactivation).toBe(true);
      expect(context7CleanupReleasedBeforeDeactivation).toBe(true);

      const finalServers = readServers();
      expect(finalServers.engram).toBeUndefined();
      expect(finalServers.context7).toEqual({ url: "https://mcp.context7.com/mcp", headers: { Authorization: "user-secret" } });
      // The projection receipt is owned and removed by the uninstall itself.
      expect(fs.existsSync(projectionReceipt)).toBe(false);
      // Foreign/unregistered adapter/wrapper survive; the owned private entry is deactivated.
      expect(fs.readFileSync(path.join(modules, "foreign", "keep"), "utf8")).toBe("foreign bytes");
      expect(fs.readFileSync(path.join(adapterRoot, "cli.js"), "utf8")).toBe("adapter");
      expect(fs.readlinkSync(adapterWrapper)).toBe(adapterTarget);
      expect(fs.lstatSync(activeEntry, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.resetModules();
    }
  }, 900_000);
});
