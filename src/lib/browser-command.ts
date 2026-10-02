import { spawnSync } from "node:child_process";
import path from "node:path";
import { dataDir } from "./paths.js";
import { loadVerifiedManagedBrowserReceipt, planManagedBrowserInvocation } from "./browser-managed.js";
import {
  loadPlaywrightCliObservation,
  loadPlaywrightCliPreference,
  playwrightCliPreferenceError,
  playwrightCliPreferenceFile,
} from "./tool-preferences.js";
import { verifyPlaywrightPackageBrowser } from "./external-tools.js";

/** User-facing Playwright entry: Stack code verifies the receipt before spawning. */
export function runManagedPlaywrightCommand(args: readonly string[], stateDir = dataDir()): number {
  const preferenceFile = playwrightCliPreferenceFile(stateDir);
  const preferenceError = playwrightCliPreferenceError(preferenceFile);
  if (preferenceError !== null) throw new Error(preferenceError);
  if (loadPlaywrightCliPreference(preferenceFile) !== true) {
    throw new Error("Playwright CLI: opt-in no habilitado; ejecuta install --playwright.");
  }
  const observed = loadPlaywrightCliObservation(preferenceFile);
  const receipt = loadVerifiedManagedBrowserReceipt(stateDir, "@playwright/cli");
  if (observed === null || receipt === null
    || observed.version !== receipt.version || observed.integrity !== receipt.integrity) {
    throw new Error("Playwright CLI: falta un receipt gestionado coincidente con la observación.");
  }
  const result = runVerifiedManagedPlaywright(stateDir, args);
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

/**
 * Revalidates the verified active receipt and spawns its guarded launcher.
 * `planManagedBrowserInvocation` re-checks tree/launcher on every call, so a
 * missing, drifted or manipulated runtime fails closed before any provider code
 * runs; there is no PATH, global or candidate fallback.
 */
function runVerifiedManagedBrowser(
  stateDir: string,
  packageName: "@playwright/cli" | "@opencode-ai/browser-control",
  args: readonly string[],
  options: { captureOutput?: boolean; timeoutMs?: number } = {},
) {
  const plan = planManagedBrowserInvocation(stateDir, packageName, args);
  return spawnSync(plan.command, [...plan.args], {
    encoding: "utf8", stdio: options.captureOutput ? "pipe" : "inherit", shell: false,
    timeout: options.timeoutMs ?? 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
  });
}

/** Install/doctor can invoke the verified tree before opt-in is persisted. */
export function runVerifiedManagedPlaywright(
  stateDir: string,
  args: readonly string[],
  options: { captureOutput?: boolean; timeoutMs?: number } = {},
) {
  return runVerifiedManagedBrowser(stateDir, "@playwright/cli", args, options);
}

/**
 * `jorgex-stack browser control <args>`: forwards the provider's own arguments
 * (including `--help`/`--json`/`--session`/`--file`) exactly to the verified
 * active Browser Control runtime, without adding an `mcp` argument.
 */
export function runManagedBrowserControlCommand(args: readonly string[], stateDir = dataDir()): number {
  const result = runVerifiedManagedBrowser(stateDir, "@opencode-ai/browser-control", args);
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

/** No global pnpm lookup: smoke Chromium from the authenticated managed tree. */
export function verifyManagedPlaywrightBrowser(stateDir: string): boolean {
  const receipt = loadVerifiedManagedBrowserReceipt(stateDir, "@playwright/cli");
  if (receipt === null) return false;
  const packageFile = path.join(receipt.treePath, "@playwright", "cli", "package.json");
  return verifyPlaywrightPackageBrowser(packageFile, receipt.version);
}
