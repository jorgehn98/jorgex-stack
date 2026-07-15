import { lookPath, runDetectedBin } from "./detect.js";

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
  return lookPath("pnpm") ?? lookPath("pnpm.cmd") ?? lookPath("pnpm.ps1");
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
