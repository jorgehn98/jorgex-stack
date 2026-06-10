import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { HOME } from "./paths.js";
import type { RuntimeId } from "../adapters/types.js";

export interface RuntimeDetection {
  id: RuntimeId;
  name: string;
  installed: boolean;
  binPath: string | null;
  configDir: string;
}

/** Busca un ejecutable en PATH sin invocar shell. */
export function lookPath(cmd: string): string | null {
  // En Windows, primero las extensiones ejecutables: los shims de npm/pnpm
  // crean también un script sh sin extensión que cmd.exe no puede ejecutar.
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return null;
}

export function detectOpenCode(): RuntimeDetection {
  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(HOME, ".config", "opencode");
  const binPath = lookPath("opencode");
  return {
    id: "opencode",
    name: "OpenCode",
    installed: binPath !== null || existsSync(configDir),
    binPath,
    configDir,
  };
}

export function detectClaudeCode(): RuntimeDetection {
  const configDir = path.join(HOME, ".claude");
  const binPath = lookPath("claude");
  return {
    id: "claude-code",
    name: "Claude Code",
    installed: binPath !== null || existsSync(configDir),
    binPath,
    configDir,
  };
}

export function detectCodex(): RuntimeDetection {
  const configDir = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
  const binPath = lookPath("codex");
  return {
    id: "codex",
    name: "Codex CLI",
    installed: binPath !== null || existsSync(configDir),
    binPath,
    configDir,
  };
}

/**
 * Detección de Engram (PRD D7): respeta SIEMPRE la instalación existente.
 * Orden: ENGRAM_BIN → PATH → rutas conocidas. Nunca se reinstala ni se toca
 * la base de datos del usuario.
 */
export function detectEngram(): string | null {
  const fromEnv = process.env.ENGRAM_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = lookPath("engram");
  if (onPath) return onPath;
  const candidates = [
    path.join(HOME, "go", "bin", "engram.exe"),
    path.join(HOME, "go", "bin", "engram"),
    path.join(HOME, ".local", "bin", "engram.exe"),
    path.join(HOME, ".local", "bin", "engram"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
