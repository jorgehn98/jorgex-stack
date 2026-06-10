import * as p from "@clack/prompts";

const VERSION = "0.1.0";

const COMMANDS = [
  "install",
  "sync",
  "models",
  "update",
  "doctor",
  "restore",
  "uninstall",
] as const;

type Command = (typeof COMMANDS)[number];

function printHelp(): void {
  console.log(`jorgex-stack v${VERSION}

Uso: pnpm dlx jorgex-stack [comando]

Comandos:
  install     Instala el stack en los runtimes elegidos (default, interactivo)
  sync        Re-aplica la config (idempotente)
  models      Re-escoge modelos por tier sin reinstalar
  update      Actualiza stack + terceros (Engram, skills upstream)
  doctor      Verifica el estado de la instalación
  restore     Restaura un backup
  uninstall   Retira el stack (solo lo gestionado)

Ver PRD.md para el diseño completo.`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === "--help" || arg === "-h") return printHelp();
  if (arg === "--version" || arg === "-v") return console.log(VERSION);

  const command: Command = (COMMANDS as readonly string[]).includes(arg ?? "")
    ? (arg as Command)
    : "install";

  if (arg && command === "install" && arg !== "install") {
    console.error(`Comando desconocido: ${arg}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  p.intro(`jorgex-stack v${VERSION}`);
  p.log.warn(`'${command}' aún no está implementado (fase F0 — scaffold). Roadmap: PRD.md §11.`);
  p.outro("Nada que hacer todavía.");
}

main();
