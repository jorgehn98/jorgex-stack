import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

export interface DetectedBinCommand {
  command: string;
  args: string[];
}

/**
 * Los shims .cmd/.bat requieren cmd.exe en Windows. El intérprete recibe argv
 * directo (no `shell: true`) y solo acepta partes sin metacaracteres de cmd.
 */
export function planDetectedBinCommand(bin: string, args: string[]): DetectedBinCommand | null {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args };
  if ([bin, ...args].some((part) => /[&|<>()^%!"\r\n]/.test(part))) return null;

  const quote = (part: string): string => part === "" || /\s/.test(part) ? `"${part}"` : part;
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [quote(bin), ...args.map(quote)].join(" ")],
  };
}

/**
 * Ejecuta un binario detectado con args fijos y devuelve su stdout, o null.
 * Argv directo sin shell: una ruta con metacaracteres nunca se interpreta.
 * Los shims .cmd/.bat de npm/pnpm solo corren vía cmd.exe — ahí la ruta se
 * valida antes de interpolarla (los args de los callers son literales).
 */
export function runDetectedBin(bin: string, args: string[], timeoutMs: number): string | null {
  try {
    const command = planDetectedBinCommand(bin, args);
    if (command === null) return null;
    return execFileSync(command.command, command.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
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
