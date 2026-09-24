import {
  detectPlaywrightCli,
  isPlaywrightBrowserReady,
  resolvePnpmBin,
  verifyPlaywrightBrowser,
  type PlaywrightBrowserCacheState,
  type PlaywrightCliState,
} from "./external-tools.js";
import { loadPlaywrightCliObservation } from "./tool-preferences.js";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
  const hasStableExpected = typeof expectedVersion === "string" && STABLE_SEMVER.test(expectedVersion);
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
