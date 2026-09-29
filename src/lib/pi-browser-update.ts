import {
  activateVerifiedBrowserArtifact,
  prepareVerifiedBrowserRelease,
} from "./browser-provider.js";
import {
  loadVerifiedManagedBrowserReceipt,
  rollbackManagedBrowserActivation,
  type ManagedBrowserReceipt,
} from "./browser-managed.js";
import { runVerifiedManagedPlaywright, verifyManagedPlaywrightBrowser } from "./browser-command.js";
import { isPlaywrightBrowserReady } from "./external-tools.js";
import {
  type VerifiedPlaywrightCapabilitySnapshot,
} from "./playwright-capability.js";
import type { ObservedVersion } from "./tool-preferences.js";

const PLAYWRIGHT_PACKAGE = "@playwright/cli";
const BROWSER_INSTALL_TIMEOUT_MS = 600_000;

export interface RefreshPiPlaywrightInput {
  readonly stateDir: string;
  readonly pnpmBin: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RefreshPiPlaywrightResult {
  readonly observed: ObservedVersion;
  readonly capability: VerifiedPlaywrightCapabilitySnapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSuccessfulProcess(result: {
  status: number | null;
  error?: Error;
}, action: string): void {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Playwright ${action} failed${result.error === undefined ? "" : `: ${result.error.message}`}`);
  }
}

/**
 * Resolve and activate the latest verified Playwright tree for Pi, then run
 * the same managed Chromium and version probes used by doctor. This helper is
 * deliberately side-effect free with respect to preferences: the caller
 * decides when the selected Pi operation has succeeded and persists the
 * returned observation then.
 */
export async function refreshPiPlaywright(
  input: RefreshPiPlaywrightInput,
): Promise<RefreshPiPlaywrightResult> {
  const previous = loadVerifiedManagedBrowserReceipt(input.stateDir, PLAYWRIGHT_PACKAGE);
  let activated: ManagedBrowserReceipt | undefined;
  let observed: ObservedVersion | undefined;
  let capability: VerifiedPlaywrightCapabilitySnapshot | undefined;

  try {
    await prepareVerifiedBrowserRelease(PLAYWRIGHT_PACKAGE, {
      fetchImpl: input.fetchImpl ?? globalThis.fetch,
      withVerifiedArtifact: async (context) => {
        activated = await activateVerifiedBrowserArtifact(context, {
          stateDir: input.stateDir,
          pnpmBin: input.pnpmBin,
          fetchImpl: input.fetchImpl ?? globalThis.fetch,
        });

        const browserInstall = runVerifiedManagedPlaywright(
          input.stateDir,
          ["install-browser", "chromium"],
          { timeoutMs: BROWSER_INSTALL_TIMEOUT_MS },
        );
        assertSuccessfulProcess(browserInstall, "Chromium installation");

        const versionProbe = runVerifiedManagedPlaywright(
          input.stateDir,
          ["--version"],
          { captureOutput: true, timeoutMs: 5_000 },
        );
        assertSuccessfulProcess(versionProbe, "version probe");
        const reportedVersion = (versionProbe.stdout ?? "").trim().replace(/^playwright-cli\s+/i, "");
        if (reportedVersion !== context.release.version) {
          throw new Error(
            `Playwright version probe returned ${reportedVersion || "no version"}; expected ${context.release.version}`,
          );
        }

        const current = loadVerifiedManagedBrowserReceipt(input.stateDir, PLAYWRIGHT_PACKAGE);
        if (
          current === null
          || current.version !== context.release.version
          || current.integrity !== context.release.integrity
          || current.rootPath !== activated.rootPath
        ) {
          throw new Error("Playwright managed receipt does not match the verified release");
        }

        // The persisted observation still describes the previous release.
        // Verify the new receipt and browser directly before the caller
        // advances preferences; the normal doctor intentionally rejects drift.
        const browserCache = isPlaywrightBrowserReady();
        if (browserCache.status !== "ready" || !verifyManagedPlaywrightBrowser(input.stateDir)) {
          throw new Error("Playwright Chromium smoke failed");
        }
        capability = {
          cli: { status: "current", binPath: current.launcherPath, detectedVersion: context.release.version },
          browserCache, browserVerified: true, effective: true,
        };
        observed = {
          version: context.release.version,
          integrity: context.release.integrity,
        };
      },
    });

    if (observed === undefined || capability === undefined) {
      throw new Error("Playwright verified release did not complete activation and smoke");
    }
    return { observed, capability };
  } catch (error) {
    if (activated !== undefined) {
      try {
        await rollbackManagedBrowserActivation(input.stateDir, PLAYWRIGHT_PACKAGE, activated, previous);
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}; Playwright rollback also failed: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  }
}
