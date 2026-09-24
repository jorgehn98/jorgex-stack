import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";
import { inspectStagedPiNpm } from "../src/lib/pi-staged-lock.js";

/**
 * T05 RED for T07 extended Stack receipt / runner realpath (tests only, fix).
 *
 * Previous revision invented `npm/jorgex-pi-managed/backups/<id>` which the
 * real lifecycle never produces: `activateVerifiedPiRelease` retains the old
 * backup at `<stageDir>/.activate-backup` where the real stage is
 * `agentDir/stage-<hex>/pi-agent` (outside npm). This revision uses that real
 * post-promotion topology:
 * - stage root `agentDir/stage-<32hex>/pi-agent` with staged `npm/` +
 *   `downloads/`; valid evidence via real `inspectStagedPiNpm`, then the
 *   staged npm tree is moved into the private release and exposed via the
 *   single relative link `npm/node_modules/jorgex-pi`;
 * - `backupDir = stageDir/.activate-backup` created as a real directory
 *   (retained post-promotion until explicit rollback-window close);
 * - six companion names frozen with tests/fixtures/pi-runtime.ts shape,
 *   synthetic 9.9.x versions with canonical registry URLs and canonical
 *   sha512 SRIs, lock v3, synthetic tarball bytes;
 * - synthetic candidate 9.9.9 test-only (contract cloned from the verified
 *   registry fixture for realistic runner/capabilities, package/tarball/
 *   provenance overridden for internal consistency). Never a claim about any
 *   published Pi release and never a next-version selector; real-parent
 *   ownership stays covered by pi-package-operations.test.ts.
 *
 * Desired contract (no production change here):
 * - Pi native reports release REALPATH in `package.root`. Doctor is healthy
 *   only when the relative link, runner realpath bounded in the npm root,
 *   and lock/tree evidence all match the receipt under owned scope.
 * - Current product `checkManagedPackageForDoctor` wrongly requires
 *   backupDir under `npm/jorgex-pi-managed`, so the real stage backup REDs
 *   with `source-divergent`; GREEN must accept the stage backup yet still
 *   reject a foreign absolute/symlink backupDir.
 * - Negative drift modifies ACTUAL on-disk state with the SAME receipt
 *   (lock bytes tampered), not only the receipt digest.
 * - Offline doctor of a provider-selected managed release (synthetic 9.9.9
 *   test-only, never a factual npm release) whose parent is not in the fresh
 *   frozen registry (.29 current only): `verifyManagedArtifact` callback
 *   (cached tarball bytes/SRI, no network) runs only AFTER managed
 *   link/realpath/lock/tree/deps + scope/source/engram validate; missing or
 *   false blocks `receipt-untrusted` without invoking the runner; on true the
 *   runner identity derives from the receipt parent plus registry
 *   runner/contract policy with actual realpath/version parsing.
 */

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const SYNTHETIC_VERSION = "9.9.9";

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

function canonicalParentTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

type ManagedOperationModule = {
  runPiPackageManagedOperation: (
    input: {
      operation: "doctor" | "uninstall";
      interactive: boolean;
      registry: { id: "pi"; kind: "package-managed"; candidate: unknown; acceptedCandidates?: readonly unknown[] };
      detected: { executable: string; packageRunner: string; settingsJson: string };
      engramBin: string | null;
      receiptJson: string | null;
      paths: {
        targetDir: boolean;
        codingAgentDir: string;
        receiptPath: string;
        environment: Record<string, string>;
      };
    },
    deps: {
      backupSettings(): void;
      verifyManagedArtifact?(receipt: unknown): boolean;
      readSettings?(): string;
      deactivateManagedRelease?(receipt: unknown, nextSettings: string): { kind: string; reason?: string };
      run(invocation: { executable: string; args: string[]; environment: Record<string, string> }): {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      isPackageAbsent(): boolean;
      deleteReceipt(): void;
    },
  ) => { kind: string; packageSource?: string; reason?: string };
};

async function loadOperations(): Promise<ManagedOperationModule> {
  const mod = (await import("../src/lib/pi-package-lifecycle.js")) as Partial<ManagedOperationModule>;
  expect(mod.runPiPackageManagedOperation).toBeTypeOf("function");
  return mod as ManagedOperationModule;
}

type ManagedSyncModule = {
  runPiPackageManagedSync: (
    input: {
      operation: "sync";
      interactive: boolean;
      registry: { id: "pi"; kind: "package-managed"; candidate: unknown; acceptedCandidates?: readonly unknown[] };
      detected: { executable: string; packageRunner: string; settingsJson: string };
      engramBin: string | null;
      receiptJson: string | null;
      paths: {
        targetDir: boolean;
        codingAgentDir: string;
        receiptPath: string;
        environment: Record<string, string>;
      };
    },
    deps: {
      backupSettings(): void;
      verifyManagedArtifact?(receipt: unknown): boolean;
      run(invocation: { executable: string; args: string[]; environment: Record<string, string> }): {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      isPackageAbsent(): boolean;
      deleteReceipt(): void;
    },
  ) => { kind: string; actions?: unknown[]; packageSource?: string; reason?: string };
};

async function loadManagedSync(): Promise<ManagedSyncModule> {
  const mod = (await import("../src/lib/pi-package-lifecycle.js")) as Partial<ManagedSyncModule>;
  expect(mod.runPiPackageManagedSync).toBeTypeOf("function");
  return mod as ManagedSyncModule;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function syntheticHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

type ManagedSandbox = {
  agentDir: string;
  stageDir: string;
  npmDir: string;
  releaseDir: string;
  packageRoot: string;
  linkPath: string;
  linkBin: string;
  backupDir: string;
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
  candidate: typeof PI_RUNTIME_CANDIDATE & {
    package: { name: string; version: string; source: string };
    tarball: { bytes: number; sha256: string; sha512: string };
    provenance: { commit: string };
  };
  engramBin: string;
  receiptPath: string;
  environment: Record<string, string>;
  releaseLockPath: string;
  tarballPath: string;
};

function setupValidManagedSandbox(): ManagedSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-managed-realpath-"));
  sandboxes.push(sandbox);
  const agentDir = path.join(sandbox, "agent");
  const npmDir = path.join(agentDir, "npm");
  // Real stage topology: agentDir/stage-<32hex>/pi-agent (outside npm).
  const stageHex = syntheticHex("jorgex-pi-managed-stage-root").slice(0, 32);
  const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
  const stagedNpm = path.join(stageDir, "npm");
  const downloadsDir = path.join(stageDir, "downloads");
  fs.mkdirSync(stagedNpm, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(path.join(npmDir, "node_modules"), { recursive: true });

  // Synthetic tarball bytes test-only; integrity bound to these exact bytes.
  const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9-managed-realpath\n");
  const parentIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const tarballFile = `jorgex-pi-${SYNTHETIC_VERSION}.tgz`;
  const tarballPath = path.join(downloadsDir, tarballFile);
  fs.writeFileSync(tarballPath, tarballBytes);
  const fileSpec = `file:../downloads/${tarballFile}`;

  const depEntries = STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(11 + index),
  }));
  const parentDeps: Record<string, string> = {};
  for (const dep of depEntries) parentDeps[dep.name] = "*";

  const packages: Record<string, Record<string, unknown>> = {
    "": { dependencies: { "jorgex-pi": fileSpec } },
    "node_modules/jorgex-pi": {
      version: SYNTHETIC_VERSION,
      resolved: fileSpec,
      integrity: parentIntegrity,
      dependencies: parentDeps,
    },
  };
  for (const dep of depEntries) {
    packages[`node_modules/${dep.name}`] = {
      version: dep.version,
      resolved: canonicalDepUrl(dep.name, dep.version),
      integrity: dep.integrity,
    };
  }
  fs.writeFileSync(
    path.join(stagedNpm, "package-lock.json"),
    `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(stagedNpm, "package.json"),
    `${JSON.stringify({ name: "pi-extensions", version: SYNTHETIC_VERSION, dependencies: { "jorgex-pi": fileSpec } }, null, 2)}\n`,
  );

  const stagedModules = path.join(stagedNpm, "node_modules");
  const stagedParent = path.join(stagedModules, "jorgex-pi");
  fs.mkdirSync(path.join(stagedParent, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(stagedParent, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: SYNTHETIC_VERSION, dependencies: parentDeps }, null, 2)}\n`,
  );
  // Runner entry must exist before inspection so the tree digest covers it.
  fs.writeFileSync(path.join(stagedParent, "bin", "jorgex-pi.mjs"), "// synthetic managed runner entry\n");
  for (const dep of depEntries) {
    const dir = path.join(stagedModules, dep.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: dep.name, version: dep.version }, null, 2)}\n`,
    );
  }

  const release = {
    version: SYNTHETIC_VERSION,
    tarballUrl: canonicalParentTarballUrl(SYNTHETIC_VERSION),
    integrity: parentIntegrity,
  };
  // Valid evidence from the real inspector, not hand-rolled digests.
  const evidence = inspectStagedPiNpm({ stageDir, tarballPath, release });
  expect(evidence.dependencies).toHaveLength(6);

  // Promote the verified staged npm tree into the private release (move, never
  // copy the shared npm root) and expose only the single relative link.
  const releaseId = syntheticHex("jorgex-pi-managed-realpath-tracer");
  const releaseDir = path.join(npmDir, "jorgex-pi-managed", "releases", releaseId);
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  fs.renameSync(stagedNpm, releaseDir);
  const packageRoot = path.join(releaseDir, "node_modules", "jorgex-pi");
  const linkPath = path.join(npmDir, "node_modules", "jorgex-pi");
  const relative = path.relative(path.dirname(linkPath), packageRoot);
  expect(relative.startsWith("..")).toBe(true);
  fs.symlinkSync(relative, linkPath, "dir");
  // Real post-promotion backup retained under the stage, outside npm, until
  // the lifecycle explicitly closes the rollback window.
  const backupDir = path.join(stageDir, ".activate-backup");
  fs.mkdirSync(backupDir, { recursive: true });

  // Synthetic candidate internally consistent with the staged tree
  // (same version/tarball bytes); contract shape cloned from the verified
  // fixture for realistic runner/capabilities. Test-only, not published.
  const candidate = {
    ...PI_RUNTIME_CANDIDATE,
    package: { name: "jorgex-pi", version: SYNTHETIC_VERSION, source: `npm:jorgex-pi@${SYNTHETIC_VERSION}` },
    tarball: {
      bytes: tarballBytes.byteLength,
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
      sha512: createHash("sha512").update(tarballBytes).digest("hex"),
    },
    provenance: { commit: syntheticHex("synthetic-managed-provenance").slice(0, 40) },
  } as ManagedSandbox["candidate"];

  const engramBin = path.join(sandbox, "bin", "engram");
  const receiptPath = path.join(sandbox, "state", "pi-receipt.json");
  const environment: Record<string, string> = {
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    TMPDIR: path.join(sandbox, "tmp"),
    PI_CODING_AGENT_DIR: agentDir,
    ENGRAM_BIN: engramBin,
  };
  return {
    agentDir,
    stageDir,
    npmDir,
    releaseDir,
    packageRoot,
    linkPath,
    linkBin: path.join(linkPath, "bin", "jorgex-pi.mjs"),
    backupDir,
    lockSha256: evidence.lockSha256,
    treeSha256: evidence.treeSha256,
    dependencies: [...evidence.dependencies],
    candidate,
    engramBin,
    receiptPath,
    environment,
    releaseLockPath: path.join(releaseDir, "package-lock.json"),
    tarballPath,
  };
}

function managedReceipt(sandbox: ManagedSandbox): string {
  return JSON.stringify({
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: sandbox.candidate.package,
      tarball: sandbox.candidate.tarball,
      provenance: sandbox.candidate.provenance,
    },
    scope: { kind: "target-dir", codingAgentDir: sandbox.agentDir },
    engram: { binary: sandbox.engramBin },
    managedPackage: {
      releaseDir: sandbox.releaseDir,
      linkPath: sandbox.linkPath,
      backupDir: sandbox.backupDir,
      lockSha256: sandbox.lockSha256,
      treeSha256: sandbox.treeSha256,
      dependencies: sandbox.dependencies,
    },
  });
}

function managedSettings(sandbox: ManagedSandbox): string {
  const source = sandbox.candidate.package.source;
  return JSON.stringify({ packages: [{ source, skills: [], prompts: [] }] });
}

function doctorRunnerJson(sandbox: ManagedSandbox, realRoot: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "doctor",
    ok: true,
    package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
    result: { healthy: true },
  })}\n`;
}

function syncRunnerJson(sandbox: ManagedSandbox, realRoot: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "sync",
    ok: true,
    package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
    result: { changed: false, actions: [] },
  })}\n`;
}

function cleanupRunnerJson(sandbox: ManagedSandbox, realRoot: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "cleanup",
    ok: true,
    package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
    result: { changed: false, actions: [] },
  })}\n`;
}

// Foreign entries the uninstall settings plan must preserve (test-only).
const FOREIGN_PKG = "npm:foreign@1.0.0";
const GENTLE_PKG = "npm:gentle-engram@9.9.99";
const ADAPTER_PKG = "npm:pi-mcp-adapter@9.9.98";

function uninstallSettingsWithForeign(ownedSource: string): string {
  return JSON.stringify({
    packages: [FOREIGN_PKG, GENTLE_PKG, ADAPTER_PKG, { source: ownedSource, skills: [], prompts: [] }],
  });
}

function verifyingArtifactCallback(sandbox: ManagedSandbox, verifyCalls: string[]): (receipt: unknown) => boolean {
  return (receipt: unknown) => {
    verifyCalls.push("verify");
    try {
      const r = receipt as {
        candidate?: { package?: { name?: unknown; source?: unknown }; tarball?: { bytes?: unknown; sha256?: unknown; sha512?: unknown } };
      };
      const bytes = fs.readFileSync(sandbox.tarballPath);
      return (
        r.candidate?.package?.name === "jorgex-pi" &&
        r.candidate?.package?.source === sandbox.candidate.package.source &&
        r.candidate?.tarball?.bytes === bytes.byteLength &&
        r.candidate?.tarball?.sha256 === createHash("sha256").update(bytes).digest("hex") &&
        r.candidate?.tarball?.sha512 === createHash("sha512").update(bytes).digest("hex")
      );
    } catch {
      return false;
    }
  };
}

describe("managed private-release realpath RED (T05 for T07, valid evidence)", () => {
  it("accepts the Pi native realpath when link, lock, tree and deps match the receipt", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const sandbox = setupValidManagedSandbox();

    expect(sandbox.dependencies).toHaveLength(6);
    // Real post-promotion topology: stageDir is agentDir/stage-<hex>/pi-agent
    // (outside npm) and the retained backup lives at stageDir/.activate-backup.
    expect(path.basename(sandbox.stageDir)).toBe("pi-agent");
    expect(path.basename(path.dirname(sandbox.stageDir))).toMatch(/^stage-[0-9a-f]{32}$/);
    expect(sandbox.backupDir).toBe(path.join(sandbox.stageDir, ".activate-backup"));
    expect(path.relative(sandbox.npmDir, sandbox.backupDir).startsWith("..")).toBe(true);
    expect(fs.lstatSync(sandbox.backupDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(sandbox.backupDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(sandbox.linkPath).isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(sandbox.linkPath);
    expect(path.isAbsolute(target)).toBe(false);
    expect(path.resolve(path.dirname(sandbox.linkPath), target)).toBe(sandbox.packageRoot);
    const realRoot = fs.realpathSync(sandbox.linkPath);
    expect(realRoot).toBe(sandbox.packageRoot);
    // Evidence is on disk, not made up: lock bytes hash to the receipt digest.
    expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).toBe(
      sandbox.lockSha256,
    );

    const result = runPiPackageManagedOperation(
      {
        operation: "doctor",
        interactive: false,
        registry: { id: "pi", kind: "package-managed", candidate: sandbox.candidate },
        detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
        engramBin: sandbox.engramBin,
        receiptJson: managedReceipt(sandbox),
        paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
      },
      {
        backupSettings() {},
        run() {
          return { exitCode: 0, stdout: doctorRunnerJson(sandbox, realRoot), stderr: "" };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      },
    );

    expect(result).toEqual({ kind: "healthy" });
  });

  it("blocks doctor when the same receipt no longer matches the on-disk lock", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);
    const receiptJson = managedReceipt(sandbox);

    const input = {
      operation: "doctor" as const,
      interactive: false,
      registry: { id: "pi" as const, kind: "package-managed" as const, candidate: sandbox.candidate },
      detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
      engramBin: sandbox.engramBin,
      receiptJson,
      paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
    };
    const deps = {
      backupSettings() {},
      run() {
        return { exitCode: 0, stdout: doctorRunnerJson(sandbox, realRoot), stderr: "" };
      },
      isPackageAbsent() {
        return true;
      },
      deleteReceipt() {},
    };

    // Tamper ACTUAL on-disk lock bytes while keeping the SAME receipt: a
    // correct verifier comparing lockSha256 must now block.
    fs.appendFileSync(sandbox.releaseLockPath, " ");
    expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).not.toBe(
      sandbox.lockSha256,
    );

    expect(runPiPackageManagedOperation(input, deps)).toMatchObject({ kind: "blocked" });
  });

  it("blocks doctor when backupDir is a foreign absolute path outside the lifecycle", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);

    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-foreign-backup-"));
    // Tracked for cleanup, never real HOME.
    sandboxes.push(foreignDir);

    const foreignReceipt = JSON.stringify({ ...JSON.parse(managedReceipt(sandbox)), managedPackage: { ...JSON.parse(managedReceipt(sandbox)).managedPackage, backupDir: foreignDir } });
    expect(path.resolve(foreignDir)).not.toBe(path.resolve(sandbox.backupDir));

    const result = runPiPackageManagedOperation(
      {
        operation: "doctor",
        interactive: false,
        registry: { id: "pi", kind: "package-managed", candidate: sandbox.candidate },
        detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
        engramBin: sandbox.engramBin,
        receiptJson: foreignReceipt,
        paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
      },
      {
        backupSettings() {},
        run() {
          return { exitCode: 0, stdout: doctorRunnerJson(sandbox, realRoot), stderr: "" };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      },
    );

    expect(result).toMatchObject({ kind: "blocked" });
  });

  it("supports offline doctor of a provider-selected managed release via verifyManagedArtifact despite frozen registry", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);
    // Synthetic 9.9.9 test-only receipt; never a factual npm release claim.
    expect(sandbox.candidate.package.version).toBe("9.9.9");
    expect(PI_RUNTIME_CANDIDATE.package.version).not.toBe("9.9.9");
    expect(fs.existsSync(sandbox.tarballPath)).toBe(true);

    const runCalls: string[] = [];
    const verifyCalls: string[] = [];
    const result = runPiPackageManagedOperation(
      {
        operation: "doctor",
        interactive: false,
        // Fresh frozen registry: .29 current only, no acceptedCandidates.
        registry: { id: "pi", kind: "package-managed", candidate: PI_RUNTIME_CANDIDATE },
        detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
        engramBin: sandbox.engramBin,
        receiptJson: managedReceipt(sandbox),
        paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
      },
      {
        backupSettings() {},
        verifyManagedArtifact(receipt: unknown) {
          verifyCalls.push("verify");
          try {
            const r = receipt as {
              candidate?: { package?: { name?: unknown; source?: unknown }; tarball?: { bytes?: unknown; sha256?: unknown; sha512?: unknown } };
            };
            const bytes = fs.readFileSync(sandbox.tarballPath);
            return (
              r.candidate?.package?.name === "jorgex-pi" &&
              r.candidate?.package?.source === sandbox.candidate.package.source &&
              r.candidate?.tarball?.bytes === bytes.byteLength &&
              r.candidate?.tarball?.sha256 === createHash("sha256").update(bytes).digest("hex") &&
              r.candidate?.tarball?.sha512 === createHash("sha512").update(bytes).digest("hex")
            );
          } catch {
            return false;
          }
        },
        run() {
          runCalls.push("run");
          return { exitCode: 0, stdout: doctorRunnerJson(sandbox, realRoot), stderr: "" };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      },
    );

    expect(result).toEqual({ kind: "healthy", packageSource: sandbox.candidate.package.source });
    expect(sandbox.candidate.package.source).not.toBe(PI_RUNTIME_CANDIDATE.package.source);
  });

  it("blocks offline doctor when the artifact callback is missing/false or evidence drifted, without invoking the runner", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();

    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    // Missing callback: must block receipt-untrusted with no runner call.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const result = runPiPackageManagedOperation(
        {
          operation: "doctor",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        {
          backupSettings() {},
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: doctorRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
      expect(result).not.toHaveProperty("packageSource");
      expect(runCalls).toEqual([]);
    }

    // False callback: must block receipt-untrusted with no runner call.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = runPiPackageManagedOperation(
        {
          operation: "doctor",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        {
          backupSettings() {},
          verifyManagedArtifact() {
            verifyCalls.push("verify");
            return false;
          },
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: doctorRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
      expect(result).not.toHaveProperty("packageSource");
      expect(runCalls).toEqual([]);
    }

    // Drifted on-disk lock with the SAME receipt: must block before the
    // callback, with neither callback nor runner invoked.
    {
      const sandbox = setupValidManagedSandbox();
      const receiptJson = managedReceipt(sandbox);
      fs.appendFileSync(sandbox.releaseLockPath, " ");
      expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).not.toBe(
        sandbox.lockSha256,
      );
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = runPiPackageManagedOperation(
        {
          operation: "doctor",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
          engramBin: sandbox.engramBin,
          receiptJson,
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        {
          backupSettings() {},
          verifyManagedArtifact() {
            verifyCalls.push("verify");
            return true;
          },
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: doctorRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("packageSource");
      expect(verifyCalls).toEqual([]);
      expect(runCalls).toEqual([]);
    }
  });

  it("syncs a verified managed release offline via runPiPackageManagedSync despite frozen registry", async () => {
    const { runPiPackageManagedSync } = await loadManagedSync();
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);
    // Synthetic 9.9.9 test-only; frozen registry stays .29 current only.
    expect(sandbox.candidate.package.version).toBe("9.9.9");
    expect(PI_RUNTIME_CANDIDATE.package.version).not.toBe("9.9.9");
    expect(fs.existsSync(sandbox.tarballPath)).toBe(true);

    const runCalls: string[] = [];
    const verifyCalls: string[] = [];
    const result = runPiPackageManagedSync(
      {
        operation: "sync",
        interactive: false,
        registry: { id: "pi", kind: "package-managed", candidate: PI_RUNTIME_CANDIDATE },
        detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
        engramBin: sandbox.engramBin,
        receiptJson: managedReceipt(sandbox),
        paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
      },
      {
        backupSettings() {},
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        run() {
          runCalls.push("run");
          return { exitCode: 0, stdout: syncRunnerJson(sandbox, realRoot), stderr: "" };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      },
    );

    expect(result).toEqual({ kind: "synced", actions: [], packageSource: sandbox.candidate.package.source });
    expect(sandbox.candidate.package.source).not.toBe(PI_RUNTIME_CANDIDATE.package.source);
    expect(runCalls).toEqual(["run"]);
  });

  it("blocks managed sync when the artifact callback fails or the on-disk lock drifted, without invoking the runner", async () => {
    const { runPiPackageManagedSync } = await loadManagedSync();
    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    // False callback with valid evidence: block with no runner call.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = runPiPackageManagedSync(
        {
          operation: "sync",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        {
          backupSettings() {},
          verifyManagedArtifact() {
            verifyCalls.push("verify");
            return false;
          },
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: syncRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("packageSource");
      expect(runCalls).toEqual([]);
    }

    // Drifted on-disk lock with the SAME receipt and a trusting callback:
    // block before the callback and the runner.
    {
      const sandbox = setupValidManagedSandbox();
      const receiptJson = managedReceipt(sandbox);
      fs.appendFileSync(sandbox.releaseLockPath, " ");
      expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).not.toBe(
        sandbox.lockSha256,
      );
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = runPiPackageManagedSync(
        {
          operation: "sync",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: managedSettings(sandbox) },
          engramBin: sandbox.engramBin,
          receiptJson,
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        {
          backupSettings() {},
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: syncRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("packageSource");
      expect(verifyCalls).toEqual([]);
      expect(runCalls).toEqual([]);
    }
  });

  it("uninstalls a verified managed private release offline without pi remove", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);
    const ownedSource = sandbox.candidate.package.source;
    // Synthetic 9.9.9 test-only receipt; frozen registry stays .29 current only.
    expect(ownedSource).toBe("npm:jorgex-pi@9.9.9");
    expect(PI_RUNTIME_CANDIDATE.package.source).not.toBe(ownedSource);
    const settingsJson = uninstallSettingsWithForeign(ownedSource);

    const events: string[] = [];
    const verifyCalls: string[] = [];
    const deactivations: Array<{ receiptSource: unknown; nextSettings: string }> = [];
    const runnerCalls: Array<{ executable: string; args: string[] }> = [];
    const result = runPiPackageManagedOperation(
      {
        operation: "uninstall",
        interactive: false,
        registry: { id: "pi", kind: "package-managed", candidate: PI_RUNTIME_CANDIDATE },
        detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson },
        engramBin: sandbox.engramBin,
        receiptJson: managedReceipt(sandbox),
        paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
      },
      {
        backupSettings() {
          events.push("backup-settings");
        },
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        readSettings() {
          events.push("read-settings");
          return settingsJson;
        },
        deactivateManagedRelease(receipt: unknown, nextSettings: string) {
          events.push("deactivate");
          deactivations.push({
            receiptSource: (receipt as { candidate?: { package?: { source?: unknown } } }).candidate?.package?.source,
            nextSettings,
          });
          return { kind: "uninstalled" };
        },
        run(invocation) {
          events.push(`run:${invocation.args.join(" ")}`);
          runnerCalls.push({ executable: invocation.executable, args: [...invocation.args] });
          if (invocation.args[0] === "cleanup") {
            return { exitCode: 0, stdout: cleanupRunnerJson(sandbox, realRoot), stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "unexpected-runner-call" };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      },
    );

    expect(result).toEqual({ kind: "uninstalled" });
    // Owned runner cleanup only: never a `pi remove` invocation.
    expect(runnerCalls.map((call) => call.args.join(" "))).toEqual(["cleanup --json"]);
    expect(runnerCalls[0]?.executable).toBe(sandbox.linkBin);
    // Journaled before mutation, settings re-read after cleanup, then deactivate.
    expect(events).toEqual(["backup-settings", "run:cleanup --json", "read-settings", "deactivate"]);
    // Deactivation receives the validated receipt plus settings with only the
    // exact owned Pi source removed, preserving gentle/adapter/foreign.
    expect(deactivations).toHaveLength(1);
    expect(deactivations[0]?.receiptSource).toBe(ownedSource);
    expect(JSON.parse(deactivations[0]?.nextSettings ?? "")).toEqual({
      packages: [FOREIGN_PKG, GENTLE_PKG, ADAPTER_PKG],
    });
  });

  it("blocks managed uninstall when artifact auth fails or settings drifted, before cleanup", async () => {
    const { runPiPackageManagedOperation } = await loadOperations();
    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    function uninstallDeps(sandbox: ManagedSandbox, overrides: {
      verify?: (receipt: unknown) => boolean;
      settingsJson: string;
      events: string[];
      runCalls: Array<{ executable: string; args: string[] }>;
      deactivations: Array<{ receiptSource: unknown; nextSettings: string }>;
    }) {
      const verifyCalls: string[] = [];
      return {
        verifyCalls,
        deps: {
          backupSettings() {
            overrides.events.push("backup-settings");
          },
          verifyManagedArtifact:
            overrides.verify ??
            ((receipt: unknown) => {
              verifyCalls.push("verify");
              return false;
            }),
          readSettings() {
            overrides.events.push("read-settings");
            return overrides.settingsJson;
          },
          deactivateManagedRelease(receipt: unknown, nextSettings: string) {
            overrides.events.push("deactivate");
            overrides.deactivations.push({
              receiptSource: (receipt as { candidate?: { package?: { source?: unknown } } }).candidate?.package,
              nextSettings,
            });
            return { kind: "uninstalled" };
          },
          run(invocation: { executable: string; args: string[]; environment: Record<string, string> }) {
            overrides.events.push(`run:${invocation.args.join(" ")}`);
            overrides.runCalls.push({ executable: invocation.executable, args: [...invocation.args] });
            return { exitCode: 0, stdout: cleanupRunnerJson(sandbox, fs.realpathSync(sandbox.linkPath)), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      };
    }

    // False cached artifact with valid evidence: block before cleanup/callback target.
    {
      const sandbox = setupValidManagedSandbox();
      const events: string[] = [];
      const runCalls: Array<{ executable: string; args: string[] }> = [];
      const deactivations: Array<{ receiptSource: unknown; nextSettings: string }> = [];
      const { deps } = uninstallDeps(sandbox, {
        settingsJson: uninstallSettingsWithForeign(sandbox.candidate.package.source),
        events,
        runCalls,
        deactivations,
      });
      const result = runPiPackageManagedOperation(
        {
          operation: "uninstall",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: uninstallSettingsWithForeign(sandbox.candidate.package.source) },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        deps,
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(runCalls).toEqual([]);
      expect(deactivations).toEqual([]);
      expect(events).not.toContain("deactivate");
    }

    // Tampered link with the SAME receipt: block before callback/cleanup.
    {
      const sandbox = setupValidManagedSandbox();
      fs.unlinkSync(sandbox.linkPath);
      fs.symlinkSync(path.resolve(sandbox.packageRoot), sandbox.linkPath);
      const events: string[] = [];
      const runCalls: Array<{ executable: string; args: string[] }> = [];
      const deactivations: Array<{ receiptSource: unknown; nextSettings: string }> = [];
      const cbCalls: string[] = [];
      const { deps } = uninstallDeps(sandbox, {
        verify: verifyingArtifactCallback(sandbox, cbCalls),
        settingsJson: uninstallSettingsWithForeign(sandbox.candidate.package.source),
        events,
        runCalls,
        deactivations,
      });
      const result = runPiPackageManagedOperation(
        {
          operation: "uninstall",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: uninstallSettingsWithForeign(sandbox.candidate.package.source) },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        deps,
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(cbCalls).toEqual([]);
      expect(runCalls).toEqual([]);
      expect(deactivations).toEqual([]);
    }

    // Edited settings (owned entry no longer exact): block before cleanup.
    {
      const sandbox = setupValidManagedSandbox();
      const ownedSource = sandbox.candidate.package.source;
      const editedSettings = JSON.stringify({
        packages: [FOREIGN_PKG, GENTLE_PKG, { source: ownedSource, skills: ["custom"], prompts: [] }],
      });
      const events: string[] = [];
      const runCalls: Array<{ executable: string; args: string[] }> = [];
      const deactivations: Array<{ receiptSource: unknown; nextSettings: string }> = [];
      const cbCalls: string[] = [];
      const { deps } = uninstallDeps(sandbox, {
        verify: verifyingArtifactCallback(sandbox, cbCalls),
        settingsJson: editedSettings,
        events,
        runCalls,
        deactivations,
      });
      const result = runPiPackageManagedOperation(
        {
          operation: "uninstall",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: editedSettings },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: { targetDir: true, codingAgentDir: sandbox.agentDir, receiptPath: sandbox.receiptPath, environment: sandbox.environment },
        },
        deps,
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(cbCalls).toEqual([]);
      expect(runCalls).toEqual([]);
      expect(deactivations).toEqual([]);
    }
  });

  it("verifies an offline managed release via verifyOfflineManagedPiRelease without runner or mutation", async () => {
    const mod = (await import("../src/lib/pi-package-lifecycle.js")) as Record<string, unknown>;
    expect(typeof mod["verifyOfflineManagedPiRelease"], "falta verifyOfflineManagedPiRelease offline T07").toBe(
      "function",
    );
    type VerifyInput = {
      detected: { executable: string; packageRunner: string; settingsJson: string };
      engramBin: string | null;
      receiptJson: string | null;
      paths: { targetDir: boolean; codingAgentDir: string; receiptPath: string; environment: Record<string, string> };
    };
    type VerifyDeps = {
      verifyManagedArtifact?(receipt: unknown): boolean;
      run?(invocation: { executable: string; args: string[]; environment: Record<string, string> }): {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      backupSettings?(): void;
      isPackageAbsent?(): boolean;
      deleteReceipt?(): void;
    };
    type VerifyResult = { kind: string; receipt?: unknown; realRoot?: string; reason?: string };
    const verifyOfflineManagedPiRelease = mod["verifyOfflineManagedPiRelease"] as (
      input: VerifyInput,
      deps: VerifyDeps,
    ) => VerifyResult | Promise<VerifyResult>;

    // Positive: synthetic old managed release (9.9.9 test-only) validates via
    // receipt + cached tgz using the existing doctor/sync input shape. The
    // current frozen registry (.29) is observed only to prove it is NOT an
    // identity comparator here. GREEN may reuse the exact shared
    // checkOfflineManagedRelease gate under this exported name.
    {
      const sandbox = setupValidManagedSandbox();
      expect(sandbox.candidate.package.version).toBe("9.9.9");
      expect(PI_RUNTIME_CANDIDATE.package.version).toBe("0.8.29");
      expect(sandbox.candidate.package.source).not.toBe(PI_RUNTIME_CANDIDATE.package.source);
      const realRoot = fs.realpathSync(sandbox.linkPath);
      expect(realRoot).toBe(sandbox.packageRoot);
      const lockBefore = fs.readFileSync(sandbox.releaseLockPath);
      const linkTargetBefore = fs.readlinkSync(sandbox.linkPath);
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const receiptJson = managedReceipt(sandbox);
      const result = await verifyOfflineManagedPiRelease(
        {
          detected: {
            executable: "/opt/pi/bin/pi",
            packageRunner: sandbox.linkBin,
            settingsJson: managedSettings(sandbox),
          },
          engramBin: sandbox.engramBin,
          receiptJson,
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          backupSettings() {},
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "ok", realRoot });
      const receipt = (result as { receipt?: { candidate?: { package?: { source?: unknown } } } }).receipt;
      expect(receipt !== undefined).toBe(true);
      expect(receipt?.candidate?.package?.source).toBe(sandbox.candidate.package.source);
      expect(verifyCalls).toEqual(["verify"]);
      // No old-runner subprocess and no FS/receiver mutation.
      expect(runCalls).toEqual([]);
      expect(fs.readFileSync(sandbox.releaseLockPath).equals(lockBefore)).toBe(true);
      expect(fs.readlinkSync(sandbox.linkPath)).toBe(linkTargetBefore);
      expect(fs.realpathSync(sandbox.linkPath)).toBe(sandbox.packageRoot);
    }

    // Drift: tampered on-disk lock with the SAME receipt blocks before the
    // cached-tgz callback and before any subprocess.
    {
      const sandbox = setupValidManagedSandbox();
      const receiptJson = managedReceipt(sandbox);
      fs.appendFileSync(sandbox.releaseLockPath, " ");
      expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).not.toBe(
        sandbox.lockSha256,
      );
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await verifyOfflineManagedPiRelease(
        {
          detected: {
            executable: "/opt/pi/bin/pi",
            packageRunner: sandbox.linkBin,
            settingsJson: managedSettings(sandbox),
          },
          engramBin: sandbox.engramBin,
          receiptJson,
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          verifyManagedArtifact() {
            verifyCalls.push("verify");
            return true;
          },
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          backupSettings() {},
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("realRoot");
      expect(verifyCalls).toEqual([]);
      expect(runCalls).toEqual([]);
    }

    // Drift: false cached-tgz callback blocks receipt-untrusted before any runner.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await verifyOfflineManagedPiRelease(
        {
          detected: {
            executable: "/opt/pi/bin/pi",
            packageRunner: sandbox.linkBin,
            settingsJson: managedSettings(sandbox),
          },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          verifyManagedArtifact() {
            verifyCalls.push("verify");
            return false;
          },
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          backupSettings() {},
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
      expect(result).not.toHaveProperty("realRoot");
      expect(verifyCalls).toEqual(["verify"]);
      expect(runCalls).toEqual([]);
    }
  });
});

describe("managed models runner RED (T07, provider-selected 9.9.9)", () => {
  type ManagedModelsInput = {
    operation: "models";
    interactive: boolean;
    registry: {
      id: "pi";
      kind: "package-managed";
      candidate: unknown;
      acceptedCandidates?: readonly unknown[];
    };
    detected: { executable: string; packageRunner: string; settingsJson: string };
    engramBin: string | null;
    receiptJson: string | null;
    paths: {
      targetDir: boolean;
      codingAgentDir: string;
      receiptPath: string;
      environment: Record<string, string>;
    };
  };

  type ManagedModelsDeps = {
    backupSettings(): void;
    verifyManagedArtifact?(receipt: unknown): boolean;
    run(invocation: {
      executable: string;
      args: string[];
      environment: Record<string, string>;
    }): { exitCode: number; stdout: string; stderr: string };
    isPackageAbsent(): boolean;
    deleteReceipt(): void;
  };

  // Live Pi 0.8.31 `models --json` publishes schema1
  // {mode:'managed-primary',primary:{provider:'openai-codex',model:'gpt-5.6-sol',contextWindow:872000},tiers:[...]}.
  // Canonical producer contract/schemas/runner-response.v1.schema.json lines
  // 279-293 pins this exact managed-primary + primary shape; fixture
  // tests/fixtures/pi-runtime.ts managedExternalWrites independently pins the
  // same provider/model/contextWindow pair. No old published producer schema
  // in this repo demonstrates inherit-session as legitimate legacy output
  // (grep finds it only in Stack parsers/tests), so no legacy acceptance is
  // invented here.
  const MANAGED_PRIMARY_MODE = "managed-primary";
  const MANAGED_PRIMARY = { provider: "openai-codex", model: "gpt-5.6-sol", contextWindow: 872000 };
  const MANAGED_TIERS = ["strong", "standard", "cheap"];

  type ManagedModelsResult = {
    kind: string;
    models?: { mode: string; primary?: { provider: string; model: string; contextWindow: number }; tiers: string[] };
    reason?: string;
  };

  type ManagedModelsFn = (
    input: ManagedModelsInput,
    deps: ManagedModelsDeps,
  ) => ManagedModelsResult | Promise<ManagedModelsResult>;

  async function loadManagedModels(): Promise<ManagedModelsFn> {
    const mod = (await import("../src/lib/pi-package-lifecycle.js")) as unknown as Record<string, unknown>;
    expect(typeof mod["runPiPackageManagedModels"], "falta runPiPackageManagedModels gestionado T07").toBe(
      "function",
    );
    return mod["runPiPackageManagedModels"] as ManagedModelsFn;
  }

  function modelsRunnerJson(sandbox: ManagedSandbox, realRoot: string): string {
    return `${JSON.stringify({
      schemaVersion: 1,
      command: "models",
      ok: true,
      package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
      result: {
        mode: MANAGED_PRIMARY_MODE,
        primary: { ...MANAGED_PRIMARY },
        tiers: [...MANAGED_TIERS],
      },
    })}\n`;
  }

  function modelsInput(sandbox: ManagedSandbox): ManagedModelsInput {
    return {
      operation: "models",
      interactive: false,
      registry: { id: "pi", kind: "package-managed", candidate: PI_RUNTIME_CANDIDATE },
      detected: {
        executable: "/opt/pi/bin/pi",
        packageRunner: sandbox.linkBin,
        settingsJson: managedSettings(sandbox),
      },
      engramBin: sandbox.engramBin,
      receiptJson: managedReceipt(sandbox),
      paths: {
        targetDir: true,
        codingAgentDir: sandbox.agentDir,
        receiptPath: sandbox.receiptPath,
        environment: sandbox.environment,
      },
    };
  }

  it("runs models --json on a verified provider-selected release and returns managed-primary with exact published primary", async () => {
    const runPiPackageManagedModels = await loadManagedModels();
    const sandbox = setupValidManagedSandbox();
    // Old managed synthetic provider-selected receipt 9.9.9; current static registry candidate stays .29.
    expect(sandbox.candidate.package.version).toBe("9.9.9");
    expect(PI_RUNTIME_CANDIDATE.package.version).toBe("0.8.29");
    expect(sandbox.candidate.package.source).not.toBe(PI_RUNTIME_CANDIDATE.package.source);
    expect(fs.existsSync(sandbox.tarballPath)).toBe(true);
    const realRoot = fs.realpathSync(sandbox.linkPath);
    expect(realRoot).toBe(sandbox.packageRoot);
    const lockBefore = fs.readFileSync(sandbox.releaseLockPath);
    const linkTargetBefore = fs.readlinkSync(sandbox.linkPath);

    const runCalls: string[] = [];
    const verifyCalls: string[] = [];
    const invocations: Array<{ executable: string; args: string[]; environment: Record<string, string> }> = [];
    const events: string[] = [];
    const result = await runPiPackageManagedModels(modelsInput(sandbox), {
      backupSettings() {
        events.push("backup-settings");
      },
      verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
      run(invocation) {
        runCalls.push("run");
        invocations.push({
          executable: invocation.executable,
          args: [...invocation.args],
          environment: { ...invocation.environment },
        });
        return { exitCode: 0, stdout: modelsRunnerJson(sandbox, realRoot), stderr: "" };
      },
      isPackageAbsent() {
        return true;
      },
      deleteReceipt() {
        events.push("delete-receipt");
      },
    });

    // RED: current runPiPackageManagedModels still parses only obsolete
    // inherit-session, so this exact published managed-primary payload blocks
    // with runner-unhealthy until the parser is fixed. Mock envelope is valid
    // (receipt version/root/realpath + tiers exact); failure must come from the
    // models-mode/primary mismatch, not mock setup.
    expect(result).toEqual({
      kind: "models",
      models: {
        mode: MANAGED_PRIMARY_MODE,
        primary: { ...MANAGED_PRIMARY },
        tiers: [...MANAGED_TIERS],
      },
    });
    // Authenticated cached artifact gate ran once, then exactly one package runner call.
    expect(verifyCalls).toEqual(["verify"]);
    expect(runCalls).toEqual(["run"]);
    expect(invocations).toHaveLength(1);
    const first = invocations[0];
    expect(first?.executable).toBe(sandbox.linkBin);
    expect(first?.args).toEqual(["models", "--json"]);
    expect(first?.environment).toEqual(sandbox.environment);
    // No network or writes: evidence untouched, no receipt mutation.
    expect(events).toEqual([]);
    expect(fs.readFileSync(sandbox.releaseLockPath).equals(lockBefore)).toBe(true);
    expect(fs.readlinkSync(sandbox.linkPath)).toBe(linkTargetBefore);
    expect(fs.realpathSync(sandbox.linkPath)).toBe(sandbox.packageRoot);
  });

  it("blocks models before the runner when link or lock drifted", async () => {
    const runPiPackageManagedModels = await loadManagedModels();
    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    // Lock drift: SAME receipt, tampered on-disk lock bytes.
    {
      const sandbox = setupValidManagedSandbox();
      const receiptJson = managedReceipt(sandbox);
      fs.appendFileSync(sandbox.releaseLockPath, " ");
      expect(createHash("sha256").update(fs.readFileSync(sandbox.releaseLockPath)).digest("hex")).not.toBe(
        sandbox.lockSha256,
      );
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(
        {
          operation: "models",
          interactive: false,
          registry: baseRegistry,
          detected: {
            executable: "/opt/pi/bin/pi",
            packageRunner: sandbox.linkBin,
            settingsJson: managedSettings(sandbox),
          },
          engramBin: sandbox.engramBin,
          receiptJson,
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          backupSettings() {},
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: modelsRunnerJson(sandbox, sandbox.packageRoot), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual([]);
      expect(runCalls).toEqual([]);
    }

    // Link drift: SAME receipt, absolute symlink target instead of the contained relative link.
    {
      const sandbox = setupValidManagedSandbox();
      fs.unlinkSync(sandbox.linkPath);
      fs.symlinkSync(path.resolve(sandbox.packageRoot), sandbox.linkPath);
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(
        {
          operation: "models",
          interactive: false,
          registry: baseRegistry,
          detected: {
            executable: "/opt/pi/bin/pi",
            packageRunner: sandbox.linkBin,
            settingsJson: managedSettings(sandbox),
          },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          backupSettings() {},
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: modelsRunnerJson(sandbox, sandbox.packageRoot), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual([]);
      expect(runCalls).toEqual([]);
    }
  });

  it("blocks models without a receipt or with a manual entry, without invoking the runner", async () => {
    const runPiPackageManagedModels = await loadManagedModels();
    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    // Missing receipt: valid settings/source but receiptJson null.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const input = modelsInput(sandbox);
      const result = await runPiPackageManagedModels(
        { ...input, registry: baseRegistry, receiptJson: null },
        {
          backupSettings() {},
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: modelsRunnerJson(sandbox, sandbox.packageRoot), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(runCalls).toEqual([]);
    }

    // Manual entry: bare string source instead of the exact managed object, SAME receipt.
    {
      const sandbox = setupValidManagedSandbox();
      const ownedSource = sandbox.candidate.package.source;
      const manualSettings = JSON.stringify({ packages: [ownedSource] });
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(
        {
          operation: "models",
          interactive: false,
          registry: baseRegistry,
          detected: { executable: "/opt/pi/bin/pi", packageRunner: sandbox.linkBin, settingsJson: manualSettings },
          engramBin: sandbox.engramBin,
          receiptJson: managedReceipt(sandbox),
          paths: {
            targetDir: true,
            codingAgentDir: sandbox.agentDir,
            receiptPath: sandbox.receiptPath,
            environment: sandbox.environment,
          },
        },
        {
          backupSettings() {},
          verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
          run() {
            runCalls.push("run");
            return { exitCode: 0, stdout: modelsRunnerJson(sandbox, sandbox.packageRoot), stderr: "" };
          },
          isPackageAbsent() {
            return true;
          },
          deleteReceipt() {},
        },
      );
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(runCalls).toEqual([]);
    }
  });

  it("rejects a models runner record with wrong version, root, or tiers", async () => {
    const runPiPackageManagedModels = await loadManagedModels();
    const baseRegistry = { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE };

    function modelsInputFor(sandbox: ManagedSandbox): ManagedModelsInput {
      return {
        operation: "models",
        interactive: false,
        registry: baseRegistry,
        detected: {
          executable: "/opt/pi/bin/pi",
          packageRunner: sandbox.linkBin,
          settingsJson: managedSettings(sandbox),
        },
        engramBin: sandbox.engramBin,
        receiptJson: managedReceipt(sandbox),
        paths: {
          targetDir: true,
          codingAgentDir: sandbox.agentDir,
          receiptPath: sandbox.receiptPath,
          environment: sandbox.environment,
        },
      };
    }

    // Wrong version: registry .29 identity instead of the 9.9.9 receipt parent.
    {
      const sandbox = setupValidManagedSandbox();
      const realRoot = fs.realpathSync(sandbox.linkPath);
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(modelsInputFor(sandbox), {
        backupSettings() {},
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        run() {
          runCalls.push("run");
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              command: "models",
              ok: true,
              package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root: realRoot },
              result: {
                mode: MANAGED_PRIMARY_MODE,
                primary: { ...MANAGED_PRIMARY },
                tiers: [...MANAGED_TIERS],
              },
            })}\n`,
            stderr: "",
          };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      });
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual(["verify"]);
      expect(runCalls).toEqual(["run"]);
    }

    // Wrong root: lexical link path instead of the release realRoot.
    {
      const sandbox = setupValidManagedSandbox();
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(modelsInputFor(sandbox), {
        backupSettings() {},
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        run() {
          runCalls.push("run");
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              command: "models",
              ok: true,
              package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: sandbox.linkPath },
              result: {
                mode: MANAGED_PRIMARY_MODE,
                primary: { ...MANAGED_PRIMARY },
                tiers: [...MANAGED_TIERS],
              },
            })}\n`,
            stderr: "",
          };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      });
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual(["verify"]);
      expect(runCalls).toEqual(["run"]);
    }

    // Wrong tiers: managed-primary contract requires the exact published tiers.
    {
      const sandbox = setupValidManagedSandbox();
      const realRoot = fs.realpathSync(sandbox.linkPath);
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(modelsInputFor(sandbox), {
        backupSettings() {},
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        run() {
          runCalls.push("run");
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              command: "models",
              ok: true,
              package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
              result: {
                mode: MANAGED_PRIMARY_MODE,
                primary: { ...MANAGED_PRIMARY },
                tiers: ["strong", "standard"],
              },
            })}\n`,
            stderr: "",
          };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      });
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual(["verify"]);
      expect(runCalls).toEqual(["run"]);
    }
  });

  it("rejects wrong managed-primary provider, model, contextWindow, or missing primary", async () => {
    const runPiPackageManagedModels = await loadManagedModels();

    async function expectBlockedForResult(resultPayload: unknown): Promise<void> {
      const sandbox = setupValidManagedSandbox();
      const realRoot = fs.realpathSync(sandbox.linkPath);
      const runCalls: string[] = [];
      const verifyCalls: string[] = [];
      const result = await runPiPackageManagedModels(modelsInput(sandbox), {
        backupSettings() {},
        verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
        run() {
          runCalls.push("run");
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              schemaVersion: 1,
              command: "models",
              ok: true,
              package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
              result: resultPayload,
            })}\n`,
            stderr: "",
          };
        },
        isPackageAbsent() {
          return true;
        },
        deleteReceipt() {},
      });
      expect(result).toMatchObject({ kind: "blocked" });
      expect(result).not.toHaveProperty("models");
      expect(verifyCalls).toEqual(["verify"]);
      expect(runCalls).toEqual(["run"]);
    }

    // Envelope (version/root) stays valid; only the published primary is wrong.
    // GREEN must keep rejecting each field exactly; no invented fallback.
    await expectBlockedForResult({
      mode: MANAGED_PRIMARY_MODE,
      primary: { provider: "other-provider", model: "gpt-5.6-sol", contextWindow: 872000 },
      tiers: [...MANAGED_TIERS],
    });
    await expectBlockedForResult({
      mode: MANAGED_PRIMARY_MODE,
      primary: { provider: "openai-codex", model: "other-model", contextWindow: 872000 },
      tiers: [...MANAGED_TIERS],
    });
    await expectBlockedForResult({
      mode: MANAGED_PRIMARY_MODE,
      primary: { provider: "openai-codex", model: "gpt-5.6-sol", contextWindow: 1 },
      tiers: [...MANAGED_TIERS],
    });
    await expectBlockedForResult({ mode: MANAGED_PRIMARY_MODE, tiers: [...MANAGED_TIERS] });
  });

  it("rejects obsolete inherit-session without legacy producer evidence", async () => {
    const runPiPackageManagedModels = await loadManagedModels();
    // RED: current parser still accepts obsolete inherit-session, so this
    // blocks-expected record returns success until the parser requires the
    // published managed-primary shape. No old published producer schema in
    // this repo shows inherit-session as legitimate output, so acceptance is
    // not kept as legacy compatibility.
    const sandbox = setupValidManagedSandbox();
    const realRoot = fs.realpathSync(sandbox.linkPath);
    const runCalls: string[] = [];
    const verifyCalls: string[] = [];
    const result = await runPiPackageManagedModels(modelsInput(sandbox), {
      backupSettings() {},
      verifyManagedArtifact: verifyingArtifactCallback(sandbox, verifyCalls),
      run() {
        runCalls.push("run");
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            schemaVersion: 1,
            command: "models",
            ok: true,
            package: { name: "jorgex-pi", version: sandbox.candidate.package.version, root: realRoot },
            result: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] },
          })}\n`,
          stderr: "",
        };
      },
      isPackageAbsent() {
        return true;
      },
      deleteReceipt() {},
    });
    expect(result).toMatchObject({ kind: "blocked" });
    expect(result).not.toHaveProperty("models");
    expect(verifyCalls).toEqual(["verify"]);
    expect(runCalls).toEqual(["run"]);
  });
});
