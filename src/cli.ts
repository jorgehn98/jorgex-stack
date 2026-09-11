import * as p from "@clack/prompts";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { InstallModePreference, RuntimeId, SelectableRuntimeId, SubagentConcurrency } from "./adapters/types.js";
import { ADAPTERS, resolvePlaywrightToolPlan, runInstall } from "./install.js";
import { runUninstall } from "./uninstall.js";
import { runDoctor } from "./doctor.js";
import { runUpdateCheck, runInteractiveUpdate, updateEngram, type InteractiveUpdateResult } from "./update.js";
import { runModelsPicker } from "./models-picker.js";
import { listBackups, restoreBackup } from "./lib/backup.js";
import { readWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot } from "./lib/writing-style.js";
import { readPackageVersion } from "./lib/release.js";
import { loadModelMap } from "./lib/model-map.js";
import {
  DEFAULT_INSTALL_MODE_PREFERENCE,
  hasInstallModePreference,
  installModePreferenceFile,
  loadInstallModePreference,
  parseInstallModePreferenceFlags,
  saveInstallModePreference,
} from "./lib/install-mode.js";
import { browserPreferenceErrors, devtoolsMcpPreferenceFile, loadDevtoolsMcpPreference, loadPlaywrightCliPreference, type PlaywrightRuntimeSelection } from "./lib/tool-preferences.js";
import {
  detectPiRuntime,
  PI_RUNTIME_CANDIDATE,
  hasManagedPiRuntime,
  resolvePiEngramBin,
  resolvePiEngramRequirement,
  type PiRuntimeOperation,
} from "./lib/pi-runtime.js";
import { runManagedPiSystem } from "./lib/pi-managed-runtime.js";
import { writeText } from "./lib/fsx.js";
import { runQualityPlan } from "./lib/quality-runner.js";
import { serializeQualityReceipt } from "./lib/quality-receipt.js";
import { installMissingEngram } from "./lib/engram-install.js";

const VERSION = readPackageVersion();

const COMMANDS = ["install", "sync", "models", "update", "doctor", "restore", "uninstall", "quality"] as const;
export type Command = (typeof COMMANDS)[number];

export interface Flags {
  agents: SelectableRuntimeId[];
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  mode?: string;
  subagentConcurrency?: string;
  help: boolean;
  version: boolean;
  list: boolean;
  check: boolean;
  removeEngram: boolean;
  engram: boolean;
  playwright: boolean;
  playwrightRuntimes?: SelectableRuntimeId[];
  removePlaywright: boolean;
  devtools: boolean;
  noDevtools: boolean;
  receipt?: string;
  positional: string[];
  unknownFlags: string[];
}

export interface ParsedCli {
  action: "run" | "help" | "version" | "unknown" | "unknown-flags";
  command: Command;
  flags: Flags;
  unknownCommand?: string;
}

const QUALITY_REJECTED_VALUE_FLAGS = new Set([
  "--agents",
  "--playwright-runtimes",
  "-a",
  "--target-dir",
  "--mode",
  "--subagent-concurrency",
]);

async function ensureOpenCodeModelsForInstall(
  command: "install" | "sync",
  flags: Flags,
  runtimes: SelectableRuntimeId[],
): Promise<boolean> {
  if (!runtimes.includes("opencode") || loadModelMap().opencode) return true;

  const canPrompt = command === "install" && !flags.yes && !flags.dryRun && process.stdout.isTTY;
  if (canPrompt) {
    const code = await runModelsPicker({ yes: false, runtimes: ["opencode"] });
    if (code === 0 && loadModelMap().opencode) return true;
  }

  console.error(
    "OpenCode no tiene modelos configurados. Ejecuta 'jorgex-stack models --agents opencode' de forma interactiva antes de install/sync.",
  );
  return false;
}

export function parseFlags(args: string[], allowReceipt = false): Flags {
  const flags: Flags = {
    agents: [],
    dryRun: false,
    yes: false,
    mode: undefined,
    subagentConcurrency: undefined,
    help: false,
    version: false,
    list: false,
    check: false,
    removeEngram: false,
    engram: false,
    playwright: false,
    removePlaywright: false,
    devtools: false,
    noDevtools: false,
    receipt: undefined,
    positional: [],
    unknownFlags: [],
  };
  const readValue = (index: number): [string | undefined, number] => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) return [undefined, index];
    return [value, index + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (allowReceipt) {
      if (arg === "--help" || arg === "-h") flags.help = true;
      else if (arg === "--version" || arg === "-v") flags.version = true;
      else if (arg === "--receipt") {
        const [value, nextIndex] = readValue(i);
        if (value === undefined || value === "") flags.unknownFlags.push(arg);
        else flags.receipt = value;
        i = nextIndex;
      }
      else if (arg.startsWith("--receipt=")) {
        const value = arg.slice(10);
        if (value === "") flags.unknownFlags.push(arg);
        else flags.receipt = value;
      }
      else if (QUALITY_REJECTED_VALUE_FLAGS.has(arg)) {
        flags.unknownFlags.push(arg);
        const [, nextIndex] = readValue(i);
        i = nextIndex;
      }
      else if (arg.startsWith("-")) flags.unknownFlags.push(arg);
      else flags.positional.push(arg);
      continue;
    }

    if (arg === "--agents" || arg === "-a") {
      const [value, nextIndex] = readValue(i);
      flags.agents = (value ?? "").split(",").filter(Boolean) as SelectableRuntimeId[];
      i = nextIndex;
    }
    else if (arg.startsWith("--agents=")) flags.agents = arg.slice(9).split(",").filter(Boolean) as SelectableRuntimeId[];
    else if (arg === "--target-dir") {
      const [value, nextIndex] = readValue(i);
      flags.targetDir = value;
      i = nextIndex;
    }
    else if (arg.startsWith("--target-dir=")) flags.targetDir = arg.slice(13);
    else if (arg === "--mode") {
      const [value, nextIndex] = readValue(i);
      flags.mode = value ?? "";
      i = nextIndex;
    } else if (arg.startsWith("--mode=")) flags.mode = arg.slice(7);
    else if (arg === "--subagent-concurrency") {
      const [value, nextIndex] = readValue(i);
      flags.subagentConcurrency = value ?? "";
      i = nextIndex;
    } else if (arg.startsWith("--subagent-concurrency=")) flags.subagentConcurrency = arg.slice(23);
    else if (arg === "--playwright-runtimes") {
      const [value, nextIndex] = readValue(i);
      flags.playwrightRuntimes = (value ?? "").split(",").filter(Boolean) as SelectableRuntimeId[];
      i = nextIndex;
    } else if (arg.startsWith("--playwright-runtimes=")) {
      flags.playwrightRuntimes = arg.slice("--playwright-runtimes=".length).split(",").filter(Boolean) as SelectableRuntimeId[];
    }
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg === "--list") flags.list = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--remove-engram") flags.removeEngram = true;
    else if (arg === "--engram") flags.engram = true;
    else if (arg === "--playwright") flags.playwright = true;
    else if (arg === "--remove-playwright") flags.removePlaywright = true;
    else if (arg === "--devtools") flags.devtools = true;
    else if (arg === "--no-devtools") flags.noDevtools = true;
    else if (arg.startsWith("-")) flags.unknownFlags.push(arg);
    else flags.positional.push(arg);
  }
  return flags;
}

async function resolveInstallMode(flags: Flags, promptIfMissing = true): Promise<InstallModePreference | null> {
  const explicit = parseInstallModePreferenceFlags(flags.mode, flags.subagentConcurrency);
  if (explicit.error) {
    console.error(explicit.error);
    process.exitCode = 1;
    return null;
  }
  if (explicit.preference) return explicit.preference;

  if (flags.targetDir !== undefined) {
    p.log.info("--target-dir ignora la preferencia guardada y usa modo human por defecto; usa --mode programmatic si quieres otro modo.");
    return DEFAULT_INSTALL_MODE_PREFERENCE;
  }

  const preferenceFile = installModePreferenceFile();
  if (hasInstallModePreference(preferenceFile)) {
    try {
      return loadInstallModePreference(preferenceFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `${reason}\nCorrige o borra ${preferenceFile}, o vuelve a ejecutar con --mode human|programmatic.`,
      );
      process.exitCode = 1;
      return null;
    }
  }
  if (!promptIfMissing) {
    console.error("No hay modo guardado; usa --mode explícito para este sync.");
    process.exitCode = 1;
    return null;
  }
  if (flags.yes || !process.stdout.isTTY) return DEFAULT_INSTALL_MODE_PREFERENCE;

  const selected = await p.select({
    message: "¿Cómo quieres instalar el modo del stack?",
    options: [
      { value: "human", label: "Human (comportamiento actual)" },
      { value: "programmatic", label: "Programmatic (elige concurrencia)" },
    ],
    initialValue: DEFAULT_INSTALL_MODE_PREFERENCE.mode,
  });
  if (p.isCancel(selected)) return null;

  if (selected === "human") {
    return {
      mode: "human",
      subagentConcurrency: "serial",
    };
  }

  const concurrency = await p.select({
    message: "Concurrencia de subagentes en modo programmatic",
    options: [
      { value: "serial", label: "Serial (default)" },
      { value: "parallel", label: "Parallel" },
    ],
    initialValue: DEFAULT_INSTALL_MODE_PREFERENCE.subagentConcurrency,
  });
  if (p.isCancel(concurrency)) return null;

  return {
    mode: "programmatic",
    subagentConcurrency: concurrency as SubagentConcurrency,
  };
}

async function resolvePlaywrightToolConsent(
  command: "install" | "sync",
  flags: Flags,
  runtimes: SelectableRuntimeId[],
): Promise<{
  command: "install" | "sync";
  interactive: boolean;
  yes: boolean;
  targetDir: boolean;
  explicitToolSelection: boolean;
  confirmed: boolean;
  runtimeSelection?: PlaywrightRuntimeSelection;
} | null> {
  const interactive = Boolean(process.stdout.isTTY);
  const supported = runtimes.filter((runtime) => runtime !== "pi"
    || (PI_RUNTIME_CANDIDATE.contract.capabilities as readonly string[]).includes("playwright-handoff-v1"));
  if (flags.playwrightRuntimes !== undefined) {
    const requested = flags.playwrightRuntimes;
    let error: string | undefined;
    if (requested.length === 0) error = "--playwright-runtimes requiere al menos un runtime.";
    for (const runtime of requested) {
      if (!["opencode", "claude-code", "codex", "pi"].includes(runtime)) error = `Runtime Playwright desconocido: ${runtime}.`;
      else if (!runtimes.includes(runtime)) error = `El runtime ${runtime} no está en --agents/destinos de esta instalación.`;
      else if (!supported.includes(runtime)) error = "Pi requiere un candidato con playwright-handoff-v1 para activar Playwright.";
      if (error) break;
    }
    if (error) { console.error(error); process.exitCode = 1; return null; }
  }
  let confirmed = false;
  if (command === "install" && interactive && !flags.yes && !flags.dryRun && flags.targetDir === undefined) {
    const answer = await p.confirm({
      message: "Recomendado: ¿instalar Playwright CLI global y descargar sus navegadores?",
      initialValue: false,
    });
    if (p.isCancel(answer)) return null;
    confirmed = answer === true;
  }
  let runtimeSelection: PlaywrightRuntimeSelection | undefined;
  const approved = interactive && !flags.yes ? confirmed : flags.yes && flags.playwright;
  if (command === "install" && approved && supported.length > 0) {
    let selected = flags.playwrightRuntimes ?? supported;
    if (interactive && !flags.yes && !flags.dryRun && flags.targetDir === undefined && flags.playwrightRuntimes === undefined) {
      const answer = await p.multiselect({
        message: "¿En qué runtimes activar la guía de Playwright? (instalación global compartida)",
        required: false,
        options: supported.map((runtime) => ({ value: runtime, label: runtime === "pi" ? "Pi" : ADAPTERS[runtime]?.name ?? runtime })),
        initialValues: supported.filter((runtime) => loadPlaywrightCliPreference(undefined, runtime) === true),
      });
      if (p.isCancel(answer)) return null;
      selected = answer as SelectableRuntimeId[];
    }
    runtimeSelection = Object.fromEntries(supported.map((runtime) => [runtime, selected.includes(runtime)]));
  }
  if (command === "install" && approved && runtimes.includes("pi") && !supported.includes("pi")) {
    p.log.info("La activación de Playwright en Pi requiere la próxima adopción del paquete Pi; el binario global sí puede instalarse.");
  }
  return {
    command,
    interactive,
    yes: flags.yes,
    targetDir: flags.targetDir !== undefined,
    explicitToolSelection: flags.playwright,
    confirmed,
    ...(runtimeSelection === undefined ? {} : { runtimeSelection }),
  };
}

async function resolveDevtoolsMcpSelection(
  command: "install" | "sync",
  flags: Flags,
  runtimes: SelectableRuntimeId[],
): Promise<Partial<Record<SelectableRuntimeId, boolean>> | null> {
  if (flags.devtools && flags.noDevtools) {
    console.error("Usa solo uno de --devtools o --no-devtools.");
    process.exitCode = 1;
    return null;
  }

  if (flags.devtools || flags.noDevtools) {
    return Object.fromEntries(runtimes.map((runtime) => [runtime, flags.devtools]));
  }

  if (command !== "install" || flags.yes || flags.dryRun || flags.targetDir !== undefined || !process.stdout.isTTY) {
    return {};
  }

  const file = devtoolsMcpPreferenceFile();
  const selected = await p.multiselect({
    message: "Chrome DevTools MCP avanzado (opcional). ¿En qué runtimes activarlo?",
    required: false,
    options: runtimes.map((runtime) => ({ value: runtime, label: runtime === "pi" ? "Pi" : ADAPTERS[runtime]?.name ?? runtime })),
    initialValues: runtimes.filter((runtime) => loadDevtoolsMcpPreference(file, runtime)),
  });
  if (p.isCancel(selected)) return null;
  const enabled = new Set(selected as SelectableRuntimeId[]);
  return Object.fromEntries(runtimes.map((runtime) => [runtime, enabled.has(runtime)]));
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [first, ...rest] = argv;
  const isCommand = (COMMANDS as readonly string[]).includes(first ?? "install");

  if (first !== undefined && !isCommand && !first.startsWith("-")) {
    return {
      action: "unknown",
      command: "install",
      flags: parseFlags(rest),
      unknownCommand: first,
    };
  }

  const command: Command = isCommand ? ((first ?? "install") as Command) : "install";
  const flags = parseFlags(isCommand ? rest : argv, command === "quality");

  if (first === "--help" || first === "-h" || flags.help) return { action: "help", command, flags };
  if (first === "--version" || first === "-v" || flags.version) return { action: "version", command, flags };
  if (flags.unknownFlags.length > 0) return { action: "unknown-flags", command, flags };

  return { action: "run", command, flags };
}

/** Runtimes destino: --agents explícito, o multiselect interactivo de los detectados, o todos los detectados. */
function isFileManagedRuntime(runtime: SelectableRuntimeId): runtime is RuntimeId {
  return runtime !== "pi";
}

async function resolveRuntimes(flags: Flags, includeAvailablePi = false): Promise<SelectableRuntimeId[] | null> {
  if (flags.agents.length > 0) return flags.agents;
  const detected: { id: SelectableRuntimeId; name: string }[] = Object.values(ADAPTERS)
    .filter((adapter) => adapter.detect().installed)
    .map((adapter) => ({ id: adapter.id, name: adapter.name }));
  const pi = detectPiRuntime();
  if (pi.installed && (includeAvailablePi || hasManagedPiRuntime(flags.targetDir))) {
    detected.push({ id: "pi", name: "Pi" });
  }
  if (detected.length === 0) return [];
  if (flags.yes || !process.stdout.isTTY || flags.targetDir !== undefined) return detected.map((runtime) => runtime.id);

  const choice = await p.multiselect({
    message: "¿En qué runtimes? (detectados en esta máquina)",
    options: detected.map((runtime) => ({ value: runtime.id, label: runtime.name })),
    initialValues: detected.map((runtime) => runtime.id),
  });
  if (p.isCancel(choice)) return null;
  return choice;
}

type HostEngramResolution =
  | { ok: true; bin: string | null }
  | { ok: false; message: string };

/** Resuelve Engram una sola vez antes de tocar cualquier runtime del install. */
async function resolveHostEngramForInstall(
  flags: Flags,
): Promise<HostEngramResolution> {
  if (flags.targetDir !== undefined) return { ok: true, bin: null };

  const existing = resolvePiEngramBin();
  if (flags.dryRun) return { ok: true, bin: existing };
  if (existing !== null) return { ok: true, bin: existing };

  let accepted = flags.engram;
  if (!accepted && !flags.yes && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const answer = await p.confirm({
      message: "Engram no está instalado. ¿Descargar e instalar ahora el binario oficial verificado?",
      initialValue: false,
    });
    if (!p.isCancel(answer)) accepted = answer === true;
  }
  if (!accepted) {
    return {
      ok: false,
      message: "Engram no está instalado. Usa --engram para autorizar su instalación o instálalo antes de reintentar.",
    };
  }

  try {
    const result = await installMissingEngram();
    if (result.ok) return { ok: true, bin: result.bin };
    return { ok: false, message: `Engram: ${result.reason}` };
  } catch (error) {
    return { ok: false, message: `Engram: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function runSelectedPi(
  operation: PiRuntimeOperation,
  targetDir?: string,
  yes = false,
  resolvedEngramBin?: string | null,
  devtoolsMcpEnabled?: boolean,
  writingStyle?: WritingStyleSnapshot,
  modePreference?: InstallModePreference,
  playwrightCliEnabled?: boolean,
): Promise<number> {
  if (targetDir === undefined && operation !== "models") {
    const preferenceErrors = browserPreferenceErrors();
    if (preferenceErrors.length > 0) {
      for (const error of preferenceErrors) console.error(error);
      return 1;
    }
  }
  if (operation === "install" || operation === "sync" || operation === "update") {
    writingStyle ??= readWritingStyle(resolveWritingStyleFile({ targetDir }), { rootDir: targetDir });
  }
  const detected = detectPiRuntime();
  if (!detected.installed || detected.executable === null) {
    console.error("Pi no detectado. Instala el runtime Pi antes de gestionar jorgex-pi.");
    return 1;
  }
  if (detected.version === null) {
    console.error("No se pudo verificar la versión instalada de Pi sin ejecutarlo; revisa la instalación de Pi.");
    return 1;
  }
  let engramBin = resolvedEngramBin === undefined
    ? resolvePiEngramBin(targetDir)
    : resolvedEngramBin;
  if (operation === "install" && engramBin === null) {
    const requirement = await resolvePiEngramRequirement({
      targetDir,
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      yes,
    }, {
      detectHost: () => resolvePiEngramBin(),
      detectTarget: (root) => resolvePiEngramBin(root),
      confirm: async ({ message, initialValue }) => {
        const answer = await p.confirm({ message, initialValue });
        return !p.isCancel(answer) && answer;
      },
      installNative: async ({ version }) => updateEngram("Gentleman-Programming/engram", version),
    });
    if (requirement.kind !== "existing") {
      console.error(requirement.kind === "offer"
        ? "Pi: instalación cancelada; Engram sigue siendo obligatorio."
        : `Pi: ${requirement.reason}. ${requirement.remedy}`);
      return 1;
    }
    engramBin = requirement.bin;
  }
  const result = await runManagedPiSystem({
    writingStyle,
    writingStyleMode: modePreference?.mode,
    operation,
    targetDir,
    detected: { executable: detected.executable, version: detected.version },
    engramBin,
    ...(devtoolsMcpEnabled === undefined ? {} : { devtoolsMcpEnabled }),
    ...(playwrightCliEnabled === undefined ? {} : { playwrightCliEnabled }),
  });
  if (result.kind === "blocked") {
    const paths = "paths" in result ? `: ${result.paths.join(", ")}` : "";
    console.error(`Pi: ${result.reason ?? "operación bloqueada"}${paths}${result.remedy ? `. ${result.remedy}` : ""}`);
    return 1;
  }
  if (result.kind === "models" && result.models !== undefined) console.log(JSON.stringify(result.models));
  else p.log.success(`Pi: ${result.kind}.`);
  return 0;
}

function persistSuccessfulGlobalMode(
  mode: InstallModePreference | undefined,
  targetDir: string | undefined,
  dryRun: boolean,
  exitCode: number,
): void {
  if (mode === undefined || targetDir !== undefined || dryRun || exitCode !== 0) return;
  saveInstallModePreference(installModePreferenceFile(), mode);
}

function printHelp(): void {
  console.log(`jorgex-stack v${VERSION}

Uso: pnpm dlx jorgex-stack [comando] [opciones]

Comandos:
  install     Instala el stack; OpenCode fresh exige elegir modelos conectados
  sync        Re-aplica la config y el model-map existente (idempotente; sin picker)
  models      Picker por tier o subagente (OpenCode: 'opencode models' en vivo)
  update      --check: compara stack/Engram/skills con sus upstreams
  doctor      Estado: Engram, drift de config, hooks de Codex, key de context7
  restore     --list para ver backups · 'restore <id>' para restaurar
  uninstall   Retira SOLO lo gestionado por el stack (con backup).
               Engram se CONSERVA por defecto (memorias, binario y registro);
               desregistrarlo exige --remove-engram o el sí explícito
  quality     Ejecuta un plan JSON explícito y emite un receipt local

Opciones:
  --agents, -a opencode,claude-code,codex,pi   Runtimes destino (default: detectados)
  --mode human|programmatic   Modo de instalación (default: preferencia guardada o human)
  --subagent-concurrency serial|parallel  Concurrencia de subagentes en modo programmatic
  --target-dir <dir>    Dir alternativo (pruebas de paridad; requiere 1 runtime)
  --dry-run             Muestra el plan sin escribir nada
  --yes, -y             No interactivo
  --playwright          Autoriza Playwright CLI global y sus navegadores (requerido con --yes/sin TTY)
  --engram              (install) autoriza instalar el binario Engram si falta
  --devtools            (install/sync) activa Chrome DevTools MCP para los runtimes destino (opt-in)
  --no-devtools         (install/sync) desactiva Chrome DevTools MCP (incompatible con --devtools)
  --remove-engram       (uninstall) desregistra Engram de los runtimes;
                        memorias y binario quedan intactos igualmente
  --playwright-runtimes <csv>  Activa su guía sólo en estos runtimes de --agents (con --playwright)
  --remove-playwright   (uninstall) retira solo el paquete global de Playwright;
                        nunca perfiles, caché ni navegadores
  --receipt <path>      (quality) escribe el receipt en ese path de forma atómica

Ver PRD.md para el diseño completo.`);
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.action === "help") return printHelp();
  if (parsed.action === "version") return console.log(VERSION);
  if (parsed.action === "unknown") {
    console.error(`Comando desconocido: ${parsed.unknownCommand}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (parsed.action === "unknown-flags") {
    const { unknownFlags } = parsed.flags;
    const plural = unknownFlags.length > 1;
    console.error(`Flag${plural ? "s" : ""} no reconocido${plural ? "s" : ""}: ${unknownFlags.join(", ")}`);
    console.error(
      `jorgex-stack v${VERSION} no reconoce ${plural ? "esos flags" : "ese flag"}. ` +
        `Si esperabas que existiera, puede que estés ejecutando un binario cacheado antiguo:\n` +
        `  pnpm dlx jorgex-stack@latest ...\n` +
        `Flags disponibles: jorgex-stack --help`,
    );
    process.exitCode = 1;
    return;
  }

  const { command, flags } = parsed;

  if (flags.engram && command !== "install") {
    console.error("--engram solo se admite durante install.");
    process.exitCode = 1;
    return;
  }

  if (flags.playwrightRuntimes !== undefined && (command !== "install" || !flags.playwright)) {
    console.error("--playwright-runtimes requiere install --playwright.");
    process.exitCode = 1;
    return;
  }

  if (command !== "quality" && flags.targetDir !== undefined && flags.agents.length !== 1) {
    console.error("--target-dir requiere exactamente un runtime en --agents.");
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "quality": {
      if (
        flags.targetDir !== undefined
        || flags.agents.length > 0
        || flags.dryRun
        || flags.yes
        || flags.mode !== undefined
        || flags.subagentConcurrency !== undefined
        || flags.list
        || flags.check
        || flags.removeEngram
        || flags.engram
        || flags.playwright
        || flags.removePlaywright
        || flags.devtools
        || flags.noDevtools
      ) {
        console.error("quality solo admite <plan.json> y, opcionalmente, --receipt <path>.");
        process.exitCode = 1;
        return;
      }
      if (flags.positional.length !== 1) {
        console.error("Uso: jorgex-stack quality <plan.json> [--receipt <path>]");
        process.exitCode = 1;
        return;
      }
      if (flags.receipt !== undefined && flags.receipt.trim() === "") {
        console.error("--receipt requiere un path no vacío.");
        process.exitCode = 1;
        return;
      }

      try {
        const plan = JSON.parse(fs.readFileSync(flags.positional[0]!, "utf8")) as unknown;
        const result = await runQualityPlan(plan);
        const serialized = serializeQualityReceipt(result.receipt);
        if (flags.receipt === undefined) process.stdout.write(`${serialized}\n`);
        else writeText(flags.receipt, `${serialized}\n`);
        process.exitCode = result.evaluation.status === "pass" ? 0 : 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      return;
    }
    case "install":
    case "sync": {
      const runtimes = await resolveRuntimes(flags, command === "install");
      if (runtimes === null) return;
      if (runtimes.length === 0) {
        console.error("Ningún runtime detectado (opencode, claude-code, codex, pi).");
        process.exitCode = 1;
        return;
      }
      const fileRuntimes = runtimes.filter(isFileManagedRuntime);
      let exitCode = 0;
      let completed = false;
      p.intro(`jorgex-stack ${command}${flags.dryRun ? " (dry-run)" : ""}`);
      try {
        const writingStyle = readWritingStyle(resolveWritingStyleFile({ targetDir: flags.targetDir }), { rootDir: flags.targetDir });
        if (flags.targetDir === undefined) {
          const errors = browserPreferenceErrors();
          if (errors.length > 0) {
            for (const error of errors) p.log.error(error);
            exitCode = 1;
            return;
          }
        }
        const mode = fileRuntimes.length > 0 || flags.mode !== undefined || flags.subagentConcurrency !== undefined
          ? await resolveInstallMode(flags) : undefined;
        if (mode === null) return;
        const devtoolsMcpSelection = await resolveDevtoolsMcpSelection(command, flags, runtimes);
        if (devtoolsMcpSelection === null) { exitCode = process.exitCode === 1 ? 1 : 0; return; }
        const playwrightToolConsent = await resolvePlaywrightToolConsent(command, flags, runtimes);
        if (playwrightToolConsent === null) { exitCode = process.exitCode === 1 ? 1 : 0; return; }
        if (!await ensureOpenCodeModelsForInstall(command, flags, fileRuntimes)) { exitCode = 1; return; }

        let engramBin: string | null | undefined;
        if (command === "install") {
          const engram = await resolveHostEngramForInstall(flags);
          if (!engram.ok) { p.log.error(engram.message); exitCode = 1; return; }
          engramBin = engram.bin;
        }
        if (fileRuntimes.length > 0) {
          exitCode = await runInstall({
            runtimes: fileRuntimes,
            writingStyle,
            targetDir: flags.targetDir,
            dryRun: flags.dryRun,
            yes: flags.yes,
            mode,
            playwrightToolConsent,
            devtoolsMcpSelection,
            engramBin,
            showSummary: false,
          });
        }
        let piCanRun = true;
        if (command === "install" && fileRuntimes.length === 0 && runtimes.includes("pi")
          && resolvePlaywrightToolPlan(playwrightToolConsent).actions.length > 0) {
          if (flags.dryRun) {
            p.log.info("Playwright CLI: instalación global y navegador previstos (dry-run; no se ejecutan).");
          } else {
            exitCode = await runInstall({
              writingStyle,
              runtimes: [], targetDir: flags.targetDir, dryRun: false, yes: flags.yes,
              playwrightToolConsent, engramBin, showSummary: false,
            });
            piCanRun = exitCode === 0;
          }
        }
        if (runtimes.includes("pi") && piCanRun) {
          if (flags.dryRun) p.log.info(`Pi: ${command} previsto; dry-run no ejecuta subprocess ni escribe receipt.`);
          else {
            const piExitCode = await runSelectedPi(command, flags.targetDir, flags.yes,
              flags.targetDir === undefined ? engramBin : undefined, devtoolsMcpSelection.pi, writingStyle, mode,
              flags.targetDir === undefined && exitCode === 0 && resolvePlaywrightToolPlan(playwrightToolConsent).actions.length > 0
                ? playwrightToolConsent.runtimeSelection?.pi : undefined);
            exitCode = Math.max(exitCode, piExitCode);
          }
        }
        if (runtimes.includes("pi")) persistSuccessfulGlobalMode(mode, flags.targetDir, flags.dryRun, exitCode);
        completed = true;
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
      } finally {
        if (process.exitCode === 1) exitCode = 1;
        process.exitCode = exitCode;
        p.outro(exitCode !== 0
          ? `${command} completado con errores (revisa arriba).`
          : !completed ? `${command} cancelado.`
          : flags.dryRun ? "Dry-run: no se ha escrito nada." : "Hecho.");
      }
      return;
    }
    case "uninstall": {
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      if (runtimes.length === 0 && !flags.removePlaywright) {
        console.error("Ningún runtime detectado (opencode, claude-code, codex).");
        process.exitCode = 1;
        return;
      }
      const fileRuntimes = runtimes.filter(isFileManagedRuntime);
      let exitCode = fileRuntimes.length > 0 || flags.removePlaywright
        ? await runUninstall({
            runtimes: fileRuntimes,
            targetDir: flags.targetDir,
            dryRun: flags.dryRun,
            yes: flags.yes,
            removeEngram: flags.removeEngram,
            removePlaywright: flags.removePlaywright,
          })
        : 0;
      if (runtimes.includes("pi")) {
        if (flags.dryRun) p.log.info("Pi: uninstall previsto; dry-run conserva paquete y receipt.");
        else exitCode = Math.max(exitCode, await runSelectedPi("uninstall", flags.targetDir));
      }
      process.exitCode = exitCode;
      return;
    }
    case "doctor": {
      const mode = flags.mode !== undefined || flags.subagentConcurrency !== undefined
        ? await resolveInstallMode(flags) : undefined;
      if (mode === null) return;
      const piSelected = flags.agents.includes("pi")
        || (flags.agents.length === 0 && detectPiRuntime().installed && hasManagedPiRuntime(flags.targetDir));
      const doctorRuntimes: SelectableRuntimeId[] = flags.agents.length > 0
        ? flags.agents
        : flags.targetDir === undefined
          ? [
              ...Object.values(ADAPTERS).filter((adapter) => adapter.detect().installed).map((adapter) => adapter.id),
              ...(piSelected ? ["pi" as const] : []),
            ]
          : [...Object.keys(ADAPTERS) as RuntimeId[], ...(piSelected ? ["pi" as const] : [])];
      let exitCode = await runDoctor({ targetDir: flags.targetDir, runtimes: doctorRuntimes, mode });
      if (piSelected) exitCode = Math.max(exitCode, await runSelectedPi("doctor", flags.targetDir, false, undefined, undefined, undefined, mode));
      process.exitCode = exitCode;
      return;
    }
    case "update": {
      if (flags.check || flags.dryRun) {
        const piExplicit = flags.agents.includes("pi");
        const fileRuntimeExplicit = flags.agents.some(isFileManagedRuntime);
        let exitCode = flags.agents.length === 0 || fileRuntimeExplicit
          ? await runUpdateCheck(VERSION, flags.targetDir === undefined)
          : 0;
        if (piExplicit) exitCode = Math.max(exitCode, await runSelectedPi("doctor", flags.targetDir));
        process.exitCode = exitCode;
        return;
      }
      // Sin --check ni --dry-run: sync primero, luego flujo interactivo de update.
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      const fileRuntimes = runtimes.filter(isFileManagedRuntime);
      const preferenceFile = installModePreferenceFile();
      const explicitMode = flags.mode !== undefined || flags.subagentConcurrency !== undefined;
      const hasSavedMode = hasInstallModePreference(preferenceFile);
      const canResolveMode = flags.targetDir !== undefined || explicitMode || hasSavedMode;
      const mode = canResolveMode
        ? await resolveInstallMode(flags, false)
        : DEFAULT_INSTALL_MODE_PREFERENCE;
      if (mode === null) return;
      const writingStyle = readWritingStyle(
        resolveWritingStyleFile({ targetDir: flags.targetDir }),
        { rootDir: flags.targetDir },
      );
      if (fileRuntimes.length === 0 && runtimes.includes("pi")) {
        const piExitCode = await runSelectedPi("update", flags.targetDir, false, undefined, undefined, writingStyle, mode);
        process.exitCode = piExitCode;
        persistSuccessfulGlobalMode(mode, flags.targetDir, flags.dryRun, piExitCode);
        return;
      }
      const canSync = fileRuntimes.length === 0 || canResolveMode;
      if (fileRuntimes.length > 0 && canSync) {
        const code = await runInstall({
          runtimes: fileRuntimes,
          writingStyle,
          targetDir: flags.targetDir,
          dryRun: flags.dryRun,
          yes: true,
          mode,
        });
        if (code !== 0) {
          process.exitCode = code;
          return;
        }
      } else if (fileRuntimes.length > 0) {
        console.error("No hay modo guardado; se omite el sync previo y se continúa con update. Usa --mode explícito si quieres sincronizar.");
      }
      const result: InteractiveUpdateResult = await runInteractiveUpdate(
        VERSION,
        flags.yes,
        flags.dryRun,
        flags.targetDir === undefined,
      );
      process.exitCode = result.exitCode;
      if (result.exitCode === 0 && runtimes.includes("pi")) {
        process.exitCode = Math.max(process.exitCode, await runSelectedPi("update", flags.targetDir, false, undefined, undefined, writingStyle, mode));
      }
      // Solo skills/stack cambian los artefactos que el sync propaga.
      if (result.syncRequired && fileRuntimes.length > 0 && (result.exitCode !== 0 || !canSync)) {
        p.log.warn("Skills/stack actualizados, pero el sync con los runtimes sigue pendiente. Ejecuta jorgex-stack sync --mode human|programmatic.");
      } else if (result.exitCode === 0 && result.syncRequired && fileRuntimes.length > 0 && canSync && !flags.yes && process.stdout.isTTY) {
        const apply = await p.confirm({ message: "¿Re-aplicar a los runtimes ahora? (sync)" });
        if (!p.isCancel(apply) && apply) {
          process.exitCode = await runInstall({
            runtimes: fileRuntimes,
            writingStyle,
            targetDir: flags.targetDir,
            dryRun: false,
            yes: false,
            mode,
          });
        } else {
          console.log("Sin aplicar. Cuando quieras: jorgex-stack sync");
        }
      } else if (result.exitCode === 0 && result.syncRequired && fileRuntimes.length > 0 && canSync && (flags.yes || !process.stdout.isTTY)) {
        console.log("Skills/stack actualizados. Ejecuta jorgex-stack sync para aplicarlos a los runtimes.");
      }
      if (runtimes.includes("pi")) {
        persistSuccessfulGlobalMode(mode, flags.targetDir, flags.dryRun, process.exitCode ?? result.exitCode);
      }
      return;
    }
    case "models": {
      // Mismo primer paso que install: elegir runtimes (espacio) antes de
      // preguntar modelos — solo se piden los de los runtimes seleccionados.
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      if (runtimes.length === 0) {
        console.error("Ningún runtime detectado (opencode, claude-code, codex, pi).");
        process.exitCode = 1;
        return;
      }
      const fileRuntimes = runtimes.filter(isFileManagedRuntime);
      let code = fileRuntimes.length > 0
        ? await runModelsPicker({ yes: flags.yes, runtimes: fileRuntimes })
        : 0;
      if (runtimes.includes("pi")) code = Math.max(code, await runSelectedPi("models", flags.targetDir));
      process.exitCode = code;
      // Elegir modelos solo escribe el model-map local; aplicarlos a los
      // agentes instalados es trabajo de sync. Ofrecerlo aquí evita el paso
      // manual que nadie recuerda.
      if (code === 0 && fileRuntimes.length > 0 && !flags.yes && process.stdout.isTTY) {
        const apply = await p.confirm({ message: "¿Aplicar ahora los modelos a los agentes instalados? (sync)" });
        if (!p.isCancel(apply) && apply) {
          const preferenceFile = installModePreferenceFile();
          const explicitMode = flags.mode !== undefined || flags.subagentConcurrency !== undefined;
          const hasSavedMode = hasInstallModePreference(preferenceFile);
          const canResolveMode = flags.targetDir !== undefined || explicitMode || hasSavedMode;
          if (!canResolveMode) {
            p.log.warn("Model-map guardado: se omite el sync con los runtimes porque falta un modo. Ejecuta jorgex-stack sync --mode human|programmatic.");
            return;
          }
          const mode = await resolveInstallMode(flags, false);
          if (mode === null) return;
          process.exitCode = await runInstall({ runtimes: fileRuntimes, targetDir: flags.targetDir, dryRun: flags.dryRun, yes: false, mode });
        } else {
          console.log("Sin aplicar. Cuando quieras: jorgex-stack sync");
        }
      }
      return;
    }
    case "restore": {
      if (flags.list || flags.positional.length === 0) {
        const backups = listBackups();
        if (backups.length === 0) return console.log("No hay backups.");
        for (const b of backups) console.log(`${b.id}  (${b.files.length} archivos, ${b.createdAt})`);
        if (!flags.list) console.log("\nUsa: jorgex-stack restore <id>");
        return;
      }
      const restored = restoreBackup(flags.positional[0]!);
      console.log(`Restaurados ${restored} archivos.`);
      return;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
