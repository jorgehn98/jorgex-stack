import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext, RuntimeId } from "../src/adapters/types.js";
import { loadCanonicalMcp, type CanonicalHooks } from "../src/lib/canonical.js";
import { readTomlSection } from "../src/lib/filemerge.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const RUNTIMES = ["claude-code", "codex", "opencode"] as const;
const DEVTOOLS_SERVER = "chrome-devtools";
const MODELS: RuntimeModelMap = {
  strong: { model: "test/strong" },
  standard: { model: "test/standard" },
  cheap: { model: "test/cheap" },
};
const tempDirs: string[] = [];

type DevToolsSelectionContext = InstallContext & {
  enabledMcpServers: ReadonlySet<string>;
  ownedMcpServers: ReadonlySet<string>;
};

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function adapterFor(runtime: RuntimeId): Adapter {
  switch (runtime) {
    case "claude-code": return claudeCodeAdapter;
    case "codex": return codexAdapter;
    case "opencode": return opencodeAdapter;
  }
}

function configFile(runtime: RuntimeId, configDir: string): string {
  switch (runtime) {
    case "claude-code": return path.join(path.dirname(configDir), `${path.basename(configDir)}.json`);
    case "codex": return path.join(configDir, "config.toml");
    case "opencode": return path.join(configDir, "opencode.json");
  }
}

function context(runtime: RuntimeId, configDir: string, enabled: boolean, owned = false): DevToolsSelectionContext {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: MODELS,
    warnings: [],
    enabledMcpServers: new Set(enabled ? [DEVTOOLS_SERVER] : []),
    ownedMcpServers: new Set(owned ? [DEVTOOLS_SERVER] : []),
  };
}

function writeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ opencode: MODELS }) + "\n");
}

async function importInstallModule(homeDir: string): Promise<typeof import("../src/install.js")> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    vi.resetModules();
    return await import("../src/install.js");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

function writeUserConfig(runtime: RuntimeId, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (runtime === "codex") {
    fs.writeFileSync(
      file,
      '# user comment must survive\nmodel = "user-model"\nuser_marker = "preserve"\n\n[mcp_servers.user-server]\ncommand = "user-command"\n',
    );
    return;
  }

  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  fs.writeFileSync(
    file,
    JSON.stringify({
      user_marker: "preserve",
      [mcpKey]: { "user-server": { type: "remote", url: "https://example.invalid/mcp" } },
    }) + "\n",
  );
}

function plannedContent(adapter: Adapter, ctx: DevToolsSelectionContext): string {
  const [action] = adapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
  expect(action).toMatchObject({ kind: "write" });
  return (action as { content: string }).content;
}

function expectUserConfigPreserved(runtime: RuntimeId, content: string): void {
  if (runtime === "codex") {
    expect(content).toContain("# user comment must survive");
    expect(content).toContain('user_marker = "preserve"');
    expect(readTomlSection(content, "mcp_servers.user-server")).toContain('command = "user-command"');
    return;
  }

  const parsed = JSON.parse(content) as Record<string, Record<string, unknown> | string>;
  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  expect(parsed.user_marker).toBe("preserve");
  expect(parsed[mcpKey]).toMatchObject({ "user-server": { url: "https://example.invalid/mcp" } });
}

function expectDevToolsServer(runtime: RuntimeId, content: string): void {
  const expectedArgs = [
    "dlx",
    "chrome-devtools-mcp@1.6.0",
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];

  if (runtime === "codex") {
    const section = readTomlSection(content, `mcp_servers.${DEVTOOLS_SERVER}`);
    expect(section).not.toBeNull();
    if (section === null) return;
    expect(section).toContain('command = "pnpm"');
    expect(section).toContain(
      'args = ["dlx", "chrome-devtools-mcp@1.6.0", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"]',
    );
    return;
  }

  const parsed = JSON.parse(content) as Record<string, Record<string, Record<string, unknown>>>;
  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  const server = parsed[mcpKey]![DEVTOOLS_SERVER]!;
  if (runtime === "opencode") {
    expect(server).toMatchObject({ type: "local", command: ["pnpm", ...expectedArgs] });
  } else {
    expect(server).toMatchObject({ type: "stdio", command: "pnpm", args: expectedArgs });
  }
}

function expectDevToolsAbsent(runtime: RuntimeId, content: string): void {
  if (runtime === "codex") {
    expect(readTomlSection(content, `mcp_servers.${DEVTOOLS_SERVER}`)).toBeNull();
    return;
  }

  const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>;
  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  expect(parsed[mcpKey]?.[DEVTOOLS_SERVER]).toBeUndefined();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("optional Chrome DevTools MCP", () => {
  it("declares the full, telemetry-disabled server as default-disabled canonical metadata", () => {
    const server = loadCanonicalMcp(stackRoot()).servers[DEVTOOLS_SERVER] as {
      transport?: string;
      command?: string;
      args?: string[];
      optional?: boolean;
      defaultEnabled?: boolean;
    } | undefined;

    expect(server).toMatchObject({
      transport: "stdio",
      command: "pnpm",
      optional: true,
      defaultEnabled: false,
    });
    expect(server?.args).toEqual([
      "dlx",
      "chrome-devtools-mcp@1.6.0",
      "--isolated",
      "--redact-network-headers",
      "--no-performance-crux",
      "--no-usage-statistics",
    ]);
  });

  it("defaults each runtime to disabled while preserving explicit per-runtime opt-ins", async () => {
    const mod = await import("../src/lib/tool-preferences.js") as {
      devtoolsMcpPreferenceFile?: (stateDir?: string) => string;
      loadDevtoolsMcpPreference?: (file: string, runtime: RuntimeId) => boolean;
      saveDevtoolsMcpPreference?: (file: string, runtime: RuntimeId, enabled: boolean) => void;
      loadDevtoolsMcpOwnership?: (file: string, runtime: RuntimeId, server: string) => boolean;
      saveDevtoolsMcpOwnership?: (file: string, runtime: RuntimeId, server: string, owned: boolean) => void;
    };
    expect(mod.devtoolsMcpPreferenceFile).toBeTypeOf("function");
    expect(mod.loadDevtoolsMcpPreference).toBeTypeOf("function");
    expect(mod.saveDevtoolsMcpPreference).toBeTypeOf("function");
    expect(mod.loadDevtoolsMcpOwnership).toBeTypeOf("function");
    expect(mod.saveDevtoolsMcpOwnership).toBeTypeOf("function");

    const file = mod.devtoolsMcpPreferenceFile!(tempDir());
    for (const runtime of RUNTIMES) expect(mod.loadDevtoolsMcpPreference!(file, runtime)).toBe(false);

    mod.saveDevtoolsMcpPreference!(file, "claude-code", true);
    mod.saveDevtoolsMcpPreference!(file, "codex", false);

    expect(mod.loadDevtoolsMcpPreference!(file, "claude-code")).toBe(true);
    expect(mod.loadDevtoolsMcpPreference!(file, "codex")).toBe(false);
    expect(mod.loadDevtoolsMcpPreference!(file, "opencode")).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      enabled: { "claude-code": true, codex: false },
    });

    mod.saveDevtoolsMcpOwnership!(file, "claude-code", DEVTOOLS_SERVER, true);
    expect(mod.loadDevtoolsMcpOwnership!(file, "claude-code", DEVTOOLS_SERVER)).toBe(true);
    expect(mod.loadDevtoolsMcpOwnership!(file, "codex", DEVTOOLS_SERVER)).toBe(false);
  });

  it.each(RUNTIMES)("%s preserves an identical manual server when disabled or uninstalled", (runtime) => {
    const root = tempDir();
    const configDir = runtime === "claude-code" ? path.join(root, ".claude") : path.join(root, runtime);
    const file = configFile(runtime, configDir);
    const adapter = adapterFor(runtime);
    const disabled = context(runtime, configDir, false);
    const enabled = context(runtime, configDir, true);
    const hooks = { hooks: {} } as CanonicalHooks;

    writeUserConfig(runtime, file);
    const manualContent = plannedContent(adapter, enabled);
    fs.writeFileSync(file, manualContent);

    const disabledContent = plannedContent(adapter, disabled);
    expectDevToolsServer(runtime, disabledContent);
    expectUserConfigPreserved(runtime, disabledContent);

    const uninstalled = adapter.planUnmerge(loadCanonicalMcp(stackRoot()), hooks, disabled)
      .find((action) => action.target === file);
    expect(uninstalled).toMatchObject({ kind: "write" });
    const uninstalledContent = (uninstalled as { content: string }).content;
    expectDevToolsServer(runtime, uninstalledContent);
    expectUserConfigPreserved(runtime, uninstalledContent);
  });

  it.each(RUNTIMES)("%s removes a stack-owned server when disabled or uninstalled", (runtime) => {
    const root = tempDir();
    const configDir = runtime === "claude-code" ? path.join(root, ".claude") : path.join(root, runtime);
    const file = configFile(runtime, configDir);
    const adapter = adapterFor(runtime);
    const enabled = context(runtime, configDir, true);
    const ownedDisabled = context(runtime, configDir, false, true);
    const hooks = { hooks: {} } as CanonicalHooks;

    writeUserConfig(runtime, file);
    const enabledContent = plannedContent(adapter, enabled);
    fs.writeFileSync(file, enabledContent);

    const disabledContent = plannedContent(adapter, ownedDisabled);
    expectDevToolsAbsent(runtime, disabledContent);
    expectUserConfigPreserved(runtime, disabledContent);

    fs.writeFileSync(file, enabledContent);
    const uninstalled = adapter.planUnmerge(loadCanonicalMcp(stackRoot()), hooks, ownedDisabled)
      .find((action) => action.target === file);
    expect(uninstalled).toMatchObject({ kind: "write" });
    const uninstalledContent = (uninstalled as { content: string }).content;
    expectDevToolsAbsent(runtime, uninstalledContent);
    expectUserConfigPreserved(runtime, uninstalledContent);
  });

  it("claims ownership only after its DevTools config entry is written", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    const install = await importInstallModule(homeDir);
    const adapter = install.ADAPTERS.opencode!;
    const originalDetect = adapter.detect;
    adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });

    try {
      await expect(install.runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        devtoolsMcpSelection: { opencode: true },
      })).resolves.toBe(0);

      expectDevToolsServer("opencode", fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
      expect(JSON.parse(fs.readFileSync(path.join(homeDir, ".jorgex-stack", "devtools-mcp.json"), "utf8"))).toMatchObject({
        owned: { opencode: { [DEVTOOLS_SERVER]: true } },
      });
    } finally {
      adapter.detect = originalDetect;
    }
  });

  it("does not claim ownership when the config write fails", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      vi.resetModules();
      vi.doMock("../src/lib/fsx.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../src/lib/fsx.js")>();
        return {
          ...actual,
          writeText(file: string, content: string) {
            if (path.resolve(file) === path.resolve(path.join(configDir, "opencode.json"))) throw new Error("write failed");
            actual.writeText(file, content);
          },
        };
      });
      const install = await import("../src/install.js");
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      await expect(install.runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        devtoolsMcpSelection: { opencode: true },
      })).rejects.toThrow("write failed");

      const preferences = await import("../src/lib/tool-preferences.js") as {
        devtoolsMcpPreferenceFile: () => string;
        loadDevtoolsMcpOwnership?: (file: string, runtime: RuntimeId, server: string) => boolean;
      };
      expect(preferences.loadDevtoolsMcpOwnership).toBeTypeOf("function");
      expect(preferences.loadDevtoolsMcpOwnership!(preferences.devtoolsMcpPreferenceFile(), "opencode", DEVTOOLS_SERVER)).toBe(false);
      adapter.detect = originalDetect;
    } finally {
      vi.doUnmock("../src/lib/fsx.js");
      vi.resetModules();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});
