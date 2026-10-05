import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, HOME } from "./paths.js";
import { ensureDir, isContainedIn, writeText, readTextIfExists } from "./fsx.js";

export interface BackupInfo {
  id: string;
  label: string;
  createdAt: string;
  files: { original: string; stored: string; symlinkTarget?: string }[];
  /** Checksum compuesto del contenido respaldado (dedup de snapshots idénticos). */
  checksum?: string;
}

function backupsRoot(): string {
  return path.join(dataDir(), "backups");
}

/** SHA-256 compuesto y determinista de (ruta + contenido) de cada archivo. */
function compositeChecksum(files: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort()) {
    const content = crypto.createHash("sha256").update(fs.lstatSync(file).isSymbolicLink() ? `symlink:${fs.readlinkSync(file)}` : fs.readFileSync(file)).digest("hex");
    hash.update(`${file}:${content}\n`);
  }
  return hash.digest("hex");
}

/**
 * Copia los archivos existentes que se van a tocar a un snapshot con manifest.
 * Devuelve null si ninguno de los targets existe todavía (nada que respaldar).
 * Si el contenido es idéntico al backup más reciente, lo reutiliza en vez de
 * duplicarlo. Los snapshots se conservan hasta su limpieza deliberada.
 */
export function createBackup(files: string[], label: string, root = backupsRoot()): BackupInfo | null {
  const existing = [...new Set(files)].filter((f) => fs.lstatSync(f, { throwIfNoEntry: false }) !== undefined);
  if (existing.length === 0) return null;

  const checksum = compositeChecksum(existing);
  const latest = listBackups(root)[0];
  if (latest?.checksum === checksum) return latest;

  // El id deriva del timestamp en ms; dos backups en el mismo milisegundo
  // colisionarían y el segundo machacaría el directorio del primero. Sufijo
  // incremental para garantizar unicidad sin depender de la resolución del reloj.
  const base = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
  let id = base;
  let dir = path.join(root, id);
  for (let n = 1; fs.existsSync(dir); n++) {
    id = `${base}-${n}`;
    dir = path.join(root, id);
  }
  ensureDir(path.join(dir, "files"));

  const entries = existing.map((original, i) => {
    const stored = path.join(dir, "files", `${String(i).padStart(4, "0")}-${path.basename(original)}`);
    if (fs.lstatSync(original).isSymbolicLink()) {
      const symlinkTarget = path.resolve(path.dirname(original), fs.readlinkSync(original));
      fs.writeFileSync(stored, symlinkTarget);
      return { original, stored, symlinkTarget };
    }
    fs.copyFileSync(original, stored);
    return { original, stored };
  });

  const info: BackupInfo = { id, label, createdAt: new Date().toISOString(), files: entries, checksum };
  writeText(path.join(dir, "manifest.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

export function listBackups(root = backupsRoot()): BackupInfo[] {
  if (!fs.existsSync(root)) return [];
  const infos: BackupInfo[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readTextIfExists(path.join(root, entry.name, "manifest.json"));
    if (manifest === null) continue;
    try {
      infos.push(JSON.parse(manifest) as BackupInfo);
    } catch {
      // Manifest corrupto: se lista vacío para que sea visible, sin eliminarlo.
      infos.push({ id: entry.name, label: "(manifest corrupto)", createdAt: "", files: [] });
    }
  }
  return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Restaura un backup por id. Devuelve cuántos archivos se restauraron.
 * Nunca escribe a través de symlinks: un `original` que sea symlink o tenga
 * un ancestro symlink (lstat, sin seguir) se omite. El conteo resultante
 * permite al setup oficial detectar una restauración incompleta.
 */
export function restoreBackup(id: string, root = backupsRoot(), boundary = HOME): number {
  const info = listBackups(root).find((b) => b.id === id);
  if (!info) throw new Error(`Backup no encontrado: ${id}`);
  const boundaryResolved = path.resolve(boundary);
  const hasSymlinkAncestor = (file: string): boolean => {
    let dir = path.dirname(path.resolve(file));
    while (dir !== boundaryResolved && isContainedIn(dir, boundaryResolved)) {
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) return true;
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
          ? (error as NodeJS.ErrnoException).code
          : "UNKNOWN";
        // Ilegible distinto de ausente: no se puede descartar alias.
        if (code !== "ENOENT") return true;
        // Intermedio ausente: seguir ascendiendo hacia un posible symlink
        // superior en lugar de dar por limpio el árbol.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  };
  let restored = 0;
  for (const { original, stored, symlinkTarget } of info.files) {
    if (!fs.existsSync(stored)) continue;
    // El manifest del backup es estado local editable: nunca puede dirigir
    // una escritura fuera de la frontera (HOME en uso real).
    if (!isContainedIn(original, boundary)) continue;
    try {
      if (fs.lstatSync(original).isSymbolicLink()) continue;
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : "UNKNOWN";
      // Ausente: recrear es seguro si los ancestros están limpios. Ilegible:
      // omitir (no se puede descartar alias).
      if (code !== "ENOENT") continue;
    }
    if (hasSymlinkAncestor(original)) continue;
    ensureDir(path.dirname(original));
    if (symlinkTarget !== undefined) {
      if (!isContainedIn(symlinkTarget, boundary) || fs.existsSync(original)) continue;
      fs.symlinkSync(symlinkTarget, original, process.platform === "win32" ? "junction" : "dir");
    } else fs.copyFileSync(stored, original);
    restored++;
  }
  return restored;
}
