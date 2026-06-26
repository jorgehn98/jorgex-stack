import * as p from "@clack/prompts";
import { pathToFileURL } from "node:url";
import type { InstallModePreference, RuntimeId, SubagentConcurrency } from "./adapters/types.js";
import { ADAPTERS, runInstall } from "./install.js";
import { runUninstall } from "./uninstall.js";
import { runDoctor } from "./doctor.js";
import { runUpdateCheck, runInteractiveUpdate, type InteractiveUpdateResult } from "./update.js";
import { runModelsPicker } from "./models-picker.js";
import { listBackups, restoreBackup } from "./lib/backup.js";
import { readPackageVersion } from "./lib/release.js";
import {
  DEFAULT_INSTALL_MODE_PREFERENCE,
  hasInstallModePreference,
  installModePreferenceFile,
  loadInstallModePreference,
  parseInstallModePreferenceFlags,
} from "./lib/install-mode.js";

const VERSION = readPackageVersion();

const COMMANDS = ["install", "sync", "models", "update", "doctor", "restore", "uninstall"] as const;
export type Command = (typeof COMMANDS)[number];

export interface Flags {
  agents: RuntimeId[];
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
  positional: string[];
}

export interface ParsedCli {
  action: "run" | "help" | "version" | "unknown";
  command: Command;
  flags: Flags;
  unknownCommand?: string;
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
    positional: [],
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
      flags.agents = (value ?? "").split(",").filter(Boolean) as RuntimeId[];
      i = nextIndex;
    }
    else if (arg.startsWith("--agents=")) flags.agents = arg.slice(9).split(",").filter(Boolean) as RuntimeId[];
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

  return { action: "run", command, flags };
}

/** Runtimes destino: --agents explícito, o multiselect interactivo de los detectados, o todos los detectados. */
async function resolveRuntimes(flags: Flags): Promise<RuntimeId[] | null> {
  if (flags.agents.length > 0) return flags.agents;
  const detected = Object.values(ADAPTERS).filter((a) => a.detect().installed);
  if (detected.length === 0) return [];
  if (flags.yes || !process.stdout.isTTY || flags.targetDir !== undefined) return detected.map((a) => a.id);

  const choice = await p.multiselect({
    message: "¿En qué runtimes? (detectados en esta máquina)",
    options: detected.map((a) => ({ value: a.id, label: a.name })),
    initialValues: detected.map((a) => a.id),
  });
  if (p.isCancel(choice)) return null;
  return choice;
}

function printHelp(): void {
  console.log(`jorgex-stack v${VERSION}

Uso: pnpm dlx jorgex-stack [comando] [opciones]

Comandos:
  install     Instala el stack en los runtimes elegidos (default, interactivo)
  sync        Re-aplica la config (idempotente; alias de install)
  models      Picker de modelos por tier (OpenCode: lista en vivo de 'opencode models')
  update      --check: compara stack/Engram/skills con sus upstreams
  doctor      Estado: Engram, drift de config, hooks de Codex, key de context7
  restore     --list para ver backups · 'restore <id>' para restaurar
  uninstall   Retira SOLO lo gestionado por el stack (con backup).
              Engram se CONSERVA por defecto (memorias, binario y registro);
              desregistrarlo exige --remove-engram o el sí explícito

Opciones:
  --agents, -a opencode,claude-code,codex   Runtimes destino (default: detectados)
  --mode human|programmatic   Modo de instalación (default: preferencia guardada o human)
  --subagent-concurrency serial|parallel  Concurrencia de subagentes en modo programmatic
  --target-dir <dir>    Dir alternativo (pruebas de paridad; requiere 1 runtime)
  --dry-run             Muestra el plan sin escribir nada
  --yes, -y             No interactivo
  --remove-engram       (uninstall) desregistra Engram de los runtimes;
                        memorias y binario quedan intactos igualmente

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

  const { command, flags } = parsed;

  if (flags.targetDir !== undefined && flags.agents.length !== 1) {
    console.error("--target-dir requiere exactamente un runtime en --agents.");
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "install":
    case "sync": {
      const mode = await resolveInstallMode(flags);
      if (mode === null) return;
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      if (runtimes.length === 0) {
        console.error("Ningún runtime detectado (opencode, claude-code, codex).");
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runInstall({ runtimes, targetDir: flags.targetDir, dryRun: flags.dryRun, yes: flags.yes, mode });
      return;
    }
    case "uninstall": {
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      if (runtimes.length === 0) {
        console.error("Ningún runtime detectado (opencode, claude-code, codex).");
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runUninstall({
        runtimes,
        targetDir: flags.targetDir,
        dryRun: flags.dryRun,
        yes: flags.yes,
        removeEngram: flags.removeEngram,
      });
      return;
    }
    case "doctor": {
      process.exitCode = await runDoctor();
      return;
    }
    case "update": {
      if (flags.check) {
        // --check: solo informar (comportamiento anterior, byte-compatible).
        process.exitCode = await runUpdateCheck(VERSION);
        return;
      }
      // --dry-run: cortocircuita al check sin sync previo ni flujo interactivo.
      if (flags.dryRun) {
        process.exitCode = await runUpdateCheck(VERSION);
        return;
      }
      // Sin --check ni --dry-run: sync primero, luego flujo interactivo de update.
      const runtimes = await resolveRuntimes(flags);
      if (runtimes === null) return;
      const preferenceFile = installModePreferenceFile();
      const explicitMode = flags.mode !== undefined || flags.subagentConcurrency !== undefined;
      const hasSavedMode = hasInstallModePreference(preferenceFile);
      const canResolveMode = flags.targetDir !== undefined || explicitMode || hasSavedMode;
      const mode = runtimes.length > 0 && canResolveMode
        ? await resolveInstallMode(flags, false)
        : DEFAULT_INSTALL_MODE_PREFERENCE;
      if (mode === null) return;
      const canSync = runtimes.length === 0 || canResolveMode;
      if (runtimes.length > 0 && canSync) {
        const code = await runInstall({
          runtimes,
          targetDir: flags.targetDir,
          dryRun: flags.dryRun,
          yes: true,
          mode,
        });
        if (code !== 0) {
          process.exitCode = code;
          return;
        }
      } else if (runtimes.length > 0) {
        console.error("No hay modo guardado; se omite el sync previo y se continúa con update. Usa --mode explícito si quieres sincronizar.");
      }
      const result: InteractiveUpdateResult = await runInteractiveUpdate(VERSION, flags.yes, flags.dryRun);
      process.exitCode = result.exitCode;
      // Ofrecer sync si se aplicaron skills o stack y hay runtimes disponibles.
      if (result.exitCode === 0 && result.appliedUpdates && runtimes.length > 0 && !canSync) {
        p.log.warn("Skills/stack actualizados, pero el sync con los runtimes sigue pendiente. Ejecuta jorgex-stack sync --mode human|programmatic.");
      } else if (result.exitCode === 0 && result.appliedUpdates && runtimes.length > 0 && canSync && !flags.yes && process.stdout.isTTY) {
        const apply = await p.confirm({ message: "¿Re-aplicar a los runtimes ahora? (sync)" });
        if (!p.isCancel(apply) && apply) {
          process.exitCode = await runInstall({
            runtimes,
            targetDir: flags.targetDir,
            dryRun: false,
            yes: false,
            mode,
          });
        } else {
          console.log("Sin aplicar. Cuando quieras: jorgex-stack sync");
        }
      } else if (result.exitCode === 0 && result.appliedUpdates && runtimes.length > 0 && canSync && (flags.yes || !process.stdout.isTTY)) {
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
        console.error("Ningún runtime detectado (opencode, claude-code, codex).");
        process.exitCode = 1;
        return;
      }
      const code = await runModelsPicker({ yes: flags.yes, runtimes });
      process.exitCode = code;
      // Elegir modelos solo escribe el model-map local; aplicarlos a los
      // agentes instalados es trabajo de sync. Ofrecerlo aquí evita el paso
      // manual que nadie recuerda.
      if (code === 0 && !flags.yes && process.stdout.isTTY) {
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
          process.exitCode = await runInstall({ runtimes, targetDir: flags.targetDir, dryRun: flags.dryRun, yes: false, mode });
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
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
