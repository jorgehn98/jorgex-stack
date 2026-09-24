import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEVTOOLS_SERVER = "chrome-devtools";
const MODELS = {
  strong: { model: "test/strong" },
  standard: { model: "test/standard" },
  cheap: { model: "test/cheap" },
};

const mocks = vi.hoisted(() => ({
  detectPlaywrightCli: vi.fn(() => ({
    status: "current" as const,
    binPath: "C:/pnpm/playwright-cli.cmd",
    detectedVersion: "0.1.18",
  })),
  isPlaywrightBrowserReady: vi.fn<() => {
    status: "missing" | "unreadable";
    path: string;
    errorCode: string;
  }>(() => ({
    status: "missing" as const,
    path: "C:/Users/test/AppData/Local/ms-playwright",
    errorCode: "ENOENT",
  })),
  executePlaywrightToolAction: vi.fn(() => true),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock("@clack/prompts", () => mocks.prompts);

vi.mock("../src/lib/external-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/external-tools.js")>();
  return {
    ...actual,
    detectPlaywrightCli: mocks.detectPlaywrightCli,
    isPlaywrightBrowserReady: mocks.isPlaywrightBrowserReady,
    executePlaywrightToolAction: mocks.executePlaywrightToolAction,
  };
});

// Unconditional test guard: no save may reach the real HOME. Every
// savePlaywrightCliPreference/saveDevtoolsMcpPreference/saveDevtoolsMcpOwnership
// call must target a strict child of the currently active fake HOME when a
// sandbox is active, or an explicit temp file under os.tmpdir() otherwise.
// Direct temp file helper tests remain allowed; default destinations outside
// the active temp home are refused before delegating to the real save.
const guard = vi.hoisted(() => ({ allowedHome: null as string | null }));

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

function writeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ opencode: MODELS }) + "\n");
}

function writeDevtoolsConfig(configDir: string): string {
  const file = path.join(configDir, "opencode.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    mcp: {
      [DEVTOOLS_SERVER]: {
        type: "local",
        command: ["pnpm", "dlx", "chrome-devtools-mcp@1.6.0", "--no-usage-statistics"],
      },
    },
  }) + "\n");
  return file;
}

function hasDevtoolsServer(file: string): boolean {
  const content = JSON.parse(fs.readFileSync(file, "utf8")) as { mcp?: Record<string, unknown> };
  return content.mcp?.[DEVTOOLS_SERVER] !== undefined;
}

function setOnlyOpenCodeDetected(install: typeof import("../src/install.js"), configDir: string): () => void {
  const originals = Object.values(install.ADAPTERS).map((adapter) => [adapter, adapter.detect] as const);
  for (const adapter of Object.values(install.ADAPTERS)) {
    adapter.detect = () => ({
      id: adapter.id,
      name: adapter.name,
      installed: adapter.id === "opencode",
      binPath: null,
      configDir: adapter.id === "opencode" ? configDir : path.join(configDir, adapter.id),
    });
  }
  return () => {
    for (const [adapter, detect] of originals) adapter.detect = detect;
  };
}

async function assertPreferencesSandboxed(homeDir: string): Promise<void> {
  const { dataDir } = await import("../src/lib/paths.js");
  const { playwrightCliPreferenceFile, devtoolsMcpPreferenceFile } = await import("../src/lib/tool-preferences.js");
  expect(isStrictChild(playwrightCliPreferenceFile(dataDir()), homeDir)).toBe(true);
  expect(isStrictChild(devtoolsMcpPreferenceFile(dataDir()), homeDir)).toBe(true);
}

afterEach(() => {
  mocks.detectPlaywrightCli.mockClear();
  mocks.isPlaywrightBrowserReady.mockClear();
  mocks.executePlaywrightToolAction.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  guard.allowedHome = null;
  vi.resetModules();
});

describe("browser preference safety", () => {
  it("preserves a Pi enabled selection with file runtimes while keeping ownership file-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-browser-preference-"));
    const preference = path.join(root, "devtools-mcp.json");
    const initial = {
      version: 1,
      enabled: { opencode: true, codex: false },
      owned: { opencode: { [DEVTOOLS_SERVER]: true } },
    };

    try {
      fs.writeFileSync(preference, JSON.stringify(initial) + "\n");
      const preferences = await import("../src/lib/tool-preferences.js") as unknown as {
        loadDevtoolsMcpPreference(file: string, runtime: "pi"): boolean;
        saveDevtoolsMcpPreference(file: string, runtime: "pi", enabled: boolean): void;
        loadDevtoolsMcpOwnership(file: string, runtime: "pi", server: string): boolean;
        devtoolsMcpPreferenceError(file: string): string | null;
      };

      preferences.saveDevtoolsMcpPreference(preference, "pi", true);

      expect(preferences.loadDevtoolsMcpPreference(preference, "pi")).toBe(true);
      expect(JSON.parse(fs.readFileSync(preference, "utf8"))).toEqual({
        version: 1,
        enabled: { opencode: true, codex: false, pi: true },
        owned: { opencode: { [DEVTOOLS_SERVER]: true } },
      });
      expect(preferences.loadDevtoolsMcpOwnership(preference, "pi", DEVTOOLS_SERVER)).toBe(false);

      fs.writeFileSync(preference, JSON.stringify({
        version: 1,
        enabled: { pi: true },
        owned: { pi: { [DEVTOOLS_SERVER]: true } },
      }) + "\n");
      expect(preferences.devtoolsMcpPreferenceError(preference)).toMatch(/inv[aá]lida/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps real DevTools and Playwright state out of target-dir install and uninstall", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-browser-state-"));
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const stateDir = path.join(homeDir, ".jorgex-stack");
    const devtoolsPreference = path.join(stateDir, "devtools-mcp.json");
    const playwrightPreference = path.join(stateDir, "playwright-cli.json");
    const devtoolsState = JSON.stringify({ version: 1, enabled: { opencode: false }, owned: { opencode: { [DEVTOOLS_SERVER]: true } } }) + "\n";
    const playwrightState = JSON.stringify({ version: 1, enabled: true }) + "\n";

    try {
      writeModelMap(homeDir);
      fs.writeFileSync(devtoolsPreference, devtoolsState);
      fs.writeFileSync(playwrightPreference, playwrightState);

      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const { runUninstall } = await import("../src/uninstall.js");
        await assertPreferencesSandboxed(homeDir);
        const restoreDetect = setOnlyOpenCodeDetected(install, targetDir);
        try {
          const configFile = writeDevtoolsConfig(targetDir);
          const installCode = await install.runInstall({
            runtimes: ["opencode"],
            targetDir,
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            playwrightToolConsent: {
              command: "sync",
              interactive: false,
              yes: true,
              targetDir: true,
              explicitToolSelection: false,
              confirmed: false,
            },
          });
          const installPreserved = fs.readFileSync(devtoolsPreference, "utf8") === devtoolsState
            && fs.readFileSync(playwrightPreference, "utf8") === playwrightState
            && hasDevtoolsServer(configFile);

          fs.writeFileSync(devtoolsPreference, devtoolsState);
          fs.writeFileSync(playwrightPreference, playwrightState);
          writeDevtoolsConfig(targetDir);
          await assertPreferencesSandboxed(homeDir);
          const uninstallCode = await runUninstall({
            runtimes: ["opencode"],
            targetDir,
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: false,
          });
          const uninstallPreserved = fs.readFileSync(devtoolsPreference, "utf8") === devtoolsState
            && fs.readFileSync(playwrightPreference, "utf8") === playwrightState
            && hasDevtoolsServer(configFile);

          expect({ installCode, installPreserved, uninstallCode, uninstallPreserved }).toEqual({
            installCode: 0,
            installPreserved: true,
            uninstallCode: 0,
            uninstallPreserved: true,
          });
          expect(mocks.detectPlaywrightCli).not.toHaveBeenCalled();
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("allows missing state but rejects corrupt state before reconciling browser preferences", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-corrupt-browser-state-"));
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const stateDir = path.join(homeDir, ".jorgex-stack");
    const devtoolsPreference = path.join(stateDir, "devtools-mcp.json");
    const playwrightPreference = path.join(stateDir, "playwright-cli.json");

    try {
      writeModelMap(homeDir);
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        await assertPreferencesSandboxed(homeDir);
        const restoreDetect = setOnlyOpenCodeDetected(install, configDir);
        try {
          await expect(install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          })).resolves.toBe(0);

          const configFile = writeDevtoolsConfig(configDir);
          const corruptDevtools = "{not-json\n";
          const corruptPlaywright = "{also-not-json\n";
          fs.writeFileSync(devtoolsPreference, corruptDevtools);
          fs.writeFileSync(playwrightPreference, corruptPlaywright);

          await expect(install.runInstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            devtoolsMcpSelection: { opencode: false },
            playwrightToolConsent: {
              command: "sync",
              interactive: false,
              yes: true,
              targetDir: false,
              explicitToolSelection: false,
              confirmed: false,
            },
          })).resolves.toBe(1);

          expect(fs.readFileSync(devtoolsPreference, "utf8")).toBe(corruptDevtools);
          expect(fs.readFileSync(playwrightPreference, "utf8")).toBe(corruptPlaywright);
          expect(hasDevtoolsServer(configFile)).toBe(true);
          const messages = Object.values(mocks.prompts.log)
            .flatMap((log) => log.mock.calls.flat())
            .map((value) => String(value))
            .join("\n");
          expect(messages).toMatch(/(devtools-mcp|playwright-cli)\.json/i);
          expect(messages).toMatch(/corrupt|inv[aá]lid|repar|corrige|borra/i);
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks install, update, and uninstall when existing browser preferences are directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-state-eisdir-"));
    const homeDir = path.join(root, "home");
    const devtoolsPreference = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
    const playwrightPreference = path.join(homeDir, ".jorgex-stack", "playwright-cli.json");

    try {
      fs.mkdirSync(devtoolsPreference, { recursive: true });
      fs.mkdirSync(playwrightPreference, { recursive: true });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "1.1.0" }))));

      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const { runUpdateCheck } = await import("../src/update.js");
        const { runUninstall } = await import("../src/uninstall.js");
        await assertPreferencesSandboxed(homeDir);

        const installCode = await install.runInstall({
          runtimes: [],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
        });
        const updateCode = await runUpdateCheck("1.1.0");
        const uninstallCode = await runUninstall({
          runtimes: [],
          dryRun: false,
          yes: true,
          removeEngram: false,
          removePlaywright: false,
        });

        expect([installCode, updateCode, uninstallCode]).toEqual([1, 1, 1]);
        expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringContaining(devtoolsPreference));
        expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringContaining(playwrightPreference));
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not finish install with a success outro when Playwright setup fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-install-failure-"));
    const homeDir = path.join(root, "home");

    try {
      await withTempHome(homeDir, async () => {
        const { runInstall } = await import("../src/install.js");
        await assertPreferencesSandboxed(homeDir);

        await expect(runInstall({
          runtimes: [],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          playwrightToolConsent: {
            command: "install",
            interactive: false,
            yes: true,
            targetDir: false,
            explicitToolSelection: true,
            confirmed: false,
          },
          playwrightToolDeps: {
            run: async () => false,
            persistEnabled: () => undefined,
          },
        })).resolves.toBe(1);

        expect(mocks.prompts.outro).toHaveBeenCalledWith(expect.stringMatching(/errores/i));
        expect(mocks.prompts.outro).not.toHaveBeenCalledWith(expect.stringMatching(/^Hecho\./i));
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("short-circuits global-bin setup, keeps the preference unpersisted, and gives the setup remedy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-global-bin-"));
    const homeDir = path.join(root, "home");
    const actions: string[] = [];
    const persistEnabled = vi.fn();

    try {
      await withTempHome(homeDir, async () => {
        const { runInstall } = await import("../src/install.js");
        await assertPreferencesSandboxed(homeDir);

        await expect(runInstall({
          runtimes: [],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          playwrightToolConsent: {
            command: "install",
            interactive: false,
            yes: true,
            targetDir: false,
            explicitToolSelection: true,
            confirmed: false,
          },
          playwrightToolDeps: {
            run: async (action) => {
              actions.push(action);
              return { ok: false as const, reason: "pnpm-global-bin" as const };
            },
            persistEnabled,
          },
        })).resolves.toBe(1);

        expect(actions).toEqual(["install"]);
        expect(persistEnabled).not.toHaveBeenCalled();
        expect(mocks.prompts.log.error).toHaveBeenCalledWith(
          expect.stringMatching(/pnpm setup.*jorgex-stack install --playwright/i),
        );
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable browser cache with its path and code during sync", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-sync-cache-"));
    const homeDir = path.join(root, "home");
    const stateDir = path.join(homeDir, ".jorgex-stack");
    const cachePath = path.join(homeDir, "AppData", "Local", "ms-playwright");

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "playwright-cli.json"), JSON.stringify({ version: 1, enabled: true }) + "\n");
      mocks.isPlaywrightBrowserReady.mockReturnValueOnce({
        status: "unreadable",
        path: cachePath,
        errorCode: "EACCES",
      });

      await withTempHome(homeDir, async () => {
        const { runInstall } = await import("../src/install.js");
        await assertPreferencesSandboxed(homeDir);
        await expect(runInstall({
          runtimes: [],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          playwrightToolConsent: {
            command: "sync",
            interactive: false,
            yes: true,
            targetDir: false,
            explicitToolSelection: false,
            confirmed: false,
          },
        })).resolves.toBe(0);

        expect(mocks.isPlaywrightBrowserReady).toHaveBeenCalledOnce();
        expect(mocks.prompts.log.warn).toHaveBeenCalledWith(expect.stringContaining(cachePath));
        expect(mocks.prompts.log.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "an applied ownership-release action", configPresent: true, remainsOwned: false },
    { name: "no ownership-release action", configPresent: false, remainsOwned: true },
  ])("releases DevTools ownership only after $name", async ({ configPresent, remainsOwned }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-uninstall-ownership-"));
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const preference = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");

    try {
      writeModelMap(homeDir);
      fs.writeFileSync(preference, JSON.stringify({
        version: 1,
        enabled: { opencode: false },
        owned: { opencode: { [DEVTOOLS_SERVER]: true } },
      }) + "\n");
      if (configPresent) writeDevtoolsConfig(configDir);

      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const { runUninstall } = await import("../src/uninstall.js");
        await assertPreferencesSandboxed(homeDir);
        const restoreDetect = setOnlyOpenCodeDetected(install, configDir);
        try {
          await expect(runUninstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: false,
          })).resolves.toBe(0);

          const state = JSON.parse(fs.readFileSync(preference, "utf8")) as {
            owned?: { opencode?: Record<string, true> };
          };
          expect(state.owned?.opencode?.[DEVTOOLS_SERVER] === true).toBe(remainsOwned);
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps DevTools ownership when its runtime config is unreadable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-uninstall-unreadable-"));
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const configFile = path.join(configDir, "opencode.json");
    const preference = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");

    try {
      writeModelMap(homeDir);
      fs.writeFileSync(preference, JSON.stringify({
        version: 1,
        enabled: { opencode: false },
        owned: { opencode: { [DEVTOOLS_SERVER]: true } },
      }) + "\n");
      fs.mkdirSync(configFile, { recursive: true });

      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const { runUninstall } = await import("../src/uninstall.js");
        await assertPreferencesSandboxed(homeDir);
        const restoreDetect = setOnlyOpenCodeDetected(install, configDir);
        try {
          await expect(runUninstall({
            runtimes: ["opencode"],
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: false,
          })).resolves.toBe(1);

          const state = JSON.parse(fs.readFileSync(preference, "utf8")) as {
            owned?: { opencode?: Record<string, true> };
          };
          expect(state.owned?.opencode?.[DEVTOOLS_SERVER]).toBe(true);
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit Playwright flags under target-dir from executing global actions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-target-browser-flags-"));
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const stateDir = path.join(homeDir, ".jorgex-stack");
    const devtoolsPreference = path.join(stateDir, "devtools-mcp.json");
    const playwrightPreference = path.join(stateDir, "playwright-cli.json");
    const devtoolsObserved = {
      version: "9.9.20",
      integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}`,
    };
    const devtoolsState = JSON.stringify({
      version: 1,
      enabled: { opencode: true },
      owned: { opencode: { [DEVTOOLS_SERVER]: true } },
      observed: devtoolsObserved,
    }) + "\n";
    const playwrightState = JSON.stringify({ version: 1, enabled: true }) + "\n";
    const installActions: string[] = [];

    try {
      writeModelMap(homeDir);
      fs.writeFileSync(devtoolsPreference, devtoolsState);
      fs.writeFileSync(playwrightPreference, playwrightState);

      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const { runUninstall } = await import("../src/uninstall.js");
        await assertPreferencesSandboxed(homeDir);
        const restoreDetect = setOnlyOpenCodeDetected(install, targetDir);
        try {
          writeDevtoolsConfig(targetDir);
          const installCode = await install.runInstall({
            runtimes: ["opencode"],
            targetDir,
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            playwrightToolConsent: {
              command: "install",
              interactive: false,
              yes: true,
              targetDir: true,
              explicitToolSelection: true,
              confirmed: false,
            },
            playwrightToolDeps: {
              run: async (action) => {
                installActions.push(action);
                return true;
              },
              persistEnabled: () => undefined,
            },
          });
          await assertPreferencesSandboxed(homeDir);
          const uninstallCode = await runUninstall({
            runtimes: ["opencode"],
            targetDir,
            dryRun: false,
            yes: true,
            removeEngram: false,
            removePlaywright: true,
          });

          expect({ installCode, uninstallCode, installActions }).toEqual({
            installCode: 0,
            uninstallCode: 0,
            installActions: [],
          });
          expect(mocks.executePlaywrightToolAction).not.toHaveBeenCalled();
          expect(fs.readFileSync(devtoolsPreference, "utf8")).toBe(devtoolsState);
          expect(fs.readFileSync(playwrightPreference, "utf8")).toBe(playwrightState);
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("browser observed-version preferences [T14-RED]", () => {
  type Observed = { version: string; integrity: string };
  const PLAYWRIGHT_OBSERVED: Observed = {
    version: "9.9.10",
    integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}`,
  };
  const DEVTOOLS_OBSERVED: Observed = {
    version: "9.9.20",
    integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}`,
  };

  type ObservationPrefs = {
    savePlaywrightCliPreference(
      file: string,
      enabled: boolean,
      selection?: Record<string, boolean>,
      observed?: Observed,
    ): void;
    loadPlaywrightCliObservation(file: string): Observed | null;
    loadPlaywrightCliPreference(file: string, runtime?: string): boolean | undefined;
    saveDevtoolsMcpPreference(
      file: string,
      runtime: string,
      enabled: boolean,
      observed?: Observed,
    ): void;
    loadDevtoolsMcpObservation(file: string): Observed | null;
    loadDevtoolsMcpPreference(file: string, runtime: string): boolean;
    loadDevtoolsMcpOwnership(file: string, runtime: string, server: string): boolean;
  };

  async function loadObservationPrefs(): Promise<ObservationPrefs> {
    const mod = (await import("../src/lib/tool-preferences.js")) as unknown as Partial<ObservationPrefs>;
    expect(
      mod.loadPlaywrightCliObservation,
      "loadPlaywrightCliObservation must be exported from src/lib/tool-preferences.ts",
    ).toBeTypeOf("function");
    expect(
      mod.loadDevtoolsMcpObservation,
      "loadDevtoolsMcpObservation must be exported from src/lib/tool-preferences.ts",
    ).toBeTypeOf("function");
    return mod as ObservationPrefs;
  }

  it("records the observed Playwright candidate while preserving other runtimes and migrating v1", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-observed-"));
    try {
      const file = path.join(root, "playwright-cli.json");
      fs.writeFileSync(file, JSON.stringify({ version: 2, enabled: { opencode: true, codex: false } }) + "\n");

      prefs.savePlaywrightCliPreference(file, true, { pi: true }, PLAYWRIGHT_OBSERVED);

      expect(prefs.loadPlaywrightCliPreference(file, "pi")).toBe(true);
      expect(prefs.loadPlaywrightCliPreference(file, "opencode")).toBe(true);
      expect(prefs.loadPlaywrightCliPreference(file, "codex")).toBe(false);
      expect(prefs.loadPlaywrightCliObservation(file)).toEqual(PLAYWRIGHT_OBSERVED);

      fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true }) + "\n");
      prefs.savePlaywrightCliPreference(file, true, { pi: true }, PLAYWRIGHT_OBSERVED);

      expect(prefs.loadPlaywrightCliPreference(file, "pi")).toBe(true);
      expect(prefs.loadPlaywrightCliObservation(file)).toEqual(PLAYWRIGHT_OBSERVED);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid observed Playwright candidate without mutation", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-observed-invalid-"));
    try {
      const file = path.join(root, "playwright-cli.json");
      const initial = JSON.stringify({ version: 2, enabled: { opencode: true } }) + "\n";
      fs.writeFileSync(file, initial);
      const prerelease: Observed = {
        version: "9.9.10-beta.1",
        integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}`,
      };
      const malformed: Observed = { version: "9.9.10", integrity: "sha512-!!not-base64!!" };

      expect(() => prefs.savePlaywrightCliPreference(file, true, { pi: true }, prerelease)).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(initial);
      expect(() => prefs.savePlaywrightCliPreference(file, true, { pi: true }, malformed)).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(initial);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a legacy Playwright enabled record parseable with a null observation", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-observed-legacy-"));
    try {
      const file = path.join(root, "playwright-cli.json");
      fs.writeFileSync(file, JSON.stringify({ version: 2, enabled: { opencode: true } }) + "\n");

      expect(prefs.loadPlaywrightCliPreference(file, "opencode")).toBe(true);
      expect(prefs.loadPlaywrightCliObservation(file)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the observed DevTools candidate while preserving owned and enabled state", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-observed-"));
    try {
      const file = path.join(root, "devtools-mcp.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          enabled: { opencode: true },
          owned: { opencode: { [DEVTOOLS_SERVER]: true } },
        }) + "\n",
      );

      prefs.saveDevtoolsMcpPreference(file, "pi", true, DEVTOOLS_OBSERVED);

      expect(prefs.loadDevtoolsMcpPreference(file, "pi")).toBe(true);
      expect(prefs.loadDevtoolsMcpPreference(file, "opencode")).toBe(true);
      expect(prefs.loadDevtoolsMcpOwnership(file, "opencode", DEVTOOLS_SERVER)).toBe(true);
      expect(prefs.loadDevtoolsMcpOwnership(file, "pi", DEVTOOLS_SERVER)).toBe(false);
      expect(prefs.loadDevtoolsMcpObservation(file)).toEqual(DEVTOOLS_OBSERVED);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid observed DevTools candidate without mutation", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-observed-invalid-"));
    try {
      const file = path.join(root, "devtools-mcp.json");
      const initial =
        JSON.stringify({
          version: 1,
          enabled: { opencode: true },
          owned: { opencode: { [DEVTOOLS_SERVER]: true } },
        }) + "\n";
      fs.writeFileSync(file, initial);
      const prerelease: Observed = {
        version: "9.9.20-beta.1",
        integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}`,
      };
      const malformed: Observed = { version: "9.9.20", integrity: "sha512-!!not-base64!!" };

      expect(() => prefs.saveDevtoolsMcpPreference(file, "pi", true, prerelease)).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(initial);
      expect(() => prefs.saveDevtoolsMcpPreference(file, "pi", true, malformed)).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(initial);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a legacy DevTools enabled record parseable with a null observation", async () => {
    const prefs = await loadObservationPrefs();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-observed-legacy-"));
    try {
      const file = path.join(root, "devtools-mcp.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          enabled: { opencode: true },
          owned: { opencode: { [DEVTOOLS_SERVER]: true } },
        }) + "\n",
      );

      expect(prefs.loadDevtoolsMcpPreference(file, "opencode")).toBe(true);
      expect(prefs.loadDevtoolsMcpOwnership(file, "opencode", DEVTOOLS_SERVER)).toBe(true);
      expect(prefs.loadDevtoolsMcpObservation(file)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
