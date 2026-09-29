import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * [T58/T59-RED] Pi MCP adapter config path and owned legacy migration.
 *
 * The managed Pi agent owns only its configDir.  The installed adapter package
 * selects the active filename: adapter major < 3 uses mcp.json, while major
 * >= 3 uses mcp-adapter.json.  Only the exact official Engram root can move
 * from the legacy name, and every unsafe/ambiguous state must preserve bytes.
 */

type MigrationInput = {
  configDir: string;
  engramBin: string;
};

type MigrationResult = {
  migrated: boolean;
  backupPath?: string;
};

type PiMcpConfigModule = {
  resolvePiAdapterConfigPath(configDir: string): string;
  readPiMcpConfig(file: string): unknown;
  migrateOfficialPiMcpConfig(input: MigrationInput): MigrationResult;
};

const moduleSpecifier = new URL("../src/lib/pi-mcp-config.js", import.meta.url).href;

async function loadPiMcpConfig(): Promise<PiMcpConfigModule> {
  const mod = (await import(/* @vite-ignore */ moduleSpecifier)) as Partial<PiMcpConfigModule>;
  expect(
    mod.resolvePiAdapterConfigPath,
    "resolvePiAdapterConfigPath must be exported from src/lib/pi-mcp-config.ts",
  ).toBeTypeOf("function");
  expect(
    mod.readPiMcpConfig,
    "readPiMcpConfig must be exported from src/lib/pi-mcp-config.ts",
  ).toBeTypeOf("function");
  expect(
    mod.migrateOfficialPiMcpConfig,
    "migrateOfficialPiMcpConfig must be exported from src/lib/pi-mcp-config.ts",
  ).toBeTypeOf("function");
  return mod as PiMcpConfigModule;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

type Sandbox = {
  root: string;
  configDir: string;
  engramBin: string;
  outsideMarker: string;
  adapterPackage: string;
  legacyPath: string;
  destinationPath: string;
};

function createSandbox(version?: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-mcp-config-"));
  sandboxes.push(root);
  const configDir = path.join(root, "pi-agent");
  const adapterPackage = path.join(configDir, "npm", "node_modules", "pi-mcp-adapter", "package.json");
  const engramBin = path.join(root, "outside", "bin", "engram");
  const outsideMarker = path.join(root, "outside", "marker.txt");
  const legacyPath = path.join(configDir, "mcp.json");
  const destinationPath = path.join(configDir, "mcp-adapter.json");
  fs.mkdirSync(path.dirname(adapterPackage), { recursive: true });
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(engramBin, "outside binary marker\n", "utf8");
  fs.writeFileSync(outsideMarker, "must remain untouched\n", "utf8");
  if (version !== undefined) writeAdapterPackage(adapterPackage, version);
  return { root, configDir, engramBin, outsideMarker, adapterPackage, legacyPath, destinationPath };
}

function writeAdapterPackage(packagePath: string, version: string): void {
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, `${JSON.stringify({ name: "pi-mcp-adapter", version })}\n`, "utf8");
}

function isStrictChild(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function officialServer(engramBin: string): Record<string, unknown> {
  return {
    command: engramBin,
    args: ["mcp", "--tools=agent"],
    lifecycle: "lazy",
    directTools: false,
  };
}

function exactLegacyBytes(engramBin: string): string {
  return `${JSON.stringify({ mcpServers: { engram: officialServer(engramBin) } }, null, 2)}\n`;
}

function writeLegacy(sandbox: Sandbox, value: unknown): string {
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  fs.writeFileSync(sandbox.legacyPath, bytes, "utf8");
  return bytes;
}

function expectNoDestructiveMutation(
  sandbox: Sandbox,
  beforeLegacy: string | null,
  beforeDestination: string | null,
): void {
  if (beforeLegacy === null) expect(fs.existsSync(sandbox.legacyPath)).toBe(false);
  else expect(fs.readFileSync(sandbox.legacyPath, "utf8")).toBe(beforeLegacy);
  if (beforeDestination === null) expect(fs.existsSync(sandbox.destinationPath)).toBe(false);
  else expect(fs.readFileSync(sandbox.destinationPath, "utf8")).toBe(beforeDestination);
  expect(fs.readFileSync(sandbox.outsideMarker, "utf8")).toBe("must remain untouched\n");
}

function runPreservingFailure(
  migrate: () => MigrationResult,
  sandbox: Sandbox,
  beforeLegacy: string | null,
  beforeDestination: string | null,
): MigrationResult | null {
  try {
    const result = migrate();
    expect(result.migrated).toBe(false);
    expectNoDestructiveMutation(sandbox, beforeLegacy, beforeDestination);
    return result;
  } catch {
    expectNoDestructiveMutation(sandbox, beforeLegacy, beforeDestination);
    return null;
  }
}

describe("Pi MCP adapter config path and owned legacy migration", () => {
  it("does not echo malformed legacy MCP contents in verifier diagnostics", async () => {
    const sandbox = createSandbox("3.2.0");
    const sentinel = "PRIVATE_42";
    fs.writeFileSync(sandbox.legacyPath, sentinel);
    fs.writeFileSync(sandbox.destinationPath, exactLegacyBytes(sandbox.engramBin));
    fs.writeFileSync(path.join(sandbox.configDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.16", "npm:pi-mcp-adapter"] }));
    const { verifyOfficialSetup } = await import("../src/adapters/pi.js");
    const result = await verifyOfficialSetup(sandbox);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(sentinel);
    expect(result.reason).toContain("mcp.json");
  });
  it.each([
    ["2.99.9", "mcp.json"],
    ["3.0.0", "mcp-adapter.json"],
    ["10.4.2", "mcp-adapter.json"],
  ] as const)("selects %s without an upper-major cap", async (version, file) => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox(version);

    expect(mod.resolvePiAdapterConfigPath(sandbox.configDir)).toBe(path.join(sandbox.configDir, file));
  });

  it.each([
    ["missing package metadata", undefined],
    ["invalid package JSON", "invalid-json"],
    ["missing package version", JSON.stringify({ name: "pi-mcp-adapter" })],
    ["invalid package version", JSON.stringify({ name: "pi-mcp-adapter", version: "not-semver" })],
  ] as const)("blocks %s before selecting a config path", async (_label, fixture) => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox();
    if (fixture === undefined) {
      // The package directory remains absent.
    } else {
      fs.mkdirSync(path.dirname(sandbox.adapterPackage), { recursive: true });
      fs.writeFileSync(sandbox.adapterPackage, fixture === "invalid-json" ? "{broken" : fixture, "utf8");
    }

    expect(() => mod.resolvePiAdapterConfigPath(sandbox.configDir)).toThrow();
    expect(fs.existsSync(sandbox.legacyPath)).toBe(false);
    expect(fs.existsSync(sandbox.destinationPath)).toBe(false);
    expect(fs.readFileSync(sandbox.outsideMarker, "utf8")).toBe("must remain untouched\n");
  });

  it("reads JSONC with trailing commas followed by comments", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const file = sandbox.destinationPath;
    fs.writeFileSync(file, `{
  "mcpServers": {
    "engram": {
      "command": "${sandbox.engramBin}",
      "args": ["mcp", "--tools=agent"],
      "lifecycle": "lazy",
      "directTools": false,
    }, // server trailing comma
  }, // root trailing comma
}\n`, "utf8");

    expect(mod.readPiMcpConfig(file)).toEqual({
      mcpServers: {
        engram: {
          command: sandbox.engramBin,
          args: ["mcp", "--tools=agent"],
          lifecycle: "lazy",
          directTools: false,
        },
      },
    });
  });

  it("does not concatenate JSON tokens separated by a block comment", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const file = sandbox.destinationPath;
    fs.writeFileSync(file, '{"value":1/*comment*/2}\n', "utf8");

    expect(() => mod.readPiMcpConfig(file)).toThrow();
  });

  it("rejects an oversized config from stat metadata before reading its bytes", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const file = sandbox.destinationPath;
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      expect(() => mod.readPiMcpConfig(file)).toThrow(/exceeds/i);
      expect(readSpy.mock.calls.some(([candidate]) => candidate === file)).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("moves the exact official legacy root for adapter major >= 3 with a byte backup", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.0.0");
    const before = writeLegacy(sandbox, exactLegacyBytes(sandbox.engramBin));

    const result = mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin });

    expect(result).toMatchObject({ migrated: true });
    expect(result.backupPath).toBeTypeOf("string");
    expect(isStrictChild(sandbox.configDir, result.backupPath as string)).toBe(true);
    expect(path.resolve(result.backupPath as string)).not.toBe(path.resolve(sandbox.destinationPath));
    expect(fs.readFileSync(sandbox.destinationPath, "utf8")).toBe(before);
    expect(fs.readFileSync(result.backupPath as string, "utf8")).toBe(before);
    expect(fs.existsSync(sandbox.legacyPath)).toBe(false);
    expect(fs.readFileSync(sandbox.outsideMarker, "utf8")).toBe("must remain untouched\n");
  });

  it("is idempotent after promoting the legacy file", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.7.1");
    const before = writeLegacy(sandbox, exactLegacyBytes(sandbox.engramBin));
    const first = mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin });
    expect(first.migrated).toBe(true);
    const destinationAfterFirst = fs.readFileSync(sandbox.destinationPath, "utf8");

    const second = mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin });

    expect(second).toEqual({ migrated: false });
    expect(destinationAfterFirst).toBe(before);
    expect(fs.readFileSync(sandbox.destinationPath, "utf8")).toBe(destinationAfterFirst);
    expect(fs.existsSync(sandbox.legacyPath)).toBe(false);
  });

  it("does not migrate a legacy file while adapter major is still < 3", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("2.99.9");
    const before = writeLegacy(sandbox, exactLegacyBytes(sandbox.engramBin));

    const result = mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin });

    expect(result).toEqual({ migrated: false });
    expectNoDestructiveMutation(sandbox, before, null);
  });

  it.each([
    ["foreign server", (engramBin: string) => ({ mcpServers: { engram: officialServer(engramBin), other: { command: "foreign" } } })],
    ["extra root field", (engramBin: string) => ({ mcpServers: { engram: officialServer(engramBin) }, metadata: { owner: "user" } })],
  ] as const)("preserves legacy bytes with %s instead of claiming ownership", async (_label, build) => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const before = writeLegacy(sandbox, build(sandbox.engramBin));

    runPreservingFailure(
      () => mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin }),
      sandbox,
      before,
      null,
    );
  });

  it.each([
    ["extra server field", (engramBin: string) => ({ ...officialServer(engramBin), toolPrefix: "none" })],
    ["missing directTools", (engramBin: string) => ({ command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy" })],
    ["wrong command", (_engramBin: string) => ({ ...officialServer("/foreign/engram") })],
    ["wrong arguments", (engramBin: string) => ({ ...officialServer(engramBin), args: ["mcp"] })],
  ] as const)("does not migrate a legacy Engram server with %s", async (_label, build) => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const before = writeLegacy(sandbox, { mcpServers: { engram: build(sandbox.engramBin) } });

    runPreservingFailure(
      () => mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin }),
      sandbox,
      before,
      null,
    );
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["missing root server", JSON.stringify({ mcpServers: {} })],
  ] as const)("blocks %s without writing a destination", async (_label, bytes) => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const before = writeLegacy(sandbox, bytes);

    runPreservingFailure(
      () => mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin }),
      sandbox,
      before,
      null,
    );
  });

  it.skipIf(process.platform === "win32")("preserves a symlinked legacy path without following or deleting it", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const external = path.join(sandbox.root, "outside", "mcp.json");
    const before = exactLegacyBytes(sandbox.engramBin);
    fs.writeFileSync(external, before, "utf8");
    fs.symlinkSync(external, sandbox.legacyPath);

    runPreservingFailure(
      () => mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin }),
      sandbox,
      before,
      null,
    );
    expect(fs.lstatSync(sandbox.legacyPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(external, "utf8")).toBe(before);
  });

  it("blocks an existing conflicting destination without changing either file", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const beforeLegacy = writeLegacy(sandbox, exactLegacyBytes(sandbox.engramBin));
    const beforeDestination = JSON.stringify({ mcpServers: { foreign: { command: "keep" } } }) + "\n";
    fs.writeFileSync(sandbox.destinationPath, beforeDestination, "utf8");

    runPreservingFailure(
      () => mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin }),
      sandbox,
      beforeLegacy,
      beforeDestination,
    );
  });

  it("keeps an identical existing destination byte-identical and may safely deduplicate the old file", async () => {
    const mod = await loadPiMcpConfig();
    const sandbox = createSandbox("3.2.0");
    const before = writeLegacy(sandbox, exactLegacyBytes(sandbox.engramBin));
    fs.writeFileSync(sandbox.destinationPath, before, "utf8");

    const result = mod.migrateOfficialPiMcpConfig({ configDir: sandbox.configDir, engramBin: sandbox.engramBin });

    expect(result.migrated).toBe(false);
    expect(fs.readFileSync(sandbox.destinationPath, "utf8")).toBe(before);
    if (fs.existsSync(sandbox.legacyPath)) {
      expect(fs.readFileSync(sandbox.legacyPath, "utf8")).toBe(before);
    } else {
      expect(result.backupPath).toBeTypeOf("string");
      expect(isStrictChild(sandbox.configDir, result.backupPath as string)).toBe(true);
      expect(fs.readFileSync(result.backupPath as string, "utf8")).toBe(before);
    }
    expect(fs.readFileSync(sandbox.outsideMarker, "utf8")).toBe("must remain untouched\n");
  });
});
