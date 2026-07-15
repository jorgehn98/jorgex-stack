import path from "node:path";
import { readTextIfExists, writeText } from "./fsx.js";
import { dataDir } from "./paths.js";

const PLAYWRIGHT_CLI_PREFERENCE_VERSION = 1;

interface PlaywrightCliPreference {
  version: typeof PLAYWRIGHT_CLI_PREFERENCE_VERSION;
  enabled: boolean;
}

export function playwrightCliPreferenceFile(stateDir = dataDir()): string {
  return path.join(stateDir, "playwright-cli.json");
}

/** Missing, unreadable, or invalid state is deliberately not an authorization. */
export function loadPlaywrightCliPreference(file = playwrightCliPreferenceFile()): boolean | undefined {
  const raw = readTextIfExists(file);
  if (raw === null) return undefined;

  try {
    const value = JSON.parse(raw) as Partial<PlaywrightCliPreference>;
    if (value.version !== PLAYWRIGHT_CLI_PREFERENCE_VERSION || typeof value.enabled !== "boolean") return undefined;
    return value.enabled;
  } catch {
    return undefined;
  }
}

/** Stores only an explicit choice, atomically, outside runtime manifests. */
export function savePlaywrightCliPreference(file: string, enabled: boolean): void {
  writeText(file, JSON.stringify({ version: PLAYWRIGHT_CLI_PREFERENCE_VERSION, enabled }) + "\n");
}
