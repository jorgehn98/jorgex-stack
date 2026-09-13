import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter, RuntimeId } from "../src/adapters/types.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";

const OPEN_CODE_MODELS = {
  strong: { model: "provider/strong" },
  standard: { model: "provider/standard" },
  cheap: { model: "provider/cheap" },
};

const CODEX_MODELS = {
  strong: { model: "default", variant: "high" },
  standard: { model: "default", variant: "medium" },
  cheap: { model: "default", variant: "low" },
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalAgents = loadCanonicalAgents(path.join(ROOT, "stack", "agents"));
const sampleSubagent = canonicalAgents.find((agent) => agent.mode === "subagent")!;

afterEach(() => {
  vi.restoreAllMocks();
});

function preferenceFile(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "install-mode.json");
}

function writePreference(homeDir: string, value: unknown): void {
  const file = preferenceFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function modelMapFile(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "model-map.json");
}

function writeModelMap(homeDir: string, value: unknown): void {
  const file = modelMapFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function runCli(args: string[], homeDir: string): Promise<void> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.exitCode = undefined;

  try {
    vi.resetModules();
    process.argv = [process.execPath, path.join(ROOT, "src", "cli.ts"), ...args];
    await import("../src/cli.js");
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
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

describe("install-mode regressions", () => {
  it("runInstall rejects OpenCode without an explicit user model map", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-no-opencode-models-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");
    const { runInstall } = await importInstallModule(homeDir);

    await expect(runInstall({
      runtimes: ["opencode"],
      targetDir,
      dryRun: false,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
    })).resolves.toBe(1);
    expect(fs.existsSync(path.join(targetDir, "agents"))).toBe(false);
  });

  it("no crea model-map.json en un HOME nuevo durante un dry-run", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-dry-run-fresh-home-"));
    const homeDir = path.join(tmp, "home");
    const dataDir = path.join(homeDir, ".jorgex-stack");
    const modelMap = modelMapFile(homeDir);

    try {
      const { runInstall } = await importInstallModule(homeDir);

      await expect(runInstall({
        runtimes: ["codex"],
        dryRun: true,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        showSummary: false,
      })).resolves.toBe(0);

      expect(fs.existsSync(modelMap)).toBe(false);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignora la preferencia guardada cuando --target-dir debería forzar artefactos human", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-target-dir-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");

    writePreference(homeDir, { mode: "programmatic", subagentConcurrency: "parallel" });
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

    await runCli(["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"], homeDir);

    const { opencodeAdapter } = await import("../src/adapters/opencode.js");
    const systemPrompt = fs.readFileSync(opencodeAdapter.paths(targetDir).systemPromptFile, "utf8");

    expect(systemPrompt).not.toContain("PROGRAMMATIC MODE");
    expect(systemPrompt).not.toContain("strict JSON object");
  });

  it("lee un model-map real existente en --target-dir sin crear archivos nuevos del data-dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-target-dir-model-map-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");
    const dataDir = path.join(homeDir, ".jorgex-stack");
    const file = modelMapFile(homeDir);
    const overrideModel = "readonly/custom-model";
    const overrideVariant = "readonly";

    writeModelMap(homeDir, {
      opencode: {
        ...OPEN_CODE_MODELS,
        [sampleSubagent.tier]: { model: overrideModel, variant: overrideVariant },
      },
    });
    const originalModelMap = fs.readFileSync(file, "utf8");

    await runCli(["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"], homeDir);

    const subagentFile = path.join(targetDir, "agents", `${sampleSubagent.name}.md`);

    expect(fs.readFileSync(subagentFile, "utf8")).toContain(`model: ${overrideModel}`);
    expect(fs.readFileSync(subagentFile, "utf8")).toContain(`variant: ${overrideVariant}`);
    expect(fs.readFileSync(file, "utf8")).toBe(originalModelMap);
    expect(fs.readdirSync(dataDir).sort()).toEqual(["model-map.json"]);
  });

  it("no escribe la preferencia antes de saber que la instalación ha terminado bien", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-save-timing-"));
    const homeDir = path.join(tmp, "home");

    writePreference(homeDir, { mode: "human", subagentConcurrency: "serial" });

    const { runInstall } = await importInstallModule(homeDir);
    await expect(
      runInstall({
        runtimes: ["does-not-exist" as RuntimeId],
        dryRun: false,
        yes: true,
        mode: { mode: "programmatic", subagentConcurrency: "parallel" },
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(fs.readFileSync(preferenceFile(homeDir), "utf8")) as { mode: string; subagentConcurrency: string }).toEqual({
      mode: "human",
      subagentConcurrency: "serial",
    });
  });

  it("persiste programmatic aunque el runtime ya esté al día y no haya cambios", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-mode-noop-"));
    const homeDir = path.join(tmp, "home");
    const opencodeConfigDir = path.join(tmp, "opencode");
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

    const install = await importInstallModule(homeDir);
    const opencodeAdapter = install.ADAPTERS.opencode!;
    const originalDetect = opencodeAdapter.detect;

    opencodeAdapter.detect = () => ({
      id: "opencode",
      name: "OpenCode",
      installed: true,
      binPath: null,
      configDir: opencodeConfigDir,
    });

    try {
      await expect(
        install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "programmatic", subagentConcurrency: "parallel" },
        }),
      ).resolves.toBe(0);

      const paths = opencodeAdapter.paths(opencodeConfigDir);
      const systemPrompt = fs.readFileSync(paths.systemPromptFile, "utf8");

      writePreference(homeDir, { mode: "human", subagentConcurrency: "serial" });

      await expect(
        install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "programmatic", subagentConcurrency: "parallel" },
        }),
      ).resolves.toBe(0);

      expect(fs.readFileSync(paths.systemPromptFile, "utf8")).toBe(systemPrompt);
      expect(JSON.parse(fs.readFileSync(preferenceFile(homeDir), "utf8")) as { mode: string; subagentConcurrency: string }).toEqual({
        mode: "programmatic",
        subagentConcurrency: "parallel",
      });
    } finally {
      opencodeAdapter.detect = originalDetect;
    }
  });

  it("no persiste el modo resuelto si un runtime posterior falla", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-partial-save-"));
    const homeDir = path.join(tmp, "home");
    const opencodeConfigDir = path.join(tmp, "opencode");
    const codexConfigDir = path.join(tmp, "codex");

    writePreference(homeDir, { mode: "human", subagentConcurrency: "serial" });

    const install = await importInstallModule(homeDir);
    const opencodeAdapter = install.ADAPTERS.opencode!;
    const codexAdapter = install.ADAPTERS.codex!;
    const originalOpencodeDetect = opencodeAdapter.detect;
    const originalCodexDetect = codexAdapter.detect;
    const originalCodexRenderAgent = codexAdapter.renderAgent;

    opencodeAdapter.detect = () => ({
      id: "opencode",
      name: "OpenCode",
      installed: true,
      binPath: null,
      configDir: opencodeConfigDir,
    });

    const codexDetect = vi.fn()
      .mockReturnValueOnce({
        id: "codex",
        name: "Codex CLI",
        installed: false,
        binPath: null,
        configDir: codexConfigDir,
      })
      .mockReturnValue({
        id: "codex",
        name: "Codex CLI",
        installed: true,
        binPath: null,
        configDir: codexConfigDir,
      });

    codexAdapter.detect = codexDetect as typeof codexAdapter.detect;
    codexAdapter.renderAgent = () => {
      throw new Error("codex runtime failed");
    };

    try {
      await expect(
        install.runInstall({
          runtimes: ["opencode", "codex"],
          dryRun: false,
          yes: true,
          mode: { mode: "programmatic", subagentConcurrency: "parallel" },
        }),
      ).rejects.toThrow("codex runtime failed");

      expect(JSON.parse(fs.readFileSync(preferenceFile(homeDir), "utf8")) as { mode: string; subagentConcurrency: string }).toEqual({
        mode: "human",
        subagentConcurrency: "serial",
      });
    } finally {
      opencodeAdapter.detect = originalOpencodeDetect;
      codexAdapter.detect = originalCodexDetect;
      codexAdapter.renderAgent = originalCodexRenderAgent;
    }
  });

  it("rechaza una preferencia interna human/parallel inválida antes de persistirla", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-invalid-mode-"));
    const homeDir = path.join(tmp, "home");

    const { runInstall } = await importInstallModule(homeDir);

    await expect(
      runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "parallel" } as any,
      }),
    ).rejects.toThrow();
  });

  it("avisa cuando no puede construir el plan y desactiva la limpieza de huérfanos", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-orphan-warning-"));
    const homeDir = path.join(tmp, "home");
    const brokenOpenCodeDir = path.join(tmp, "opencode");
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

    const install = await importInstallModule(homeDir);
    const originalAdapters = { ...install.ADAPTERS };
    const fakeAdapter = {
      ...originalAdapters.opencode!,
      detect: (): ReturnType<Adapter["detect"]> => ({
        installed: true,
        configDir: brokenOpenCodeDir,
        id: "opencode",
        name: "OpenCode",
        binPath: null,
      }),
      renderAgent: () => {
        throw new Error("broken plan");
      },
    };

    install.ADAPTERS.opencode = fakeAdapter;
    delete install.ADAPTERS.codex;
    delete install.ADAPTERS["claude-code"];

    try {
      const current = install.collectAllCurrentTargets();

      expect(current.complete).toBe(false);
      expect(current.warnings.some((message) => /broken plan/i.test(message))).toBe(true);
    } finally {
      install.ADAPTERS.opencode = originalAdapters.opencode;
      if (originalAdapters.codex) install.ADAPTERS.codex = originalAdapters.codex;
      if (originalAdapters["claude-code"]) install.ADAPTERS["claude-code"] = originalAdapters["claude-code"];
      else delete install.ADAPTERS["claude-code"];
    }
  });
});

describe("Context7 install preflight regressions", () => {
  it("persiste ownership después de crear el registro Context7 ausente", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-context7-install-ownership-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const configFile = path.join(configDir, "opencode.json");
    const ownershipFile = path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

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
      })).resolves.toBe(0);

      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
        mcp?: Record<string, { type?: string; url?: string }>;
      };
      expect(config.mcp?.context7).toMatchObject({
        type: "remote",
        url: "https://mcp.context7.com/mcp",
      });
      expect(JSON.parse(fs.readFileSync(ownershipFile, "utf8"))).toMatchObject({
        owned: { opencode: { context7: true } },
      });
    } finally {
      adapter.detect = originalDetect;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prevalida todos los registros MCP seleccionados antes de crear cualquier prompt", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-context7-install-preflight-"));
    const homeDir = path.join(tmp, "home");
    const codexConfigDir = path.join(homeDir, ".codex");
    const opencodeConfigDir = path.join(homeDir, ".config", "opencode");
    const codexPrompt = path.join(codexConfigDir, "AGENTS.md");
    const opencodeConfigFile = path.join(opencodeConfigDir, "opencode.json");
    const previousEnv = {
      CODEX_HOME: process.env.CODEX_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    };
    writeModelMap(homeDir, { codex: CODEX_MODELS, opencode: OPEN_CODE_MODELS });
    fs.mkdirSync(opencodeConfigDir, { recursive: true });
    fs.writeFileSync(opencodeConfigFile, JSON.stringify({
      model: "user/model",
      mcp: {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          enabled: false,
        },
      },
    }, null, 2) + "\n");

    process.env.CODEX_HOME = codexConfigDir;
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
    const install = await importInstallModule(homeDir);
    const codexAdapter = install.ADAPTERS.codex!;
    const opencodeAdapter = install.ADAPTERS.opencode!;
    const originalCodexDetect = codexAdapter.detect;
    const originalOpencodeDetect = opencodeAdapter.detect;
    codexAdapter.detect = () => ({ id: "codex", name: "Codex CLI", installed: true, binPath: null, configDir: codexConfigDir });
    opencodeAdapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir: opencodeConfigDir });

    try {
      await expect(install.runInstall({
        runtimes: ["codex", "opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
      })).resolves.toBe(1);

      expect(fs.existsSync(codexPrompt)).toBe(false);
      expect(fs.existsSync(path.join(codexConfigDir, "config.toml"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".jorgex-stack", "writing-style.md"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".jorgex-stack", "manifest.json"))).toBe(false);
      expect(fs.readFileSync(opencodeConfigFile, "utf8")).toContain('"enabled": false');
    } finally {
      codexAdapter.detect = originalCodexDetect;
      opencodeAdapter.detect = originalOpencodeDetect;
      if (previousEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousEnv.CODEX_HOME;
      if (previousEnv.OPENCODE_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousEnv.OPENCODE_CONFIG_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no publica un prompt nuevo antes de que falle la actualización del registro existente", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-context7-install-order-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const configFile = path.join(configDir, "opencode.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ model: "user/model", userSetting: "preserve" }, null, 2) + "\n");
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const originalExitCode = process.exitCode;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.OPENCODE_CONFIG_DIR = configDir;
    process.exitCode = undefined;
    vi.resetModules();
    vi.doMock("../src/lib/fsx.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/fsx.js")>();
      return {
        ...actual,
        writeText(file: string, content: string, mode?: number) {
          if (path.resolve(file) === path.resolve(configFile)) throw new Error("Context7 config update failed");
          return actual.writeText(file, content, mode);
        },
      };
    });

    try {
      const install = await import("../src/install.js");
      const adapter = install.ADAPTERS.opencode!;
      const originalDetect = adapter.detect;
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: null, configDir });
      try {
        await expect(install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
        })).rejects.toThrow("Context7 config update failed");
      } finally {
        adapter.detect = originalDetect;
      }

      expect(fs.existsSync(path.join(configDir, "AGENTS.md"))).toBe(false);
      expect(fs.readFileSync(configFile, "utf8")).toContain('"userSetting": "preserve"');
    } finally {
      vi.doUnmock("../src/lib/fsx.js");
      vi.resetModules();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      process.exitCode = originalExitCode;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
