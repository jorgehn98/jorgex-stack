import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, runInstall } from "./install.js";
import { runUpdate, runUpdateCheck } from "./update.js";
import { runDoctor } from "./doctor.js";
import { runUninstall } from "./uninstall.js";
import { listBackups, restoreBackup } from "./lib/backup.js";
import { readPackageVersion } from "./lib/release.js";
import { runQualityPlan } from "./lib/quality-runner.js";
import { serializeQualityReceipt } from "./lib/quality-receipt.js";
import { writeText } from "./lib/fsx.js";

const COMMANDS = ["install", "update", "doctor", "uninstall", "models", "restore", "quality"] as const;
export type Command = typeof COMMANDS[number];
export interface Flags {
  agents: RuntimeId[]; targetDir?: string; dryRun: boolean; yes: boolean;
  help: boolean; version: boolean; check: boolean; list: boolean;
  engram: boolean; removeEngram: boolean; upgradePermissions: boolean;
  receipt?: string; positional: string[]; unknownFlags: string[];
}
export function parseFlags(args: string[], allowReceipt = false): Flags {
  const flags: Flags = { agents: [], dryRun: false, yes: false, help: false, version: false, check: false, list: false, engram: false, removeEngram: false, upgradePermissions: false, positional: [], unknownFlags: [] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const [key, inline] = argument.split(/=(.*)/s);
    if (key === "--help" || key === "-h") flags.help = true;
    else if (key === "--version" || key === "-v") flags.version = true;
    else if ((key === "--agents" || key === "-a" || key === "--target-dir") && !allowReceipt || key === "--receipt" && allowReceipt) {
      const value = inline ?? args[index + 1];
      if (inline === undefined && value && !value.startsWith("-")) index++;
      if (!value || value.startsWith("-")) { flags.unknownFlags.push(argument); continue; }
      if (key === "--target-dir") flags.targetDir = value;
      else if (key === "--receipt") flags.receipt = value;
      else flags.agents = value.split(",") as RuntimeId[];
    } else if (key === "--dry-run" && !allowReceipt) flags.dryRun = true;
    else if ((key === "--yes" || key === "-y") && !allowReceipt) flags.yes = true;
    else if (key === "--check" && !allowReceipt) flags.check = true;
    else if (key === "--list" && !allowReceipt) flags.list = true;
    else if (key === "--engram" && !allowReceipt) flags.engram = true;
    else if (key === "--remove-engram" && !allowReceipt) flags.removeEngram = true;
    else if (key === "--upgrade-permissions" && !allowReceipt) flags.upgradePermissions = true;
    else if (argument.startsWith("-")) flags.unknownFlags.push(argument);
    else flags.positional.push(argument);
  }
  return flags;
}
export interface ParsedCli { action: "run" | "help" | "version" | "unknown" | "unknown-flags"; command: Command; flags: Flags; unknownCommand?: string }
export function parseCliArgs(argv: string[]): ParsedCli {
  const first = argv[0];
  const known = (COMMANDS as readonly string[]).includes(first ?? "install");
  const command = known ? (first ?? "install") as Command : "install";
  const flags = parseFlags(known && first ? argv.slice(1) : argv, command === "quality");
  const action = flags.help ? "help" : flags.version ? "version" : first && !known && !first.startsWith("-") ? "unknown" : flags.unknownFlags.length ? "unknown-flags" : "run";
  return { action, command, flags, ...(action === "unknown" ? { unknownCommand: first } : {}) };
}
function printHelp(): void {
  console.log("jorgex-stack install|update|doctor|uninstall|models|restore|quality\n--agents claude-code,codex,opencode,pi --target-dir DIR --dry-run --yes\nInstall: --engram --upgrade-permissions. Update: --check. Uninstall: --remove-engram.\nMenú y selector nativo por agente pendientes de T07/T06; no se usa el picker por tiers retirado.");
}
async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const { flags, command } = parsed;
  if (parsed.action === "version") { console.log(readPackageVersion()); return; }
  if (parsed.action === "help" || process.argv.length === 2) { printHelp(); return; }
  if (parsed.action !== "run") throw new Error(`Entrada desconocida: ${parsed.unknownCommand ?? flags.unknownFlags.join(", ")}`);
  if (command === "quality") {
    if (flags.positional.length !== 1) throw new Error("quality requiere un archivo de plan JSON.");
    const result = await runQualityPlan(JSON.parse(fs.readFileSync(flags.positional[0]!, "utf8")));
    if (flags.receipt) writeText(flags.receipt, serializeQualityReceipt(result.receipt));
    else console.log(serializeQualityReceipt(result.receipt));
    process.exitCode = result.evaluation.status === "pass" ? 0 : 1; return;
  }
  if (command === "models") throw new Error("Selector por tiers retirado; selector nativo por agente pendiente de T06. Usa la elección nativa del runtime mientras tanto.");
  if (command === "restore") {
    if (flags.targetDir) throw new Error("restore no admite target-dir.");
    if (flags.list) { console.log(listBackups().map((backup) => `${backup.id} ${backup.label}`).join("\n")); return; }
    if (flags.positional.length !== 1) throw new Error("restore requiere un ID de backup.");
    console.log(`Restaurados ${restoreBackup(flags.positional[0]!)} archivos.`); return;
  }
  if (flags.agents.some((runtime) => !(runtime in ADAPTERS))) throw new Error("Runtime desconocido; solo Claude Code, Codex, OpenCode v2 y Pi.");
  if (flags.targetDir && flags.agents.length !== 1) throw new Error("--target-dir requiere exactamente un runtime.");
  if (flags.engram && command !== "install") throw new Error("--engram solo se admite en install.");
  const runtimes = flags.agents.length ? flags.agents : Object.keys(ADAPTERS) as RuntimeId[];
  const options = { ...flags, runtimes };
  if (command === "doctor") process.exitCode = await runDoctor(options);
  else if (command === "uninstall") process.exitCode = await runUninstall(options);
  else if (command === "update") process.exitCode = flags.check ? await runUpdateCheck() : await runUpdate(options);
  else process.exitCode = await runInstall(options);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Operación incompleta"); process.exitCode = 1; });
}
