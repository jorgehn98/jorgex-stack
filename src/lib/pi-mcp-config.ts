import fs from "node:fs";
import path from "node:path";

const ADAPTER_PACKAGE = "pi-mcp-adapter";
const MAX_CONFIG_BYTES = 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OFFICIAL_ARGS = ["mcp", "--tools=agent"] as const;

export interface PiMcpMigrationInput {
  configDir: string;
  engramBin: string;
}

export interface PiMcpMigrationResult {
  migrated: boolean;
  backupPath?: string;
}

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type FileSnapshot = {
  bytes: Buffer;
  identity: FileIdentity;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code as string
    : "UNKNOWN";
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}

function assertDirectory(configDir: string): string {
  const resolved = path.resolve(configDir);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Pi MCP config directory is not a real directory: ${resolved}`);
  }
  return resolved;
}

function adapterPackagePath(configDir: string): string {
  return path.join(configDir, "npm", "node_modules", ADAPTER_PACKAGE, "package.json");
}

function readAdapterMajor(configDir: string): number {
  const manifestPath = adapterPackagePath(configDir);
  let manifestStat: fs.Stats;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch (error) {
    throw new Error(`Installed pi-mcp-adapter package metadata is missing or unreadable at ${manifestPath} (${errnoCode(error)}).`);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`Installed pi-mcp-adapter package metadata is not a regular file at ${manifestPath}.`);
  }
  if (manifestStat.size > MAX_CONFIG_BYTES) throw new Error(`Installed pi-mcp-adapter metadata is too large at ${manifestPath}.`);

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(manifestPath);
    if (raw.byteLength > MAX_CONFIG_BYTES) throw new Error("metadata size limit");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch (error) {
    throw new Error(`Installed pi-mcp-adapter package metadata is invalid at ${manifestPath} (${errnoCode(error)}).`);
  }
  if (!isRecord(parsed) || parsed.name !== ADAPTER_PACKAGE || typeof parsed.version !== "string") {
    throw new Error(`Installed pi-mcp-adapter package metadata is incomplete at ${manifestPath}.`);
  }
  const match = SEMVER.exec(parsed.version);
  if (match === null) {
    throw new Error(`Installed pi-mcp-adapter version is invalid at ${manifestPath}.`);
  }
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major)) {
    throw new Error(`Installed pi-mcp-adapter version is out of range at ${manifestPath}.`);
  }
  return major;
}

/**
 * Selects the file read by the installed adapter.  The package metadata is
 * authoritative: an absent or malformed manifest must not silently fall back
 * to the historical file.
 */
export function resolvePiAdapterConfigPath(configDir: string): string {
  const resolvedDir = assertDirectory(configDir);
  const major = readAdapterMajor(resolvedDir);
  return path.join(resolvedDir, major >= 3 ? "mcp-adapter.json" : "mcp.json");
}

function stripJsonCommentsAndTrailingCommas(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      output += " ";
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      output += " ";
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new SyntaxError("unterminated JSON comment");
      index = end + 1;
      continue;
    }
    output += char;
  }
  if (inString) throw new SyntaxError("unterminated JSON string");
  let cleaned = "";
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === ",") {
      let next = index + 1;
      while (next < output.length && /\s/.test(output[next]!)) next += 1;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    cleaned += char;
  }
  return cleaned;
}

/** Reads a bounded Pi MCP JSON/JSONC document without mutating it. */
export function readPiMcpConfig(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pi MCP config is not a regular file: ${file}`);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`Pi MCP config exceeds ${MAX_CONFIG_BYTES} bytes: ${file}`);
  const bytes = fs.readFileSync(file);
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error(`Pi MCP config exceeds ${MAX_CONFIG_BYTES} bytes: ${file}`);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(stripJsonCommentsAndTrailingCommas(source)) as unknown;
}

function readSnapshot(file: string): FileSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  if (stat.size > MAX_CONFIG_BYTES) return null;
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.byteLength > MAX_CONFIG_BYTES) return null;
    return {
      bytes,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
    };
  } catch {
    return null;
  }
}

function exactOfficialEngramRoot(value: unknown, engramBin: string): boolean {
  if (!path.isAbsolute(engramBin) || !isRecord(value)) return false;
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "mcpServers")) return false;
  const servers = value.mcpServers;
  if (!isRecord(servers) || Object.keys(servers).length !== 1 || !Object.hasOwn(servers, "engram")) return false;
  const server = servers.engram;
  if (!isRecord(server)) return false;
  const keys = Object.keys(server).sort();
  if (keys.join("\0") !== ["args", "command", "directTools", "lifecycle"].join("\0")) return false;
  return server.command === engramBin
    && server.lifecycle === "lazy"
    && server.directTools === false
    && Array.isArray(server.args)
    && server.args.length === OFFICIAL_ARGS.length
    && server.args.every((arg, index) => arg === OFFICIAL_ARGS[index]);
}

function nextBackupPath(configDir: string, legacyPath: string): string {
  const base = `${path.basename(legacyPath)}.jorgex-backup-${process.pid}-${Date.now()}`;
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const name = suffix === 0 ? base : `${base}-${suffix}`;
    const candidate = path.join(configDir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a Pi MCP backup path under ${configDir}.`);
}

function createBackup(configDir: string, legacyPath: string, bytes: Buffer): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const backupPath = nextBackupPath(configDir, legacyPath);
    let fd: number | undefined;
    try {
      fd = fs.openSync(backupPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return backupPath;
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* preserve the source on cleanup failure */ }
      }
      // Never remove a path we did not successfully open ourselves.  In
      // particular, an EEXIST race may be a user symlink or another backup.
      if (errnoCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not create a Pi MCP backup under ${configDir}.`);
}

function sourceUnchanged(file: string, snapshot: FileSnapshot): boolean {
  const current = readSnapshot(file);
  return current !== null && sameIdentity(current.identity, snapshot.identity) && current.bytes.equals(snapshot.bytes);
}

function removeExactSource(file: string, snapshot: FileSnapshot): boolean {
  const current = readSnapshot(file);
  if (current === null || !sameIdentity(current.identity, snapshot.identity) || !current.bytes.equals(snapshot.bytes)) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    return false;
  }
  return !fs.existsSync(file);
}

function writeDestinationExclusively(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  let createdIdentity: FileIdentity | null = null;
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    createdIdentity = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve the original write error */ }
    if (createdIdentity !== null) {
      const current = readSnapshot(file);
      if (current !== null && sameIdentity(current.identity, createdIdentity)) {
        try { fs.unlinkSync(file); } catch { /* never follow a raced destination */ }
      }
    }
    throw error;
  }
  fs.closeSync(fd);
}

/**
 * Promotes only the exact official Engram root from the historical file to
 * the file selected by adapter >=3.  Every write is preceded by an in-scope
 * byte backup and source identity/readback checks; conflicts and aliases are
 * left untouched.
 */
export function migrateOfficialPiMcpConfig(input: PiMcpMigrationInput): PiMcpMigrationResult {
  const configDir = assertDirectory(input.configDir);
  const activePath = resolvePiAdapterConfigPath(configDir);
  if (path.basename(activePath) !== "mcp-adapter.json") return { migrated: false };

  const legacyPath = path.join(configDir, "mcp.json");
  const source = readSnapshot(legacyPath);
  if (source === null || source.bytes.byteLength > MAX_CONFIG_BYTES) return { migrated: false };

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(text)) as unknown;
  } catch {
    return { migrated: false };
  }
  if (!exactOfficialEngramRoot(parsed, input.engramBin)) return { migrated: false };

  let destination: fs.Stats | null = null;
  try {
    destination = fs.lstatSync(activePath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") return { migrated: false };
  }
  if (destination !== null) {
    // Never overwrite or follow a user-owned destination.  A regular file is
    // eligible only when its bytes are exactly the legacy bytes.
    if (!destination.isFile() || destination.isSymbolicLink()) return { migrated: false };
    if (destination.size > MAX_CONFIG_BYTES) return { migrated: false };
    let destinationBytes: Buffer;
    try { destinationBytes = fs.readFileSync(activePath); } catch { return { migrated: false }; }
    if (!destinationBytes.equals(source.bytes)) return { migrated: false };
  }

  const backupPath = createBackup(configDir, legacyPath, source.bytes);
  if (!sourceUnchanged(legacyPath, source)) return { migrated: false, backupPath };

  if (destination === null) {
    try {
      writeDestinationExclusively(activePath, source.bytes);
      const written = readSnapshot(activePath);
      if (written === null || !written.bytes.equals(source.bytes)) {
        return { migrated: false, backupPath };
      }
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return { migrated: false, backupPath };
      return { migrated: false, backupPath };
    }
  } else {
    const currentDestination = readSnapshot(activePath);
    if (currentDestination === null || !currentDestination.bytes.equals(source.bytes)) return { migrated: false, backupPath };
  }

  // Do not remove a source that changed while the destination was prepared.
  if (!removeExactSource(legacyPath, source)) return { migrated: false, backupPath };
  return { migrated: destination === null, backupPath };
}

export function declaredPiMcpConfigFiles(stageDir: string): string[] {
  const file = path.join(stageDir, "npm", "node_modules", "jorgex-pi", "contract", "jorgex-pi.v1.json");
  const contract = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpAdapterConfig?: { schemaVersion?: unknown; files?: unknown } };
  const declaration = contract.mcpAdapterConfig;
  if (declaration === undefined) return [];
  if (declaration.schemaVersion !== 1 || !Array.isArray(declaration.files)
    || !declaration.files.every((file): file is string => typeof file === "string")) {
    throw new Error("El candidato Pi declara un contrato MCP inválido.");
  }
  return declaration.files;
}

