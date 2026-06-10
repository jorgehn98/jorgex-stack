import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

/**
 * Raíz de la fuente canónica (carpeta stack/). Se resuelve subiendo desde este
 * módulo hasta encontrarla, así funciona igual en dist/ (bundle) y en dev.
 */
export function stackRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "stack");
    if (existsSync(path.join(candidate, "system-prompt", "AGENTS.md"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("No se encontró stack/ relativa al CLI — instalación rota.");
}

/** Datos locales del usuario (model-map, backups). Nunca van al repo. */
export function dataDir(): string {
  return path.join(HOME, ".jorgex-stack");
}
