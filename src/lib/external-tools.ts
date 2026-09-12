import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lookPath, planDetectedBinCommand, runDetectedBin } from "./detect.js";

export const PLAYWRIGHT_CLI = {
  packageName: "@playwright/cli",
  bin: "playwright-cli",
  version: "0.1.18",
  browserInstallAction: "install-browser",
} as const;

export type PlaywrightCliStatus = "absent" | "broken" | "current" | "outdated" | "not-in-path";

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

export type PnpmSetupResult =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; reason: string };

export type PlaywrightToolActionFailureReason =
  | "pnpm-unavailable"
  | "pnpm-command"
  | "pnpm-global-bin"
  | "action-failed"
  | "browser-launch";

export type PlaywrightToolActionResult =
  | { ok: true }
  | { ok: false; reason: PlaywrightToolActionFailureReason };

export const PNPM_GLOBAL_BIN_REMEDY =
  "Ejecuta 'pnpm setup', abre una terminal nueva y reintenta. Sin consentimiento, el stack no modifica la configuración de la shell.";

/** Devuelve un remedio accionable solo para fallos atribuibles a pnpm. */
export function resolvePnpmFailureRemedy(reason: PlaywrightToolActionFailureReason): string | null {
  switch (reason) {
    case "pnpm-unavailable":
      return "Instala pnpm o añádelo a PATH antes de reintentar.";
    case "pnpm-command":
      return "No se pudo ejecutar pnpm. Revisa su instalación, PATH y permisos antes de reintentar.";
    case "pnpm-global-bin":
      return PNPM_GLOBAL_BIN_REMEDY;
    case "action-failed":
      return null;
    case "browser-launch":
      return "Chromium se descargó, pero no ha podido arrancar. Revisa el error de lanzamiento y las dependencias de tu sistema antes de reintentar.";
  }
}

export type PlaywrightBrowserCacheState =
  | { status: "ready"; path: string }
  | { status: "missing"; path: string; errorCode?: string }
  | { status: "unreadable"; path: string; errorCode: string };

export interface CommandPlan {
  command: string;
  args: string[];
}

function hasNonzeroProcessStatus(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && typeof error.status === "number"
    && error.status !== 0;
}

function parsePlaywrightCliVersion(output: string | null): string | null {
  if (output === null) return null;
  return /^(?:playwright-cli\s+)?(\d+\.\d+\.\d+)$/i.exec(output.trim())?.[1] ?? null;
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
  if (binPath === null) {
    const pnpmHome = resolvePnpmHome();
    const name = process.platform === "win32" ? `${PLAYWRIGHT_CLI.bin}.cmd` : PLAYWRIGHT_CLI.bin;
    const known = [path.join(pnpmHome, name), path.join(pnpmHome, "bin", name)]
      .find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
    if (known) return { status: "not-in-path", binPath: known, detectedVersion: null };
  }
  return resolvePlaywrightCliState({
    binPath,
    versionOutput: binPath ? runDetectedBin(binPath, ["--version"], 5_000, { NO_UPDATE_NOTIFIER: "1" }) : null,
  });
}

/** Resuelve pnpm para que los callers ejecuten el plan sin shell. */
export function resolvePnpmBin(): string | null {
  const pnpm = lookPath("pnpm");
  if (pnpm !== null && !pnpm.toLowerCase().endsWith(".ps1")) return pnpm;

  const pnpmCmd = lookPath("pnpm.cmd");
  return pnpmCmd !== null && !pnpmCmd.toLowerCase().endsWith(".ps1") ? pnpmCmd : null;
}

function resolvePnpmHome(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.PNPM_HOME) return env.PNPM_HOME;
  if (env.XDG_DATA_HOME) return paths.join(env.XDG_DATA_HOME, "pnpm");
  if (platform === "darwin") return paths.join(homeDir, "Library", "pnpm");
  if (platform === "win32") return env.LOCALAPPDATA ? paths.join(env.LOCALAPPDATA, "pnpm") : paths.join(homeDir, ".pnpm");
  return paths.join(homeDir, ".local", "share", "pnpm");
}

/** Ejecuta pnpm setup en un entorno hijo sin mutar el proceso del CLI. */
export function setupPnpmGlobal(
  pnpmBin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
): PnpmSetupResult {
  const pnpmHome = resolvePnpmHome(env, platform, homeDir);
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(pnpmHome)) return { ok: false, reason: "PNPM_HOME debe ser una ruta absoluta; corrige la configuración antes de reintentar." };
  const pathEntries = [pnpmHome, paths.join(pnpmHome, "bin")];
  if (env.PATH !== undefined) pathEntries.push(env.PATH);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PNPM_HOME: pnpmHome,
    PATH: pathEntries.join(platform === "win32" ? ";" : ":"),
  };
  const invocation = planDetectedBinCommand(pnpmBin, ["setup"]);
  if (invocation === null) return { ok: false, reason: "No se pudo preparar la invocación de pnpm setup." };
  try {
    execFileSync(invocation.command, invocation.args, { stdio: "inherit", env: childEnv });
    return { ok: true, env: childEnv };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
      return { command: pnpmBin, args: ["dlx", pinnedPackage, PLAYWRIGHT_CLI.browserInstallAction, "chromium"] };
  }
}

/** Comprueba que Chromium del CLI global puede arrancar en un perfil efímero, sin abrir sitios externos. */
export function verifyPlaywrightBrowser(
  pnpmBin: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): boolean {
  const rootCommand = planDetectedBinCommand(pnpmBin, ["root", "--global"]);
  if (rootCommand === null) return false;
  try {
    const root = execFileSync(rootCommand.command, rootCommand.args, {
      encoding: "utf8", timeout: 5_000, env, cwd, stdio: ["ignore", "pipe", "inherit"],
    }).trim();
    if (!path.isAbsolute(root)) return false;
    const packageFile = fs.realpathSync(path.join(root, "@playwright", "cli", "package.json"));
    const installed = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: string; version?: string };
    if (installed.name !== PLAYWRIGHT_CLI.packageName || installed.version !== PLAYWRIGHT_CLI.version) return false;
    const probe = `
      const { createRequire } = require('node:module');
      const { chromium } = createRequire(process.argv[1])('playwright');
      (async () => {
        const browser = await chromium.launch({ headless: true, timeout: 15000 });
        try {
          const page = await browser.newPage();
          await page.goto('about:blank', { timeout: 5000 });
        } finally { await browser.close(); }
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ["-e", probe, packageFile], {
      timeout: 25_000, stdio: "inherit", cwd, env: { ...env, NO_UPDATE_NOTIFIER: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

/** Ejecuta el plan pinneado sin shell y reutiliza el puente seguro para shims Windows. */
export function executePlaywrightToolAction(
  action: PlaywrightCliAction,
  pnpmBin = resolvePnpmBin(),
  env?: NodeJS.ProcessEnv,
): PlaywrightToolActionResult {
  if (pnpmBin === null) return { ok: false, reason: "pnpm-unavailable" };

  if (action !== "install-browser") {
    const preflight = planDetectedBinCommand(pnpmBin, ["bin", "--global"]);
    if (preflight === null) return { ok: false, reason: "pnpm-command" };
    try {
      const globalBin = execFileSync(preflight.command, preflight.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        ...(env === undefined ? {} : { env }),
      });
      if (globalBin.trim() === "") return { ok: false, reason: "pnpm-global-bin" };
    } catch (error) {
      return { ok: false, reason: hasNonzeroProcessStatus(error) ? "pnpm-global-bin" : "pnpm-command" };
    }
  }

  const command = planPlaywrightCliCommand(action, pnpmBin);
  const invocation = planDetectedBinCommand(command.command, command.args);
  if (invocation === null) return { ok: false, reason: "pnpm-command" };

  const cwd = action === "install-browser" ? fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-playwright-")) : undefined;
  const childEnv = action === "install-browser"
    ? { ...(env ?? process.env), NO_UPDATE_NOTIFIER: "1" } : (env ?? process.env);
  try {
    execFileSync(invocation.command, invocation.args, {
      stdio: "inherit", env: childEnv, ...(cwd === undefined ? {} : { cwd }),
    });
    if (action === "install-browser" && !verifyPlaywrightBrowser(pnpmBin, childEnv, cwd)) {
      return { ok: false, reason: "browser-launch" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "action-failed" };
  } finally {
    if (cwd !== undefined) fs.rmSync(cwd, { recursive: true, force: true });
  }
}
