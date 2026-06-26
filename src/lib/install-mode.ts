import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";
import { writeText } from "./fsx.js";
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
): InstallModePreference {
  if (!value) {
    throw new Error("Preferencia de instalación vacía o corrupta.");
  }
  if (value.mode === "human") {
    if (value.subagentConcurrency !== "serial") {
      throw new Error("Preferencia de instalación inconsistente: human solo puede usar serial.");
    }
    return DEFAULT_INSTALL_MODE_PREFERENCE;
  }

  if (value.mode === "programmatic") {
    const subagentConcurrency = value.subagentConcurrency;
    if (subagentConcurrency === undefined || !isSubagentConcurrency(subagentConcurrency)) {
      throw new Error("Preferencia de instalación inválida o corrupta.");
    }
    return {
      mode: "programmatic",
      subagentConcurrency,
    };
  }

  throw new Error("Preferencia de instalación inválida o corrupta.");
}

export function loadInstallModePreference(file = installModePreferenceFile()): InstallModePreference {
  if (!fs.existsSync(file)) return DEFAULT_INSTALL_MODE_PREFERENCE;
  try {
    const raw = fs.readFileSync(file, "utf8");
    return normalizeInstallModePreference(JSON.parse(raw) as Partial<InstallModePreference>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer la preferencia de instalación en ${file}: ${message}`);
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

  if (subagentConcurrency !== undefined && mode !== "programmatic") {
    return { error: "--subagent-concurrency requiere --mode programmatic." };
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

  return {};
}
