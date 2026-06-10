import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, buildPlan, makeContext } from "./install.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "./lib/canonical.js";
import { createBackup } from "./lib/backup.js";
import { writeText } from "./lib/fsx.js";
import { stackRoot } from "./lib/paths.js";

export interface UninstallOptions {
  runtimes: RuntimeId[];
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
}

/** Borra hacia arriba los directorios que hayan quedado vacíos, sin salir de root. */
function pruneEmptyDirs(file: string, root: string): void {
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
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

    const unmerge = adapter.planUnmerge(mcp, hooks, ctx);
    const mergedTargets = new Set(unmerge.map((a) => a.target));
    const deleteTargets = buildPlan(adapter, ctx)
      .map((a) => a.target)
      .filter((t) => !mergedTargets.has(t) && fs.existsSync(t));

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(`${deleteTargets.length} archivos a borrar, ${unmerge.length} archivos compartidos a limpiar`);

    if (opts.dryRun) continue;

    const backup = createBackup(
      [...deleteTargets, ...unmerge.map((a) => a.target).filter((t) => fs.existsSync(t))],
      `uninstall-${id}`,
    );
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    for (const target of deleteTargets) {
      fs.rmSync(target, { force: true });
      pruneEmptyDirs(target, path.dirname(configDir));
    }
    for (const action of unmerge) {
      if (action.kind !== "write") continue;
      if (action.content.trim() === "") {
        fs.rmSync(action.target, { force: true });
      } else {
        writeText(action.target, action.content);
      }
    }
    p.log.success(`${adapter.name}: stack retirado (lo tuyo queda intacto).`);
  }

  p.outro(opts.dryRun ? "Dry-run: no se ha tocado nada." : "Hecho. Usa 'restore' si quieres volver atrás.");
  return 0;
}
