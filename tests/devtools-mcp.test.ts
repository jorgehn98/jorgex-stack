import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext, RuntimeId } from "../src/adapters/types.js";
import { loadCanonicalMcp, materializeCanonicalDevtoolsServer, type CanonicalHooks, type CanonicalMcp } from "../src/lib/canonical.js";
import { writeText as writeRealText } from "../src/lib/fsx.js";
import { readTomlSection } from "../src/lib/filemerge.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { planMcp } from "../src/components/mcp.js";

// Unconditional test guard: no save may reach the real HOME. Every
// savePlaywrightCliPreference/saveDevtoolsMcpPreference/saveDevtoolsMcpOwnership
// call must target a strict child of the currently active fake HOME when a
// sandbox is active, or an explicit temp file under os.tmpdir() otherwise.
// Direct temp file helper tests remain allowed; default destinations outside
// the active temp home are refused before delegating to the real save.
const guard = vi.hoisted(() => ({ allowedHome: null as string | null }));

// Provider-flow fixtures use synthetic tarball bytes. The real artifact
// probe is covered in browser-provider-resolution; flow tests stub execution.
vi.mock("../src/lib/browser-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/browser-provider.js")>()),
  verifyDevtoolsCliArtifact: vi.fn(async () => ({ binPath: "/isolated/stage/bin", version: FLOW_VERSION })),
}));

vi.mock("../src/lib/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/paths.js")>();
  const pathMod = await import("node:path");
  return {
    ...actual,
    get HOME() {
      return guard.allowedHome !== null ? pathMod.resolve(guard.allowedHome) : actual.HOME;
    },
    dataDir: () => {
      if (guard.allowedHome !== null) return pathMod.join(pathMod.resolve(guard.allowedHome), ".jorgex-stack");
      return actual.dataDir();
    },
  };
});

vi.mock("../src/lib/tool-preferences.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tool-preferences.js")>();
  const pathMod = await import("node:path");
  const osMod = await import("node:os");
  function isStrictChildOf(child: string, root: string): boolean {
    const relative = pathMod.relative(pathMod.resolve(root), pathMod.resolve(child));
    return relative !== ""
      && relative !== ".."
      && !relative.startsWith(`..${pathMod.sep}`)
      && !pathMod.isAbsolute(relative);
  }
  function assertSandboxed(file: string, fn: string): void {
    const allowed = guard.allowedHome;
    const normalizedFile = pathMod.resolve(file);
    if (allowed !== null) {
      if (!isStrictChildOf(normalizedFile, pathMod.resolve(allowed))) {
        throw new Error(`test guard: ${fn} blocked outside sandbox: ${file} not under ${allowed}`);
      }
      return;
    }
    const tmp = pathMod.resolve(osMod.tmpdir());
    if (!isStrictChildOf(normalizedFile, tmp)) {
      throw new Error(`test guard: ${fn} blocked outside sandbox (no allowedHome) for ${file}`);
    }
  }
  function sandboxedStateDir(explicit?: string): string | undefined {
    if (explicit !== undefined) return explicit;
    if (guard.allowedHome !== null) return pathMod.join(pathMod.resolve(guard.allowedHome), ".jorgex-stack");
    return undefined;
  }
  return {
    ...actual,
    playwrightCliPreferenceFile: (stateDir?: string) => {
      const resolved = sandboxedStateDir(stateDir);
      return resolved === undefined ? actual.playwrightCliPreferenceFile() : actual.playwrightCliPreferenceFile(resolved);
    },
    devtoolsMcpPreferenceFile: (stateDir?: string) => {
      const resolved = sandboxedStateDir(stateDir);
      return resolved === undefined ? actual.devtoolsMcpPreferenceFile() : actual.devtoolsMcpPreferenceFile(resolved);
    },
    savePlaywrightCliPreference: (...args: Parameters<typeof actual.savePlaywrightCliPreference>) => {
      assertSandboxed(args[0], "savePlaywrightCliPreference");
      return actual.savePlaywrightCliPreference(...args);
    },
    saveDevtoolsMcpPreference: (...args: Parameters<typeof actual.saveDevtoolsMcpPreference>) => {
      assertSandboxed(args[0], "saveDevtoolsMcpPreference");
      return actual.saveDevtoolsMcpPreference(...args);
    },
    saveDevtoolsMcpOwnership: (...args: Parameters<typeof actual.saveDevtoolsMcpOwnership>) => {
      assertSandboxed(args[0], "saveDevtoolsMcpOwnership");
      return actual.saveDevtoolsMcpOwnership(...args);
    },
  };
});

function isStrictChild(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  guard.allowedHome = path.resolve(homeDir);
  try {
    vi.resetModules();
    return await run();
  } finally {
    guard.allowedHome = null;
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

async function assertPreferencesSandboxed(homeDir: string): Promise<void> {
  const { dataDir } = await import("../src/lib/paths.js");
  const { playwrightCliPreferenceFile, devtoolsMcpPreferenceFile } = await import("../src/lib/tool-preferences.js");
  expect(isStrictChild(playwrightCliPreferenceFile(dataDir()), homeDir)).toBe(true);
  expect(isStrictChild(devtoolsMcpPreferenceFile(dataDir()), homeDir)).toBe(true);
}

function seedDevtoolsObserved(homeDir: string, enabled: Record<string, boolean> = { opencode: true }): void {
  const file = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    enabled,
    owned: {},
    observed: { ...OBSERVED_DEVTOOLS },
  }) + "\n");
}

const RUNTIMES = ["claude-code", "codex", "opencode"] as const;
const DEVTOOLS_SERVER = "chrome-devtools";
const MODELS: RuntimeModelMap = {
  strong: { model: "test/strong" },
  standard: { model: "test/standard" },
  cheap: { model: "test/cheap" },
};
const tempDirs: string[] = [];

// Synthetic test-only observed DevTools release shared by every test in this
// file. It is a fixture, never a future version selector: the exact version
// and SRI travel together from the verified per-machine observation.
const OBSERVED_DEVTOOLS = {
  version: "9.9.20",
  integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}`,
};

// Synthetic test-only provider release for the install flow, shared by the
// opt-in tracer and the ownership tests so no test ever hits live npm. The
// exact version/URL/SRI travel together from the stubbed registry.
const FLOW_VERSION = "9.9.20";
const FLOW_TARBALL = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-9.9.20.tgz";
const FLOW_BYTES = Buffer.from("synthetic-chrome-devtools-mcp-tarball-9.9.20\n");
const FLOW_INTEGRITY = `sha512-${createHash("sha512").update(FLOW_BYTES).digest("base64")}`;
const FLOW_METADATA = "https://registry.npmjs.org/chrome-devtools-mcp";

function flowPackument(): unknown {
  return {
    name: "chrome-devtools-mcp",
    "dist-tags": { latest: FLOW_VERSION },
    versions: {
      [FLOW_VERSION]: {
        name: "chrome-devtools-mcp",
        version: FLOW_VERSION,
        dist: { tarball: FLOW_TARBALL, integrity: FLOW_INTEGRITY },
      },
    },
  };
}

function stubFlowFetch(events: string[], tarballBytes: Buffer): void {
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    events.push(`fetch ${url}`);
    if (url === FLOW_TARBALL) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(tarballBytes.slice());
          controller.close();
        },
      });
      const tarball = new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
      Object.defineProperty(tarball, "url", { value: url });
      return tarball;
    }
    const metadata = new Response(JSON.stringify(flowPackument()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(metadata, "url", { value: url });
    return metadata;
  };
  vi.stubGlobal("fetch", stub);
}

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

function materializedCanonical(): CanonicalMcp {
  const canonical = loadCanonicalMcp(stackRoot());
  const server = canonical.servers[DEVTOOLS_SERVER];
  expect(server).toBeDefined();
  return {
    ...canonical,
    servers: {
      ...canonical.servers,
      [DEVTOOLS_SERVER]: materializeCanonicalDevtoolsServer(server!, OBSERVED_DEVTOOLS),
    },
  };
}

function plannedContent(adapter: Adapter, ctx: DevToolsSelectionContext): string {
  const [action] = adapter.planMainConfig(materializedCanonical(), ctx);
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
    `chrome-devtools-mcp@${OBSERVED_DEVTOOLS.version}`,
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
      `args = ["dlx", "chrome-devtools-mcp@${OBSERVED_DEVTOOLS.version}", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"]`,
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

function addUserFieldToDevToolsServer(runtime: RuntimeId, content: string): string {
  if (runtime === "codex") {
    return content.replace(
      `args = ["dlx", "chrome-devtools-mcp@${OBSERVED_DEVTOOLS.version}", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"]`,
      '$&\nuser_marker = "preserve"',
    );
  }

  const root = JSON.parse(content) as Record<string, Record<string, Record<string, unknown>>>;
  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  root[mcpKey]![DEVTOOLS_SERVER]! = {
    ...root[mcpKey]![DEVTOOLS_SERVER]!,
    user_marker: { source: "manual" },
  };
  return JSON.stringify(root, null, 2) + "\n";
}

function devToolsServerSnapshot(runtime: RuntimeId, content: string): unknown {
  if (runtime === "codex") return readTomlSection(content, `mcp_servers.${DEVTOOLS_SERVER}`);

  const root = JSON.parse(content) as Record<string, Record<string, Record<string, unknown>>>;
  const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
  return root[mcpKey]![DEVTOOLS_SERVER];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  guard.allowedHome = null;
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
      "chrome-devtools-mcp@{{VERSION}}",
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
    const uninstalled = adapter.planUnmerge(materializedCanonical(), hooks, ownedDisabled)
      .find((action) => action.target === file);
    expect(uninstalled).toMatchObject({ kind: "write" });
    const uninstalledContent = (uninstalled as { content: string }).content;
    expectDevToolsAbsent(runtime, uninstalledContent);
    expectUserConfigPreserved(runtime, uninstalledContent);
  });

  it.each(RUNTIMES)("%s disables a legacy owned server without an observed version", (runtime) => {
    const root = tempDir();
    const configDir = runtime === "claude-code" ? path.join(root, ".claude") : path.join(root, runtime);
    const file = configFile(runtime, configDir);
    const adapter = adapterFor(runtime);
    writeUserConfig(runtime, file);
    const oldObserved = { ...OBSERVED_DEVTOOLS, version: "1.6.0" };
    const legacyCanonical = loadCanonicalMcp(stackRoot());
    const legacyServer = materializeCanonicalDevtoolsServer(legacyCanonical.servers[DEVTOOLS_SERVER]!, oldObserved);
    const [installed] = adapter.planMainConfig({ servers: { ...legacyCanonical.servers, [DEVTOOLS_SERVER]: legacyServer } }, {
      ...context(runtime, configDir, true), devtoolsMcpObservedVersion: oldObserved,
    });
    expect(installed).toMatchObject({ kind: "write" });
    fs.writeFileSync(file, (installed as { content: string }).content);

    const disabled = context(runtime, configDir, false, true);
    const actions = planMcp(adapter, disabled);
    const configAction = actions.find((action) => action.kind === "write" && action.target === file);
    expect(configAction).toBeDefined();
    const content = (configAction as { content: string }).content;
    expectDevToolsAbsent(runtime, content);
    expectUserConfigPreserved(runtime, content);
  });

  it.each(RUNTIMES)("%s releases ownership but preserves a formerly owned server extended by the user", (runtime) => {
    const root = tempDir();
    const configDir = runtime === "claude-code" ? path.join(root, ".claude") : path.join(root, runtime);
    const file = configFile(runtime, configDir);
    const adapter = adapterFor(runtime);
    const enabled = context(runtime, configDir, true);
    const ownedDisabled = context(runtime, configDir, false, true);
    const hooks = { hooks: {} } as CanonicalHooks;

    writeUserConfig(runtime, file);
    const extendedContent = addUserFieldToDevToolsServer(runtime, plannedContent(adapter, enabled));
    const originalServer = devToolsServerSnapshot(runtime, extendedContent);
    fs.writeFileSync(file, extendedContent);

    const [syncAction] = adapter.planMainConfig(loadCanonicalMcp(stackRoot()), ownedDisabled);
    expect(syncAction).toMatchObject({ kind: "write", mcpOwnership: [{ server: DEVTOOLS_SERVER, owned: false }] });
    expect(devToolsServerSnapshot(runtime, (syncAction as { content: string }).content)).toEqual(originalServer);

    const uninstallAction = adapter.planUnmerge(loadCanonicalMcp(stackRoot()), hooks, ownedDisabled)
      .find((action) => action.target === file);
    expect(uninstallAction).toMatchObject({ kind: "write", mcpOwnership: [{ server: DEVTOOLS_SERVER, owned: false }] });
    expect(devToolsServerSnapshot(runtime, (uninstallAction as { content: string }).content)).toEqual(originalServer);
  });

  it("claims ownership only after its DevTools config entry is written", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      await assertPreferencesSandboxed(homeDir);
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      const fetchEvents: string[] = [];

      try {
        stubFlowFetch(fetchEvents, FLOW_BYTES);
        try {
          await expect(install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            devtoolsMcpSelection: { opencode: true },
          })).resolves.toBe(0);

          expectDevToolsServer("opencode", fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
          const preferenceRaw = fs.readFileSync(path.join(homeDir, ".jorgex-stack", "devtools-mcp.json"), "utf8");
          expect(JSON.parse(preferenceRaw)).toMatchObject({
            enabled: { opencode: true },
            owned: { opencode: { [DEVTOOLS_SERVER]: true } },
          });
          expect(preferenceRaw).toContain(FLOW_VERSION);
          expect(preferenceRaw).toContain(FLOW_INTEGRITY);
          expect(fetchEvents).toEqual([`fetch ${FLOW_METADATA}`, `fetch ${FLOW_TARBALL}`]);
        } finally {
          vi.unstubAllGlobals();
        }
      } finally {
        adapter.detect = originalDetect;
      }
    });
  });

  it("does not claim ownership when the config write fails", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    await withTempHome(homeDir, async () => {
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
      try {
        stubFlowFetch([], FLOW_BYTES);
        const install = await import("../src/install.js");
        await assertPreferencesSandboxed(homeDir);
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
          })).rejects.toThrow("write failed");

          const preferences = await import("../src/lib/tool-preferences.js") as {
            devtoolsMcpPreferenceFile: () => string;
            loadDevtoolsMcpOwnership?: (file: string, runtime: RuntimeId, server: string) => boolean;
          };
          expect(preferences.loadDevtoolsMcpOwnership).toBeTypeOf("function");
          expect(preferences.loadDevtoolsMcpOwnership!(preferences.devtoolsMcpPreferenceFile(), "opencode", DEVTOOLS_SERVER)).toBe(false);
        } finally {
          adapter.detect = originalDetect;
        }
      } finally {
        vi.unstubAllGlobals();
        vi.doUnmock("../src/lib/fsx.js");
      }
    });
  });
});

describe("DevTools observed-version materialization [T14-RED]", () => {
  // The observed record stands for the verified per-machine observation in
  // devtools-mcp.json (see browser-preferences-safety); the shared planMcp
  // seam only consumes its version. Integrity proves verified-ness of the
  // fixture. Adapters keep formatting already-materialized argv.
  const OBSERVED = OBSERVED_DEVTOOLS;
  const EXPECTED_ARGS = [
    "dlx",
    `chrome-devtools-mcp@${OBSERVED_DEVTOOLS.version}`,
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];

  function observedContext(
    runtime: RuntimeId,
    configDir: string,
    observed: typeof OBSERVED | undefined,
  ): DevToolsSelectionContext {
    return {
      ...context(runtime, configDir, true),
      devtoolsMcpObservedVersion: observed,
    } as DevToolsSelectionContext;
  }

  function plannedObservedContent(adapter: Adapter, ctx: DevToolsSelectionContext): string {
    const [action] = planMcp(adapter, ctx);
    expect(action).toMatchObject({ kind: "write" });
    return (action as { content: string }).content;
  }

  function plannedDevtoolsArgs(runtime: RuntimeId, content: string): string[] {
    if (runtime === "codex") {
      const section = readTomlSection(content, `mcp_servers.${DEVTOOLS_SERVER}`);
      expect(section).not.toBeNull();
      const match = /args = (\[.*\])/.exec(section ?? "");
      expect(match?.[1]).toBeDefined();
      return JSON.parse(match![1]!) as string[];
    }
    const parsed = JSON.parse(content) as Record<string, Record<string, Record<string, unknown>>>;
    const mcpKey = runtime === "claude-code" ? "mcpServers" : "mcp";
    const server = parsed[mcpKey]![DEVTOOLS_SERVER]!;
    if (runtime === "opencode") {
      const command = server["command"] as string[];
      expect(command[0]).toBe("pnpm");
      return command.slice(1);
    }
    return server["args"] as string[];
  }

  it.each(RUNTIMES)("materializes the observed DevTools version for %s", (runtime) => {
    const root = tempDir();
    const configDir = runtime === "claude-code" ? path.join(root, ".claude") : path.join(root, runtime);
    const adapter = adapterFor(runtime);
    writeUserConfig(runtime, configFile(runtime, configDir));

    const content = plannedObservedContent(adapter, observedContext(runtime, configDir, OBSERVED));

    expect(plannedDevtoolsArgs(runtime, content)).toEqual(EXPECTED_ARGS);
    expect(content).not.toContain("{{VERSION}}");
    expect(content).not.toContain("1.6.0");
    expectUserConfigPreserved(runtime, content);
  });

  it("throws before planning without an observed version", () => {
    const root = tempDir();
    const configDir = path.join(root, "opencode");
    const adapter = adapterFor("opencode");
    const file = configFile("opencode", configDir);
    writeUserConfig("opencode", file);
    const raw = fs.readFileSync(file, "utf8");

    expect(() => planMcp(adapter, context("opencode", configDir, true))).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it("throws for a prerelease observed version without planning", () => {
    const root = tempDir();
    const configDir = path.join(root, "opencode");
    const adapter = adapterFor("opencode");
    writeUserConfig("opencode", configFile("opencode", configDir));
    const prerelease = { version: "9.9.20-beta.1", integrity: OBSERVED.integrity };

    expect(() => planMcp(adapter, observedContext("opencode", configDir, prerelease))).toThrow();
  });

  it("keeps the disabled server absent even with an observed version", () => {
    const root = tempDir();
    const configDir = path.join(root, "opencode");
    const adapter = adapterFor("opencode");
    writeUserConfig("opencode", configFile("opencode", configDir));

    const content = plannedObservedContent(adapter, {
      ...context("opencode", configDir, false),
      devtoolsMcpObservedVersion: OBSERVED,
    } as DevToolsSelectionContext);

    expectDevToolsAbsent("opencode", content);
    expectUserConfigPreserved("opencode", content);
  });

  it("keeps the canonical DevTools server a flag-only version template", () => {
    const server = loadCanonicalMcp(stackRoot()).servers[DEVTOOLS_SERVER] as { args?: unknown };
    expect(server?.args).toContain("chrome-devtools-mcp@{{VERSION}}");
    expect(JSON.stringify(server?.args)).not.toContain("1.6.0");
  });
});

describe("DevTools verified-provider opt-in [T14-RED]", () => {
  // The config assertion pins `chrome-devtools-mcp@9.9.20`, never a floating
  // tag; the provider fixture itself is shared at file scope above.
  const FLOW_FLAGS = [
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];

  it("verifies the provider release before writing config and records the observed opt-in", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      await assertPreferencesSandboxed(homeDir);
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      const configFile = path.join(configDir, "opencode.json");
      writeUserConfig("opencode", configFile);
      const fetchEvents: string[] = [];

      try {
        stubFlowFetch(fetchEvents, FLOW_BYTES);
        try {
          await expect(install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            devtoolsMcpSelection: { opencode: true },
          })).resolves.toBe(0);

          const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
            mcp?: Record<string, { command?: unknown }>;
          };
          expect(config.mcp?.[DEVTOOLS_SERVER]?.command).toEqual([
            "pnpm",
            "dlx",
            `chrome-devtools-mcp@${FLOW_VERSION}`,
            ...FLOW_FLAGS,
          ]);
          expect(JSON.stringify(config.mcp?.[DEVTOOLS_SERVER])).not.toContain("latest");

          const preferenceFile = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
          const preferenceRaw = fs.readFileSync(preferenceFile, "utf8");
          const preference = JSON.parse(preferenceRaw) as {
            enabled?: Record<string, boolean>;
            owned?: Record<string, Record<string, boolean>>;
          };
          expect(preference.enabled).toMatchObject({ opencode: true });
          expect(preferenceRaw).toContain(FLOW_VERSION);
          expect(preferenceRaw).toContain(FLOW_INTEGRITY);
          expect(preference.owned).toMatchObject({ opencode: { [DEVTOOLS_SERVER]: true } });
          expectUserConfigPreserved("opencode", fs.readFileSync(configFile, "utf8"));
          expect(fetchEvents).toEqual([`fetch ${FLOW_METADATA}`, `fetch ${FLOW_TARBALL}`]);
        } finally {
          vi.unstubAllGlobals();
        }
      } finally {
        adapter.detect = originalDetect;
      }
    });
  });

  it("writes nothing and marks no opt-in when the tarball integrity mismatches", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      await assertPreferencesSandboxed(homeDir);
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      const configFile = path.join(configDir, "opencode.json");
      writeUserConfig("opencode", configFile);
      const rawConfig = fs.readFileSync(configFile, "utf8");
      const preferenceFile = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
      const fetchEvents: string[] = [];

      try {
        stubFlowFetch(fetchEvents, Buffer.from("tampered-tarball-bytes\n"));
        try {
          const outcome = await install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            devtoolsMcpSelection: { opencode: true },
          }).then(
            (code: number) => ({ code }),
            () => ({ code: "threw" as const }),
          );

          expect(outcome.code === "threw" || outcome.code !== 0).toBe(true);
          expect(fs.readFileSync(configFile, "utf8")).toBe(rawConfig);
          if (fs.existsSync(preferenceFile)) {
            const preference = JSON.parse(fs.readFileSync(preferenceFile, "utf8")) as {
              enabled?: Record<string, boolean>;
              owned?: Record<string, Record<string, boolean>>;
            };
            expect(preference.enabled?.opencode).not.toBe(true);
            expect(preference.owned?.opencode?.[DEVTOOLS_SERVER]).not.toBe(true);
          }
          expect(fetchEvents).toEqual([`fetch ${FLOW_METADATA}`, `fetch ${FLOW_TARBALL}`]);
        } finally {
          vi.unstubAllGlobals();
        }
      } finally {
        adapter.detect = originalDetect;
      }
    });
  });

  it.each(["sync", "dry-run", "target-dir"] as const)("performs no provider fetch for %s", async (kind) => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const configDir = kind === "target-dir" ? targetDir : path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    seedDevtoolsObserved(homeDir, { opencode: true });
    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      await assertPreferencesSandboxed(homeDir);
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      const fetchEvents: string[] = [];

      try {
        stubFlowFetch(fetchEvents, FLOW_BYTES);
        try {
          const code = await install.runInstall({
            runtimes: ["opencode"],
            ...(kind === "target-dir" ? { targetDir } : {}),
            dryRun: kind === "dry-run",
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            ...(kind === "sync" ? { command: "sync" as const } : {}),
            devtoolsMcpSelection: { opencode: true },
          });
          expect(code).toBe(kind === "target-dir" ? 1 : 0);
          if (kind === "sync") {
            expectDevToolsServer("opencode", fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
          }
        } finally {
          vi.unstubAllGlobals();
        }
      } finally {
        adapter.detect = originalDetect;
      }

      expect(fetchEvents).toEqual([]);
    });
  });
});

describe("DevTools flag-smoke integration [T14-RED]", () => {
  // The provider stub is shared at file scope; the smoke double below only
  // observes. One shared event log pins the full order: provider metadata,
  // then tarball, then smoke, then the first config write. The flow must
  // prove the four privacy flags on the staged artifact AFTER verification
  // and BEFORE the first config write.
  type SmokeInput = {
    artifactPath: string;
    stageDir: string;
    pnpmBin: string;
    release?: { version: string; tarballUrl: string; integrity: string };
  };

  async function importSmokeInstallModule(
    smokeCalls: SmokeInput[][],
    events: string[],
    smokeBehavior: "resolve" | "reject",
  ): Promise<typeof import("../src/install.js")> {
    vi.doMock("../src/lib/browser-provider.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/browser-provider.js")>("../src/lib/browser-provider.js")),
      verifyDevtoolsCliArtifact: (...args: unknown[]) => {
        smokeCalls.push(args as unknown as SmokeInput[]);
        events.push("smoke");
        if (smokeBehavior === "reject") return Promise.reject(new Error("DevTools CLI smoke: missing mandatory flag --isolated"));
        return Promise.resolve({ binPath: "/isolated/stage/bin", version: FLOW_VERSION });
      },
    }));
    vi.doMock("../src/lib/external-tools.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/external-tools.js")>("../src/lib/external-tools.js")),
      resolvePnpmBin: () => "/isolated/bin/pnpm",
    }));
    vi.doMock("../src/lib/fsx.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/fsx.js")>("../src/lib/fsx.js")),
      writeText: (file: string, content: string) => {
        events.push(`write ${file}`);
        writeRealText(file, content);
      },
    }));
    vi.resetModules();
    return import("../src/install.js");
  }

  function unmockSmokeInstall(): void {
    vi.unstubAllGlobals();
    vi.doUnmock("../src/lib/browser-provider.js");
    vi.doUnmock("../src/lib/external-tools.js");
    vi.doUnmock("../src/lib/fsx.js");
  }

  it("proves the privacy flags on the staged artifact after verification and before the first config write", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    const configFile = path.join(configDir, "opencode.json");
    writeUserConfig("opencode", configFile);
    const events: string[] = [];
    const smokeCalls: SmokeInput[][] = [];
    stubFlowFetch(events, FLOW_BYTES);

    try {
      await withTempHome(homeDir, async () => {
        const install = await importSmokeInstallModule(smokeCalls, events, "resolve");
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

          expect(smokeCalls).toHaveLength(1);
          expect(smokeCalls[0]?.[0]).toMatchObject({
            pnpmBin: "/isolated/bin/pnpm",
            release: { version: FLOW_VERSION, tarballUrl: FLOW_TARBALL, integrity: FLOW_INTEGRITY },
          });
          const input = smokeCalls[0]?.[0] as SmokeInput;
          expect(path.isAbsolute(input.artifactPath)).toBe(true);
          expect(input.artifactPath.endsWith(".tgz")).toBe(true);
          expect(path.isAbsolute(input.stageDir)).toBe(true);
          const metaIdx = events.indexOf(`fetch ${FLOW_METADATA}`);
          const tarballIdx = events.indexOf(`fetch ${FLOW_TARBALL}`);
          const smokeIdx = events.indexOf("smoke");
          const firstWriteIdx = events.findIndex((event) => event.startsWith("write "));
          expect(metaIdx).toBeGreaterThanOrEqual(0);
          expect(tarballIdx).toBeGreaterThan(metaIdx);
          expect(smokeIdx).toBeGreaterThan(tarballIdx);
          expect(firstWriteIdx).toBeGreaterThan(smokeIdx);
          expectDevToolsServer("opencode", fs.readFileSync(configFile, "utf8"));
          const preferenceRaw = fs.readFileSync(path.join(homeDir, ".jorgex-stack", "devtools-mcp.json"), "utf8");
          expect(preferenceRaw).toContain(FLOW_VERSION);
          expect(preferenceRaw).toContain(FLOW_INTEGRITY);
          expectUserConfigPreserved("opencode", fs.readFileSync(configFile, "utf8"));
        } finally {
          adapter.detect = originalDetect;
        }
      });
    } finally {
      unmockSmokeInstall();
    }
  });

  it("fails the install without config or preference marks when the flag smoke rejects", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    const configFile = path.join(configDir, "opencode.json");
    writeUserConfig("opencode", configFile);
    const rawConfig = fs.readFileSync(configFile, "utf8");
    const preferenceFile = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
    const events: string[] = [];
    const smokeCalls: SmokeInput[][] = [];
    const fetchEvents: string[] = [];
    stubFlowFetch(fetchEvents, FLOW_BYTES);

    try {
      await withTempHome(homeDir, async () => {
        const install = await importSmokeInstallModule(smokeCalls, events, "reject");
        const adapter = install.ADAPTERS.opencode!;
        const originalDetect = adapter.detect;
        adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
        try {
          const outcome = await install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            devtoolsMcpSelection: { opencode: true },
          }).then(
            (code: number) => ({ code }),
            () => ({ code: "threw" as const }),
          );

          expect(outcome.code === "threw" || outcome.code !== 0).toBe(true);
          expect(smokeCalls).toHaveLength(1);
          expect(fs.readFileSync(configFile, "utf8")).toBe(rawConfig);
          expect(fs.existsSync(preferenceFile)).toBe(false);
          expect(events.filter((event) => event.startsWith("write "))).toEqual([]);
          expect(fetchEvents).toEqual([`fetch ${FLOW_METADATA}`, `fetch ${FLOW_TARBALL}`]);
        } finally {
          adapter.detect = originalDetect;
        }
      });
    } finally {
      unmockSmokeInstall();
    }
  });

  it.each(["no-opt-in", "dry-run", "target-dir", "sync"] as const)("invokes neither smoke nor provider fetch for %s", async (kind) => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const configDir = kind === "target-dir" ? targetDir : path.join(homeDir, ".config", "opencode");
    writeModelMap(homeDir);
    const events: string[] = [];
    const smokeCalls: SmokeInput[][] = [];
    const fetchEvents: string[] = [];
    stubFlowFetch(fetchEvents, FLOW_BYTES);

    try {
      await withTempHome(homeDir, async () => {
        const install = await importSmokeInstallModule(smokeCalls, events, "resolve");
        const adapter = install.ADAPTERS.opencode!;
        const originalDetect = adapter.detect;
        adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
        try {
          const code = await install.runInstall({
            runtimes: ["opencode"],
            ...(kind === "target-dir" ? { targetDir } : {}),
            dryRun: kind === "dry-run",
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            ...(kind === "sync" ? { command: "sync" as const } : {}),
            ...(kind === "no-opt-in" ? {} : { devtoolsMcpSelection: { opencode: true } }),
          });
          expect(code).toBe(kind === "no-opt-in" ? 0 : 1);
        } finally {
          adapter.detect = originalDetect;
        }
      });
    } finally {
      unmockSmokeInstall();
    }

    expect(smokeCalls).toEqual([]);
    expect(fetchEvents).toEqual([]);
  });
});
