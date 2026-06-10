import fs from "node:fs";
import path from "node:path";

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

let tmpCounter = 0;

function tmpPath(target: string): string {
  return path.join(path.dirname(target), `.jorgex-${process.pid}-${tmpCounter++}.tmp`);
}

/** Mueve el temporal sobre el destino; limpia el temporal si el rename falla. */
function renameInto(tmp: string, target: string): void {
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Escritura atómica: temporal en el mismo dir + rename. Un corte a mitad de
 * escritura nunca deja una config del usuario corrupta o a medias.
 */
export function writeText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = tmpPath(file);
  fs.writeFileSync(tmp, content, "utf8");
  renameInto(tmp, file);
}

/** Copia atómica: misma garantía que writeText. */
export function copyFile(source: string, target: string): void {
  ensureDir(path.dirname(target));
  const tmp = tmpPath(target);
  fs.copyFileSync(source, tmp);
  renameInto(tmp, target);
}

/** Borra hacia arriba los directorios que hayan quedado vacíos, sin salir de root. */
export function pruneEmptyDirs(file: string, root: string): void {
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

export function sameFileContent(a: string, b: string): boolean {
  try {
    const bufA = fs.readFileSync(a);
    const bufB = fs.readFileSync(b);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}
