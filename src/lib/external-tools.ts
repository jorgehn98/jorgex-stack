import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lookPath, planDetectedBinCommand, runDetectedBin } from "./detect.js";

export const PLAYWRIGHT_CLI = {
  packageName: "@playwright/cli",
  bin: "playwright-cli",
  version: "0.1.17",
  browserInstallAction: "install-browser",
} as const;

export type PlaywrightCliStatus = "absent" | "broken" | "current" | "outdated";

export interface PlaywrightCliState {
  status: PlaywrightCliStatus;
  binPath: string | null;
  detectedVersion: string | null;
}

export interface PlaywrightCliDetectionInput {
  binPath: string | null;
  versionOutput: string | null;
}

export type PlaywrightCliAction = "install" | "update" | "remove" | "install-browser";

export type PlaywrightBrowserCacheState =
  | { status: "ready"; path: string }
  | { status: "missing"; path: string; errorCode?: string }
  | { status: "unreadable"; path: string; errorCode: string };

export interface CommandPlan {
  command: string;
  args: string[];
}

function parsePlaywrightCliVersion(output: string | null): string | null {
  if (output === null) return null;
  return /^playwright-cli\s+(\d+\.\d+\.\d+)\s*$/i.exec(output.trim())?.[1] ?? null;
}

/** Resuelve el estado desde valores inyectables para no acoplarlo a PATH ni a procesos. */
export function resolvePlaywrightCliState({ binPath, versionOutput }: PlaywrightCliDetectionInput): PlaywrightCliState {
  if (binPath === null) return { status: "absent", binPath: null, detectedVersion: null };

  const detectedVersion = parsePlaywrightCliVersion(versionOutput);
  if (detectedVersion === null) return { status: "broken", binPath, detectedVersion: null };

  return {
    status: detectedVersion === PLAYWRIGHT_CLI.version ? "current" : "outdated",
    binPath,
    detectedVersion,
  };
}

/** Detecta la herramienta con el mismo acceso seguro a PATH/procesos que el resto del CLI. */
export function detectPlaywrightCli(): PlaywrightCliState {
  const binPath = lookPath(PLAYWRIGHT_CLI.bin);
  return resolvePlaywrightCliState({
    binPath,
    versionOutput: binPath ? runDetectedBin(binPath, ["--version"], 5_000) : null,
  });
}

/** Resuelve pnpm para que los callers ejecuten el plan sin shell. */
export function resolvePnpmBin(): string | null {
  const pnpm = lookPath("pnpm");
  if (pnpm !== null && !pnpm.toLowerCase().endsWith(".ps1")) return pnpm;

  const pnpmCmd = lookPath("pnpm.cmd");
  return pnpmCmd !== null && !pnpmCmd.toLowerCase().endsWith(".ps1") ? pnpmCmd : null;
}

/**
 * Comprueba la caché de navegadores de Playwright sin arrancar un navegador ni
 * abrir una URL. Es una señal conservadora: una caché desconocida se trata como
 * no preparada para que doctor no declare sano un entorno incompleto.
 */
export function isPlaywrightBrowserReady(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
): PlaywrightBrowserCacheState {
  const configuredPath = env.PLAYWRIGHT_BROWSERS_PATH;
  const cacheDir = configuredPath ?? (
    platform === "win32"
      ? path.join(env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"), "ms-playwright")
      : platform === "darwin"
        ? path.join(homeDir, "Library", "Caches", "ms-playwright")
        : path.join(env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache"), "ms-playwright")
  );
  if (configuredPath === "0") return { status: "missing", path: cacheDir, errorCode: "DISABLED" };

  try {
    const ready = fs.readdirSync(cacheDir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && /^chromium(?:_headless_shell)?-/.test(entry.name),
    );
    return ready ? { status: "ready", path: cacheDir } : { status: "missing", path: cacheDir };
  } catch (error) {
    const errorCode = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    return errorCode === "ENOENT"
      ? { status: "missing", path: cacheDir, errorCode }
      : { status: "unreadable", path: cacheDir, errorCode };
  }
}

/** Planifica argv directo y pinneado; la ejecución pertenece al flujo que lo solicita. */
export function planPlaywrightCliCommand(action: PlaywrightCliAction, pnpmBin: string): CommandPlan {
  const pinnedPackage = `${PLAYWRIGHT_CLI.packageName}@${PLAYWRIGHT_CLI.version}`;

  switch (action) {
    case "install":
    case "update":
      return { command: pnpmBin, args: ["add", "--global", pinnedPackage] };
    case "remove":
      return { command: pnpmBin, args: ["remove", "--global", PLAYWRIGHT_CLI.packageName] };
    case "install-browser":
      return { command: pnpmBin, args: ["dlx", pinnedPackage, PLAYWRIGHT_CLI.browserInstallAction] };
  }
}

/** Ejecuta el plan pinneado sin shell y reutiliza el puente seguro para shims Windows. */
export function executePlaywrightToolAction(action: PlaywrightCliAction, pnpmBin = resolvePnpmBin()): boolean {
  if (pnpmBin === null) return false;

  const command = planPlaywrightCliCommand(action, pnpmBin);
  const invocation = planDetectedBinCommand(command.command, command.args);
  if (invocation === null) return false;

  try {
    execFileSync(invocation.command, invocation.args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}
