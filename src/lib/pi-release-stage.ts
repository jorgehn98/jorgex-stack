import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectStagedPiNpm } from "./pi-staged-lock.js";

export interface StageArtifact {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

export interface StageRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface StageInput {
  homeDir: string;
  agentDir: string;
  piExecutable: string;
  artifact: StageArtifact;
  release: StageRelease;
}

export interface StageRunOptions {
  env: Record<string, string>;
  cwd: string;
}

export interface StageRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type StageRun = (
  executable: string,
  args: string[],
  options: StageRunOptions,
) => StageRunResult | Promise<StageRunResult>;

export interface StageEvidence {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
}

export interface StageResult {
  stageDir: string;
  evidence: StageEvidence;
  sourceAlias: string;
}

/**
 * T06 stage orchestration: install the verified tarball through the detected
 * Pi CLI inside an isolated stage, then return observed evidence.
 *
 * Real-layout assumptions (isolated Pi-native probe with Pi 0.87.1):
 * - stageDir is the Pi agent dir (`stageRoot/pi-agent`) holding
 *   `settings.json` (Pi native, exactly one `npm:jorgex-pi@file:<tgz>` alias)
 *   and the staged npm tree at `stageDir/npm` (lock v3 `pi-extensions`,
 *   `file:` alias resolving to the verified tarball, six hoisted companions).
 * - `inspectStagedPiNpm` owns lock/tree evidence; this module owns TOCTOU
 *   preflight, isolated env/cwd, Pi invocation, and alias extraction. It never
 *   promotes to the active tree.
 */

const REGISTRY_HOST = "registry.npmjs.org";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const STAGE_TIMEOUT_MS = 120_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function fail(message: string): never {
  throw new Error(`pi-release-stage: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function canonicalTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

function assertCanonicalSha512(integrity: unknown, label: string): Buffer {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  const b64 = (integrity as string).slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    fail(`${label} must be canonical sha512 SRI`);
  }
  if (bytes.length !== 64 || bytes.toString("base64") !== b64) {
    fail(`${label} must be canonical sha512 SRI`);
  }
  return bytes;
}

function validateRelease(release: unknown): { version: string; tarballUrl: string; expectedSha512: Buffer } {
  if (!isRecord(release)) fail("release must be an object");
  const { version, tarballUrl, integrity } = release as Record<string, unknown>;
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    fail(`invalid release version ${String(version)}`);
  }
  if (typeof tarballUrl !== "string") fail("foreign release tarball URL");
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl as string);
  } catch {
    fail("foreign release tarball URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== REGISTRY_HOST ||
    (tarballUrl as string) !== canonicalTarballUrl(version as string)
  ) {
    fail("foreign release tarball URL");
  }
  return {
    version: version as string,
    tarballUrl: tarballUrl as string,
    expectedSha512: assertCanonicalSha512(integrity, "release integrity"),
  };
}

function validateArtifactShape(artifact: unknown): asserts artifact is StageArtifact {
  if (!isRecord(artifact)) fail("artifact must be an object");
  const { path: artifactPath, bytes, sha256, sha512 } = artifact as Record<string, unknown>;
  if (typeof artifactPath !== "string" || artifactPath === "" || !path.isAbsolute(artifactPath)) {
    fail("artifact.path must be a non-empty absolute path");
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    fail("artifact.bytes must be a non-negative integer");
  }
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) {
    fail("artifact.sha256 must be 64 lowercase hex");
  }
  if (typeof sha512 !== "string" || !HEX128.test(sha512)) {
    fail("artifact.sha512 must be 128 lowercase hex");
  }
}

function equalHex(aHex: string, bHex: string): boolean {
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(aHex, "hex");
    b = Buffer.from(bHex, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/** TOCTOU preflight: re-hash the on-disk tarball and bind it to the release SRI. */
function assertArtifactMatchesRelease(
  artifactPath: string,
  artifact: StageArtifact,
  expectedSha512: Buffer,
): void {
  const st = lstatOrNull(artifactPath);
  if (st === null) fail(`missing verified artifact: ${artifactPath}`);
  if (st.isSymbolicLink()) fail(`verified artifact must not be a symlink: ${artifactPath}`);
  if (!st.isFile()) fail(`verified artifact must be a regular file: ${artifactPath}`);
  if (st.size > MAX_TARBALL_BYTES) fail(`verified artifact exceeds size bound: ${artifactPath}`);
  if (st.size !== artifact.bytes) {
    fail("verified artifact bytes do not match release (TOCTOU or swap)");
  }
  let fd: number;
  try {
    fd = fs.openSync(artifactPath, "r");
  } catch {
    fail(`cannot read verified artifact: ${artifactPath}`);
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read verified artifact: ${artifactPath}`);
      }
      if (read === 0) break;
      total += read;
      if (total > MAX_TARBALL_BYTES) fail(`verified artifact exceeds size bound: ${artifactPath}`);
      sha256.update(buffer.subarray(0, read));
      sha512.update(buffer.subarray(0, read));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors on a read-only descriptor.
    }
  }
  if (total !== artifact.bytes) {
    fail("verified artifact bytes do not match release (TOCTOU or swap)");
  }
  const actual256 = sha256.digest("hex");
  const actual512Buffer = sha512.digest();
  const actual512Hex = actual512Buffer.toString("hex");
  if (!equalHex(actual256, artifact.sha256) || !equalHex(actual512Hex, artifact.sha512)) {
    fail("verified artifact digest does not match release (TOCTOU or swap)");
  }
  if (actual512Buffer.length !== expectedSha512.length || !timingSafeEqual(actual512Buffer, expectedSha512)) {
    fail("verified artifact bytes do not match release integrity");
  }
}

function assertAgentBoundary(homeDir: string, agentDir: string): { homeResolved: string; agentResolved: string } {
  if (typeof homeDir !== "string" || homeDir === "" || !path.isAbsolute(homeDir)) {
    fail("homeDir must be a non-empty absolute path");
  }
  if (typeof agentDir !== "string" || agentDir === "" || !path.isAbsolute(agentDir)) {
    fail("agentDir must be a non-empty absolute path");
  }
  const homeResolved = path.resolve(homeDir);
  const agentResolved = path.resolve(agentDir);
  const homeStat = lstatOrNull(homeResolved);
  if (homeStat === null || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    fail(`homeDir must be a real directory: ${homeDir}`);
  }
  if (!isStrictChild(agentResolved, homeResolved)) {
    fail("agentDir must live within the homeDir boundary");
  }
  const agentStat = lstatOrNull(agentResolved);
  if (agentStat === null || !agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    fail(`agentDir must be a real directory: ${agentDir}`);
  }
  return { homeResolved, agentResolved };
}

function runtimePath(piExecutable: string): string {
  const entries =
    process.platform === "win32"
      ? [
          path.dirname(piExecutable),
          path.dirname(process.execPath),
          process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : null,
        ]
      : [path.dirname(piExecutable), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(entries.filter((entry): entry is string => entry !== null))].join(path.delimiter);
}

function withStageDir(error: unknown, stageDir: string): never {
  if (error instanceof Error) {
    (error as Error & { stageDir?: string }).stageDir = stageDir;
    throw error;
  }
  const wrapped = new Error(`pi-release-stage: stage failed: ${String(error)}`);
  (wrapped as Error & { stageDir?: string }).stageDir = stageDir;
  throw wrapped;
}

function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = Reflect.get(entry, "source");
  return typeof source === "string" ? source : null;
}

function readStageSourceAlias(stageDir: string, expectedAlias: string): string {
  const settingsPath = path.join(stageDir, "settings.json");
  const st = lstatOrNull(settingsPath);
  if (st === null) fail(`missing staged settings: ${settingsPath}`);
  if (st.isSymbolicLink()) fail(`staged settings must not be a symlink: ${settingsPath}`);
  if (!st.isFile()) fail(`staged settings must be a regular file: ${settingsPath}`);
  if (st.size > MAX_SETTINGS_BYTES) fail(`staged settings exceeds size bound: ${settingsPath}`);
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    fail(`cannot read staged settings: ${settingsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail(`malformed staged settings: ${settingsPath}`);
  }
  if (!isRecord(parsed)) fail(`malformed staged settings: ${settingsPath}`);
  const packages = Reflect.get(parsed, "packages");
  if (!Array.isArray(packages)) fail(`staged settings misses packages[]: ${settingsPath}`);
  const sources: string[] = [];
  for (const entry of packages) {
    const source = packageSource(entry);
    if (source === null) fail(`malformed staged settings entry: ${settingsPath}`);
    if (source.includes("jorgex-pi")) sources.push(source);
  }
  if (sources.length !== 1 || sources[0] !== expectedAlias) {
    fail(`staged settings must declare exactly one ${expectedAlias}`);
  }
  return sources[0] as string;
}

export async function stageVerifiedPiTarball(input: StageInput, run: StageRun): Promise<StageResult> {
  if (!isRecord(input)) fail("input must be an object");
  if (typeof run !== "function") fail("run must be a function");
  const { homeDir, agentDir, piExecutable, artifact, release } = input as Record<string, unknown>;
  if (typeof piExecutable !== "string" || piExecutable === "" || !path.isAbsolute(piExecutable)) {
    fail("piExecutable must be a non-empty absolute path");
  }
  if (piExecutable === "npm") fail("piExecutable must be the detected Pi CLI, never npm");
  validateArtifactShape(artifact);
  const typedArtifact = artifact as StageArtifact;
  const { version, tarballUrl, expectedSha512 } = validateRelease(release);
  void tarballUrl;
  void version;
  const { agentResolved } = assertAgentBoundary(homeDir as string, agentDir as string);

  // Bind the exact verified identity to on-disk bytes BEFORE Pi ever runs.
  // A swap after download must reject here; the post-install inspector alone
  // is too late because untrusted bytes would already have gone through Pi.
  assertArtifactMatchesRelease(path.resolve(typedArtifact.path), typedArtifact, expectedSha512);

  // Random private stage root directly under the agent dir, never the active
  // npm/settings/receipt. Mode 0700 enforced after mkdir to survive umask.
  let stageRoot = "";
  let stageDir = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = path.join(agentResolved, `stage-${randomBytes(16).toString("hex")}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      stageRoot = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      fail(`cannot create private stage root: ${(error as Error).message}`);
    }
  }
  if (stageRoot === "") fail("cannot create private stage root after retries");
  try {
    fs.chmodSync(stageRoot, 0o700);
  } catch {
    fail("cannot secure private stage root");
  }
  stageDir = path.join(stageRoot, "pi-agent");

  const home = path.join(stageRoot, "home");
  const appdata = path.join(stageRoot, "appdata");
  const localappdata = path.join(stageRoot, "localappdata");
  const xdgConfig = path.join(stageRoot, "xdg-config");
  const xdgData = path.join(stageRoot, "xdg-data");
  const xdgCache = path.join(stageRoot, "xdg-cache");
  const temporary = path.join(stageRoot, "tmp");
  const npmCache = path.join(stageRoot, "npm-cache");
  const workspace = path.join(stageRoot, "workspace");
  try {
    for (const dir of [
      stageDir,
      home,
      appdata,
      localappdata,
      xdgConfig,
      xdgData,
      xdgCache,
      temporary,
      npmCache,
      workspace,
    ]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(stageRoot, 0o700);
  } catch (error) {
    withStageDir(new Error(`pi-release-stage: cannot prepare isolated stage: ${(error as Error).message}`), stageDir);
  }

  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    npm_config_cache: npmCache,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PI_CODING_AGENT_DIR: stageDir,
    PATH: runtimePath(piExecutable as string),
  };

  const expectedAlias = `npm:jorgex-pi@file:${typedArtifact.path}`;
  const args = ["install", expectedAlias, "--no-approve"];

  let outcome: StageRunResult;
  try {
    const maybe = (run as StageRun)(piExecutable as string, args, { env: { ...env }, cwd: workspace });
    if (maybe !== null && typeof maybe === "object" && typeof (maybe as Promise<StageRunResult>).then === "function") {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("pi-release-stage: pi install timed out")), STAGE_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      });
      outcome = await Promise.race([maybe as Promise<StageRunResult>, timeout]);
    } else {
      outcome = maybe as StageRunResult;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-release-stage: ")) {
      withStageDir(error, stageDir);
    }
    withStageDir(new Error(`pi-release-stage: pi install failed: ${error instanceof Error ? error.message : String(error)}`), stageDir);
  }

  if (
    outcome === null ||
    typeof outcome !== "object" ||
    typeof (outcome as StageRunResult).exitCode !== "number"
  ) {
    withStageDir(new Error("pi-release-stage: pi install returned an invalid result"), stageDir);
  }
  if ((outcome as StageRunResult).exitCode !== 0) {
    const stderr = typeof (outcome as StageRunResult).stderr === "string" ? (outcome as StageRunResult).stderr : "";
    const stdout = typeof (outcome as StageRunResult).stdout === "string" ? (outcome as StageRunResult).stdout : "";
    const detail = stderr !== "" ? stderr : stdout !== "" ? stdout : `exit ${(outcome as StageRunResult).exitCode}`;
    const trimmed = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
    withStageDir(new Error(`pi-release-stage: pi install failed: ${trimmed}`), stageDir);
  }

  // Evidence first: the staged inspector gates the minimal/foreign tree with
  // `pi-staged-lock:` before the alias is trusted. Alias extraction follows
  // and returns the exact Pi-native file: alias; this module never promotes.
  let evidence: StageEvidence;
  try {
    evidence = (await inspectStagedPiNpm({
      stageDir,
      tarballPath: typedArtifact.path,
      release: { version, tarballUrl, integrity: (release as StageRelease).integrity },
    })) as StageEvidence;
  } catch (error) {
    withStageDir(error, stageDir);
  }

  let sourceAlias: string;
  try {
    sourceAlias = readStageSourceAlias(stageDir, expectedAlias);
  } catch (error) {
    withStageDir(error, stageDir);
  }

  return { stageDir, evidence: evidence as StageEvidence, sourceAlias: sourceAlias as string };
}
