import fs from "node:fs";
import path from "node:path";
import { buildStagedPiCandidate } from "./pi-candidate.js";
import {
  downloadVerifiedPiTarball,
  resolveLatestPiRelease,
  resolvePiProducerCommit,
} from "./pi-release-resolver.js";
import { stageVerifiedPiTarball } from "./pi-release-stage.js";
import type { PiRuntimeCandidate } from "./pi-package-lifecycle.js";

export interface PiInstallPreflightPaths {
  homeDir: string;
  agentDir: string;
  piExecutable: string;
  downloadsDir: string;
}

export interface PiInstallPreflightRunOptions {
  env: Record<string, string>;
  cwd: string;
}

export interface PiInstallPreflightRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PiInstallPreflightRun = (
  executable: string,
  args: string[],
  options: PiInstallPreflightRunOptions,
) => PiInstallPreflightRunResult | Promise<PiInstallPreflightRunResult>;

export interface PiInstallPreflightDeps {
  fetchImpl: typeof fetch;
  run: PiInstallPreflightRun;
}

export interface PiInstallPreflightRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface PiInstallPreflightArtifact {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

export interface PiInstallPreflightEvidence {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
}

export interface PiInstallPreflightResult {
  candidate: PiRuntimeCandidate;
  artifact: PiInstallPreflightArtifact;
  release: PiInstallPreflightRelease;
  stageDir: string;
  evidence: PiInstallPreflightEvidence;
  sourceAlias: string;
}

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function fail(message: string): never {
  throw new Error(`pi-install-preflight: ${message}`);
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function assertRealDir(resolved: string, label: string): void {
  const st = lstatOrNull(resolved);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${resolved}`);
  }
}

function validatePaths(paths: unknown): PiInstallPreflightPaths {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) {
    fail("paths must be an object");
  }
  const { homeDir, agentDir, piExecutable, downloadsDir } = paths as Record<string, unknown>;
  if (typeof homeDir !== "string" || homeDir === "" || !path.isAbsolute(homeDir)) {
    fail("homeDir must be a non-empty absolute path");
  }
  if (typeof agentDir !== "string" || agentDir === "" || !path.isAbsolute(agentDir)) {
    fail("agentDir must be a non-empty absolute path");
  }
  if (typeof piExecutable !== "string" || piExecutable === "" || !path.isAbsolute(piExecutable)) {
    fail("piExecutable must be a non-empty absolute path");
  }
  if (piExecutable === "npm") {
    fail("piExecutable must be the detected Pi CLI, never npm");
  }
  if (typeof downloadsDir !== "string" || downloadsDir === "" || !path.isAbsolute(downloadsDir)) {
    fail("downloadsDir must be a non-empty absolute path");
  }

  const homeResolved = path.resolve(homeDir);
  const agentResolved = path.resolve(agentDir);
  const downloadsResolved = path.resolve(downloadsDir);

  assertRealDir(homeResolved, "homeDir");
  assertRealDir(agentResolved, "agentDir");
  assertRealDir(downloadsResolved, "downloadsDir");

  if (!isStrictChild(agentResolved, homeResolved)) {
    fail("agentDir must live within the homeDir boundary");
  }
  // The verified artifact must live outside the isolated stage tree (which
  // lives under agentDir) so the stage never invents or consumes its own
  // bytes. downloadsDir as a sibling of homeDir (fake Stack downloads) and
  // as a Stack-owned dir outside agentDir both satisfy this.
  if (downloadsResolved === agentResolved || isStrictChild(downloadsResolved, agentResolved)) {
    fail("downloadsDir must live outside the agentDir stage boundary");
  }
  if (downloadsResolved === homeResolved) {
    fail("downloadsDir must not be the homeDir itself");
  }

  return { homeDir, agentDir, piExecutable, downloadsDir };
}

function validateDeps(deps: unknown): PiInstallPreflightDeps {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    fail("deps must be an object");
  }
  const { fetchImpl, run } = deps as Record<string, unknown>;
  if (typeof fetchImpl !== "function") {
    fail("fetchImpl must be a function");
  }
  if (typeof run !== "function") {
    fail("run must be a function");
  }
  return { fetchImpl: fetchImpl as typeof fetch, run: run as PiInstallPreflightRun };
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/**
 * Detect the Pi host version from the executable's own installed manifest
 * without invoking it and without touching any active tree. Fail closed when
 * the manifest cannot be found: hostVersion is evidence for the candidate
 * builder, never a static fallback.
 */
function detectPiHostVersion(piExecutable: string): string {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(piExecutable));
  } catch {
    fail(`cannot resolve Pi executable: ${piExecutable}`);
  }
  for (let depth = 0; depth < 8; depth++) {
    const manifests = [
      path.join(current, "package.json"),
      path.join(current, "node_modules", PI_PACKAGE_NAME, "package.json"),
    ];
    for (const manifest of manifests) {
      let parsed: unknown;
      try {
        parsed = readJsonFile(manifest);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        Reflect.get(parsed, "name") === PI_PACKAGE_NAME &&
        typeof Reflect.get(parsed, "version") === "string"
      ) {
        const version = Reflect.get(parsed, "version") as string;
        if (version !== "" && !/\s/.test(version)) {
          return version;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  fail(`cannot detect Pi host version from executable: ${piExecutable}`);
}

/**
 * T06 provider-to-private-stage preflight (NO activation).
 *
 * Composes the already-tested Stack Pi provider chain in order:
 * resolveLatestPiRelease → resolvePiProducerCommit →
 * downloadVerifiedPiTarball → stageVerifiedPiTarball →
 * buildStagedPiCandidate.
 *
 * Read-only against the active tree: the only writes are the verified
 * tarball under the passed Stack-owned downloadsDir (exact observed
 * version, no-overwrite via the downloader) and the isolated private
 * stage under agentDir (owned by the stager). It never touches the
 * active npm tree, settings, receipt, official Engram setup, target-dir,
 * or any global download location, and never falls back to the static
 * pin. Any metadata/tag/stage failure throws an actionable error
 * without asserting installation success.
 */
export async function preparePiManagedInstall(
  paths: PiInstallPreflightPaths,
  deps: PiInstallPreflightDeps,
): Promise<PiInstallPreflightResult> {
  const { homeDir, agentDir, piExecutable, downloadsDir } = validatePaths(paths);
  const { fetchImpl, run } = validateDeps(deps);

  // 1. Live provider selection: exact stable dist-tags.latest identity from
  // the official npm packument. No static pin, no `latest` install.
  let release: PiInstallPreflightRelease;
  try {
    release = await resolveLatestPiRelease(fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-release-resolver: ")) {
      throw error;
    }
    throw new Error(
      `pi-install-preflight: provider release resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!STABLE_SEMVER.test(release.version)) {
    fail(`provider returned an unstable version: ${release.version}`);
  }

  // 2. Informational producer commit for the exact resolved version from
  // the official public tag ref. Context only, never an attestation.
  let commit: string;
  try {
    commit = await resolvePiProducerCommit(release.version, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-release-resolver: ")) {
      throw error;
    }
    throw new Error(
      `pi-install-preflight: producer commit resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 3. Verified acquisition: exact tarball bytes under the passed
  // Stack-owned downloadsDir with the exact observed version. Symlink/path
  // containment plus no-overwrite are enforced by the downloader; this
  // preflight only binds the destination to downloadsDir first.
  const downloadsResolved = path.resolve(downloadsDir);
  const destination = path.join(downloadsResolved, `jorgex-pi-${release.version}.tgz`);
  if (!isStrictChild(destination, downloadsResolved)) {
    fail(`tarball destination escapes downloadsDir: ${destination}`);
  }

  let artifact: PiInstallPreflightArtifact;
  try {
    artifact = await downloadVerifiedPiTarball(release, destination, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-release-resolver: ")) {
      throw error;
    }
    throw new Error(
      `pi-install-preflight: verified tarball acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 4. Isolated private stage: Pi-native `install file:` inside a random
  // stageRoot under agentDir plus the staged lock/tree inspector. The
  // stager owns TOCTOU preflight, isolated env/cwd, Pi invocation, and
  // alias extraction; it never promotes to the active tree.
  let stageDir: string;
  let evidence: PiInstallPreflightEvidence;
  let sourceAlias: string;
  try {
    const staged = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable, artifact, release },
      run as (executable: string, args: string[], options: { env: Record<string, string>; cwd: string }) => { exitCode: number; stdout: string; stderr: string } | Promise<{ exitCode: number; stdout: string; stderr: string }>,
    );
    stageDir = staged.stageDir;
    evidence = staged.evidence;
    sourceAlias = staged.sourceAlias;
  } catch (error) {
    // Preserve the stage for diagnosis (the stager already does) and the
    // active tree byte-identical; surface the actionable cause as-is.
    throw error;
  }

  // 5. Dynamic candidate from the staged package against the producer
  // contract. The Stack contract is compatibility only; package/source
  // come from the live release, never the frozen pin. Fail closed here
  // when the published stage contract drifts (capabilities/browser).
  const hostVersion = detectPiHostVersion(piExecutable);
  let candidate: PiRuntimeCandidate;
  try {
    candidate = await buildStagedPiCandidate({
      stageDir,
      release,
      artifact,
      commit,
      hostVersion,
      evidence,
    });
  } catch (error) {
    throw error;
  }

  return { candidate, artifact, release, stageDir, evidence, sourceAlias };
}
