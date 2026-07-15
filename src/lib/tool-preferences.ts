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

function parsePlaywrightCliPreference(raw: string): boolean | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PlaywrightCliPreference>;
    if (value.version !== PLAYWRIGHT_CLI_PREFERENCE_VERSION || typeof value.enabled !== "boolean") return undefined;
    return value.enabled;
  } catch {
    return undefined;
  }
}

/** Devuelve un remedio concreto sin normalizar ni reescribir la preferencia. */
export function playwrightCliPreferenceError(file = playwrightCliPreferenceFile()): string | null {
  const raw = readTextIfExists(file);
  if (raw === null || parsePlaywrightCliPreference(raw) !== undefined) return null;
  return `Playwright CLI: preferencia inválida en ${file}. Corrige o borra ese archivo antes de reintentar.`;
}

/** Missing, unreadable, or invalid state is deliberately not an authorization. */
export function loadPlaywrightCliPreference(file = playwrightCliPreferenceFile()): boolean | undefined {
  const raw = readTextIfExists(file);
  if (raw === null) return undefined;
  return parsePlaywrightCliPreference(raw);
}

/** Stores only an explicit choice, atomically, outside runtime manifests. */
export function savePlaywrightCliPreference(file: string, enabled: boolean): void {
  const error = playwrightCliPreferenceError(file);
  if (error !== null) throw new Error(error);
  writeText(file, JSON.stringify({ version: PLAYWRIGHT_CLI_PREFERENCE_VERSION, enabled }) + "\n");
}

export function devtoolsMcpPreferenceFile(stateDir = dataDir()): string {
  return path.join(stateDir, "devtools-mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeId(value: string): value is RuntimeId {
  return value === "claude-code" || value === "codex" || value === "opencode";
}

function parseDevtoolsMcpState(raw: string): DevtoolsMcpPreference | null {
  try {
    const value = JSON.parse(raw) as Partial<DevtoolsMcpPreference>;
    if (
      !isRecord(value)
      || value.version !== DEVTOOLS_MCP_PREFERENCE_VERSION
      || !isRecord(value.enabled)
      || !isRecord(value.owned)
    ) return null;

    const enabled: DevtoolsMcpPreference["enabled"] = {};
    for (const [runtime, selected] of Object.entries(value.enabled)) {
      if (!isRuntimeId(runtime) || typeof selected !== "boolean") return null;
      enabled[runtime] = selected;
    }

    const owned: DevtoolsMcpPreference["owned"] = {};
    for (const [runtime, servers] of Object.entries(value.owned)) {
      if (!isRuntimeId(runtime) || !isRecord(servers)) return null;
      const managed: Record<string, true> = {};
      for (const [server, marked] of Object.entries(servers)) {
        if (marked !== true) return null;
        managed[server] = true;
      }
      if (Object.keys(managed).length > 0) owned[runtime] = managed;
    }
    return { version: DEVTOOLS_MCP_PREFERENCE_VERSION, enabled, owned };
  } catch {
    return null;
  }
}

function loadDevtoolsMcpState(file: string): DevtoolsMcpPreference {
  const empty: DevtoolsMcpPreference = { version: DEVTOOLS_MCP_PREFERENCE_VERSION, enabled: {}, owned: {} };
  const raw = readTextIfExists(file);
  if (raw === null) return empty;

  return parseDevtoolsMcpState(raw) ?? empty;
}

/** Devuelve un remedio concreto sin convertir un estado inválido en defaults. */
export function devtoolsMcpPreferenceError(file = devtoolsMcpPreferenceFile()): string | null {
  const raw = readTextIfExists(file);
  if (raw === null || parseDevtoolsMcpState(raw) !== null) return null;
  return `Chrome DevTools MCP: preferencia inválida en ${file}. Corrige o borra ese archivo antes de reintentar.`;
}

function saveDevtoolsMcpState(file: string, state: DevtoolsMcpPreference): void {
  const error = devtoolsMcpPreferenceError(file);
  if (error !== null) throw new Error(error);
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

/** Estados inválidos bloquean mutaciones para no reconciliarlos destructivamente. */
export function browserPreferenceErrors(stateDir = dataDir()): string[] {
  return [
    playwrightCliPreferenceError(playwrightCliPreferenceFile(stateDir)),
    devtoolsMcpPreferenceError(devtoolsMcpPreferenceFile(stateDir)),
  ].filter((error): error is string => error !== null);
}
