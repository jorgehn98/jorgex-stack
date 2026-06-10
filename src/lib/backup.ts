import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./paths.js";
import { ensureDir, writeText, readTextIfExists } from "./fsx.js";

const KEEP_BACKUPS = 10;

export interface BackupInfo {
  id: string;
  label: string;
  createdAt: string;
  files: { original: string; stored: string }[];
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
    const content = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    hash.update(`${file}:${content}\n`);
  }
  return hash.digest("hex");
}

/**
 * Copia los archivos existentes que se van a tocar a un snapshot con manifest.
 * Devuelve null si ninguno de los targets existe todavía (nada que respaldar).
 * Si el contenido es idéntico al backup más reciente, lo reutiliza en vez de
 * duplicarlo (así los slots de retención no se llenan de copias iguales).
 */
export function createBackup(files: string[], label: string, root = backupsRoot()): BackupInfo | null {
  const existing = [...new Set(files)].filter((f) => fs.existsSync(f));
  if (existing.length === 0) return null;

  const checksum = compositeChecksum(existing);
  const latest = listBackups(root)[0];
  if (latest?.checksum === checksum) return latest;

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
  const dir = path.join(root, id);
  ensureDir(path.join(dir, "files"));

  const entries = existing.map((original, i) => {
    const stored = path.join(dir, "files", `${String(i).padStart(4, "0")}-${path.basename(original)}`);
    fs.copyFileSync(original, stored);
    return { original, stored };
  });

  const info: BackupInfo = { id, label, createdAt: new Date().toISOString(), files: entries, checksum };
  writeText(path.join(dir, "manifest.json"), JSON.stringify(info, null, 2) + "\n");
  pruneBackups(root);
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
      // Manifest corrupto: se lista vacío para que sea visible y prune lo recicle.
      infos.push({ id: entry.name, label: "(manifest corrupto)", createdAt: "", files: [] });
    }
  }
  return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Restaura un backup por id. Devuelve cuántos archivos se restauraron. */
export function restoreBackup(id: string, root = backupsRoot()): number {
  const info = listBackups(root).find((b) => b.id === id);
  if (!info) throw new Error(`Backup no encontrado: ${id}`);
  let restored = 0;
  for (const { original, stored } of info.files) {
    if (!fs.existsSync(stored)) continue;
    ensureDir(path.dirname(original));
    fs.copyFileSync(stored, original);
    restored++;
  }
  return restored;
}

function pruneBackups(root: string): void {
  const all = listBackups(root);
  for (const old of all.slice(KEEP_BACKUPS)) {
    fs.rmSync(path.join(root, old.id), { recursive: true, force: true });
  }
}
