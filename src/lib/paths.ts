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

/**
 * Raíz de configuración nativa de OpenCode (fuente oficial v2.0.19+):
 * `OPENCODE_CONFIG_DIR` manda; si falta, `$XDG_CONFIG_HOME/opencode`; si no,
 * `~/.config/opencode`. Helper puro (lee el entorno en cada llamada) que detect
 * y el adapter comparten para que no diverjan.
 */
export function resolveOpenCodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCODE_CONFIG_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(env.HOME ?? HOME, ".config");
  return path.join(base, "opencode");
}

/** Igualdad de rutas robusta (Windows es case-insensitive). */
export function samePath(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (process.platform === "win32") return resolvedA.toLowerCase() === resolvedB.toLowerCase();
  return resolvedA === resolvedB;
}
