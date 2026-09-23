import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PI_RUNTIME_ARCHIVE, PI_RUNTIME_CANDIDATE, STACK_ENGRAM_PROVIDER_ONLY } from "./fixtures/pi-runtime.js";
import { runPiProjectionLifecycleSystem } from "../src/lib/pi-projection-lifecycle.js";
import { stackRoot } from "../src/lib/paths.js";

const piDirectory = process.env.JORGEX_PI_DIR;
const crossRepo = piDirectory === undefined ? describe.skip : describe;
const registryTarball = process.env.JORGEX_PI_TARBALL;
const registryArtifact = registryTarball === undefined ? describe.skip : describe;
const temporaryPaths: string[] = [];

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function digest(algorithm: "sha256" | "sha512", file: string): string {
  return createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
}

function listTarEntries(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd().split(/\r?\n/);
}

function expectExactArtifactIntegrity(tarball: string): void {
  const stats = fs.statSync(tarball);
  expect(stats.isFile()).toBe(true);
  expect(stats.size).toBe(PI_RUNTIME_CANDIDATE.tarball.bytes);
  expect(digest("sha256", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha256);
  expect(digest("sha512", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha512);
}

function readTarJson(tarball: string, entry: string): unknown {
  return JSON.parse(execFileSync("tar", ["-xOf", tarball, entry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })) as unknown;
}

function packTarball(root: string): string {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-cross-repo-pack-"));
  temporaryPaths.push(packDir);
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const tarballs = fs.readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return path.join(packDir, tarballs[0]!);
}

function expectArchiveInventory(tarball: string): void {
  const entries = new Set(listTarEntries(tarball));
  expect(entries.size).toBe(PI_RUNTIME_ARCHIVE.entries);
  expect(entries.has(`package/${PI_RUNTIME_ARCHIVE.workAudit.asset}`)).toBe(true);
  for (const asset of PI_RUNTIME_ARCHIVE.brandingAssets) {
    expect(entries.has(`package/${asset}`), asset).toBe(true);
  }
  for (const asset of PI_RUNTIME_ARCHIVE.qualityAssets) {
    expect(entries.has(`package/${asset}`), asset).toBe(true);
  }
  const packedManifest = readTarJson(tarball, "package/package.json") as {
    bundledDependencies?: unknown;
    pi?: { skills?: unknown };
  };
  expect(packedManifest.pi?.skills).toEqual(expect.arrayContaining([PI_RUNTIME_ARCHIVE.workAudit.manifestEntry]));
  expect(packedManifest.bundledDependencies).toEqual(PI_RUNTIME_ARCHIVE.bundledDependencies);
  for (const dependency of PI_RUNTIME_ARCHIVE.bundledDependencies) {
    expect(entries.has(`package/node_modules/${dependency}/package.json`), dependency).toBe(true);
  }
  for (const dependency of PI_RUNTIME_ARCHIVE.closurePackageManifests) {
    expect(entries.has(`package/node_modules/${dependency}/package.json`), dependency).toBe(true);
  }
  for (const binding of PI_RUNTIME_ARCHIVE.nativeBindings) {
    expect(entries.has(`package/node_modules/${binding}`), binding).toBe(true);
  }
}

function writeFakePlaywright(root: string): string {
  const bin = path.join(root, "bin", process.platform === "win32" ? "playwright-cli.cmd" : "playwright-cli");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(bin, "@echo off\r\necho 0.1.18\r\n");
  } else {
    fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write("0.1.18\\n");\n`);
    fs.chmodSync(bin, 0o755);
  }
  return bin;
}

function runPublishedBootstrap(packageRoot: string, agentDir: string, home: string): string {
  const harness = path.join(path.dirname(packageRoot), "bootstrap-harness.mjs");
  fs.writeFileSync(harness, `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
const { createBootstrap } = await import(pathToFileURL(join(packageRoot, "extensions", "bootstrap.ts")).href);
const handlers = new Map();
const eventHandlers = new Map();
const activeTools = [];
const pi = {
  events: {
    on(name, handler) { eventHandlers.set(name, handler); },
    emit() {},
  },
  on(name, handler) { handlers.set(name, handler); },
  getActiveTools() { return [...activeTools]; },
  setActiveTools(names) { activeTools.splice(0, activeTools.length, ...names); },
  registerTool() {},
  registerCommand() {},
  sendUserMessage() {},
  sendMessage() {},
};

await createBootstrap({
  loadCompanion: async () => () => {},
  getPermissionsService: () => true,
})(pi);
await handlers.get("session_start")?.({}, { sessionId: "published-handoff" });
await eventHandlers.get("permissions:ready")?.({ sessionId: "published-handoff" });
const result = await handlers.get("before_agent_start")?.(
  { systemPrompt: "Base policy" },
  { sessionId: "published-handoff", hasUI: true },
);
process.stdout.write(JSON.stringify({ prompt: result?.systemPrompt ?? "" }));
`, "utf8");
  const isolationRoot = path.dirname(packageRoot);
  const emptyPath = path.join(isolationRoot, "empty-bin");
  fs.mkdirSync(emptyPath, { recursive: true });
  const result = spawnSync(process.execPath, [harness, packageRoot], {
    cwd: isolationRoot,
    encoding: "utf8",
    env: {
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: path.join(isolationRoot, "xdg-config"),
      XDG_CACHE_HOME: path.join(isolationRoot, "xdg-cache"),
      PATH: emptyPath,
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Publicado Pi bootstrap falló (${result.status}): ${result.stderr || result.stdout}`);
  }
  return (JSON.parse(result.stdout) as { prompt: string }).prompt;
}

function expectRunnerOutput(
  output: { stdout: string; stderr: string },
  command: "sync" | "cleanup",
  packageRunner: string,
): void {
  expect(output.stderr).toBe("");
  expect(output.stdout.endsWith("\n")).toBe(true);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes);

  const body = output.stdout.slice(0, -1);
  expect(body).not.toBe("");
  expect(body).not.toMatch(/[\r\n]/);

  const parsed: unknown = JSON.parse(body);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  const record = parsed as {
    schemaVersion?: unknown;
    command?: unknown;
    ok?: unknown;
    package?: unknown;
  };
  expect(record.schemaVersion).toBe(PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion);
  expect(record.command).toBe(command);
  expect(record.ok).toBe(true);
  expect(record.package).not.toBeNull();
  expect(typeof record.package).toBe("object");
  expect(Array.isArray(record.package)).toBe(false);
  const packageInfo = record.package as { name?: unknown; version?: unknown; root?: unknown };
  expect(packageInfo.name).toBe(PI_RUNTIME_CANDIDATE.package.name);
  expect(packageInfo.version).toBe(PI_RUNTIME_CANDIDATE.package.version);
  expect(typeof packageInfo.root).toBe("string");
  const packageRoot = packageInfo.root as string;
  expect(path.isAbsolute(packageRoot)).toBe(true);
  expect(path.resolve(packageRoot, "bin", "jorgex-pi.mjs")).toBe(path.resolve(packageRunner));
}

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

registryArtifact("exact npm artifact for the pinned jorgex-pi candidate", () => {
  beforeAll(() => {
    expectExactArtifactIntegrity(path.resolve(registryTarball!));
  });

  it("matches the frozen bytes, digests, package contract, and archive inventory", () => {
    const tarball = path.resolve(registryTarball!);

    const manifest = readTarJson(tarball, "package/package.json") as { name?: unknown; version?: unknown };
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as {
      package?: unknown;
      pi?: { testedVersions?: unknown };
      capabilities?: unknown;
    };
    const runner = readTarJson(tarball, "package/contract/runner.v1.json") as {
      schemaVersion?: unknown;
      bin?: unknown;
      commands?: unknown;
      stdout?: { maxBytes?: unknown };
    };
    const assets = readTarJson(tarball, "package/contract/assets.v1.json") as { managedExternalWrites?: unknown };
    const parity = readTarJson(tarball, "package/contract/parity.v2.json") as {
      source?: { commit?: unknown };
    };
    expect(manifest).toMatchObject({
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
    });
    expect(contract.package).toEqual(PI_RUNTIME_CANDIDATE.package);
    expect(contract.pi?.testedVersions).toEqual(PI_RUNTIME_CANDIDATE.pi.testedVersions);
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(runner).toMatchObject({
      schemaVersion: PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion,
      bin: PI_RUNTIME_CANDIDATE.contract.runner.bin,
      commands: PI_RUNTIME_CANDIDATE.contract.runner.commands,
      stdout: { maxBytes: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes },
    });
    expect(assets.managedExternalWrites).toEqual(PI_RUNTIME_CANDIDATE.contract.managedExternalWrites);
    expect(parity.source?.commit).toBe(PI_RUNTIME_ARCHIVE.parity.source.commit);
    expectArchiveInventory(tarball);
  }, 60_000);

  it("executes managed defaults and permission cleanup from the exact published tarball", () => {
    const tarball = path.resolve(registryTarball!);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-registry-lifecycle-"));
    temporaryPaths.push(root);
    execFileSync("tar", ["-xzf", tarball, "-C", root], { stdio: ["ignore", "ignore", "pipe"] });

    const agentDir = path.join(root, "agent");
    const settingsFile = path.join(agentDir, "settings.json");
    const modelsFile = path.join(agentDir, "models.json");
    const receiptFile = path.join(agentDir, "jorgex-pi", "sol-lifecycle.v1.json");
    const permissionsFile = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
    const permissionsReceipt = path.join(agentDir, "jorgex-pi", "permissions-lifecycle.v1.json");
    const experienceReceipt = path.join(agentDir, "jorgex-pi", "experience-lifecycle.v1.json");
    const engramBin = path.join(root, process.platform === "win32" ? "engram.exe" : "engram");
    const runner = path.join(root, "package", "bin", "jorgex-pi.mjs");
    // T54-RED: official `engram setup pi` preconditions (provider-managed
    // singleton packages + canonical MCP + executable sandbox binary) must
    // exist before runner sync/doctor; the runner never invokes the
    // coordinator. Versions are provider-managed observations, only the
    // singleton shape (exactly one gentle + one adapter) and the canonical
    // MCP form are asserted. Sandbox stays under the temp root, no real HOME.
    const officialGentle = "npm:gentle-engram@0.1.99";
    const officialAdapter = "npm:pi-mcp-adapter@0.2.5";
    const officialPackages = [officialGentle, officialAdapter];
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: officialPackages, foreign: { keep: true }, defaultThinkingLevel: "high" }));
    fs.writeFileSync(modelsFile, JSON.stringify({ foreign: { keep: true } }));
    fs.writeFileSync(engramBin, process.platform === "win32" ? "placeholder" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(engramBin, 0o700);
    const seedOfficialSetup = (codingAgentDir: string): void => {
      fs.mkdirSync(codingAgentDir, { recursive: true });
      const targetSettings = path.join(codingAgentDir, "settings.json");
      if (!fs.existsSync(targetSettings)) {
        fs.writeFileSync(targetSettings, JSON.stringify({ packages: officialPackages }));
      }
      fs.writeFileSync(path.join(codingAgentDir, "mcp.json"), JSON.stringify({
        mcpServers: {
          engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
        },
      }));
    };
    seedOfficialSetup(agentDir);

    const environment = {
      PI_CODING_AGENT_DIR: agentDir,
      ENGRAM_BIN: engramBin,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    };
    fs.mkdirSync(environment.TEMP, { recursive: true });
    const run = (command: "sync" | "cleanup" | "doctor" | "status", codingAgentDir = agentDir) => spawnSync(process.execPath, [runner, command, "--json"], {
      encoding: "utf8",
      env: { ...environment, PI_CODING_AGENT_DIR: codingAgentDir },
    });

    const sync = run("sync");
    expect(sync.status).toBe(0);
    expectRunnerOutput(sync, "sync", runner);
    // Official setup preconditions survive managed sync: exactly one
    // provider-managed gentle + adapter entry and the canonical MCP server
    // pointing at the executable sandbox binary.
    expect(readJson(settingsFile)).toMatchObject({ packages: officialPackages });
    expect(readJson(path.join(agentDir, "mcp.json"))).toEqual({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    });
    expect(fs.statSync(engramBin).isFile()).toBe(true);
    expect(readJson(settingsFile)).toMatchObject({
      foreign: { keep: true },
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      theme: "JorgeX",
      quietStartup: true,
      hideThinkingBlock: true,
      defaultThinkingLevel: "high",
    });
    expect(readJson(modelsFile)).toMatchObject({
      foreign: { keep: true },
      providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { contextWindow: 872000 } } } },
    });
    expect(fs.existsSync(receiptFile)).toBe(true);
    expect(fs.existsSync(permissionsFile)).toBe(true);
    expect(readJson(permissionsFile)).toEqual(readJson(path.join(root, "package", "assets", "permissions", "defaults.json")));
    const permissionBytes = fs.readFileSync(permissionsFile, "utf8");
    const permissionReceiptBytes = fs.readFileSync(permissionsReceipt, "utf8");
    const experienceReceiptBytes = fs.readFileSync(experienceReceipt, "utf8");
    const settingsBytes = fs.readFileSync(settingsFile, "utf8");
    expect(run("sync").status).toBe(0);
    expect(fs.readFileSync(experienceReceipt, "utf8")).toBe(experienceReceiptBytes);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(settingsBytes);
    expect(fs.readFileSync(permissionsFile, "utf8")).toBe(permissionBytes);
    expect(fs.readFileSync(permissionsReceipt, "utf8")).toBe(permissionReceiptBytes);

    const canonicalCleanup = run("cleanup");
    expect(canonicalCleanup.status).toBe(0);
    expectRunnerOutput(canonicalCleanup, "cleanup", runner);
    expect(readJson(settingsFile)).toEqual({ packages: officialPackages, foreign: { keep: true }, defaultThinkingLevel: "high" });
    expect(readJson(modelsFile)).toEqual({ foreign: { keep: true } });
    expect(fs.existsSync(receiptFile)).toBe(false);
    expect(fs.existsSync(permissionsFile)).toBe(false);
    expect(fs.existsSync(permissionsReceipt)).toBe(false);
    expect(fs.existsSync(experienceReceipt)).toBe(false);
    const permissionBackups = path.join(agentDir, "jorgex-pi", "permissions-backups");
    const backupFiles = fs.readdirSync(permissionBackups, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(permissionBackups, entry.name, "config.json"));
    expect(backupFiles.some((file) => fs.readFileSync(file, "utf8") === permissionBytes)).toBe(true);

    const resync = run("sync");
    expect(resync.status).toBe(0);
    expectRunnerOutput(resync, "sync", runner);

    const settings = readJson(settingsFile) as Record<string, unknown>;
    settings.defaultModel = "user-model";
    settings.theme = "dark";
    settings.hideThinkingBlock = false;
    delete settings.quietStartup;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    expect(run("sync").status).toBe(0);
    expect(readJson(settingsFile)).not.toHaveProperty("quietStartup");
    expect(readJson(settingsFile)).toMatchObject({ theme: "dark", hideThinkingBlock: false, defaultThinkingLevel: "high" });
    const models = readJson(modelsFile) as Record<string, any>;
    models.providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow = 900000;
    fs.writeFileSync(modelsFile, JSON.stringify(models));

    const userPolicy = readJson(permissionsFile) as { permission: Record<string, unknown> };
    userPolicy.permission.read = "ask";
    const userPolicyBytes = JSON.stringify(userPolicy);
    fs.writeFileSync(permissionsFile, userPolicyBytes);
    const cleanup = run("cleanup");
    expect(cleanup.status).toBe(0);
    expectRunnerOutput(cleanup, "cleanup", runner);
    expect(readJson(settingsFile)).toEqual({ packages: officialPackages, foreign: { keep: true }, defaultModel: "user-model", theme: "dark", hideThinkingBlock: false, defaultThinkingLevel: "high" });
    expect(readJson(modelsFile)).toEqual({
      foreign: { keep: true },
      providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { contextWindow: 900000 } } } },
    });
    expect(fs.readFileSync(permissionsFile, "utf8")).toBe(userPolicyBytes);

    const preexistingAgent = path.join(root, "preexisting-agent");
    const preexistingPolicy = path.join(preexistingAgent, "extensions", "pi-permission-system", "config.json");
    fs.mkdirSync(path.dirname(preexistingPolicy), { recursive: true });
    fs.writeFileSync(preexistingPolicy, userPolicyBytes);
    const preexistingSettings = { packages: officialPackages, theme: "JorgeX", quietStartup: false, hideThinkingBlock: true, defaultThinkingLevel: "high" };
    const preexistingSettingsFile = path.join(preexistingAgent, "settings.json");
    fs.writeFileSync(preexistingSettingsFile, JSON.stringify(preexistingSettings));
    seedOfficialSetup(preexistingAgent);
    expect(readJson(preexistingSettingsFile)).toMatchObject({ packages: officialPackages });
    expect(run("sync", preexistingAgent).status).toBe(0);
    expect(run("cleanup", preexistingAgent).status).toBe(0);
    expect(fs.readFileSync(preexistingPolicy, "utf8")).toBe(userPolicyBytes);
    expect(readJson(preexistingSettingsFile)).toEqual(preexistingSettings);

    const invalidAgent = path.join(root, "invalid-agent");
    const invalidPolicy = path.join(invalidAgent, "extensions", "pi-permission-system", "config.json");
    fs.mkdirSync(path.dirname(invalidPolicy), { recursive: true });
    fs.writeFileSync(invalidPolicy, "invalid JSON");
    fs.writeFileSync(path.join(invalidAgent, "settings.json"), JSON.stringify({ packages: officialPackages }));
    seedOfficialSetup(invalidAgent);
    const invalidSync = run("sync", invalidAgent);
    expect(invalidSync.status).toBe(0);
    expectRunnerOutput(invalidSync, "sync", runner);
    expect(fs.readFileSync(invalidPolicy, "utf8")).toBe("invalid JSON");
    expect(readJson(path.join(invalidAgent, "jorgex-pi", "permissions-lifecycle.v1.json"))).not.toHaveProperty("owned");
    const status = run("status", invalidAgent);
    expect(JSON.parse(status.stdout).result.permissions.state).toBe("invalid");
    const doctor = run("doctor", invalidAgent);
    expect(doctor.status).not.toBe(0);
    expect(JSON.parse(doctor.stdout).result.checks).toContainEqual({ id: "permissions", status: "error" });

  }, 60_000);

  it("consumes Stack's Playwright handoff in the published Pi bootstrap and hides it after disable", () => {
    const tarball = path.resolve(registryTarball!);
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as { capabilities?: unknown };
    expect(contract.capabilities).toEqual(expect.arrayContaining(["playwright-handoff-v1"]));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-published-playwright-"));
    temporaryPaths.push(root);
    execFileSync("tar", ["-xzf", tarball, "-C", root], { stdio: ["ignore", "ignore", "pipe"] });

    const packageRoot = path.join(root, "package");
    const targetDir = path.join(root, "stack-target");
    const agentDir = path.join(targetDir, "pi-agent");
    const home = path.join(targetDir, "home");
    const playwrightCommand = writeFakePlaywright(root);
    const packageSource = `npm:jorgex-pi@${PI_RUNTIME_CANDIDATE.package.version}`;

    expect(runPiProjectionLifecycleSystem({
      operation: "install",
      targetDir,
      packageSource,
      engramBin: path.join(root, "engram"),
      playwrightCliEnabled: true,
      playwrightHandoffEnabled: true,
      playwrightCliCommand: playwrightCommand,
    })).toMatchObject({ kind: "installed" });

    const handoff = path.join(agentDir, "jorgex-pi", "playwright.v1.json");
    expect(readJson(handoff)).toEqual({
      schemaVersion: 1,
      enabled: true,
      command: playwrightCommand,
      version: "0.1.18",
    });

    const enabledPrompt = runPublishedBootstrap(packageRoot, agentDir, home);
    expect(enabledPrompt).toContain(playwrightCommand);
    expect(enabledPrompt).toContain("<!-- jorgex:playwright -->");
    expect(enabledPrompt).not.toContain("<!-- jorgex:browser -->");
    expect(enabledPrompt).not.toContain("<!-- jorgex:context7 -->");
    expect(enabledPrompt).not.toMatch(/Context7/i);

    expect(runPiProjectionLifecycleSystem({
      operation: "sync",
      targetDir,
      packageSource,
      engramBin: path.join(root, "engram"),
      playwrightCliEnabled: false,
      playwrightHandoffEnabled: false,
      playwrightCliCommand: null,
    })).toMatchObject({ kind: "synced" });
    expect(fs.existsSync(handoff)).toBe(false);

    const disabledPrompt = runPublishedBootstrap(packageRoot, agentDir, home);
    expect(disabledPrompt).not.toContain(playwrightCommand);
    expect(disabledPrompt).not.toMatch(/playwright-cli/i);
    expect(disabledPrompt).not.toContain("<!-- jorgex:browser -->");
    expect(disabledPrompt).not.toContain("<!-- jorgex:context7 -->");
    expect(disabledPrompt).not.toMatch(/Context7/i);
  }, 60_000);
});

crossRepo("cross-repo contract for the pinned jorgex-pi candidate", () => {
  it("verifies the explicit JorgeX Pi checkout contract and bundled closure", () => {
    const root = path.resolve(piDirectory!);
    expect(fs.statSync(root).isDirectory()).toBe(true);

    const manifest = readJson(path.join(root, "package.json")) as { name?: string; version?: string };
    const contract = readJson(path.join(root, "contract", "jorgex-pi.v1.json")) as {
      package?: unknown;
      pi?: { testedVersions?: unknown };
      capabilities?: unknown;
    };
    const runner = readJson(path.join(root, "contract", "runner.v1.json")) as {
      schemaVersion?: unknown;
      bin?: unknown;
      commands?: unknown;
      stdout?: { maxBytes?: unknown };
    };
    const assets = readJson(path.join(root, "contract", "assets.v1.json")) as { managedExternalWrites?: unknown };

    expect(manifest).toMatchObject({
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
    });
    expect(contract.package).toEqual(PI_RUNTIME_CANDIDATE.package);
    expect(contract.pi?.testedVersions).toEqual(PI_RUNTIME_CANDIDATE.pi.testedVersions);
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(runner).toMatchObject({
      schemaVersion: PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion,
      bin: PI_RUNTIME_CANDIDATE.contract.runner.bin,
      commands: PI_RUNTIME_CANDIDATE.contract.runner.commands,
      stdout: { maxBytes: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes },
    });
    expect(assets.managedExternalWrites).toEqual(PI_RUNTIME_CANDIDATE.contract.managedExternalWrites);

    const tarball = packTarball(root);
    expectArchiveInventory(tarball);
  }, 60_000);

  it("coordinates install through the managed operation with the checkout-local Pi: normalizes source, initializes via sync, and removes only the managed package", async () => {
    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js");
    const { runManagedPiOperation } = await import("../src/lib/pi-managed-runtime.js") as unknown as {
      runManagedPiOperation(operation: "install", deps: {
        runPackage(operation: string): Promise<{ kind: string; reason?: string; receipt?: unknown }>;
        runProjection(operation: string): Promise<unknown>;
        prepareProjectionUninstall(): Promise<never>;
        completeProjectionUninstall(): Promise<never>;
      }): Promise<unknown>;
    };
    const root = path.resolve(piDirectory!);
    const piManifest = readJson(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")) as {
      version?: unknown;
    };
    const piExecutable = path.join(root, "node_modules", ".bin", "pi");
    expect(piManifest.version).toBe("0.84.2");
    expect(fs.realpathSync(piExecutable)).toBe(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));

    const sourceTarball = packTarball(root);
    const checkoutLifecycleFixture = {
      source: PI_RUNTIME_CANDIDATE.package.source,
      bytes: fs.statSync(sourceTarball).size,
      sha256: digest("sha256", sourceTarball),
      sha512: digest("sha512", sourceTarball),
      package: PI_RUNTIME_CANDIDATE.package,
      provenance: { commit: "checkout-lifecycle-fixture" },
    };
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-cross-repo-install-"));
    temporaryPaths.push(target);
    const workspace = path.join(target, "workspace");
    const agentDir = path.join(target, "pi-agent");
    const settingsPath = path.join(agentDir, "settings.json");
    const downloadedTarball = path.join(target, "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
    const packageRunner = path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
    const packageRoot = path.dirname(path.dirname(packageRunner));
    const engramBin = path.join(target, "bin", process.platform === "win32" ? "engram.exe" : "engram");
    const foreignSource = "npm:foreign@1.0.0";
    const foreignState = { owner: "user", nested: { keep: true } };
    // T54-RED: this lower-level managed-operation test starts AFTER the
    // coordinator's external `engram setup pi` (it never pretends to run the
    // coordinator). Seed the singleton provider-managed packages + canonical
    // MCP with the executable sandbox binary before the managed install;
    // versions are provider-managed observations, only the singleton shape and
    // canonical MCP form are asserted. Order/package/projection assertions
    // below stay strict. Sandbox stays under the temp target, no real HOME.
    const officialGentle = "npm:gentle-engram@0.1.99";
    const officialAdapter = "npm:pi-mcp-adapter@0.2.5";

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, process.platform === "win32" ? "placeholder" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(engramBin, 0o700);
    fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [foreignSource, officialGentle, officialAdapter], foreignState, defaultThinkingLevel: "high" })}\n`);
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }));
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages).toEqual([foreignSource, officialGentle, officialAdapter]);

    const invocations: Array<{ executable: string; args: string[]; environment: Record<string, string> }> = [];
    const runIsolated = (invocation: { executable: string; args: string[]; environment: Record<string, string> }) => {
      invocations.push(invocation);
      expect(invocation.environment).toMatchObject({
        HOME: path.join(target, "home"),
        USERPROFILE: path.join(target, "home"),
        APPDATA: path.join(target, "appdata"),
        LOCALAPPDATA: path.join(target, "localappdata"),
        XDG_CONFIG_HOME: path.join(target, "xdg-config"),
        XDG_DATA_HOME: path.join(target, "xdg-data"),
        XDG_CACHE_HOME: path.join(target, "xdg-cache"),
        TEMP: path.join(target, "tmp"),
        TMP: path.join(target, "tmp"),
        TMPDIR: path.join(target, "tmp"),
        npm_config_cache: path.join(target, "npm-cache"),
        PI_CODING_AGENT_DIR: agentDir,
        ENGRAM_BIN: engramBin,
      });
      expect(invocation.environment).not.toHaveProperty("PI_PACKAGE_DIR");
      expect(invocation.environment).not.toHaveProperty("NPM_TOKEN");
      const result = spawnSync(invocation.executable, invocation.args, {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...invocation.environment,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_OFFLINE: "true",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
        shell: false,
        timeout: 120_000,
        maxBuffer: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes + 1,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error?.message ?? ""),
      };
    };

    const trace: string[] = [];
    const result = await runManagedPiOperation("install", {
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") {
          return installPiFromVerifiedTarball({
            targetDir: target,
            piExecutable,
            engramBin,
            candidate: {
              ...checkoutLifecycleFixture,
            },
          }, {
            download(destination) {
              expect(destination).toBe(downloadedTarball);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.copyFileSync(sourceTarball, destination);
              return {
                path: destination,
                bytes: fs.statSync(destination).size,
                sha256: digest("sha256", destination),
                sha512: digest("sha512", destination),
              };
            },
            backupSettings() {
              const backup = path.join(target, "backups", "settings.json");
              fs.mkdirSync(path.dirname(backup), { recursive: true });
              fs.copyFileSync(settingsPath, backup);
            },
            run: runIsolated,
            readSettings: () => fs.readFileSync(settingsPath, "utf8"),
            rewriteSettings: (content) => fs.writeFileSync(settingsPath, `${content}\n`),
            writeReceiptAtomic: (content) => {
              const receiptPath = path.join(target, "state", "pi-receipt.json");
              fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
              fs.writeFileSync(receiptPath, content);
            },
          }) as unknown as { kind: string; reason?: string; receipt?: unknown };
        }
        if (next !== "sync") throw new Error(`unexpected package operation: ${next}`);
        const sync = runIsolated({
          executable: process.execPath,
          args: [packageRunner, "sync", "--json"],
          environment: invocations[0]!.environment,
        });
        expect(sync.exitCode).toBe(0);
        expectRunnerOutput(sync, "sync", packageRunner);
        return { kind: "synced" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return runPiProjectionLifecycleSystem({
          operation: next as "install",
          targetDir: target,
          packageSource: PI_RUNTIME_CANDIDATE.package.source,
          engramBin,
          playwrightCliEnabled: false,
        }) as unknown;
      },
      async prepareProjectionUninstall(): Promise<never> {
        throw new Error("install must not prepare uninstall");
      },
      async completeProjectionUninstall(): Promise<never> {
        throw new Error("install must not complete uninstall");
      },
    });

    expect(trace).toEqual(["package:install", "projection:install", "package:sync"]);
    expect(result).toEqual(expect.objectContaining({ kind: "installed" }));
    expect(invocations).toEqual([
      expect.objectContaining({
        executable: piExecutable,
        args: ["install", `npm:jorgex-pi@file:${downloadedTarball}`, "--no-approve"],
      }),
      expect.objectContaining({
        executable: process.execPath,
        args: [packageRunner, "doctor", "--json"],
      }),
      expect.objectContaining({
        executable: process.execPath,
        args: [packageRunner, "sync", "--json"],
      }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      packages: [foreignSource, officialGentle, officialAdapter, { source: PI_RUNTIME_CANDIDATE.package.source, skills: [], prompts: [] }],
      foreignState,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "high",
    });
    expect(JSON.parse(fs.readFileSync(path.join(target, "backups", "settings.json"), "utf8"))).toEqual({
      packages: [foreignSource, officialGentle, officialAdapter],
      foreignState,
      defaultThinkingLevel: "high",
    });
    expect(fs.existsSync(packageRunner)).toBe(true);
    expect(fs.existsSync(path.join(target, "state", "pi-receipt.json"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "jorgex-pi", "sol-lifecycle.v1.json"))).toBe(true);

    const remove = runIsolated({
      executable: piExecutable,
      args: ["remove", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
      environment: invocations[0]!.environment,
    });
    expect(remove).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      packages: [foreignSource, officialGentle, officialAdapter],
      foreignState,
      defaultThinkingLevel: "high",
    });
    expect(fs.existsSync(packageRoot)).toBe(false);
  }, 60_000);

  it("exposes the exact Pi 0.8.29 initialization-diagnostics-v1 contract and provisional pending doctor", async () => {
    const root = path.resolve(piDirectory!);
    const manifest = readJson(path.join(root, "package.json")) as { name?: string; version?: string };
    expect(manifest).toMatchObject({ name: "jorgex-pi", version: "0.8.29" });

    const contract = readJson(path.join(root, "contract", "jorgex-pi.v1.json")) as { capabilities?: string[]; package?: { version?: string; source?: string } };
    expect(contract.package).toEqual({ name: "jorgex-pi", version: "0.8.29", source: "npm:jorgex-pi@0.8.29" });
    expect(contract.capabilities).toContain("initialization-diagnostics-v1");
    expect(contract.capabilities?.at(-1)).toBe("initialization-diagnostics-v1");

    const runner = readJson(path.join(root, "contract", "runner.v1.json")) as {
      experience?: { diagnostic?: string };
      permissions?: { diagnostic?: string };
    };
    expect(runner.experience?.diagnostic).toBe(
      "status reports pending, initialized, invalid, or unreadable from the receipt only; pending means the receipt is absent and requires a registered package; invalid preserves INVALID_PATH, INVALID_RECEIPT, or RECEIPT_TOO_LARGE and unreadable preserves READ_FAILED; status and doctor are read-only and never lock, write, or delete state",
    );
    expect(runner.permissions?.diagnostic).toBe(
      "permission state reports invalid or unreadable files without exposing their contents; a registered package also reports pending when the receipt is not initialized",
    );

    const schema = readJson(path.join(root, "contract", "schemas", "runner-response.v1.schema.json")) as {
      $defs: {
        statusResult: { required: string[]; properties: Record<string, unknown> };
        doctorResult: { properties: { checks: { minItems: number; maxItems: number; prefixItems: Array<{ properties: { id: { const: string } } }>; items: unknown } } };
        experience: unknown;
      };
    };
    expect(schema.$defs.statusResult.required).toEqual(["installation", "engram", "context7", "permissions", "experience"]);
    expect(schema.$defs.statusResult.properties.experience).toEqual({ $ref: "#/$defs/experience" });
    expect(schema.$defs.doctorResult.properties.checks.minItems).toBe(5);
    expect(schema.$defs.doctorResult.properties.checks.maxItems).toBe(5);
    expect(schema.$defs.doctorResult.properties.checks.items).toBe(false);
    expect(schema.$defs.doctorResult.properties.checks.prefixItems.map((item) => item.properties.id.const)).toEqual([
      "package",
      "engram",
      "context7",
      "permissions",
      "experience",
    ]);

    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-pending-cross-repo-"));
    temporaryPaths.push(target);
    const agentDir = path.join(target, "pi-agent");
    const packageRunner = path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
    const packageRoot = path.dirname(path.dirname(packageRunner));
    const pendingDoctor = `${JSON.stringify({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
      package: { name: "jorgex-pi", version: "0.8.29", root: packageRoot },
      result: {
        healthy: false,
        checks: [
          { id: "package", status: "ok" },
          { id: "engram", status: "ok" },
          { id: "context7", status: "ok" },
          { id: "permissions", status: "error" },
          { id: "experience", status: "error" },
        ],
      },
      error: {
        phase: "initialization",
        code: "INITIALIZATION_REQUIRED",
        message: "Pi initialization is pending: run sync to complete first initialization.",
        remedy: "Run jorgex-pi sync --json and retry.",
      },
    })}\n`;
    const candidate = {
      source: "npm:jorgex-pi@0.8.29",
      bytes: 1,
      sha256: "a".repeat(64),
      sha512: "b".repeat(128),
      package: { name: "jorgex-pi", version: "0.8.29", source: "npm:jorgex-pi@0.8.29" },
    } as const;

    let downloadDestination: string | null = null;
    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: path.join(target, "bin", "engram"),
      candidate,
    }, {
      download(destination: string) {
        downloadDestination = destination;
        return { path: destination, bytes: 1, sha256: "a".repeat(64), sha512: "b".repeat(128) };
      },
      backupSettings() {},
      run(invocation: { executable: string; args: string[]; environment: Record<string, string> }) {
        if (invocation.args[0] === "install") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: pendingDoctor, stderr: "" };
      },
      readSettings() {
        expect(downloadDestination).not.toBeNull();
        return JSON.stringify({ packages: [`npm:jorgex-pi@file:${downloadDestination}`] });
      },
      rewriteSettings() {},
      writeReceiptAtomic() {},
    });

    expect(result).toEqual(expect.objectContaining({ kind: "installed" }));
  }, 60_000);

});

describe("T43 provider-only parity: Stack sin protocolo Engram", () => {
  it("no distribuye fuente/sección/placeholder/interfaz Stack en ningún runtime", () => {
    const root = stackRoot();
    expect(fs.existsSync(path.join(root, STACK_ENGRAM_PROVIDER_ONLY.forbiddenSource.replace(/^stack\//, "")))).toBe(false);
    const sections = fs.readFileSync(path.join(root, "..", "src", "lib", "system-prompt-sections.ts"), "utf8");
    expect(sections).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenSection);
    const plugins = fs.readFileSync(path.join(root, "..", "src", "components", "plugins.ts"), "utf8");
    expect(plugins).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenPlaceholder);
    const types = fs.readFileSync(path.join(root, "..", "src", "adapters", "types.ts"), "utf8");
    expect(types).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenInterface);
    // Context7/browser/writing-style no se tocan en T43.
    expect(sections).toContain("context7");
    expect(sections).toContain("writing-style");
  });
});

// ---------------------------------------------------------------------------
// T52-RED: seam cross-repo compara el contrato productor 0.8.29 completo.
// Cuando JORGEX_PI_DIR se provee, lee el tag exacto
// bbaf80f09bd1512e21fe80f22b4aad61420a8800 read-only (git show, sin mutar el
// checkout) o el checkout si ya es 0.8.29, y compara capabilities completas.
// Cuando JORGEX_PI_TARBALL se provee, lee el tarball exacto read-only y
// compara el mismo contrato. Fuente independiente: contract/jorgex-pi.v1.json
// del tag Pi v0.8.29. Ambos exigen bridge y resto intacto en productor y en
// Stack (fixture + producción). No edita pin generado.
// ---------------------------------------------------------------------------

const T52_EXPECTED_PI_0_8_29_COMMIT = "bbaf80f09bd1512e21fe80f22b4aad61420a8800";
const T52_EXPECTED_PI_0_8_29_CAPABILITIES = [
  "foundation-contract-v1",
  "stack-snapshot-v2",
  "modular-system-prompts-v1",
  "runtime-agents-v1",
  "permission-gated-tools-v1",
  "structured-questions-v1",
  "web-access-v1",
  "goal-continuation-v1",
  "engram-official-bridge-v1",
  "engram-runtime-tools-v1",
  "context7-http-v1",
  "permissions-policy-v1",
  "permissions-upgrade-v1",
  "experience-defaults-v1",
  "chrome-devtools-handoff-v1",
  "playwright-handoff-v1",
  "runner-json-v1",
  "tui-branding-v1",
  "managed-primary-model-v1",
  "quality-receipt-contract-v1",
  "quality-capabilities-contract-v1",
  "initialization-diagnostics-v1",
] as const;

function t52ReadProducerContract(piDir: string): { version: string; capabilities: string[] } {
  const root = path.resolve(piDir);
  const checkoutFile = path.join(root, "contract", "jorgex-pi.v1.json");
  try {
    const checkout = readJson(checkoutFile) as { package?: { version?: unknown }; capabilities?: unknown };
    if (checkout.package?.version === "0.8.29" && Array.isArray(checkout.capabilities)) {
      return { version: "0.8.29", capabilities: checkout.capabilities as string[] };
    }
  } catch {
    // El checkout puede estar en otra versión; se intenta el tag exacto.
  }
  const tagOut = execFileSync("git", ["show", `${T52_EXPECTED_PI_0_8_29_COMMIT}:contract/jorgex-pi.v1.json`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tagContract = JSON.parse(tagOut) as { package?: { version?: unknown }; capabilities?: unknown };
  expect(tagContract.package?.version).toBe("0.8.29");
  expect(Array.isArray(tagContract.capabilities)).toBe(true);
  return { version: "0.8.29", capabilities: tagContract.capabilities as string[] };
}

const t52CrossRepo = piDirectory === undefined ? describe.skip : describe;
const t52Registry = registryTarball === undefined ? describe.skip : describe;

t52CrossRepo("[T52-RED] productor Pi 0.8.29 leído del tag exacto", () => {
  it("el checkout/tag productor contiene bridge y no legacy, resto intacto, y Stack lo iguala", async () => {
    const producer = t52ReadProducerContract(piDirectory!);
    expect(producer.capabilities).toContain("engram-official-bridge-v1");
    expect(producer.capabilities).not.toContain("mcp-adapter-v1");
    expect(producer.capabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);

    const fixtureCapabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
    expect(fixtureCapabilities).toContain("engram-official-bridge-v1");
    expect(fixtureCapabilities).not.toContain("mcp-adapter-v1");
    expect(fixtureCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(fixtureCapabilities).toEqual(producer.capabilities);

    const { PI_RUNTIME_REGISTRY } = await import("../src/lib/pi-runtime.js");
    const productionCapabilities = [...PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities];
    expect(productionCapabilities).toContain("engram-official-bridge-v1");
    expect(productionCapabilities).not.toContain("mcp-adapter-v1");
    expect(productionCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(productionCapabilities).toEqual(producer.capabilities);
  }, 60_000);
});

t52Registry("[T52-RED] tarball exacto Pi 0.8.29 con contrato productor completo", () => {
  it("el tarball contiene bridge y no legacy, resto intacto, y Stack lo iguala", async () => {
    const tarball = path.resolve(registryTarball!);
    expectExactArtifactIntegrity(tarball);
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as {
      package?: { version?: unknown };
      capabilities?: unknown;
    };
    expect(contract.package?.version).toBe("0.8.29");
    const tarballCapabilities = contract.capabilities as string[];
    expect(tarballCapabilities).toContain("engram-official-bridge-v1");
    expect(tarballCapabilities).not.toContain("mcp-adapter-v1");
    expect(tarballCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);

    const fixtureCapabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
    expect(fixtureCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(fixtureCapabilities).toEqual(tarballCapabilities);

    const { PI_RUNTIME_REGISTRY } = await import("../src/lib/pi-runtime.js");
    const productionCapabilities = [...PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities];
    expect(productionCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(productionCapabilities).toEqual(tarballCapabilities);
  }, 60_000);
});
