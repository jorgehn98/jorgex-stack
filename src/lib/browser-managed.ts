import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browserTreeSha256, type BrowserClosurePackage, type StageVerifiedBrowserTreeResult } from "./browser-stage.js";
import { isCanonicalSha512Integrity, isStableSemverVersion, type NpmPackageRelease } from "./npm-provider.js";

const MANAGED_ROOT = ".browser-managed";
const LOCK_FILE = ".activation.lock";
const ACTIVE_POINTER_FILE = "active.v1.json";
const RECEIPT_FILE = "receipt.json";
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;
const HASH = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 16 * 1024;
const MAX_TREE_SYMLINK_BYTES = 16 * 1024;
const TREE_HASH_CHUNK_BYTES = 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export type ManagedBrowserPackageName = "@playwright/cli" | "chrome-devtools-mcp";

/** The exact provider release whose bytes were verified before staging. */
export type ManagedBrowserRelease = NpmPackageRelease;

export interface ActivateManagedBrowserTreeInput {
  /** Stack state root where the managed tree and receipt will live. */
  readonly stateDir: string;
  readonly packageName: ManagedBrowserPackageName;
  readonly release: ManagedBrowserRelease;
  /** The isolated tree returned by `stageVerifiedBrowserTree`. */
  readonly staged: StageVerifiedBrowserTreeResult;
  /** Absolute entry path contained by `staged.nodeModulesPath`. */
  readonly entryPath: string;
}

export interface ManagedBrowserReceipt {
  readonly schemaVersion: 1;
  readonly packageName: ManagedBrowserPackageName;
  readonly version: string;
  readonly integrity: string;
  readonly rootPath: string;
  readonly treePath: string;
  readonly entryPath: string;
  readonly launcherPath: string;
  readonly treeSha256: string;
  readonly launcherSha256: string;
  readonly closure: readonly BrowserClosurePackage[];
}

function fail(message: string): never {
  throw new Error(`browser-managed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || !path.isAbsolute(value)) {
    fail(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function lstatOrFail(file: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(file);
  } catch {
    fail(`missing ${label}: ${file}`);
  }
}

function fileIdentity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: fs.Stats, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function realpathOrFail(file: string, label: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    fail(`cannot resolve ${label}: ${file}`);
  }
}

function assertRealDirectory(directory: string, label: string): string {
  const stat = lstatOrFail(directory, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${directory}`);
  return realpathOrFail(directory, label);
}

function existingRealDirectory(directory: string, label: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(`cannot inspect ${label}: ${directory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`);
  return realpathOrFail(directory, label);
}

function isContained(root: string, candidate: string, allowEqual: boolean): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertContained(root: string, candidate: string, label: string): string {
  const resolved = realpathOrFail(candidate, label);
  if (!isContained(root, resolved, false)) fail(`${label} escapes its root`);
  return resolved;
}

function assertStateDirectory(input: unknown): string {
  const directory = absolutePath(input, "stateDir");
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("stateDir must be a real directory");
    return realpathOrFail(directory, "stateDir");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-managed: ")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`cannot inspect stateDir: ${directory}`);
    return directory;
  }
}

function ensureDirectory(directory: string, label: string): string {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a real directory`);
    return realpathOrFail(directory, label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-managed: ")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`cannot inspect ${label}: ${directory}`);
    try {
      fs.mkdirSync(directory, { mode: 0o700, recursive: false });
    } catch {
      fail(`cannot create ${label}: ${directory}`);
    }
    return assertRealDirectory(directory, label);
  }
}

function packageDirectoryName(packageName: ManagedBrowserPackageName): string {
  return packageName === "@playwright/cli" ? "playwright-cli" : "chrome-devtools-mcp";
}

function validateRelease(value: unknown): ManagedBrowserRelease {
  if (!isRecord(value)) fail("release must be an object");
  if (!isStableSemverVersion(value.version)) fail("release version must be a stable semver");
  if (typeof value.tarballUrl !== "string" || value.tarballUrl === "") fail("release tarball URL is invalid");
  if (!isCanonicalSha512Integrity(value.integrity)) fail("release integrity is invalid");
  return { version: value.version, tarballUrl: value.tarballUrl, integrity: value.integrity };
}

function validateClosureIdentity(
  value: unknown,
  packageName: ManagedBrowserPackageName,
  version: unknown,
  integrity: unknown,
): readonly BrowserClosurePackage[] {
  if (!Array.isArray(value) || value.length === 0) fail("staged closure must be a non-empty array");
  const seen = new Set<string>();
  const closure: BrowserClosurePackage[] = [];
  for (const item of value) {
    if (!isRecord(item)) fail("staged closure entry must be an object");
    if (
      typeof item.name !== "string" ||
      !PACKAGE_NAME.test(item.name) ||
      typeof item.version !== "string" ||
      !NPM_VERSION.test(item.version) ||
      !isCanonicalSha512Integrity(item.integrity)
    ) {
      fail("staged closure entry is invalid");
    }
    const key = `${item.name}@${item.version}`;
    if (seen.has(key)) fail(`staged closure contains a duplicate: ${key}`);
    seen.add(key);
    closure.push({ name: item.name, version: item.version, integrity: item.integrity });
  }
  const root = closure.find((item) => item.name === packageName);
  if (root === undefined || root.version !== version || root.integrity !== integrity) {
    fail("staged closure root differs from release");
  }
  return closure;
}

function validateClosure(
  value: unknown,
  packageName: ManagedBrowserPackageName,
  release: ManagedBrowserRelease,
): readonly BrowserClosurePackage[] {
  return validateClosureIdentity(value, packageName, release.version, release.integrity);
}

function validateStagedInput(input: ActivateManagedBrowserTreeInput): {
  stateDir: string;
  packageName: ManagedBrowserPackageName;
  release: ManagedBrowserRelease;
  nodeModulesPath: string;
  treePath: string;
  entryPath: string;
  treeSha256: string;
  closure: readonly BrowserClosurePackage[];
} {
  if (!isRecord(input)) fail("input must be an object");
  if (input.packageName !== "@playwright/cli" && input.packageName !== "chrome-devtools-mcp") {
    fail("unsupported managed browser package");
  }
  const packageName = input.packageName;
  const stateDir = assertStateDirectory(input.stateDir);
  const release = validateRelease(input.release);
  if (!isRecord(input.staged)) fail("staged tree evidence must be an object");
  const nodeModulesPath = absolutePath(input.staged.nodeModulesPath, "staged.nodeModulesPath");
  const treePath = absolutePath(input.staged.treePath, "staged.treePath");
  const entryPath = absolutePath(input.entryPath, "entryPath");
  const treeSha256 = input.staged.treeSha256;
  if (typeof treeSha256 !== "string" || !HASH.test(treeSha256)) fail("staged treeSha256 is invalid");
  const stageRoot = realpathOrFail(path.dirname(nodeModulesPath), "staged stage root");
  const realNodeModulesPath = assertRealDirectory(nodeModulesPath, "staged node_modules");
  if (!isContained(stageRoot, realNodeModulesPath, false)) fail("staged node_modules escapes its stage");
  const realTreePath = assertContained(realNodeModulesPath, treePath, "staged tree");
  const entryStat = lstatOrFail(entryPath, "staged entry");
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) fail("staged entry must be a regular file");
  const realEntryPath = assertContained(realNodeModulesPath, entryPath, "staged entry");
  if (!isContained(realNodeModulesPath, realEntryPath, false)) fail("staged entry escapes node_modules");
  if (!isContained(realNodeModulesPath, realTreePath, false)) fail("staged tree escapes node_modules");
  const closure = validateClosure(input.staged.closure, packageName, release);
  const observedTreeSha256 = browserTreeSha256(nodeModulesPath, stageRoot);
  if (observedTreeSha256 !== treeSha256) fail("staged tree digest drifted before activation");
  const relativeEntry = path.relative(path.resolve(nodeModulesPath), path.resolve(entryPath));
  if (
    relativeEntry === "" ||
    relativeEntry === ".." ||
    relativeEntry.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeEntry)
  ) {
    fail("entryPath must be contained by staged node_modules");
  }
  return { stateDir, packageName, release, nodeModulesPath, treePath: realTreePath, entryPath, treeSha256, closure };
}

async function acquireLock(lockPath: string): Promise<() => void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      const lockIdentity = fileIdentity(fs.fstatSync(fd));
      try {
        fs.writeSync(fd, `${process.pid}\n`, undefined, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          const stat = fs.lstatSync(lockPath);
          if (stat.isFile() && !stat.isSymbolicLink() && sameFileIdentity(stat, lockIdentity)) fs.unlinkSync(lockPath);
        } catch {
          // Never remove a path that changed owner.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") fail(`cannot acquire activation lock: ${String(error)}`);
      const stat = lstatOrFail(lockPath, "activation lock");
      if (!stat.isFile() || stat.isSymbolicLink()) fail("activation lock is not a regular file");
      if (attempt + 1 === LOCK_ATTEMPTS) fail("managed browser activation lock is busy");
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  fail("managed browser activation lock is busy");
}

function removeOwnedDirectory(directory: string | null, identity: FileIdentity | null = null): void {
  if (directory === null) return;
  try {
    const stat = fs.lstatSync(directory);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (identity === null || sameFileIdentity(stat, identity))
    ) {
      fs.rmSync(directory, { recursive: true, force: false });
    }
  } catch {
    // Preserve the primary activation error and never delete foreign state.
  }
}

interface ActiveBrowserPointer {
  readonly schemaVersion: 1;
  readonly packageName: ManagedBrowserPackageName;
  readonly rootPath: string;
  readonly receiptSha256: string;
}

interface ValidatedActiveBrowser {
  readonly pointerPath: string;
  readonly pointerIdentity: FileIdentity;
  readonly pointerRaw: Buffer;
  readonly receiptPath: string;
  readonly receiptRaw: Buffer;
  readonly receipt: ManagedBrowserReceipt;
}

function readBoundedRegularFile(file: string, label: string, maxBytes: number): Buffer {
  const stat = lstatOrFail(file, label);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stat.size > maxBytes) fail(`${label} exceeds its size bound`);
  try {
    return fs.readFileSync(file);
  } catch {
    fail(`cannot read ${label}: ${file}`);
  }
}

/** Resolve the executable declared by the verified root package, never by PATH. */
export function resolveStagedBrowserEntry(
  staged: StageVerifiedBrowserTreeResult,
  packageName: ManagedBrowserPackageName,
): string {
  if (packageName !== "@playwright/cli" && packageName !== "chrome-devtools-mcp") {
    fail("unsupported managed browser package");
  }
  const root = absolutePath(staged.treePath, "staged.treePath");
  const realRoot = realpathOrFail(root, "staged root package");
  const manifestPath = path.join(root, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readBoundedRegularFile(manifestPath, "staged package manifest", 1024 * 1024).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-managed: ")) throw error;
    fail("staged package manifest is invalid JSON");
  }
  if (!isRecord(manifest) || manifest.name !== packageName) fail("staged package identity differs");
  const binName = packageName === "@playwright/cli" ? "playwright-cli" : "chrome-devtools-mcp";
  const bin = typeof manifest.bin === "string"
    ? manifest.bin
    : isRecord(manifest.bin) ? manifest.bin[binName] : undefined;
  if (typeof bin !== "string" || bin === "" || path.isAbsolute(bin) || CONTROL_CHARACTERS.test(bin)) {
    fail("staged package bin is invalid");
  }
  const entry = path.resolve(root, bin);
  if (!isContained(root, entry, false)) fail("staged package bin escapes its root");
  const realEntry = assertContained(realRoot, entry, "staged package bin");
  const stat = lstatOrFail(entry, "staged package bin");
  if (!stat.isFile() || stat.isSymbolicLink() || !isContained(realRoot, realEntry, false)) {
    fail("staged package bin must be a regular file in its root");
  }
  return entry;
}

function readOptionalRegularFile(file: string, label: string, maxBytes: number): Buffer | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(`cannot inspect ${label}: ${file}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stat.size > maxBytes) fail(`${label} exceeds its size bound`);
  try {
    return fs.readFileSync(file);
  } catch {
    fail(`cannot read ${label}: ${file}`);
  }
}

function assertStrictKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${label} has unexpected fields`);
  }
}

function parseJsonObject(raw: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    fail(`${label} is malformed`);
  }
  if (!isRecord(parsed)) fail(`${label} must be an object`);
  return parsed;
}

function validateReceiptObject(
  value: unknown,
  packageDir: string,
  expectedPackageName: ManagedBrowserPackageName,
  expectedRootPath: string,
): ManagedBrowserReceipt {
  if (!isRecord(value)) fail("managed receipt must be an object");
  assertStrictKeys(
    value,
    [
      "closure",
      "entryPath",
      "integrity",
      "launcherPath",
      "launcherSha256",
      "packageName",
      "rootPath",
      "schemaVersion",
      "treePath",
      "treeSha256",
      "version",
    ],
    "managed receipt",
  );
  if (value.schemaVersion !== 1 || value.packageName !== expectedPackageName) fail("managed receipt identity is invalid");
  if (!isStableSemverVersion(value.version) || !isCanonicalSha512Integrity(value.integrity)) {
    fail("managed receipt release identity is invalid");
  }
  const rootPath = absolutePath(value.rootPath, "managed receipt rootPath");
  if (rootPath !== expectedRootPath || path.dirname(rootPath) !== packageDir || !path.basename(rootPath).startsWith("release-")) {
    fail("managed receipt rootPath is not an owned release");
  }
  const rootStat = lstatOrFail(rootPath, "managed release root");
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("managed release root is not a real directory");
  const treePath = absolutePath(value.treePath, "managed receipt treePath");
  if (treePath !== path.join(rootPath, "node_modules")) fail("managed receipt treePath is invalid");
  assertRealDirectory(treePath, "managed receipt tree");
  const entryPath = absolutePath(value.entryPath, "managed receipt entryPath");
  const launcherPath = absolutePath(value.launcherPath, "managed receipt launcherPath");
  if (!isContained(treePath, entryPath, false)) fail("managed receipt entryPath escapes the tree");
  if (!isContained(rootPath, launcherPath, false)) fail("managed receipt launcherPath escapes the release");
  assertContained(treePath, entryPath, "managed receipt entryPath");
  assertContained(rootPath, launcherPath, "managed receipt launcherPath");
  const entryStat = lstatOrFail(entryPath, "managed receipt entry");
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) fail("managed receipt entry is not a regular file");
  const launcherStat = lstatOrFail(launcherPath, "managed receipt launcher");
  if (!launcherStat.isFile() || launcherStat.isSymbolicLink()) fail("managed receipt launcher is not a regular file");
  if (typeof value.treeSha256 !== "string" || !HASH.test(value.treeSha256)) fail("managed receipt treeSha256 is invalid");
  if (typeof value.launcherSha256 !== "string" || !HASH.test(value.launcherSha256)) fail("managed receipt launcherSha256 is invalid");
  const closure = validateClosureIdentity(value.closure, expectedPackageName, value.version, value.integrity);
  const observedTreeSha256 = browserTreeSha256(treePath, rootPath);
  if (observedTreeSha256 !== value.treeSha256) fail("managed receipt tree digest drifted");
  if (hashRegularFile(launcherPath) !== value.launcherSha256) fail("managed receipt launcher digest drifted");
  return {
    schemaVersion: 1,
    packageName: expectedPackageName,
    version: value.version,
    integrity: value.integrity,
    rootPath,
    treePath,
    entryPath,
    launcherPath,
    treeSha256: value.treeSha256,
    launcherSha256: value.launcherSha256,
    closure,
  };
}

function readValidatedActiveBrowser(
  packageDir: string,
  packageName: ManagedBrowserPackageName,
): ValidatedActiveBrowser | null {
  const pointerPath = path.join(packageDir, ACTIVE_POINTER_FILE);
  const pointerRaw = readOptionalRegularFile(pointerPath, "active browser pointer", 64 * 1024);
  if (pointerRaw === null) return null;
  const pointerIdentity = fileIdentity(lstatOrFail(pointerPath, "active browser pointer"));
  const pointer = parseJsonObject(pointerRaw, "active browser pointer");
  assertStrictKeys(pointer, ["packageName", "receiptSha256", "rootPath", "schemaVersion"], "active browser pointer");
  if (pointer.schemaVersion !== 1 || pointer.packageName !== packageName) fail("active browser pointer identity is invalid");
  if (typeof pointer.receiptSha256 !== "string" || !HASH.test(pointer.receiptSha256)) {
    fail("active browser pointer receiptSha256 is invalid");
  }
  const rootPath = absolutePath(pointer.rootPath, "active browser pointer rootPath");
  if (path.dirname(rootPath) !== packageDir || !path.basename(rootPath).startsWith("release-")) {
    fail("active browser pointer rootPath is not an owned release");
  }
  const receiptPath = path.join(rootPath, RECEIPT_FILE);
  const receiptRaw = readBoundedRegularFile(receiptPath, "managed receipt", 4 * 1024 * 1024);
  const expectedReceiptSha256 = createHash("sha256").update(receiptRaw).digest("hex");
  if (expectedReceiptSha256 !== pointer.receiptSha256) fail("active browser pointer receipt hash differs");
  const receipt = validateReceiptObject(parseJsonObject(receiptRaw, "managed receipt"), packageDir, packageName, rootPath);
  return { pointerPath, pointerIdentity, pointerRaw, receiptPath, receiptRaw, receipt };
}

function assertNoOrphanedManagedBrowserState(packageDir: string, allowActiveLock: boolean): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packageDir, { withFileTypes: true });
  } catch {
    fail(`cannot inspect managed browser package root: ${packageDir}`);
  }
  const managedArtifacts = entries.filter((entry) => {
    if (allowActiveLock && entry.name === LOCK_FILE) return false;
    return (
      entry.name === LOCK_FILE ||
      entry.name === RECEIPT_FILE ||
      entry.name.startsWith("release-") ||
      entry.name.startsWith(".pending-") ||
      entry.name.startsWith(".active-")
    );
  });
  if (managedArtifacts.length > 0) {
    fail(
      `orphaned managed browser state without an active pointer: ${managedArtifacts
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }
}

/**
 * Reads the currently active managed browser receipt without repairing or
 * creating any state. Existing state is revalidated through the same strict
 * pointer, receipt, tree and launcher verifier used by activation.
 */
export function loadVerifiedManagedBrowserReceipt(
  stateDir: string,
  packageName: ManagedBrowserPackageName,
): ManagedBrowserReceipt | null {
  if (packageName !== "@playwright/cli" && packageName !== "chrome-devtools-mcp") {
    fail("unsupported managed browser package");
  }
  const statePath = absolutePath(stateDir, "stateDir");
  const realStateDir = existingRealDirectory(statePath, "stateDir");
  if (realStateDir === null) return null;
  const managedRoot = existingRealDirectory(path.join(realStateDir, MANAGED_ROOT), "managed browser root");
  if (managedRoot === null) return null;
  const packageDirectory = existingRealDirectory(
    path.join(managedRoot, packageDirectoryName(packageName)),
    "managed browser package root",
  );
  if (packageDirectory === null) return null;
  const active = readValidatedActiveBrowser(packageDirectory, packageName);
  if (active !== null) return active.receipt;
  assertNoOrphanedManagedBrowserState(packageDirectory, false);
  return null;
}

function hashRegularFile(file: string): string {
  const stat = lstatOrFail(file, "launcher");
  if (!stat.isFile() || stat.isSymbolicLink()) fail("launcher must be a regular file");
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`cannot open launcher: ${file}`);
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(TREE_HASH_CHUNK_BYTES);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    const finalStat = fs.fstatSync(fd);
    if (!finalStat.isFile() || finalStat.size !== stat.size) fail("launcher changed while being hashed");
    return hash.digest("hex");
  } finally {
    try { fs.closeSync(fd); } catch { /* Preserve the primary verification result. */ }
  }
}

function launcherSource(nodeModulesPath: string, entryPath: string, expectedTreeSha256: string): string {
  return `const fs = (await import("node:fs")).default;
const path = (await import("node:path")).default;
const { createHash } = await import("node:crypto");
const { pathToFileURL } = await import("node:url");

const root = ${JSON.stringify(nodeModulesPath)};
const entry = ${JSON.stringify(entryPath)};
const expected = ${JSON.stringify(expectedTreeSha256)};
const MAX_BYTES = ${MAX_TREE_BYTES};
const MAX_ENTRIES = ${MAX_TREE_ENTRIES};
const MAX_METADATA_BYTES = ${MAX_TREE_METADATA_BYTES};
const MAX_PATH_BYTES = ${MAX_TREE_PATH_BYTES};
const MAX_SYMLINK_BYTES = ${MAX_TREE_SYMLINK_BYTES};
const CHUNK_BYTES = ${TREE_HASH_CHUNK_BYTES};
const CONTROL = /[\\u0000-\\u001f\\u007f]/;

function contained(base, candidate, allowEqual) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  if (relative === "") return allowEqual;
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function targetFor(linkPath, tree, metadata) {
  const raw = fs.readlinkSync(linkPath, "buffer");
  const target = raw.toString("utf8");
  if (Buffer.from(target, "utf8").compare(raw) !== 0 || target === "" || CONTROL.test(target) || raw.byteLength > MAX_SYMLINK_BYTES || path.isAbsolute(target) || (process.platform === "win32" && /^[a-zA-Z]:/.test(target))) {
    throw new Error("managed browser symlink is not an internal relative target");
  }
  const parts = target.split(process.platform === "win32" ? /[\\\\/]+/ : /\\/+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error("managed browser symlink target is empty");
  let current = path.dirname(path.resolve(linkPath));
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = index === parts.length - 1;
    current = part === ".." ? path.dirname(current) : path.join(current, part);
    if (!contained(tree, current, true)) throw new Error("managed browser symlink escapes tree");
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("managed browser symlink chain is not allowed");
    if (last ? (!stat.isFile() && !stat.isDirectory()) : !stat.isDirectory()) throw new Error("managed browser symlink target is invalid");
  }
  if (metadata.bytes + raw.byteLength > MAX_METADATA_BYTES) throw new Error("managed browser metadata is too large");
  metadata.bytes += raw.byteLength;
  return target;
}

function readEntries(directory, tree, remaining, metadata) {
  const handle = fs.opendirSync(directory);
  const entries = [];
  let primary = null;
  try {
    for (;;) {
      const dirent = handle.readSync();
      if (dirent === null) break;
      if (entries.length >= remaining) throw new Error("managed browser tree has too many entries");
      const full = path.join(directory, dirent.name);
      const relative = path.relative(path.resolve(tree), full).split(path.sep).join("/");
      const pathBytes = Buffer.byteLength(relative, "utf8");
      if (relative === "" || CONTROL.test(relative) || pathBytes > MAX_PATH_BYTES || metadata.bytes + pathBytes > MAX_METADATA_BYTES) throw new Error("managed browser tree contains an invalid path");
      metadata.bytes += pathBytes;
      entries.push({ full, relative });
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { handle.closeSync(); } catch (error) { if (primary === null) throw error; }
  }
  return entries;
}

function openFile(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) { fs.closeSync(fd); throw new Error("managed browser tree entry is not a regular file"); }
  return { fd, size: stat.size };
}

function hashFile(hash, file, total) {
  const opened = openFile(file);
  let primary = null;
  try {
    if (opened.size > MAX_BYTES || total.bytes + opened.size > MAX_BYTES) throw new Error("managed browser tree is too large");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(opened.size));
    hash.update(length);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let readTotal = 0;
    for (;;) {
      const read = fs.readSync(opened.fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      readTotal += read;
      if (readTotal > opened.size || total.bytes + readTotal > MAX_BYTES) throw new Error("managed browser tree changed");
      hash.update(buffer.subarray(0, read));
    }
    const finalStat = fs.fstatSync(opened.fd);
    if (!finalStat.isFile() || finalStat.size !== readTotal || readTotal !== opened.size) throw new Error("managed browser tree changed");
    total.bytes += readTotal;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { fs.closeSync(opened.fd); } catch (error) { if (primary === null) throw error; }
  }
}

function treeHash(tree) {
  const rootStat = fs.lstatSync(tree);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("managed browser node_modules is invalid");
  const entries = [];
  const pending = [path.resolve(tree)];
  const metadata = { bytes: 0 };
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const { full, relative } of readEntries(directory, tree, MAX_ENTRIES - entries.length, metadata)) {
      if (entries.length >= MAX_ENTRIES) throw new Error("managed browser tree has too many entries");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) entries.push({ kind: "symlink", relative, target: targetFor(full, tree, metadata) });
      else if (stat.isDirectory()) { entries.push({ kind: "dir", relative }); pending.push(full); }
      else if (stat.isFile()) entries.push({ kind: "file", relative, filePath: full });
      else throw new Error("managed browser tree contains an unsupported entry");
    }
  }
  entries.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const hash = createHash("sha256");
  hash.update("browser-v2\\0", "utf8");
  const total = { bytes: 0 };
  for (const item of entries) {
    hash.update(item.kind + "\\0" + item.relative + "\\0", "utf8");
    if (item.kind === "symlink") {
      const payload = Buffer.from(item.target, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(payload.length));
      hash.update(length); hash.update(payload); total.bytes += payload.length;
    } else if (item.kind === "dir") hash.update(Buffer.alloc(8));
    else hashFile(hash, item.filePath, total);
  }
  return hash.digest("hex");
}

if (treeHash(root) !== expected) throw new Error("managed browser tree digest drifted before launch");
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
}

function managedTreeVerifierSource(): string {
  const source = launcherSource("/jorgex-browser-verifier/node_modules", "/jorgex-browser-verifier/entry.mjs", "0".repeat(64));
  const start = source.indexOf("function contained(base, candidate, allowEqual)");
  const end = source.indexOf("if (treeHash(root) !== expected)");
  if (start < 0 || end < 0 || end <= start) fail("managed browser tree verifier source is unavailable");
  return source.slice(start, end);
}

export interface ManagedBrowserInvocationPlan {
  readonly command: string;
  readonly args: readonly string[];
}

const DEVTOOLS_PRIVACY_FLAGS = [
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
] as const;

function invocationGuardSource(
  receipt: ManagedBrowserReceipt,
  runtimeArgs: readonly string[],
): string {
  const treeVerifier = managedTreeVerifierSource();
  return `const fs = (await import("node:fs")).default;
const { createHash } = await import("node:crypto");
const path = (await import("node:path")).default;

const expectedLauncherPath = ${JSON.stringify(receipt.launcherPath)};
const expectedLauncherSha256 = ${JSON.stringify(receipt.launcherSha256)};
const root = ${JSON.stringify(receipt.treePath)};
const expected = ${JSON.stringify(receipt.treeSha256)};
const expectedRuntimeArgs = ${JSON.stringify([...runtimeArgs])};
const MAX_LAUNCHER_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = ${MAX_TREE_BYTES};
const MAX_ENTRIES = ${MAX_TREE_ENTRIES};
const MAX_METADATA_BYTES = ${MAX_TREE_METADATA_BYTES};
const MAX_PATH_BYTES = ${MAX_TREE_PATH_BYTES};
const MAX_SYMLINK_BYTES = ${MAX_TREE_SYMLINK_BYTES};
const CHUNK_BYTES = ${TREE_HASH_CHUNK_BYTES};
const CONTROL = /[\\u0000-\\u001f\\u007f]/;

${treeVerifier}

function readVerifiedLauncher(file) {
  let initial;
  try { initial = fs.lstatSync(file); } catch { throw new Error("managed browser launcher is unavailable"); }
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("managed browser launcher is not a regular file");
  if (initial.size > MAX_LAUNCHER_BYTES) throw new Error("managed browser launcher exceeds 4 MiB");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  const chunks = [];
  let total = 0;
  let primary = null;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_LAUNCHER_BYTES) throw new Error("managed browser launcher is invalid");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_LAUNCHER_BYTES) throw new Error("managed browser launcher exceeds 4 MiB");
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    const finalStat = fs.fstatSync(fd);
    if (!finalStat.isFile() || finalStat.size !== total || total !== opened.size) throw new Error("managed browser launcher changed while being read");
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { fs.closeSync(fd); } catch (error) { if (primary === null) throw error; }
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("managed browser launcher is not strict UTF-8");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedLauncherSha256) throw new Error("managed browser launcher digest drifted");
  return text;
}

if (process.argv[1] !== expectedLauncherPath) throw new Error("managed browser launcher path changed");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedRuntimeArgs)) throw new Error("managed browser runtime args changed");
const launcherSource = readVerifiedLauncher(expectedLauncherPath);
if (treeHash(root) !== expected) throw new Error("managed browser tree digest drifted before launch");
process.argv[1] = expectedLauncherPath;
const evaluateVerifiedLauncher = (verifiedSource) => new Function("return (async()=>{\\n" + verifiedSource + "\\n})()")();
await evaluateVerifiedLauncher(launcherSource);
`;
}

export function planManagedBrowserInvocation(
  stateDir: string,
  packageName: ManagedBrowserPackageName,
  runtimeArgs: readonly string[],
): ManagedBrowserInvocationPlan {
  if (packageName !== "@playwright/cli" && packageName !== "chrome-devtools-mcp") {
    fail("unsupported managed browser package");
  }
  if (!Array.isArray(runtimeArgs)) fail("runtimeArgs must be an array");
  if (runtimeArgs.some((arg) => typeof arg !== "string" || CONTROL_CHARACTERS.test(arg))) {
    fail("runtimeArgs contain an invalid control character");
  }
  if (
    packageName === "chrome-devtools-mcp" &&
    (runtimeArgs.length !== DEVTOOLS_PRIVACY_FLAGS.length ||
      runtimeArgs.some((arg, index) => arg !== DEVTOOLS_PRIVACY_FLAGS[index]))
  ) {
    fail("chrome-devtools-mcp requires the fixed privacy flags in order");
  }
  const receipt = loadVerifiedManagedBrowserReceipt(stateDir, packageName);
  if (receipt === null) fail("verified managed browser receipt not found");
  return {
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      invocationGuardSource(receipt, runtimeArgs),
      receipt.launcherPath,
      ...runtimeArgs,
    ],
  };
}

function writeNewFile(file: string, content: string, mode: number): void {
  try {
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode });
    fs.chmodSync(file, mode);
  } catch {
    fail(`cannot create managed file: ${file}`);
  }
}

function writeNewReceipt(directory: string, receipt: ManagedBrowserReceipt): void {
  const receiptPath = path.join(directory, RECEIPT_FILE);
  const temporaryPath = path.join(directory, `.receipt-${randomBytes(12).toString("hex")}.tmp`);
  writeNewFile(temporaryPath, `${JSON.stringify(receipt)}\n`, 0o600);
  try {
    fs.renameSync(temporaryPath, receiptPath);
  } catch {
    try { fs.unlinkSync(temporaryPath); } catch { /* Preserve the primary failure. */ }
    fail(`cannot publish managed receipt: ${receiptPath}`);
  }
}

function removeOwnedFile(file: string | null, identity: FileIdentity | null = null): void {
  if (file === null) return;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && (identity === null || sameFileIdentity(stat, identity))) {
      fs.unlinkSync(file);
    }
  } catch {
    // Cleanup must never remove a path that changed owner.
  }
}

function linkNoClobber(source: string, destination: string, label: string): void {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") fail(`${label} changed or already exists`);
    if (code === "EXDEV" || code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP") {
      fail(`${label} requires same-directory no-clobber links; refusing unsupported publication`);
    }
    fail(`${label} link failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeActivePointerAtomic(
  packageDir: string,
  pointer: ActiveBrowserPointer,
  previous: ValidatedActiveBrowser | null,
): void {
  const pointerPath = path.join(packageDir, ACTIVE_POINTER_FILE);
  const content = `${JSON.stringify(pointer)}\n`;
  const temporaryPath = path.join(packageDir, `.active-${randomBytes(12).toString("hex")}.tmp`);
  writeNewFile(temporaryPath, content, 0o600);
  const temporaryIdentity = fileIdentity(lstatOrFail(temporaryPath, "active pointer temporary file"));
  let backupPath: string;
  let backupDirectory: string | null = null;
  try {
    if (previous === null) {
      try {
        fs.lstatSync(pointerPath);
        fail("active browser pointer appeared during activation");
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("browser-managed: ")) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("cannot inspect active browser pointer");
      }
      linkNoClobber(temporaryPath, pointerPath, "active browser pointer");
      const pointerIdentity = fileIdentity(lstatOrFail(pointerPath, "active browser pointer"));
      const publishedRaw = readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024);
      if (!publishedRaw.equals(Buffer.from(content))) {
        removeOwnedFile(pointerPath, pointerIdentity);
        fail("active browser pointer readback differs");
      }
      removeOwnedFile(temporaryPath, temporaryIdentity);
      return;
    }

    const current = readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024);
    const currentStat = lstatOrFail(pointerPath, "active browser pointer");
    if (!current.equals(previous.pointerRaw) || !sameFileIdentity(currentStat, previous.pointerIdentity)) {
      fail("active browser pointer changed during activation");
    }

    const backupToken = randomBytes(12).toString("hex");
    backupPath = path.join(packageDir, `.active-backup-${backupToken}.json`);
    writeNewFile(backupPath, previous.pointerRaw.toString("utf8"), 0o600);
    backupDirectory = path.join(packageDir, `.active-backup-${backupToken}`);
    fs.mkdirSync(backupDirectory, { mode: 0o700 });
    lstatOrFail(backupDirectory, "active pointer backup directory");
    const retiredPointerPath = path.join(backupDirectory, "retired-pointer");

    // Retire the actual inode, not a separately re-read pathname. The backup
    // directory is private and remains until publication or rollback is proven.
    fs.renameSync(pointerPath, retiredPointerPath);
    lstatOrFail(retiredPointerPath, "retired active pointer");
    const retiredRaw = readBoundedRegularFile(retiredPointerPath, "retired active pointer", 64 * 1024);
    const movedOwnedPointer =
      sameFileIdentity(lstatOrFail(retiredPointerPath, "retired active pointer"), previous.pointerIdentity) &&
      retiredRaw.equals(previous.pointerRaw);
    if (!movedOwnedPointer) {
      const currentPointer = readOptionalRegularFile(pointerPath, "active browser pointer", 64 * 1024);
      if (currentPointer === null) {
        try {
          linkNoClobber(retiredPointerPath, pointerPath, "foreign active pointer restore");
          const restoredForeign = readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024);
          if (!restoredForeign.equals(retiredRaw)) fail("foreign active pointer restore readback differs");
        } catch (restoreError) {
          throw new Error(
            `${restoreError instanceof Error ? restoreError.message : String(restoreError)}; foreign pointer retained at ${backupDirectory}`,
          );
        }
      }
      throw new Error(`foreign active pointer replaced before retirement; backup retained at ${backupDirectory}`);
    }

    try {
      linkNoClobber(temporaryPath, pointerPath, "active browser pointer");
    } catch (error) {
      const currentPointer = readOptionalRegularFile(pointerPath, "active browser pointer", 64 * 1024);
      if (currentPointer !== null) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; foreign active pointer preserved; backup retained at ${backupDirectory}`,
        );
      }
      const restorePath = path.join(backupDirectory, ".restore-pointer");
      try {
        writeNewFile(restorePath, previous.pointerRaw.toString("utf8"), 0o600);
      } catch (restoreError) {
        throw new Error(
          `${restoreError instanceof Error ? restoreError.message : String(restoreError)}; active pointer rollback incomplete; backup retained at ${backupDirectory}`,
        );
      }
      try {
        linkNoClobber(restorePath, pointerPath, "active browser pointer restore");
        const restoredRaw = readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024);
        if (!restoredRaw.equals(previous.pointerRaw)) fail("active browser pointer restore readback differs");
      } catch (restoreError) {
        throw new Error(
          `${restoreError instanceof Error ? restoreError.message : String(restoreError)}; active pointer rollback incomplete; backup retained at ${backupDirectory}`,
        );
      }
      throw error;
    }

    const publishedRaw = readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024);
    if (!publishedRaw.equals(Buffer.from(content))) {
      try {
        if (!sameFileIdentity(lstatOrFail(pointerPath, "active browser pointer"), temporaryIdentity)) {
          throw new Error("active browser pointer was replaced by a foreign inode");
        }
        fs.unlinkSync(pointerPath);
        linkNoClobber(retiredPointerPath, pointerPath, "active browser pointer restore");
        if (!readBoundedRegularFile(pointerPath, "active browser pointer", 64 * 1024).equals(previous.pointerRaw)) {
          throw new Error("active browser pointer restore readback differs");
        }
      } catch (restoreError) {
        throw new Error(`${restoreError instanceof Error ? restoreError.message : String(restoreError)}; active pointer rollback incomplete; backup retained at ${backupDirectory}`);
      }
      throw new Error("active browser pointer readback differs; previous pointer restored");
    }
    removeOwnedFile(temporaryPath, temporaryIdentity);
  } finally {
    removeOwnedFile(temporaryPath, temporaryIdentity);
  }
}

function sameVerifiedCandidate(
  receipt: ManagedBrowserReceipt,
  prepared: ReturnType<typeof validateStagedInput>,
): boolean {
  return (
    receipt.packageName === prepared.packageName &&
    receipt.version === prepared.release.version &&
    receipt.integrity === prepared.release.integrity &&
    receipt.treeSha256 === prepared.treeSha256 &&
    JSON.stringify(receipt.closure) === JSON.stringify(prepared.closure)
  );
}

/**
 * Promotes a previously verified browser stage into a private Stack-owned
 * release. Validation and hashing happen before any state write; the copied
 * tree and launcher are verified before the strict receipt is published.
 */
export async function activateManagedBrowserTree(
  input: ActivateManagedBrowserTreeInput,
): Promise<ManagedBrowserReceipt> {
  const prepared = validateStagedInput(input);
  const managedRootPath = path.join(prepared.stateDir, MANAGED_ROOT);
  ensureDirectory(prepared.stateDir, "stateDir");
  const managedRoot = ensureDirectory(managedRootPath, "managed browser root");
  const packageDirectory = ensureDirectory(
    path.join(managedRoot, packageDirectoryName(prepared.packageName)),
    "managed browser package root",
  );
  const releaseLock = await acquireLock(path.join(packageDirectory, LOCK_FILE));
  let pendingRoot: string | null = null;
  let pendingIdentity: FileIdentity | null = null;
  let publishedRoot: string | null = null;
  let publishedIdentity: FileIdentity | null = null;
  try {
    const previous = readValidatedActiveBrowser(packageDirectory, prepared.packageName);
    if (previous === null) assertNoOrphanedManagedBrowserState(packageDirectory, true);
    if (previous !== null && sameVerifiedCandidate(previous.receipt, prepared)) return previous.receipt;
    pendingRoot = fs.mkdtempSync(path.join(packageDirectory, ".pending-"));
    fs.chmodSync(pendingRoot, 0o700);
    pendingIdentity = fileIdentity(lstatOrFail(pendingRoot, "pending managed release"));
    const copiedNodeModules = path.join(pendingRoot, "node_modules");
    try {
      fs.cpSync(prepared.nodeModulesPath, copiedNodeModules, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
    } catch (error) {
      fail(`cannot copy staged browser tree: ${error instanceof Error ? error.message : String(error)}`);
    }
    const copiedTreeSha256 = browserTreeSha256(copiedNodeModules, pendingRoot);
    if (copiedTreeSha256 !== prepared.treeSha256) fail("copied managed browser tree digest differs from stage");
    const relativeEntry = path.relative(path.resolve(prepared.nodeModulesPath), path.resolve(prepared.entryPath));
    if (relativeEntry === "" || relativeEntry === ".." || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) {
      fail("entryPath must be contained by staged node_modules");
    }
    const copiedEntry = path.join(copiedNodeModules, relativeEntry);
    const copiedEntryStat = lstatOrFail(copiedEntry, "copied entry");
    if (!copiedEntryStat.isFile() || copiedEntryStat.isSymbolicLink()) fail("copied entry must be a regular file");
    const releaseSuffix = path.basename(pendingRoot).slice(".pending-".length);
    const finalRoot = path.join(packageDirectory, `release-${releaseSuffix}`);
    if (fs.existsSync(finalRoot)) fail("managed browser release path collision");
    const movedReleaseIdentity = pendingIdentity;
    fs.renameSync(pendingRoot, finalRoot);
    pendingRoot = null;
    pendingIdentity = null;
    publishedRoot = finalRoot;
    publishedIdentity = movedReleaseIdentity ?? fileIdentity(lstatOrFail(finalRoot, "published managed release"));
    const finalNodeModules = path.join(finalRoot, "node_modules");
    const finalEntry = path.join(finalNodeModules, relativeEntry);
    const launcherPath = path.join(finalRoot, "launcher.mjs");
    writeNewFile(launcherPath, launcherSource(finalNodeModules, finalEntry, prepared.treeSha256), 0o700);
    const launcherSha256 = hashRegularFile(launcherPath);
    const receipt: ManagedBrowserReceipt = {
      schemaVersion: 1,
      packageName: prepared.packageName,
      version: prepared.release.version,
      integrity: prepared.release.integrity,
      rootPath: finalRoot,
      treePath: finalNodeModules,
      entryPath: finalEntry,
      launcherPath,
      treeSha256: prepared.treeSha256,
      launcherSha256,
      closure: prepared.closure,
    };
    writeNewReceipt(finalRoot, receipt);
    const receiptRaw = readBoundedRegularFile(path.join(finalRoot, RECEIPT_FILE), "managed receipt", 4 * 1024 * 1024);
    const verifiedReceipt = validateReceiptObject(
      parseJsonObject(receiptRaw, "managed receipt"),
      packageDirectory,
      prepared.packageName,
      finalRoot,
    );
    writeActivePointerAtomic(
      packageDirectory,
      {
        schemaVersion: 1,
        packageName: prepared.packageName,
        rootPath: finalRoot,
        receiptSha256: createHash("sha256").update(receiptRaw).digest("hex"),
      },
      previous,
    );
    return verifiedReceipt;
  } catch (error) {
    let safeToRemovePublished = true;
    try {
      const active = readValidatedActiveBrowser(packageDirectory, prepared.packageName);
      safeToRemovePublished = active?.receipt.rootPath !== publishedRoot;
    } catch {
      safeToRemovePublished = false;
    }
    if (safeToRemovePublished) removeOwnedDirectory(publishedRoot, publishedIdentity);
    removeOwnedDirectory(pendingRoot, pendingIdentity);
    throw error;
  } finally {
    releaseLock();
  }
}

/** Restore the prior active release if a later browser smoke or preference write fails. */
export async function rollbackManagedBrowserActivation(
  stateDir: string,
  packageName: ManagedBrowserPackageName,
  activated: ManagedBrowserReceipt,
  previous: ManagedBrowserReceipt | null,
): Promise<void> {
  if (packageName !== "@playwright/cli" && packageName !== "chrome-devtools-mcp") {
    fail("unsupported managed browser package");
  }
  const realStateDir = assertRealDirectory(stateDir, "stateDir");
  const packageDirectory = assertRealDirectory(
    path.join(realStateDir, MANAGED_ROOT, packageDirectoryName(packageName)),
    "managed browser package root",
  );
  const releaseLock = await acquireLock(path.join(packageDirectory, LOCK_FILE));
  try {
    const active = readValidatedActiveBrowser(packageDirectory, packageName);
    if (active === null || JSON.stringify(active.receipt) !== JSON.stringify(activated)) {
      fail("active browser release changed before rollback");
    }
    if (previous?.rootPath === activated.rootPath) return;
    const activatedIdentity = fileIdentity(lstatOrFail(activated.rootPath, "activated browser release"));
    if (previous === null) {
      const currentRaw = readBoundedRegularFile(active.pointerPath, "active browser pointer", 64 * 1024);
      if (!currentRaw.equals(active.pointerRaw)
        || !sameFileIdentity(lstatOrFail(active.pointerPath, "active browser pointer"), active.pointerIdentity)) {
        fail("active browser pointer changed before rollback");
      }
      fs.unlinkSync(active.pointerPath);
      const quarantined = path.join(packageDirectory, `.failed-${randomBytes(12).toString("hex")}`);
      try {
        fs.renameSync(activated.rootPath, quarantined);
      } catch (error) {
        try {
          writeActivePointerAtomic(packageDirectory, {
            schemaVersion: 1,
            packageName,
            rootPath: activated.rootPath,
            receiptSha256: createHash("sha256").update(active.receiptRaw).digest("hex"),
          }, null);
        } catch (restoreError) {
          fail(`first browser rollback incomplete at ${activated.rootPath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        fail(`cannot quarantine failed browser release; candidate pointer restored (${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"})`);
      }
      if (!sameFileIdentity(lstatOrFail(quarantined, "quarantined browser release"), activatedIdentity)) {
        fail(`quarantined browser release changed owner: ${quarantined}`);
      }
      try {
        fs.rmSync(quarantined, { recursive: true, force: false });
      } catch (error) {
        fail(`failed browser release quarantined at ${quarantined}; cleanup failed (${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"})`);
      }
      if (fs.existsSync(quarantined) || readValidatedActiveBrowser(packageDirectory, packageName) !== null) {
        fail(`first browser rollback incomplete at ${quarantined}`);
      }
      return;
    } else {
      if (path.dirname(previous.rootPath) !== packageDirectory) fail("previous browser release escapes managed root");
      const priorRaw = readBoundedRegularFile(path.join(previous.rootPath, RECEIPT_FILE), "previous managed receipt", 4 * 1024 * 1024);
      const prior = validateReceiptObject(parseJsonObject(priorRaw, "previous managed receipt"), packageDirectory, packageName, previous.rootPath);
      if (JSON.stringify(prior) !== JSON.stringify(previous)) fail("previous browser release drifted before rollback");
      writeActivePointerAtomic(packageDirectory, {
        schemaVersion: 1,
        packageName,
        rootPath: previous.rootPath,
        receiptSha256: createHash("sha256").update(priorRaw).digest("hex"),
      }, active);
    }
    const restored = readValidatedActiveBrowser(packageDirectory, packageName);
    if (restored?.receipt.rootPath !== previous.rootPath) {
      fail("active browser rollback readback differs");
    }
    removeOwnedDirectory(activated.rootPath, activatedIdentity);
    if (fs.existsSync(activated.rootPath)) fail(`browser rollback restored pointer but candidate cleanup failed: ${activated.rootPath}`);
  } finally {
    releaseLock();
  }
}
