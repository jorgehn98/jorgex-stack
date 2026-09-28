import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { isCanonicalSha512Integrity, isStableSemverVersion } from "./npm-provider.js";
import { planDetectedBinCommand } from "./detect.js";

const REGISTRY_HOST = "registry.npmjs.org";
const STAGE_LOCK_FILE = ".jorgex-browser-lock.json";
const STAGE_HOOK_FILE = ".pnpmfile.mjs";
const STAGE_PACKAGE_FILE = "package.json";
const STAGE_NPMRC_FILE = ".npmrc";
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 32_768;
const MAX_FILES = 250_000;
const RUN_TIMEOUT_MS = 120_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 16 * 1024;
const MAX_TREE_SYMLINK_BYTES = 16 * 1024;
const TREE_HASH_CHUNK_BYTES = 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface BrowserStageRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface StageVerifiedBrowserTreeInput {
  artifactPath: string;
  packageName: string;
  release: BrowserStageRelease;
  stageDir: string;
  pnpmBin: string;
  fetchImpl: typeof fetch;
}

export type BrowserStagePnpmRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => void | Promise<void>;

export interface StageVerifiedBrowserTreeDeps {
  runPnpm?: BrowserStagePnpmRunner;
}

export interface BrowserClosurePackage {
  name: string;
  version: string;
  integrity: string;
}

export interface StageVerifiedBrowserTreeResult {
  treePath: string;
  nodeModulesPath: string;
  treeSha256: string;
  closure: BrowserClosurePackage[];
}

interface LockPackage {
  key: string;
  name: string;
  version: string;
  resolution: Record<string, unknown>;
  root: boolean;
}

interface OfficialPackageMetadata {
  integrity: string;
  tarball: string;
}

function fail(message: string): never {
  throw new Error(`browser-stage: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || !path.isAbsolute(value)) {
    fail(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function lstatOrFail(file: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`missing ${label}: ${file}`);
  }
  return stat;
}

function assertRealDirectory(dir: string, label: string): string {
  const stat = lstatOrFail(dir, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${dir}`);
  try {
    return fs.realpathSync(dir);
  } catch {
    fail(`cannot resolve ${label}: ${dir}`);
  }
}

function assertRegularFile(file: string, label: string): fs.Stats {
  const stat = lstatOrFail(file, label);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${file}`);
  return stat;
}

function assertContained(realRoot: string, candidate: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    fail(`cannot resolve ${label}: ${candidate}`);
  }
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    fail(`${label} escapes the stage`);
  }
  return resolved;
}

function canonicalTarballUrl(packageName: string, version: string): string {
  const shortName = packageName.slice(packageName.lastIndexOf("/") + 1);
  return `https://${REGISTRY_HOST}/${packageName}/-/${shortName}-${version}.tgz`;
}

function assertRelease(packageName: string, release: unknown): BrowserStageRelease {
  if (!isRecord(release)) fail("release must be an object");
  const { version, tarballUrl, integrity } = release;
  if (!isStableSemverVersion(version)) fail("release version must be a stable semver");
  if (typeof tarballUrl !== "string") fail("release tarball URL is invalid");
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    fail("release tarball URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== REGISTRY_HOST ||
    tarballUrl !== canonicalTarballUrl(packageName, version)
  ) {
    fail("release tarball URL is not the official canonical URL");
  }
  if (!isCanonicalSha512Integrity(integrity)) fail("release integrity is not canonical sha512 SRI");
  return { version, tarballUrl, integrity };
}

function hashArtifact(file: string): { bytes: number; integrity: string } {
  assertRegularFile(file, "artifact");
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    fail(`cannot open artifact: ${file}`);
  }
  const hash = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      fs.closeSync(fd);
    } catch {
      // The digest and byte count remain authoritative; close is hygiene.
    }
  };
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read artifact: ${file}`);
      }
      if (read === 0) break;
      bytes += read;
      if (bytes > MAX_ARTIFACT_BYTES) fail("artifact exceeds 128 MiB");
      hash.update(buffer.subarray(0, read));
    }
    return { bytes, integrity: `sha512-${hash.digest("base64")}` };
  } finally {
    close();
  }
}

function assertArtifactIntegrity(file: string, expected: string): void {
  const observed = hashArtifact(file);
  const expectedBytes = Buffer.from(expected.slice("sha512-".length), "base64");
  const observedBytes = Buffer.from(observed.integrity.slice("sha512-".length), "base64");
  if (expectedBytes.length !== observedBytes.length || !timingSafeEqual(expectedBytes, observedBytes)) {
    fail("artifact bytes do not match release integrity");
  }
}

function readBoundedJson(file: string, label: string): unknown {
  const stat = assertRegularFile(file, label);
  if (stat.size > MAX_JSON_BYTES) fail(`${label} exceeds 4 MiB`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${label}: ${file}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(`malformed ${label}: ${file}`);
  }
}

async function readBoundedResponse(response: Response, label: string): Promise<string> {
  if (response.body === null) fail(`${label} has no response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        fail(`${label} exceeds 4 MiB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function readOfficialMetadata(
  packageName: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<OfficialPackageMetadata> {
  const url = `https://${REGISTRY_HOST}/${packageName}/${version}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    fail(`registry fetch failed for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`registry responded ${response.status} for ${packageName}`);
  if (response.url !== url) fail(`registry response URL drifted for ${packageName}`);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length.trim()) || Number(length.trim()) > MAX_JSON_BYTES)) {
    fail(`registry metadata exceeds 4 MiB for ${packageName}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(await readBoundedResponse(response, `registry metadata for ${packageName}`)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-stage: ")) throw error;
    fail(`malformed registry metadata for ${packageName}`);
  }
  if (!isRecord(data) || data.name !== packageName || data.version !== version) {
    fail(`registry metadata misses exact ${packageName}@${version}`);
  }
  const dist = data.dist;
  if (!isRecord(dist) || typeof dist.integrity !== "string" || typeof dist.tarball !== "string") {
    fail(`registry metadata misses dist for ${packageName}@${version}`);
  }
  if (!isCanonicalSha512Integrity(dist.integrity)) {
    fail(`registry integrity is not canonical for ${packageName}@${version}`);
  }
  const expectedTarball = canonicalTarballUrl(packageName, version);
  if (dist.tarball !== expectedTarball) {
    fail(`registry tarball URL is not canonical for ${packageName}@${version}`);
  }
  return { integrity: dist.integrity, tarball: dist.tarball };
}

function parsePackageKey(key: string): { name: string; version: string } {
  if (typeof key !== "string" || key === "") fail("lock package key is invalid");
  const separator = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (separator <= 0) fail(`lock package key is invalid: ${key}`);
  const name = key.slice(0, separator);
  const source = key.slice(separator + 1);
  if (!PACKAGE_NAME.test(name) || source === "") fail(`lock package key is invalid: ${key}`);
  const peer = source.indexOf("(");
  const version = peer < 0 ? source : source.slice(0, peer);
  if (version === "") fail(`lock package key is invalid: ${key}`);
  return { name, version };
}

function assertNpmVersion(version: string, label: string): void {
  if (!NPM_VERSION.test(version)) fail(`${label} is not a valid npm version: ${version}`);
}

function localTarballPath(spec: string, stageDir: string): string {
  if (!spec.startsWith("file:") || spec.startsWith("file://")) fail("root lock source is not a local file");
  const relative = spec.slice("file:".length);
  if (relative === "" || relative.includes("\0")) fail("root lock source is invalid");
  const resolved = path.resolve(stageDir, relative);
  return resolved;
}

function parseLockPackages(
  lock: unknown,
  packageName: string,
  release: BrowserStageRelease,
  stageDir: string,
  artifactPath: string,
): LockPackage[] {
  if (!isRecord(lock) || lock.lockfileVersion !== "9.0" || !isRecord(lock.packages)) {
    fail("pnpm hook did not produce a lockfile v9 packages map");
  }
  const entries = Object.entries(lock.packages);
  if (entries.length === 0 || entries.length > MAX_PACKAGES) fail("lockfile package closure is empty or too large");
  const parsed: LockPackage[] = [];
  let root: LockPackage | null = null;
  for (const [key, raw] of entries) {
    if (!isRecord(raw) || !isRecord(raw.resolution)) fail(`lock package has incomplete resolution: ${key}`);
    const identity = parsePackageKey(key);
    const resolution = raw.resolution;
    if (typeof resolution.integrity !== "string" || !isCanonicalSha512Integrity(resolution.integrity)) {
      fail(`lock package has missing or invalid integrity: ${key}`);
    }
    if (resolution.tarball !== undefined && typeof resolution.tarball !== "string") {
      fail(`lock package has invalid tarball source: ${key}`);
    }
    const isRoot = identity.name === packageName && identity.version.startsWith("file:");
    if (isRoot) {
      if (root !== null) fail("lockfile contains multiple root package records");
      if (raw.version !== release.version) fail("root lock package version differs from release");
      if (resolution.integrity !== release.integrity) fail("root lock package integrity differs from release");
      if (typeof resolution.tarball !== "string") fail("root lock package misses local tarball source");
      const lockArtifact = localTarballPath(resolution.tarball, stageDir);
      if (path.resolve(lockArtifact) !== path.resolve(artifactPath)) {
        fail("root lock package points to a different artifact");
      }
      root = { key, name: packageName, version: release.version, resolution, root: true };
      parsed.push(root);
      continue;
    }

    if (identity.version.startsWith("file:") || identity.version.startsWith("link:") || identity.version.startsWith("git")) {
      fail(`lock package uses unsupported source: ${key}`);
    }
    assertNpmVersion(identity.version, `lock package ${key} version`);
    if (raw.version !== undefined && raw.version !== identity.version) {
      fail(`lock package version differs from key: ${key}`);
    }
    if (typeof resolution.tarball === "string" && resolution.tarball !== canonicalTarballUrl(identity.name, identity.version)) {
      fail(`lock package tarball source is not the official registry: ${key}`);
    }
    parsed.push({ key, name: identity.name, version: identity.version, resolution, root: false });
  }
  if (root === null) fail("lockfile misses the verified root package record");
  return parsed;
}

function writeStageFiles(stageDir: string, packageName: string, artifactPath: string): string {
  const packageJson = {
    name: "jorgex-browser-stage",
    version: "0.0.0",
    private: true,
    packageManager: "pnpm@11.1.1",
    dependencies: { [packageName]: `file:${artifactPath}` },
  };
  try {
    fs.writeFileSync(path.join(stageDir, STAGE_PACKAGE_FILE), `${JSON.stringify(packageJson)}\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(stageDir, STAGE_NPMRC_FILE),
      "registry=https://registry.npmjs.org/\nignore-scripts=true\nfund=false\naudit=false\n" +
        "global-pnpmfile=\npatches-dir=\n",
      { mode: 0o600 },
    );
  } catch {
    fail("cannot write private stage configuration");
  }
  const hookPath = path.join(stageDir, STAGE_HOOK_FILE);
  const lockPath = path.join(stageDir, STAGE_LOCK_FILE);
  const hook = `import fs from "node:fs";\nconst output = process.env.JORGEX_BROWSER_STAGE_LOCK;\nif (typeof output !== "string" || output === "") throw new Error("missing stage lock output");\nexport const hooks = { afterAllResolved(lockfile) { fs.writeFileSync(output, JSON.stringify(lockfile), { encoding: "utf8", mode: 0o600 }); return lockfile; } };\n`;
  try {
    fs.writeFileSync(hookPath, hook, { mode: 0o600 });
    // Make the expected output path explicit to injected runners too.
    fs.rmSync(lockPath, { force: true });
  } catch {
    fail("cannot write private stage hook");
  }
  return lockPath;
}

function stageEnv(stageDir: string, storeDir: string, virtualStoreDir: string, lockPath: string): NodeJS.ProcessEnv {
  const home = path.join(stageDir, ".home");
  const cache = path.join(stageDir, ".cache");
  const tmp = path.join(stageDir, ".tmp");
  const pnpmHome = path.join(stageDir, ".pnpm-home");
  const dirs = [home, cache, tmp, pnpmHome, storeDir, virtualStoreDir];
  try {
    for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    fail("cannot create private pnpm directories");
  }
  const systemPath = process.platform === "win32"
    ? [path.dirname(process.execPath), process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : null]
    : [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(stageDir, ".config"),
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: path.join(stageDir, ".local-share"),
    XDG_STATE_HOME: path.join(stageDir, ".state"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    PNPM_HOME: pnpmHome,
    COREPACK_HOME: path.join(stageDir, ".corepack"),
    PATH: systemPath.filter((entry): entry is string => entry !== null).join(path.delimiter),
    NPM_CONFIG_REGISTRY: `https://${REGISTRY_HOST}/`,
    npm_config_registry: `https://${REGISTRY_HOST}/`,
    NPM_CONFIG_USERCONFIG: path.join(stageDir, STAGE_NPMRC_FILE),
    npm_config_userconfig: path.join(stageDir, STAGE_NPMRC_FILE),
    npm_config_cache: cache,
    npm_config_store_dir: storeDir,
    npm_config_virtual_store_dir: virtualStoreDir,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_ignore_scripts: "true",
    JORGEX_BROWSER_STAGE_LOCK: lockPath,
    CI: "true",
    NO_UPDATE_NOTIFIER: "1",
  };
  try {
    fs.mkdirSync(env.XDG_CONFIG_HOME as string, { recursive: true, mode: 0o700 });
    fs.mkdirSync(env.XDG_DATA_HOME as string, { recursive: true, mode: 0o700 });
    fs.mkdirSync(env.XDG_STATE_HOME as string, { recursive: true, mode: 0o700 });
    fs.mkdirSync(env.COREPACK_HOME as string, { recursive: true, mode: 0o700 });
  } catch {
    fail("cannot create private pnpm environment");
  }
  return env;
}

async function runDefaultPnpm(
  pnpmBin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  const command = planDetectedBinCommand(pnpmBin, args);
  if (command === null) fail("pnpm path contains unsafe Windows command characters");
  const result = spawnSync(command.command, command.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined) {
    fail(`pnpm failed (${(result.error as NodeJS.ErrnoException).code ?? "UNKNOWN"})`);
  }
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const codes = [...new Set(output.match(/\b(?:ERR_PNPM_[A-Z0-9_]+|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENOSPC|CERT_[A-Z0-9_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b/g) ?? [])].slice(0, 3);
    fail(`pnpm exited with status ${String(result.status)}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}`);
  }
}

function assertStageTreeFilesystem(stageDir: string, realStage: string): void {
  let count = 0;
  const visited = new Set<string>();
  const walk = (entry: string): void => {
    count += 1;
    if (count > MAX_FILES) fail("staged tree exceeds file bound");
    const stat = lstatOrFail(entry, "staged tree entry");
    if (stat.isSymbolicLink()) {
      const real = assertContained(realStage, entry, "staged symlink");
      if (visited.has(real)) return;
      visited.add(real);
      const realStat = lstatOrFail(real, "staged symlink target");
      if (realStat.isDirectory()) walk(real);
      return;
    }
    if (!stat.isDirectory()) return;
    const real = assertContained(realStage, entry, "staged directory");
    if (visited.has(real)) return;
    visited.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(entry, { withFileTypes: true });
    } catch {
      fail(`cannot enumerate staged directory: ${entry}`);
    }
    for (const child of entries) walk(path.join(entry, child.name));
  };
  walk(stageDir);
}

function readPackageManifest(file: string, label: string): { name: string; version: string } {
  const parsed = readBoundedJson(file, label);
  if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    fail(`${label} misses name/version`);
  }
  if (!PACKAGE_NAME.test(parsed.name) || !NPM_VERSION.test(parsed.version)) fail(`${label} has invalid identity`);
  return { name: parsed.name, version: parsed.version };
}

function collectVirtualPackages(stageDir: string, realStage: string): Set<string> {
  const virtual = path.join(stageDir, "node_modules", ".pnpm");
  const stat = assertRealDirectory(virtual, "pnpm virtual store");
  if (stat !== realStage && !stat.startsWith(realStage + path.sep)) fail("pnpm virtual store escapes stage");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(virtual, { withFileTypes: true });
  } catch {
    fail("cannot enumerate pnpm virtual store");
  }
  const identities = new Set<string>();
  const visited = new Set<string>();
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "lock.yaml") continue;
    const packageEntry = path.join(virtual, entry.name);
    const entryStat = lstatOrFail(packageEntry, "pnpm virtual package");
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) fail(`invalid pnpm virtual package: ${entry.name}`);
    assertContained(realStage, packageEntry, "pnpm virtual package");
    const packageModules = path.join(packageEntry, "node_modules");
    assertRealDirectory(packageModules, "pnpm virtual package node_modules");
    const collect = (dir: string): void => {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        fail(`cannot enumerate pnpm package directory: ${dir}`);
      }
      for (const child of children) {
        if (child.name === ".bin") continue;
        const childPath = path.join(dir, child.name);
        const childStat = lstatOrFail(childPath, "pnpm installed package");
        if (childStat.isDirectory() && !childStat.isSymbolicLink() && child.name.startsWith("@")) {
          collect(childPath);
          continue;
        }
        if (!childStat.isDirectory() && !childStat.isSymbolicLink()) {
          fail(`pnpm package entry is not a directory: ${childPath}`);
        }
        assertContained(realStage, childPath, "pnpm installed package");
        const manifest = readPackageManifest(path.join(childPath, "package.json"), "pnpm package manifest");
        const real = fs.realpathSync(childPath);
        if (!visited.has(real)) {
          visited.add(real);
          identities.add(`${manifest.name}@${manifest.version}`);
        }
      }
    };
    collect(packageModules);
  }
  if (identities.size === 0) fail("pnpm installed package tree is empty");
  return identities;
}

function collectHoistedPackages(stageDir: string, realStage: string): Set<string> {
  const nodeModules = path.join(stageDir, "node_modules");
  assertRealDirectory(nodeModules, "node_modules");
  const identities = new Set<string>();
  const pending = [nodeModules];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { fail(`cannot enumerate hoisted package directory: ${directory}`); }
    for (const entry of entries) {
      if ([".pnpm", ".bin", ".modules.yaml", ".pnpm-workspace-state-v1.json"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        let scoped: fs.Dirent[];
        try { scoped = fs.readdirSync(fullPath, { withFileTypes: true }); }
        catch { fail(`cannot enumerate hoisted scope: ${fullPath}`); }
        for (const child of scoped) {
          if (!child.isDirectory() || child.isSymbolicLink()) fail(`hoisted scope contains a non-directory package: ${fullPath}`);
          const packagePath = path.join(fullPath, child.name);
          const real = assertContained(realStage, packagePath, "hoisted package");
          const manifest = readPackageManifest(path.join(real, "package.json"), "hoisted package manifest");
          if (manifest.name !== `${entry.name}/${child.name}`) fail(`hoisted package name differs from path: ${packagePath}`);
          identities.add(`${manifest.name}@${manifest.version}`);
          const nested = path.join(packagePath, "node_modules");
          if (fs.existsSync(nested)) { assertRealDirectory(nested, "nested node_modules"); pending.push(nested); }
        }
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`hoisted package is not a real directory: ${fullPath}`);
      const real = assertContained(realStage, fullPath, "hoisted package");
      const manifest = readPackageManifest(path.join(real, "package.json"), "hoisted package manifest");
      if (manifest.name !== entry.name) fail(`hoisted package name differs from path: ${fullPath}`);
      identities.add(`${manifest.name}@${manifest.version}`);
      const nested = path.join(fullPath, "node_modules");
      if (fs.existsSync(nested)) { assertRealDirectory(nested, "nested node_modules"); pending.push(nested); }
    }
  }
  if (identities.size === 0) fail("hoisted installed package tree is empty");
  return identities;
}

function assertTopLevelPackages(stageDir: string, packageName: string, realStage: string, lockPackages: LockPackage[]): string {
  const nodeModules = path.join(stageDir, "node_modules");
  assertRealDirectory(nodeModules, "node_modules");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    fail("cannot enumerate node_modules");
  }
  const allowed = new Set([".pnpm", ".bin", ".modules.yaml", ".pnpm-workspace-state-v1.json"]);
  for (const name of process.platform === "win32" ? lockPackages.map((pkg) => pkg.name) : [packageName]) {
    allowed.add(name.startsWith("@") ? name.slice(0, name.indexOf("/")) : name);
  }
  for (const entry of entries) {
    if (!allowed.has(entry.name)) fail(`extra top-level installed package: ${entry.name}`);
  }
  const treePath = path.join(nodeModules, ...packageName.split("/"));
  const treeStat = lstatOrFail(treePath, "staged root package");
  if (!treeStat.isDirectory() && !treeStat.isSymbolicLink()) {
    fail("staged root package is not a directory");
  }
  assertContained(realStage, treePath, "staged root package");
  return treePath;
}

function assertClosureInstalled(
  stageDir: string,
  packageName: string,
  release: BrowserStageRelease,
  lockPackages: LockPackage[],
  realStage: string,
): string {
  const treePath = assertTopLevelPackages(stageDir, packageName, realStage, lockPackages);
  const manifest = readPackageManifest(path.join(treePath, "package.json"), "staged root package manifest");
  if (manifest.name !== packageName || manifest.version !== release.version) {
    fail("staged root package manifest differs from release");
  }
  const installed = process.platform === "win32"
    ? collectHoistedPackages(stageDir, realStage)
    : collectVirtualPackages(stageDir, realStage);
  const expected = new Set<string>();
  for (const pkg of lockPackages) expected.add(`${pkg.name}@${pkg.version}`);
  expected.add(`${packageName}@${release.version}`);
  for (const identity of installed) {
    if (!expected.has(identity)) fail(`installed package is absent from lock closure: ${identity}`);
  }
  if (!installed.has(`${packageName}@${release.version}`)) fail("verified root package is absent from installed tree");
  for (const pkg of lockPackages) {
    const identity = `${pkg.name}@${pkg.version}`;
    if (!installed.has(identity)) fail(`lock package is absent from installed tree: ${identity}`);
  }
  return treePath;
}

interface BrowserTreeEntry {
  kind: "file" | "dir" | "symlink";
  relativePath: string;
  filePath?: string;
  target?: string;
}

interface TreeMetadataBudget {
  bytes: number;
}

function isContainedTreePath(root: string, candidate: string, allowEqual: boolean): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readContainedTreeSymlinkTarget(linkPath: string, root: string, metadata: TreeMetadataBudget): string {
  let raw: Buffer;
  try {
    raw = fs.readlinkSync(linkPath, "buffer") as Buffer;
  } catch {
    fail(`cannot read staged symlink: ${linkPath}`);
  }
  const target = raw.toString("utf8");
  if (
    !Buffer.from(target, "utf8").equals(raw) ||
    target === "" ||
    CONTROL_CHARACTERS.test(target) ||
    raw.byteLength > MAX_TREE_SYMLINK_BYTES ||
    path.isAbsolute(target) ||
    (process.platform === "win32" && /^[a-zA-Z]:/.test(target))
  ) {
    fail(`staged symlink must be an internal relative UTF-8 target: ${linkPath}`);
  }
  const separator = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts = target.split(separator).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) fail(`staged symlink target is empty: ${linkPath}`);
  let current = path.dirname(path.resolve(linkPath));
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const last = index === parts.length - 1;
    current = part === ".." ? path.dirname(current) : path.join(current, part);
    if (!isContainedTreePath(root, current, true)) fail(`staged symlink escapes its tree: ${linkPath}`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail(`staged symlink target is missing: ${linkPath}`);
    }
    if (stat.isSymbolicLink()) fail(`staged symlink chain is not allowed: ${linkPath}`);
    if (last) {
      if (!stat.isFile() && !stat.isDirectory()) fail(`staged symlink target is not a file or directory: ${linkPath}`);
    } else if (!stat.isDirectory()) {
      fail(`staged symlink target traverses a non-directory: ${linkPath}`);
    }
  }
  if (metadata.bytes + raw.byteLength > MAX_TREE_METADATA_BYTES) {
    fail("staged tree exceeds its metadata bound");
  }
  metadata.bytes += raw.byteLength;
  return target;
}

function readTreeDirectoryEntries(
  directoryPath: string,
  root: string,
  remainingEntries: number,
  metadata: TreeMetadataBudget,
): Array<{ fullPath: string; relativePath: string }> {
  let directory: fs.Dir;
  try {
    directory = fs.opendirSync(directoryPath);
  } catch {
    fail(`cannot open staged tree directory: ${directoryPath}`);
  }
  const entries: Array<{ fullPath: string; relativePath: string }> = [];
  let primary: unknown = null;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= remainingEntries) fail("staged tree exceeds its entry bound");
      const fullPath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(path.resolve(root), fullPath).split(path.sep).join("/");
      const pathBytes = Buffer.byteLength(relativePath, "utf8");
      if (
        relativePath === "" ||
        CONTROL_CHARACTERS.test(relativePath) ||
        pathBytes > MAX_TREE_PATH_BYTES ||
        metadata.bytes + pathBytes > MAX_TREE_METADATA_BYTES
      ) {
        fail(`staged tree contains an invalid or oversized path: ${fullPath}`);
      }
      metadata.bytes += pathBytes;
      entries.push({ fullPath, relativePath });
    }
  } catch (error) {
    primary = error;
    if (error instanceof Error && error.message.startsWith("browser-stage: ")) throw error;
    fail(`cannot read staged tree directory: ${directoryPath}`);
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      if (primary === null) fail(`cannot close staged tree directory: ${directoryPath}`);
    }
  }
  return entries;
}

function openTrustedTreeFile(filePath: string): { fd: number; size: number } {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch {
    fail(`cannot open staged tree file: ${filePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    try { fs.closeSync(fd); } catch { /* Preserve the primary failure. */ }
    fail(`cannot stat staged tree file: ${filePath}`);
  }
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
    try { fs.closeSync(fd); } catch { /* Preserve the primary failure. */ }
    fail(`staged tree entry is not a regular file: ${filePath}`);
  }
  return { fd, size: stat.size };
}

function hashTrustedTreeFile(hash: ReturnType<typeof createHash>, filePath: string, total: { bytes: number }): void {
  const opened = openTrustedTreeFile(filePath);
  let primary: unknown = null;
  try {
    if (opened.size > MAX_TREE_BYTES || total.bytes + opened.size > MAX_TREE_BYTES) {
      fail("staged tree exceeds its byte bound");
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(opened.size));
    hash.update(length);
    const buffer = Buffer.allocUnsafe(TREE_HASH_CHUNK_BYTES);
    let readTotal = 0;
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(opened.fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read staged tree file: ${filePath}`);
      }
      if (read === 0) break;
      readTotal += read;
      if (readTotal > opened.size || total.bytes + readTotal > MAX_TREE_BYTES) {
        fail(`staged tree file changed or exceeds its byte bound: ${filePath}`);
      }
      hash.update(buffer.subarray(0, read));
    }
    const finalStat = fs.fstatSync(opened.fd);
    if (!finalStat.isFile() || finalStat.size !== readTotal || readTotal !== opened.size) {
      fail(`staged tree file changed while being verified: ${filePath}`);
    }
    total.bytes += readTotal;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      if (primary === null) fail(`cannot close staged tree file: ${filePath}`);
    }
  }
}

export function browserTreeSha256(nodeModulesPath: string, realStage: string): string {
  const nodeModulesStat = lstatOrFail(nodeModulesPath, "node_modules");
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    fail("node_modules must be a real directory");
  }
  assertContained(realStage, nodeModulesPath, "node_modules");
  const root = path.resolve(nodeModulesPath);
  const entries: BrowserTreeEntry[] = [];
  const pending = [root];
  const metadata: TreeMetadataBudget = { bytes: 0 };
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const { fullPath, relativePath } of readTreeDirectoryEntries(
      directory,
      root,
      MAX_TREE_ENTRIES - entries.length,
      metadata,
    )) {
      if (entries.length >= MAX_TREE_ENTRIES) fail("staged tree exceeds its entry bound");
      const stat = lstatOrFail(fullPath, "staged tree entry");
      if (stat.isSymbolicLink()) {
        entries.push({
          kind: "symlink",
          relativePath,
          target: readContainedTreeSymlinkTarget(fullPath, root, metadata),
        });
      } else if (stat.isDirectory()) {
        entries.push({ kind: "dir", relativePath });
        pending.push(fullPath);
      } else if (stat.isFile()) {
        entries.push({ kind: "file", relativePath, filePath: fullPath });
      } else {
        fail(`staged tree contains an unsupported entry: ${fullPath}`);
      }
    }
  }
  entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  const hash = createHash("sha256");
  hash.update("browser-v2\0", "utf8");
  const total = { bytes: 0 };
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.relativePath}\0`, "utf8");
    if (entry.kind === "symlink") {
      const payload = Buffer.from(entry.target!, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(payload.length));
      hash.update(length);
      hash.update(payload);
      total.bytes += payload.length;
      if (total.bytes > MAX_TREE_BYTES) fail("staged tree exceeds its byte bound");
    } else if (entry.kind === "dir") {
      hash.update(Buffer.alloc(8));
    } else {
      hashTrustedTreeFile(hash, entry.filePath!, total);
    }
  }
  return hash.digest("hex");
}

/**
 * Installs an already SRI-verified browser tarball in a private pnpm stage,
 * captures pnpm's resolved lock object through `afterAllResolved`, and checks
 * every registry package against official metadata before returning its tree.
 * This function never promotes or activates the staged tree.
 */
export async function stageVerifiedBrowserTree(
  input: StageVerifiedBrowserTreeInput,
  deps: StageVerifiedBrowserTreeDeps = {},
): Promise<StageVerifiedBrowserTreeResult> {
  if (!isRecord(input)) fail("input must be an object");
  const { artifactPath: rawArtifactPath, packageName, release: rawRelease, stageDir: rawStageDir, pnpmBin, fetchImpl } = input;
  if (typeof packageName !== "string" || !PACKAGE_NAME.test(packageName)) fail("invalid package name");
  const artifactPath = assertAbsolutePath(rawArtifactPath, "artifactPath");
  const stageDir = assertAbsolutePath(rawStageDir, "stageDir");
  if (typeof pnpmBin !== "string" || pnpmBin === "" || !path.isAbsolute(pnpmBin)) fail("pnpmBin must be absolute");
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) fail("invalid dependencies");
  if (deps.runPnpm !== undefined && typeof deps.runPnpm !== "function") fail("runPnpm must be a function");
  const release = assertRelease(packageName, rawRelease);
  const realStage = assertRealDirectory(stageDir, "stageDir");
  let stageEntries: fs.Dirent[];
  try {
    stageEntries = fs.readdirSync(stageDir, { withFileTypes: true });
  } catch {
    fail("cannot enumerate stageDir");
  }
  if (stageEntries.length !== 0) fail("stageDir must start empty");
  try {
    fs.chmodSync(stageDir, 0o700);
  } catch {
    fail("cannot make stageDir private");
  }
  assertArtifactIntegrity(artifactPath, release.integrity);
  const lockPath = writeStageFiles(stageDir, packageName, artifactPath);
  const storeDir = path.join(stageDir, ".pnpm-store");
  const virtualStoreDir = path.join(stageDir, "node_modules", ".pnpm");
  const env = stageEnv(stageDir, storeDir, virtualStoreDir, lockPath);
  const args = [
    "install",
    "--ignore-scripts",
    "--ignore-workspace",
    `--registry=https://${REGISTRY_HOST}/`,
    `--config.pnpmfile=${path.join(stageDir, STAGE_HOOK_FILE)}`,
    `--config.lockfile-dir=${stageDir}`,
    `--config.store-dir=${storeDir}`,
    `--config.virtual-store-dir=${virtualStoreDir}`,
    ...(process.platform === "win32" ? ["--config.node-linker=hoisted"] : []),
    "--frozen-lockfile=false",
  ];
  try {
    const runner = deps.runPnpm ?? ((runnerArgs, options) => runDefaultPnpm(pnpmBin, runnerArgs, options));
    await runner(args, { cwd: stageDir, env });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-stage: ")) throw error;
    fail(`pnpm stage failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertArtifactIntegrity(artifactPath, release.integrity);
  const lock = readBoundedJson(lockPath, "pnpm closure evidence");
  const lockPackages = parseLockPackages(lock, packageName, release, stageDir, artifactPath);
  const metadata = new Map<string, OfficialPackageMetadata>();
  const closure: BrowserClosurePackage[] = [];
  for (const pkg of lockPackages) {
    if (pkg.root) {
      closure.push({ name: pkg.name, version: pkg.version, integrity: release.integrity });
      continue;
    }
    const identity = `${pkg.name}@${pkg.version}`;
    let observed = metadata.get(identity);
    if (observed === undefined) {
      observed = await readOfficialMetadata(pkg.name, pkg.version, fetchImpl);
      metadata.set(identity, observed);
    }
    if (pkg.resolution.integrity !== observed.integrity) {
      fail(`lock integrity differs from official metadata: ${identity}`);
    }
    if (pkg.resolution.tarball !== undefined && pkg.resolution.tarball !== observed.tarball) {
      fail(`lock tarball differs from official metadata: ${identity}`);
    }
    closure.push({ name: pkg.name, version: pkg.version, integrity: observed.integrity });
  }
  assertStageTreeFilesystem(stageDir, realStage);
  const treePath = assertClosureInstalled(stageDir, packageName, release, lockPackages, realStage);
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treeSha256 = browserTreeSha256(nodeModulesPath, realStage);
  closure.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { treePath, nodeModulesPath, treeSha256, closure };
}
