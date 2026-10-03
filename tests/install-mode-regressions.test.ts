import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter, RuntimeId } from "../src/adapters/types.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP, resolveAgentModel } from "../src/lib/model-map.js";
import { cleanupOpenCodeBinaries, opencodeV2Binary, writeOpenCodeBinary } from "./helpers/opencode-binary.js";
import { snapshotEnv } from "./helpers/opencode-isolation.js";
import { removeTemporaryRoots } from "./helpers/pnpm-tooling.js";

/** Binario v2 real reutilizable: el gate ejecuta el binario detectado. */
const OPENCODE_V2_BIN = opencodeV2Binary();

afterAll(cleanupOpenCodeBinaries);

const promptLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, log: promptLog };
});

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

/**
 * Roots temporales propios de este fichero: se registran al crearlos y el
 * `afterEach` los elimina (solo esos), también cuando un caso falla. No se
 * recorren prefijos ajenos ni `/var/tmp`.
 */
const ownedTempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedTempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(promptLog)) fn.mockClear();
  removeTemporaryRoots(ownedTempRoots);
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

async function runCli(
  args: readonly string[],
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<number | string | undefined> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const managedKeys = [...new Set(["HOME", "USERPROFILE", ...Object.keys(extraEnv)])];
  const originals = new Map<string, string | undefined>(managedKeys.map((key) => [key, process.env[key]]));

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;

  try {
    vi.resetModules();
    process.argv = [process.execPath, path.join(ROOT, "src", "cli.ts"), ...args];
    await import("../src/cli.js");
    return process.exitCode;
  } finally {
    process.argv = originalArgv;
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = originalExitCode;
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
  it("runInstall siembra el roster v2 de OpenCode sin mapa de usuario ni catálogo", async () => {
    const tmp = createTempRoot("jx-install-default-opencode-models-");
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");
    const { runInstall } = await importInstallModule(homeDir);

    // Spec T04 (picker): los defaults v2 inicializan OpenCode fresh también sin
    // TTY/--yes; el rechazo antiguo por falta de mapa manual queda obsoleto.
    await expect(runInstall({
      runtimes: ["opencode"],
      targetDir,
      opencodeTargetMajor: 2,
      dryRun: false,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
    })).resolves.toBe(0);

    const subagentFile = path.join(targetDir, "agents", `${sampleSubagent.name}.md`);
    const frontmatter = fs.readFileSync(subagentFile, "utf8");
    const expected = resolveAgentModel(DEFAULT_MODEL_MAP.opencode, sampleSubagent.name, sampleSubagent.tier);
    const expectedRef = expected.variant ? `${expected.model}#${expected.variant}` : expected.model;
    expect(frontmatter).toContain(`model: ${JSON.stringify(expectedRef)}`);
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
    const tmp = createTempRoot("jx-install-target-dir-");
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");

    writePreference(homeDir, { mode: "programmatic", subagentConcurrency: "parallel" });
    writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

    await runCli(
      ["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"],
      homeDir,
      { JORGEX_OPENCODE_TARGET_MAJOR: "2" },
    );

    const { opencodeAdapter } = await import("../src/adapters/opencode.js");
    const systemPrompt = fs.readFileSync(opencodeAdapter.paths(targetDir).systemPromptFile, "utf8");

    expect(systemPrompt).not.toContain("PROGRAMMATIC MODE");
    expect(systemPrompt).not.toContain("strict JSON object");
  });

  it("lee un model-map real existente en --target-dir sin crear archivos nuevos del data-dir", async () => {
    const tmp = createTempRoot("jx-install-target-dir-model-map-");
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

    await runCli(
      ["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"],
      homeDir,
      { JORGEX_OPENCODE_TARGET_MAJOR: "2" },
    );

    const subagentFile = path.join(targetDir, "agents", `${sampleSubagent.name}.md`);

    // El escalar YAML v2 es un único `provider/model#variant` (sin `variant:`
    // aparte), serializado con comillas JSON para que un valor manual no inyecte
    // campos en el frontmatter.
    const subagent = fs.readFileSync(subagentFile, "utf8");
    expect(subagent).toContain(`model: ${JSON.stringify(`${overrideModel}#${overrideVariant}`)}`);
    expect(subagent).not.toContain("variant:");
    expect(fs.readFileSync(file, "utf8")).toBe(originalModelMap);
    expect(fs.readdirSync(dataDir).sort()).toEqual(["model-map.json"]);
  });

  it("no escribe la preferencia antes de saber que la instalación ha terminado bien", async () => {
    const tmp = createTempRoot("jx-install-save-timing-");
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
    const tmp = createTempRoot("jx-install-mode-noop-");
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
      binPath: OPENCODE_V2_BIN,
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
    const tmp = createTempRoot("jx-install-partial-save-");
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
      binPath: OPENCODE_V2_BIN,
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
    const tmp = createTempRoot("jx-install-invalid-mode-");
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
    const tmp = createTempRoot("jx-install-orphan-warning-");
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
    adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir });

    try {
      await expect(install.runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
      })).resolves.toBe(0);

      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
        mcp?: { servers?: Record<string, { type?: string; url?: string }> };
      };
      expect(config.mcp?.servers?.context7).toMatchObject({
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
    opencodeAdapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir: opencodeConfigDir });

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
      adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir });
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

// ---------------------------------------------------------------------------
// Frontera OpenCode v2 (T01): version-gate major 2 antes del primer write y
// migración owned que falla cerrado cuando el configDir del manifest ya no
// coincide con el detectado.
// ---------------------------------------------------------------------------

/**
 * HOME/config/estado/caches aislados; nunca toca el HOME personal, la config
 * activa ni los directorios XDG/TMP del runner. Todos los overrides se
 * restauran al terminar.
 */
async function withIsolatedOpenCodeEnv<T>(
  opts: { homeDir: string; configDir: string; binDir: string; tmpDir: string },
  run: () => Promise<T>,
): Promise<T> {
  const { homeDir, configDir, binDir, tmpDir } = opts;
  const isolated: Record<string, string> = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCODE_CONFIG_DIR: configDir,
    PATH: binDir,
    XDG_CONFIG_HOME: path.join(tmpDir, "xdg-config"),
    XDG_DATA_HOME: path.join(tmpDir, "xdg-data"),
    XDG_CACHE_HOME: path.join(tmpDir, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmpDir, "xdg-state"),
    XDG_RUNTIME_DIR: path.join(tmpDir, "xdg-runtime"),
    TMPDIR: path.join(tmpDir, "tmp"),
  };
  const cleared = ["ENGRAM_BIN", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"] as const;
  const managedKeys = [...Object.keys(isolated), ...cleared];
  const restore = snapshotEnv(managedKeys);

  for (const dir of new Set([...Object.values(isolated), homeDir, configDir, binDir])) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const [key, value] of Object.entries(isolated)) process.env[key] = value;
  for (const key of cleared) delete process.env[key];

  try {
    vi.resetModules();
    return await run();
  } finally {
    restore();
    vi.resetModules();
  }
}

/** Mensajes observables de diagnóstico (error/warn/message) para el usuario. */
function projectedDiagnostics(): string {
  return [...Object.values(promptLog)]
    .flatMap((fn) => fn.mock.calls)
    .flat()
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

/** Argumentos con los que el gate invocó el fixture (vacío si nunca corrió). */
function recordedProbeArgs(markerFile: string): string {
  return fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8") : "";
}

function opencodeInstallOptions() {
  return {
    runtimes: ["opencode"] as RuntimeId[],
    dryRun: false,
    yes: true,
    mode: { mode: "human" as const, subagentConcurrency: "serial" as const },
    showSummary: false,
  };
}

describe.skipIf(process.platform === "win32")("OpenCode v2 major-2 preflight regressions", () => {
  it("rechaza un binario v1 major 1 sin proyectar configuración v2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-major-v1-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/opencode/i);
        expect(projectedDiagnostics()).toMatch(/(?:major|[vV]ersi[oó]n)/);
        // El rechazo debe venir de probar el binario, no de asumir v1.
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechaza una versión ambigua o ilegible sin escribir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-major-ambiguous-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "opencode dev build", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/opencode/i);
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no proyecta cuando el binario está ausente aunque el configDir exista", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-major-absent-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        await runInstall(opencodeInstallOptions());

        // Skip o rechazo son aceptables; lo innegociable es no escribir la
        // proyección v2 sobre una máquina sin binario v2 verificable.
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/opencode/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("control: acepta major 2, ejecuta --version y proyecta la configuración", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-major-v2-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(0);
        expect(fs.existsSync(path.join(configDir, "AGENTS.md"))).toBe(true);
        // Control no vacuo: el binario detectado se probó de verdad.
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("OpenCode v1 migration ownership regressions", () => {
  it("no migra ni toca archivos owned cuando el configDir del manifest no coincide con el detectado", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-migration-mismatch-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const staleConfigDir = path.join(homeDir, ".opencode-stale");
    const binDir = path.join(tmp, "bin");
    const probeMarker = path.join(tmp, "opencode-probe.log");
    const legacyFile = path.join(homeDir, ".agents", "skills", "legacy-retired", "SKILL.md");
    const legacyContent = "legacy owned v1 content\n";

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(staleConfigDir, { recursive: true });
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, legacyContent);
      writeOpenCodeBinary(binDir, { output: "2.0.19", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir: staleConfigDir, owned: [legacyFile], updatedAt: "legacy" });
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        const manifestBefore = fs.readFileSync(manifestFile);

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall({ ...opencodeInstallOptions(), command: "sync" });

        expect(code).toBe(1);
        expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyContent);
        expect(fs.readFileSync(manifestFile)).toEqual(manifestBefore);
        expect(projectedDiagnostics()).toMatch(/(?:configDir|ownership|propiedad|manifest)/i);
        // El conflicto se decide con v2 ya probado, no por un bailout previo.
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Ejecuta un cuerpo POSIX arbitrario: sirve para timeout y salida excesiva. */
function writeRawOpenCodeScript(binDir: string, body: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "opencode");
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform === "win32")("OpenCode --target-dir evidence regressions", () => {
  it("rechaza --target-dir sin evidencia inyectada antes de escribir y sin ejecutar el binario personal", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-target-no-evidence-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const targetDir = path.join(tmp, "target");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        const code = await runInstall({ ...opencodeInstallOptions(), targetDir });

        expect(code).toBe(1);
        expect(fs.existsSync(path.join(targetDir, "AGENTS.md"))).toBe(false);
        // Spec02: --target-dir no ejecuta el binario personal.
        expect(recordedProbeArgs(probeMarker)).toBe("");
        expect(projectedDiagnostics()).toMatch(/opencode/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("control: --target-dir con evidencia major 2 proyecta sin ejecutar el binario personal", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-target-evidence2-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const targetDir = path.join(tmp, "target");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      // Binario v1 en PATH: si el sandbox lo probara, rechazaría el control.
      writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        const code = await runInstall({ ...opencodeInstallOptions(), targetDir, opencodeTargetMajor: 2 });

        expect(code).toBe(0);
        expect(fs.existsSync(path.join(targetDir, "AGENTS.md"))).toBe(true);
        expect(recordedProbeArgs(probeMarker)).toBe("");
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([1, 0, 3, Number.NaN])(
    "rechaza --target-dir con evidencia inválida (%s) antes de escribir",
    async (injected) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-target-bad-evidence-"));
      const homeDir = path.join(tmp, "home");
      const configDir = path.join(homeDir, ".config", "opencode");
      const binDir = path.join(tmp, "bin");
      const targetDir = path.join(tmp, "target");

      try {
        fs.mkdirSync(configDir, { recursive: true });
        writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

        await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
          const { runInstall } = await import("../src/install.js");
          const code = await runInstall({ ...opencodeInstallOptions(), targetDir, opencodeTargetMajor: injected });

          expect(code).toBe(1);
          expect(fs.existsSync(path.join(targetDir, "AGENTS.md"))).toBe(false);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("no acepta la evidencia de target como bypass de una instalación real", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-real-no-bypass-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { runInstall } = await import("../src/install.js");
        // Instalación real con evidencia inyectada: debe probar el binario v1
        // detectado e ignorar la evidencia de target.
        const code = await runInstall({ ...opencodeInstallOptions(), opencodeTargetMajor: 2 });

        expect(code).toBe(1);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
        expect(projectedDiagnostics()).toMatch(/opencode/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("OpenCode major parsing regressions", () => {
  it("acepta el literal real 'opencode v2.0.20'", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-literal-"));
    try {
      const bin = writeOpenCodeBinary(path.join(tmp, "bin"), { output: "opencode v2.0.20" });
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("acepta un wrapper que reenvía argv al binario real", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-wrapper-"));
    const innerMarker = path.join(tmp, "inner-args.log");
    try {
      const inner = writeOpenCodeBinary(path.join(tmp, "inner"), { output: "opencode v2.0.20", markerFile: innerMarker });
      const wrapper = writeRawOpenCodeScript(path.join(tmp, "bin"), `exec '${inner}' "$@"`);
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");

      expect(opencodeMajorVersion(wrapper)).toBe(2);
      expect(fs.readFileSync(innerMarker, "utf8")).toMatch(/--version/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no interpreta una salida con varias versiones (v1 y v2) como una versión válida", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-multi-"));
    try {
      const bin = writeOpenCodeBinary(path.join(tmp, "bin"), { output: "1.2.3\n2.0.20" });
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no acepta v1 por un número de dependencia anterior en la salida", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-dep-accept-"));
    try {
      const bin = writeOpenCodeBinary(path.join(tmp, "bin"), { output: "wrapped node 2.3.4\nopencode v1.2.3" });
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no interpreta un número de error/dependencia como versión de OpenCode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-error-"));
    try {
      const bin = writeOpenCodeBinary(path.join(tmp, "bin"), {
        output: "Error: opencode exited 1; node 18.16.0 is required",
      });
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("devuelve null si el binario no responde dentro del timeout", { timeout: 20_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-timeout-"));
    try {
      // `exec` reemplaza el shell: al expirar el timeout no sobrevive un hijo.
      const bin = writeRawOpenCodeScript(path.join(tmp, "bin"), "exec sleep 30");
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("devuelve null si el binario produce una salida excesiva", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-parse-huge-"));
    try {
      const line = "x".repeat(100);
      const bin = writeRawOpenCodeScript(
        path.join(tmp, "bin"),
        `i=0\nwhile [ $i -lt 14000 ]; do printf '%s\\n' '${line}'; i=$((i+1)); done`,
      );
      const { opencodeMajorVersion } = await import("../src/lib/detect.js");
      expect(opencodeMajorVersion(bin)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("OpenCode manifest ownership regressions", () => {
  it("rechaza un manifest con entrada 'opencode' nula antes de escribir y lo preserva", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-null-entry-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(manifestFile, JSON.stringify({ runtimes: { opencode: null } }, null, 2) + "\n");
        const manifestBefore = fs.readFileSync(manifestFile);

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(fs.readFileSync(manifestFile)).toEqual(manifestBefore);
        // Un TypeError interno no es un remedio accionable.
        expect(projectedDiagnostics()).not.toMatch(/Cannot read propert|TypeError/i);
        expect(projectedDiagnostics()).toMatch(/manifest|coherent|revisa|restaura/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechaza entradas no string en 'owned' antes de escribir y preserva el manifest", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-bad-owned-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(
          manifestFile,
          JSON.stringify({ runtimes: { opencode: { configDir, owned: [123, null], updatedAt: "legacy" } } }, null, 2) + "\n",
        );
        const manifestBefore = fs.readFileSync(manifestFile);

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(fs.readFileSync(manifestFile)).toEqual(manifestBefore);
        expect(projectedDiagnostics()).toMatch(/(?:manifest|owned|coherent|propiedad)/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no borra un owned fuera de la frontera permitida y bloquea antes de escribir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-outside-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const outsideFile = path.join(tmp, "outside", "artifact.txt");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
      fs.writeFileSync(outsideFile, "outside HOME\n");
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [outsideFile], updatedAt: "legacy" });

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside HOME\n");
        expect(fs.readdirSync(configDir)).toEqual([]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechaza un manifest corrupto y lo preserva antes de escribir (control)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-corrupt-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(manifestFile, "{not-json\n");

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readFileSync(manifestFile, "utf8")).toBe("{not-json\n");
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/(?:manifest|coherent|legible)/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no acepta ni borra un owned ajeno dentro de HOME que Stack jamás proyecta", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-foreign-home-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const foreignFile = path.join(homeDir, "notes", "foreign-note.txt");
    const foreignContent = "foreign HOME note, never projected by Stack\n";

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
      fs.writeFileSync(foreignFile, foreignContent);
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const { writeRuntimeManifest } = await import("../src/lib/manifest.js");
        writeRuntimeManifest("opencode", { configDir, owned: [foreignFile], updatedAt: "legacy" });
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        const manifestBefore = fs.readFileSync(manifestFile);

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        // Un manifest editable no acredita propiedad: un owned ajeno dentro de
        // HOME no se migra ni se borra; el inventario incoherente falla cerrado.
        expect(code).toBe(1);
        expect(fs.readFileSync(foreignFile, "utf8")).toBe(foreignContent);
        expect(fs.readFileSync(manifestFile)).toEqual(manifestBefore);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/(?:owned|frontera|propiedad|manifest|coherent)/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechaza pendingOrphans incoherentes sin limpiar ni proyectar", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-manifest-pending-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const foreignFile = path.join(homeDir, "notes", "pending-foreign.txt");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
      fs.writeFileSync(foreignFile, "foreign pending orphan\n");
      writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });

      await withIsolatedOpenCodeEnv({ homeDir, configDir, binDir, tmpDir: tmp }, async () => {
        const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(
          manifestFile,
          JSON.stringify({ runtimes: { opencode: { configDir, owned: [], pendingOrphans: [foreignFile, 123], updatedAt: "legacy" } } }, null, 2) + "\n",
        );
        const manifestBefore = fs.readFileSync(manifestFile);

        const { runInstall } = await import("../src/install.js");
        const code = await runInstall(opencodeInstallOptions());

        expect(code).toBe(1);
        expect(fs.readFileSync(foreignFile, "utf8")).toBe("foreign pending orphan\n");
        expect(fs.readFileSync(manifestFile)).toEqual(manifestBefore);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(projectedDiagnostics()).toMatch(/(?:pendingOrphans|manifest|coherent|owned)/i);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("OpenCode CLI preflight before first write", () => {
  it.each([
    ["install", ["install", "--agents", "opencode", "--yes"]],
  ] as const)(
    "%s con binario v1 rechaza sin escribir writing-style, modelo, modo ni setup",
    async (command, args) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-cli-first-write-"));
      const homeDir = path.join(tmp, "home");
      const configDir = path.join(homeDir, ".config", "opencode");
      const binDir = path.join(tmp, "bin");
      const dataDir = path.join(homeDir, ".jorgex-stack");
      const writingStyleFile = path.join(dataDir, "writing-style.md");
      const modeFile = path.join(dataDir, "install-mode.json");
      const mapFile = path.join(dataDir, "model-map.json");
      const probeMarker = path.join(tmp, "opencode-probe.log");

      try {
        fs.mkdirSync(configDir, { recursive: true });
        writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
        writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });
        const modelMapBefore = fs.readFileSync(mapFile);

        // `install` resuelve Engram antes de runInstall; un binario existente
        // evita ese camino para que el rechazo observable sea el de OpenCode.
        const engramBin = path.join(tmp, "bin", "engram");
        fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.chmodSync(engramBin, 0o755);

        const code = await runCli(args, homeDir, {
          OPENCODE_CONFIG_DIR: configDir,
          PATH: binDir,
          ENGRAM_BIN: command === "install" ? engramBin : undefined,
          CODEX_HOME: undefined,
          CLAUDE_CONFIG_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
          XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
          XDG_DATA_HOME: path.join(tmp, "xdg-data"),
          XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
          XDG_STATE_HOME: path.join(tmp, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
          TMPDIR: path.join(tmp, "tmp"),
        });

        expect(code).toBe(1);
        // La frontera debe rechazar antes de applyWritingStyle / ensureModels.
        expect(fs.existsSync(writingStyleFile)).toBe(false);
        expect(fs.existsSync(modeFile)).toBe(false);
        expect(fs.readFileSync(mapFile)).toEqual(modelMapBefore);
        expect(fs.readdirSync(configDir)).toEqual([]);
        expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("el canal de env para target no evita el probe de una instalación real", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-cli-env-no-bypass-"));
    const homeDir = path.join(tmp, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    const binDir = path.join(tmp, "bin");
    const dataDir = path.join(homeDir, ".jorgex-stack");
    const writingStyleFile = path.join(dataDir, "writing-style.md");
    const probeMarker = path.join(tmp, "opencode-probe.log");

    try {
      fs.mkdirSync(configDir, { recursive: true });
      writeOpenCodeBinary(binDir, { output: "1.2.3", markerFile: probeMarker });
      writeModelMap(homeDir, { opencode: OPEN_CODE_MODELS });
      // `install` resuelve Engram antes de runInstall; un binario existente evita
      // ese camino para que el rechazo observable sea el de OpenCode.
      const engramBin = path.join(binDir, "engram");
      fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.chmodSync(engramBin, 0o755);

      // Sin --target-dir, el canal de evidencia de target no aplica: el binario
      // v1 detectado debe probarse y rechazar antes de escribir.
      const code = await runCli(
        ["install", "--agents", "opencode", "--yes", "--mode", "human"],
        homeDir,
        {
          OPENCODE_CONFIG_DIR: configDir,
          PATH: binDir,
          JORGEX_OPENCODE_TARGET_MAJOR: "2",
          ENGRAM_BIN: engramBin,
          CODEX_HOME: undefined,
          CLAUDE_CONFIG_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
          XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
          XDG_DATA_HOME: path.join(tmp, "xdg-data"),
          XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
          XDG_STATE_HOME: path.join(tmp, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
          TMPDIR: path.join(tmp, "tmp"),
        },
      );

      expect(code).toBe(1);
      expect(fs.existsSync(writingStyleFile)).toBe(false);
      expect(fs.readdirSync(configDir)).toEqual([]);
      expect(recordedProbeArgs(probeMarker)).toMatch(/--version/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
