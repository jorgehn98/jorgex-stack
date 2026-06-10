import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";
import { ensureDir, writeText, readTextIfExists } from "./fsx.js";

const KEEP_BACKUPS = 10;

export interface BackupInfo {
  id: string;
  label: string;
  createdAt: string;
  files: { original: string; stored: string }[];
}

function backupsRoot(): string {
  return path.join(dataDir(), "backups");
}

/**
 * Copia los archivos existentes que se van a tocar a un snapshot con manifest.
 * Devuelve null si ninguno de los targets existe todavía (nada que respaldar).
 */
export function createBackup(files: string[], label: string): BackupInfo | null {
  const existing = [...new Set(files)].filter((f) => fs.existsSync(f));
  if (existing.length === 0) return null;

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
  const dir = path.join(backupsRoot(), id);
  ensureDir(path.join(dir, "files"));

  const entries = existing.map((original, i) => {
    const stored = path.join(dir, "files", `${String(i).padStart(4, "0")}-${path.basename(original)}`);
    fs.copyFileSync(original, stored);
    return { original, stored };
  });

  const info: BackupInfo = { id, label, createdAt: new Date().toISOString(), files: entries };
  writeText(path.join(dir, "manifest.json"), JSON.stringify(info, null, 2) + "\n");
  pruneBackups();
  return info;
}

export function listBackups(): BackupInfo[] {
  const root = backupsRoot();
  if (!fs.existsSync(root)) return [];
  const infos: BackupInfo[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readTextIfExists(path.join(root, entry.name, "manifest.json"));
    if (manifest === null) continue;
    try {
      infos.push(JSON.parse(manifest) as BackupInfo);
    } catch {
      // manifest corrupto: se lista igualmente como inválido al restaurar
    }
  }
  return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Restaura un backup por id. Devuelve cuántos archivos se restauraron. */
export function restoreBackup(id: string): number {
  const info = listBackups().find((b) => b.id === id);
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

function pruneBackups(): void {
  const all = listBackups();
  for (const old of all.slice(KEEP_BACKUPS)) {
    fs.rmSync(path.join(backupsRoot(), old.id), { recursive: true, force: true });
  }
}
