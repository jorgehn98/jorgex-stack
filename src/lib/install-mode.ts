import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";
import { readTextIfExists, writeText } from "./fsx.js";
import type { InstallMode, InstallModePreference, SubagentConcurrency } from "../adapters/types.js";

const INSTALL_MODES = new Set<InstallMode>(["human", "programmatic"]);
const SUBAGENT_CONCURRENCIES = new Set<SubagentConcurrency>(["serial", "parallel"]);

export const DEFAULT_INSTALL_MODE_PREFERENCE: InstallModePreference = {
  mode: "human",
  subagentConcurrency: "serial",
};

export function installModePreferenceFile(): string {
  return path.join(dataDir(), "install-mode.json");
}

export function hasInstallModePreference(file = installModePreferenceFile()): boolean {
  return fs.existsSync(file);
}

export function isInstallMode(value: string): value is InstallMode {
  return INSTALL_MODES.has(value as InstallMode);
}

export function isSubagentConcurrency(value: string): value is SubagentConcurrency {
  return SUBAGENT_CONCURRENCIES.has(value as SubagentConcurrency);
}

export function normalizeInstallModePreference(
  value: Partial<InstallModePreference> | null | undefined,
  fallback: InstallModePreference = DEFAULT_INSTALL_MODE_PREFERENCE,
): InstallModePreference {
  if (!value) return fallback;
  const mode = value.mode;
  const subagentConcurrency = value.subagentConcurrency;
  if (!isInstallMode(mode ?? "") || !isSubagentConcurrency(subagentConcurrency ?? "")) {
    return fallback;
  }
  return {
    mode: mode as InstallMode,
    subagentConcurrency: subagentConcurrency as SubagentConcurrency,
  };
}

export function loadInstallModePreference(file = installModePreferenceFile()): InstallModePreference {
  const raw = readTextIfExists(file);
  if (raw === null) return DEFAULT_INSTALL_MODE_PREFERENCE;
  try {
    return normalizeInstallModePreference(JSON.parse(raw) as Partial<InstallModePreference>);
  } catch {
    return DEFAULT_INSTALL_MODE_PREFERENCE;
  }
}

export function saveInstallModePreference(file: string, value: InstallModePreference): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

export function parseInstallModePreferenceFlags(
  mode?: string,
  subagentConcurrency?: string,
): { preference?: InstallModePreference; error?: string } {
  if (mode !== undefined && !isInstallMode(mode)) {
    return { error: `Modo inválido: ${mode}` };
  }
  if (subagentConcurrency !== undefined && !isSubagentConcurrency(subagentConcurrency)) {
    return { error: `Concurrencia de subagentes inválida: ${subagentConcurrency}` };
  }

  if (mode === "human") {
    if (subagentConcurrency !== undefined) {
      return { error: "--subagent-concurrency no se puede usar con --mode human." };
    }
    return { preference: DEFAULT_INSTALL_MODE_PREFERENCE };
  }

  if (mode === "programmatic") {
    return {
      preference: {
        mode,
        subagentConcurrency: subagentConcurrency ?? "serial",
      },
    };
  }

  if (subagentConcurrency !== undefined) {
    return {
      preference: {
        mode: "programmatic",
        subagentConcurrency,
      },
    };
  }

  return {};
}
