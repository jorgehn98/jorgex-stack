import { pathToFileURL } from "node:url";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, runInstall, type RuntimeSyncStatus } from "./install.js";
import { runUpdate } from "./update.js";
import { residueDirs, runDoctor } from "./doctor.js";
import { cleanResidues, pruneBackups } from "./cleanup.js";
import { runUninstall } from "./uninstall.js";
import { editAgent } from "./models-picker.js";
import { loadCanonicalAgents } from "./lib/canonical.js";
import { stackRoot } from "./lib/paths.js";
import { readManifest } from "./lib/manifest.js";
import { detectEngram } from "./lib/detect.js";
import type { OperationScope } from "./lib/operation-scope.js";

type Action = "install" | "update" | "doctor" | "uninstall";
type CleanUnit = "residues" | "backups";
type Option = { value: string; label: string };
export interface MenuOperations {
  detect(): RuntimeId[];
  agents(): string[];
  operate(action: Action, scope: OperationScope, runtimes: RuntimeId[]): Promise<number>;
  edit(runtime: RuntimeId, agent: string, route: string): Promise<void>;
  managed?(): RuntimeId[];
  clean(unit: CleanUnit, ui: MenuUI): Promise<number>;
}
export interface MenuUI {
  select(route: string, options: Option[]): Promise<string>;
  confirm(message: string): Promise<boolean>;
  info(message: string): void;
}
const BACK: Option = { value: "back", label: "Volver" };
const actions: Option[] = [
  { value: "install", label: "Instalar / configurar" }, { value: "update", label: "Actualizar" },
  { value: "doctor", label: "Doctor" }, { value: "uninstall", label: "Desinstalar" }, { value: "clean", label: "Limpiar" }, { value: "exit", label: "Salir" },
];
const cleanUnits: Option[] = [{ value: "residues", label: "Residuos de versiones anteriores" }, { value: "backups", label: "Backups antiguos" }, BACK];
const sections: Option[] = [
  { value: "all", label: "Todo" }, { value: "skills", label: "Skills compartidas" },
  { value: "config", label: "Configuración por runtime" }, { value: "agents", label: "Subagentes" }, BACK,
];

export async function runMenu(operations: MenuOperations, ui: MenuUI, tty: boolean): Promise<void> {
  if (!tty) { ui.info("JorgeX Stack requiere un terminal interactivo: ejecuta jorgex-stack en una terminal. Sin cambios ni espera de entrada."); return; }
  const detected = operations.detect();
  ui.info(`JorgeX Stack · Runtimes detectados: ${detected.map((id) => ADAPTERS[id].name).join(" · ") || "ninguno"}. Los ausentes no se instalan automáticamente.`);
  async function unit(action: Action, scope: OperationScope, runtimes: RuntimeId[], route: string) {
    if ((action === "install" || action === "update") && (scope.section === "all" || scope.section === "config")) {
      ui.info("Permisos: una configuración nueva trabaja sin prompts y solo deniega rutas de secretos; una existente se conserva sin cambios. No es un sandbox, y en Codex los .env no quedan protegidos. Detalle: docs/references/permissions.md.");
    }
    while (true) {
      const choice = await ui.select(route, [
        { value: "apply", label: action === "doctor" ? "Comprobar (solo lectura)" : "Aplicar esta unidad" },
        ...(action === "install" && scope.agent ? [{ value: "edit", label: "Editar modelo / esfuerzo" }] : []), BACK,
      ]);
      if (choice === "back") return;
      if (choice === "edit") {
        try { await operations.edit(runtimes[0]!, scope.agent!, route); }
        catch { ui.info("Agente pendiente; no se deshace lo ya guardado. Reintenta explícitamente."); }
        continue;
      }
      if (scope.section === "all" || scope.section === "skills") ui.info("Skills compartidas: alcance global, visible también para otros runtimes; no son copias aisladas por runtime.");
      if (action === "uninstall" && !await ui.confirm(`Retirar ${route}${scope.section === "all" || scope.section === "skills" ? ": incluye skills compartidas usadas por otros runtimes" : ""}. Conserva runtimes, datos de Engram, credenciales, sesiones y herramientas compartidas. ¿Continuar?`)) continue;
      try {
        const result = await operations.operate(action, scope, runtimes);
        ui.info(result ? "Aplicación parcial: consulta las unidades aplicadas y pendientes arriba. Reintento solo al elegir Aplicar; sin rollback global." : "Unidad completada. Configuración: nueva sesión / reload del runtime cuando corresponda.");
      } catch { ui.info("Unidad pendiente; pueden existir cambios parciales. Reintenta explícitamente; sin rollback global."); }
    }
  }
  while (true) {
    const action = await ui.select("Inicio", actions) as Action | "clean" | "exit" | "back";
    if (action === "exit" || action === "back") return;
    if (action === "clean") {
      while (true) {
        const unit = await ui.select("Limpiar", cleanUnits) as CleanUnit | "back";
        if (unit === "back") break;
        try { await operations.clean(unit, ui); }
        catch { ui.info("Limpieza incompleta; revisa ruta/permisos. Lo ya retirado no se deshace."); }
      }
      continue;
    }
    while (true) {
      const section = await ui.select(actions.find((option) => option.value === action)!.label, sections) as OperationScope["section"] | "back";
      if (section === "back") break;
      const route = `${actions.find((option) => option.value === action)!.label} › ${sections.find((option) => option.value === section)!.label}`;
      const runtimes = action === "uninstall" ? [...new Set([...detected, ...operations.managed?.() ?? []])] : detected;
      if (!runtimes.length) { ui.info("Sin destinos locales; instala el runtime por su canal oficial. Sin cambios."); continue; }
      if (section === "skills") { await unit(action, { section }, runtimes, route); continue; }
      while (true) {
        const runtime = await ui.select(route, [...runtimes.map((id) => ({ value: id, label: ADAPTERS[id].name })), ...(section === "all" ? [{ value: "all", label: "Todos los destinos" }] : []), BACK]);
        if (runtime === "back") break;
        const selected = runtime === "all" ? runtimes : [runtime as RuntimeId];
        const runtimeRoute = `${route} › ${runtime === "all" ? "Todos" : ADAPTERS[runtime as RuntimeId].name}`;
        if (section !== "agents") { await unit(action, { section }, selected, runtimeRoute); continue; }
        while (true) {
          const agent = await ui.select(runtimeRoute, [{ value: "all", label: "Todos los subagentes" }, ...operations.agents().map((name) => ({ value: name, label: name })), BACK]);
          if (agent === "back") break;
          await unit(action, { section, ...(agent === "all" ? {} : { agent }) }, selected, `${runtimeRoute} › ${agent}`);
        }
      }
    }
  }
}

const ui: MenuUI = {
  async select(route, options) {
    const answer = await p.select({ message: `JorgeX Stack · ${route}`, options });
    return p.isCancel(answer) ? route === "Inicio" ? "exit" : "back" : answer;
  },
  async confirm(message) { const answer = await p.confirm({ message, initialValue: false }); return !p.isCancel(answer) && answer; },
  info: (message) => p.log.info(message),
};
const operations: MenuOperations = {
  detect: () => (Object.keys(ADAPTERS) as RuntimeId[]).filter((id) => ADAPTERS[id].detect().installed),
  managed: () => Object.keys(readManifest().runtimes) as RuntimeId[],
  agents: () => loadCanonicalAgents(path.join(stackRoot(), "agents")).map((agent) => agent.name),
  edit: editAgent,
  clean(unit, cleanupUi) {
    const dirs = residueDirs();
    return unit === "residues" ? cleanResidues(dirs, cleanupUi) : pruneBackups(path.join(dirs.stateDir, "backups"), cleanupUi);
  },
  async operate(action, scope, runtimes) {
    const opts = { scope, runtimes, dryRun: false, yes: false };
    if (action === "doctor") return runDoctor(opts);
    if (action === "uninstall") return runUninstall({ ...opts, removeEngram: false });
    let engram = false;
    if ((scope.section === "all" || scope.section === "config") && !detectEngram()) {
      engram = await ui.confirm("Engram ausente: ¿instalar el último release oficial? El runtime y los datos personales se conservan.");
      if (!engram) { ui.info("Configuración pendiente: Engram es prerrequisito. No se ha aplicado esta unidad."); return 1; }
    }
    const statuses: Array<{ runtime: RuntimeId; status: RuntimeSyncStatus }> = [];
    const onRuntimeStatus = (runtime: string, status: RuntimeSyncStatus) => { statuses.push({ runtime: runtime as RuntimeId, status }); };
    const result = action === "update" ? await runUpdate({ ...opts, engram, onRuntimeStatus }) : await runInstall({ ...opts, engram, onRuntimeStatus });
    for (const { runtime, status } of statuses) ui.info(`${ADAPTERS[runtime].name}: ${status === "ok" ? "unidad aplicada" : "unidad pendiente / parcial"}.`);
    return result;
  },
};

async function main() {
  if (process.argv.length > 2) { console.error("Solo entrada interactiva: jorgex-stack, sin subcomandos ni flags."); process.exitCode = 1; return; }
  await runMenu(operations, ui, !!process.stdin.isTTY && !!process.stdout.isTTY);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { console.error("Operación incompleta; revisa configuración/permisos. Sin rollback global."); process.exitCode = 1; });
}
