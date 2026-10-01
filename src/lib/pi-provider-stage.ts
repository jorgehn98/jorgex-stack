import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  downloadVerifiedNpmPackageTarball,
  isCanonicalSha512Integrity,
  isStableSemverVersion,
  type NpmPackageRelease,
} from "./npm-provider.js";
import {
  buildDerivedProviderArtifact,
  type DerivedProviderArtifactEvidence,
} from "./pi-provider-artifact.js";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";
import { runPiStageProcess } from "./pi-stage-process.js";
import type { StageRun, StageRunResult } from "./pi-release-stage.js";

const PROVIDER_NAMES = ["gentle-engram", "pi-mcp-adapter"] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const PROVIDER_PACKAGE_ROOT = "pi-extensions";
const HEX64 = /^[0-9a-f]{64}$/;

export interface PiProviderPackageEvidence {
  readonly name: ProviderName;
  readonly version: string;
  readonly integrity: string;
  readonly packageRoot: string;
  readonly treeSha256: string;
  readonly bins: Readonly<Record<string, string>>;
  /** Only present for an opted-in gentle-engram transform; absent otherwise. */
  readonly provenance?: DerivedProviderArtifactEvidence;
}

type StagePiProviderPackagesBaseInput = {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly piExecutable: string;
  /**
   * Stack-internal opt-in for the bounded #1567 transform. Absent or false
   * preserves the official acquisition; true derives only gentle-engram after
   * the original SRI is verified. Other values fail before any effect.
   */
  readonly engramTypeboxCompat?: boolean;
};

/**
 * Stack-internal acquisition selector, not an SDK flag or authentication.
 * A future runtime caller must derive it from the verified candidate.
 */
export type StagePiProviderPackagesInput =
  | (StagePiProviderPackagesBaseInput & {
      readonly mcpTransport?: "legacy";
      readonly releases: Readonly<Record<ProviderName, NpmPackageRelease>>;
    })
  | (StagePiProviderPackagesBaseInput & {
      readonly mcpTransport: "native";
      readonly releases: Readonly<{ "gentle-engram": NpmPackageRelease; "pi-mcp-adapter"?: never }>;
    });

export interface StagePiProviderPackagesDeps {
  readonly fetchImpl?: typeof fetch;
  readonly run?: StageRun;
}

export interface StagePiProviderPackagesResult {
  readonly stageDir: string;
  readonly packages: readonly PiProviderPackageEvidence[];
}

function fail(message: string): never {
  throw new Error(`pi-provider-stage: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isStrictChild(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertRealDirectory(target: string, label: string): string {
  const resolved = path.resolve(target);
  const stat = lstatOrNull(resolved);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${target}`);
  }
  return resolved;
}

function assertRegularFile(target: string, label: string, maxBytes = MAX_JSON_BYTES): void {
  const stat = lstatOrNull(target);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file: ${target}`);
  }
  if (stat.size > maxBytes) fail(`${label} exceeds size limit: ${target}`);
}

function readJson(target: string, label: string, maxBytes = MAX_JSON_BYTES): Record<string, unknown> {
  assertRegularFile(target, label, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  } catch {
    fail(`${label} is malformed: ${target}`);
  }
  if (!isRecord(parsed)) fail(`${label} must be an object: ${target}`);
  return parsed;
}

function assertStageBoundary(homeDir: string, agentDir: string): { home: string; agent: string } {
  const home = assertRealDirectory(homeDir, "homeDir");
  const agent = assertRealDirectory(agentDir, "agentDir");
  if (!isStrictChild(agent, home)) fail("agentDir must be inside homeDir");
  return { home, agent };
}

function runtimePath(piExecutable: string): string {
  const entries = process.platform === "win32"
    ? [
      path.dirname(piExecutable),
      path.dirname(process.execPath),
      process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : null,
    ]
    : [path.dirname(piExecutable), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(entries.filter((entry): entry is string => entry !== null && entry !== ""))].join(path.delimiter);
}

function validatePiExecutable(value: unknown): string {
  if (typeof value !== "string" || value === "" || !path.isAbsolute(value)) {
    fail("piExecutable must be a non-empty absolute path");
  }
  if (path.basename(value).toLowerCase() === "npm" || path.basename(value).toLowerCase().startsWith("npm.")) {
    fail("piExecutable must be the detected Pi CLI, never npm");
  }
  return path.resolve(value);
}

function assertRelease(name: ProviderName, release: unknown): NpmPackageRelease {
  if (!isRecord(release)) fail(`${name} release must be an object`);
  if (!isStableSemverVersion(release.version)) fail(`${name} release has an invalid version`);
  if (typeof release.tarballUrl !== "string" || !isCanonicalSha512Integrity(release.integrity)) {
    fail(`${name} release has invalid registry metadata`);
  }
  return {
    version: release.version,
    tarballUrl: release.tarballUrl,
    integrity: release.integrity,
  };
}

function resolveMcpTransport(value: unknown): "native" | "legacy" {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "native") return "native";
  fail('mcpTransport must be "native" or "legacy" when present');
}

function resolveEngramTypeboxCompat(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  fail("engramTypeboxCompat must be a boolean when present");
}

function selectProviderReleases(
  transport: "native" | "legacy",
  raw: Record<string, unknown>,
): Array<{ provider: ProviderName; release: NpmPackageRelease }> {
  if (transport === "native") {
    if (Object.prototype.hasOwnProperty.call(raw, "pi-mcp-adapter")) {
      fail("native transport is contradictory with a pi-mcp-adapter release");
    }
    return [{ provider: "gentle-engram", release: assertRelease("gentle-engram", raw["gentle-engram"]) }];
  }
  return PROVIDER_NAMES.map((provider) => ({ provider, release: assertRelease(provider, raw[provider]) }));
}

function createDirectory(target: string): void {
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
  } catch {
    fail(`cannot create private stage directory: ${target}`);
  }
}

function createStageRoot(homeDir: string): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Keep the native stage outside the active Pi agent directory. Native Pi
    // is allowed to create its own package-lock/settings inside this tree,
    // but it must never see (or prune) the active jorgex-pi installation.
    const candidate = path.join(homeDir, `provider-stage-${randomBytes(16).toString("hex")}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      fs.chmodSync(candidate, 0o700);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      fail(`cannot create private stage root: ${(error as Error).message}`);
    }
  }
  fail("cannot create private stage root after retries");
}

function stageEnvironment(stageRoot: string, stageAgentDir: string, piExecutable: string): Record<string, string> {
  const home = path.join(stageRoot, "home");
  const appdata = path.join(stageRoot, "appdata");
  const localappdata = path.join(stageRoot, "localappdata");
  const xdgConfig = path.join(stageRoot, "xdg-config");
  const xdgData = path.join(stageRoot, "xdg-data");
  const xdgCache = path.join(stageRoot, "xdg-cache");
  const temporary = path.join(stageRoot, "tmp");
  const npmCache = path.join(stageRoot, "npm-cache");
  const npmConfig = path.join(stageRoot, "npmrc");
  for (const directory of [
    home,
    appdata,
    localappdata,
    xdgConfig,
    xdgData,
    xdgCache,
    temporary,
    npmCache,
    path.dirname(npmConfig),
    stageAgentDir,
  ]) createDirectory(directory);

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
    npm_config_userconfig: npmConfig,
    npm_config_install_strategy: "nested",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_progress: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PI_CODING_AGENT_DIR: stageAgentDir,
    PATH: runtimePath(piExecutable),
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "OS"] as const) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

function assertFileAlias(spec: unknown, npmDir: string, artifactPath: string, label: string): string {
  if (typeof spec !== "string" || !spec.startsWith("file:")) fail(`${label} must be a file: alias`);
  const rest = spec.slice("file:".length);
  if (rest === "") fail(`${label} has an empty file: alias`);
  if (path.resolve(npmDir, rest) !== path.resolve(artifactPath)) {
    fail(`${label} does not resolve to the verified artifact`);
  }
  return spec;
}

function packagePath(nodeModules: string, name: string): string {
  return path.join(nodeModules, ...name.split("/"));
}

function normalizeBins(raw: unknown, packageName: string): Record<string, string> {
  if (typeof raw === "string") {
    if (raw === "") fail(`${packageName} declares an empty bin target`);
    return { [packageName]: raw };
  }
  if (!isRecord(raw)) fail(`${packageName} must declare a bin map`);
  const result: Record<string, string> = {};
  for (const [name, target] of Object.entries(raw)) {
    if (name === "" || name.includes("/") || name.includes("\\") || typeof target !== "string" || target === "") {
      fail(`${packageName} declares an invalid bin`);
    }
    result[name] = target;
  }
  if (Object.keys(result).length === 0) fail(`${packageName} must declare at least one bin`);
  return result;
}

function assertBinTargets(packageRoot: string, bins: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, target] of Object.entries(bins)) {
    if (path.isAbsolute(target)) fail(`${name} bin must be relative`);
    const candidate = path.resolve(packageRoot, target);
    if (!isStrictChild(candidate, packageRoot)) fail(`${name} bin escapes its package root`);
    const stat = lstatOrNull(candidate);
    if (stat === null) fail(`${name} bin target is missing`);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      fail(`${name} bin target cannot be resolved`);
    }
    if (!isStrictChild(real, packageRoot)) fail(`${name} bin escapes its package root`);
    const finalStat = fs.statSync(candidate);
    if (!finalStat.isFile()) fail(`${name} bin target is not a file`);
    result[name] = target;
  }
  return result;
}

function assertDirectRoots(nodeModules: string, provider: ProviderName): void {
  const entries = fs.readdirSync(nodeModules);
  const allowed = new Set([provider, ".bin", ".package-lock.json"]);
  for (const entry of entries) {
    if (!allowed.has(entry)) fail(`foreign direct provider root: ${entry}`);
  }
  const hiddenLock = path.join(nodeModules, ".package-lock.json");
  if (lstatOrNull(hiddenLock) !== null) assertRegularFile(hiddenLock, "staged provider hidden lock", MAX_LOCK_BYTES);
  const binDir = path.join(nodeModules, ".bin");
  const binStat = lstatOrNull(binDir);
  if (binStat !== null && (!binStat.isDirectory() || binStat.isSymbolicLink())) {
    fail("provider .bin must be a real directory");
  }
  if (binStat !== null) {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      const target = path.join(binDir, entry.name);
      if (!entry.isSymbolicLink()) continue;
      let raw: string;
      try {
        raw = fs.readlinkSync(target);
      } catch {
        fail(`provider .bin entry is unreadable: ${entry.name}`);
      }
      if (raw === "" || path.isAbsolute(raw)) fail(`provider .bin entry escapes stage: ${entry.name}`);
      const resolved = path.resolve(binDir, raw);
      if (!isStrictChild(resolved, nodeModules)) fail(`provider .bin entry escapes stage: ${entry.name}`);
      const stat = lstatOrNull(resolved);
      if (stat === null) fail(`provider .bin entry is broken: ${entry.name}`);
    }
  }
}

function assertLockEntries(packages: Record<string, unknown>, provider: ProviderName): void {
  for (const key of Object.keys(packages)) {
    if (key === "" || key === `node_modules/${provider}`) continue;
    if (!key.startsWith(`node_modules/${provider}/node_modules/`)) {
      fail(`foreign lock root: ${key}`);
    }
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes actually installed, which differ from the official release only for
 * an opted-in derived variant. `integrity` here is the effective artifact SRI;
 * the returned evidence always keeps the original registry SRI separately.
 */
type EffectiveProviderArtifact = {
  readonly artifactPath: string;
  readonly integrity: string;
  readonly provenance?: DerivedProviderArtifactEvidence;
};

function expectedManifestSha256(provenance: DerivedProviderArtifactEvidence): string {
  return provenance.origin === "derived"
    ? provenance.derived.manifestSha256
    : provenance.original.manifestSha256;
}

function assertDerivedHasNoOwnTypebox(
  packages: Record<string, unknown>,
  packageRoot: string,
  provider: ProviderName,
): void {
  const lockKey = `node_modules/${provider}/node_modules/typebox`;
  if (Object.prototype.hasOwnProperty.call(packages, lockKey)) {
    fail(`${provider} derived variant must not install its own TypeBox`);
  }
  if (lstatOrNull(path.join(packageRoot, "node_modules", "typebox")) !== null) {
    fail(`${provider} derived variant must not install its own TypeBox`);
  }
}

function inspectProviderTree(
  stageAgentDir: string,
  effective: EffectiveProviderArtifact,
  release: NpmPackageRelease,
  provider: ProviderName,
): PiProviderPackageEvidence {
  const npmDir = path.join(stageAgentDir, "npm");
  const modules = path.join(npmDir, "node_modules");
  assertRealDirectory(npmDir, "staged provider npm root");
  assertRealDirectory(modules, "staged provider node_modules");
  assertDirectRoots(modules, provider);

  const lockPath = path.join(npmDir, "package-lock.json");
  const lock = readJson(lockPath, "staged provider lock", MAX_LOCK_BYTES);
  if (lock.name !== PROVIDER_PACKAGE_ROOT || lock.lockfileVersion !== 3) {
    fail("staged provider lock must be npm v3 pi-extensions");
  }
  if (!isRecord(lock.packages)) fail("staged provider lock misses packages");
  const packages = lock.packages;
  assertLockEntries(packages, provider);
  const root = packages[""];
  const parent = packages[`node_modules/${provider}`];
  if (!isRecord(root) || !isRecord(parent)) fail(`staged provider lock misses ${provider}`);
  if (!isRecord(root.dependencies)) fail("staged provider lock misses root dependencies");
  const rootSpec = assertFileAlias(root.dependencies[provider], npmDir, effective.artifactPath, "provider root alias");
  const parentSpec = assertFileAlias(parent.resolved, npmDir, effective.artifactPath, "provider resolved alias");
  if (rootSpec !== parentSpec) fail("provider root/resolved aliases differ");
  // The lock must describe the effective bytes; the original SRI stays in the
  // returned evidence, never in the installed lock for a derived variant.
  if (parent.version !== release.version || parent.integrity !== effective.integrity) {
    fail(`staged provider lock metadata mismatch: ${provider}`);
  }

  const rootManifest = readJson(path.join(npmDir, "package.json"), "staged provider root manifest");
  if (rootManifest.name !== PROVIDER_PACKAGE_ROOT || !isRecord(rootManifest.dependencies)) {
    fail("staged provider root manifest is invalid");
  }
  if (rootManifest.dependencies[provider] !== rootSpec) {
    fail("staged provider manifest alias differs from lock");
  }

  const packageRoot = path.join(modules, provider);
  assertRealDirectory(packageRoot, `staged ${provider} root`);
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = readJson(manifestPath, `${provider} manifest`);
  if (manifest.name !== provider || manifest.version !== release.version) {
    fail(`staged ${provider} manifest identity/version mismatch`);
  }
  if (effective.provenance !== undefined) {
    if (sha256Hex(fs.readFileSync(manifestPath)) !== expectedManifestSha256(effective.provenance)) {
      fail(`staged ${provider} installed manifest does not match the selected provenance`);
    }
    if (effective.provenance.origin === "derived") assertDerivedHasNoOwnTypebox(packages, packageRoot, provider);
  }
  const bins = assertBinTargets(packageRoot, normalizeBins(manifest.bin, provider));
  // inventoryTreeSha256 performs a bounded deterministic walk and rejects
  // absolute, broken, escaping, and chained symlinks below this provider.
  let treeSha256: string;
  try {
    treeSha256 = inventoryTreeSha256(packageRoot);
  } catch (error) {
    fail(`staged ${provider} tree is unsafe: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evidence: PiProviderPackageEvidence = {
    name: provider,
    version: release.version,
    integrity: release.integrity,
    packageRoot,
    treeSha256,
    bins,
  };
  return effective.provenance === undefined ? evidence : { ...evidence, provenance: effective.provenance };
}

function failureDetail(result: StageRunResult): string {
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const detail = stderr !== "" ? stderr : stdout !== "" ? stdout : `exit ${result.exitCode}`;
  return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
}

function defaultStageRun(executable: string, args: string[], options: { env: Record<string, string>; cwd: string }): Promise<StageRunResult> {
  return runPiStageProcess(executable, args, options);
}

/**
 * Resolve the selected provider tarballs into isolated Pi-native trees. Each
 * provider gets its own npm root as the selected isolation layout, keeping
 * staging separate from the active jorgex-pi tree. The returned trees are
 * evidence only; activation is a separate transaction in
 * pi-provider-activation.ts.
 */
export async function stagePiProviderPackages(
  input: StagePiProviderPackagesInput,
  deps: StagePiProviderPackagesDeps = {},
): Promise<StagePiProviderPackagesResult> {
  if (!isRecord(input)) fail("input must be an object");
  const engramTypeboxCompat = resolveEngramTypeboxCompat(input.engramTypeboxCompat);
  const transport = resolveMcpTransport(input.mcpTransport);
  const { home, agent } = assertStageBoundary(input.homeDir, input.agentDir);
  const piExecutable = validatePiExecutable(input.piExecutable);
  if (!isRecord(input.releases)) fail("releases must be an object");
  const selected = selectProviderReleases(transport, input.releases);
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  const run = deps.run ?? defaultStageRun;
  if (typeof run !== "function") fail("run must be a function");

  const stageDir = createStageRoot(home);
  const packages: PiProviderPackageEvidence[] = [];
  const stagedProviders: Array<{
    provider: ProviderName;
    release: NpmPackageRelease;
    effective: EffectiveProviderArtifact;
    stageAgentDir: string;
    workspace: string;
    env: Record<string, string>;
  }> = [];

  // Download and verify every selected candidate before invoking native Pi. A
  // later SRI failure must not leave an earlier provider partially staged. The
  // optional derived variant is also built here, before the first spawn, from
  // the already-verified official bytes.
  for (const { provider, release } of selected) {
    const providerStage = path.join(stageDir, provider);
    const stageAgentDir = path.join(providerStage, "pi-agent");
    const downloads = path.join(providerStage, "downloads");
    const workspace = path.join(providerStage, "workspace");
    createDirectory(stageAgentDir);
    createDirectory(downloads);
    createDirectory(workspace);
    const artifactPath = path.join(downloads, `${provider}-${release.version}.tgz`);
    const artifact = await downloadVerifiedNpmPackageTarball(provider, release, artifactPath, fetchImpl);
    let effective: EffectiveProviderArtifact = { artifactPath: artifact.path, integrity: release.integrity };
    if (engramTypeboxCompat && provider === "gentle-engram") {
      // The builder re-reads and re-verifies the official bytes, then writes its
      // own destination; the original release SRI is never replaced or mutated.
      const provenance = await buildDerivedProviderArtifact({
        packageName: provider,
        release,
        official: artifact,
        destination: path.join(downloads, `${provider}-${release.version}-derived.tgz`),
      });
      effective = provenance.origin === "derived"
        ? { artifactPath: provenance.derived.path, integrity: provenance.derived.integrity, provenance }
        : { artifactPath: artifact.path, integrity: release.integrity, provenance };
    }
    const env = stageEnvironment(providerStage, stageAgentDir, piExecutable);
    stagedProviders.push({ provider, release, effective, stageAgentDir, workspace, env });
  }

  for (const staged of stagedProviders) {
    const provider = staged.provider;
    const artifact = { path: staged.effective.artifactPath };
    const source = `npm:${provider}@file:${artifact.path}`;
    let result: StageRunResult;
    try {
      result = await run(piExecutable, ["install", source, "--no-approve"], { env: staged.env, cwd: staged.workspace });
    } catch (error) {
      fail(`${provider} native stage failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(result) || typeof result.exitCode !== "number") fail(`${provider} native stage returned invalid output`);
    if (result.exitCode !== 0) fail(`${provider} native stage failed: ${failureDetail(result)}`);
    packages.push(inspectProviderTree(staged.stageAgentDir, staged.effective, staged.release, provider));
  }
  return { stageDir, packages };
}
