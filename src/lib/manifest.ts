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

export interface RuntimeManifest {
  configDir: string;
  /** Rutas absolutas resueltas de los archivos enteramente nuestros. */
  owned: string[];
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
