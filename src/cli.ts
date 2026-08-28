import * as p from "@clack/prompts";
import { pathToFileURL } from "node:url";
import type { InstallModePreference, RuntimeId, SelectableRuntimeId, SubagentConcurrency } from "./adapters/types.js";
import { ADAPTERS, resolvePlaywrightToolPlan, runInstall } from "./install.js";
import { runUninstall } from "./uninstall.js";
import { runDoctor } from "./doctor.js";
import { runUpdateCheck, runInteractiveUpdate, updateEngram, type InteractiveUpdateResult } from "./update.js";
import { runModelsPicker } from "./models-picker.js";
import { listBackups, restoreBackup } from "./lib/backup.js";
import { readPackageVersion } from "./lib/release.js";
import { loadModelMap } from "./lib/model-map.js";
import {
  DEFAULT_INSTALL_MODE_PREFERENCE,
  hasInstallModePreference,
  installModePreferenceFile,
  loadInstallModePreference,
  parseInstallModePreferenceFlags,
} from "./lib/install-mode.js";
import { browserPreferenceErrors, devtoolsMcpPreferenceFile, loadDevtoolsMcpPreference } from "./lib/tool-preferences.js";
import {
  detectPiRuntime,
  hasManagedPiRuntime,
  resolvePiEngramBin,
  resolvePiEngramRequirement,
  type PiRuntimeOperation,
} from "./lib/pi-runtime.js";
import { runManagedPiSystem } from "./lib/pi-managed-runtime.js";

const VERSION = readPackageVersion();

const COMMANDS = ["install", "sync", "models", "update", "doctor", "restore", "uninstall"] as const;
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
  playwright: boolean;
  removePlaywright: boolean;
  devtools: boolean;
  noDevtools: boolean;
  positional: string[];
  unknownFlags: string[];
}

export interface ParsedCli {
  action: "run" | "help" | "version" | "unknown" | "unknown-flags";
  command: Command;
  flags: Flags;
  unknownCommand?: string;
}

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

export function parseFlags(args: string[]): Flags {
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
    playwright: false,
    removePlaywright: false,
    devtools: false,
    noDevtools: false,
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
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg === "--list") flags.list = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--remove-engram") flags.removeEngram = true;
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
): Promise<{
  command: "install" | "sync";
  interactive: boolean;
  yes: boolean;
  targetDir: boolean;
  explicitToolSelection: boolean;
  confirmed: boolean;
} | null> {
  const interactive = Boolean(process.stdout.isTTY);
  let confirmed = false;
  if (command === "install" && interactive && !flags.yes && !flags.dryRun && flags.targetDir === undefined) {
    const answer = await p.confirm({
      message: "Recomendado: ¿instalar Playwright CLI global y descargar sus navegadores?",
      initialValue: false,
    });
    if (p.isCancel(answer)) return null;
    confirmed = answer === true;
  }
  return {
    command,
    interactive,
    yes: flags.yes,
    targetDir: flags.targetDir !== undefined,
    explicitToolSelection: flags.playwright,
    confirmed,
  };
}

async function resolveDevtoolsMcpSelection(
  command: "install" | "sync",
  flags: Flags,
  runtimes: RuntimeId[],
): Promise<Partial<Record<RuntimeId, boolean>> | null> {
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
    message: "Chrome DevTools MCP avanzado (full: ~29 tools y ~5.8–7.7k tokens de schemas). ¿En qué runtimes activarlo?",
    options: runtimes.map((runtime) => ({ value: runtime, label: ADAPTERS[runtime]?.name ?? runtime })),
    initialValues: runtimes.filter((runtime) => loadDevtoolsMcpPreference(file, runtime)),
  });
  if (p.isCancel(selected)) return null;
  const enabled = new Set(selected as RuntimeId[]);
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
  const flags = parseFlags(isCommand ? rest : argv);

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

async function runSelectedPi(operation: PiRuntimeOperation, targetDir?: string, yes = false): Promise<number> {
  if (targetDir === undefined && operation !== "models") {
    const preferenceErrors = browserPreferenceErrors();
    if (preferenceErrors.length > 0) {
      for (const error of preferenceErrors) console.error(error);
      return 1;
    }
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
  let engramBin = resolvePiEngramBin(targetDir);
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
    operation,
    targetDir,
    detected: { executable: detected.executable, version: detected.version },
    engramBin,
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

Opciones:
  --agents, -a opencode,claude-code,codex,pi   Runtimes destino (default: detectados)
  --mode human|programmatic   Modo de instalación (default: preferencia guardada o human)
  --subagent-concurrency serial|parallel  Concurrencia de subagentes en modo programmatic
  --target-dir <dir>    Dir alternativo (pruebas de paridad; requiere 1 runtime)
  --dry-run             Muestra el plan sin escribir nada
  --yes, -y             No interactivo
  --playwright          Autoriza Playwright CLI global y sus navegadores (requerido con --yes/sin TTY)
  --devtools            (install/sync) activa Chrome DevTools MCP para los runtimes destino (opt-in)
  --no-devtools         (install/sync) desactiva Chrome DevTools MCP (incompatible con --devtools)
  --remove-engram       (uninstall) desregistra Engram de los runtimes;
                        memorias y binario quedan intactos igualmente
  --remove-playwright   (uninstall) retira solo el paquete global de Playwright;
                        nunca perfiles, caché ni navegadores

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

  if (flags.targetDir !== undefined && flags.agents.length !== 1) {
    console.error("--target-dir requiere exactamente un runtime en --agents.");
    process.exitCode = 1;
    return;
  }

  switch (command) {
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
      if (fileRuntimes.length > 0) {
        const mode = await resolveInstallMode(flags);
        if (mode === null) return;
        const devtoolsMcpSelection = await resolveDevtoolsMcpSelection(command, flags, fileRuntimes);
        if (devtoolsMcpSelection === null) return;
        const playwrightToolConsent = await resolvePlaywrightToolConsent(command, flags);
        if (playwrightToolConsent === null) return;
        const hasOpenCodeModels = await ensureOpenCodeModelsForInstall(command, flags, fileRuntimes);
        if (!hasOpenCodeModels) {
          process.exitCode = 1;
          return;
        }
        exitCode = await runInstall({
          runtimes: fileRuntimes,
          targetDir: flags.targetDir,
          dryRun: flags.dryRun,
          yes: flags.yes,
          mode,
          playwrightToolConsent,
          devtoolsMcpSelection,
        });
      }
      let piCanRun = true;
      if (command === "install" && fileRuntimes.length === 0 && runtimes.includes("pi")) {
        const playwrightToolConsent = await resolvePlaywrightToolConsent(command, flags);
        if (playwrightToolConsent === null) return;
        if (resolvePlaywrightToolPlan(playwrightToolConsent).actions.length > 0) {
          if (flags.dryRun) {
            p.log.info("Playwright CLI: instalación global y navegador previstos (dry-run; no se ejecutan).");
          } else {
            exitCode = await runInstall({
              runtimes: [],
              targetDir: flags.targetDir,
              dryRun: false,
              yes: flags.yes,
              playwrightToolConsent,
            });
            piCanRun = exitCode === 0;
          }
        }
      }
      if (runtimes.includes("pi") && piCanRun) {
        if (flags.dryRun) p.log.info(`Pi: ${command} previsto; dry-run no ejecuta subprocess ni escribe receipt.`);
        else exitCode = Math.max(exitCode, await runSelectedPi(command, flags.targetDir, flags.yes));
      }
      process.exitCode = exitCode;
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
      const fileDoctorSelected = flags.agents.length === 0 || flags.agents.some(isFileManagedRuntime);
      let exitCode = fileDoctorSelected ? await runDoctor() : 0;
      const piSelected = flags.agents.includes("pi")
        || (flags.agents.length === 0 && detectPiRuntime().installed && hasManagedPiRuntime(flags.targetDir));
      if (piSelected) exitCode = Math.max(exitCode, await runSelectedPi("doctor", flags.targetDir));
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
      if (fileRuntimes.length === 0 && runtimes.includes("pi")) {
        process.exitCode = await runSelectedPi("update", flags.targetDir);
        return;
      }
      const preferenceFile = installModePreferenceFile();
      const explicitMode = flags.mode !== undefined || flags.subagentConcurrency !== undefined;
      const hasSavedMode = hasInstallModePreference(preferenceFile);
      const canResolveMode = flags.targetDir !== undefined || explicitMode || hasSavedMode;
      const mode = fileRuntimes.length > 0 && canResolveMode
        ? await resolveInstallMode(flags, false)
        : DEFAULT_INSTALL_MODE_PREFERENCE;
      if (mode === null) return;
      const canSync = fileRuntimes.length === 0 || canResolveMode;
      if (fileRuntimes.length > 0 && canSync) {
        const code = await runInstall({
          runtimes: fileRuntimes,
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
        process.exitCode = Math.max(process.exitCode, await runSelectedPi("update", flags.targetDir));
      }
      // Solo skills/stack cambian los artefactos que el sync propaga.
      if (result.syncRequired && fileRuntimes.length > 0 && (result.exitCode !== 0 || !canSync)) {
        p.log.warn("Skills/stack actualizados, pero el sync con los runtimes sigue pendiente. Ejecuta jorgex-stack sync --mode human|programmatic.");
      } else if (result.exitCode === 0 && result.syncRequired && fileRuntimes.length > 0 && canSync && !flags.yes && process.stdout.isTTY) {
        const apply = await p.confirm({ message: "¿Re-aplicar a los runtimes ahora? (sync)" });
        if (!p.isCancel(apply) && apply) {
          process.exitCode = await runInstall({
            runtimes: fileRuntimes,
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
