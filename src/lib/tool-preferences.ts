import fs from "node:fs";
import path from "node:path";
import type { RuntimeId, SelectableRuntimeId } from "../adapters/types.js";
import { writeText } from "./fsx.js";
import { dataDir } from "./paths.js";

const PLAYWRIGHT_CLI_PREFERENCE_VERSION = 1;
const DEVTOOLS_MCP_PREFERENCE_VERSION = 1;
const PRIMARY_MODEL_OWNERSHIP_VERSION = 1;

export type PlaywrightRuntimeSelection = Partial<Record<SelectableRuntimeId, boolean>>;
type PlaywrightCliPreference =
  | { version: 1; enabled: boolean }
  | { version: 2; enabled: PlaywrightRuntimeSelection };
const PLAYWRIGHT_RUNTIMES: SelectableRuntimeId[] = ["opencode", "claude-code", "codex", "pi"];

interface DevtoolsMcpPreference {
  version: typeof DEVTOOLS_MCP_PREFERENCE_VERSION;
  enabled: Partial<Record<SelectableRuntimeId, boolean>>;
  owned: Partial<Record<RuntimeId, Record<string, true>>>;
}

interface PrimaryModelOwnership {
  version: typeof PRIMARY_MODEL_OWNERSHIP_VERSION;
  owned: Partial<Record<RuntimeId, Record<string, Record<string, true>>>>;
}

function readPreference(file: string): { raw: string | null; errorCode: string | null } {
  try {
    return { raw: fs.readFileSync(file, "utf8"), errorCode: null };
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    return code === "ENOENT" ? { raw: null, errorCode: null } : { raw: null, errorCode: code };
  }
}

export function playwrightCliPreferenceFile(stateDir = dataDir()): string {
  return path.join(stateDir, "playwright-cli.json");
}

function parsePlaywrightCliPreference(raw: string): PlaywrightCliPreference | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (value.version === 1 && typeof value.enabled === "boolean") return { version: 1, enabled: value.enabled };
    if (value.version !== 2 || !isRecord(value.enabled)) return undefined;
    if (Object.entries(value.enabled).some(([runtime, enabled]) =>
      !PLAYWRIGHT_RUNTIMES.includes(runtime as SelectableRuntimeId) || typeof enabled !== "boolean")) return undefined;
    return { version: 2, enabled: value.enabled as PlaywrightRuntimeSelection };
  } catch {
    return undefined;
  }
}

/** Devuelve un remedio concreto sin normalizar ni reescribir la preferencia. */
export function playwrightCliPreferenceError(file = playwrightCliPreferenceFile()): string | null {
  const { raw, errorCode } = readPreference(file);
  if (errorCode !== null) {
    return `Playwright CLI: no se pudo leer la preferencia en ${file} (${errorCode}). Corrige o borra ese archivo antes de reintentar.`;
  }
  if (raw === null || parsePlaywrightCliPreference(raw) !== undefined) return null;
  return `Playwright CLI: preferencia inválida en ${file}. Corrige o borra ese archivo antes de reintentar.`;
}

/** Missing, unreadable, or invalid state is deliberately not an authorization. */
export function loadPlaywrightCliPreference(
  file = playwrightCliPreferenceFile(),
  runtime?: SelectableRuntimeId,
): boolean | undefined {
  const { raw } = readPreference(file);
  const state = raw === null ? undefined : parsePlaywrightCliPreference(raw);
  if (state === undefined) return undefined;
  if (state.version === 1) return state.enabled;
  return runtime === undefined ? Object.values(state.enabled).some(Boolean) : state.enabled[runtime] === true;
}

/** Preserves choices outside the explicit runtime selection and legacy installations. */
export function savePlaywrightCliPreference(
  file: string,
  enabled: boolean,
  selection?: PlaywrightRuntimeSelection,
): void {
  const error = playwrightCliPreferenceError(file);
  if (error !== null) throw new Error(error);
  const { raw } = readPreference(file);
  const previous = raw === null ? undefined : parsePlaywrightCliPreference(raw);
  if (selection === undefined && previous?.version !== 2) {
    writeText(file, JSON.stringify({ version: PLAYWRIGHT_CLI_PREFERENCE_VERSION, enabled }) + "\n");
    return;
  }
  const inherited: PlaywrightRuntimeSelection = previous?.version === 2 ? previous.enabled
    : Object.fromEntries(PLAYWRIGHT_RUNTIMES.map((runtime) => [runtime, previous?.enabled === true]));
  const choices = { ...inherited, ...selection };
  const state = { version: 2, enabled: enabled ? choices : Object.fromEntries(Object.keys(choices).map((runtime) => [runtime, false])) };
  const content = JSON.stringify(state) + "\n";
  if (parsePlaywrightCliPreference(content) === undefined) throw new Error("Playwright CLI: selección de runtimes inválida.");
  writeText(file, content);
}

export function devtoolsMcpPreferenceFile(stateDir = dataDir()): string {
  return path.join(stateDir, "devtools-mcp.json");
}

export function primaryModelOwnershipFile(stateDir = dataDir()): string {
  return path.join(stateDir, "primary-model.json");
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
      if ((!isRuntimeId(runtime) && runtime !== "pi") || typeof selected !== "boolean") return null;
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
  const { raw } = readPreference(file);
  if (raw === null) return empty;

  return parseDevtoolsMcpState(raw) ?? empty;
}

/** Devuelve un remedio concreto sin convertir un estado inválido en defaults. */
export function devtoolsMcpPreferenceError(file = devtoolsMcpPreferenceFile()): string | null {
  const { raw, errorCode } = readPreference(file);
  if (errorCode !== null) {
    return `Chrome DevTools MCP: no se pudo leer la preferencia en ${file} (${errorCode}). Corrige o borra ese archivo antes de reintentar.`;
  }
  if (raw === null || parseDevtoolsMcpState(raw) !== null) return null;
  return `Chrome DevTools MCP: preferencia inválida en ${file}. Corrige o borra ese archivo antes de reintentar.`;
}

function saveDevtoolsMcpState(file: string, state: DevtoolsMcpPreference): void {
  const error = devtoolsMcpPreferenceError(file);
  if (error !== null) throw new Error(error);
  writeText(file, JSON.stringify(state) + "\n");
}

/** Sin una elección válida y explícita, DevTools MCP permanece deshabilitado. */
export function loadDevtoolsMcpPreference(file: string, runtime: SelectableRuntimeId): boolean {
  return loadDevtoolsMcpState(file).enabled[runtime] === true;
}

/** Persiste una selección por runtime sin modificar las elecciones de los demás. */
export function saveDevtoolsMcpPreference(file: string, runtime: SelectableRuntimeId, enabled: boolean): void {
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

function parsePrimaryModelOwnership(raw: string): PrimaryModelOwnership | null {
  try {
    const value = JSON.parse(raw) as Partial<PrimaryModelOwnership>;
    if (!isRecord(value) || value.version !== PRIMARY_MODEL_OWNERSHIP_VERSION || !isRecord(value.owned)) return null;
    const owned: PrimaryModelOwnership["owned"] = {};
    for (const [runtime, configs] of Object.entries(value.owned)) {
      if (!isRuntimeId(runtime) || !isRecord(configs)) return null;
      const markedConfigs: Record<string, Record<string, true>> = {};
      for (const [configDir, fields] of Object.entries(configs)) {
        if (configDir === "" || !isRecord(fields)) return null;
        const markedFields: Record<string, true> = {};
        for (const [field, state] of Object.entries(fields)) {
          if (field === "" || state !== true) return null;
          markedFields[field] = true;
        }
        if (Object.keys(markedFields).length > 0) markedConfigs[configDir] = markedFields;
      }
      if (Object.keys(markedConfigs).length > 0) owned[runtime] = markedConfigs;
    }
    return { version: PRIMARY_MODEL_OWNERSHIP_VERSION, owned };
  } catch {
    return null;
  }
}

function loadPrimaryModelOwnershipState(file: string): PrimaryModelOwnership {
  const empty: PrimaryModelOwnership = { version: PRIMARY_MODEL_OWNERSHIP_VERSION, owned: {} };
  const { raw } = readPreference(file);
  return raw === null ? empty : (parsePrimaryModelOwnership(raw) ?? empty);
}

export function primaryModelOwnershipError(file = primaryModelOwnershipFile()): string | null {
  const { raw, errorCode } = readPreference(file);
  if (errorCode !== null) {
    return `Primary model: no se pudo leer el ownership en ${file} (${errorCode}). Corrige o borra ese archivo antes de reintentar.`;
  }
  if (raw === null || parsePrimaryModelOwnership(raw) !== null) return null;
  return `Primary model: ownership inválido en ${file}. Corrige o borra ese archivo antes de reintentar.`;
}

function primaryModelConfigKey(configDir: string): string {
  const resolved = path.resolve(configDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function loadPrimaryModelOwnership(file: string, runtime: RuntimeId, configDir: string): ReadonlySet<string> {
  const key = primaryModelConfigKey(configDir);
  return new Set(Object.keys(loadPrimaryModelOwnershipState(file).owned[runtime]?.[key] ?? {}));
}

export function savePrimaryModelOwnership(
  file: string,
  runtime: RuntimeId,
  configDir: string,
  field: string,
  owned: boolean,
): void {
  const error = primaryModelOwnershipError(file);
  if (error !== null) throw new Error(error);
  const state = loadPrimaryModelOwnershipState(file);
  const key = primaryModelConfigKey(configDir);
  if (owned) {
    ((state.owned[runtime] ??= {})[key] ??= {})[field] = true;
  } else {
    delete state.owned[runtime]?.[key]?.[field];
    if (state.owned[runtime]?.[key] !== undefined && Object.keys(state.owned[runtime]![key]!).length === 0) {
      delete state.owned[runtime]![key];
    }
    if (state.owned[runtime] !== undefined && Object.keys(state.owned[runtime]).length === 0) delete state.owned[runtime];
  }
  writeText(file, JSON.stringify(state) + "\n");
}

/** Estados inválidos bloquean mutaciones para no reconciliarlos destructivamente. */
export function browserPreferenceErrors(stateDir = dataDir()): string[] {
  return [
    playwrightCliPreferenceError(playwrightCliPreferenceFile(stateDir)),
    devtoolsMcpPreferenceError(devtoolsMcpPreferenceFile(stateDir)),
  ].filter((error): error is string => error !== null);
}
