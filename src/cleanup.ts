import fs from "node:fs";
import path from "node:path";
import { createBackup, listBackups } from "./lib/backup.js";
import { isContainedIn } from "./lib/fsx.js";
import { findResidues, formatBytes, treeBytes, type ResidueDirs } from "./lib/residues.js";

export interface CleanupUI { confirm(message: string): Promise<boolean>; info(message: string): void }
export const BACKUPS_KEPT_PER_LABEL = 3;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const sum = (sizes: (number | null)[]) => sizes.reduce<number | null>((total, size) => total === null || size === null ? null : total + size, 0);

/** Whether target sits under root once links in its parent chain are resolved. The entry itself is never resolved. */
function within(target: string, root: string): boolean {
  try { return isContainedIn(path.join(fs.realpathSync(path.dirname(target)), path.basename(target)), fs.realpathSync(root)); }
  catch { return false; }
}

/** Removes every path it can and reports the ones it could not; returns how many were removed. */
function removeAll(targets: string[], ui: CleanupUI): number {
  let removed = 0;
  for (const target of targets) {
    try { fs.rmSync(target, { recursive: true }); removed++; }
    catch { ui.info(`No se pudo retirar ${target}; revisa ruta/permisos.`); }
  }
  return removed;
}

/**
 * Removes "private" residues after confirmation: files are backed up first (label
 * `cleanup`), directories are not. Links are never followed or removed, and
 * "user-config" residues are only shown. Returns how many were removed.
 */
export async function cleanResidues(dirs: ResidueDirs, ui: CleanupUI, backupsRoot = path.join(dirs.stateDir, "backups")): Promise<number> {
  const roots = [dirs.stateDir, dirs.configDirs.pi].filter((root): root is string => !!root);
  const files: string[] = [];
  const directories: string[] = [];
  const sizes: (number | null)[] = [];
  const skipped: string[] = [];
  for (const residue of findResidues(dirs)) {
    const stat = fs.lstatSync(residue.path, { throwIfNoEntry: false });
    if (residue.kind !== "private") skipped.push(`  ${residue.path} (${formatBytes(residue.bytes)}). ${residue.remedy}`);
    else if (stat?.isSymbolicLink()) skipped.push(`  ${residue.path}: es un enlace simbólico; no se sigue ni se retira. Revísalo a mano.`);
    else if (!stat || (!stat.isFile() && !stat.isDirectory()) || !roots.some((root) => within(residue.path, root))) skipped.push(`  ${residue.path}: fuera de los directorios propios de Stack o de tipo inesperado; se omite.`);
    else { (stat.isDirectory() ? directories : files).push(residue.path); sizes.push(residue.bytes); }
  }
  if (skipped.length) ui.info(["Residuos que esta acción no retira:", ...skipped].join("\n"));
  const targets = [...files, ...directories];
  if (!targets.length) { ui.info("Sin residuos privados que retirar. Sin cambios."); return 0; }
  ui.info(["Residuos privados de versiones anteriores:", ...targets.map((target) => `  ${target}`)].join("\n"));
  if (!await ui.confirm(`Retirar ${plural(targets.length, "residuo", "residuos")} (${formatBytes(sum(sizes))} en total): ${plural(files.length, "archivo", "archivos")} con backup previo y ${plural(directories.length, "directorio", "directorios")} sin backup. Stack ya no los lee. ¿Continuar?`)) {
    ui.info("Sin cambios.");
    return 0;
  }
  // A failed backup throws before anything is deleted.
  createBackup(files, "cleanup", backupsRoot);
  const removed = removeAll(targets, ui);
  ui.info(`Residuos retirados: ${removed} de ${targets.length}.`);
  return removed;
}

/**
 * Deletes snapshots beyond the newest BACKUPS_KEPT_PER_LABEL of each label after
 * confirmation. Snapshots with a corrupt manifest are always kept. Returns how
 * many were deleted.
 */
export async function pruneBackups(root: string, ui: CleanupUI): Promise<number> {
  const all = listBackups(root);
  const seen = new Map<string, number>();
  const targets = all.filter((info) => {
    if (!info.createdAt) return false;
    const rank = seen.get(info.label) ?? 0;
    seen.set(info.label, rank + 1);
    // The manifest id is editable local state: it must name its own directory, a direct child of the root.
    return rank >= BACKUPS_KEPT_PER_LABEL && path.basename(info.id) === info.id && all.filter((other) => other.id === info.id).length === 1
      && isContainedIn(path.join(root, info.id), root) && !!fs.lstatSync(path.join(root, info.id), { throwIfNoEntry: false })?.isDirectory()
      && fs.existsSync(path.join(root, info.id, "manifest.json"));
  }).map((info) => path.join(root, info.id));
  if (!targets.length) { ui.info(`Backups: nada que podar; se conservan los ${BACKUPS_KEPT_PER_LABEL} más recientes de cada etiqueta y los de manifest corrupto.`); return 0; }
  if (!await ui.confirm(`Borrar ${plural(targets.length, "snapshot", "snapshots")} de backup (${formatBytes(sum(targets.map(treeBytes)))} en total) en ${root}. Se conservan los ${BACKUPS_KEPT_PER_LABEL} más recientes de cada etiqueta y los de manifest corrupto; lo borrado no se puede recuperar. ¿Continuar?`)) {
    ui.info("Sin cambios.");
    return 0;
  }
  const removed = removeAll(targets, ui);
  ui.info(`Snapshots borrados: ${removed} de ${targets.length}.`);
  return removed;
}
