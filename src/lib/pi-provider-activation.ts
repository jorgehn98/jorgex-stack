import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isNamedPiSource } from "../adapters/pi.js";
import { isCanonicalSha512Integrity, isStableSemverVersion } from "./npm-provider.js";
import {
  assertProviderArtifactProvenance,
  type DerivedProviderArtifactEvidence,
  type DerivedProviderProvenance,
} from "./pi-provider-artifact.js";
import {
  buildPiProviderReceipt,
  piProviderReceiptPath,
  serializePiProviderReceipt,
  verifyPiProviderReceipt,
  type PiProviderReceiptEntry,
} from "./pi-provider-receipt.js";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";

/** The only packages owned by the Stack provider updater. */
const PROVIDER_NAMES = ["gentle-engram", "pi-mcp-adapter"] as const;
const NATIVE_PROVIDER_NAMES = ["gentle-engram"] as const;
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PiProviderPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly packageRoot: string;
  readonly treeSha256: string;
  readonly bins: Readonly<Record<string, string>>;
  /** Registry-origin provenance, or a derived variant under explicit receipt opt-in. */
  readonly provenance?: DerivedProviderArtifactEvidence;
}

export interface ActivatePiProviderPackagesInput {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly stageDir: string;
  readonly packages: readonly PiProviderPackage[];
  /**
   * Transport selector, not authentication: caller MUST derive it from the verified Pi contract.
   */
  readonly mcpTransport?: "native" | "legacy";
  /** Exact bytes read before staging. A changed settings file aborts. */
  readonly settingsJson: string;
  /**
   * Receipt lifecycle selector for the separate provider receipt:
   * - `undefined` preserves the previous behaviour and forbids derived staging;
   * - `null` requires the receipt to be absent and publishes the first one;
   * - `string` is the exact current receipt bytes expected before an update.
   * Any other type fails before effects.
   */
  readonly providerReceiptSnapshot?: string | null;
  /** Runtime readback, normally Pi RPC plus provider/MCP checks. */
  readonly verify: () => void | Promise<void>;
}

export interface ActivatePiProviderPackagesResult {
  readonly ok: true;
  readonly backupDir: string | null;
  readonly changed: boolean;
}

type RecoveryError = Error & { recovery?: "complete" | "incomplete" };
type BinMap = Record<string, string>;
type PackageState = {
  input: PiProviderPackage;
  candidateRoot: string;
  activeRoot: string;
  backupRoot: string;
  existed: boolean;
  previousTreeSha256: string | null;
  manifestSha256: string;
  provenance?: DerivedProviderProvenance;
  phase: "pending" | "backed-up" | "promoted";
};
type ReceiptRollbackState = {
  homeDir: string;
  path: string;
  oldRaw: string | null;
  newRaw: string | null;
  phase: "pending" | "written";
  stateDirCreated: boolean;
};

function resolved(value: string): string {
  return path.resolve(value);
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(resolved(root), resolved(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isContainedOrEqual(child: string, root: string): boolean {
  return resolved(child) === resolved(root) || isStrictChild(child, root);
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? String((error as NodeJS.ErrnoException).code)
    : "UNKNOWN";
}

function incomplete(message: string): never {
  const error = new Error(`pi-provider-activation: ${message}`) as RecoveryError;
  error.recovery = "incomplete";
  throw error;
}

function fail(message: string): never {
  throw new Error(`pi-provider-activation: ${message}`);
}

/** Reject a symlink anywhere in the existing ancestor chain. */
function assertAncestorsClean(target: string, boundary: string, label: string): void {
  const boundaryResolved = resolved(boundary);
  let current = resolved(target);
  if (!isContainedOrEqual(current, boundaryResolved)) {
    fail(`${label} escapes its boundary: ${target}`);
  }
  for (;;) {
    const stat = lstatOrNull(current);
    if (stat !== null && stat.isSymbolicLink()) fail(`${label} ancestor is a symlink: ${current}`);
    if (current === boundaryResolved) return;
    const parent = path.dirname(current);
    if (parent === current || !isContainedOrEqual(parent, boundaryResolved)) {
      fail(`${label} has an unsafe ancestor: ${current}`);
    }
    current = parent;
  }
}

function assertRealDirectory(target: string, boundary: string, label: string): string {
  const value = resolved(target);
  if (!isStrictChild(value, boundary) && value !== resolved(boundary)) {
    fail(`${label} escapes its boundary: ${target}`);
  }
  assertAncestorsClean(value, boundary, label);
  const stat = lstatOrNull(value);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${target}`);
  }
  return value;
}

function assertOptionalRealDirectory(target: string, boundary: string, label: string): boolean {
  const value = resolved(target);
  if (!isStrictChild(value, boundary)) fail(`${label} escapes its boundary: ${target}`);
  assertAncestorsClean(path.dirname(value), boundary, label);
  const stat = lstatOrNull(value);
  if (stat === null) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${target}`);
  return true;
}

function assertRegularFile(target: string, boundary: string, label: string): void {
  const value = resolved(target);
  if (!isStrictChild(value, boundary)) fail(`${label} escapes its boundary: ${target}`);
  assertAncestorsClean(path.dirname(value), boundary, label);
  const stat = lstatOrNull(value);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${target}`);
}

function readBoundedFile(target: string, boundary: string, label: string): Buffer {
  assertRegularFile(target, boundary, label);
  const stat = lstatOrNull(target);
  if (stat === null || stat.size > MAX_MANIFEST_BYTES) fail(`${label} exceeds size bound: ${target}`);
  try {
    return fs.readFileSync(target);
  } catch {
    fail(`cannot read ${label}: ${target}`);
  }
}

function readJsonObject(target: string, boundary: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedFile(target, boundary, label).toString("utf8")) as unknown;
  } catch {
    fail(`malformed ${label}: ${target}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} must be an object: ${target}`);
  }
  return parsed as Record<string, unknown>;
}

function realPathInside(target: string, root: string, label: string): void {
  let actual: string;
  let rootActual: string;
  try {
    actual = fs.realpathSync(target);
    rootActual = fs.realpathSync(root);
  } catch {
    fail(`${label} cannot be resolved safely: ${target}`);
  }
  if (!isStrictChild(actual, rootActual)) fail(`${label} escapes its stage root: ${target}`);
}

function normalizeBins(raw: unknown, packageName: string, label: string): BinMap {
  if (typeof raw === "string") {
    if (raw === "") fail(`${label} has an empty bin target`);
    return { [packageName]: raw };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${label} must declare a bin map`);
  }
  const out: BinMap = {};
  for (const [name, target] of Object.entries(raw as Record<string, unknown>)) {
    if (name === "" || name.includes("/") || name.includes("\\") || typeof target !== "string" || target === "") {
      fail(`${label} has an invalid bin declaration`);
    }
    out[name] = target;
  }
  return out;
}

function sortedMap(map: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
}

function validateBinTarget(packageRoot: string, target: string, label: string): string {
  if (path.isAbsolute(target)) fail(`${label} must be relative: ${target}`);
  const lexical = resolved(path.join(packageRoot, target));
  if (!isStrictChild(lexical, packageRoot)) fail(`${label} escapes its package root: ${target}`);
  assertAncestorsClean(path.dirname(lexical), packageRoot, label);
  const stat = lstatOrNull(lexical);
  if (stat === null) fail(`${label} does not exist: ${target}`);
  let actual: string;
  try {
    actual = fs.realpathSync(lexical);
  } catch {
    fail(`${label} cannot be resolved: ${target}`);
  }
  if (!isStrictChild(actual, resolved(packageRoot))) fail(`${label} escapes its package root: ${target}`);
  let finalStat: fs.Stats;
  try {
    finalStat = fs.statSync(lexical);
  } catch {
    fail(`${label} cannot be stat'ed: ${target}`);
  }
  if (!finalStat.isFile()) {
    fail(`${label} must point to a file: ${target}`);
  }
  return lexical;
}

function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = (entry as Record<string, unknown>).source;
  return typeof source === "string" ? source : null;
}

function canonicalProviderSource(source: string, packageName: string): boolean {
  return isNamedPiSource(source, packageName);
}

function claimsAdapterSource(source: string): boolean {
  // Unsafe selectors still claim the protected name even though canonical matching rejects them.
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

function parseAndPlanSettings(
  settingsJson: string,
  packages: readonly PiProviderPackage[],
  rejectAdapterClaim: boolean,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson) as unknown;
  } catch {
    fail("settings.json is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("settings.json root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.packages)) fail("settings.json packages must be an array");
  const entries = root.packages as unknown[];
  const planned = entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail("settings.json contains an entry without a canonical source");
    }
    const source = packageSource(entry);
    if (source === null) fail("settings.json contains an entry without a canonical source");
    return entry;
  });
  if (rejectAdapterClaim) {
    for (const entry of planned) {
      const source = packageSource(entry);
      if (source !== null && claimsAdapterSource(source)) {
        fail("settings.json registers the protected pi-mcp-adapter source; manual resolution is required");
      }
    }
  }
  for (const provider of packages) {
    const matches = planned
      .map((entry, index) => ({ entry, index, source: packageSource(entry) }))
      .filter((value) => value.source !== null && canonicalProviderSource(value.source, provider.name));
    if (matches.length !== 1) {
      fail(`settings.json must contain exactly one canonical source for ${provider.name}`);
    }
    const match = matches[0];
    if (match === undefined) fail(`settings.json source missing for ${provider.name}`);
    const nextSource = `npm:${provider.name}@${provider.version}`;
    if (typeof match.entry === "string") {
      planned[match.index] = nextSource;
    } else {
      // Preserve all provider filters and user fields; only source is owned.
      (match.entry as Record<string, unknown>).source = nextSource;
    }
  }
  root.packages = planned;
  return JSON.stringify(root);
}

function validateSettingsFile(settingsPath: string, agentDir: string, expected: string): void {
  assertRegularFile(settingsPath, agentDir, "settings.json");
  let current: string;
  try {
    current = fs.readFileSync(settingsPath, "utf8");
  } catch {
    fail(`cannot read settings.json: ${settingsPath}`);
  }
  if (current !== expected) fail("settings.json changed since staging; refusing activation");
}

function validatePackageInput(provider: PiProviderPackage, expectedName: string): void {
  if (provider.name !== expectedName) fail(`unexpected provider package: ${provider.name}`);
  if (!isStableSemverVersion(provider.version)) fail(`invalid provider version: ${provider.version}`);
  if (!isCanonicalSha512Integrity(provider.integrity)) fail(`invalid provider integrity: ${provider.name}`);
  if (!SHA256.test(provider.treeSha256)) fail(`invalid provider tree hash: ${provider.name}`);
  if (provider.bins === null || typeof provider.bins !== "object" || Array.isArray(provider.bins)) {
    fail(`provider bins must be a map: ${provider.name}`);
  }
}

/**
 * A staged derived artifact may only be activated under an explicit receipt
 * opt-in (`providerReceiptSnapshot` present). This runs before any managed
 * root, lock, marker, backup or promotion is touched. Registry-origin
 * provenance is the already-corrected official artifact and stays allowed;
 * malformed origins are rejected rather than silently ignored.
 */
function assertProviderProvenance(provider: PiProviderPackage, receiptOptIn: boolean): void {
  const provenance: unknown = provider.provenance;
  if (provenance === undefined) return;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    fail("unknown provider provenance origin: malformed provenance");
  }
  const origin = (provenance as { readonly origin?: unknown }).origin;
  if (origin === "derived" && !receiptOptIn) fail("derived requires transactional receipt");
  if (origin !== "registry" && origin !== "derived") fail(`unknown provider provenance origin: ${String(origin)}`);
}

type CandidateEvidence = { bins: BinMap; manifestSha256: string; provenance?: DerivedProviderProvenance };

function validateCandidate(provider: PiProviderPackage, stageDir: string): CandidateEvidence {
  const candidateRoot = resolved(provider.packageRoot);
  const expectedRoot = path.join(stageDir, provider.name, "pi-agent", "npm", "node_modules", provider.name);
  if (candidateRoot !== resolved(expectedRoot)) fail(`candidate root is not the direct staged provider root: ${provider.name}`);
  assertRealDirectory(candidateRoot, stageDir, `candidate ${provider.name}`);
  realPathInside(candidateRoot, stageDir, `candidate ${provider.name}`);
  const manifestPath = path.join(candidateRoot, "package.json");
  const manifest = readJsonObject(manifestPath, candidateRoot, `${provider.name} package.json`);
  if (manifest.name !== provider.name || manifest.version !== provider.version) {
    fail(`candidate metadata does not match ${provider.name}`);
  }
  const manifestSha256 = crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
  const manifestBins = normalizeBins(manifest.bin, provider.name, `${provider.name} candidate bins`);
  if (sortedMap(manifestBins) !== sortedMap(provider.bins)) {
    fail(`candidate bin map does not match metadata: ${provider.name}`);
  }
  for (const target of Object.values(manifestBins)) validateBinTarget(candidateRoot, target, `${provider.name} candidate bin`);
  let actualTree: string;
  try {
    actualTree = inventoryTreeSha256(candidateRoot);
  } catch (error) {
    fail(`candidate tree is unsafe: ${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actualTree !== provider.treeSha256) fail(`candidate tree hash changed: ${provider.name}`);
  let provenance: DerivedProviderProvenance | undefined;
  if (provider.provenance !== undefined) {
    provenance = assertProviderArtifactProvenance(provider.provenance);
    if (provenance.packageName !== provider.name || provenance.version !== provider.version) {
      fail(`candidate provenance identity does not match ${provider.name}`);
    }
    if (provenance.original.integrity !== provider.integrity) {
      fail(`candidate provenance integrity does not match ${provider.name}`);
    }
    const expectedManifest = provenance.origin === "derived"
      ? provenance.derived.manifestSha256
      : provenance.original.manifestSha256;
    if (manifestSha256 !== expectedManifest) {
      fail(`candidate manifest bytes do not match the selected provenance: ${provider.name}`);
    }
  }
  return provenance === undefined
    ? { bins: manifestBins, manifestSha256 }
    : { bins: manifestBins, manifestSha256, provenance };
}

function validateExistingPackage(activeRoot: string, agentDir: string, provider: PiProviderPackage, candidateBins: BinMap, modules: string): string | null {
  const stat = lstatOrNull(activeRoot);
  if (stat === null) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`existing provider root is not a real directory: ${provider.name}`);
  const manifest = readJsonObject(path.join(activeRoot, "package.json"), activeRoot, `${provider.name} existing package.json`);
  if (manifest.name !== provider.name || typeof manifest.version !== "string" || manifest.version === "") {
    fail(`existing provider metadata is not owned: ${provider.name}`);
  }
  const existingBins = normalizeBins(manifest.bin, provider.name, `${provider.name} existing bins`);
  if (sortedMap(existingBins) !== sortedMap(candidateBins)) {
    fail(`provider bin layout changed for ${provider.name}; manual migration required`);
  }
  for (const target of Object.values(existingBins)) validateBinTarget(activeRoot, target, `${provider.name} existing bin`);
  const existingTree = inventoryTreeSha256(activeRoot);

  // Existing npm wrappers belong to the provider only when they already point
  // at this package. They are never created or overwritten by this updater.
  const binDir = path.join(modules, ".bin");
  if (lstatOrNull(binDir) !== null) assertRealDirectory(binDir, modules, "npm .bin");
  for (const [binName, target] of Object.entries(existingBins)) {
    const wrapper = path.join(binDir, binName);
    const wrapperStat = lstatOrNull(wrapper);
    if (wrapperStat === null || !wrapperStat.isSymbolicLink()) continue;
    let raw: string;
    try {
      raw = fs.readlinkSync(wrapper);
    } catch {
      fail(`provider bin wrapper is unreadable: ${wrapper}`);
    }
    const expected = resolved(path.join(activeRoot, target));
    const actual = resolved(path.join(path.dirname(wrapper), raw));
    if (actual !== expected) fail(`provider bin wrapper points elsewhere: ${wrapper}`);
  }
  return existingTree;
}

function atomicWrite(target: string, content: string, boundary: string): void {
  assertAncestorsClean(path.dirname(target), boundary, "atomic target");
  const dir = path.dirname(target);
  const temporary = path.join(dir, `.jorgex-provider-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (lstatOrNull(temporary) !== null) fs.rmSync(temporary, { force: true });
  }
}

function sameRegularFile(target: string, expected: string, boundary: string): boolean {
  const stat = lstatOrNull(target);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return false;
  try {
    return fs.readFileSync(target, "utf8") === expected;
  } catch {
    return false;
  }
}

function readReceiptBytesOrNull(homeDir: string, receiptPath: string): string | null {
  assertAncestorsClean(path.dirname(receiptPath), homeDir, "provider receipt");
  // Absence is ENOENT only: a real I/O error must never read as "no receipt".
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(receiptPath, { throwIfNoEntry: false });
  } catch (error) {
    fail(`cannot inspect provider receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat === undefined) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) fail("provider receipt must be a regular file");
  try {
    return fs.readFileSync(receiptPath, "utf8");
  } catch {
    fail("cannot read provider receipt");
  }
}

function ensureStateDir(homeDir: string): boolean {
  const stateDir = path.dirname(piProviderReceiptPath(homeDir));
  const stat = lstatOrNull(stateDir);
  if (stat !== null) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("provider state directory is unsafe");
    return false;
  }
  assertAncestorsClean(path.dirname(stateDir), homeDir, "provider state directory");
  fs.mkdirSync(stateDir, { recursive: false, mode: 0o700 });
  return true;
}

function stateToReceiptEntry(state: PackageState): PiProviderReceiptEntry {
  const provider = state.input;
  return {
    name: provider.name,
    version: provider.version,
    source: `npm:${provider.name}@${provider.version}`,
    packageRoot: `npm/node_modules/${provider.name}`,
    integrity: provider.integrity,
    treeSha256: provider.treeSha256,
    manifestSha256: state.manifestSha256,
    bins: provider.bins,
    ...(state.provenance === undefined ? {} : { provenance: state.provenance }),
  };
}

function validateReceiptRollback(state: ReceiptRollbackState): void {
  if (state.newRaw === null) return;
  let current: string | null;
  try {
    current = readReceiptBytesOrNull(state.homeDir, state.path);
  } catch {
    incomplete("provider receipt is unreadable during provider rollback");
  }
  if (state.phase === "written") {
    if (current !== state.newRaw) incomplete("provider receipt drifted during provider rollback");
    return;
  }
  if (current !== state.oldRaw) incomplete("provider receipt changed before rollback");
}

function restoreReceipt(state: ReceiptRollbackState): void {
  if (state.newRaw === null || state.phase !== "written") return;
  if (state.oldRaw !== null) {
    atomicWrite(state.path, state.oldRaw, state.homeDir);
    if (!sameRegularFile(state.path, state.oldRaw, state.homeDir)) {
      incomplete("provider receipt restore readback failed");
    }
    return;
  }
  fs.unlinkSync(state.path);
  if (state.stateDirCreated) {
    try {
      fs.rmdirSync(path.dirname(state.path));
    } catch {
      // Foreign contents keep the directory; only an empty own directory is removed.
    }
  }
}

function markRecovery(error: unknown, state: "complete" | "incomplete"): RecoveryError {
  const result = error instanceof Error ? error as RecoveryError : new Error(String(error)) as RecoveryError;
  result.recovery = state;
  return result;
}

function ensureTransactionFile(pathname: string, expected: string): void {
  const stat = lstatOrNull(pathname);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) incomplete(`transaction state drifted: ${pathname}`);
  let current: string;
  try { current = fs.readFileSync(pathname, "utf8"); } catch { incomplete(`transaction state unreadable: ${pathname}`); }
  if (current !== expected) incomplete(`transaction state drifted: ${pathname}`);
}

function removeTransactionState(lockPath: string, lockContent: string, markerPath: string, markerContent: string): void {
  assertAncestorsClean(path.dirname(lockPath), path.dirname(path.dirname(lockPath)), "transaction state");
  ensureTransactionFile(lockPath, lockContent);
  ensureTransactionFile(markerPath, markerContent);
  // Remove the lock first. If marker cleanup fails, the marker remains as
  // durable evidence and blocks an unsafe retry.
  fs.unlinkSync(lockPath);
  fs.unlinkSync(markerPath);
}

function verifyPromotedPackage(state: PackageState): void {
  const stat = lstatOrNull(state.activeRoot);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) fail(`promoted provider root missing: ${state.input.name}`);
  const manifest = readJsonObject(path.join(state.activeRoot, "package.json"), state.activeRoot, `${state.input.name} active package.json`);
  if (manifest.name !== state.input.name || manifest.version !== state.input.version) {
    fail(`promoted provider metadata mismatch: ${state.input.name}`);
  }
  let tree: string;
  try { tree = inventoryTreeSha256(state.activeRoot); } catch { fail(`promoted provider tree unreadable: ${state.input.name}`); }
  if (tree !== state.input.treeSha256) fail(`promoted provider tree drifted: ${state.input.name}`);
}

function verifyPreviousPackageBeforeRename(state: PackageState, agentDir: string): void {
  const stat = lstatOrNull(state.activeRoot);
  if (!state.existed) {
    if (stat !== null) fail(`unowned provider root appeared before promotion: ${state.input.name}`);
    return;
  }
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`existing provider root drifted before promotion: ${state.input.name}`);
  }
  assertAncestorsClean(state.activeRoot, agentDir, `existing ${state.input.name}`);
  const manifest = readJsonObject(path.join(state.activeRoot, "package.json"), state.activeRoot, `${state.input.name} existing package.json`);
  if (manifest.name !== state.input.name || typeof manifest.version !== "string" || manifest.version === "") {
    fail(`existing provider metadata drifted before promotion: ${state.input.name}`);
  }
  let currentTree: string;
  try {
    currentTree = inventoryTreeSha256(state.activeRoot);
  } catch {
    fail(`existing provider tree became unreadable before promotion: ${state.input.name}`);
  }
  if (currentTree !== state.previousTreeSha256) {
    fail(`existing provider changed before promotion: ${state.input.name}`);
  }
}

function verifyBackup(state: PackageState): void {
  if (!state.existed) return;
  const stat = lstatOrNull(state.backupRoot);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) incomplete(`provider backup drifted: ${state.input.name}`);
  if (state.previousTreeSha256 === null) incomplete(`provider backup hash missing: ${state.input.name}`);
  let tree: string;
  try { tree = inventoryTreeSha256(state.backupRoot); } catch { incomplete(`provider backup unreadable: ${state.input.name}`); }
  if (tree !== state.previousTreeSha256) incomplete(`provider backup bytes drifted: ${state.input.name}`);
}

function restoreState(
  states: readonly PackageState[],
  settingsPath: string,
  oldSettings: string,
  nextSettings: string,
  agentDir: string,
  lockPath: string,
  lockContent: string,
  markerPath: string,
  markerContent: string,
  backupDir: string,
  stageDir: string,
  receipt: ReceiptRollbackState,
): void {
  ensureTransactionFile(lockPath, lockContent);
  ensureTransactionFile(markerPath, markerContent);
  if (!sameRegularFile(settingsPath, nextSettings, agentDir) && !sameRegularFile(settingsPath, oldSettings, agentDir)) incomplete("settings drifted during provider rollback");
  const backupSettings = path.join(backupDir, "settings.json");
  assertRegularFile(backupSettings, backupDir, "provider settings backup");
  if (fs.readFileSync(backupSettings, "utf8") !== oldSettings) incomplete("provider settings backup drifted");
  validateReceiptRollback(receipt);
  for (const state of states) {
    assertAncestorsClean(path.dirname(state.activeRoot), agentDir, `active ${state.input.name}`);
    if (state.phase === "pending") {
      verifyPreviousPackageBeforeRename(state, agentDir);
      continue;
    }
    assertAncestorsClean(path.dirname(state.backupRoot), backupDir, `provider backup ${state.input.name}`);
    verifyBackup(state);
    if (state.phase === "promoted") {
      verifyPromotedPackage(state);
      assertAncestorsClean(path.dirname(state.candidateRoot), stageDir, `candidate ${state.input.name}`);
      if (lstatOrNull(state.candidateRoot) !== null) incomplete(`candidate stage root was replaced: ${state.input.name}`);
    } else if (lstatOrNull(state.activeRoot) !== null) {
      incomplete(`provider root appeared after backup: ${state.input.name}`);
    }
  }
  for (const state of [...states].reverse()) {
    if (state.phase === "pending") continue;
    if (state.phase === "promoted") fs.renameSync(state.activeRoot, state.candidateRoot);
    if (state.existed) fs.renameSync(state.backupRoot, state.activeRoot);
  }
  atomicWrite(settingsPath, oldSettings, agentDir);
  restoreReceipt(receipt);
  for (const state of states) verifyPreviousPackageBeforeRename(state, agentDir);
  removeTransactionState(lockPath, lockContent, markerPath, markerContent);
}

export async function activatePiProviderPackages(
  input: ActivatePiProviderPackagesInput,
): Promise<ActivatePiProviderPackagesResult> {
  const homeDir = assertRealDirectory(input.homeDir, resolved(input.homeDir), "homeDir");
  const agentDir = assertRealDirectory(input.agentDir, homeDir, "agentDir");
  const stageDir = assertRealDirectory(input.stageDir, homeDir, "stageDir");
  if (!isStrictChild(stageDir, homeDir)) fail("stageDir must be a strict child of homeDir");
  const receiptSnapshot = (input as { readonly providerReceiptSnapshot?: unknown }).providerReceiptSnapshot;
  if (receiptSnapshot !== undefined && receiptSnapshot !== null && typeof receiptSnapshot !== "string") {
    fail("providerReceiptSnapshot must be a string or null when present");
  }
  const receiptMode: "legacy" | "absent" | "exact" = receiptSnapshot === undefined
    ? "legacy"
    : receiptSnapshot === null
      ? "absent"
      : "exact";
  const receiptPath = piProviderReceiptPath(homeDir);
  const transport = input.mcpTransport;
  if (transport !== undefined && transport !== "native" && transport !== "legacy") {
    fail("unknown provider activation transport");
  }
  const native = transport === "native";
  const selectedNames: readonly string[] = native ? NATIVE_PROVIDER_NAMES : PROVIDER_NAMES;
  if (!Array.isArray(input.packages) || input.packages.length !== selectedNames.length) {
    fail(native
      ? "native activation requires exactly the gentle-engram provider package"
      : "exactly the two owned provider packages are required");
  }
  const byName = new Map(input.packages.map((provider) => [provider.name, provider]));
  if (byName.size !== selectedNames.length) fail("provider packages must not be duplicated");
  if (native && !byName.has("gentle-engram")) {
    fail("native activation requires the gentle-engram provider package");
  }
  for (const provider of input.packages) assertProviderProvenance(provider, receiptMode !== "legacy");
  const settingsPath = path.join(agentDir, "settings.json");
  validateSettingsFile(settingsPath, agentDir, input.settingsJson);
  const nextSettings = parseAndPlanSettings(input.settingsJson, selectedNames.map((name) => {
    const provider = byName.get(name);
    if (provider === undefined) fail(`missing provider package: ${name}`);
    return provider;
  }), native);

  // Strict prior receipt verification against the current active roots and
  // settings, before any managed root, lock or backup is created. `undefined`
  // keeps the previous contract only while no managed receipt exists; once one
  // is present the caller must acknowledge it with an explicit snapshot.
  let oldReceiptRaw: string | null = null;
  {
    const prior = verifyPiProviderReceipt({ homeDir, agentDir });
    if (receiptMode === "legacy") {
      if (prior.kind !== "absent") {
        fail("managed provider receipt exists; providerReceiptSnapshot is required");
      }
    } else {
      oldReceiptRaw = readReceiptBytesOrNull(homeDir, receiptPath);
      if (receiptMode === "absent") {
        if (prior.kind !== "absent") fail("provider receipt already exists; expected absence");
      } else if (prior.kind === "absent" || oldReceiptRaw !== receiptSnapshot) {
        fail("provider receipt changed since staging; refusing activation");
      }
    }
  }

  const npmDir = path.join(agentDir, "npm");
  const modules = path.join(npmDir, "node_modules");
  assertRealDirectory(npmDir, agentDir, "npm root");
  assertRealDirectory(modules, npmDir, "node_modules");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  assertOptionalRealDirectory(managedRoot, npmDir, "managed root");
  if (lstatOrNull(managedRoot) === null) {
    assertAncestorsClean(path.dirname(managedRoot), agentDir, "managed root");
    fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  }
  const lockPath = path.join(managedRoot, "transaction.lock");
  const markerPath = path.join(managedRoot, "active-transaction.json");
  if (lstatOrNull(lockPath) !== null) fail(`transaction lock busy: ${lockPath}`);
  if (lstatOrNull(markerPath) !== null) fail(`active transaction pending: ${markerPath}`);

  const states: PackageState[] = [];
  for (const name of selectedNames) {
    const provider = byName.get(name);
    if (provider === undefined) fail(`missing provider package: ${name}`);
    validatePackageInput(provider, name);
    const candidate = validateCandidate(provider, stageDir);
    const activeRoot = path.join(modules, name);
    assertAncestorsClean(activeRoot, agentDir, `active ${name}`);
    const previousTreeSha256 = validateExistingPackage(activeRoot, agentDir, provider, candidate.bins, modules);
    states.push({
      input: provider,
      candidateRoot: resolved(provider.packageRoot),
      activeRoot,
      backupRoot: "",
      existed: previousTreeSha256 !== null,
      previousTreeSha256,
      manifestSha256: candidate.manifestSha256,
      ...(candidate.provenance === undefined ? {} : { provenance: candidate.provenance }),
      phase: "pending",
    });
  }
  const nextReceipt = receiptMode === "legacy" ? null : serializePiProviderReceipt(buildPiProviderReceipt({
    agentDir,
    mcpTransport: native ? "native" : "legacy",
    providers: states.map(stateToReceiptEntry),
  }));
  const backupDir = path.join(stageDir, `.provider-activation-${crypto.randomBytes(16).toString("hex")}`);
  const backupProviders = path.join(backupDir, "providers");
  if (!isStrictChild(backupDir, stageDir)) fail("provider backup escaped stage root");
  const lockContent = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), backupDir })}\n`;
  const markerContent = `${JSON.stringify({ phase: "provider-activation", backupDir, packages: selectedNames, pid: process.pid }, null, 2)}\n`;
  const receiptRollback: ReceiptRollbackState = {
    homeDir,
    path: receiptPath,
    oldRaw: oldReceiptRaw,
    newRaw: nextReceipt,
    phase: "pending",
    stateDirCreated: false,
  };
  let lockAcquired = false;
  let markerCreated = false;
  let backupCreated = false;
  try {
    fs.writeFileSync(lockPath, lockContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
    lockAcquired = true;
    // Re-read after obtaining the lock: a native Pi process may have updated
    // settings between the initial preflight and transaction acquisition.
    validateSettingsFile(settingsPath, agentDir, input.settingsJson);
    if (receiptMode === "legacy") {
      const locked = verifyPiProviderReceipt({ homeDir, agentDir });
      if (locked.kind !== "absent") fail("managed provider receipt appeared while acquiring the transaction lock");
    } else {
      const locked = verifyPiProviderReceipt({ homeDir, agentDir });
      const lockedRaw = readReceiptBytesOrNull(homeDir, receiptPath);
      if (receiptMode === "absent") {
        if (locked.kind !== "absent") fail("provider receipt appeared while acquiring the transaction lock");
      } else if (locked.kind === "absent" || lockedRaw !== receiptSnapshot) {
        fail("provider receipt changed while acquiring the transaction lock");
      }
    }
    const unchanged = JSON.stringify(JSON.parse(input.settingsJson)) === nextSettings
      && states.every((state) => state.previousTreeSha256 === state.input.treeSha256)
      && (nextReceipt === null || oldReceiptRaw === nextReceipt);
    if (unchanged) {
      await input.verify();
      validateSettingsFile(settingsPath, agentDir, input.settingsJson);
      for (const state of states) verifyPreviousPackageBeforeRename(state, agentDir);
      if (nextReceipt !== null) {
        const after = verifyPiProviderReceipt({ homeDir, agentDir });
        if (after.kind === "absent" || readReceiptBytesOrNull(homeDir, receiptPath) !== nextReceipt) {
          fail("provider receipt drifted during the no-op verification");
        }
      }
      ensureTransactionFile(lockPath, lockContent);
      fs.unlinkSync(lockPath);
      lockAcquired = false;
      return { ok: true, changed: false, backupDir: null };
    }
    fs.writeFileSync(markerPath, markerContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
    markerCreated = true;
    fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
    backupCreated = true;
    fs.mkdirSync(backupProviders, { recursive: false, mode: 0o700 });
    for (const state of states) {
      state.backupRoot = path.join(backupProviders, state.input.name);
    }
    fs.writeFileSync(path.join(backupDir, "settings.json"), input.settingsJson, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(backupDir, "manifest.json"), `${JSON.stringify({ receiptExisted: oldReceiptRaw !== null, packages: states.map((state) => ({ name: state.input.name, existed: state.existed, treeSha256: state.previousTreeSha256 })) }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (oldReceiptRaw !== null) {
      fs.writeFileSync(path.join(backupDir, "provider-receipt.json"), oldReceiptRaw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    for (const state of states) {
      // Hash once more immediately before moving the candidate. This catches
      // a stage writer that changed the verified tree after preflight.
      const currentCandidateTree = inventoryTreeSha256(state.candidateRoot);
      if (currentCandidateTree !== state.input.treeSha256) fail(`candidate tree changed before promotion: ${state.input.name}`);
      assertAncestorsClean(path.dirname(state.candidateRoot), stageDir, `candidate ${state.input.name}`);
      assertAncestorsClean(path.dirname(state.activeRoot), agentDir, `active ${state.input.name}`);
      verifyPreviousPackageBeforeRename(state, agentDir);
      if (state.existed) {
        fs.renameSync(state.activeRoot, state.backupRoot);
        state.phase = "backed-up";
      }
      fs.renameSync(state.candidateRoot, state.activeRoot);
      state.phase = "promoted";
    }
    for (const state of states) verifyPromotedPackage(state);
    atomicWrite(settingsPath, nextSettings, agentDir);
    if (!sameRegularFile(settingsPath, nextSettings, agentDir)) fail("settings readback failed after provider promotion");
    if (nextReceipt !== null) {
      receiptRollback.stateDirCreated = ensureStateDir(homeDir);
      atomicWrite(receiptPath, nextReceipt, homeDir);
      receiptRollback.phase = "written";
      if (!sameRegularFile(receiptPath, nextReceipt, homeDir)) fail("provider receipt readback failed after promotion");
    }
    await input.verify();
    for (const state of states) verifyPromotedPackage(state);
    if (!sameRegularFile(settingsPath, nextSettings, agentDir)) fail("settings drifted after provider verification");
    if (nextReceipt !== null) {
      if (!sameRegularFile(receiptPath, nextReceipt, homeDir)) fail("provider receipt drifted after provider verification");
      const verified = verifyPiProviderReceipt({ homeDir, agentDir });
      if (verified.kind === "absent") fail("provider receipt is missing after promotion");
    }
    removeTransactionState(lockPath, lockContent, markerPath, markerContent);
    return { ok: true, changed: true, backupDir };
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    if (!lockAcquired || !markerCreated || !backupCreated) {
      try {
        if (markerCreated) ensureTransactionFile(markerPath, markerContent);
        if (markerCreated) fs.unlinkSync(markerPath);
        if (lockAcquired) ensureTransactionFile(lockPath, lockContent);
        if (lockAcquired) fs.unlinkSync(lockPath);
      } catch {
        incomplete(`activation failed before promotion and transaction cleanup was unsafe: ${original.message}`);
      }
      throw original;
    }
    try {
      await Promise.resolve();
      restoreState(states, settingsPath, input.settingsJson, nextSettings, agentDir, lockPath, lockContent, markerPath, markerContent, backupDir, stageDir, receiptRollback);
    } catch (rollbackError) {
      const reason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      incomplete(`rollback incomplete; retaining provider backup and transaction marker: ${reason}; original: ${original.message}`);
    }
    throw markRecovery(original, "complete");
  }
}
