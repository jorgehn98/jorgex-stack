import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileAction } from "../adapters/types.js";
import { isContainedIn } from "./fsx.js";
import index from "./opencode-static-resources.json" with { type: "json" };

/**
 * Autenticación de bytes para los cuatro recursos estáticos OpenCode
 * (hooks.ts, worktree.ts y los dos scripts .cjs). El índice congelado acredita
 * únicamente el canon legacy v1 publicado: la coincidencia de digest NUNCA crea
 * ownership por sí sola. El ownership sigue viniendo del manifest coherente.
 *
 * El índice se genera con `scripts/regenerate-opencode-static-resources.py`
 * (operación mantenedora explícita, no runtime) y se empaqueta en el bundle;
 * ninguna operación de usuario consulta la red.
 */

export interface StaticResourceRow {
  readonly source: string;
  readonly target: string;
  readonly size: number;
  readonly sha256: string;
}

interface StaticResourceIndex {
  readonly provenance: {
    readonly package: string;
    readonly version: string;
    readonly commit: string;
    readonly sri: string;
  };
  readonly resources: readonly StaticResourceRow[];
}

const data = index as StaticResourceIndex;

/** Procedencia del artefacto histórico verificado (paquete/versión/commit/SRI). */
export const STATIC_RESOURCE_PROVENANCE = data.provenance;

/** Filas ordenadas por target; solo los cuatro recursos proyectados. */
export const STATIC_RESOURCES: readonly StaticResourceRow[] = data.resources;

export type StaticResourceVerdict =
  | "absent"
  | "current"
  | "legacy"
  | "unknown"
  | "symlink"
  | "not-regular"
  | "unreadable"
  | "escaping";

export interface StaticResourceAuth {
  readonly target: string;
  readonly row: StaticResourceRow;
  readonly owned: boolean;
  readonly verdict: StaticResourceVerdict;
}

/** Mapa target absoluto → fila congelada para un configDir concreto. */
export function staticResourceTargets(configDir: string): Map<string, StaticResourceRow> {
  const map = new Map<string, StaticResourceRow>();
  for (const row of STATIC_RESOURCES) map.set(path.resolve(configDir, row.target), row);
  return map;
}

/** Bytes que la proyección escribiría para cada target resuelto del plan. */
export function projectedBytesByTarget(actions: readonly FileAction[]): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  for (const action of actions) {
    const target = path.resolve(action.target);
    try {
      map.set(target, action.kind === "write" ? Buffer.from(action.content) : fs.readFileSync(action.source));
    } catch {
      // Fuente ilegible: sin bytes actuales autenticables; el caller bloquea.
    }
  }
  return map;
}

function matches(bytes: Buffer, size: number, sha256: string): boolean {
  return bytes.length === size && crypto.createHash("sha256").update(bytes).digest("hex") === sha256;
}

interface StaticResourceBase {
  readonly target: string;
  readonly row: StaticResourceRow;
  readonly owned: boolean;
}

interface RealpathFailure {
  readonly ok: false;
  readonly code: string | undefined;
}

function tryRealpath(target: string): { ok: true; path: string } | RealpathFailure {
  try {
    return { ok: true, path: fs.realpathSync(target) };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return { ok: false, code };
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

/** El ancestro vivo más cercano, o null si no se pudo determinar (fail-closed). */
function nearestExistingAncestor(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function physicallyInside(candidate: string, root: string): boolean {
  return candidate === root || isContainedIn(candidate, root);
}

/**
 * Evalúa la física ANTES de aceptar una ausencia: aunque el leaf no exista, el
 * ancestro vivo más cercano debe resolver dentro de la raíz física autorizada.
 * Una raíz/ancestro no resoluble falla cerrado y nunca autoriza una lectura.
 */
function resolveAbsentVerdict(base: StaticResourceBase, target: string, root: string): StaticResourceAuth {
  const realRoot = tryRealpath(root);
  if (!realRoot.ok) {
    // Raíz aún no creada (install fresh): solo se admite un leaf ausente cuyo
    // ancestro vivo sea un prefijo léxico de la raíz; cualquier otra cosa
    // (EACCES, ancestro enlace) bloquea.
    if (realRoot.code !== "ENOENT") return { ...base, verdict: "unreadable" };
    const resolvedRoot = path.resolve(root);
    const ancestor = nearestExistingAncestor(path.dirname(target));
    if (ancestor === null) return { ...base, verdict: "unreadable" };
    const realAncestor = tryRealpath(ancestor);
    if (!realAncestor.ok) return { ...base, verdict: "unreadable" };
    return physicallyInside(realAncestor.path, resolvedRoot) || isContainedIn(resolvedRoot, realAncestor.path)
      ? { ...base, verdict: "absent" }
      : { ...base, verdict: "escaping" };
  }
  const ancestor = nearestExistingAncestor(path.dirname(target));
  if (ancestor === null) return { ...base, verdict: "escaping" };
  const realAncestor = tryRealpath(ancestor);
  if (!realAncestor.ok) return { ...base, verdict: "unreadable" };
  return physicallyInside(realAncestor.path, realRoot.path)
    ? { ...base, verdict: "absent" }
    : { ...base, verdict: "escaping" };
}

/**
 * Clasifica un recurso estático contra sus bytes actuales proyectados y el
 * canon legacy congelado. No sigue enlaces: abre con O_NOFOLLOW cuando el SO lo
 * soporta, valida el descriptor (`fstat`) y solo lee hasta el tamaño candidato
 * acreditado +1, verificando estabilidad después. No usa `readFileSync(path)`
 * sobre un `lstat` que puede quedar obsoleto.
 */
export function authenticateStaticResource(
  target: string,
  row: StaticResourceRow,
  currentBytes: Buffer | null,
  owned: boolean,
  root: string,
): StaticResourceAuth {
  const base: StaticResourceBase = { target, row, owned };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { ...base, verdict: "unreadable" };
    return resolveAbsentVerdict(base, target, root);
  }
  if (stat.isSymbolicLink()) return { ...base, verdict: "symlink" };
  if (!stat.isFile() || stat.nlink > 1) return { ...base, verdict: "not-regular" };

  const realRoot = tryRealpath(root);
  if (!realRoot.ok) return { ...base, verdict: "unreadable" };
  const realTarget = tryRealpath(target);
  if (!realTarget.ok) return { ...base, verdict: "unreadable" };
  if (!physicallyInside(realTarget.path, realRoot.path)) return { ...base, verdict: "escaping" };

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "EMLINK") return { ...base, verdict: "symlink" };
    return { ...base, verdict: "unreadable" };
  }
  try {
    if (noFollow === 0) {
      // SO sin O_NOFOLLOW: no relajar; se rechaza un leaf convertido en enlace.
      try {
        if (fs.lstatSync(target).isSymbolicLink()) return { ...base, verdict: "symlink" };
      } catch {
        return { ...base, verdict: "unreadable" };
      }
    }
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1) return { ...base, verdict: "not-regular" };

    const candidateMax = Math.max(row.size, currentBytes === null ? -1 : currentBytes.length);
    if (opened.size > candidateMax) return { ...base, verdict: "unknown" };
    const limit = candidateMax + 1;
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const read = fs.readSync(fd, buffer, offset, limit - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > candidateMax) return { ...base, verdict: "unknown" };

    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== opened.nlink) {
      return { ...base, verdict: "unknown" };
    }
    const bytes = buffer.subarray(0, offset);
    if (currentBytes !== null && bytes.equals(currentBytes)) return { ...base, verdict: "current" };
    if (matches(bytes, row.size, row.sha256)) return { ...base, verdict: "legacy" };
    return { ...base, verdict: "unknown" };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Motivo de bloqueo antes de cualquier mutación, o null si la operación puede
 * proceder. Un recurso ausente siempre procede (se crea y reclama).
 */
export function staticResourceBlockReason(auth: StaticResourceAuth): string | null {
  const label = auth.target;
  switch (auth.verdict) {
    case "absent":
      return null;
    case "current":
      return null;
    case "legacy":
      return auth.owned ? null : `${label}: recurso unowned con contenido legacy v1 conocido; se conserva sin reemplazar ni reclamar.`;
    case "symlink":
      return `${label}: es un enlace simbólico; se preserva sin seguir el enlace ni reemplazarlo.`;
    case "not-regular":
      return `${label}: no es un archivo regular (o tiene enlaces múltiples); se preserva.`;
    case "unreadable":
      return `${label}: no se pudo leer; se preserva el estado actual.`;
    case "escaping":
      return `${label}: la ruta física escapa del configDir autorizado; se preserva.`;
    case "unknown":
      return auth.owned
        ? `${label}: recurso owned con contenido modificado/desconocido; se preserva byte a byte.`
        : `${label}: recurso unowned con contenido distinto al actual; se conserva sin reemplazar ni reclamar.`;
  }
}

/** Targets unowned byte-idénticos al actual: no-op permitido pero sin claim. */
export function unownedCurrentTargets(auths: readonly StaticResourceAuth[]): Set<string> {
  const out = new Set<string>();
  for (const auth of auths) {
    if (!auth.owned && auth.verdict === "current") out.add(path.resolve(auth.target));
  }
  return out;
}
