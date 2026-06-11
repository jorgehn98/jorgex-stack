import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listFilesRecursive, copyFile, ensureDir, writeText } from "./fsx.js";
import { createBackup } from "./backup.js";
import { stackRoot } from "./paths.js";

// Skills propias (sin upstream) y de tipo release: nunca se reemplazan con esta función.
export const PROTECTED_SKILLS = new Set(["agent-delegation", "work-lifecycle"]);

export interface SkillDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Devuelve true si dos archivos son equivalentes ignorando diferencias de line endings
 * (CRLF vs LF). Compara primero byte a byte para evitar lecturas innecesarias; si
 * difieren, normaliza \r\n → \n en ambos y vuelve a comparar. Esto evita que en
 * Windows (core.autocrlf=true) los tarballs LF de GitHub aparezcan como modificados
 * respecto al working tree CRLF.
 * Nota: los archivos binarios también se cubren correctamente: si son byte-iguales →
 * same; si difieren, la normalización no altera bytes no-textuales y el resultado
 * seguirá siendo "distinto".
 */
function sameTextContentNormalized(a: string, b: string): boolean {
  const ba = fs.readFileSync(a);
  const bb = fs.readFileSync(b);
  if (ba.equals(bb)) return true;
  const sa = ba.toString("utf8").replace(/\r\n/g, "\n");
  const sb = bb.toString("utf8").replace(/\r\n/g, "\n");
  return sa === sb;
}

/**
 * Compara recursivamente upstreamDir vs localDir y devuelve las rutas relativas
 * agrupadas por estado. La comparación normaliza line endings (CRLF/LF) para
 * evitar falsos positivos en Windows donde el working tree puede estar en CRLF
 * y los tarballs descargados de GitHub llegan en LF.
 */
export function diffSkillDirs(upstreamDir: string, localDir: string): SkillDiff {
  const upstreamFiles = new Set(
    listFilesRecursive(upstreamDir).map((f) => path.relative(upstreamDir, f)),
  );
  const localFiles = new Set(
    listFilesRecursive(localDir).map((f) => path.relative(localDir, f)),
  );

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const rel of upstreamFiles) {
    if (!localFiles.has(rel)) {
      added.push(rel);
    } else if (!sameTextContentNormalized(path.join(upstreamDir, rel), path.join(localDir, rel))) {
      modified.push(rel);
    }
  }
  for (const rel of localFiles) {
    if (!upstreamFiles.has(rel)) {
      deleted.push(rel);
    }
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  };
}

/**
 * Devuelve el resumen legible del diff entre upstreamDir y localDir usando
 * `git diff --no-index --stat`. Si no hay diferencias, devuelve cadena vacía.
 * En caso de error (git no disponible o dirs inexistentes) devuelve un mensaje
 * con el conteo de archivos de diffSkillDirs como fallback.
 */
export function renderSkillDiff(upstreamDir: string, localDir: string): string {
  try {
    // git diff --no-index sale con código 1 cuando hay diferencias (comportamiento esperado)
    execFileSync("git", ["diff", "--no-index", "--stat", "--", localDir, upstreamDir], {
      stdio: "pipe",
      encoding: "utf8",
    });
    // código 0 → sin diferencias
    return "";
  } catch (err: unknown) {
    // execFileSync lanza cuando exit code != 0; el output está en err.stdout
    const e = err as { stdout?: string; status?: number };
    if (typeof e.stdout === "string" && e.status === 1) {
      // código 1 = hay diferencias (comportamiento normal de git diff)
      return e.stdout;
    }
    // Fallback: git no disponible o directorios inválidos
    const d = diffSkillDirs(upstreamDir, localDir);
    const total = d.added.length + d.modified.length + d.deleted.length;
    if (total === 0) return "";
    return (
      `[git no disponible — resumen de cambios]\n` +
      `  añadidos: ${d.added.length}, modificados: ${d.modified.length}, eliminados: ${d.deleted.length}`
    );
  }
}

/**
 * Reemplaza la copia local de una skill por el contenido del upstreamSkillDir
 * y actualiza el pin `commit` en upstreams.json.
 *
 * Reglas:
 * - Skills protegidas (agent-delegation, work-lifecycle) y kind=release (graphify)
 *   se rechazan sin tocar el disco.
 * - Se hace backup de la skill local antes de tocarla.
 * - La copia se hace en staging (dir hermano temporal) antes de renombrar,
 *   para evitar ventanas de estado parcial en caso de error.
 * - upstreams.json se reescribe atómicamente (writeText = temp+rename).
 *   El resto de claves del JSON se preservan intactas.
 *
 * @param upstreamsFilePath - Ruta al upstreams.json (por defecto la del proyecto).
 * @param localSkillsRoot   - Directorio raíz de skills locales (por defecto stack/skills/).
 * @param backupsRoot       - Raíz de backups (para tests; por defecto el dataDir real).
 */
export function replaceSkill(
  name: string,
  upstreamSkillDir: string,
  newCommit: string,
  upstreamsFilePath?: string,
  localSkillsRoot?: string,
  backupsRoot?: string,
): void {
  if (PROTECTED_SKILLS.has(name)) {
    throw new Error(`La skill "${name}" es propia del stack y no se actualiza desde upstream.`);
  }

  const upstreamsFile = upstreamsFilePath ?? path.join(path.dirname(stackRoot()), "upstreams.json");
  const raw = fs.readFileSync(upstreamsFile, "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = JSON.parse(raw) as any;

  const skillEntry = data?.skills?.[name];
  if (!skillEntry) {
    throw new Error(`Skill "${name}" no encontrada en upstreams.json.`);
  }
  if (skillEntry.kind === "release") {
    throw new Error(`La skill "${name}" es de tipo release y no se actualiza con replaceSkill.`);
  }

  const skillsRoot = localSkillsRoot ?? path.join(stackRoot(), "skills");
  const localSkillDir = path.join(skillsRoot, name);

  // Backup de la copia local actual (puede no existir si es totalmente nueva).
  const localFiles = listFilesRecursive(localSkillDir);
  if (localFiles.length > 0) {
    createBackup(localFiles, `skill-update-${name}`, backupsRoot);
  }

  // Copia el upstream a un dir staging hermano; luego rename atómico.
  const stagingDir = `${localSkillDir}.staging-${process.pid}`;
  try {
    const upstreamFiles = listFilesRecursive(upstreamSkillDir);
    for (const src of upstreamFiles) {
      const rel = path.relative(upstreamSkillDir, src);
      const dest = path.join(stagingDir, rel);
      ensureDir(path.dirname(dest));
      copyFile(src, dest);
    }

    // Rename: local → .old, staging → local, borrar .old
    const oldDir = `${localSkillDir}.old-${process.pid}`;
    if (fs.existsSync(localSkillDir)) {
      fs.renameSync(localSkillDir, oldDir);
    }
    fs.renameSync(stagingDir, localSkillDir);
    fs.rmSync(oldDir, { recursive: true, force: true });
  } catch (err) {
    // Limpiar staging en error para no dejar restos
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignorar */ }
    throw err;
  }

  // Re-pin del commit en upstreams.json (upsert quirúrgico, escritura atómica).
  skillEntry.commit = newCommit;
  writeText(upstreamsFile, JSON.stringify(data, null, 2) + "\n");
}
