import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, runInstall } from "./install.js";
import { listBackups, restoreBackup } from "./lib/backup.js";
import { ensureModelMapFile } from "./lib/model-map.js";

const VERSION = "0.4.0";

const COMMANDS = ["install", "sync", "models", "update", "doctor", "restore", "uninstall"] as const;
type Command = (typeof COMMANDS)[number];

interface Flags {
  agents: RuntimeId[];
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  list: boolean;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { agents: [], dryRun: false, yes: false, list: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--agents" || arg === "-a") flags.agents = (args[++i] ?? "").split(",").filter(Boolean) as RuntimeId[];
    else if (arg.startsWith("--agents=")) flags.agents = arg.slice(9).split(",").filter(Boolean) as RuntimeId[];
    else if (arg === "--target-dir") flags.targetDir = args[++i];
    else if (arg.startsWith("--target-dir=")) flags.targetDir = arg.slice(13);
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--list") flags.list = true;
    else flags.positional.push(arg);
  }
  return flags;
}

function printHelp(): void {
  console.log(`jorgex-stack v${VERSION}

Uso: pnpm dlx jorgex-stack [comando] [opciones]

Comandos:
  install     Instala el stack en los runtimes elegidos (default)
  sync        Re-aplica la config (idempotente; alias de install)
  models      Crea/abre el model-map por tiers (~/.jorgex-stack/model-map.json)
  restore     --list para ver backups · 'restore <id>' para restaurar
  update      Actualiza stack + terceros (F5)
  doctor      Verifica el estado de la instalación (F5)
  uninstall   Retira el stack (F5)

Opciones:
  --agents, -a opencode,claude-code,codex   Runtimes destino (default: detectados con adapter)
  --target-dir <dir>    Instala en un dir alternativo (pruebas de paridad)
  --dry-run             Muestra el plan sin escribir nada
  --yes, -y             No interactivo

Ver PRD.md para el diseño completo.`);
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);

  if (first === "--help" || first === "-h") return printHelp();
  if (first === "--version" || first === "-v") return console.log(VERSION);

  const isCommand = (COMMANDS as readonly string[]).includes(first ?? "install");
  if (first !== undefined && !isCommand && !first.startsWith("-")) {
    console.error(`Comando desconocido: ${first}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const command: Command = isCommand ? (first as Command) : "install";
  const flags = parseFlags(isCommand ? rest : process.argv.slice(2));

  switch (command) {
    case "install":
    case "sync": {
      const available = Object.keys(ADAPTERS) as RuntimeId[];
      const runtimes = flags.agents.length > 0 ? flags.agents : available;
      if (flags.targetDir !== undefined && runtimes.length !== 1) {
        console.error("--target-dir requiere exactamente un runtime en --agents.");
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runInstall({
        runtimes,
        targetDir: flags.targetDir,
        dryRun: flags.dryRun,
        yes: flags.yes,
      });
      return;
    }
    case "models": {
      const file = ensureModelMapFile();
      p.intro("jorgex-stack models");
      p.log.info(`Model-map por tiers: ${file}`);
      p.log.info("Edítalo y re-ejecuta 'sync'. Picker interactivo (lista en vivo de `opencode models`): F5.");
      p.outro("Hecho.");
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
    default: {
      p.intro(`jorgex-stack v${VERSION}`);
      p.log.warn(`'${command}' llega en F5 (ver PRD.md §11).`);
      p.outro("Nada que hacer todavía.");
    }
  }
}

main();
