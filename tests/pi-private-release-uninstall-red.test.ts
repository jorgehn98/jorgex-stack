import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";

/**
 * T05 RED for safe uninstall of the Stack-managed schema1 `managedPackage`
 * private Pi release (tests only, no production change).
 *
 * Exact specs: work/external-version-pins/tasks/05.md + 07.md.
 *
 * Desired contract (GREEN closes in `src/lib/pi-private-release.ts`, same
 * module as activation, same per-agent
 * `npm/jorgex-pi-managed/transaction.lock` + `active-transaction.json`):
 *   deactivateVerifiedPiRelease({homeDir,agentDir,receiptPath,
 *     managedPackage:{releaseDir,linkPath,backupDir,lockSha256,treeSha256,
 *     dependencies},nextSettings,verify})
 *     : {kind:'uninstalled',backupDir:string}
 * Synchronous ONLY: `verify: () => void` runs inline (real runtime verify
 * is a synchronous fs readback); no Promise success may be claimed before
 * the rollback decision. A `verify` returning a thenable/Promise must fail
 * closed and roll back.
 *
 * Caller already authenticates receipt/link/lock/tree/tgz, but the helper
 * rechecks the owned link points to the exact internal release and real
 * dirs; it NEVER calls Pi native `pi remove` nor swaps the shared npm root.
 *
 * Topology under test (real FS, os.tmpdir sandbox as fake home only, never
 * real HOME, no network, no installed Pi):
 * - agentDir/npm/node_modules/jorgex-pi is the ONLY owned entry that may
 *   move (relative symlink to the private release realpath).
 * - agentDir/npm/node_modules/foreign-pkg + gentle-engram + pi-mcp-adapter
 *   are foreign/provider-owned and must survive byte-identically; the shared
 *   npm root is never copied/replaced.
 * - The private release lives at
 *   npm/jorgex-pi-managed/releases/<64hex>/ with its own package-lock.json
 *   and six resolved deps; lockSha256 is sha256 of the lock bytes and
 *   treeSha256 is the deterministic inventoryTreeSha256 of the release dir.
 * - settings.json holds the exact managed Pi object plus gentle/adapter/
 *   foreign bare strings; receipt v1 (outside the agent dir) holds the same
 *   managedPackage.
 * - Success unlinks ONLY the owned entry, moves the private release into a
 *   unique Stack-owned uninstall backup (never deletes unverified bytes),
 *   writes nextSettings (Pi removed, provider/foreign preserved), removes
 *   the receipt by rename into the backup, runs verify to confirm absence,
 *   and retains the backup for rollback.
 * - Verify throw AFTER removal restores release/link/settings/receipt
 *   byte-identically with no foreign mutation.
 * - A preexisting active-transaction marker blocks incomplete before writes.
 *
 * Synthetic 9.9.x versions are test-only and never claim a published Pi
 * release nor select a next version.
 */

type DeactivateInput = {
  homeDir: string;
  agentDir: string;
  receiptPath: string;
  managedPackage: {
    releaseDir: string;
    linkPath: string;
    backupDir: string;
    lockSha256: string;
    treeSha256: string;
    dependencies: Array<{ name: string; version: string; integrity: string }>;
  };
  nextSettings: string;
  verify: () => void;
};

type DeactivateModule = {
  deactivateVerifiedPiRelease: (input: DeactivateInput) => { kind: "uninstalled"; backupDir: string };
};

async function loadModule(): Promise<DeactivateModule> {
  const mod = (await import("../src/lib/pi-private-release.js")) as unknown as Partial<DeactivateModule>;
  expect(mod.deactivateVerifiedPiRelease).toBeTypeOf("function");
  return mod as DeactivateModule;
}

const PI_VERSION = "9.9.9";
const PI_SOURCE = `npm:jorgex-pi@${PI_VERSION}`;
const GENTLE = "npm:gentle-engram@9.9.99";
const ADAPTER = "npm:pi-mcp-adapter@9.9.98";
const FOREIGN = "npm:foreign@1.0.0";

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const NEW_PI_INDEX = "// jorgex-pi 9.9.9 private release\nmodule.exports = 'new-pi';\n";
const FOREIGN_INDEX = "// foreign package - must survive byte-identically\nmodule.exports = 'foreign';\n";
const GENTLE_INDEX = "// provider gentle package - must survive byte-identically\nmodule.exports = 'gentle';\n";
const ADAPTER_INDEX = "// provider adapter package - must survive byte-identically\nmodule.exports = 'adapter';\n";

function syntheticHex(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

function canonicalDepUrl(name: string, version: string): string {
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type UninstallSandbox = {
  homeDir: string;
  agentDir: string;
  stageDir: string;
  npmDir: string;
  releaseDir: string;
  packageRoot: string;
  linkPath: string;
  receiptPath: string;
  settingsPath: string;
  backupDir: string;
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
  oldSettings: string;
  nextSettings: string;
  oldReceipt: string;
  expectedLinkTarget: string;
  foreignIndex: string;
  gentleIndex: string;
  adapterIndex: string;
  lockPath: string;
  releaseIndex: string;
};

function setupUninstallSandbox(): UninstallSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-uninstall-"));
  sandboxes.push(sandbox);
  expect(sandbox.startsWith(os.tmpdir())).toBe(true);

  const homeDir = sandbox;
  const agentDir = path.join(homeDir, "agent");
  const stageHex = syntheticHex("jorgex-pi-uninstall-stage-root").slice(0, 32);
  const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
  const backupDir = path.join(stageDir, ".activate-backup");
  const npmDir = path.join(agentDir, "npm");
  const releaseId = syntheticHex("jorgex-pi-uninstall-release");
  expect(releaseId).toMatch(/^[0-9a-f]{64}$/);
  const releaseDir = path.join(npmDir, "jorgex-pi-managed", "releases", releaseId);
  const packageRoot = path.join(releaseDir, "node_modules", "jorgex-pi");
  const linkPath = path.join(npmDir, "node_modules", "jorgex-pi");
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const settingsPath = path.join(agentDir, "settings.json");
  const foreignIndex = path.join(npmDir, "node_modules", "foreign-pkg", "index.js");
  const gentleIndex = path.join(npmDir, "node_modules", "gentle-engram", "index.js");
  const adapterIndex = path.join(npmDir, "node_modules", "pi-mcp-adapter", "index.js");
  const lockPath = path.join(releaseDir, "package-lock.json");
  const releaseIndex = path.join(packageRoot, "index.js");

  // Six observed deps with canonical SRI (test-only synthetic versions).
  const dependencies = STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(21 + index),
  }));
  expect(dependencies).toHaveLength(6);

  // Synthetic parent tarball bytes bound to the lock parent integrity.
  const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9-uninstall\n");
  const parentIntegrity = `sha512-${crypto.createHash("sha512").update(tarballBytes).digest("base64")}`;
  const tarballFile = `jorgex-pi-${PI_VERSION}.tgz`;
  const fileSpec = `file:../downloads/${tarballFile}`;
  const parentDeps: Record<string, string> = {};
  for (const dep of dependencies) parentDeps[dep.name] = "*";
  const packages: Record<string, Record<string, unknown>> = {
    "": { dependencies: { "jorgex-pi": fileSpec } },
    "node_modules/jorgex-pi": {
      version: PI_VERSION,
      resolved: fileSpec,
      integrity: parentIntegrity,
      dependencies: parentDeps,
    },
  };
  for (const dep of dependencies) {
    packages[`node_modules/${dep.name}`] = {
      version: dep.version,
      resolved: canonicalDepUrl(dep.name, dep.version),
      integrity: dep.integrity,
    };
  }

  // Private release tree: Pi entry + six hoisted deps.
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "jorgex-pi", version: PI_VERSION, dependencies: parentDeps }, null, 2)}\n`);
  fs.writeFileSync(releaseIndex, NEW_PI_INDEX);
  fs.writeFileSync(path.join(packageRoot, "bin", "jorgex-pi.mjs"), "// synthetic managed runner entry\n");
  for (const dep of dependencies) {
    const dir = path.join(releaseDir, "node_modules", dep.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: dep.name, version: dep.version }, null, 2)}\n`);
  }
  fs.writeFileSync(
    path.join(releaseDir, "package.json"),
    `${JSON.stringify({ name: "pi-extensions", version: PI_VERSION, dependencies: { "jorgex-pi": fileSpec } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
  );

  // Real digests: lock bytes hash + deterministic release inventory.
  const lockSha256 = crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
  expect(lockSha256).toMatch(/^[0-9a-f]{64}$/);
  const treeSha256 = inventoryTreeSha256(releaseDir);
  expect(treeSha256).toMatch(/^[0-9a-f]{64}$/);

  // Retained activation backup under the stage, outside npm (must exist).
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "activation-marker.json"), '{"retained":true}\n');

  // Owned relative symlink to the private release realpath.
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const expectedLinkTarget = path.relative(path.dirname(linkPath), packageRoot);
  expect(expectedLinkTarget).toBe(`../jorgex-pi-managed/releases/${releaseId}/node_modules/jorgex-pi`);
  expect(path.isAbsolute(expectedLinkTarget)).toBe(false);
  fs.symlinkSync(expectedLinkTarget, linkPath, "dir");
  expect(fs.realpathSync(linkPath)).toBe(packageRoot);

  // Foreign + official provider packages sharing the same npm root.
  fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, FOREIGN_INDEX);
  fs.mkdirSync(path.dirname(gentleIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(gentleIndex), "package.json"), '{"name":"gentle-engram","version":"9.9.99"}\n');
  fs.writeFileSync(gentleIndex, GENTLE_INDEX);
  fs.mkdirSync(path.dirname(adapterIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(adapterIndex), "package.json"), '{"name":"pi-mcp-adapter","version":"9.9.98"}\n');
  fs.writeFileSync(adapterIndex, ADAPTER_INDEX);

  // Settings with the exact managed Pi object plus gentle/adapter/foreign.
  const managedPi = { source: PI_SOURCE, skills: [], prompts: [] };
  const oldSettings = `${JSON.stringify({ theme: "custom", packages: [FOREIGN, GENTLE, ADAPTER, managedPi], extra: { note: "keep" } }, null, 2)}\n`;
  const nextSettings = `${JSON.stringify({ theme: "custom", packages: [FOREIGN, GENTLE, ADAPTER], extra: { note: "keep" } }, null, 2)}\n`;
  expect(nextSettings).not.toContain(PI_SOURCE);
  fs.writeFileSync(settingsPath, oldSettings);

  // Receipt v1 with managedPackage (outside the agent dir, inside home).
  const engramBin = path.join(sandbox, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
  const candidate = {
    package: { name: "jorgex-pi", version: PI_VERSION, source: PI_SOURCE },
    tarball: {
      bytes: tarballBytes.byteLength,
      sha256: crypto.createHash("sha256").update(tarballBytes).digest("hex"),
      sha512: crypto.createHash("sha512").update(tarballBytes).digest("hex"),
    },
    provenance: { commit: syntheticHex("synthetic-uninstall-provenance").slice(0, 40) },
  };
  const oldReceipt = `${JSON.stringify(
    {
      schemaVersion: 1,
      state: "installed",
      candidate,
      scope: { kind: "target-dir", codingAgentDir: agentDir },
      engram: { binary: engramBin },
      managedPackage: {
        releaseDir,
        linkPath,
        backupDir,
        lockSha256,
        treeSha256,
        dependencies: dependencies.map((dep) => ({ ...dep })),
      },
    },
    null,
    2,
  )}\n`;
  expect(oldReceipt).toContain("managedPackage");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, oldReceipt);

  // Home boundary: receipt outside the agent dir, never under it.
  expect(path.relative(homeDir, agentDir).startsWith("..")).toBe(false);
  expect(path.relative(homeDir, receiptPath).startsWith("..")).toBe(false);
  expect(path.relative(agentDir, receiptPath).startsWith("..")).toBe(true);
  expect(fs.existsSync(path.join(agentDir, "state", "pi-receipt.json"))).toBe(false);

  return {
    homeDir,
    agentDir,
    stageDir,
    npmDir,
    releaseDir,
    packageRoot,
    linkPath,
    receiptPath,
    settingsPath,
    backupDir,
    lockSha256,
    treeSha256,
    dependencies,
    oldSettings,
    nextSettings,
    oldReceipt,
    expectedLinkTarget,
    foreignIndex,
    gentleIndex,
    adapterIndex,
    lockPath,
    releaseIndex,
  };
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function findFileWithContent(root: string, expected: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (st.isFile() && fs.readFileSync(full, "utf8") === expected) return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

describe("pi private-release safe uninstall RED (T05 for T07)", () => {
  it("unlinks only the owned entry, moves the release into a unique Stack-owned backup, writes nextSettings, renames the receipt into the backup, and keeps foreign bytes intact", async () => {
    const sb = setupUninstallSandbox();
    const { deactivateVerifiedPiRelease } = await loadModule();

    let verifyRan = false;
    const verify = (): void => {
      // Ordering proof: verify must run only after owned removal.
      verifyRan = true;
      expect(lstatOrNull(sb.linkPath)).toBeNull();
      expect(fs.existsSync(sb.releaseDir)).toBe(false);
      expect(fs.existsSync(sb.receiptPath)).toBe(false);
    };

    // Synchronous contract: direct return, no Promise/await on the helper.
    const result = deactivateVerifiedPiRelease({
      homeDir: sb.homeDir,
      agentDir: sb.agentDir,
      receiptPath: sb.receiptPath,
      managedPackage: {
        releaseDir: sb.releaseDir,
        linkPath: sb.linkPath,
        backupDir: sb.backupDir,
        lockSha256: sb.lockSha256,
        treeSha256: sb.treeSha256,
        dependencies: sb.dependencies.map((dep) => ({ ...dep })),
      },
      nextSettings: sb.nextSettings,
      verify,
    });

    expect(verifyRan).toBe(true);
    expect(result.kind).toBe("uninstalled");
    expect(typeof result.backupDir).toBe("string");
    expect(path.isAbsolute(result.backupDir)).toBe(true);
    expect(path.relative(sb.homeDir, result.backupDir).startsWith("..")).toBe(false);
    expect(path.resolve(result.backupDir)).not.toBe(path.resolve(sb.releaseDir));
    expect(path.resolve(result.backupDir)).not.toBe(path.resolve(sb.backupDir));
    const backupStat = lstatOrNull(result.backupDir);
    expect(backupStat?.isDirectory()).toBe(true);
    expect(backupStat?.isSymbolicLink()).toBe(false);

    // Owned entry + release + receipt are gone from their live locations.
    expect(lstatOrNull(sb.linkPath)).toBeNull();
    expect(fs.existsSync(sb.releaseDir)).toBe(false);
    expect(fs.existsSync(sb.receiptPath)).toBe(false);
    // Next settings written verbatim: Pi removed, provider/foreign preserved.
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.nextSettings);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).not.toContain(PI_SOURCE);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toContain(GENTLE);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toContain(ADAPTER);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toContain(FOREIGN);

    // Release bytes were moved into the backup, never deleted unverified:
    // the exact release index and receipt bytes must be found under it.
    expect(findFileWithContent(result.backupDir, NEW_PI_INDEX)).not.toBeNull();
    expect(findFileWithContent(result.backupDir, sb.oldReceipt)).not.toBeNull();
    // Backup retained for rollback, not cleaned as incidental cleanup.
    expect(fs.existsSync(result.backupDir)).toBe(true);
    // Activation backup stays recoverable and is never auto-deleted.
    expect(fs.readFileSync(path.join(sb.backupDir, "activation-marker.json"), "utf8")).toBe('{"retained":true}\n');

    // Shared npm root never swapped: foreign/provider bytes unchanged.
    expect(fs.lstatSync(path.join(sb.npmDir, "node_modules")).isDirectory()).toBe(true);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(sb.gentleIndex, "utf8")).toBe(GENTLE_INDEX);
    expect(fs.readFileSync(sb.adapterIndex, "utf8")).toBe(ADAPTER_INDEX);
  });

  it("restores release/link/settings/receipt byte-identically when verify throws after removal, with no foreign mutation", async () => {
    const sb = setupUninstallSandbox();
    const { deactivateVerifiedPiRelease } = await loadModule();

    const beforeLock = fs.readFileSync(sb.lockPath);
    const beforeReleaseIndex = fs.readFileSync(sb.releaseIndex, "utf8");

    let observedAfterRemoval = false;
    const verify = (): void => {
      // Ordering proof: removal happened before the injected failure.
      expect(lstatOrNull(sb.linkPath)).toBeNull();
      expect(fs.existsSync(sb.releaseDir)).toBe(false);
      observedAfterRemoval = true;
      throw new Error("verify-boom-after-removal");
    };

    // Synchronous contract: sync throw, no rejected Promise.
    expect(() =>
      deactivateVerifiedPiRelease({
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        managedPackage: {
          releaseDir: sb.releaseDir,
          linkPath: sb.linkPath,
          backupDir: sb.backupDir,
          lockSha256: sb.lockSha256,
          treeSha256: sb.treeSha256,
          dependencies: sb.dependencies.map((dep) => ({ ...dep })),
        },
        nextSettings: sb.nextSettings,
        verify,
      }),
    ).toThrow(/verify-boom-after-removal/);
    expect(observedAfterRemoval).toBe(true);

    // Previous state restored byte-identically (not left removed).
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sb.linkPath)).toBe(sb.expectedLinkTarget);
    expect(fs.realpathSync(sb.linkPath)).toBe(sb.packageRoot);
    expect(fs.readFileSync(sb.releaseIndex, "utf8")).toBe(beforeReleaseIndex);
    expect(fs.readFileSync(sb.releaseIndex, "utf8")).toBe(NEW_PI_INDEX);
    expect(fs.readFileSync(sb.lockPath)).toEqual(beforeLock);
    expect(crypto.createHash("sha256").update(fs.readFileSync(sb.lockPath)).digest("hex")).toBe(sb.lockSha256);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(sb.treeSha256);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);

    // No foreign mutation during rollback.
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(sb.gentleIndex, "utf8")).toBe(GENTLE_INDEX);
    expect(fs.readFileSync(sb.adapterIndex, "utf8")).toBe(ADAPTER_INDEX);
  });

  it("blocks incomplete before writes when a stable active-transaction marker is present, preserving marker/state/foreign and the live release", async () => {
    const sb = setupUninstallSandbox();
    const { deactivateVerifiedPiRelease } = await loadModule();

    // Simulated crash marker from a prior activation: stable per-agent path.
    const managedRoot = path.join(sb.npmDir, "jorgex-pi-managed");
    const markerPath = path.join(managedRoot, "active-transaction.json");
    const markerContent = `${JSON.stringify({ stageDir: sb.stageDir, backupDir: sb.backupDir, phase: "prepared", pid: process.pid }, null, 2)}\n`;
    fs.writeFileSync(markerPath, markerContent);

    let verifyRan = false;
    const verify = (): void => {
      verifyRan = true;
    };
    // Synchronous contract: sync throw, no rejected Promise.
    let failure: unknown = null;
    try {
      deactivateVerifiedPiRelease({
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        managedPackage: {
          releaseDir: sb.releaseDir,
          linkPath: sb.linkPath,
          backupDir: sb.backupDir,
          lockSha256: sb.lockSha256,
          treeSha256: sb.treeSha256,
          dependencies: sb.dependencies.map((dep) => ({ ...dep })),
        },
        nextSettings: sb.nextSettings,
        verify,
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { recovery?: string }).recovery).toBe("incomplete");
    expect(String((failure as Error).message)).toMatch(/transaction|incomplete|pending|crash|recover/i);
    expect(verifyRan).toBe(false);

    // Nothing mutated and the marker plus live state are preserved.
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerContent);
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sb.linkPath)).toBe(sb.expectedLinkTarget);
    expect(fs.realpathSync(sb.linkPath)).toBe(sb.packageRoot);
    expect(fs.readFileSync(sb.releaseIndex, "utf8")).toBe(NEW_PI_INDEX);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(sb.gentleIndex, "utf8")).toBe(GENTLE_INDEX);
    expect(fs.readFileSync(sb.adapterIndex, "utf8")).toBe(ADAPTER_INDEX);
    expect(fs.readFileSync(path.join(sb.backupDir, "activation-marker.json"), "utf8")).toBe('{"retained":true}\n');
  });

  it("fails closed and rolls back when verify returns a thenable/Promise instead of void, never claiming success before the async outcome", async () => {
    const sb = setupUninstallSandbox();
    const { deactivateVerifiedPiRelease } = await loadModule();

    // Async escape hatch: sync contract requires `verify: () => void`, so a
    // thenable return must fail closed. Dynamic cast keeps typecheck green.
    const asyncVerify = (() => Promise.resolve()) as unknown as () => void;

    expect(() =>
      deactivateVerifiedPiRelease({
        homeDir: sb.homeDir,
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        managedPackage: {
          releaseDir: sb.releaseDir,
          linkPath: sb.linkPath,
          backupDir: sb.backupDir,
          lockSha256: sb.lockSha256,
          treeSha256: sb.treeSha256,
          dependencies: sb.dependencies.map((dep) => ({ ...dep })),
        },
        nextSettings: sb.nextSettings,
        verify: asyncVerify,
      }),
    ).toThrow();

    // Rolled back byte-identically: no success claimed, no partial removal.
    expect(fs.lstatSync(sb.linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sb.linkPath)).toBe(sb.expectedLinkTarget);
    expect(fs.realpathSync(sb.linkPath)).toBe(sb.packageRoot);
    expect(fs.readFileSync(sb.releaseIndex, "utf8")).toBe(NEW_PI_INDEX);
    expect(crypto.createHash("sha256").update(fs.readFileSync(sb.lockPath)).digest("hex")).toBe(sb.lockSha256);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(sb.treeSha256);
    expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(sb.oldSettings);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(sb.oldReceipt);
    expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
    expect(fs.readFileSync(sb.gentleIndex, "utf8")).toBe(GENTLE_INDEX);
    expect(fs.readFileSync(sb.adapterIndex, "utf8")).toBe(ADAPTER_INDEX);
  });
});
