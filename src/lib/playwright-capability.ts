import {
  detectPlaywrightCli,
  isPlaywrightBrowserReady,
  resolvePnpmBin,
  verifyPlaywrightBrowser,
  type PlaywrightBrowserCacheState,
  type PlaywrightCliState,
} from "./external-tools.js";
import { loadPlaywrightCliObservation, playwrightCliPreferenceFile } from "./tool-preferences.js";
import { isStableSemverVersion } from "./npm-provider.js";
import { loadVerifiedManagedBrowserReceipt } from "./browser-managed.js";
import { runVerifiedManagedPlaywright, verifyManagedPlaywrightBrowser } from "./browser-command.js";
import { dataDir } from "./paths.js";

/** Snapshot efímera de la capacidad global compartida de Playwright. */
export interface PlaywrightCapabilitySnapshot {
  cli: PlaywrightCliState;
  browserCache: PlaywrightBrowserCacheState;
  browserVerified: boolean;
  effective: boolean;
}

/** Snapshot entregada después de completar un setup verificado. */
export interface VerifiedPlaywrightCapabilitySnapshot extends PlaywrightCapabilitySnapshot {
  cli: { status: "current"; binPath: string; detectedVersion: string };
  browserCache: { status: "ready"; path: string };
  browserVerified: true;
  effective: true;
}

/** Read-only local candidate for update --check; hashes the managed receipt, never PATH. */
export function detectManagedPlaywrightCli(stateDir = dataDir()): PlaywrightCliState {
  const observed = loadPlaywrightCliObservation(playwrightCliPreferenceFile(stateDir));
  try {
    const receipt = loadVerifiedManagedBrowserReceipt(stateDir, "@playwright/cli");
    if (receipt === null) return { status: "absent", binPath: null, detectedVersion: null };
    return {
      status: observed?.version === receipt.version && observed.integrity === receipt.integrity ? "current" : "outdated",
      binPath: receipt.launcherPath,
      detectedVersion: receipt.version,
    };
  } catch {
    return { status: "broken", binPath: null, detectedVersion: null };
  }
}

/** Offline managed receipt check plus a bounded CLI/Chromium smoke; never checks global pnpm. */
export function inspectManagedPlaywrightCapability(options: {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  browserVerified?: boolean;
} = {}): PlaywrightCapabilitySnapshot {
  const stateDir = options.stateDir ?? dataDir();
  const browserCache = isPlaywrightBrowserReady(options.env ?? process.env);
  const observed = loadPlaywrightCliObservation(playwrightCliPreferenceFile(stateDir));
  let receipt;
  try { receipt = loadVerifiedManagedBrowserReceipt(stateDir, "@playwright/cli"); }
  catch {
    return { cli: { status: "broken", binPath: null, detectedVersion: null },
      browserCache, browserVerified: false, effective: false };
  }
  if (receipt === null) {
    return { cli: { status: "absent", binPath: null, detectedVersion: null },
      browserCache, browserVerified: false, effective: false };
  }
  const matches = observed !== null && receipt.version === observed.version && receipt.integrity === observed.integrity;
  if (!matches) {
    return { cli: { status: "outdated", binPath: receipt.launcherPath, detectedVersion: receipt.version },
      browserCache, browserVerified: false, effective: false };
  }
  try {
    const result = runVerifiedManagedPlaywright(stateDir, ["--version"], { captureOutput: true, timeoutMs: 5_000 });
    const reported = (result.stdout ?? "").trim().replace(/^playwright-cli\s+/i, "");
    if (result.error !== undefined || result.status !== 0 || reported !== receipt.version) {
      throw new Error("managed Playwright version probe failed");
    }
    const browserVerified = browserCache.status === "ready"
      && (options.browserVerified === true || verifyManagedPlaywrightBrowser(stateDir));
    return {
      cli: { status: "current", binPath: receipt.launcherPath, detectedVersion: receipt.version },
      browserCache, browserVerified, effective: browserVerified,
    };
  } catch {
    return { cli: { status: "broken", binPath: receipt.launcherPath, detectedVersion: receipt.version },
      browserCache, browserVerified: false, effective: false };
  }
}

/**
 * Comprueba una sola vez la capacidad global de Playwright.
 * La existencia de la caché no certifica que Chromium pueda arrancar.
 */
export function inspectPlaywrightCapability(options: {
  expectedVersion?: string;
  browserVerified?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): PlaywrightCapabilitySnapshot {
  const env = options.env ?? process.env;
  const isDefaultRuntime = options.env === undefined;
  let expectedVersion = options.expectedVersion;
  if (expectedVersion === undefined && isDefaultRuntime) {
    const observed = loadPlaywrightCliObservation();
    if (observed) expectedVersion = observed.version;
  }
  const hasStableExpected = isStableSemverVersion(expectedVersion);
  const cli = options.env === undefined
    ? detectPlaywrightCli(undefined, expectedVersion)
    : detectPlaywrightCli(env, expectedVersion);
  const browserCache = options.env === undefined ? isPlaywrightBrowserReady() : isPlaywrightBrowserReady(env);
  let browserVerified = false;

  if (hasStableExpected && cli.status === "current" && browserCache.status === "ready") {
    if (options.browserVerified === true) {
      browserVerified = true;
    } else {
      const pnpmBin = options.env === undefined ? resolvePnpmBin() : resolvePnpmBin(env);
      if (pnpmBin !== null) {
        try { browserVerified = verifyPlaywrightBrowser(pnpmBin, env, undefined, expectedVersion); }
        catch { browserVerified = false; }
      }
    }
  }

  const effective = hasStableExpected
    && cli.status === "current"
    && cli.binPath !== null
    && cli.detectedVersion === expectedVersion
    && (options.browserVerified === true || browserCache.status === "ready")
    && browserVerified;
  return { cli, browserCache, browserVerified, effective };
}
