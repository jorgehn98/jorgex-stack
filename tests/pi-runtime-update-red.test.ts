// T05 RED for T07 managed update via runPiRuntimeSystem (tests only, no prod change).
//
// Desired contract (GREEN in src/lib/pi-runtime.ts, operation "update"):
// - runPiRuntimeSystem({ operation: "update", targetDir: tempSandbox, detected: Pi 0.87.1,
//   engramBin, candidate: NEW test-only, prepared: NEW stage }) from an old valid managed
//   schema1 receipt + projected settings migrates to the different test-only staged release.
// - Old auth FIRST via verifyOfflineManagedPiRelease (mocked spy here; unit gate already
//   real-FS tested): returns validated old receipt/root ONLY when old receipt/settings/source
//   match; otherwise blocked. Activation must never run before that gate.
// - Stage evidence via inspectStagedPiNpm must match the prepared evidence; official
//   Engram setup must never run for --target-dir (mock throws if called).
// - activatePreparedPiInstall must receive previousSource OLD, stage/candidate NEW, and the
//   old settingsJson; result is { kind: "updated", receipt: NEW, packageSource: NEW }.
// - Mocked gate blocked => blocked without activation and original files untouched.
// - Same version + same lock/tree => { kind: "healthy" } without activate (synthetic managedPackage).
//
// Topology (os.tmpdir sandbox only, never real HOME, no network):
// - targetDir/state/pi-receipt.json holds the OLD managed schema1 receipt; targetDir/pi-agent/
//   settings.json holds the single exact managed object { source: OLD, skills: [], prompts: [] }.
// - OLD release/link/backup use the real post-promotion layout (release under
//   npm/jorgex-pi-managed/releases/<id>, single relative link npm/node_modules/jorgex-pi,
//   backup under stage/.activate-backup outside npm); a foreign package file must survive.
// - NEW stage is agentDir/stage-<32hex>/pi-agent with a dummy verified tgz; candidate 9.9.9
//   test-only (contract cloned from the verified fixture, never a published claim).
// - RED currently: update ignores candidate/prepared and returns blocked
//   "verified-update-required" (or "receipt-untrusted" via the frozen registry), so the
//   "updated"/"healthy" expectations below fail for the intended behavioral reason.
//   Typecheck stays green.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

const mocks = vi.hoisted(() => ({
  verifyOfflineManagedPiRelease: vi.fn(),
  activatePreparedPiInstall: vi.fn(),
  inspectStagedPiNpm: vi.fn(),
  runOfficialSetupIfNeeded: vi.fn(),
}));

vi.mock("../src/lib/pi-package-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-package-lifecycle.js")>();
  return { ...actual, verifyOfflineManagedPiRelease: mocks.verifyOfflineManagedPiRelease };
});

vi.mock("../src/lib/pi-install-activation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-install-activation.js")>();
  return { ...actual, activatePreparedPiInstall: mocks.activatePreparedPiInstall };
});

vi.mock("../src/lib/pi-staged-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pi-staged-lock.js")>();
  return { ...actual, inspectStagedPiNpm: mocks.inspectStagedPiNpm };
});

vi.mock("../src/lib/official-engram-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/official-engram-setup.js")>();
  return { ...actual, runOfficialSetupIfNeeded: mocks.runOfficialSetupIfNeeded };
});

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const OLD_VERSION = "9.9.8";
const NEW_VERSION = "9.9.9";
const OLD_SOURCE = `npm:jorgex-pi@${OLD_VERSION}`;
const NEW_SOURCE = `npm:jorgex-pi@${NEW_VERSION}`;

function syntheticHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${20 + index}`;
}

function canonicalDepUrl(name: string, version: string): string {
  const unscoped = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

function canonicalParentTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

type SyntheticDep = { name: string; version: string; integrity: string };

function syntheticDeps(seedFill: number): SyntheticDep[] {
  return STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(seedFill + index),
  }));
}

type SyntheticCandidate = typeof PI_RUNTIME_CANDIDATE & {
  package: { name: string; version: string; source: string };
  tarball: { bytes: number; sha256: string; sha512: string };
  provenance: { commit: string };
};

function syntheticCandidate(version: string, tarballBytes: Buffer, provenanceSeed: string): SyntheticCandidate {
  return {
    ...PI_RUNTIME_CANDIDATE,
    package: { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` },
    tarball: {
      bytes: tarballBytes.byteLength,
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
      sha512: createHash("sha512").update(tarballBytes).digest("hex"),
    },
    provenance: { commit: syntheticHex(provenanceSeed).slice(0, 40) },
  } as SyntheticCandidate;
}

type UpdateSandbox = {
  targetDir: string;
  agentDir: string;
  receiptPath: string;
  settingsPath: string;
  engramBin: string;
  piExecutable: string;
  foreignFile: string;
  oldCandidate: SyntheticCandidate;
  newCandidate: SyntheticCandidate;
  oldReceiptJson: string;
  oldSettingsJson: string;
  oldReleaseDir: string;
  oldPackageRoot: string;
  oldLinkPath: string;
  newReceipt: Record<string, unknown>;
  prepared: {
    candidate: SyntheticCandidate;
    artifact: { path: string; bytes: number; sha256: string; sha512: string };
    release: { version: string; tarballUrl: string; integrity: string };
    stageDir: string;
    evidence: { lockSha256: string; treeSha256: string; dependencies: SyntheticDep[] };
    sourceAlias: string;
  };
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.verifyOfflineManagedPiRelease.mockReset();
  mocks.activatePreparedPiInstall.mockReset();
  mocks.inspectStagedPiNpm.mockReset();
  mocks.runOfficialSetupIfNeeded.mockReset();
  mocks.runOfficialSetupIfNeeded.mockImplementation(() => {
    throw new Error("official Engram setup must not run for targetDir update");
  });
});

function setupUpdateSandbox(opts: { sameVersionHealthy?: boolean } = {}): UpdateSandbox {
  const same = opts.sameVersionHealthy === true;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-update-red-"));
  sandboxes.push(sandbox);
  const targetDir = sandbox;
  const agentDir = path.join(targetDir, "pi-agent");
  const npmDir = path.join(agentDir, "npm");
  fs.mkdirSync(path.join(npmDir, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "state"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "bin"), { recursive: true });

  const engramBin = path.join(targetDir, "bin", "engram");
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
  const piExecutable = path.join(targetDir, "bin", "pi");
  fs.writeFileSync(piExecutable, "#!/bin/sh\nexit 0\n");

  // Foreign package that must survive byte-identically (never copied/removed).
  const foreignDir = path.join(npmDir, "node_modules", "foreign-pkg");
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignFile = path.join(foreignDir, "index.js");
  fs.writeFileSync(foreignFile, "// foreign - must survive\nmodule.exports='foreign';\n");

  // OLD managed release topology (real dirs + relative link, outside-HOME sandbox).
  const oldTarballBytes = Buffer.from(`synthetic-old-tarball-${OLD_VERSION}\n`);
  const oldCandidate = syntheticCandidate(OLD_VERSION, oldTarballBytes, "old-provenance-9-9-8");
  const oldDeps = syntheticDeps(31);
  const oldLockSha = syntheticHex(`old-lock-${OLD_VERSION}`);
  const oldTreeSha = syntheticHex(`old-tree-${OLD_VERSION}`);
  const oldReleaseId = syntheticHex(`old-release-${OLD_VERSION}`);
  const oldReleaseDir = path.join(npmDir, "jorgex-pi-managed", "releases", oldReleaseId);
  const oldPackageRoot = path.join(oldReleaseDir, "node_modules", "jorgex-pi");
  fs.mkdirSync(path.join(oldPackageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(oldPackageRoot, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: OLD_VERSION })}\n`,
  );
  fs.writeFileSync(path.join(oldPackageRoot, "bin", "jorgex-pi.mjs"), "// old synthetic runner\n");
  fs.writeFileSync(path.join(oldReleaseDir, "package-lock.json"), "{}\n");
  const oldLinkPath = path.join(npmDir, "node_modules", "jorgex-pi");
  const oldRelative = path.relative(path.dirname(oldLinkPath), oldPackageRoot);
  fs.symlinkSync(oldRelative, oldLinkPath, "dir");
  const oldStageHex = syntheticHex("old-stage-backup-root").slice(0, 32);
  const oldStageDir = path.join(agentDir, `stage-${oldStageHex}`, "pi-agent");
  const oldBackupDir = path.join(oldStageDir, ".activate-backup");
  fs.mkdirSync(oldBackupDir, { recursive: true });

  const oldReceipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { ...oldCandidate.package },
      tarball: { ...oldCandidate.tarball },
      provenance: { ...oldCandidate.provenance },
    },
    scope: { kind: "target-dir", codingAgentDir: agentDir },
    engram: { binary: engramBin },
    managedPackage: {
      releaseDir: oldReleaseDir,
      linkPath: oldLinkPath,
      backupDir: oldBackupDir,
      lockSha256: oldLockSha,
      treeSha256: oldTreeSha,
      dependencies: oldDeps.map((d) => ({ ...d })),
    },
  };
  const oldReceiptJson = JSON.stringify(oldReceipt);
  const oldSettingsJson = JSON.stringify({
    packages: [{ source: OLD_SOURCE, skills: [], prompts: [] }],
  });
  const receiptPath = path.join(targetDir, "state", "pi-receipt.json");
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(receiptPath, `${oldReceiptJson}\n`);
  fs.writeFileSync(settingsPath, oldSettingsJson);

  // NEW staged release (different test-only version unless sameVersionHealthy).
  const newVersion = same ? OLD_VERSION : NEW_VERSION;
  const newSource = same ? OLD_SOURCE : NEW_SOURCE;
  const newTarballBytes = same
    ? Buffer.from(`synthetic-old-tarball-${OLD_VERSION}\n`)
    : Buffer.from(`synthetic-new-tarball-${NEW_VERSION}\n`);
  const newCandidate = syntheticCandidate(newVersion, newTarballBytes, same ? "old-provenance-9-9-8" : "new-provenance-9-9-9");
  // Same lock/tree for the healthy control; different digests for the update case.
  const newLockSha = same ? oldLockSha : syntheticHex(`new-lock-${NEW_VERSION}`);
  const newTreeSha = same ? oldTreeSha : syntheticHex(`new-tree-${NEW_VERSION}`);
  const newDeps = same ? oldDeps.map((d) => ({ ...d })) : syntheticDeps(77);
  const newStageHex = syntheticHex(same ? "new-stage-same" : "new-stage-update").slice(0, 32);
  const stageDir = path.join(agentDir, `stage-${newStageHex}`, "pi-agent");
  const downloadsDir = path.join(stageDir, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const tarballFile = `jorgex-pi-${newVersion}.tgz`;
  const tarballPath = path.join(downloadsDir, tarballFile);
  fs.writeFileSync(tarballPath, newTarballBytes);
  const parentIntegrity = `sha512-${createHash("sha512").update(newTarballBytes).digest("base64")}`;
  const release = {
    version: newVersion,
    tarballUrl: canonicalParentTarballUrl(newVersion),
    integrity: parentIntegrity,
  };
  const evidence = { lockSha256: newLockSha, treeSha256: newTreeSha, dependencies: newDeps };
  const prepared = {
    candidate: newCandidate,
    artifact: {
      path: tarballPath,
      bytes: newTarballBytes.byteLength,
      sha256: createHash("sha256").update(newTarballBytes).digest("hex"),
      sha512: createHash("sha512").update(newTarballBytes).digest("hex"),
    },
    release,
    stageDir,
    evidence,
    sourceAlias: `npm:jorgex-pi@file:${tarballPath}`,
  };

  // NEW receipt the GREEN activation is expected to publish (mock returns it).
  const newReleaseId = syntheticHex(`new-release-${newVersion}-${newLockSha}`);
  const newReceipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { ...newCandidate.package },
      tarball: { ...newCandidate.tarball },
      provenance: { ...newCandidate.provenance },
    },
    scope: { kind: "target-dir", codingAgentDir: agentDir },
    engram: { binary: engramBin },
    managedPackage: {
      releaseDir: path.join(npmDir, "jorgex-pi-managed", "releases", newReleaseId),
      linkPath: oldLinkPath,
      backupDir: path.join(stageDir, ".activate-backup"),
      lockSha256: newLockSha,
      treeSha256: newTreeSha,
      dependencies: newDeps.map((d) => ({ ...d })),
    },
  };
  void newSource;

  return {
    targetDir,
    agentDir,
    receiptPath,
    settingsPath,
    engramBin,
    piExecutable,
    foreignFile,
    oldCandidate,
    newCandidate,
    oldReceiptJson,
    oldSettingsJson,
    oldReleaseDir,
    oldPackageRoot,
    oldLinkPath,
    newReceipt,
    prepared,
  };
}

function snapshotFiles(sandbox: UpdateSandbox): { receipt: string; settings: string; foreign: string } {
  return {
    receipt: fs.readFileSync(sandbox.receiptPath, "utf8"),
    settings: fs.readFileSync(sandbox.settingsPath, "utf8"),
    foreign: fs.readFileSync(sandbox.foreignFile, "utf8"),
  };
}

describe("pi runtime managed update RED (T05 for T07)", () => {
  it("authenticates the old managed receipt before activation and returns updated with the new receipt/source", async () => {
    const sandbox = setupUpdateSandbox();
    expect(sandbox.oldCandidate.package.source).toBe(OLD_SOURCE);
    expect(sandbox.newCandidate.package.source).toBe(NEW_SOURCE);
    expect(NEW_SOURCE).not.toBe(OLD_SOURCE);
    expect(sandbox.oldReceiptJson).toContain("managedPackage");
    expect(JSON.parse(sandbox.oldSettingsJson)).toEqual({
      packages: [{ source: OLD_SOURCE, skills: [], prompts: [] }],
    });

    const events: string[] = [];
    const fetchCalls: string[] = [];
    const holder = globalThis as unknown as { fetch?: unknown };
    const originalFetch = holder.fetch;
    (holder as Record<string, unknown>)["fetch"] = (...args: unknown[]) => {
      fetchCalls.push(String((args[0] as string | undefined) ?? "fetch"));
      throw new Error("network forbidden in managed update RED");
    };

    // Unit gate is already real-FS tested: this spy only proves ordering for the
    // system seam. It accepts ONLY the exact old receipt/settings/source.
    mocks.verifyOfflineManagedPiRelease.mockImplementation((input: unknown) => {
      events.push("verify");
      const record = input as {
        receiptJson?: unknown;
        engramBin?: unknown;
        detected?: { settingsJson?: unknown };
        paths?: { codingAgentDir?: unknown; targetDir?: unknown };
      };
      const ok =
        record.receiptJson === sandbox.oldReceiptJson &&
        record.detected?.settingsJson === sandbox.oldSettingsJson &&
        record.engramBin === sandbox.engramBin &&
        record.paths?.codingAgentDir === sandbox.agentDir &&
        record.paths?.targetDir === true;
      if (!ok) return { kind: "blocked", reason: "receipt-untrusted" };
      const parsed = JSON.parse(sandbox.oldReceiptJson) as { candidate?: unknown };
      return { kind: "ok", receipt: parsed, realRoot: sandbox.oldPackageRoot };
    });
    mocks.inspectStagedPiNpm.mockImplementation((input: unknown) => {
      events.push("inspect");
      const record = input as { stageDir?: unknown; tarballPath?: unknown; release?: { version?: unknown } };
      expect(record.stageDir).toBe(sandbox.prepared.stageDir);
      expect(record.tarballPath).toBe(sandbox.prepared.artifact.path);
      expect(record.release?.version).toBe(NEW_VERSION);
      return { ...sandbox.prepared.evidence };
    });
    mocks.activatePreparedPiInstall.mockImplementation(async (input: unknown) => {
      events.push("activate");
      const record = input as {
        previousSource?: unknown;
        settingsJson?: unknown;
        scopeKind?: unknown;
        agentDir?: unknown;
        prepared?: { candidate?: { package?: { source?: unknown } }; stageDir?: unknown };
      };
      // GREEN must carry the OLD source/settings into activation, never a bare
      // string or the NEW source as previous.
      expect(record.previousSource).toBe(OLD_SOURCE);
      expect(record.settingsJson).toBe(sandbox.oldSettingsJson);
      expect(record.scopeKind).toBe("target-dir");
      expect(record.agentDir).toBe(sandbox.agentDir);
      expect(record.prepared?.candidate?.package?.source).toBe(NEW_SOURCE);
      expect(record.prepared?.stageDir).toBe(sandbox.prepared.stageDir);
      return { kind: "installed", receipt: sandbox.newReceipt };
    });

    try {
      const { runPiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
      const result = (await runPiRuntimeSystem({
        operation: "update",
        targetDir: sandbox.targetDir,
        detected: { executable: sandbox.piExecutable, version: "0.87.1" },
        engramBin: sandbox.engramBin,
        candidate: sandbox.newCandidate as never,
        prepared: sandbox.prepared as never,
      })) as Record<string, unknown>;

      // No runner, no pi remove, no network: setup never runs, fetch never runs.
      expect(mocks.runOfficialSetupIfNeeded).not.toHaveBeenCalled();
      expect(fetchCalls).toEqual([]);
      // Old auth happens before activation: the gate spy must run first.
      expect(events).toContain("verify");
      expect(events).toContain("activate");
      expect(events.indexOf("verify")).toBeLessThan(events.indexOf("activate"));
      // Stage evidence is verified (inspector sees the NEW stage, not the old tree).
      expect(mocks.inspectStagedPiNpm).toHaveBeenCalled();
      // Foreign package survives; activation owns only the private entry.
      expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toContain("foreign");

      // Desired GREEN outcome: updated with the NEW receipt + source.
      expect(result).toMatchObject({ kind: "updated" });
      const receipt = result["receipt"] as
        | { candidate?: { package?: { source?: unknown; version?: unknown } } }
        | undefined;
      expect(receipt?.candidate?.package?.source).toBe(NEW_SOURCE);
      expect(receipt?.candidate?.package?.version).toBe(NEW_VERSION);
      expect(result["packageSource"]).toBe(NEW_SOURCE);
    } finally {
      holder.fetch = originalFetch;
    }
  });

  it("rejects a blocked old gate without activation and leaves original files untouched", async () => {
    const sandbox = setupUpdateSandbox();
    const before = snapshotFiles(sandbox);
    const foreignBefore = fs.readFileSync(sandbox.foreignFile, "utf8");
    const events: string[] = [];

    mocks.verifyOfflineManagedPiRelease.mockImplementation(() => {
      events.push("verify");
      return { kind: "blocked", reason: "receipt-untrusted" };
    });
    mocks.inspectStagedPiNpm.mockImplementation(() => {
      events.push("inspect");
      return { ...sandbox.prepared.evidence };
    });
    mocks.activatePreparedPiInstall.mockImplementation(async () => {
      events.push("activate");
      return { kind: "installed", receipt: sandbox.newReceipt };
    });

    const { runPiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const result = (await runPiRuntimeSystem({
      operation: "update",
      targetDir: sandbox.targetDir,
      detected: { executable: sandbox.piExecutable, version: "0.87.1" },
      engramBin: sandbox.engramBin,
      candidate: sandbox.newCandidate as never,
      prepared: sandbox.prepared as never,
    })) as Record<string, unknown>;

    expect(mocks.verifyOfflineManagedPiRelease).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["verify"]);
    expect(mocks.inspectStagedPiNpm).not.toHaveBeenCalled();
    expect(mocks.activatePreparedPiInstall).not.toHaveBeenCalled();
    expect(mocks.runOfficialSetupIfNeeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "blocked" });
    expect(snapshotFiles(sandbox)).toEqual(before);
    expect(fs.readFileSync(sandbox.foreignFile, "utf8")).toBe(foreignBefore);
    expect(fs.readlinkSync(sandbox.oldLinkPath)).toBe(
      path.relative(path.dirname(sandbox.oldLinkPath), sandbox.oldPackageRoot),
    );
  });

  it("returns healthy without activation when version and lock/tree are already current", async () => {
    const sandbox = setupUpdateSandbox({ sameVersionHealthy: true });
    expect(sandbox.newCandidate.package.source).toBe(OLD_SOURCE);
    expect(sandbox.prepared.evidence.lockSha256).toBe(
      (JSON.parse(sandbox.oldReceiptJson) as { managedPackage: { lockSha256: string } }).managedPackage.lockSha256,
    );

    const events: string[] = [];
    mocks.verifyOfflineManagedPiRelease.mockImplementation((input: unknown) => {
      events.push("verify");
      const record = input as { receiptJson?: unknown; detected?: { settingsJson?: unknown } };
      if (record.receiptJson !== sandbox.oldReceiptJson) return { kind: "blocked", reason: "receipt-untrusted" };
      if (record.detected?.settingsJson !== sandbox.oldSettingsJson) {
        return { kind: "blocked", reason: "source-divergent" };
      }
      const parsed = JSON.parse(sandbox.oldReceiptJson) as { candidate?: unknown };
      return { kind: "ok", receipt: parsed, realRoot: sandbox.oldPackageRoot };
    });
    mocks.inspectStagedPiNpm.mockImplementation(() => {
      events.push("inspect");
      return { ...sandbox.prepared.evidence };
    });
    mocks.activatePreparedPiInstall.mockImplementation(async () => {
      events.push("activate");
      return { kind: "installed", receipt: sandbox.newReceipt };
    });

    const { runPiRuntimeSystem } = await import("../src/lib/pi-runtime.js");
    const result = (await runPiRuntimeSystem({
      operation: "update",
      targetDir: sandbox.targetDir,
      detected: { executable: sandbox.piExecutable, version: "0.87.1" },
      engramBin: sandbox.engramBin,
      candidate: sandbox.newCandidate as never,
      prepared: sandbox.prepared as never,
    })) as Record<string, unknown>;

    expect(mocks.verifyOfflineManagedPiRelease).toHaveBeenCalled();
    expect(mocks.activatePreparedPiInstall).not.toHaveBeenCalled();
    expect(mocks.runOfficialSetupIfNeeded).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "healthy" });
    expect(events).not.toContain("activate");
  });
});
