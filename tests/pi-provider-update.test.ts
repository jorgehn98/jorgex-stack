import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";
import type { NpmPackageRelease } from "../src/lib/npm-provider.js";

/**
 * T65 RED for the deliberate Pi provider update.
 *
 * Intended public contract (no production change in this RED):
 * - `updatePiProviderPackages({ homeDir, agentDir, piExecutable, engramBin })`
 *   is exported by `src/lib/pi-provider-update.ts` and returns `{ kind, versions }`.
 * - It resolves both provider releases through `resolveLatestNpmPackageRelease`,
 *   stages them through `stagePiProviderPackages`, smoke-tests the staged
 *   provider roots with the managed jorgex-pi root, then activates only those
 *   roots through `activatePiProviderPackages`.
 * - Before staging it snapshots the private Pi receipt at
 *   `<home>/.jorgex-stack/pi-receipt.json`, its managed link target, and its
 *   release tree digest. The activation verification callback must re-check
 *   those bytes; a drift is an error, never a fabricated healthy result.
 * - MCP completion is a separate post-promotion phase. If it fails after the
 *   provider roots were activated, the error must say that providers are
 *   active and MCP remains pending; it must not claim a full rollback.
 *
 * Registry, stage, smoke, and activation are mocked at their public module
 * seams. The receipt/link/tree fixture remains real filesystem state, and the
 * activation mock executes the verification callback so the test protects the
 * ownership boundary rather than call choreography.
 */

type ProviderName = "gentle-engram" | "pi-mcp-adapter";
type Releases = Record<ProviderName, NpmPackageRelease>;

type ProviderEvidence = {
  name: ProviderName;
  version: string;
  integrity: string;
  packageRoot: string;
  treeSha256: string;
  bins: Record<string, string>;
};

type UpdateInput = {
  homeDir: string;
  agentDir: string;
  piExecutable: string;
  engramBin: string;
};

type UpdateModule = {
  updatePiProviderPackages(input: UpdateInput): Promise<{
    kind: "updated" | "healthy";
    versions: Record<ProviderName, string>;
  }>;
  completeUpdatedPiMcp(configDir: string, engramBin: string): Promise<void>;
};

const PROVIDERS: readonly ProviderName[] = ["gentle-engram", "pi-mcp-adapter"];
const PI_VERSION = "0.8.37";
const PI_EXECUTABLE_NAME = "pi";
const ENGRAM_NAME = "engram";
const oldProviderVersions: Releases = {
  "gentle-engram": {
    version: "0.1.16",
    tarballUrl: "https://registry.npmjs.org/gentle-engram/-/gentle-engram-0.1.16.tgz",
    integrity: `sha512-${Buffer.alloc(64, 21).toString("base64")}`,
  },
  "pi-mcp-adapter": {
    version: "3.2.0",
    tarballUrl: "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-3.2.0.tgz",
    integrity: `sha512-${Buffer.alloc(64, 22).toString("base64")}`,
  },
};
const latestVersions: Releases = {
  "gentle-engram": {
    version: "0.1.17",
    tarballUrl: "https://registry.npmjs.org/gentle-engram/-/gentle-engram-0.1.17.tgz",
    integrity: `sha512-${Buffer.alloc(64, 31).toString("base64")}`,
  },
  "pi-mcp-adapter": {
    version: "3.2.1",
    tarballUrl: "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-3.2.1.tgz",
    integrity: `sha512-${Buffer.alloc(64, 32).toString("base64")}`,
  },
};

const mocks = vi.hoisted(() => ({
  resolveLatestNpmPackageRelease: vi.fn(),
  stagePiProviderPackages: vi.fn(),
  smokePiProviderRuntime: vi.fn(),
  activatePiProviderPackages: vi.fn(),
}));

vi.mock("../src/lib/npm-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/npm-provider.js")>();
  return { ...actual, resolveLatestNpmPackageRelease: mocks.resolveLatestNpmPackageRelease };
});

vi.mock("../src/lib/pi-provider-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-provider-stage.js")>();
  return { ...actual, stagePiProviderPackages: mocks.stagePiProviderPackages };
});

vi.mock("../src/lib/pi-provider-smoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-provider-smoke.js")>();
  return { ...actual, smokePiProviderRuntime: mocks.smokePiProviderRuntime };
});

vi.mock("../src/lib/pi-provider-activation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-provider-activation.js")>();
  return { ...actual, activatePiProviderPackages: mocks.activatePiProviderPackages };
});

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.resolveLatestNpmPackageRelease.mockReset();
  mocks.stagePiProviderPackages.mockReset();
  mocks.smokePiProviderRuntime.mockReset();
  mocks.activatePiProviderPackages.mockReset();
});

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalProviderSource(name: ProviderName, version: string): string {
  return `npm:${name}@${version}`;
}

function canonicalNpmSource(name: string, version: string): string {
  return `npm:${name}@${version}`;
}

type ProviderSandbox = UpdateInput & {
  root: string;
  settingsPath: string;
  receiptPath: string;
  oldReleaseDir: string;
  oldLinkPath: string;
  foreignFile: string;
  mcpPath: string;
  oldReceipt: string;
  oldSettings: string;
};

function createSandbox(): ProviderSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-provider-update-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const npmDir = path.join(agentDir, "npm");
  const modules = path.join(npmDir, "node_modules");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(homeDir, ".jorgex-stack", "pi-receipt.json");
  const engramBin = path.join(homeDir, ".local", "bin", ENGRAM_NAME);
  const piExecutable = path.join(root, "bin", PI_EXECUTABLE_NAME);
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const oldReleaseDir = path.join(managedRoot, "releases", "old-provider-update");
  const oldPackageRoot = path.join(oldReleaseDir, "node_modules", "jorgex-pi");
  const oldLinkPath = path.join(modules, "jorgex-pi");
  const backupDir = path.join(agentDir, `stage-${"a".repeat(32)}`, "pi-agent", ".activate-backup");
  const foreignRoot = path.join(modules, "foreign-pkg");
  const foreignFile = path.join(foreignRoot, "keep.txt");
  const mcpPath = path.join(agentDir, "mcp-adapter.json");

  fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(engramBin), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(piExecutable), { recursive: true, mode: 0o700 });
  fs.mkdirSync(oldPackageRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(engramBin, "engram fixture\n", { mode: 0o700 });
  fs.writeFileSync(piExecutable, "pi fixture\n", { mode: 0o700 });
  fs.writeFileSync(foreignFile, "foreign provider bytes\n", { mode: 0o600 });

  fs.writeFileSync(
    path.join(oldPackageRoot, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: PI_VERSION })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(oldPackageRoot, "runner.mjs"), "// private runner\n", { mode: 0o600 });
  fs.mkdirSync(path.join(oldPackageRoot, "contract"));
  fs.writeFileSync(path.join(oldPackageRoot, "contract", "jorgex-pi.v1.json"), JSON.stringify({ mcpAdapterConfig: { schemaVersion: 1, files: ["mcp.json", "mcp-adapter.json"] } }));
  const lockBytes = Buffer.from('{"name":"jorgex-pi-managed","lockfileVersion":3,"packages":{}}\n');
  fs.writeFileSync(path.join(oldReleaseDir, "package-lock.json"), lockBytes, { mode: 0o600 });
  const relativeLink = path.relative(path.dirname(oldLinkPath), oldPackageRoot);
  fs.symlinkSync(relativeLink, oldLinkPath, "dir");

  const oldSettings = `${JSON.stringify({
    packages: [
      canonicalProviderSource("gentle-engram", oldProviderVersions["gentle-engram"].version),
      canonicalProviderSource("pi-mcp-adapter", oldProviderVersions["pi-mcp-adapter"].version),
      canonicalNpmSource("jorgex-pi", PI_VERSION),
      "npm:foreign@1.0.0",
    ],
  })}\n`;
  fs.writeFileSync(settingsPath, oldSettings, { mode: 0o600 });

  for (const [name, release] of Object.entries(oldProviderVersions) as Array<[ProviderName, NpmPackageRelease]>) {
    const providerRoot = path.join(modules, name);
    fs.mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(providerRoot, "package.json"),
      `${JSON.stringify({ name, version: release.version, bin: { [name]: "cli.js" } })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(providerRoot, "cli.js"), `// ${name}\n`, { mode: 0o700 });
  }
  fs.writeFileSync(
    mcpPath,
    `${JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const oldReceiptObject = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: "jorgex-pi", version: PI_VERSION, source: canonicalNpmSource("jorgex-pi", PI_VERSION) },
      tarball: {
        bytes: Buffer.byteLength("private-pi"),
        sha256: sha256("private-pi"),
        sha512: createHash("sha512").update("private-pi").digest("hex"),
      },
      provenance: { commit: "a".repeat(40) },
    },
    scope: { kind: "real", codingAgentDir: agentDir },
    engram: { binary: engramBin },
    managedPackage: {
      releaseDir: oldReleaseDir,
      linkPath: oldLinkPath,
      backupDir,
      lockSha256: sha256(lockBytes),
      treeSha256: inventoryTreeSha256(oldReleaseDir),
      dependencies: [],
    },
  };
  const oldReceipt = `${JSON.stringify(oldReceiptObject, null, 2)}\n`;
  fs.writeFileSync(receiptPath, oldReceipt, { mode: 0o600 });

  return {
    root,
    homeDir,
    agentDir,
    piExecutable,
    engramBin,
    settingsPath,
    receiptPath,
    oldReleaseDir,
    oldLinkPath,
    foreignFile,
    mcpPath,
    oldReceipt,
    oldSettings,
  };
}

function snapshotPrivateState(sandbox: ProviderSandbox): { receipt: string; link: string; tree: string; settings: string } {
  return {
    receipt: fs.readFileSync(sandbox.receiptPath, "utf8"),
    link: fs.readlinkSync(sandbox.oldLinkPath),
    tree: inventoryTreeSha256(sandbox.oldReleaseDir),
    settings: fs.readFileSync(sandbox.settingsPath, "utf8"),
  };
}

function stageFixture(sandbox: ProviderSandbox): { stageDir: string; packages: ProviderEvidence[] } {
  const stageDir = path.join(sandbox.root, "provider-stage");
  const packages = PROVIDERS.map((name) => {
    const packageRoot = path.join(stageDir, name, "npm", "node_modules", name);
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name, version: latestVersions[name].version, bin: { [name]: "cli.js" } })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(packageRoot, "cli.js"), `// candidate ${name}\n`, { mode: 0o700 });
    return {
      name,
      version: latestVersions[name].version,
      integrity: latestVersions[name].integrity,
      packageRoot,
      treeSha256: inventoryTreeSha256(packageRoot),
      bins: { [name]: path.join(packageRoot, "cli.js") },
    };
  });
  return { stageDir, packages };
}

function configureMocks(sandbox: ProviderSandbox, options: { activationError?: string; mcpFailure?: boolean } = {}): string[] {
  const events: string[] = [];
  const staged = stageFixture(sandbox);
  mocks.resolveLatestNpmPackageRelease.mockImplementation(async (name: ProviderName) => {
    events.push(`resolve:${name}`);
    return latestVersions[name];
  });
  mocks.stagePiProviderPackages.mockImplementation(async (input: { releases: Releases }) => {
    events.push("stage");
    expect(input.releases).toEqual(latestVersions);
    return staged;
  });
  mocks.smokePiProviderRuntime.mockImplementation(async (input: { piExecutable: string; jorgexPackageRoot: string; providerRoots: Record<ProviderName, string>; engramBin: string }) => {
    events.push("smoke");
    expect(input.piExecutable).toBe(sandbox.piExecutable);
    expect(input.engramBin).toBe(sandbox.engramBin);
    expect(Object.keys(input.providerRoots).sort()).toEqual([...PROVIDERS].sort());
    expect(input.jorgexPackageRoot).toBe(path.join(sandbox.agentDir, "npm", "node_modules", "jorgex-pi"));
    return { commands: ["goal", "subagents", "permission-system", "websearch", "jorgex:header", "mcp-adapter", "mcp"] };
  });
  mocks.activatePiProviderPackages.mockImplementation(async (input: { verify?: () => void | Promise<void>; stageDir?: string }) => {
    events.push("activate");
    expect(input.stageDir).toBe(staged.stageDir);
    if (typeof input.verify !== "function") throw new Error("activation verification callback missing");
    try {
      await input.verify();
      events.push("verify");
    } catch (error) {
      events.push("verify-failed");
      throw error;
    }
    if (options.activationError !== undefined) throw new Error(options.activationError);
    if (options.mcpFailure === true) fs.writeFileSync(sandbox.mcpPath, "{ invalid mcp json\n", { mode: 0o600 });
    return { ok: true, backupDir: path.join(staged.stageDir, "backup") };
  });
  return events;
}

async function loadUpdater(): Promise<UpdateModule> {
  const mod = (await import(/* @vite-ignore */ new URL("../src/lib/pi-provider-update.js", import.meta.url).href)) as Partial<UpdateModule>;
  expect(mod.updatePiProviderPackages, "updatePiProviderPackages must be exported from src/lib/pi-provider-update.ts").toBeTypeOf("function");
  expect(mod.completeUpdatedPiMcp, "completeUpdatedPiMcp must be exported from src/lib/pi-provider-update.ts").toBeTypeOf("function");
  return mod as UpdateModule;
}

describe("[T65-RED] deliberate Pi provider update", () => {
  it("fails closed on registry resolution failure before stage or activation", async () => {
    const sandbox = createSandbox();
    const before = snapshotPrivateState(sandbox);
    const events: string[] = [];
    mocks.resolveLatestNpmPackageRelease.mockImplementation(async (name: ProviderName) => {
      events.push(`resolve:${name}`);
      if (name === "pi-mcp-adapter") throw new Error("registry unavailable");
      return latestVersions[name];
    });
    mocks.stagePiProviderPackages.mockImplementation(async () => {
      events.push("stage");
      throw new Error("stage must not run after registry failure");
    });
    const update = await loadUpdater();

    await expect(update.updatePiProviderPackages({
      homeDir: sandbox.homeDir,
      agentDir: sandbox.agentDir,
      piExecutable: sandbox.piExecutable,
      engramBin: sandbox.engramBin,
    })).rejects.toThrow(/registry unavailable/i);
    expect(events).toContain("resolve:gentle-engram");
    expect(events).toContain("resolve:pi-mcp-adapter");
    expect(events).not.toContain("stage");
    expect(mocks.activatePiProviderPackages).not.toHaveBeenCalled();
    expect(snapshotPrivateState(sandbox)).toEqual(before);
    expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toBe("foreign provider bytes\n");
  });

  it("propagates private receipt/link/tree drift from the activation verification callback", async () => {
    const sandbox = createSandbox();
    const before = snapshotPrivateState(sandbox);
    const events = configureMocks(sandbox);
    mocks.activatePiProviderPackages.mockImplementationOnce(async (input: { verify?: () => void | Promise<void> }) => {
      events.push("activate");
      if (typeof input.verify !== "function") throw new Error("activation verification callback missing");
      fs.writeFileSync(sandbox.receiptPath, before.receipt + " ");
      await input.verify();
    });
    const update = await loadUpdater();

    await expect(update.updatePiProviderPackages({
      homeDir: sandbox.homeDir,
      agentDir: sandbox.agentDir,
      piExecutable: sandbox.piExecutable,
      engramBin: sandbox.engramBin,
    })).rejects.toThrow(/drift|receipt|link|tree/i);
    expect(events).toContain("stage");
    expect(events).toContain("smoke");
    expect(events).toContain("activate");
    expect(mocks.activatePiProviderPackages).toHaveBeenCalledTimes(1);
    expect(snapshotPrivateState(sandbox)).toEqual({ ...before, receipt: before.receipt + " " });
    expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toBe("foreign provider bytes\n");
  });

  it("reports providers active and MCP pending when post-promotion completion fails", async () => {
    const sandbox = createSandbox();
    const before = snapshotPrivateState(sandbox);
    const events = configureMocks(sandbox, { mcpFailure: true });
    const update = await loadUpdater();

    await expect(update.updatePiProviderPackages({
      homeDir: sandbox.homeDir,
      agentDir: sandbox.agentDir,
      piExecutable: sandbox.piExecutable,
      engramBin: sandbox.engramBin,
    })).rejects.toThrow(/provider|MCP|pending|activated/i);
    expect(events).toContain("stage");
    expect(events).toContain("smoke");
    expect(events).toContain("activate");
    expect(mocks.activatePiProviderPackages).toHaveBeenCalledTimes(1);
    // The private jorgex-pi receipt/link/tree are not part of provider
    // promotion and remain byte-identical even when MCP completion is pending.
    expect(snapshotPrivateState(sandbox)).toEqual(before);
    expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toBe("foreign provider bytes\n");
  });
});
