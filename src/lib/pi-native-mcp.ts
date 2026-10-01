import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBackup } from "./backup.js";
import { writeText } from "./fsx.js";
import { resolveActivePiEntry } from "./pi-private-release.js";
import { stopOwnedPiProcess } from "./pi-stage-smoke.js";
import type { PiProjectionMcpNativeAuthority } from "./pi-projection-lifecycle.js";

/**
 * Stack consumer of the Pi `mcp-native-v1` producer contract.
 *
 * Pure definition/digest and readonly ownership work happens in a bounded Node
 * child that imports the already-verified Pi artifact by absolute URL. Sensitive
 * definition data travels through stdin, never argv or logs, and the child only
 * returns a small validated JSON value.
 */

const CONTRACT_RELATIVE = ["contract", "native-mcp.v1.json"] as const;
const MAX_CONTRACT_BYTES = 1024 * 1024;
const MAX_CHILD_STDOUT_BYTES = 1024 * 1024;
const MAX_CHILD_STDERR_BYTES = 16 * 1024;
const EXPORT_TIMEOUT_MS = 120_000;

const NATIVE_MCP_CONTRACT_LITERAL = {
  schemaVersion: 1,
  capability: "mcp-native-v1",
  transport: "native",
  configurationPath: "PI_CODING_AGENT_DIR/mcp.json",
  packageReceiptPath: "HOME/.jorgex-stack/pi-receipt.json",
  projectionReceiptPath: "HOME/.jorgex-stack/pi-projection-receipt.json",
  authorityField: "mcpNative",
  servers: ["engram", "context7", "chrome-devtools"],
  definitions: {
    entrypoint: "extensions/mcp-engram.mjs",
    digestExport: "digestNativeMcpDefinition",
    devtoolsExport: "resolveNativeDevtoolsDefinition",
  },
  ownership: {
    entrypoint: "extensions/native-mcp.mjs",
    export: "inspectNativeMcpOwnership",
  },
} as const;

export type NativeMcpServerName = "engram" | "context7" | "chrome-devtools";

export interface NativeMcpContract {
  readonly definitionsEntrypoint: string;
  readonly digestExport: string;
  readonly devtoolsExport: string;
  readonly ownershipEntrypoint: string;
  readonly ownershipExport: string;
}

export interface NativeMcpDevtoolsDefinition {
  readonly command: string;
  readonly args: readonly string[];
}

export interface NativeMcpOwnershipEntry {
  readonly state: "absent" | "unowned" | "conflict" | "managed";
  readonly cleanupEligible: boolean;
  readonly availability: "unavailable" | "configured" | "disabled" | "unsupported-execution";
  readonly reason?: string;
}

export interface NativeMcpOwnershipResult {
  readonly servers: Readonly<Record<NativeMcpServerName, NativeMcpOwnershipEntry>>;
  readonly package: { readonly state: "not-required" | "verified" | "conflict"; readonly reason?: string };
  readonly connection: "not-verified";
}

const OWNERSHIP_STATES: readonly NativeMcpOwnershipEntry["state"][] = ["absent", "unowned", "conflict", "managed"];
const OWNERSHIP_AVAILABILITY: readonly NativeMcpOwnershipEntry["availability"][] = ["unavailable", "configured", "disabled", "unsupported-execution"];
const OWNERSHIP_PACKAGE_STATES: readonly NativeMcpOwnershipResult["package"]["state"][] = ["not-required", "verified", "conflict"];

/**
 * Strictly validates the complete checker DTO before any cast: exactly the three
 * native servers, each with a known state/availability and boolean
 * cleanupEligible, the package state domain, and the read-only connection. A
 * cleanupEligible claim is accepted only for a verified package and a managed
 * server; any missing key or unexpected enum throws.
 */
function parseNativeMcpOwnershipResult(value: unknown): NativeMcpOwnershipResult {
  if (!isRecord(value) || value.connection !== "not-verified") fail("native ownership result is invalid");
  const servers = value.servers;
  if (!isRecord(servers)
    || Object.keys(servers).length !== NATIVE_MCP_SERVER_NAMES.length
    || !NATIVE_MCP_SERVER_NAMES.every((name) => Object.hasOwn(servers, name))) {
    fail("native ownership result is invalid");
  }
  const pkg = value.package;
  if (!isRecord(pkg)
    || typeof pkg.state !== "string"
    || !OWNERSHIP_PACKAGE_STATES.includes(pkg.state as NativeMcpOwnershipResult["package"]["state"])) {
    fail("native ownership result is invalid");
  }
  if (Object.hasOwn(pkg, "reason") && typeof pkg.reason !== "string") {
    fail("native ownership result is invalid");
  }
  const packageState = pkg.state as NativeMcpOwnershipResult["package"]["state"];
  const parsedServers = {} as Record<NativeMcpServerName, NativeMcpOwnershipEntry>;
  for (const name of NATIVE_MCP_SERVER_NAMES) {
    const entry = servers[name];
    if (!isRecord(entry)
      || typeof entry.state !== "string"
      || !OWNERSHIP_STATES.includes(entry.state as NativeMcpOwnershipEntry["state"])
      || typeof entry.cleanupEligible !== "boolean"
      || typeof entry.availability !== "string"
      || !OWNERSHIP_AVAILABILITY.includes(entry.availability as NativeMcpOwnershipEntry["availability"])) {
      fail("native ownership result is invalid");
    }
    if (Object.hasOwn(entry, "reason") && typeof entry.reason !== "string") {
      fail("native ownership result is invalid");
    }
    const state = entry.state as NativeMcpOwnershipEntry["state"];
    if (entry.cleanupEligible === true && !(packageState === "verified" && state === "managed")) {
      fail("native ownership result is invalid");
    }
    parsedServers[name] = {
      state,
      cleanupEligible: entry.cleanupEligible,
      availability: entry.availability as NativeMcpOwnershipEntry["availability"],
      ...(entry.reason === undefined ? {} : { reason: entry.reason as string }),
    };
  }
  return {
    servers: parsedServers,
    package: pkg.reason === undefined
      ? { state: packageState }
      : { state: packageState, reason: pkg.reason as string },
    connection: "not-verified",
  };
}

function fail(message: string): never {
  throw new Error(`pi-native-mcp: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readBoundedRegularFile(file: string, maxBytes: number, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stat.size > maxBytes) fail(`${label} exceeds its size bound`);
  const bytes = fs.readFileSync(file);
  if (bytes.byteLength > maxBytes) fail(`${label} exceeds its size bound`);
  return bytes;
}

/** Reads and validates the staged/installed `contract/native-mcp.v1.json`. */
export function readNativeMcpContract(packageRoot: string): NativeMcpContract {
  const root = path.resolve(packageRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("package root must be a real directory");
  const contractPath = path.join(root, ...CONTRACT_RELATIVE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedRegularFile(contractPath, MAX_CONTRACT_BYTES, "native MCP contract").toString("utf8"));
  } catch (error) {
    fail(`native MCP contract is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(NATIVE_MCP_CONTRACT_LITERAL)) {
    fail("native MCP contract drifts from the Stack native policy");
  }
  for (const entrypoint of [NATIVE_MCP_CONTRACT_LITERAL.definitions.entrypoint, NATIVE_MCP_CONTRACT_LITERAL.ownership.entrypoint]) {
    const file = path.join(root, entrypoint);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`native MCP entrypoint is not a regular file: ${entrypoint}`);
  }
  return {
    definitionsEntrypoint: NATIVE_MCP_CONTRACT_LITERAL.definitions.entrypoint,
    digestExport: NATIVE_MCP_CONTRACT_LITERAL.definitions.digestExport,
    devtoolsExport: NATIVE_MCP_CONTRACT_LITERAL.definitions.devtoolsExport,
    ownershipEntrypoint: NATIVE_MCP_CONTRACT_LITERAL.ownership.entrypoint,
    ownershipExport: NATIVE_MCP_CONTRACT_LITERAL.ownership.export,
  };
}

const EXPORT_BOOTSTRAP = [
  'import { readFileSync } from "node:fs";',
  "const request = JSON.parse(readFileSync(0, \"utf8\"));",
  "const module = await import(request.moduleUrl);",
  "const fn = module[request.exportName];",
  'if (typeof fn !== "function") throw new Error("native-export-missing");',
  "const value = await fn(...request.args);",
  "process.stdout.write(JSON.stringify({ ok: true, value: value === undefined ? null : value }));",
].join("\n");

function isolatedChildEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "SystemDrive", "COMSPEC", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

/**
 * Runs one Pi export in a bounded Node child. All request data (including any
 * sensitive definition fields) is written to stdin; the module URL, export name
 * and arguments never appear in argv or logs. Only a validated small JSON value
 * is returned; a failing child surfaces a generic error without its stderr.
 */
async function runNativeMcpExport(input: {
  readonly packageRoot: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly args: readonly unknown[];
}): Promise<unknown> {
  const moduleUrl = pathToFileURL(path.join(path.resolve(input.packageRoot), input.entrypoint)).href;
  const request = JSON.stringify({ moduleUrl, exportName: input.exportName, args: input.args });
  if (Buffer.byteLength(request, "utf8") > MAX_CHILD_STDOUT_BYTES) fail("native export request exceeds its size bound");
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", EXPORT_BOOTSTRAP], {
      env: isolatedChildEnv(),
      cwd: path.resolve(input.packageRoot),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      // Stop only this operation's own child/group; teardown failures must never
      // silently resolve a failing export as success.
      void stopOwnedPiProcess(child).then(
        () => { if (error !== null) reject(error); else resolve(value); },
        () => {
          reject(error !== null
            ? error
            : new Error(`pi-native-mcp: native export ${input.exportName} teardown failed`));
        },
      );
    };
    const onStdout = (chunk: Buffer): void => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CHILD_STDOUT_BYTES) {
        settle(new Error(`pi-native-mcp: native export ${input.exportName} exceeded its output bound`));
        return;
      }
      stdout += chunk.toString("utf8");
    };
    const onStderr = (chunk: Buffer): void => {
      if (settled) return;
      stderrBytes += chunk.length;
      // stderr is bounded but never surfaced: it may echo user definition data.
      if (stderrBytes > MAX_CHILD_STDERR_BYTES) settle(new Error(`pi-native-mcp: native export ${input.exportName} failed`));
    };
    const onError = (): void => { settle(new Error(`pi-native-mcp: native export ${input.exportName} failed`)); };
    const onClose = (code: number | null): void => {
      if (settled) return;
      if (code !== 0) { settle(new Error(`pi-native-mcp: native export ${input.exportName} failed`)); return; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        settle(new Error(`pi-native-mcp: native export ${input.exportName} returned an invalid result`));
        return;
      }
      if (!isRecord(parsed) || parsed.ok !== true) {
        settle(new Error(`pi-native-mcp: native export ${input.exportName} failed`));
        return;
      }
      settle(null, parsed.value);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => { settle(new Error(`pi-native-mcp: native export ${input.exportName} timed out`)); }, EXPORT_TIMEOUT_MS);
    timer.unref();
    child.stdin?.on("error", () => { /* surfaced through close/error */ });
    child.stdin?.end(request);
  });
}

/** Pure protected-definition digest computed by the verified Pi artifact. */
export async function digestNativeMcpDefinition(
  packageRoot: string,
  name: NativeMcpServerName,
  definition: Record<string, unknown>,
): Promise<string> {
  const contract = readNativeMcpContract(packageRoot);
  const value = await runNativeMcpExport({
    packageRoot,
    entrypoint: contract.definitionsEntrypoint,
    exportName: contract.digestExport,
    args: [name, definition],
  });
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("native definition digest is invalid");
  return value;
}

/** Trusted v3 DevTools guard definition, or undefined when the handoff is absent/disabled. */
export async function resolveNativeDevtoolsDefinition(
  packageRoot: string,
  options: { readonly env: Record<string, string | undefined>; readonly platform: NodeJS.Platform },
): Promise<NativeMcpDevtoolsDefinition | undefined> {
  const contract = readNativeMcpContract(packageRoot);
  const value = await runNativeMcpExport({
    packageRoot,
    entrypoint: contract.definitionsEntrypoint,
    exportName: contract.devtoolsExport,
    args: [{ env: options.env, platform: options.platform }],
  });
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) || typeof value.command !== "string" || !Array.isArray(value.args)
    || !value.args.every((arg): arg is string => typeof arg === "string")) {
    fail("native DevTools definition is invalid");
  }
  return { command: value.command, args: value.args };
}

/** Readonly native ownership inspection, bound to the active installed artifact. */
export async function inspectNativeMcpOwnership(
  activePackageRoot: string,
  options: {
    readonly env: Record<string, string | undefined>;
    readonly platform: NodeJS.Platform;
    readonly cwd: string;
    readonly projectTrusted: boolean;
  },
): Promise<NativeMcpOwnershipResult> {
  const contract = readNativeMcpContract(activePackageRoot);
  const value = await runNativeMcpExport({
    packageRoot: activePackageRoot,
    entrypoint: contract.ownershipEntrypoint,
    exportName: contract.ownershipExport,
    args: [{
      env: options.env,
      platform: options.platform,
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
    }],
  });
  return parseNativeMcpOwnershipResult(value);
}

// --- Native persistent configuration (mcp.json) -----------------------------

export interface NativeMcpOwnedEntry {
  readonly name: NativeMcpServerName;
  readonly entry: Record<string, unknown>;
  readonly created: boolean;
  readonly previousEntry?: Record<string, unknown>;
  readonly previousCleanupSha256?: string;
}

export const NATIVE_MCP_SERVER_NAMES: readonly NativeMcpServerName[] = ["engram", "context7", "chrome-devtools"];
const NATIVE_MCP_SERVER_SET = new Set<string>(NATIVE_MCP_SERVER_NAMES);

export interface NativeMcpSnapshot {
  readonly file: string;
  readonly raw: string | null;
  readonly parsed: Record<string, unknown> | null;
  readonly servers: Record<string, unknown>;
}

function readRawOrNull(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("native mcp.json is not a regular file");
    return readBoundedRegularFile(file, MAX_CONTRACT_BYTES, "native mcp.json").toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reads the raw `mcp.json` bytes plus a strict parse, without mutating anything. */
export function readNativeMcpSnapshot(agentDir: string): NativeMcpSnapshot {
  const file = path.join(path.resolve(agentDir), "mcp.json");
  const raw = readRawOrNull(file);
  if (raw === null) return { file, raw: null, parsed: null, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("native mcp.json is invalid JSON");
  }
  if (!isRecord(parsed)) fail("native mcp.json must be an object");
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isRecord(servers)) fail("native mcp.json has an invalid mcpServers section");
  return { file, raw, parsed, servers: isRecord(servers) ? servers : {} };
}

/** The exact native Engram entry Pi's builtin parser owns: command + official args. */
export function planNativeEngramEntry(engramBin: string): Record<string, unknown> {
  if (typeof engramBin !== "string" || engramBin === "" || !path.isAbsolute(engramBin)) {
    fail("native Engram requires an absolute binary path");
  }
  return { command: engramBin, args: ["mcp", "--tools=agent"] };
}

/** Context7 native entry preserving any preexisting (opaque) headers. */
export function planNativeContext7Entry(existing?: unknown): Record<string, unknown> {
  const url = "https://mcp.context7.com/mcp";
  if (isRecord(existing) && isRecord(existing.headers)) {
    return { url, headers: existing.headers };
  }
  return { url };
}

/** Whole-entry JSON encoding the Pi checker compares against cleanupSha256. */
export function nativeWholeEntrySha256(entry: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(entry));
}

/**
 * Strictly validates a granular `mcpNative` authority. Returns null when the
 * value is absent, and throws when a present authority is malformed so callers
 * block instead of inventing absence.
 */
export function parseNativeMcpAuthorityStrict(value: unknown): PiProjectionMcpNativeAuthority | null {
  if (value === undefined) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "entries"]) || value.schemaVersion !== 1) {
    fail("native MCP authority has an unsupported shape");
  }
  if (!isRecord(value.entries)) fail("native MCP authority has an invalid entries section");
  const entries: Record<string, { definitionSha256: string; cleanupSha256?: string }> = {};
  for (const [name, claim] of Object.entries(value.entries)) {
    if (!NATIVE_MCP_SERVER_SET.has(name)) fail("native MCP authority names an unknown server");
    if (!isRecord(claim) || !hasExactKeys(claim, Object.hasOwn(claim, "cleanupSha256")
      ? ["definitionSha256", "cleanupSha256"] : ["definitionSha256"])) {
      fail("native MCP authority has an invalid claim");
    }
    if (typeof claim.definitionSha256 !== "string" || !/^[0-9a-f]{64}$/.test(claim.definitionSha256)) {
      fail("native MCP authority has an invalid definition digest");
    }
    if (Object.hasOwn(claim, "cleanupSha256")
      && (typeof claim.cleanupSha256 !== "string" || !/^[0-9a-f]{64}$/.test(claim.cleanupSha256))) {
      fail("native MCP authority has an invalid cleanup stamp");
    }
    entries[name] = Object.hasOwn(claim, "cleanupSha256")
      ? { definitionSha256: claim.definitionSha256, cleanupSha256: claim.cleanupSha256 as string }
      : { definitionSha256: claim.definitionSha256 };
  }
  return { schemaVersion: 1, entries };
}

function hasExactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/**
 * Writes the protected native servers into strict-JSON `mcp.json` from a
 * previously captured raw snapshot. The bytes are re-read and compared before
 * the write (concurrent-drift detection); the previous bytes are backed up and
 * restored only when the file still equals this operation's own write.
 */
export function writeNativeMcpConfig(input: {
  readonly agentDir: string;
  readonly servers: readonly NativeMcpOwnedEntry[];
  readonly expectedRaw: string | null;
  readonly expectedParsed: Record<string, unknown> | null;
  readonly backupRoot?: string;
}): { file: string; previousRaw: string | null; writtenRaw: string } {
  const agentDir = path.resolve(input.agentDir);
  const dirStat = fs.lstatSync(agentDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("agentDir must be a real directory");
  const file = path.join(agentDir, "mcp.json");
  const current = readRawOrNull(file);
  if (current !== input.expectedRaw) fail("native mcp.json changed concurrently before the write");
  const next: Record<string, unknown> = input.expectedParsed === null ? {} : { ...input.expectedParsed };
  const servers: Record<string, unknown> = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
  for (const server of input.servers) servers[server.name] = server.entry;
  next.mcpServers = servers;
  const writtenRaw = `${JSON.stringify(next, null, 2)}\n`;
  if (input.expectedRaw !== null) createBackup([file], "pi-native-mcp", input.backupRoot);
  writeText(file, writtenRaw, 0o600);
  const readback = readRawOrNull(file);
  if (readback !== writtenRaw) {
    restoreOwnedWrite(file, writtenRaw, input.expectedRaw);
    fail("native mcp.json readback did not match the written configuration");
  }
  return { file, previousRaw: input.expectedRaw, writtenRaw };
}

/** Removes only the named native servers, preserving every other key/server. */
export function removeNativeMcpEntries(input: {
  readonly agentDir: string;
  readonly names: readonly NativeMcpServerName[];
  readonly expectedRaw: string | null;
  readonly expectedParsed: Record<string, unknown> | null;
  readonly backupRoot?: string;
}): { file: string; previousRaw: string | null; writtenRaw: string } {
  const agentDir = path.resolve(input.agentDir);
  const file = path.join(agentDir, "mcp.json");
  const current = readRawOrNull(file);
  if (current !== input.expectedRaw) fail("native mcp.json changed concurrently before the removal");
  const next: Record<string, unknown> = input.expectedParsed === null ? {} : { ...input.expectedParsed };
  const servers: Record<string, unknown> = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
  for (const name of input.names) delete servers[name];
  next.mcpServers = servers;
  const writtenRaw = `${JSON.stringify(next, null, 2)}\n`;
  if (input.expectedRaw !== null) createBackup([file], "pi-native-mcp-cleanup", input.backupRoot);
  writeText(file, writtenRaw, 0o600);
  if (readRawOrNull(file) !== writtenRaw) {
    restoreOwnedWrite(file, writtenRaw, input.expectedRaw);
    fail("native mcp.json readback did not match the removal");
  }
  return { file, previousRaw: input.expectedRaw, writtenRaw };
}

const NATIVE_MCP_CAPABILITY = NATIVE_MCP_CONTRACT_LITERAL.capability;
// Mirrors the staged-candidate `mcpNative` binding literal. Declared here (not
// imported from pi-candidate) to avoid the pi-candidate -> pi-runtime ->
// pi-native-phase -> pi-native-mcp import cycle.
const NATIVE_MCP_BINDING = { schemaVersion: 1, contractPath: "contract/native-mcp.v1.json" } as const;
const ROOT_CONTRACT_RELATIVE = ["contract", "jorgex-pi.v1.json"] as const;

/** Bounded, symlink-safe read of the managed `contract/jorgex-pi.v1.json`. */
function readManagedRootContract(packageRoot: string): unknown {
  const file = path.join(packageRoot, ...ROOT_CONTRACT_RELATIVE);
  let raw: Buffer;
  try {
    raw = readBoundedRegularFile(file, MAX_CONTRACT_BYTES, "managed root contract");
  } catch (error) {
    fail(`managed root contract is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    fail("managed root contract is not valid JSON");
  }
}

/**
 * Native classification from the managed root contract. The `mcp-native-v1`
 * capability and its literal `mcpNative` binding must both be present and agree:
 * both absent is a known legacy root (false, no native file required); a partial
 * or drifted claim throws so callers fail closed instead of treating a
 * native-declared root as legacy.
 */
function rootDeclaresNative(rootContract: unknown): boolean {
  if (!isRecord(rootContract)) fail("managed root contract must be an object");
  const capabilities = rootContract.capabilities;
  if (capabilities !== undefined
    && (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === "string"))) {
    fail("managed root contract has invalid capabilities");
  }
  const declaredCapability = Array.isArray(capabilities) && capabilities.includes(NATIVE_MCP_CAPABILITY);
  const binding = rootContract.mcpNative;
  if (declaredCapability !== (binding !== undefined)) {
    fail("managed root contract declares a partial native claim");
  }
  if (!declaredCapability) return false;
  if (JSON.stringify(binding) !== JSON.stringify(NATIVE_MCP_BINDING)) {
    fail("managed root contract mcpNative binding drifts from the native policy");
  }
  return true;
}

/**
 * True only when the active installed package declares the validated native
 * transport; used to select the native branch when no new candidate is injected.
 * The operational active entry is resolved through its canonical managed link
 * (see `resolveActivePiEntry`), the managed root contract classifies
 * native-vs-legacy, and the exact `native-mcp.v1.json` protocol is validated
 * with its physical entrypoints. An owned legacy root returns false; a corrupt
 * link/root contract or a native-declared root whose native file is missing,
 * malformed or drifted throws so the caller blocks instead of silently falling
 * back to legacy.
 */
export function isInstalledNativePackage(agentDir: string): boolean {
  const entry = resolveActivePiEntry(agentDir);
  if (entry.kind === "absent") return false;
  if (!rootDeclaresNative(readManagedRootContract(entry.packageRoot))) return false;
  readNativeMcpContract(entry.packageRoot);
  return true;
}

/** Restores a file to its previous bytes only while it still holds this write. */
export function restoreOwnedWrite(file: string, ownRaw: string, previousRaw: string | null): boolean {
  if (readRawOrNull(file) !== ownRaw) return false;
  if (previousRaw === null) {
    fs.rmSync(file, { force: true });
    return true;
  }
  writeText(file, previousRaw, 0o600);
  return true;
}

/**
 * Builds the granular `mcpNative` authority for entries created or fully owned
 * by this operation. `cleanupSha256` is only stamped for an entry created here
 * or whose previous whole entry still matched its own stamp; a user-personalized
 * entry releases cleanup instead of being re-stamped.
 */
export async function buildNativeMcpAuthority(
  packageRoot: string,
  entries: readonly NativeMcpOwnedEntry[],
): Promise<PiProjectionMcpNativeAuthority> {
  const authorityEntries: Record<string, { definitionSha256: string; cleanupSha256?: string }> = {};
  for (const owned of entries) {
    const definitionSha256 = await digestNativeMcpDefinition(packageRoot, owned.name, owned.entry);
    const wholeEntry = nativeWholeEntrySha256(owned.entry);
    const previousWhole = owned.previousEntry === undefined ? undefined : nativeWholeEntrySha256(owned.previousEntry);
    const cleanupSha256 = owned.created
      ? wholeEntry
      : owned.previousCleanupSha256 !== undefined && previousWhole === owned.previousCleanupSha256
        ? wholeEntry
        : undefined;
    authorityEntries[owned.name] = cleanupSha256 === undefined
      ? { definitionSha256 }
      : { definitionSha256, cleanupSha256 };
  }
  return { schemaVersion: 1, entries: authorityEntries };
}
