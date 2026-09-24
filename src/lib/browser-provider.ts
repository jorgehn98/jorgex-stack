import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  downloadVerifiedNpmPackageTarball,
  resolveLatestNpmPackageRelease,
  type NpmPackageRelease,
} from "./npm-provider.js";

export interface BrowserPackageRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface PrepareVerifiedBrowserReleaseOptions {
  fetchImpl: typeof fetch;
  stageParent?: string;
}

const PLAYWRIGHT_PKG = "@playwright/cli";
const DEVTOOLS_PKG = "chrome-devtools-mcp";

function fail(message: string): never {
  throw new Error(`browser-provider: ${message}`);
}

function asBrowserError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("browser-provider: ")) return error;
  if (error instanceof Error) {
    const detail = error.message.startsWith("npm-provider: ")
      ? error.message.slice("npm-provider: ".length)
      : error.message;
    return new Error(`browser-provider: ${detail}`);
  }
  return new Error(`browser-provider: ${String(error)}`);
}

function assertBrowserPackage(packageName: unknown): asserts packageName is typeof PLAYWRIGHT_PKG | typeof DEVTOOLS_PKG {
  if (packageName !== PLAYWRIGHT_PKG && packageName !== DEVTOOLS_PKG) {
    fail("unknown browser package");
  }
}

function resolveStageParent(stageParent: unknown): string {
  if (stageParent === undefined) return os.tmpdir();
  if (typeof stageParent !== "string" || stageParent === "" || !path.isAbsolute(stageParent)) {
    fail("invalid stage parent");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(stageParent);
  } catch {
    fail("invalid stage parent");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid stage parent");
  return stageParent;
}

/**
 * Shared verified acquisition for browser opt-ins (`@playwright/cli` and
 * `chrome-devtools-mcp`). Resolves the exact stable `dist-tags.latest`
 * candidate via the generic npm provider, then verifies the tarball SRI in
 * a unique private stage under the provided real absolute parent (default
 * `os.tmpdir()`). Returns only the observed `{ version, tarballUrl,
 * integrity }` after verified bytes; the stage is always removed and no
 * other file is mutated nor any package executed.
 */
export async function prepareVerifiedBrowserRelease(
  packageName: string,
  options: PrepareVerifiedBrowserReleaseOptions,
): Promise<BrowserPackageRelease> {
  assertBrowserPackage(packageName);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid options");
  }
  const { fetchImpl, stageParent } = options as PrepareVerifiedBrowserReleaseOptions;
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  const parent = resolveStageParent(stageParent);

  let stageDir: string | null = null;
  try {
    try {
      stageDir = fs.mkdtempSync(path.join(parent, "jorgex-browser-"));
    } catch (error) {
      throw asBrowserError(error);
    }
    try {
      fs.chmodSync(stageDir, 0o700);
    } catch {
      // Best effort; mkdtemp already creates a private directory.
    }

    let release: NpmPackageRelease;
    try {
      release = await resolveLatestNpmPackageRelease(packageName, fetchImpl as typeof fetch);
    } catch (error) {
      throw asBrowserError(error);
    }
    try {
      await downloadVerifiedNpmPackageTarball(
        packageName,
        release,
        path.join(stageDir, "browser-package.tgz"),
        fetchImpl as typeof fetch,
      );
    } catch (error) {
      throw asBrowserError(error);
    }
    return { version: release.version, tarballUrl: release.tarballUrl, integrity: release.integrity };
  } catch (error) {
    throw asBrowserError(error);
  } finally {
    if (stageDir !== null) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the destination was never published outside the stage.
      }
    }
  }
}
