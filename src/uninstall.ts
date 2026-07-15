import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, buildPlan, makeContext } from "./install.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "./lib/canonical.js";
import { createBackup } from "./lib/backup.js";
import { isContainedIn, pruneEmptyDirs, writeText } from "./lib/fsx.js";
import { readManifest, removeRuntimeManifest } from "./lib/manifest.js";
import { HOME, stackRoot } from "./lib/paths.js";
import { executePlaywrightToolAction, type PlaywrightToolAction } from "./install.js";
import { playwrightCliPreferenceFile, savePlaywrightCliPreference } from "./lib/tool-preferences.js";

export interface UninstallOptions {
  runtimes: RuntimeId[];
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  /** D7: desregistrar Engram exige el sí explícito (flag o confirmación). */
  removeEngram: boolean;
  /** Retira solo el paquete global de Playwright; nunca sus datos/navegadores. */
  removePlaywright: boolean;
}

export function resolvePlaywrightUninstallPlan(input: { removePackage: boolean }): {
  actions: PlaywrightToolAction[];
  preserveBrowserData: boolean;
} {
  return {
    actions: input.removePackage ? ["remove"] : [],
    preserveBrowserData: true,
  };
}

/**
 * Retira SOLO lo gestionado por el stack (criterio de aceptación 6 del PRD):
 * borra los archivos enteramente nuestros y reescribe los compartidos sin
 * nuestras secciones/claves. Backup automático antes de tocar nada.
 */
export async function runUninstall(opts: UninstallOptions): Promise<number> {
  p.intro(`jorgex-stack ${opts.dryRun ? "uninstall (dry-run)" : "uninstall"}`);
  const stackDir = stackRoot();
  const mcp = loadCanonicalMcp(stackDir);
  const hooks = loadCanonicalHooks(stackDir);
  let exitCode = 0;

  // D7: Engram guarda las memorias del usuario. Por defecto se CONSERVA todo
  // (registro MCP, plugin engram.ts); desregistrarlo exige el sí explícito.
  // Las memorias (~/.engram) y el binario no se tocan en ningún caso.
  let removeEngram = opts.removeEngram;
  if (!removeEngram && !opts.yes && !opts.dryRun && process.stdout.isTTY) {
    const answer = await p.confirm({
      message:
        "¿Quitar también el registro de Engram (MCP/plugin) de los runtimes? Tus memorias (~/.engram) y el binario NO se tocan en ningún caso.",
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelado — no se ha tocado nada.");
      return 1;
    }
    removeEngram = answer === true;
  }
  const mcpForUnmerge = removeEngram
    ? mcp
    : { servers: Object.fromEntries(Object.entries(mcp.servers).filter(([name]) => name !== "engram")) };
  if (!removeEngram) {
    p.log.info("Engram se conserva: memorias, binario y registro intactos (usa --remove-engram para desregistrarlo).");
  }

  // Archivos compartidos entre runtimes (p.ej. ~/.agents/skills sirve a Codex
  // Y OpenCode): si un runtime que NO se desinstala sigue instalado, sus
  // targets se conservan — desinstalar Codex no debe llevarse las skills que
  // OpenCode usa.
  const retained = new Set<string>();
  for (const keep of Object.values(ADAPTERS)) {
    if (opts.runtimes.includes(keep.id)) continue;
    const detection = keep.detect();
    if (!detection.installed) continue;
    const keepCtx = makeContext(keep, detection.configDir);
    if (!keepCtx) continue;
    for (const action of buildPlan(keep, keepCtx)) retained.add(path.resolve(action.target));
  }

  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) {
      p.log.warn(`${id}: sin adapter — omitido.`);
      continue;
    }
    const detection = adapter.detect();
    const configDir = opts.targetDir ?? detection.configDir;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado — omitido.`);
      continue;
    }
    const ctx = makeContext(adapter, configDir);
    if (!ctx) continue;
    ctx.preserveEngram = !removeEngram;

    const unmerge = adapter.planUnmerge(mcpForUnmerge, hooks, ctx);
    const mergedTargets = new Set(unmerge.map((a) => path.resolve(a.target)));
    // Lo instalado = plan actual ∪ manifest (cubre archivos que versiones
    // anteriores instalaron y el plan actual ya no genera).
    const usingRealConfig = opts.targetDir === undefined;
    const prevOwned = usingRealConfig ? (readManifest().runtimes[id]?.owned ?? []) : [];
    // En instalación real los targets pueden vivir fuera del configDir
    // (~/.agents/skills): borrado y poda se anclan a HOME. Nada fuera de esa
    // frontera se borra, aunque el manifest (estado local editable) lo liste.
    const pruneRoot = usingRealConfig ? HOME : path.dirname(configDir);
    const planTargets = [
      ...new Set([...buildPlan(adapter, ctx).map((a) => path.resolve(a.target)), ...prevOwned.map((t) => path.resolve(t))]),
    ].filter((t) => !mergedTargets.has(t) && fs.existsSync(t));
    const deleteTargets = planTargets.filter(
      (t) => !retained.has(t) && !(ctx.preserveEngram && path.basename(t) === "engram.ts") && isContainedIn(t, pruneRoot),
    );
    const sharedKept = planTargets.length - deleteTargets.length;

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(`${deleteTargets.length} archivos a borrar, ${unmerge.length} archivos compartidos a limpiar`);
    if (sharedKept > 0) p.log.info(`${sharedKept} archivos se conservan: otros runtimes instalados los siguen usando.`);

    if (opts.dryRun) continue;

    const backup = createBackup(
      [...deleteTargets, ...unmerge.map((a) => a.target).filter((t) => fs.existsSync(t))],
      `uninstall-${id}`,
    );
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    for (const target of deleteTargets) {
      fs.rmSync(target, { force: true });
      pruneEmptyDirs(target, pruneRoot);
    }
    for (const action of unmerge) {
      if (action.kind !== "write") continue;
      if (action.content.trim() === "") {
        fs.rmSync(action.target, { force: true });
      } else {
        writeText(action.target, action.content);
      }
    }
    if (usingRealConfig) removeRuntimeManifest(id);
    p.log.success(`${adapter.name}: stack retirado (lo tuyo queda intacto).`);
  }

  // --target-dir es una simulación/paridad de config: no debe afectar paquetes
  // globales ni la preferencia real del usuario.
  const playwrightPlan = resolvePlaywrightUninstallPlan({
    removePackage: opts.targetDir === undefined && opts.removePlaywright,
  });
  if (opts.removePlaywright && opts.targetDir !== undefined) {
    p.log.info("Playwright CLI: --target-dir conserva el paquete global y los datos del navegador.");
  } else if (playwrightPlan.actions.length > 0) {
    if (opts.dryRun) {
      p.log.info("Playwright CLI: se retiraría solo el paquete global; los datos y navegadores se conservan.");
    } else if (executePlaywrightToolAction("remove")) {
      savePlaywrightCliPreference(playwrightCliPreferenceFile(), false);
      p.log.success("Playwright CLI: paquete global retirado; los datos y navegadores se conservan.");
    } else {
      p.log.error("Playwright CLI: no se pudo retirar el paquete global; los datos y la preferencia se conservan.");
      exitCode = 1;
    }
  } else {
    p.log.info("Playwright CLI: paquete global y datos del navegador conservados (usa --remove-playwright para retirar solo el paquete).");
  }

  p.outro(opts.dryRun ? "Dry-run: no se ha tocado nada." : "Hecho. Usa 'restore' si quieres volver atrás.");
  return exitCode;
}
