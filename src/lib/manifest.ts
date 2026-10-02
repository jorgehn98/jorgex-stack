import fs from "node:fs";
import path from "node:path";
import type { RuntimeId } from "../adapters/types.js";
import { dataDir, HOME } from "./paths.js";
import { isContainedIn, readTextIfExists, writeText } from "./fsx.js";

/**
 * Manifest de instalación (~/.jorgex-stack/manifest.json): registra qué
 * archivos enteramente nuestros quedaron instalados por runtime. Permite que
 * sync limpie huérfanos cuando una versión nueva del stack renombra o elimina
 * un archivo, y que uninstall borre exactamente lo instalado aunque el plan
 * actual ya no lo genere. Los archivos compartidos (CLAUDE.md, opencode.json…)
 * no van aquí: se gestionan por unmerge de secciones.
 */

/**
 * Binding de la unidad de usuario Browser Control (T13). Evidencia de la release
 * retenida que autoriza los bytes de la unidad; `owned` sigue siendo la única
 * autoridad de propiedad, este digest no la reclama por sí solo. `releaseDirectory`
 * es siempre el basename `release-*` del namespace operativo, nunca una ruta
 * arbitraria ni el candidato.
 */
export interface ManagedBrowserControlServiceBinding {
  schemaVersion: 1;
  releaseDirectory: string;
  receiptSha256: string;
  nodePath: string;
  port: number;
  unitSha256: string;
}

/**
 * Autoridad granular del entorno del servicio Browser Control verificado (T13).
 * `projectionSha256` liga la proyección local+comando completo+puerto+autostart
 * false; `portOwned` distingue el puerto introducido por Stack de uno manual.
 */
export interface BrowserControlAutostartStamp {
  schemaVersion: 1;
  projectionSha256: string;
  portOwned: boolean;
}

export interface RuntimeManifest {
  configDir: string;
  /** Rutas absolutas resueltas de los archivos enteramente nuestros. */
  owned: string[];
  /**
   * Rutas que el plan ya no reclama y cuyo borrado queda pendiente. Siguen
   * en `owned` para que una próxima pasada pueda reintentarlo; solo se
   * retiran de ambos campos tras borrado verificado. Ausente equivale a sin
   * pendientes.
   */
  pendingOrphans?: string[];
  /** Binding de la unidad de servicio gestionada, si existe (solo OpenCode/Linux). */
  serviceUnit?: ManagedBrowserControlServiceBinding;
  /** Estampa de autostart del MCP cuando un servicio externo quedó verificado. */
  browserControlAutostart?: BrowserControlAutostartStamp;
  updatedAt: string;
}

export interface StackManifest {
  runtimes: Partial<Record<RuntimeId, RuntimeManifest>>;
}

export function manifestFile(): string {
  return path.join(dataDir(), "manifest.json");
}

export function readManifest(file = manifestFile()): StackManifest {
  const raw = readTextIfExists(file);
  if (raw === null) return { runtimes: {} };
  try {
    const parsed = JSON.parse(raw) as StackManifest;
    return { runtimes: parsed.runtimes ?? {} };
  } catch {
    // Manifest corrupto: se regenera en el siguiente install/sync.
    return { runtimes: {} };
  }
}

/**
 * Lectura estricta del manifest para decidir ownership antes de limpiar:
 * distingue ausente (ENOENT) de ilegible (otros errores) y de contenido no
 * interpretable. Un manifest editable no acredita propiedad por sí solo, pero
 * tampoco se puede asumir ausente cuando existe y no se puede leer/parsear:
 * el caller falla cerrado en vez de regenerar sobre estado desconocido.
 */
export type ManifestRead =
  | { status: "absent" }
  | { status: "ok"; manifest: StackManifest }
  | { status: "invalid"; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readManifestStrict(file = manifestFile()): ManifestRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    if (code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: `${file}: ilegible (${code})` };
  }
  if (raw.trim() === "") return { status: "invalid", reason: `${file}: vacío` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid", reason: `${file}: JSON no válido` };
  }
  const root = isPlainObject(parsed) ? parsed : null;
  if (root === null) return { status: "invalid", reason: `${file}: no es un objeto JSON` };
  const runtimes = root["runtimes"];
  if (runtimes === undefined) return { status: "ok", manifest: { runtimes: {} } };
  if (!isPlainObject(runtimes)) return { status: "invalid", reason: `${file}: 'runtimes' no es un objeto` };
  return { status: "ok", manifest: { runtimes: runtimes as StackManifest["runtimes"] } };
}

export function writeRuntimeManifest(id: RuntimeId, entry: RuntimeManifest, file = manifestFile()): void {
  const manifest = readManifest(file);
  manifest.runtimes[id] = entry;
  writeText(file, JSON.stringify(manifest, null, 2) + "\n");
}

export function removeRuntimeManifest(id: RuntimeId, file = manifestFile()): void {
  const manifest = readManifest(file);
  if (!(id in manifest.runtimes)) return;
  delete manifest.runtimes[id];
  writeText(file, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Huérfanos: archivos owned de una instalación previa que ya no son target de
 * ningún plan actual (de ningún runtime instalado). Nunca propone engram.ts
 * (D7) y solo devuelve archivos que existen DENTRO de root: el manifest es
 * estado local editable y no puede dirigir borrados fuera de esa frontera.
 */
export function findOrphans(prevOwned: string[], currentTargets: ReadonlySet<string>, root = HOME): string[] {
  return prevOwned
    .map((f) => path.resolve(f))
    .filter(
      (f) => !currentTargets.has(f) && path.basename(f) !== "engram.ts" && isContainedIn(f, root) && fs.existsSync(f),
    );
}
