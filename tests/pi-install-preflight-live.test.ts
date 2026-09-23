import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * [T05/T06-RED] Live composition of the already-tested Stack Pi provider
 * chain into one isolated managed-install preflight without activation.
 *
 * Intended code-facing contract (no production change here):
 * - `preparePiManagedInstall({ homeDir, agentDir, piExecutable, downloadsDir },
 *   { fetchImpl, run })` exported from `src/lib/pi-install-preflight.ts`.
 * - Internally composes in order `resolveLatestPiRelease`,
 *   `resolvePiProducerCommit`, `downloadVerifiedPiTarball`,
 *   `stageVerifiedPiTarball`, `buildStagedPiCandidate`; it never mutates the
 *   global active package, projection, settings, or receipt.
 * - `fetchImpl` performs the public provider reads (official npm packument
 *   plus official producer tag ref); `run` invokes the detected Pi CLI with
 *   the isolated stage env/cwd only.
 * - Returns the dynamic `{ candidate, artifact, release, stageDir, evidence,
 *   sourceAlias }` observed live: provider-selected release identity, verified
 *   tarball bytes/digests, informational producer commit, staged lock/tree
 *   evidence, and the exact staged `file:` alias. No activation.
 * - After the preflight, runs `smokeStagedPiRuntime({ piExecutable, stageDir,
 *   timeoutMs })` from `src/lib/pi-stage-smoke.ts` against the staged
 *   `pi-agent` dir BEFORE sandbox cleanup and asserts the required public
 *   commands (`goal`, `subagents`, `permission-system`, `websearch`,
 *   `jorgex:header`) are present. Engram tools are deliberately never
 *   required here: the stage carries no official provider pair.
 *
 * Live gate:
 * - Skipped unless `JORGEX_PI_BIN` points at a real Pi CLI. CI/default stays
 *   offline with no network and no hardcoded provider version anywhere in
 *   this file: every expected identity is derived from the live provider
 *   responses or cross-checked between the returned objects.
 * - All paths live under an `os.tmpdir()` sandbox acting as fake home, fake
 *   agent, and fake Stack downloads. The real user HOME, the real agent dir,
 *   and any personal Pi state are never read as inputs nor written.
 */

type PreflightPaths = {
  homeDir: string;
  agentDir: string;
  piExecutable: string;
  downloadsDir: string;
};

type PreflightRunOptions = {
  env: Record<string, string>;
  cwd: string;
};

type PreflightRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PreflightRun = (
  executable: string,
  args: string[],
  options: PreflightRunOptions,
) => PreflightRunResult | Promise<PreflightRunResult>;

type PreflightDeps = {
  fetchImpl: typeof fetch;
  run: PreflightRun;
};

type PreflightRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type PreflightArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
};

type PreflightEvidence = {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
};

type PreflightCandidate = {
  package: { name: string; version: string; source: string };
  provenance: { commit: string };
  tarball: { bytes: number; sha256: string; sha512: string };
  pi: { testedVersions: readonly string[] };
  contract: {
    schemaVersion: number;
    capabilities: readonly string[];
    runner: {
      bin: string;
      commands: readonly string[];
      schemaVersion: number;
      maxStdoutBytes: number;
    };
    managedExternalWrites: readonly unknown[];
  };
};

type PreflightResult = {
  candidate: PreflightCandidate;
  artifact: PreflightArtifact;
  release: PreflightRelease;
  stageDir: string;
  evidence: PreflightEvidence;
  sourceAlias: string;
};

type PreflightModule = {
  preparePiManagedInstall(paths: PreflightPaths, deps: PreflightDeps): Promise<PreflightResult>;
};

const preflightSpecifier = new URL("../src/lib/pi-install-preflight.js", import.meta.url).href;

async function loadPreflight(): Promise<PreflightModule> {
  const mod = (await import(/* @vite-ignore */ preflightSpecifier)) as Partial<PreflightModule>;
  expect(
    mod.preparePiManagedInstall,
    "preparePiManagedInstall must be exported from src/lib/pi-install-preflight.ts",
  ).toBeTypeOf("function");
  return mod as PreflightModule;
}

const liveBinRaw = (process.env["JORGEX_PI_BIN"] ?? "").trim();
const liveBin = liveBinRaw === "" ? undefined : liveBinRaw;

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const COMMIT40 = /^[0-9a-f]{40}$/;
const STAGE_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 60_000;

const REQUIRED_SMOKE_COMMANDS = [
  "goal",
  "subagents",
  "permission-system",
  "websearch",
  "jorgex:header",
] as const;

function expectRequiredSmokeCommands(commands: string[]): void {
  for (const required of REQUIRED_SMOKE_COMMANDS) {
    expect(commands, `staged smoke must expose required command ${required}`).toContain(required);
  }
}

type SmokeInput = {
  piExecutable: string;
  stageDir: string;
  timeoutMs?: number;
};

type SmokeResult = {
  commands: string[];
};

type StageSmokeModule = {
  smokeStagedPiRuntime(input: SmokeInput): Promise<SmokeResult>;
};

const smokeSpecifier = new URL("../src/lib/pi-stage-smoke.js", import.meta.url).href;

async function loadSmoke(): Promise<StageSmokeModule> {
  const mod = (await import(/* @vite-ignore */ smokeSpecifier)) as Partial<StageSmokeModule>;
  expect(
    mod.smokeStagedPiRuntime,
    "smokeStagedPiRuntime must be exported from src/lib/pi-stage-smoke.ts",
  ).toBeTypeOf("function");
  return mod as StageSmokeModule;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isStrictChild(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

type LiveSandbox = {
  sandbox: string;
  homeDir: string;
  agentDir: string;
  downloadsDir: string;
  settingsPath: string;
  receiptPath: string;
  foreignIndex: string;
  beforeSettings: string;
  beforeReceipt: string;
  beforeForeign: string;
};

function buildLiveSandbox(): LiveSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-preflight-live-"));
  sandboxes.push(sandbox);
  const homeDir = path.join(sandbox, "home");
  const agentDir = path.join(homeDir, "agent");
  const downloadsDir = path.join(sandbox, "stack-downloads");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const foreignDir = path.join(agentDir, "npm", "node_modules", "foreign-pkg");
  const foreignIndex = path.join(foreignDir, "index.js");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  // Active-tree markers only: arbitrary bytes without any provider version.
  // They prove the preflight leaves foreign state byte-identical.
  fs.writeFileSync(foreignIndex, "// foreign active entry - must survive byte-identically\n");
  fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: ["foreign-marker"] })}\n`);
  fs.writeFileSync(receiptPath, `${JSON.stringify({ marker: "foreign-active" })}\n`);
  return {
    sandbox,
    homeDir,
    agentDir,
    downloadsDir,
    settingsPath,
    receiptPath,
    foreignIndex,
    beforeSettings: fs.readFileSync(settingsPath, "utf8"),
    beforeReceipt: fs.readFileSync(receiptPath, "utf8"),
    beforeForeign: fs.readFileSync(foreignIndex, "utf8"),
  };
}

function runRealPi(executable: string, args: string[], options: PreflightRunOptions): PreflightRunResult {
  const outcome = spawnSync(executable, args, {
    cwd: options.cwd,
    env: { ...options.env },
    timeout: STAGE_TIMEOUT_MS,
    shell: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (outcome.error !== undefined) throw outcome.error;
  return {
    exitCode: outcome.status ?? 1,
    stdout: typeof outcome.stdout === "string" ? outcome.stdout : String(outcome.stdout ?? ""),
    stderr: typeof outcome.stderr === "string" ? outcome.stderr : String(outcome.stderr ?? ""),
  };
}

function canonicalTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

describe.skipIf(!liveBin)("Pi managed-install preflight composes the live provider chain without activation", () => {
  it("resolves, verifies, stages, and returns a dynamic candidate while leaving active state untouched", async () => {
    const { preparePiManagedInstall } = await loadPreflight();
    const piExecutable = liveBin as string;
    expect(path.isAbsolute(piExecutable)).toBe(true);
    expect(fs.existsSync(piExecutable)).toBe(true);

    const sandbox = buildLiveSandbox();
    const fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args);

    const result = await preparePiManagedInstall(
      {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable,
        downloadsDir: sandbox.downloadsDir,
      },
      { fetchImpl, run: runRealPi },
    );

    // Dynamic provider identity: stable selector, canonical registry URL,
    // canonical sha512 SRI. No literal provider version asserted anywhere.
    expect(STABLE_SEMVER.test(result.release.version)).toBe(true);
    expect(result.release.tarballUrl).toBe(canonicalTarballUrl(result.release.version));
    expect(result.release.integrity.startsWith("sha512-")).toBe(true);

    // Verified artifact: private temp publish under the fake downloads dir,
    // byte-exact with the release SRI (hex sha512 matches base64 SRI).
    expect(path.isAbsolute(result.artifact.path)).toBe(true);
    expect(isStrictChild(sandbox.downloadsDir, result.artifact.path)).toBe(true);
    const onDisk = fs.readFileSync(result.artifact.path);
    expect(onDisk.byteLength).toBe(result.artifact.bytes);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(result.artifact.sha256);
    const onDisk512 = createHash("sha512").update(onDisk).digest();
    const expected512 = Buffer.from(result.release.integrity.slice("sha512-".length), "base64");
    expect(onDisk512.equals(expected512)).toBe(true);
    expect(result.artifact.sha512).toBe(onDisk512.toString("hex"));
    expect(HEX64.test(result.artifact.sha256)).toBe(true);
    expect(HEX128.test(result.artifact.sha512)).toBe(true);

    // Independent live cross-check: the returned release is the currently
    // published selector, not a frozen literal.
    const packumentResponse = await fetchImpl("https://registry.npmjs.org/jorgex-pi", {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      redirect: "error",
    });
    expect(packumentResponse.ok).toBe(true);
    const packument = (await packumentResponse.json()) as {
      ["dist-tags"]?: { latest?: unknown };
    };
    expect(packument["dist-tags"]?.["latest"]).toBe(result.release.version);

    // Dynamic candidate: package/source from the live release, tarball bytes
    // from the verified artifact, informational producer commit shape.
    expect(result.candidate.package).toEqual({
      name: "jorgex-pi",
      version: result.release.version,
      source: `npm:jorgex-pi@${result.release.version}`,
    });
    expect(result.candidate.tarball).toEqual({
      bytes: result.artifact.bytes,
      sha256: result.artifact.sha256,
      sha512: result.artifact.sha512,
    });
    expect(COMMIT40.test(result.candidate.provenance.commit)).toBe(true);

    // Independent live cross-check: the informational commit matches the
    // official public tag ref for the resolved release.
    const refResponse = await fetchImpl(
      `https://api.github.com/repos/jorgehn98/jorgex-pi/git/ref/tags/v${result.release.version}`,
      { headers: { accept: "application/vnd.github+json" }, redirect: "error" },
    );
    expect(refResponse.ok).toBe(true);
    const ref = (await refResponse.json()) as {
      ref?: unknown;
      object?: { type?: unknown; sha?: unknown };
    };
    expect(ref.ref).toBe(`refs/tags/v${result.release.version}`);
    expect(ref.object?.["type"]).toBe("commit");
    expect(ref.object?.["sha"]).toBe(result.candidate.provenance.commit);

    // Staged evidence: lock/tree digests plus resolved companion SRI set.
    // The lock digest is re-hashed from the isolated stage, never trusted
    // blindly; companion versions/hashes stay observed, never pinned here.
    expect(HEX64.test(result.evidence.lockSha256)).toBe(true);
    expect(HEX64.test(result.evidence.treeSha256)).toBe(true);
    expect(result.evidence.dependencies.length).toBeGreaterThan(0);
    for (const dep of result.evidence.dependencies) {
      expect(typeof dep.name).toBe("string");
      expect(dep.name.length).toBeGreaterThan(0);
      expect(typeof dep.version).toBe("string");
      expect(dep.version.length).toBeGreaterThan(0);
      expect(dep.integrity.startsWith("sha512-")).toBe(true);
    }
    expect(isStrictChild(sandbox.agentDir, result.stageDir)).toBe(true);
    expect(path.basename(result.stageDir)).toBe("pi-agent");
    const stagedLockPath = path.join(result.stageDir, "npm", "package-lock.json");
    expect(createHash("sha256").update(fs.readFileSync(stagedLockPath)).digest("hex")).toBe(
      result.evidence.lockSha256,
    );
    expect(result.sourceAlias).toBe(`npm:jorgex-pi@file:${result.artifact.path}`);
    const stagedSettings = JSON.parse(fs.readFileSync(path.join(result.stageDir, "settings.json"), "utf8")) as {
      packages?: unknown;
    };
    expect(JSON.stringify(stagedSettings.packages)).toContain(result.sourceAlias);

    // Staged ABI smoke BEFORE sandbox cleanup: the real staged Pi host must
    // serve the required public commands through its isolated rpc launch.
    // Engram tools are deliberately not required: the stage carries no
    // official provider pair.
    const { smokeStagedPiRuntime } = await loadSmoke();
    const smokeHomeBefore = process.env["HOME"];
    const smokeAgentDirBefore = process.env["PI_CODING_AGENT_DIR"];
    const smoke = await smokeStagedPiRuntime({
      piExecutable,
      stageDir: result.stageDir,
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    expect(Array.isArray(smoke.commands)).toBe(true);
    expectRequiredSmokeCommands(smoke.commands);

    // No activation: the fake active tree stays byte-identical and holds no
    // managed entry; the stage lives under the sandbox, never the real HOME.
    // These readbacks run after the smoke too, so the smoke itself is proven
    // to have touched no external/home state.
    expect(process.env["HOME"]).toBe(smokeHomeBefore);
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(smokeAgentDirBefore);
    expect(fs.readFileSync(sandbox.settingsPath, "utf8")).toBe(sandbox.beforeSettings);
    expect(fs.readFileSync(sandbox.receiptPath, "utf8")).toBe(sandbox.beforeReceipt);
    expect(fs.readFileSync(sandbox.foreignIndex, "utf8")).toBe(sandbox.beforeForeign);
    expect(fs.existsSync(path.join(sandbox.agentDir, "npm", "node_modules", "jorgex-pi"))).toBe(false);
    expect(path.resolve(sandbox.homeDir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(result.stageDir).not.toBe(sandbox.agentDir);
  }, 300_000);
});
