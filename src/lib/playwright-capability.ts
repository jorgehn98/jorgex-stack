import {
  detectPlaywrightCli,
  isPlaywrightBrowserReady,
  resolvePnpmBin,
  verifyPlaywrightBrowser,
  type PlaywrightBrowserCacheState,
  type PlaywrightCliState,
} from "./external-tools.js";

/** Snapshot efímera de la capacidad global compartida de Playwright. */
export interface PlaywrightCapabilitySnapshot {
  cli: PlaywrightCliState;
  browserCache: PlaywrightBrowserCacheState;
  browserVerified: boolean;
  effective: boolean;
}

/**
 * Comprueba una sola vez la capacidad global de Playwright.
 * La existencia de la caché no certifica que Chromium pueda arrancar.
 */
export function inspectPlaywrightCapability(options: { browserVerified?: boolean } = {}): PlaywrightCapabilitySnapshot {
  const cli = detectPlaywrightCli();
  const browserCache = isPlaywrightBrowserReady();
  let browserVerified = false;

  if (cli.status === "current" && browserCache.status === "ready") {
    if (options.browserVerified === true) {
      browserVerified = true;
    } else {
      const pnpmBin = resolvePnpmBin();
      if (pnpmBin !== null) {
        try { browserVerified = verifyPlaywrightBrowser(pnpmBin); }
        catch { browserVerified = false; }
      }
    }
  }

  const effective = cli.status === "current"
    && cli.binPath !== null
    && (options.browserVerified === true || browserCache.status === "ready")
    && browserVerified;
  return { cli, browserCache, browserVerified, effective };
}
