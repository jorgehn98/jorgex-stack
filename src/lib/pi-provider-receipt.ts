import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isNamedPiSource } from "../adapters/pi.js";
import { isCanonicalSha512Integrity, isStableSemverVersion } from "./npm-provider.js";
import { assertProviderArtifactProvenance, type DerivedProviderProvenance } from "./pi-provider-artifact.js";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";

const STATE_DIR_NAME = ".jorgex-stack";
const RECEIPT_FILE_NAME = "pi-provider-receipt.json";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE_PROVIDER_NAMES = ["gentle-engram"] as const;
const LEGACY_PROVIDER_NAMES = ["gentle-engram", "pi-mcp-adapter"] as const;

export interface PiProviderReceiptEntry {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly packageRoot: string;
  readonly integrity: string;
  readonly treeSha256: string;
  readonly bins: Readonly<Record<string, string>>;
  readonly manifestSha256: string;
  readonly provenance?: DerivedProviderProvenance;
}

export interface PiProviderReceipt {
  readonly schemaVersion: 1;
  readonly agentDir: string;
  readonly mcpTransport: "native" | "legacy";
  readonly providers: readonly PiProviderReceiptEntry[];
}

export interface BuildPiProviderReceiptInput {
  readonly agentDir: string;
  readonly mcpTransport: "native" | "legacy";
  readonly providers: readonly PiProviderReceiptEntry[];
}

export type PiProviderReceiptKind = "absent" | "registry" | "derived";

export interface PiProviderReceiptVerification {
  readonly kind: PiProviderReceiptKind;
  readonly receipt: PiProviderReceipt | null;
}

function fail(message: string): never {
  throw new Error(`pi-provider-receipt: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absence is ENOENT only; any other errno fails the module explicitly. */
function lstatOrNull(target: string): fs.Stats | null {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target, { throwIfNoEntry: false });
  } catch (error) {
    fail(`cannot stat ${target}: ${errorMessage(error)}`);
  }
  return stat ?? null;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isStrictChild(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isContainedOrEqual(child: string, root: string): boolean {
  return path.resolve(child) === path.resolve(root) || isStrictChild(child, root);
}

/**
 * Bounded ancestor semantics shared with provider activation: every existing
 * component between the boundary and the target must be a real directory, so a
 * symlinked `agent`/`npm`/state ancestor is rejected even when the final root
 * metadata would otherwise match.
 */
function assertAncestorsClean(target: string, boundary: string, label: string): void {
  const boundaryResolved = path.resolve(boundary);
  let current = path.resolve(target);
  if (!isContainedOrEqual(current, boundaryResolved)) fail(`${label} escapes its boundary: ${target}`);
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

function expectedProviderNames(transport: "native" | "legacy"): readonly string[] {
  return transport === "native" ? NATIVE_PROVIDER_NAMES : LEGACY_PROVIDER_NAMES;
}

function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = (entry as Record<string, unknown>).source;
  return typeof source === "string" ? source : null;
}

function normalizeBins(raw: unknown, name: string): Record<string, string> {
  if (typeof raw === "string") {
    if (raw === "") fail(`receipt ${name} has an empty bin target`);
    return { [name]: raw };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`receipt ${name} must declare a bin map`);
  }
  const out: Record<string, string> = {};
  for (const [binName, target] of Object.entries(raw as Record<string, unknown>)) {
    if (binName === "" || binName.includes("/") || binName.includes("\\") || typeof target !== "string" || target === "") {
      fail(`receipt ${name} has an invalid bin declaration`);
    }
    out[binName] = target;
  }
  if (Object.keys(out).length === 0) fail(`receipt ${name} must declare at least one bin`);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedMap(map: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
}

function assertHexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is not a canonical hex digest`);
  return value;
}

function parseEntry(value: unknown, transport: "native" | "legacy"): PiProviderReceiptEntry {
  if (!isRecord(value)) fail("provider receipt entry must be an object");
  const name = value.name;
  if (name !== "gentle-engram" && name !== "pi-mcp-adapter") fail(`unknown provider in receipt: ${String(name)}`);
  const allowed = expectedProviderNames(transport);
  if (!allowed.includes(name)) fail(`provider receipt entry is not part of the ${transport} transport`);
  if (!isStableSemverVersion(value.version)) fail(`provider receipt entry version is invalid: ${String(name)}`);
  const version = value.version;
  const source = value.source;
  if (typeof source !== "string" || !isNamedPiSource(source, name) || source !== `npm:${name}@${version}`) {
    fail(`provider receipt entry source is not canonical: ${String(name)}`);
  }
  if (value.packageRoot !== `npm/node_modules/${name}`) fail(`provider receipt entry packageRoot is not canonical: ${String(name)}`);
  if (!isCanonicalSha512Integrity(value.integrity)) fail(`provider receipt entry integrity is not canonical sha512: ${String(name)}`);
  const treeSha256 = assertHexDigest(value.treeSha256, `provider receipt entry treeSha256 (${name})`);
  const manifestSha256 = assertHexDigest(value.manifestSha256, `provider receipt entry manifestSha256 (${name})`);
  const bins = normalizeBins(value.bins, name);
  let provenance: DerivedProviderProvenance | undefined;
  if (value.provenance !== undefined) {
    provenance = assertProviderArtifactProvenance(value.provenance);
    const rawDerived = isRecord(value.provenance) ? value.provenance.derived : undefined;
    if (isRecord(rawDerived) && rawDerived.path !== undefined) {
      fail(`provider receipt provenance must not persist a stage path: ${name}`);
    }
    if (provenance.packageName !== name || provenance.version !== version) {
      fail(`provider receipt provenance does not match its entry: ${name}`);
    }
    if (provenance.original.integrity !== value.integrity) {
      fail(`provider receipt provenance integrity does not match its entry: ${name}`);
    }
    const effective = provenance.origin === "derived" ? provenance.derived.manifestSha256 : provenance.original.manifestSha256;
    if (effective !== manifestSha256) fail(`provider receipt provenance manifest does not match its entry: ${name}`);
  }
  return {
    name,
    version,
    source,
    packageRoot: `npm/node_modules/${name}`,
    integrity: value.integrity,
    treeSha256,
    manifestSha256,
    bins,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function parsePiProviderReceipt(text: string): PiProviderReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("provider receipt is malformed JSON");
  }
  if (!isRecord(parsed)) fail("provider receipt root must be an object");
  if (parsed.schemaVersion !== 1) fail("provider receipt schemaVersion must be 1");
  const agentDir = parsed.agentDir;
  if (typeof agentDir !== "string" || agentDir === "" || !path.isAbsolute(agentDir)) {
    fail("provider receipt agentDir must be an absolute path");
  }
  const mcpTransport = parsed.mcpTransport;
  if (mcpTransport !== "native" && mcpTransport !== "legacy") fail("provider receipt mcpTransport is invalid");
  if (!Array.isArray(parsed.providers)) fail("provider receipt providers must be an array");
  const expected = expectedProviderNames(mcpTransport);
  if (parsed.providers.length !== expected.length) {
    fail(`provider receipt must list exactly the ${mcpTransport} providers`);
  }
  const providers = parsed.providers.map((entry) => parseEntry(entry, mcpTransport));
  const names = providers.map((entry) => entry.name);
  if (new Set(names).size !== names.length) fail("provider receipt providers must be unique");
  if ([...names].sort().join(",") !== [...expected].sort().join(",")) {
    fail(`provider receipt provider set does not match the ${mcpTransport} transport`);
  }
  return { schemaVersion: 1, agentDir: path.resolve(agentDir), mcpTransport, providers };
}

function readJsonObject(target: string, label: string): Record<string, unknown> {
  const stat = lstatOrNull(target);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stat.size > MAX_MANIFEST_BYTES) fail(`${label} exceeds its size bound`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  } catch {
    fail(`malformed ${label}`);
  }
  if (!isRecord(parsed)) fail(`${label} must be an object`);
  return parsed;
}

function assertBinTarget(activeRoot: string, target: string, name: string): void {
  if (path.isAbsolute(target)) fail(`receipt ${name} bin target must be relative`);
  const lexical = path.resolve(path.join(activeRoot, target));
  if (!isStrictChild(lexical, activeRoot)) fail(`receipt ${name} bin target escapes its package root`);
  const stat = lstatOrNull(lexical);
  if (stat === null || !stat.isFile()) fail(`receipt ${name} bin target is missing`);
  let actual: string;
  let rootActual: string;
  try {
    actual = fs.realpathSync(lexical);
    rootActual = fs.realpathSync(activeRoot);
  } catch {
    fail(`receipt ${name} bin target cannot be resolved safely`);
  }
  if (!isStrictChild(actual, rootActual)) fail(`receipt ${name} bin target escapes its package root`);
}

function readSettingsSources(agentDir: string): string[] {
  const settingsPath = path.join(agentDir, "settings.json");
  const stat = lstatOrNull(settingsPath);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) fail("settings.json must be a regular file");
  if (stat.size > MAX_SETTINGS_BYTES) fail("settings.json exceeds its size bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
  } catch {
    fail("settings.json is malformed");
  }
  if (!isRecord(parsed)) fail("settings.json root must be an object");
  if (!Array.isArray(parsed.packages)) fail("settings.json packages must be an array");
  const sources: string[] = [];
  for (const entry of parsed.packages) {
    const source = packageSource(entry);
    if (source !== null) sources.push(source);
  }
  return sources;
}

function bindReceiptToActiveState(receipt: PiProviderReceipt, agentDir: string): void {
  const sources = readSettingsSources(agentDir);
  for (const entry of receipt.providers) {
    const activeRoot = path.join(agentDir, entry.packageRoot);
    if (!isStrictChild(activeRoot, agentDir)) fail(`receipt ${entry.name} root escapes the agent directory`);
    assertAncestorsClean(activeRoot, agentDir, `receipt ${entry.name} root`);
    const rootStat = lstatOrNull(activeRoot);
    if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail(`receipt ${entry.name} root must be a real directory`);
    }
    const manifestPath = path.join(activeRoot, "package.json");
    const manifest = readJsonObject(manifestPath, `receipt ${entry.name} package.json`);
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      fail(`receipt ${entry.name} identity drifted from the active root`);
    }
    const manifestBytes = fs.readFileSync(manifestPath);
    if (sha256Hex(manifestBytes) !== entry.manifestSha256) fail(`receipt ${entry.name} manifest drifted from the active root`);
    const bins = normalizeBins(manifest.bin, entry.name);
    if (sortedMap(bins) !== sortedMap(entry.bins)) fail(`receipt ${entry.name} bin layout drifted from the active root`);
    for (const target of Object.values(bins)) assertBinTarget(activeRoot, target, entry.name);
    let tree: string;
    try {
      tree = inventoryTreeSha256(activeRoot);
    } catch (error) {
      fail(`receipt ${entry.name} tree is unsafe: ${errorMessage(error)}`);
    }
    if (tree !== entry.treeSha256) fail(`receipt ${entry.name} tree drifted from the active root`);
    const matches = sources.filter((source) => isNamedPiSource(source, entry.name));
    if (matches.length !== 1 || matches[0] !== entry.source) {
      fail(`receipt ${entry.name} loader source drifted from settings.json`);
    }
  }
}

export function piProviderReceiptPath(homeDir: string): string {
  return path.join(path.resolve(homeDir), STATE_DIR_NAME, RECEIPT_FILE_NAME);
}

export function buildPiProviderReceipt(input: BuildPiProviderReceiptInput): PiProviderReceipt {
  if (!isRecord(input)) fail("input must be an object");
  if (typeof input.agentDir !== "string" || input.agentDir === "" || !path.isAbsolute(input.agentDir)) {
    fail("agentDir must be an absolute path");
  }
  if (input.mcpTransport !== "native" && input.mcpTransport !== "legacy") {
    fail("mcpTransport must be native or legacy");
  }
  if (!Array.isArray(input.providers)) fail("providers must be an array");
  const expected = expectedProviderNames(input.mcpTransport);
  const names = input.providers.map((entry) => entry.name);
  if (new Set(names).size !== names.length || [...names].sort().join(",") !== [...expected].sort().join(",")) {
    fail(`providers must be exactly the ${input.mcpTransport} set`);
  }
  const providers = [...input.providers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseEntry(entry, input.mcpTransport));
  return {
    schemaVersion: 1,
    agentDir: path.resolve(input.agentDir),
    mcpTransport: input.mcpTransport,
    providers,
  };
}

export function serializePiProviderReceipt(receipt: PiProviderReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * Read-only receipt verification. It returns `absent` when the separate receipt
 * has never been published, otherwise it binds every entry to the current
 * settings source, active root identity, bins, manifest bytes and tree. A
 * malformed, symlinked or drifted receipt throws and never falls back to a
 * healthy state.
 */
export function verifyPiProviderReceipt(input: { homeDir: string; agentDir: string }): PiProviderReceiptVerification {
  if (!isRecord(input)) fail("input must be an object");
  const homeDir = path.resolve(input.homeDir);
  const agentDir = path.resolve(input.agentDir);
  if (!isStrictChild(agentDir, homeDir)) fail("agentDir must be a strict child of homeDir");
  assertAncestorsClean(agentDir, homeDir, "agent directory");
  const stateDir = path.join(homeDir, STATE_DIR_NAME);
  assertAncestorsClean(stateDir, homeDir, "provider state directory");
  const stateStat = lstatOrNull(stateDir);
  if (stateStat !== null && (stateStat.isSymbolicLink() || !stateStat.isDirectory())) {
    fail("provider state directory is unsafe");
  }
  const receiptPath = path.join(stateDir, RECEIPT_FILE_NAME);
  const stat = lstatOrNull(receiptPath);
  if (stat === null) return { kind: "absent", receipt: null };
  if (stat.isSymbolicLink() || !stat.isFile()) fail("provider receipt must be a regular file");
  if (stat.size > MAX_RECEIPT_BYTES) fail("provider receipt exceeds its size bound");
  let text: string;
  try {
    text = fs.readFileSync(receiptPath, "utf8");
  } catch {
    fail("cannot read provider receipt");
  }
  const receipt = parsePiProviderReceipt(text);
  if (receipt.agentDir !== agentDir) fail("provider receipt does not describe the active agent directory");
  bindReceiptToActiveState(receipt, agentDir);
  const kind: PiProviderReceiptKind = receipt.providers.some((entry) => entry.provenance?.origin === "derived")
    ? "derived"
    : "registry";
  return { kind, receipt };
}
