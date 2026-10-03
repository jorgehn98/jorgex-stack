/**
 * RED B3 (Specs T03/T04): ownership y unmerge de los defaults de servidor v2 y
 * del archivo compacto `cli.json`.
 *
 * El seam de ownership ya existe (FileAction.primaryModelOwnership → ledger
 * file-qualificado por runtime+configDir+campo); estos tests lo ejercitan con un
 * install real sobre HOME/XDG aislados y binario v2 fixture, no con un store nuevo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { FileAction, InstallContext } from "../src/adapters/types.js";
import { createBrowserControlReadyDouble } from "./helpers/browser-control-ready.js";
import { cleanupOpenCodeBinaries, opencodeV2Binary, writeOpenCodeBinary } from "./helpers/opencode-binary.js";
import { backupContains, snapshotEnv } from "./helpers/opencode-isolation.js";

/** Binario v2 fixture: el gate ejecuta el binario detectado, nunca un mock. */
const OPENCODE_V2_BIN = opencodeV2Binary();

afterAll(cleanupOpenCodeBinaries);

const promptLogs = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(() => true),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  info: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: promptLogs.intro,
  outro: promptLogs.outro,
  confirm: promptLogs.confirm,
  cancel: promptLogs.cancel,
  isCancel: promptLogs.isCancel,
  log: {
    info: promptLogs.info,
    warn: promptLogs.warn,
    step: promptLogs.step,
    success: promptLogs.success,
    error: promptLogs.error,
    message: promptLogs.message,
  },
}));

// El binario fixture se ejecuta de verdad (runDetectedBin interno del gate no
// se mockea); solo se neutraliza la detección de Engram.
vi.mock("../src/lib/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/detect.js")>("../src/lib/detect.js");
  return { ...actual, detectEngram: () => null };
});

/**
 * Frontera Browser Control (Spec T13): estas suites prueban modelo/config/
 * ownership/backup, no el publicador de Browser Control. El coordinador real
 * adquiriría el paquete publicado (`latest` + SRI) y sondearía el relay del
 * usuario; aquí se sustituyen SOLO las fronteras de adquisición y lectura
 * cacheada por un `ready` sintético para que el pipeline real (runInstall,
 * adapter, backups, manifest, permisos, Engram) y el uninstall offline sigan
 * ejecutándose sin red, relay ni perfiles. El doble NO certifica bytes oficiales
 * ni es evidencia del contrato Browser Control.
 */
const browserControlReady = createBrowserControlReadyDouble();

vi.mock("../src/lib/browser-control-runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/browser-control-runtime.js")>(
      "../src/lib/browser-control-runtime.js",
    );
  return { ...actual, prepareBrowserControlRuntime: browserControlReady.prepare, inspectCachedBrowserControlRuntime: browserControlReady.inspect };
});

// Defensa independiente del mock: si algún camino importara el módulo real, un
// puerto inválido garantiza que nunca se contacte el relay del usuario (19989
// por defecto). Se restaura al terminar el archivo.
const originalBrowserControlPort = process.env.BROWSER_CONTROL_PORT;
process.env.BROWSER_CONTROL_PORT = "not-a-port";

afterAll(() => {
  browserControlReady.cleanup();
  if (originalBrowserControlPort === undefined) delete process.env.BROWSER_CONTROL_PORT;
  else process.env.BROWSER_CONTROL_PORT = originalBrowserControlPort;
});

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

interface IsolatedHome {
  homeDir: string;
  configDir: string;
  stateDir: string;
  xdgConfigDir: string;
}

/** HOME/XDG aislados: ningún test toca la configuración personal del usuario. */
async function withIsolatedHome<T>(run: (input: IsolatedHome) => Promise<T>): Promise<T> {
  const root = mkTemp("jx-opencode-native-");
  const homeDir = path.join(root, "home");
  const configDir = path.join(homeDir, ".config", "opencode");
  const stateDir = path.join(root, "state");
  const xdgConfigDir = path.join(root, "xdg-config");
  const xdgDataDir = path.join(root, "xdg-data");
  const xdgCacheDir = path.join(root, "xdg-cache");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(xdgConfigDir, { recursive: true });
  fs.mkdirSync(xdgDataDir, { recursive: true });
  fs.mkdirSync(xdgCacheDir, { recursive: true });
  const restore = snapshotEnv([
    "HOME",
    "USERPROFILE",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "OPENCODE_CONFIG_DIR",
  ]);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.XDG_STATE_HOME = stateDir;
  process.env.XDG_CONFIG_HOME = xdgConfigDir;
  process.env.XDG_DATA_HOME = xdgDataDir;
  process.env.XDG_CACHE_HOME = xdgCacheDir;
  delete process.env.OPENCODE_CONFIG_DIR;
  try {
    vi.resetModules();
    return await run({ homeDir, configDir, stateDir, xdgConfigDir });
  } finally {
    restore();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withOpencodeDetection<T>(configDir: string, run: () => Promise<T>): Promise<T> {
  const install = await import("../src/install.js");
  const adapter = install.ADAPTERS.opencode;
  if (!adapter) throw new Error("Falta el adapter OpenCode");
  const detect = adapter.detect;
  adapter.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir });
  try {
    return await run();
  } finally {
    adapter.detect = detect;
  }
}

async function runOpencodeInstall(configDir: string): Promise<void> {
  await withOpencodeDetection(configDir, async () => {
    const install = await import("../src/install.js");
    const exitCode = await install.runInstall({
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
      engramBin: null,
      showSummary: false,
    });
    expect(exitCode).toBe(0);
  });
}

async function runOpencodeUninstall(configDir: string): Promise<void> {
  await withOpencodeDetection(configDir, async () => {
    const uninstall = await import("../src/uninstall.js");
    const exitCode = await uninstall.runUninstall({
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: false,
    });
    expect(exitCode).toBe(0);
  });
}

async function readOwnedFields(configDir: string): Promise<ReadonlySet<string>> {
  const { loadPrimaryModelOwnership, primaryModelOwnershipFile } = await import("../src/lib/tool-preferences.js");
  return loadPrimaryModelOwnership(primaryModelOwnershipFile(), "opencode", configDir);
}

/** Segmentos decodificados de cada ID de ownership (file-qualificado). */
function ownedSegments(owned: ReadonlySet<string>): string[][] {
  return [...owned].map((id) => JSON.parse(id) as string[]);
}

function covers(segments: string[][], ...prefix: string[]): boolean {
  return segments.some((parts) => prefix.every((part, index) => parts[index + 1] === part));
}

async function unmergeConfig(configDir: string, owned: ReadonlySet<string>): Promise<Record<string, any>> {
  const { opencodeAdapter } = await import("../src/adapters/opencode.js");
  const { loadCanonicalHooks, loadCanonicalMcp } = await import("../src/lib/canonical.js");
  const { stackRoot } = await import("../src/lib/paths.js");
  const { DEFAULT_MODEL_MAP } = await import("../src/lib/model-map.js");
  const ctx: InstallContext = {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.opencode,
    warnings: [],
    ownedPrimaryModelFields: owned,
  };
  const configFile = path.join(configDir, "opencode.json");
  const actions = opencodeAdapter.planUnmerge(loadCanonicalMcp(ctx.stackDir), loadCanonicalHooks(ctx.stackDir), ctx);
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === configFile);
  if (action?.kind !== "write") throw new Error("Falta la acción de unmerge de opencode.json");
  return JSON.parse(action.content) as Record<string, any>;
}

async function planServerConfig(configDir: string): Promise<{ actions: FileAction[]; warnings: string[] }> {
  const { opencodeAdapter } = await import("../src/adapters/opencode.js");
  const { loadCanonicalMcp } = await import("../src/lib/canonical.js");
  const { stackRoot } = await import("../src/lib/paths.js");
  const { DEFAULT_MODEL_MAP } = await import("../src/lib/model-map.js");
  const ctx: InstallContext = {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.opencode,
    warnings: [],
  };
  const actions = opencodeAdapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx);
  return { actions, warnings: ctx.warnings };
}

const SERVER_DEFAULT_PREFIXES: string[][] = [
  ["update"],
  ["agents", "plan"],
  ["agents", "title"],
  ["agents", "summary"],
  ["compaction"],
  ["formatter"],
  ["lsp"],
  ["worktree"],
];

describe("defaults de servidor v2: ownership real", () => {
  it("un install real registra ownership file-qualificado de los campos creados", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      await runOpencodeInstall(configDir);
      const owned = await readOwnedFields(configDir);
      const segments = ownedSegments(owned);

      // El ledger es compartido por runtime+configDir; cada ID sigue siendo
      // file-qualificado por basename y solo se admiten los archivos de esta
      // proyección (nunca un archivo desconocido).
      for (const parts of segments) expect(["opencode.json", "cli.json"], parts.join(" ")).toContain(parts[0]);

      // Hojas canónicas de los defaults de servidor, con ID file-qualificado.
      for (const leaf of [
        ["update"],
        ["agents", "plan", "disabled"],
        ["agents", "title", "model"],
        ["agents", "summary", "model"],
        ["compaction", "auto"],
        ["compaction", "keep", "tokens"],
        ["formatter"],
        ["lsp"],
        ["worktree", "directory"],
      ]) {
        expect(owned.has(JSON.stringify(["opencode.json", ...leaf])), leaf.join(".")).toBe(true);
      }

      // Campo exacto del archivo compacto en el mismo ledger.
      expect(owned.has(JSON.stringify(["cli.json", "session", "verbosity"]))).toBe(true);
    });
  });

  it("valores canónicos preexistentes no se reclaman ni se retiran", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      const configFile = path.join(configDir, "opencode.json");
      const preexisting = {
        update: "auto",
        formatter: true,
        lsp: false,
        worktree: { directory: "worktrees" },
        agents: {
          plan: { disabled: true },
          title: { model: "openai/gpt-6-luna#none" },
          summary: { model: "minimax/MiniMax-M3#thinking" },
        },
        compaction: { auto: true, keep: { tokens: 20000 } },
      };
      fs.writeFileSync(configFile, JSON.stringify(preexisting, null, 2) + "\n");

      await runOpencodeInstall(configDir);
      const owned = await readOwnedFields(configDir);
      const segments = ownedSegments(owned);
      for (const prefix of SERVER_DEFAULT_PREFIXES) {
        expect(covers(segments, ...prefix), `no reclamar ${prefix.join(".")}`).toBe(false);
      }

      const afterUnmerge = await unmergeConfig(configDir, owned);
      expect(afterUnmerge).toMatchObject(preexisting);
    });
  });

  it("el unmerge retira los valores canónicos owned y preserva los modificados", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      await runOpencodeInstall(configDir);
      const owned = await readOwnedFields(configDir);
      const configFile = path.join(configDir, "opencode.json");
      const installed = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, any>;

      const changed = structuredClone(installed) as Record<string, any>;
      changed.update = "disable";
      changed.formatter = false;
      changed.lsp = true;
      changed.worktree = { directory: "custom-worktrees" };
      changed.agents.plan.disabled = false;
      changed.agents.title.model = "user/title-model";
      changed.agents.summary.model = "user/summary-model";
      changed.compaction.auto = false;
      changed.compaction.keep.tokens = 5000;
      fs.writeFileSync(configFile, JSON.stringify(changed, null, 2) + "\n");

      const afterChanged = await unmergeConfig(configDir, owned);
      expect(afterChanged.update).toBe("disable");
      expect(afterChanged.formatter).toBe(false);
      expect(afterChanged.lsp).toBe(true);
      expect(afterChanged.worktree.directory).toBe("custom-worktrees");
      expect(afterChanged.agents.plan.disabled).toBe(false);
      expect(afterChanged.agents.title.model).toBe("user/title-model");
      expect(afterChanged.agents.summary.model).toBe("user/summary-model");
      expect(afterChanged.compaction.auto).toBe(false);
      expect(afterChanged.compaction.keep.tokens).toBe(5000);

      fs.writeFileSync(configFile, JSON.stringify(installed, null, 2) + "\n");
      const afterEqual = await unmergeConfig(configDir, owned);
      expect(afterEqual.update).toBeUndefined();
      expect(afterEqual.formatter).toBeUndefined();
      expect(afterEqual.lsp).toBeUndefined();
      expect(afterEqual.worktree).toBeUndefined();
      expect(afterEqual.agents?.plan?.disabled).toBeUndefined();
      expect(afterEqual.agents?.title?.model).toBeUndefined();
      expect(afterEqual.agents?.summary?.model).toBeUndefined();
      expect(afterEqual.compaction?.auto).toBeUndefined();
      expect(afterEqual.compaction?.keep).toBeUndefined();
      // Lo ajeno a estos defaults permanece.
      expect(afterEqual["$schema"]).toBe("https://opencode.ai/config.json");
    });
  });
});

/**
 * Oráculo literal e independiente de los defaults cliente v2 (Spec T19:12). Se
 * declara aquí, sin importar constantes del adapter, para que el RED falle por
 * defaults ausentes en el resultado real y no por una copia de la implementación.
 * `configDir` es la raíz efectiva (ctx.configDir): los paths de audio se derivan
 * de ella y no de un HOME fijo.
 */
function t19CliDefaults(configDir: string): Record<string, unknown> {
  const sound = (name: string): string => path.join(configDir, "sounds", name);
  return {
    theme: { name: "system", mode: "system" },
    session: { verbosity: "low", permissions: "autoaccept", tps: true },
    debug: { turn_tokens: true },
    attention: {
      notifications: true,
      sound: true,
      volume: 0.1,
      sounds: {
        done: sound("done.wav"),
        subagent_done: sound("done.wav"),
        question: sound("attention.wav"),
        permission: sound("attention.wav"),
        error: sound("attention.wav"),
        default: sound("attention.wav"),
      },
    },
  };
}

/** IDs file-qualificados de las hojas T19 y los contenedores creados en fresco. */
function t19CliOwnedFields(): string[] {
  const field = (...segments: string[]): string => JSON.stringify(["cli.json", ...segments]);
  return [
    field("theme"),
    field("theme", "name"),
    field("theme", "mode"),
    field("session"),
    field("session", "verbosity"),
    field("session", "permissions"),
    field("session", "tps"),
    field("debug"),
    field("debug", "turn_tokens"),
    field("attention"),
    field("attention", "notifications"),
    field("attention", "sound"),
    field("attention", "volume"),
    field("attention", "sounds"),
    field("attention", "sounds", "done"),
    field("attention", "sounds", "subagent_done"),
    field("attention", "sounds", "question"),
    field("attention", "sounds", "permission"),
    field("attention", "sounds", "error"),
    field("attention", "sounds", "default"),
  ];
}

/**
 * Duración en segundos de un WAV RIFF parseado de forma independiente (sin
 * importar utilidades de implementación): recorre chunks y usa `data`/`byteRate`.
 */
function wavDurationSeconds(bytes: Buffer): number {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("no es un contenedor RIFF/WAVE");
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") byteRate = bytes.readUInt32LE(body + 8);
    else if (id === "data") {
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (byteRate <= 0) throw new Error("WAV sin byteRate");
  return dataSize / byteRate;
}

describe("cli.json compacto (B3)", () => {
  it("proyecta cli.json fresco con los defaults cliente T19 y reclama hojas/contenedores creados", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      const cliFile = path.join(configDir, "cli.json");
      const { actions } = await planServerConfig(configDir);

      const cliAction = actions.find((candidate) => candidate.kind === "write" && candidate.target === cliFile);
      expect(cliAction, "B3: falta la proyección de cli.json").toBeDefined();
      if (cliAction?.kind !== "write") throw new Error("Falta la escritura de cli.json");

      // Defaults T19 exactos, con paths de audio derivados de ctx.configDir.
      expect(JSON.parse(cliAction.content)).toEqual(t19CliDefaults(configDir));

      // Claims por hoja y contenedor creados; ningún claim inesperado.
      const owned = new Set(
        (cliAction.primaryModelOwnership ?? []).filter((change) => change.owned).map((change) => change.field),
      );
      expect(owned).toEqual(new Set(t19CliOwnedFields()));

      // Ningún ajuste de verbosity pertenece al server config ni al modelo.
      const serverAction = actions.find((candidate) => candidate.kind === "write" && candidate.target === path.join(configDir, "opencode.json"));
      if (serverAction?.kind !== "write") throw new Error("Falta la escritura de opencode.json");
      expect(serverAction.content).not.toContain("verbosity");
    });
  });

  const cliPreservationCases: Array<[string, { session: { verbosity: string }; theme?: { name: string } }]> = [
    ["igual low", { session: { verbosity: "low" } }],
    ["custom high", { session: { verbosity: "high" }, theme: { name: "user-theme" } }],
  ];
  it.each(cliPreservationCases)("cli.json existente %s: valores previos se preservan y no se reclaman", async (_label, existing) => {
    await withIsolatedHome(async ({ configDir }) => {
      const cliFile = path.join(configDir, "cli.json");
      fs.writeFileSync(cliFile, JSON.stringify(existing, null, 2) + "\n");

      const { actions } = await planServerConfig(configDir);
      const cliAction = actions.find((candidate) => candidate.kind === "write" && candidate.target === cliFile);
      // Faltan defaults T19: se siembran, pero los valores previos no se tocan.
      expect(cliAction, "debe sembrar los defaults ausentes").toBeDefined();
      if (cliAction?.kind !== "write") throw new Error("Falta la escritura de cli.json");

      const content = JSON.parse(cliAction.content) as {
        session?: { verbosity?: string };
        theme?: { name?: string };
      };
      expect(content.session?.verbosity, "el valor previo se preserva").toBe(existing.session.verbosity);
      if (existing.theme !== undefined) {
        expect(content.theme?.name, "el valor previo se preserva").toBe(existing.theme.name);
      }

      const owned = new Set(
        (cliAction.primaryModelOwnership ?? []).filter((change) => change.owned).map((change) => change.field),
      );
      expect(owned.has(JSON.stringify(["cli.json", "session", "verbosity"])), "un valor previo no se reclama").toBe(false);
      if (existing.theme !== undefined) {
        expect(owned.has(JSON.stringify(["cli.json", "theme", "name"])), "un valor previo no se reclama").toBe(false);
      }
    });
  });

  it("con tui.json legacy pendiente no precrea cli.json", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      fs.writeFileSync(path.join(configDir, "tui.json"), JSON.stringify({ theme: { name: "legacy" } }, null, 2) + "\n");

      const { actions, warnings } = await planServerConfig(configDir);
      expect(actions.find((candidate) => candidate.kind === "write" && candidate.target === path.join(configDir, "cli.json"))).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/cli\.json|migra/i);
    });
  });

  it("con kv.json de estado legacy pendiente no precrea cli.json", async () => {
    await withIsolatedHome(async ({ configDir, stateDir }) => {
      const kvDir = path.join(stateDir, "opencode");
      fs.mkdirSync(kvDir, { recursive: true });
      fs.writeFileSync(path.join(kvDir, "kv.json"), JSON.stringify({ preferences: { theme: "legacy" } }, null, 2) + "\n");

      const { actions, warnings } = await planServerConfig(configDir);
      expect(actions.find((candidate) => candidate.kind === "write" && candidate.target === path.join(configDir, "cli.json"))).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/cli\.json|migra/i);
    });
  });

  it("install real siembra cli.json low y uninstall lo retira preservando claves ajenas", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      await runOpencodeInstall(configDir);
      const cliFile = path.join(configDir, "cli.json");
      expect(fs.existsSync(cliFile), "B3: install debe crear cli.json").toBe(true);
      const installed = JSON.parse(fs.readFileSync(cliFile, "utf8")) as Record<string, any>;
      expect(installed.session.verbosity).toBe("low");

      installed.theme = { name: "user-theme" };
      fs.writeFileSync(cliFile, JSON.stringify(installed, null, 2) + "\n");

      await runOpencodeUninstall(configDir);
      expect(fs.existsSync(cliFile), "uninstall no debe borrar claves ajenas de cli.json").toBe(true);
      const afterUninstall = JSON.parse(fs.readFileSync(cliFile, "utf8")) as Record<string, any>;
      expect(afterUninstall.session?.verbosity).toBeUndefined();
      expect(afterUninstall.theme).toEqual({ name: "user-theme" });
    });
  });

  it("un low modificado se preserva en uninstall", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      await runOpencodeInstall(configDir);
      const cliFile = path.join(configDir, "cli.json");
      fs.writeFileSync(cliFile, JSON.stringify({ session: { verbosity: "high" }, theme: { name: "user-theme" } }, null, 2) + "\n");

      await runOpencodeUninstall(configDir);
      expect(fs.existsSync(cliFile), "uninstall no debe borrar un cli.json modificado").toBe(true);
      const afterUninstall = JSON.parse(fs.readFileSync(cliFile, "utf8")) as Record<string, any>;
      expect(afterUninstall.session.verbosity).toBe("high");
      expect(afterUninstall.theme).toEqual({ name: "user-theme" });
    });
  });

  it.each([
    ["escalar", 123],
    ["array", [1, 2]],
  ])("session %s existente no se sobrescribe y deja remedio", async (_label, session) => {
    await withIsolatedHome(async ({ configDir }) => {
      const cliFile = path.join(configDir, "cli.json");
      const original = JSON.stringify({ session, theme: { name: "user-theme" } }, null, 2) + "\n";
      fs.writeFileSync(cliFile, original);

      const { actions, warnings } = await planServerConfig(configDir);
      const cliAction = actions.find((candidate) => candidate.kind === "write" && candidate.target === cliFile);

      // Sin acción o bytes idénticos: jamás se reemplaza un `session` ajeno.
      if (cliAction?.kind === "write") {
        expect(cliAction.content).toBe(original);
        expect((cliAction.primaryModelOwnership ?? []).filter((change) => change.owned)).toEqual([]);
      } else {
        expect(cliAction).toBeUndefined();
      }
      expect(warnings.join("\n")).toMatch(/cli\.json|session/i);
    });
  });

  it("cli.json vacío se trata como ausente y siembra los defaults T19", async () => {
    await withIsolatedHome(async ({ configDir }) => {
      const cliFile = path.join(configDir, "cli.json");
      fs.writeFileSync(cliFile, "\n   \n");

      const { actions } = await planServerConfig(configDir);
      const cliAction = actions.find((candidate) => candidate.kind === "write" && candidate.target === cliFile);
      expect(cliAction, "cli.json vacío debe sembrar los defaults T19").toBeDefined();
      if (cliAction?.kind !== "write") throw new Error("Falta la escritura de cli.json");
      expect(JSON.parse(cliAction.content)).toEqual(t19CliDefaults(configDir));
      const owned = new Set(
        (cliAction.primaryModelOwnership ?? []).filter((change) => change.owned).map((change) => change.field),
      );
      expect(owned).toEqual(new Set(t19CliOwnedFields()));
    });
  });

  it("install real proyecta los dos WAV T19, reconcilia byte-idéntico y uninstall los retira owned con backup", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      const doneWav = path.join(configDir, "sounds", "done.wav");
      const attentionWav = path.join(configDir, "sounds", "attention.wav");

      await runOpencodeInstall(configDir);

      // 1) Dos targets reales derivados del mismo configDir.
      expect(fs.existsSync(doneWav), "falta sounds/done.wav tras install").toBe(true);
      expect(fs.existsSync(attentionWav), "falta sounds/attention.wav tras install").toBe(true);

      // 2) Formato RIFF/WAVE válido y duración < 0.5s (oráculo independiente).
      const doneBytes = fs.readFileSync(doneWav);
      const attentionBytes = fs.readFileSync(attentionWav);
      for (const [label, bytes] of [["done", doneBytes], ["attention", attentionBytes]] as const) {
        expect(bytes.subarray(0, 4).toString("ascii"), `${label}: cabecera RIFF`).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii"), `${label}: formato WAVE`).toBe("WAVE");
        expect(wavDurationSeconds(bytes), `${label}: duración < 0.5s`).toBeLessThan(0.5);
      }

      // El path del cliente deriva del mismo configDir que el target real.
      const cli = JSON.parse(fs.readFileSync(path.join(configDir, "cli.json"), "utf8")) as {
        attention?: { sounds?: { done?: string; default?: string } };
      };
      expect(cli.attention?.sounds?.done, "el path del cliente deriva del mismo configDir").toBe(doneWav);
      expect(cli.attention?.sounds?.default, "el path del cliente deriva del mismo configDir").toBe(attentionWav);

      // 3) Ownership: solo los dos targets creados entran al manifest owned.
      const { readManifest } = await import("../src/lib/manifest.js");
      const owned = (): string[] => (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file));
      expect(owned(), "el WAV creado se reclama").toContain(path.resolve(doneWav));
      expect(owned(), "el WAV creado se reclama").toContain(path.resolve(attentionWav));

      // 4) Reconcile: una segunda pasada es byte-idéntica.
      await runOpencodeInstall(configDir);
      expect(fs.readFileSync(doneWav).equals(doneBytes), "reconcile no reescribe done.wav").toBe(true);
      expect(fs.readFileSync(attentionWav).equals(attentionBytes), "reconcile no reescribe attention.wav").toBe(true);

      // 5) Uninstall: el WAV owned canónico se respalda y se retira.
      await runOpencodeUninstall(configDir);
      expect(fs.existsSync(doneWav), "uninstall retira el WAV owned").toBe(false);
      expect(fs.existsSync(attentionWav), "uninstall retira el WAV owned").toBe(false);
      expect(backupContains(homeDir, doneBytes), "el WAV owned se respalda antes de retirarse").toBe(true);
      expect(backupContains(homeDir, attentionBytes), "el WAV owned se respalda antes de retirarse").toBe(true);

      // 6) Manual igual/unowned: se conserva sin claim y no se retira.
      fs.mkdirSync(path.dirname(doneWav), { recursive: true });
      fs.writeFileSync(doneWav, doneBytes);
      fs.writeFileSync(attentionWav, attentionBytes);
      await runOpencodeInstall(configDir);
      expect(fs.readFileSync(doneWav).equals(doneBytes), "un manual igual no se pisa").toBe(true);
      expect(fs.readFileSync(attentionWav).equals(attentionBytes), "un manual igual no se pisa").toBe(true);
      expect(owned(), "la coincidencia de bytes no acredita ownership").not.toContain(path.resolve(doneWav));
      expect(owned(), "la coincidencia de bytes no acredita ownership").not.toContain(path.resolve(attentionWav));

      await runOpencodeUninstall(configDir);
      expect(fs.existsSync(doneWav), "un WAV unowned no se borra").toBe(true);
      expect(fs.existsSync(attentionWav), "un WAV unowned no se borra").toBe(true);
      expect(fs.readFileSync(doneWav).equals(doneBytes)).toBe(true);
      expect(fs.readFileSync(attentionWav).equals(attentionBytes)).toBe(true);
    });
  });
});

describe("raíz nativa y aislamiento de --target-dir", () => {
  it("--target-dir no lee el state personal y siembra cli.json dentro del target", async () => {
    await withIsolatedHome(async ({ homeDir, stateDir }) => {
      const target = path.join(homeDir, "target-opencode");
      fs.mkdirSync(target, { recursive: true });

      // Fuente legacy en el state "personal", fuera del target.
      const personalKvDir = path.join(stateDir, "opencode");
      fs.mkdirSync(personalKvDir, { recursive: true });
      const personalKv = path.join(personalKvDir, "kv.json");
      const kvBytes = JSON.stringify({ preferences: { theme: "personal" } }, null, 2) + "\n";
      fs.writeFileSync(personalKv, kvBytes);

      const readSpy = vi.spyOn(fs, "readFileSync");
      try {
        const install = await import("../src/install.js");
        const exitCode = await install.runInstall({
          runtimes: ["opencode"],
          targetDir: target,
          opencodeTargetMajor: 2,
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          engramBin: null,
          showSummary: false,
        });
        expect(exitCode).toBe(0);

        // Camino offline: el coordinador Browser Control (red/relay) no se llama.
        expect(
          browserControlReady.prepare,
          "--target-dir no debe llamar al coordinador Browser Control",
        ).not.toHaveBeenCalled();

        // Frontera real: el state personal no se lee bajo --target-dir.
        const readPaths = readSpy.mock.calls.map((call) => String(call[0]));
        expect(readPaths, "el state personal no debe leerse con --target-dir").not.toContain(personalKv);

        const cliFile = path.join(target, "cli.json");
        expect(fs.existsSync(cliFile), "--target-dir debe sembrar cli.json en el target").toBe(true);
        const cli = JSON.parse(fs.readFileSync(cliFile, "utf8")) as { session?: { verbosity?: string } };
        expect(cli.session?.verbosity).toBe("low");

        expect(fs.readFileSync(personalKv, "utf8")).toBe(kvBytes);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it("resuelve la raíz nativa como OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME > HOME", async () => {
    await withIsolatedHome(async ({ xdgConfigDir }) => {
      const binDir = mkTemp("jx-opencode-root-bin-");
      const bin = writeOpenCodeBinary(binDir);
      const explicitDir = mkTemp("jx-opencode-root-explicit-");
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

      try {
        const { detectOpenCode } = await import("../src/lib/detect.js");
        const { opencodeAdapter } = await import("../src/adapters/opencode.js");
        const { HOME } = await import("../src/lib/paths.js");

        delete process.env.XDG_CONFIG_HOME;
        const homeRoot = detectOpenCode();
        expect(homeRoot.configDir).toBe(path.join(HOME, ".config", "opencode"));
        expect(homeRoot.binPath).toBe(bin);

        process.env.XDG_CONFIG_HOME = xdgConfigDir;
        expect(detectOpenCode().configDir).toBe(path.join(xdgConfigDir, "opencode"));

        process.env.OPENCODE_CONFIG_DIR = explicitDir;
        expect(detectOpenCode().configDir).toBe(explicitDir);

        // La misma raíz alimenta main y CLI; los skills siguen anclados a HOME.
        const paths = opencodeAdapter.paths(explicitDir);
        expect(paths.systemPromptFile).toBe(path.join(explicitDir, "AGENTS.md"));
        expect(paths.skillsDir).toBe(path.join(HOME, ".agents", "skills"));

        const { actions } = await planServerConfig(explicitDir);
        const targets = actions.filter((action) => action.kind === "write").map((action) => action.target);
        expect(targets).toContain(path.join(explicitDir, "opencode.json"));
        expect(targets).toContain(path.join(explicitDir, "cli.json"));
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
  });
});

/**
 * RED B5 (Spec 04:38 "Prueba decisiva de migración"): transferir SOLO marcas y
 * valores legacy conocidos y exactos al archivo/basename real; un modelo ya
 * modificado a mano a 6.1 se conserva sin reclamarlo por coincidencia y la marca
 * legacy se libera tras resultado verificado. Legacy ajeno o límites modificados
 * quedan preservados/bloqueados con remedio ANTES de escribir.
 *
 * Fuente v1 real (base 8780ba1, `src/adapters/opencode.ts:71-79`):
 * `PRIMARY_MODEL = openai/gpt-5.6-sol`, ID `gpt-5.6-sol`, límites
 * 872000/744000/128000 y nueve IDs dotted basados en ese ID (no existe owner
 * legacy 6.1; reclamar un 6.1 manual como propio sería un error).
 */
describe("ledger v1 dotted → IDs file-qualificados (B5)", () => {
  const LEGACY_MODEL = "openai/gpt-5.6-sol";
  const LEGACY_MODEL_ID = "gpt-5.6-sol";
  const V2_MODEL = "openai/gpt-6.1-sol";
  const V2_MODEL_ID = "gpt-6.1-sol";
  const LEGACY_SOL = `provider.openai.models.${LEGACY_MODEL_ID}`;
  const LEGACY_LIMITS = { context: 872000, input: 744000, output: 128000 };

  /** Los ocho IDs dotted provider del adapter v1. */
  const LEGACY_PROVIDER_FIELDS = [
    "provider",
    "provider.openai",
    "provider.openai.models",
    LEGACY_SOL,
    `${LEGACY_SOL}.limit`,
    `${LEGACY_SOL}.limit.context`,
    `${LEGACY_SOL}.limit.input`,
    `${LEGACY_SOL}.limit.output`,
  ];
  /** Los nueve IDs dotted exactos (model + provider). */
  const LEGACY_V1_FIELDS = ["model", ...LEGACY_PROVIDER_FIELDS];

  const V2_LIMIT_FIELDS = (["context", "input", "output"] as const).map((key) =>
    JSON.stringify(["opencode.json", "providers", "openai", "models", V2_MODEL_ID, "limit", key]));
  const V2_MODEL_FIELD = JSON.stringify(["opencode.json", "model"]);

  type LegacyOpenai = { models: Record<string, Record<string, unknown>> } & Record<string, unknown>;

  /** Config v1 tal como la escribía el adapter v1 (sin secretos). */
  function legacyConfig(overrides: { model?: string; context?: number } = {}): Record<string, unknown> {
    return {
      model: overrides.model ?? LEGACY_MODEL,
      theme: { name: "user-theme" },
      provider: {
        openai: {
          models: {
            [LEGACY_MODEL_ID]: {
              limit: { ...LEGACY_LIMITS, ...(overrides.context === undefined ? {} : { context: overrides.context }) },
            },
          },
        },
      },
    };
  }

  function openaiOf(config: Record<string, unknown>): LegacyOpenai {
    return (config["provider"] as { openai: LegacyOpenai }).openai;
  }

  function writeConfig(configDir: string, config: Record<string, unknown>): string {
    const file = path.join(configDir, "opencode.json");
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    return fs.readFileSync(file, "utf8");
  }

  /** Ledger v1 con la prueba de configDir que exigía el store. */
  function writeLedger(homeDir: string, configDir: string, fields: readonly string[]): string {
    const ledgerFile = path.join(homeDir, ".jorgex-stack", "primary-model.json");
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({
      version: 1,
      owned: { opencode: { [path.resolve(configDir)]: Object.fromEntries(fields.map((field) => [field, true])) } },
    }) + "\n");
    return ledgerFile;
  }

  function ledgerFields(ledgerFile: string, configDir: string): string[] {
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as {
      owned: Record<string, Record<string, Record<string, true>>>;
    };
    return Object.keys(ledger.owned.opencode?.[path.resolve(configDir)] ?? {});
  }

  function readConfig(configDir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")) as Record<string, unknown>;
  }

  async function installExitCode(configDir: string): Promise<number | string | undefined> {
    return withOpencodeDetection(configDir, async () => {
      const install = await import("../src/install.js");
      return install.runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        engramBin: null,
        showSummary: false,
      });
    });
  }

  it("migra el canon 5.6 owned exacto a los targets 6.1, retira el legacy con backup y deja el model owned", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      const bytesBefore = writeConfig(configDir, legacyConfig());
      const themeBefore = readConfig(configDir)["theme"];
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);

      // RED esperado con la fuente actual: el plan no revierte el model a 6.1 ni
      // retira el legacy (queda como doble home), así que estas aserciones cortan.
      await runOpencodeInstall(configDir);

      const config = readConfig(configDir) as {
        model?: string;
        theme?: unknown;
        provider?: { openai?: { models?: Record<string, unknown> } };
        providers?: { openai?: { models?: Record<string, { limit?: Record<string, number> }> } };
      };
      // Target canónico T04: el valor owned exacto se transfiere al 6.1…
      expect(config.model).toBe(V2_MODEL);
      expect(config.providers?.openai?.models?.[V2_MODEL_ID]?.limit).toEqual(LEGACY_LIMITS);
      // …y el legacy owned exacto se retira por completo (sin dos homes activas),
      // preservando lo ajeno.
      expect(config.provider, "el contenedor legacy owned debe quedar podado").toBeUndefined();
      expect(config.theme).toEqual(themeBefore);

      // El rewrite de la migración respalda el estado previo.
      const { listBackups } = await import("../src/lib/backup.js");
      const entry = listBackups()
        .flatMap((backup) => backup.files.map((file) => ({ backup, file })))
        .find(({ file }) => file.original === path.join(configDir, "opencode.json"));
      expect(entry, "la migración debe respaldar el config antes de reescribirlo").toBeDefined();
      expect(fs.readFileSync(entry!.file.stored, "utf8")).toBe(bytesBefore);

      // Marcas: legacy liberadas, nativas file-qualificadas presentes.
      const fields = ledgerFields(ledgerFile, configDir);
      for (const legacy of LEGACY_V1_FIELDS) {
        expect(fields, `el ID v1 ${legacy} debe liberarse`).not.toContain(legacy);
      }
      expect(fields).toContain(V2_MODEL_FIELD);
      for (const field of V2_LIMIT_FIELDS) expect(fields).toContain(field);

      // El ownership migrado queda operativo: uninstall retira el model ya
      // canónico y los límites, sin tocar lo ajeno.
      await runOpencodeUninstall(configDir);
      const afterUninstall = readConfig(configDir) as {
        model?: string;
        theme?: unknown;
        providers?: { openai?: { models?: Record<string, { limit?: Record<string, number> }> } };
      };
      expect(afterUninstall.model, "el model migrado es owned y canónico: uninstall lo retira").toBeUndefined();
      expect(afterUninstall.providers?.openai?.models?.[V2_MODEL_ID]?.limit).toBeUndefined();
      expect(afterUninstall.theme).toEqual(themeBefore);
    });
  });

  it("no reclama un model 6.1 modificado a mano aunque el ID v1 `model` esté owned", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      // El usuario cambió el modelo al valor canónico v2: el valor solo no acredita
      // propiedad, así que no se reclama; el provider/limit legacy sí es puro.
      writeConfig(configDir, legacyConfig({ model: V2_MODEL }));
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);

      await runOpencodeInstall(configDir);

      const fields = ledgerFields(ledgerFile, configDir);
      expect(fields, "un valor manual igual no se reclama").not.toContain(V2_MODEL_FIELD);
      expect(fields, "el flag v1 del modelo se libera al migrar").not.toContain("model");
      expect(fields).toContain(V2_LIMIT_FIELDS[0]!);

      const config = readConfig(configDir) as { model?: string };
      expect(config.model).toBe(V2_MODEL);
    });
  });

  it.each([
    [
      "endpoint y campo extra ajenos en el provider.openai owned",
      (config: Record<string, unknown>) => {
        const openai = openaiOf(config);
        openai["api"] = { baseURL: "https://api.example.invalid/v1" };
        openai.models[LEGACY_MODEL_ID]!["extra"] = { note: "user" };
      },
    ],
    [
      "modelo ajeno adicional bajo el mismo provider.openai",
      (config: Record<string, unknown>) => {
        openaiOf(config).models["user-other-model"] = { limit: { context: 1000, output: 100 } };
      },
    ],
  ])("con las 8 marcas dotted y límites canónicos pero %s: falla cerrado y preserva todo", async (_label, addForeign) => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      const config = legacyConfig();
      addForeign(config);
      const bytesBefore = writeConfig(configDir, config);
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);
      const ledgerBefore = fs.readFileSync(ledgerFile, "utf8");

      // Las marcas solas no acreditan: escribir el native ocultaría el entry
      // legacy ajeno (migrate-v1: native válido prevalece), así que se bloquea
      // antes de escribir cualquier byte.
      expect(await installExitCode(configDir), "debe fallar cerrado").toBe(1);
      expect(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).toBe(bytesBefore);
      expect(fs.readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);
    });
  });

  it("no acredita las 8 marcas dotted sobre otro basename: un opencode.jsonc aislado queda cerrado", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      // Frontera Spec 04:38 + escritura histórica v1. El MainConfig v1 escribía
      // SIEMPRE `opencode.json` (git 8780ba1:335 y 514; el archivo solo aparece en
      // helpers de lectura de las dos variantes), así que las marcas dotted
      // acreditan ese basename y no un `.jsonc` con el mismo contenido: sin
      // `opencode.json`, el contenido es coincidencia manual, no escritura nuestra.
      const jsoncFile = path.join(configDir, "opencode.jsonc");
      const jsonFile = path.join(configDir, "opencode.json");
      const bytesBefore = JSON.stringify(legacyConfig(), null, 2) + "\n";
      fs.writeFileSync(jsoncFile, bytesBefore);
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);
      const ledgerBefore = fs.readFileSync(ledgerFile, "utf8");

      expect(fs.existsSync(jsonFile), "el escenario es .jsonc aislado").toBe(false);
      expect(await installExitCode(configDir), "no debe reclamar ni migrar ese basename").toBe(1);
      expect(fs.readFileSync(jsoncFile, "utf8")).toBe(bytesBefore);
      expect(fs.readFileSync(ledgerFile, "utf8"), "sin claim nuevo por coincidencia de basename").toBe(ledgerBefore);
      expect(fs.existsSync(jsonFile), "no debe crear el archivo que el v1 escribía").toBe(false);
    });
  });

  it("un provider.<otroId> legacy puede seguir preservado sin bloquear la migración", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      const config = legacyConfig();
      (config["provider"] as Record<string, unknown>)["other"] = {
        models: { "user-model": { limit: { context: 1000, output: 100 } } },
      };
      writeConfig(configDir, config);
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);

      await runOpencodeInstall(configDir);

      const after = readConfig(configDir) as {
        model?: string;
        provider?: { other?: unknown };
        providers?: { openai?: { models?: Record<string, { limit?: Record<string, number> }> } };
      };
      // Otro id no queda oculto por `providers.openai`: se preserva, y la
      // migración del canon openai 5.6 procede.
      expect(after.provider?.other).toEqual({ models: { "user-model": { limit: { context: 1000, output: 100 } } } });
      expect(after.model).toBe(V2_MODEL);
      expect(after.providers?.openai?.models?.[V2_MODEL_ID]?.limit).toEqual(LEGACY_LIMITS);
      expect(ledgerFields(ledgerFile, configDir)).toContain(V2_MODEL_FIELD);
    });
  });

  it("un legacy 5.6 igual al v1 pero SIN owner queda cerrado y preserva bytes", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      writeConfig(configDir, legacyConfig());
      const configPath = path.join(configDir, "opencode.json");
      const bytesBefore = fs.readFileSync(configPath, "utf8");
      // Sin owner: la igualdad de valor no autentica la entrada legacy.
      writeLedger(homeDir, configDir, []);

      expect(await installExitCode(configDir)).toBe(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(bytesBefore);
    });
  });

  it("un límite owned modificado a mano no se acredita como puroOld: preserva y deja remedio", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      writeConfig(configDir, legacyConfig({ context: 999999 }));
      const configPath = path.join(configDir, "opencode.json");
      const bytesBefore = fs.readFileSync(configPath, "utf8");
      writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);

      expect(await installExitCode(configDir)).toBe(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(bytesBefore);
      const messages = promptLogs.error.mock.calls.flat().map((value) => String(value)).join("\n");
      expect(messages).toMatch(/remed|revisa|corrige|restaura|reintentar|acredita/i);
    });
  });

  /**
   * Fix de review ff7a54f (Spec 04:62): el preflight de coherencia con un
   * manifest existente debe disponer del ownership verificado aunque no
   * consulte preferencias browser. El fixture previo cubría solo el ledger sin
   * manifest; con AMBOS, el preflight actual construye el plan con ownership
   * vacío y el `provider.openai` v1 legítimo (9 marcas dotted propias) se
   * clasifica como legacy ajeno: install falla cerrado y no migra.
   */
  it("migra el canon 5.6 owned con manifest gestionado y ledger v1 simultáneos", async () => {
    await withIsolatedHome(async ({ homeDir, configDir }) => {
      // 1) Instalación real previa: manifest gestionado + recursos estáticos
      // actuales (bytes current, ownership neutral).
      await runOpencodeInstall(configDir);
      const manifestFile = path.join(homeDir, ".jorgex-stack", "manifest.json");
      expect(fs.existsSync(manifestFile), "la instalación real debe crear el manifest").toBe(true);
      const manifestOwned = (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        runtimes: { opencode?: { owned?: string[] } };
      }).runtimes.opencode?.owned ?? [];
      expect(
        manifestOwned.map((file) => path.resolve(file)),
        "los recursos estáticos actuales quedan owned en el manifest",
      ).toContain(path.resolve(configDir, "plugins", "hooks.ts"));

      // 2) Estado v1 exacto: config legacy 5.6 con límites puros + las nueve
      // marcas dotted owned.
      const bytesBefore = writeConfig(configDir, legacyConfig());
      const themeBefore = readConfig(configDir)["theme"];
      const ledgerFile = writeLedger(homeDir, configDir, LEGACY_V1_FIELDS);

      // 3) Con manifest + ledger simultáneos el pipeline real debe migrar.
      expect(await installExitCode(configDir), "manifest+ledger v1 deben migrar, no bloquear").toBe(0);

      const config = readConfig(configDir) as {
        model?: string;
        theme?: unknown;
        provider?: unknown;
        providers?: { openai?: { models?: Record<string, { limit?: Record<string, number> }> } };
      };
      expect(config.model).toBe(V2_MODEL);
      expect(config.providers?.openai?.models?.[V2_MODEL_ID]?.limit).toEqual(LEGACY_LIMITS);
      expect(config.provider, "sin provider legacy oculto ni doble home").toBeUndefined();
      expect(config.theme).toEqual(themeBefore);

      const { listBackups } = await import("../src/lib/backup.js");
      const entry = listBackups()
        .flatMap((backup) => backup.files.map((file) => ({ backup, file })))
        .find(({ file }) => file.original === path.join(configDir, "opencode.json"));
      expect(entry, "la migración debe respaldar el config v1").toBeDefined();
      expect(fs.readFileSync(entry!.file.stored, "utf8")).toBe(bytesBefore);

      const fields = ledgerFields(ledgerFile, configDir);
      for (const legacy of LEGACY_V1_FIELDS) {
        expect(fields, `el ID v1 ${legacy} debe liberarse`).not.toContain(legacy);
      }
      expect(fields).toContain(V2_MODEL_FIELD);
      for (const field of V2_LIMIT_FIELDS) expect(fields).toContain(field);
    });
  });
});
