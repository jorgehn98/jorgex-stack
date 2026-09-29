import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * [T58/T61] Authoritative Pi setup integration seam.
 *
 * This invokes the public `runOfficialSetupIfNeeded("pi")` wrapper with a
 * real executable and the real Pi verifier.  The provider is synthetic and
 * offline: it writes only the isolated PI_CODING_AGENT_DIR fixture.
 */

type SetupResult = {
  ran: boolean;
  ok?: boolean;
  ownershipTransferred?: boolean;
  recovery?: string;
  backupId?: string | null;
  stderr?: string;
  reason?: string;
};

type SetupModule = {
  runOfficialSetupIfNeeded(
    runtime: string,
    options: {
      command: string;
      dryRun: boolean;
      targetDir?: string;
      engramBin: string;
      configDir: string;
      homeDir: string;
      piMcpConfigFiles?: readonly string[];
    },
  ): Promise<SetupResult>;
};

type PiModule = {
  verifyOfficialSetup(options: { configDir: string; engramBin: string; homeDir: string }): Promise<{
    ok: boolean;
    layers?: string[];
    reason?: string;
  }>;
};

type Fixture = {
  root: string;
  homeDir: string;
  configDir: string;
  dataDir: string;
  engramBin: string;
  settingsPath: string;
  legacyPath: string;
  destinationPath: string;
  adapterPackagePath: string;
  npmForeignPath: string;
  legacyBytes: string;
};

const fixtures: string[] = [];

afterEach(() => {
  vi.doUnmock("../src/lib/paths.js");
  vi.resetModules();
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-mcp-setup-integration-"));
  fixtures.push(root);
  const homeDir = path.join(root, "home");
  const configDir = path.join(homeDir, ".pi", "agent");
  const dataDir = path.join(root, "stack-data");
  const engramBin = path.join(homeDir, ".local", "bin", "engram");
  const settingsPath = path.join(configDir, "settings.json");
  const legacyPath = path.join(configDir, "mcp.json");
  const destinationPath = path.join(configDir, "mcp-adapter.json");
  const adapterPackagePath = path.join(configDir, "npm", "node_modules", "pi-mcp-adapter", "package.json");
  const npmForeignPath = path.join(configDir, "npm", "foreign", "keep.txt");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const official = {
    command: engramBin,
    args: ["mcp", "--tools=agent"],
    lifecycle: "lazy",
    directTools: false,
  };
  const legacyBytes = `${JSON.stringify({ mcpServers: { engram: official } }, null, 2)}\n`;
  const providerScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const configDir = process.env.PI_CODING_AGENT_DIR;
if (typeof configDir !== "string" || configDir === "") process.exit(31);
fs.mkdirSync(path.join(configDir, "npm", "node_modules", "pi-mcp-adapter"), { recursive: true });
fs.writeFileSync(path.join(configDir, "settings.json"), ${JSON.stringify(JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@3.2.0"] }) + "\n")});
fs.writeFileSync(path.join(configDir, "npm", "node_modules", "pi-mcp-adapter", "package.json"), ${JSON.stringify(JSON.stringify({ name: "pi-mcp-adapter", version: "3.2.0" }) + "\n")});
fs.writeFileSync(path.join(configDir, "mcp.json"), ${JSON.stringify(legacyBytes)});
`;
  fs.writeFileSync(engramBin, providerScript, "utf8");
  try {
    fs.chmodSync(engramBin, 0o755);
  } catch {
    // Windows execution is skipped; POSIX mode is asserted by the real spawn.
  }
  return {
    root,
    homeDir,
    configDir,
    dataDir,
    engramBin,
    settingsPath,
    legacyPath,
    destinationPath,
    adapterPackagePath,
    npmForeignPath,
    legacyBytes,
  };
}

async function loadSetupWithRealPiVerifier(fixture: Fixture): Promise<{ setup: SetupModule; pi: PiModule }> {
  vi.resetModules();
  vi.doMock("../src/lib/paths.js", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/paths.js")>("../src/lib/paths.js");
    return {
      ...actual,
      HOME: fixture.homeDir,
      dataDir: () => fixture.dataDir,
    };
  });
  // Importing the real Pi adapter registers verifyOfficialSetup on the same
  // mocked official-engram-setup module instance used by the public wrapper.
  const pi = await import("../src/adapters/pi.js") as unknown as PiModule;
  const setup = await import("../src/lib/official-engram-setup.js") as unknown as SetupModule;
  return { setup, pi };
}

function seedPreexistingState(fixture: Fixture): { settings: string; legacy: string; foreign: string } {
  const settings = `${JSON.stringify({ packages: ["npm:foreign-before@1.0.0"] })}\n`;
  const legacy = `${JSON.stringify({ mcpServers: { foreign: { command: "/foreign/server" } } })}\n`;
  const foreign = "preexisting npm state\n";
  fs.writeFileSync(fixture.settingsPath, settings, "utf8");
  fs.writeFileSync(fixture.legacyPath, legacy, "utf8");
  fs.mkdirSync(path.dirname(fixture.npmForeignPath), { recursive: true });
  fs.writeFileSync(fixture.npmForeignPath, foreign, "utf8");
  return { settings, legacy, foreign };
}

function expectMigrationBackup(fixture: Fixture): void {
  const backupName = fs.readdirSync(fixture.configDir).find((entry) => entry.startsWith("mcp.json.jorgex-backup-"));
  expect(backupName).toBeTypeOf("string");
  expect(fs.readFileSync(path.join(fixture.configDir, backupName as string), "utf8")).toBe(fixture.legacyBytes);
}

describe.skipIf(process.platform === "win32")("Pi official setup + MCP migration integration", () => {
  it("runs the real provider hook, migrates legacy MCP, and verifies the active adapter config", async () => {
    const fixture = createFixture();
    seedPreexistingState(fixture);
    const { setup, pi } = await loadSetupWithRealPiVerifier(fixture);

    const result = await setup.runOfficialSetupIfNeeded("pi", {
      command: "install",
      dryRun: false,
      engramBin: fixture.engramBin,
      configDir: fixture.configDir,
      homeDir: fixture.homeDir,
      piMcpConfigFiles: ["mcp.json", "mcp-adapter.json"],
    });

    expect(result).toMatchObject({ ran: true, ok: true, ownershipTransferred: true });
    expect(result.backupId).toBeTypeOf("string");
    expect(fs.existsSync(path.join(fixture.dataDir, "backups", result.backupId as string))).toBe(true);
    expect(fs.existsSync(fixture.legacyPath)).toBe(false);
    expect(fs.readFileSync(fixture.destinationPath, "utf8")).toBe(fixture.legacyBytes);
    expectMigrationBackup(fixture);
    expect(fs.readFileSync(fixture.npmForeignPath, "utf8")).toBe("preexisting npm state\n");

    const verified = await pi.verifyOfficialSetup({
      configDir: fixture.configDir,
      engramBin: fixture.engramBin,
      homeDir: fixture.homeDir,
    });
    expect(verified.ok).toBe(true);
    expect(verified.layers).toEqual(expect.arrayContaining(["packages", "mcp"]));
    expect(fs.readFileSync(fixture.adapterPackagePath, "utf8")).toContain('"version":"3.2.0"');
  });

  it("fails and restores preexisting state when the staged reader declaration is absent", async () => {
    const fixture = createFixture();
    const before = seedPreexistingState(fixture);
    const { setup } = await loadSetupWithRealPiVerifier(fixture);

    const result = await setup.runOfficialSetupIfNeeded("pi", {
      command: "install",
      dryRun: false,
      engramBin: fixture.engramBin,
      configDir: fixture.configDir,
      homeDir: fixture.homeDir,
    });

    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.ownershipTransferred).toBe(false);
    expect(String(result.stderr ?? result.reason)).toMatch(/mcp-adapter|lector|declara/i);
    expect(result.recovery).toBe("complete");
    expect(fs.readFileSync(fixture.settingsPath, "utf8")).toBe(before.settings);
    expect(fs.readFileSync(fixture.legacyPath, "utf8")).toBe(before.legacy);
    expect(fs.readFileSync(fixture.npmForeignPath, "utf8")).toBe(before.foreign);
    expect(fs.existsSync(fixture.destinationPath)).toBe(false);
    expect(fs.existsSync(fixture.adapterPackagePath)).toBe(false);
    expect(fs.readdirSync(fixture.configDir).some((entry) => entry.startsWith("mcp.json.jorgex-backup-"))).toBe(false);
  });
});
