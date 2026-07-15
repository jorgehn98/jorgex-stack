import path from "node:path";
import type { RuntimeId } from "../adapters/types.js";
import { readTextIfExists, writeText } from "./fsx.js";
import { dataDir } from "./paths.js";

const PLAYWRIGHT_CLI_PREFERENCE_VERSION = 1;
const DEVTOOLS_MCP_PREFERENCE_VERSION = 1;

interface PlaywrightCliPreference {
  version: typeof PLAYWRIGHT_CLI_PREFERENCE_VERSION;
  enabled: boolean;
}

interface DevtoolsMcpPreference {
  version: typeof DEVTOOLS_MCP_PREFERENCE_VERSION;
  enabled: Partial<Record<RuntimeId, boolean>>;
  owned: Partial<Record<RuntimeId, Record<string, true>>>;
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

export function devtoolsMcpPreferenceFile(stateDir = dataDir()): string {
  return path.join(stateDir, "devtools-mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadDevtoolsMcpState(file: string): DevtoolsMcpPreference {
  const empty: DevtoolsMcpPreference = { version: DEVTOOLS_MCP_PREFERENCE_VERSION, enabled: {}, owned: {} };
  const raw = readTextIfExists(file);
  if (raw === null) return empty;

  try {
    const value = JSON.parse(raw) as Partial<DevtoolsMcpPreference>;
    if (value.version !== DEVTOOLS_MCP_PREFERENCE_VERSION || !isRecord(value.enabled)) return empty;
    const enabled = Object.fromEntries(
      Object.entries(value.enabled).filter(([, selected]) => typeof selected === "boolean"),
    ) as Partial<Record<RuntimeId, boolean>>;
    const owned: DevtoolsMcpPreference["owned"] = {};
    if (isRecord(value.owned)) {
      for (const [runtime, servers] of Object.entries(value.owned)) {
        if (!isRecord(servers)) continue;
        const managed = Object.fromEntries(Object.entries(servers).filter(([, marked]) => marked === true)) as Record<string, true>;
        if (Object.keys(managed).length > 0) owned[runtime as RuntimeId] = managed;
      }
    }
    return { version: DEVTOOLS_MCP_PREFERENCE_VERSION, enabled, owned };
  } catch {
    return empty;
  }
}

function saveDevtoolsMcpState(file: string, state: DevtoolsMcpPreference): void {
  writeText(file, JSON.stringify(state) + "\n");
}

/** Sin una elección válida y explícita, DevTools MCP permanece deshabilitado. */
export function loadDevtoolsMcpPreference(file: string, runtime: RuntimeId): boolean {
  return loadDevtoolsMcpState(file).enabled[runtime] === true;
}

/** Persiste una selección por runtime sin modificar las elecciones de los demás. */
export function saveDevtoolsMcpPreference(file: string, runtime: RuntimeId, enabled: boolean): void {
  const state = loadDevtoolsMcpState(file);
  state.enabled[runtime] = enabled;
  saveDevtoolsMcpState(file, state);
}

/** La marca solo autoriza retirar una entrada que el stack creó previamente. */
export function loadDevtoolsMcpOwnership(file: string, runtime: RuntimeId, server: string): boolean {
  return loadDevtoolsMcpState(file).owned[runtime]?.[server] === true;
}

export function saveDevtoolsMcpOwnership(file: string, runtime: RuntimeId, server: string, owned: boolean): void {
  const state = loadDevtoolsMcpState(file);
  if (owned) {
    (state.owned[runtime] ??= {})[server] = true;
  } else {
    delete state.owned[runtime]?.[server];
    if (state.owned[runtime] !== undefined && Object.keys(state.owned[runtime]).length === 0) delete state.owned[runtime];
  }
  saveDevtoolsMcpState(file, state);
}
