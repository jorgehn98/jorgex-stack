import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { prepareWritingStyle, applyWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot, type WritingStylePlan } from "./lib/writing-style.js";
import type { Adapter, FileAction, InstallContext, InstallModePreference, OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { HOME, dataDir, samePath, stackRoot } from "./lib/paths.js";
import { detectEngram, engramVersion, opencodeMajorVersion, type RuntimeDetection } from "./lib/detect.js";
import { copyFile, isContainedIn, pruneEmptyDirs, readTextIfExists, sameFileContent, writeText } from "./lib/fsx.js";
import { ensureModelMapFile, loadModelMap, type ModelMap } from "./lib/model-map.js";
import { DEFAULT_INSTALL_MODE_PREFERENCE, installModePreferenceFile, loadInstallModePreference, normalizeInstallModePreference, saveInstallModePreference } from "./lib/install-mode.js";
import { createBackup } from "./lib/backup.js";
import {
  resolveOfficialSetupArgv,
  runOfficialSetup,
  runOfficialSetupIfNeeded,
  shouldRunOfficialSetup,
  validateOfficialSetupDestination,
  type OfficialSetupIfNeededResult,
} from "./lib/official-engram-setup.js";
import { shouldRetireLegacyEngram } from "./adapters/opencode.js";
import { DEVTOOLS_MCP_SERVER, loadCanonicalHooks, loadCanonicalMcp, materializeCanonicalDevtoolsServer, materializeCanonicalDevtoolsServerForRemoval, type CanonicalMcp } from "./lib/canonical.js";
import { findOrphans, readManifest, readManifestStrict, writeRuntimeManifest } from "./lib/manifest.js";
import {
  authenticateStaticResource,
  projectedBytesByTarget,
  staticResourceBlockReason,
  staticResourceTargets,
  unownedCurrentTargets,
  type StaticResourceAuth,
} from "./lib/opencode-static-resources.js";
import { planSystemPrompt } from "./components/system-prompt.js";
import { assertSystemPromptFile } from "./lib/system-prompt-sections.js";
import { planAgents } from "./components/agents.js";
import { planSkills } from "./components/skills.js";
import { planCommands } from "./components/commands.js";
import { planHooks } from "./components/hooks.js";
import { planMcp } from "./components/mcp.js";
import { planPlugins } from "./components/plugins.js";
import {
  executePlaywrightToolAction as executeExternalPlaywrightToolAction,
  resolvePnpmBin,
  resolvePnpmFailureRemedy,
  isPlaywrightBrowserReady,
  setupPnpmGlobal,
  type PlaywrightCliAction,
  type PlaywrightCliCandidate,
  type PnpmSetupResult,
  type PlaywrightToolActionFailureReason,
  type PlaywrightToolActionResult,
} from "./lib/external-tools.js";
import { activateVerifiedBrowserArtifact, prepareVerifiedBrowserRelease } from "./lib/browser-provider.js";
import { loadVerifiedManagedBrowserReceipt, planManagedBrowserInvocation, rollbackManagedBrowserActivation } from "./lib/browser-managed.js";
import type { ManagedBrowserReceipt } from "./lib/browser-managed.js";
import { runVerifiedManagedPlaywright, verifyManagedPlaywrightBrowser } from "./lib/browser-command.js";
import {
  inspectPlaywrightCapability,
  inspectManagedPlaywrightCapability,
  type PlaywrightCapabilitySnapshot,
  type VerifiedPlaywrightCapabilitySnapshot,
} from "./lib/playwright-capability.js";
import {
  browserPreferenceErrors,
  devtoolsMcpPreferenceFile,
  loadDevtoolsMcpObservation,
  loadDevtoolsMcpOwnership,
  loadDevtoolsMcpPreference,
  loadPlaywrightCliPreference,
  type ObservedVersion,
  type PlaywrightRuntimeSelection,
  loadPrimaryModelOwnership,
  playwrightCliPreferenceFile,
  primaryModelOwnershipError,
  primaryModelOwnershipFile,
  saveDevtoolsMcpPreference,
  saveDevtoolsMcpOwnership,
  savePlaywrightCliPreference,
  savePrimaryModelOwnership,
} from "./lib/tool-preferences.js";

/** Coordinador setup oficial re-exportado para el contrato de instalación. */
export { resolveOfficialSetupArgv, shouldRunOfficialSetup, runOfficialSetup };

export const ADAPTERS: Partial<Record<RuntimeId, Adapter>> = {
  opencode: opencodeAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export interface InstallOptions extends OpenCodeTargetEvidenceOption {
  writingStyle?: WritingStyleSnapshot;
  runtimes: RuntimeId[];
  /** Override del dir de config destino (pruebas/paridad). Solo válido con un único runtime. */
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  mode?: InstallModePreference;
  /** Consentimiento explícito para la herramienta global opcional. */
  playwrightToolConsent?: PlaywrightToolConsent;
  /** Seams para verificar el flujo sin ejecutar instalaciones globales. */
  playwrightToolDeps?: PlaywrightToolPlanDeps;
  /** Snapshot de capacidad compartida por el coordinador para este comando. */
  playwrightCapability?: PlaywrightCapabilitySnapshot;
  /** Entrega al coordinador la snapshot posterior a un setup verificado. */
  onPlaywrightCapability?: (snapshot: VerifiedPlaywrightCapabilitySnapshot) => void;
  /** Elecciones explícitas del MCP DevTools para este install; undefined usa el estado persistido. */
  devtoolsMcpSelection?: Partial<Record<RuntimeId, boolean>>;
  /**
   * Observación DevTools inyectada SOLO para el sandbox --target-dir (objeto
   * previamente verificado; se valida con el materializador canónico antes de
   * escribir). --target-dir nunca lee/escribe preferencias reales ni hace fetch.
   */
  devtoolsMcpObservedVersion?: ObservedVersion;
  /** Opt-in para re-aplicar el bloque de permisos gestionados sobre config existente (reemplazo entero con backup; sin flag solo se avisa). */
  upgradePermissions?: boolean;
  /** Binario Engram resuelto por el coordinador; undefined conserva detección local. */
  engramBin?: string | null;
  /** Omite intro/outro cuando el CLI coordina varios runtimes en una sola salida. */
  showSummary?: boolean;
  /** Nombre del comando para el resumen por runtime ("install" por defecto). */
  command?: "install" | "sync";
  /** Recibe el resultado por runtime (ok/failed/skipped/preview) para el resumen coordinado. */
  onRuntimeStatus?: (runtime: string, status: RuntimeSyncStatus) => void;
}

/** Estado por runtime para el resumen final de install/sync. */
export type RuntimeSyncStatus = "ok" | "failed" | "skipped" | "preview";

const RUNTIME_STATUS_LABEL: Record<RuntimeSyncStatus, string> = {
  ok: "al día",
  failed: "falló",
  skipped: "omitido",
  preview: "revisado",
};

/** Una línea de resumen por runtime; solo presentación, no cambia exit codes. */
export function formatRuntimeSummary(
  command: "install" | "sync",
  statuses: ReadonlyArray<{ name: string; status: RuntimeSyncStatus }>,
): string {
  if (statuses.length === 0) return `Resumen ${command}: sin runtimes.`;
  const failed = statuses.filter((s) => s.status === "failed").map((s) => s.name);
  const rest = statuses
    .filter((s) => s.status !== "failed")
    .map((s) => `${s.name} ${RUNTIME_STATUS_LABEL[s.status]}`);
  const head = `Resumen ${command}: ${rest.length > 0 ? rest.join(", ") : "ningún runtime al día"}`;
  return failed.length > 0 ? `${head}; falló en ${failed.join(", ")} — revisa arriba.` : `${head}.`;
}

export type PlaywrightToolAction = Extract<PlaywrightCliAction, "install" | "install-browser" | "remove">;
export type PlaywrightInstallAction = Exclude<PlaywrightToolAction, "remove">;

/** Puente de instalación al ejecutor tipado de external-tools. */
export function executePlaywrightToolAction(
  action: PlaywrightCliAction,
  pnpmBin = resolvePnpmBin(),
  env?: NodeJS.ProcessEnv,
  candidate?: PlaywrightCliCandidate,
): PlaywrightToolActionResult {
  return executeExternalPlaywrightToolAction(action, pnpmBin, env, candidate);
}

export interface PlaywrightToolPlan {
  actions: PlaywrightInstallAction[];
  persistEnabledOnSuccess?: boolean;
}

export interface PlaywrightToolConsent {
  command: "install" | "sync";
  interactive: boolean;
  yes: boolean;
  targetDir: boolean;
  explicitToolSelection: boolean;
  confirmed: boolean;
  runtimeSelection?: PlaywrightRuntimeSelection;
}

export interface PlaywrightToolPlanDeps {
  run: (
    action: PlaywrightInstallAction,
    env?: NodeJS.ProcessEnv,
    candidate?: PlaywrightCliCandidate,
  ) => Promise<boolean | PlaywrightToolActionResult>;
  persistEnabled: (enabled: boolean, observed?: ObservedVersion) => void;
  verify?: (candidate?: PlaywrightCliCandidate) => boolean;
  setupPnpm?: (pnpmBin: string) => PnpmSetupResult;
}

export type PlaywrightToolPlanResult =
  | { ok: true }
  | {
      ok: false;
      failedAction: PlaywrightInstallAction | "verify" | "persist";
      reason?: PlaywrightToolActionFailureReason;
    };

/**
 * Un --yes no autoriza software global nuevo por sí mismo. En modo interactivo
 * la confirmación explícita de la recomendación es el consentimiento; sin TTY
 * hace falta además --playwright. sync y --target-dir nunca instalan herramientas.
 */
export function resolvePlaywrightToolPlan(consent: PlaywrightToolConsent): PlaywrightToolPlan {
  if (consent.command !== "install" || consent.targetDir) return { actions: [] };

  const approved = consent.interactive
    ? (consent.yes ? consent.explicitToolSelection : consent.confirmed)
    : consent.yes && consent.explicitToolSelection;
  return approved
    ? { actions: ["install", "install-browser"], persistEnabledOnSuccess: true }
    : { actions: [] };
}

/** Ejecuta el plan inyectable en orden y solo persiste tras éxito completo. */
export async function runPlaywrightToolPlan(
  plan: PlaywrightToolPlan,
  deps: PlaywrightToolPlanDeps,
  candidate?: PlaywrightCliCandidate,
): Promise<PlaywrightToolPlanResult> {
  for (const action of plan.actions) {
    try {
      const result = await deps.run(action, undefined, candidate);
      if (result === false) return { ok: false, failedAction: action };
      if (result !== true && !result.ok) return { ok: false, failedAction: action, reason: result.reason };
    } catch {
      return { ok: false, failedAction: action };
    }
  }
  if (deps.verify !== undefined) {
    try {
      if (!deps.verify(candidate)) return { ok: false, failedAction: "verify" };
    } catch {
      return { ok: false, failedAction: "verify" };
    }
  }
  if (plan.persistEnabledOnSuccess) {
    try {
      const observed = candidate === undefined
        ? undefined
        : { version: candidate.version, integrity: candidate.integrity };
      deps.persistEnabled(true, observed);
    } catch {
      return { ok: false, failedAction: "persist" };
    }
  }
  return { ok: true };
}

export type PlannedChange = { action: FileAction; status: "create" | "update" | "unchanged" };

function enabledMcpServers(
  runtime: RuntimeId,
  explicitDevtoolsEnabled?: boolean,
  useBrowserPreferences = true,
): ReadonlySet<string> {
  const devtoolsEnabled = explicitDevtoolsEnabled
    ?? (useBrowserPreferences && loadDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), runtime));
  return devtoolsEnabled ? new Set([DEVTOOLS_MCP_SERVER]) : new Set();
}

function ownedMcpServers(runtime: RuntimeId, configDir: string, useBrowserPreferences = true): ReadonlySet<string> {
  if (!useBrowserPreferences) return new Set();
  const file = devtoolsMcpPreferenceFile();
  const marked = [DEVTOOLS_MCP_SERVER, "context7"].filter((server) => loadDevtoolsMcpOwnership(file, runtime, server));
  if (marked.length === 0) return new Set();
  const recordedDir = readManifest().runtimes[runtime]?.configDir;
  if (typeof recordedDir !== "string" || !samePath(recordedDir, configDir)) {
    throw new Error(`${runtime}: MCP ownership configDir no coincide con el perfil actual; se conserva la configuración. Vuelve al perfil anterior o revisa el estado gestionado antes de reintentar.`);
  }
  return new Set(marked);
}

/** El estado de ownership solo avanza tras observar la entrada escrita o ausente. */
function persistConfigurationOwnershipChanges(runtime: RuntimeId, configDir: string, plan: FileAction[]): void {
  const latest = new Map<string, boolean>();
  const primary = new Map<string, boolean>();
  for (const action of plan) {
    if (action.kind !== "write") continue;
    for (const change of action.mcpOwnership ?? []) latest.set(change.server, change.owned);
    for (const change of action.primaryModelOwnership ?? []) primary.set(change.field, change.owned);
  }
  const file = devtoolsMcpPreferenceFile();
  for (const [server, owned] of latest) saveDevtoolsMcpOwnership(file, runtime, server, owned);
  const primaryFile = primaryModelOwnershipFile();
  for (const [field, owned] of primary) savePrimaryModelOwnership(primaryFile, runtime, configDir, field, owned);
}

/** Materializa el canon para unmerge con la misma observación del plan donde exista. */
function canonicalMcpForUnmerge(base: CanonicalMcp, observed?: ObservedVersion): CanonicalMcp {
  const server = base.servers[DEVTOOLS_MCP_SERVER];
  if (server === undefined) return base;
  try {
    const materialized = materializeCanonicalDevtoolsServerForRemoval(server, observed);
    return { servers: { ...base.servers, [DEVTOOLS_MCP_SERVER]: materialized } };
  } catch {
    return base;
  }
}

/** Contexto de instalación para un runtime, o null si no hay model-map. */
export function makeContext(
  adapter: Adapter,
  configDir: string,
  mode: InstallModePreference = DEFAULT_INSTALL_MODE_PREFERENCE,
  useBrowserPreferences = true,
  playwrightCapability?: boolean,
  resolveManagedBrowser = true,
  targetDir?: string,
): InstallContext | null {
  const models = loadModelMap()[adapter.id];
  if (!models) return null;
  const enabled = enabledMcpServers(adapter.id, undefined, useBrowserPreferences);
  const owned = ownedMcpServers(adapter.id, configDir, useBrowserPreferences);
  let devtoolsMcpObservedVersion: ObservedVersion | undefined;
  let devtoolsMcpInvocation: InstallContext["devtoolsMcpInvocation"];
  if (useBrowserPreferences && (enabled.has(DEVTOOLS_MCP_SERVER) || owned.has(DEVTOOLS_MCP_SERVER))) {
    try {
      const persisted = loadDevtoolsMcpObservation(devtoolsMcpPreferenceFile());
      if (persisted !== null) devtoolsMcpObservedVersion = persisted;
    } catch {
      // Sin observación: enable falla cerrado; disable retira el legacy owned exacto.
    }
  }
  if (resolveManagedBrowser && devtoolsMcpObservedVersion !== undefined) {
    const receipt = loadVerifiedManagedBrowserReceipt(dataDir(), "chrome-devtools-mcp");
    if (receipt !== null) {
      if (receipt.version !== devtoolsMcpObservedVersion.version
        || receipt.integrity !== devtoolsMcpObservedVersion.integrity) {
        throw new Error("DevTools: el receipt gestionado no coincide con la observación persistida.");
      }
      devtoolsMcpInvocation = planManagedBrowserInvocation(dataDir(), "chrome-devtools-mcp", [
        "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics",
      ]);
    }
  }
  return {
    stackDir: stackRoot(),
    configDir,
    ...(targetDir === undefined ? {} : { targetDir }),
    mode: mode.mode,
    subagentConcurrency: mode.subagentConcurrency,
    engramBin: detectEngram(),
    models,
    warnings: [],
    enabledMcpServers: enabled,
    ...(devtoolsMcpObservedVersion === undefined ? {} : { devtoolsMcpObservedVersion }),
    ...(devtoolsMcpInvocation === undefined ? {} : { devtoolsMcpInvocation }),
    playwrightCliEnabled: useBrowserPreferences
      && loadPlaywrightCliPreference(playwrightCliPreferenceFile(), adapter.id) === true
      && (playwrightCapability ?? true),
    ownedMcpServers: owned,
    // El ownership verificado es independiente de las preferencias browser: un
    // preflight que no consulta DevTools/Playwright sigue necesitándolo para
    // reconocer la migración legacy propia. Solo el sandbox --target-dir queda
    // aislado del ledger real (raíz de estado confinada ⇒ conjunto vacío).
    ownedPrimaryModelFields: targetDir === undefined
      ? loadPrimaryModelOwnership(primaryModelOwnershipFile(), adapter.id, configDir)
      : new Set(),
  };
}

export function buildContentPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planAgents(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
    ...planHooks(adapter, ctx),
    ...planPlugins(adapter, ctx),
  ];
}

export function buildPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [...planMcp(adapter, ctx), ...buildContentPlan(adapter, ctx)];
}

/** Validate every selected registration before installing files or preferences. */
export function preflightSelectedMcpConfigs(runtimes: readonly RuntimeId[], targetDir?: string): void {
  for (const id of runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) continue;
    const detection = adapter.detect();
    if (targetDir === undefined && !detection.installed) continue;
    const ctx = makeContext(adapter, targetDir ?? detection.configDir, undefined, targetDir === undefined, undefined, false, targetDir);
    if (ctx) planMcp(adapter, { ...ctx, enabledMcpServers: new Set() });
  }
}

export function diffPlan(plan: FileAction[]): PlannedChange[] {
  return plan.map((action) => {
    if (action.kind === "write") {
      const current = readTextIfExists(action.target);
      if (current === null) return { action, status: "create" };
      return { action, status: current === action.content ? "unchanged" : "update" };
    }
    if (!fs.existsSync(action.target)) return { action, status: "create" };
    return { action, status: sameFileContent(action.source, action.target) ? "unchanged" : "update" };
  });
}

function applyChanges(changes: PlannedChange[], onOwnershipWritten?: (action: FileAction) => void): void {
  for (const { action } of changes) {
    if (action.kind === "write") {
      writeText(action.target, action.content);
      if (action.mcpOwnership !== undefined || action.primaryModelOwnership !== undefined) onOwnershipWritten?.(action);
    } else copyFile(action.source, action.target);
  }
}

/**
 * Targets actuales de TODOS los runtimes detectados (no solo los del install
 * en curso): un huérfano solo lo es si ningún plan vivo lo reclama — p.ej.
 * ~/.agents/skills sirve a Codex Y OpenCode. Si algún plan falla (config de
 * usuario ilegible), `complete` es false: con visión parcial NO es seguro
 * borrar huérfanos.
 */
export function collectAllCurrentTargets(
  mode: InstallModePreference = DEFAULT_INSTALL_MODE_PREFERENCE,
  playwrightCapability?: boolean,
): { targets: Set<string>; complete: boolean; warnings: string[] } {
  const targets = new Set<string>();
  let complete = true;
  const warnings: string[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const detection = adapter.detect();
    if (!detection.installed) continue;
    try {
      const ctx = makeContext(adapter, detection.configDir, mode, true, playwrightCapability);
      if (!ctx) {
        complete = false;
        warnings.push(`${adapter.name}: limpieza de huérfanos deshabilitada — falta contexto/model-map instalable para este runtime.`);
        continue;
      }
      for (const action of buildPlan(adapter, ctx)) targets.add(path.resolve(action.target));
    } catch (error) {
      complete = false;
      warnings.push(
        `${adapter.name}: limpieza de huérfanos deshabilitada — no se pudo construir el plan completo (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  return { targets, complete, warnings };
}

/** Ruta legacy OpenCode que el setup oficial reemplaza en la misma ruta. */
function legacyOpencodePluginPath(configDir: string): string {
  return path.resolve(path.join(configDir, "plugins", "engram.ts"));
}

/** Centraliza el setup oficial y conserva el estado de recuperación del rollback. */
async function runOfficialSetupForInstall(args: {
  runtime: RuntimeId;
  configDir: string;
  engramBin: string | null;
  command?: "install" | "sync";
  dryRun: boolean;
  targetDir?: string;
}): Promise<OfficialSetupIfNeededResult> {
  // Solo Claude necesita la comprobación de versión de Engram; Codex/OpenCode son
  // gestionados por el proveedor. Ejecuta `--version` localmente, sin red ni
  // estado personal; un resultado nulo/ilegible falla cerrado en el preflight
  // Claude (binario intacto, antes de targets/backup/spawn).
  let detectedVersion: string | null = null;
  if (args.runtime === "claude-code" && typeof args.engramBin === "string" && args.engramBin !== "") {
    try {
      detectedVersion = engramVersion(args.engramBin);
    } catch {
      detectedVersion = null;
    }
  }
  return runOfficialSetupIfNeeded(args.runtime, {
    command: args.command,
    dryRun: args.dryRun,
    targetDir: args.targetDir,
    engramBin: args.engramBin,
    configDir: args.configDir,
    homeDir: HOME,
    engramVersion: detectedVersion,
    ...(args.runtime === "claude-code"
      ? { isExplicitClaudeConfigDir: process.env.CLAUDE_CONFIG_DIR !== undefined }
      : {}),
  });
}

function formatOfficialFailure(
  adapterName: string,
  official: Extract<OfficialSetupIfNeededResult, { ran: true }>,
): string {
  const detail = official.stderr ?? official.reason ?? "sin detalle";
  if (official.ok) return `${adapterName}: setup oficial Engram ok.`;
  if (official.incompleteRecovery === true) {
    return `${adapterName}: setup oficial Engram falló (${detail}). Recuperación incompleta — revisa el backup ${official.backupId ?? "previo"}.`;
  }
  if (official.recovery === "complete") {
    return `${adapterName}: setup oficial Engram falló (${detail}). Se restauró el backup previo.`;
  }
  return `${adapterName}: setup oficial Engram falló (${detail}).`;
}

/** Major admitido por esta versión de Stack para el runtime `opencode`. */
const OPENCODE_REQUIRED_MAJOR = 2;

/** Evidencia de v2 para el sandbox --target-dir (InstallOptions o env CLI). */
export interface OpenCodePreflightEvidence {
  targetDir?: string;
  targetMajor?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Targets de proyección que el adapter reconoce como Stack-owned mediante
 * inspección en solo lectura del plan canónico actual: contenido (prompt, agentes,
 * skills, comandos, hooks, plugins, scripts), config gestionada y los targets
 * compartidos del unmerge. Es la whitelist estructural source-only: una lista
 * `owned` editable no autentica por sí sola un archivo que el canon no
 * corrobora.
 */
function recognizedOpenCodeOwnedTargets(ctx: InstallContext): Set<string> {
  const recognized = new Set<string>();
  for (const action of buildPlan(opencodeAdapter, ctx)) recognized.add(path.resolve(action.target));
  for (const action of opencodeAdapter.planUnmerge(loadCanonicalMcp(ctx.stackDir), loadCanonicalHooks(ctx.stackDir), ctx)) {
    recognized.add(path.resolve(action.target));
  }
  // Recursos retirados/provistos por el provider (p.ej. plugins/engram.ts):
  // nunca se borran ni se reclaman como proyección v2, pero un manifest que los
  // liste no debe bloquear un sync legítimo.
  const { pluginsDir } = opencodeAdapter.paths(ctx.configDir);
  if (pluginsDir !== null) {
    for (const basename of opencodeAdapter.excludedPluginBasenames ?? []) {
      recognized.add(path.resolve(path.join(pluginsDir, basename)));
    }
  }
  return recognized;
}

/**
 * Un manifest OpenCode existente debe ser legible y coherente antes de
 * cualquier limpieza o write. Frontera source-only: los `owned` deben vivir en
 * las raíces reales del adapter (configDir y skillsDir; HOME completo NO es una
 * raíz de proyección) y ser corroborados por el plan canónico actual. Un
 * recurso retirado sin evidencia corroborable no se autentica por el manifest
 * editable: se preserva y se bloquea con diagnóstico. `pendingOrphans`, si
 * existe, es un array de strings subconjunto de `owned` dentro de la frontera.
 *
 * Se exporta para que `uninstall` exija la misma coherencia del perfil activo
 * antes de dar autoridad a `prevOwned`, sin duplicar la validación.
 */
export function assertOpenCodeManifestCoherence(configDir: string): void {
  const read = readManifestStrict();
  if (read.status === "absent") return;
  if (read.status === "invalid") {
    throw new Error(
      `OpenCode: el manifest gestionado no es legible/coherente (${read.reason}); no se puede acreditar ownership ni configDir. Revisa o restaura el manifest antes de reintentar install/sync.`,
    );
  }
  const entry = read.manifest.runtimes.opencode;
  if (entry === undefined) return;
  if (!isPlainRecord(entry)) {
    throw new Error(
      "OpenCode: la entrada 'opencode' del manifest no es un objeto coherente; se conserva el manifest y no se toca ningún archivo. Revisa o restaura el manifest antes de reintentar install/sync.",
    );
  }
  const recorded = entry.configDir;
  if (typeof recorded !== "string" || recorded === "" || !samePath(recorded, configDir)) {
    throw new Error(
      `OpenCode: el configDir del manifest (${typeof recorded === "string" && recorded !== "" ? recorded : "ausente"}) no coincide con el detectado (${configDir}); se conserva la configuración y no se tocan archivos owned (ownership ambiguo). Vuelve al perfil anterior o revisa el manifest antes de reintentar install/sync.`,
    );
  }
  const owned = entry.owned;
  if (!Array.isArray(owned) || owned.some((file) => typeof file !== "string")) {
    throw new Error(
      "OpenCode: la lista 'owned' del manifest debe contener solo rutas string; no se puede acreditar propiedad y no se muta nada. Revisa o restaura el manifest antes de reintentar install/sync.",
    );
  }

  const { skillsDir } = opencodeAdapter.paths(configDir);
  const roots = [path.resolve(configDir), path.resolve(skillsDir)];
  const inRoots = (file: string): boolean => roots.some((root) => isContainedIn(file, root));
  const outside = (owned as string[]).find((file) => !inRoots(file));
  if (outside !== undefined) {
    throw new Error(
      `OpenCode: el manifest declara un owned fuera de las raíces reales del adapter (${outside}); HOME no es una raíz de proyección y no se limpia nada. Revisa o restaura el manifest antes de reintentar install/sync.`,
    );
  }

  const pending = entry.pendingOrphans;
  if (pending !== undefined) {
    if (!Array.isArray(pending) || pending.some((file) => typeof file !== "string")) {
      throw new Error(
        "OpenCode: 'pendingOrphans' debe ser un array de rutas string coherentes; inventario incoherente y no se muta nada. Revisa o restaura el manifest antes de reintentar install/sync.",
      );
    }
    const ownedSet = new Set((owned as string[]).map((file) => path.resolve(file)));
    const incoherent = (pending as string[]).find((file) => !inRoots(file) || !ownedSet.has(path.resolve(file)));
    if (incoherent !== undefined) {
      throw new Error(
        `OpenCode: 'pendingOrphans' incoherente (${incoherent}); debe ser subconjunto de 'owned' y estar dentro de las raíces del adapter. Revisa o restaura el manifest antes de reintentar install/sync.`,
      );
    }
  }

  const ctx = makeContext(opencodeAdapter, configDir, DEFAULT_INSTALL_MODE_PREFERENCE, false, undefined, false);
  if (ctx === null) {
    if (owned.length > 0) {
      throw new Error(
        "OpenCode: no se pudo corroborar el inventario owned contra el plan canónico (sin contexto/model-map); se conserva sin mutar nada. Ejecuta 'jorgex-stack models --agents opencode' o revisa el manifest antes de reintentar install/sync.",
      );
    }
    return;
  }
  const recognized = recognizedOpenCodeOwnedTargets(ctx);
  const unverified = (owned as string[]).find((file) => !recognized.has(path.resolve(file)));
  if (unverified !== undefined) {
    throw new Error(
      `OpenCode: el manifest declara un recurso owned que el plan canónico actual no corrobora (${unverified}); se preserva y no se limpia (revisión manual antes de reintentar install/sync).`,
    );
  }
}

/**
 * Autenticación de bytes de los cuatro recursos estáticos OpenCode. No sustituye
 * al ownership: el manifest coherente sigue siendo la única autoridad y el
 * digest solo clasifica el contenido (actual/legacy/desconocido) para bloquear
 * o permitir la mutación. Corre antes de writing-style, model-map, backups,
 * proyección y setup.
 */
function openCodeStaticResourceAuths(
  configDir: string,
  actions: readonly FileAction[],
  ownedPaths: readonly string[],
): StaticResourceAuth[] {
  const targets = staticResourceTargets(configDir);
  if (targets.size === 0) return [];
  const bytesByTarget = projectedBytesByTarget(actions);
  const ownedSet = new Set(ownedPaths.map((file) => path.resolve(file)));
  return [...targets].map(([target, row]) =>
    authenticateStaticResource(target, row, bytesByTarget.get(target) ?? null, ownedSet.has(target), configDir));
}

function assertOpenCodeStaticResourcesUsable(auths: readonly StaticResourceAuth[]): void {
  for (const auth of auths) {
    const reason = staticResourceBlockReason(auth);
    if (reason !== null) {
      throw new Error(`OpenCode: ${reason} No se modifica ningún archivo, no se crea backup y el ownership se conserva.`);
    }
  }
}

/**
 * Extiende el preflight común de OpenCode: autentica los bytes de los recursos
 * estáticos además de la coherencia del manifest. Ausencia de contexto no muta
 * nada (el pipeline falla más adelante antes de proyectar).
 */
function assertOpenCodeStaticResourcePreflight(configDir: string): void {
  const ctx = makeContext(opencodeAdapter, configDir, DEFAULT_INSTALL_MODE_PREFERENCE, false, undefined, false);
  if (ctx === null) return;
  const owned = readManifest().runtimes.opencode?.owned ?? [];
  // Solo `buildContentPlan`: la autenticación de bytes no depende del bloque
  // MCP/modelo (cuyo plan puede fallar cerrado por estado legacy legítimo que
  // el pipeline real migra con su ledger de ownership).
  assertOpenCodeStaticResourcesUsable(openCodeStaticResourceAuths(configDir, buildContentPlan(opencodeAdapter, ctx), owned));
}

/**
 * Resuelve la evidencia de major SOLO para --target-dir. Fuera de target no hay
 * canal de evidencia: el gate siempre prueba el binario real. Un valor distinto
 * de "2" o malformado se representa como NaN y bloquea el sandbox.
 */
function resolveOpencodeTargetMajor(evidence: OpenCodePreflightEvidence): number | undefined {
  if (evidence.targetDir === undefined) return undefined;
  if (evidence.targetMajor !== undefined) return evidence.targetMajor;
  const raw = process.env.JORGEX_OPENCODE_TARGET_MAJOR;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim() === "2" ? OPENCODE_REQUIRED_MAJOR : Number.NaN;
}

/** Guardia OpenCode v2 sobre un detection ya resuelto. */
function assertOpenCodeV2Detection(detection: RuntimeDetection, evidence: OpenCodePreflightEvidence): void {
  if (detection.id !== "opencode") return;
  if (evidence.targetDir !== undefined) {
    if (resolveOpencodeTargetMajor(evidence) !== OPENCODE_REQUIRED_MAJOR) {
      throw new Error(
        `OpenCode: --target-dir requiere evidencia explícita de OpenCode v2 (major ${OPENCODE_REQUIRED_MAJOR}); sin ella no se ejecuta el binario personal ni se proyecta el sandbox. Declara JORGEX_OPENCODE_TARGET_MAJOR=${OPENCODE_REQUIRED_MAJOR} o equivalente en InstallOptions.`,
      );
    }
    return;
  }
  if (detection.binPath === null) {
    throw new Error(
      "OpenCode: no se encontró el ejecutable 'opencode' en PATH; Stack solo admite OpenCode v2 (major 2). Instálalo o verifica 'opencode --version' antes de reintentar.",
    );
  }
  const major = opencodeMajorVersion(detection.binPath);
  if (major === null) {
    throw new Error(
      `OpenCode: no se pudo interpretar la versión de ${detection.binPath} al ejecutar '--version' (se exige una única versión completa); verifica el binario antes de reintentar.`,
    );
  }
  if (major !== OPENCODE_REQUIRED_MAJOR) {
    throw new Error(
      `OpenCode: major ${major} detectado en ${detection.binPath}; esta versión de Stack solo admite OpenCode v2 (major 2). Actualiza OpenCode o permanece en una versión anterior de Stack.`,
    );
  }
  assertOpenCodeManifestCoherence(detection.configDir);
  assertOpenCodeStaticResourcePreflight(detection.configDir);
}

/**
 * Guardia común que reutilizan el pipeline (`runInstall`) y el caller CLI antes
 * de `applyWritingStyle`, el model-map o la instalación de Engram: ninguna ruta
 * que mute OpenCode debe escribir antes de acreditar v2 real (o evidencia de
 * target en el sandbox). Sin copia de la lógica entre CLI y pipeline.
 */
export function assertOpenCodeV2Preflight(
  runtimes: readonly RuntimeId[],
  evidence: OpenCodePreflightEvidence = {},
): void {
  if (!runtimes.includes("opencode")) return;
  const adapter = ADAPTERS.opencode;
  if (adapter === undefined) return;
  assertOpenCodeV2Detection(adapter.detect(), evidence);
}

/**
 * OpenCode v2 no ofrece el selector Playwright CLI (Spec T11): el caller CLI ya
 * lo rechaza, pero la API `runInstall` también debe fallar de forma honesta en
 * vez de adquirir Playwright y escribir un AGENTS.md que el runtime ya no
 * ofrece. Un runtime `pi` no es un destino Playwright de este pipeline (vive
 * fuera de `runtimes`), así que la comprobación solo mira los destinos de
 * fichero reales. Devuelve el diagnóstico o `null` si la selección es admisible.
 */
function playwrightSelectionError(opts: InstallOptions): string | null {
  const consent = opts.playwrightToolConsent;
  if (consent === undefined) return null;
  if (consent.runtimeSelection?.opencode === true) {
    return "OpenCode v2 no ofrece Playwright CLI: usa Browser Control (CLI/skill/MCP) obligatorio. Retira la selección Playwright de OpenCode.";
  }
  const targetDir = opts.targetDir !== undefined || consent.targetDir;
  const approved = consent.command === "install" && !targetDir
    && (consent.interactive
      ? (consent.yes ? consent.explicitToolSelection : consent.confirmed)
      : consent.yes && consent.explicitToolSelection);
  if (approved && opts.runtimes.length > 0 && opts.runtimes.every((id) => id === "opencode")) {
    return "OpenCode v2 no ofrece Playwright CLI: usa Browser Control (CLI/skill/MCP) obligatorio; no hay otro runtime elegible para la selección Playwright.";
  }
  return null;
}

export async function runInstall(opts: InstallOptions): Promise<number> {
  const showSummary = opts.showSummary !== false;
  if (showSummary) p.intro(`jorgex-stack ${opts.dryRun ? "install (dry-run)" : "install"}`);

  // Valida las opciones propias del caller antes del gate de entorno: una
  // preferencia interna inconsistente debe rechazarse aunque la máquina no
  // tenga OpenCode v2. Es validación pura, no una escritura.
  const modePreference = opts.mode === undefined
    ? (opts.targetDir === undefined ? loadInstallModePreference() : DEFAULT_INSTALL_MODE_PREFERENCE)
    : normalizeInstallModePreference(opts.mode);

  try {
    // Un consentimiento Playwright que incluya OpenCode v2 se rechaza aquí,
    // antes de adquirir el paquete o escribir cualquier archivo: el selector
    // está retirado y no debe degradar a un skip silencioso.
    const playwrightError = playwrightSelectionError(opts);
    if (playwrightError !== null) throw new Error(playwrightError);
    // Gate OpenCode v2 antes de cualquier escritura (y aunque el runtime no
    // esté detectado): un `--agents opencode` explícito sin binario v2 es
    // error accionable, no un skip que parezca éxito.
    assertOpenCodeV2Preflight(opts.runtimes, { targetDir: opts.targetDir, targetMajor: opts.opencodeTargetMajor });
    for (const id of opts.runtimes) {
      const adapter = ADAPTERS[id];
      if (!adapter) continue;
      const detection = adapter.detect();
      if (opts.targetDir === undefined && !detection.installed) continue;
      assertSystemPromptFile(adapter.paths(opts.targetDir ?? detection.configDir).systemPromptFile, opts.targetDir);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const modelMap: ModelMap = opts.runtimes.length > 0 ? loadModelMap() : {};

  try {
    preflightSelectedMcpConfigs(opts.runtimes, opts.targetDir);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let writingStyle: WritingStyleSnapshot;
  let preparedStyle: WritingStylePlan | undefined;
  try {
    if (opts.writingStyle !== undefined) writingStyle = opts.writingStyle;
    else writingStyle = preparedStyle = prepareWritingStyle(resolveWritingStyleFile({ targetDir: opts.targetDir }), { rootDir: opts.targetDir });
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const stackDir = stackRoot();
  const engramBin = opts.engramBin === undefined ? detectEngram() : opts.engramBin;
  const useManifest = opts.targetDir === undefined;
  const preferenceErrors = useManifest
    ? [...browserPreferenceErrors(), primaryModelOwnershipError()].filter((error): error is string => error !== null)
    : [];
  if (preferenceErrors.length > 0) {
    for (const error of preferenceErrors) p.log.error(error);
    if (showSummary) p.outro("Install cancelado: corrige el estado de configuración indicado arriba antes de reintentar.");
    return 1;
  }
  // T15 verified-provider DevTools opt-in: con selección explícita y comando
  // real, resolver el candidato exacto del proveedor ANTES de cualquier
  // escritura (writing-style, config, ownership o prefs). SRI, metadata y
  // red fallan cerrado sin tocar config/prefs, sin exec ni Chrome.
  // sync/dry-run/target-dir NUNCA resuelven ni descargan.
  const isSyncCommand = opts.command === "sync";
  const isDevtoolsTargetDir = opts.targetDir !== undefined;
  const isDevtoolsDryRun = opts.dryRun === true;
  const isRealDevtoolsInstall = !isSyncCommand && !isDevtoolsDryRun && !isDevtoolsTargetDir;
  let devtoolsPersistedObserved: ObservedVersion | null = null;
  if (useManifest) {
    try {
      devtoolsPersistedObserved = loadDevtoolsMcpObservation(devtoolsMcpPreferenceFile());
    } catch {
      devtoolsPersistedObserved = null;
    }
  }
  let devtoolsVerifiedObserved: ObservedVersion | undefined;
  let devtoolsTargetDirObserved: ObservedVersion | undefined;
  let devtoolsManagedInvocation: InstallContext["devtoolsMcpInvocation"];
  const devtoolsStateDir = opts.targetDir === undefined ? dataDir() : path.join(opts.targetDir, ".jorgex-stack");
  const devtoolsExplicitTrue = opts.runtimes.filter((id) => opts.devtoolsMcpSelection?.[id] === true);
  if (devtoolsExplicitTrue.length > 0) {
    if (isRealDevtoolsInstall) {
      try {
        const pnpmBin = resolvePnpmBin();
        if (pnpmBin === null) throw new Error("pnpm no disponible para preparar el árbol gestionado de DevTools");
        const release = await prepareVerifiedBrowserRelease("chrome-devtools-mcp", {
          fetchImpl: globalThis.fetch,
          withVerifiedArtifact: async (context) => {
            await activateVerifiedBrowserArtifact(context, { stateDir: devtoolsStateDir, pnpmBin, fetchImpl: globalThis.fetch });
          },
        });
        devtoolsVerifiedObserved = { version: release.version, integrity: release.integrity };
        devtoolsManagedInvocation = planManagedBrowserInvocation(devtoolsStateDir, "chrome-devtools-mcp", [
          "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics",
        ]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        p.log.error(`Chrome DevTools MCP: no se pudo verificar el paquete del proveedor (${detail}). Revisa tu conexión y la metadata oficial antes de reintentar; la preferencia no se ha marcado como habilitada.`);
        if (showSummary) p.outro("Install completado con errores (revisa arriba).");
        return 1;
      }
    } else if (isDevtoolsTargetDir) {
      const injected = opts.devtoolsMcpObservedVersion;
      if (injected === undefined) {
        p.log.error(`Chrome DevTools MCP: no hay versión observada inyectada para materializar el servidor habilitado; --target-dir no resuelve ni descarga del proveedor ni lee preferencias reales.`);
        if (showSummary) p.outro("Install completado con errores (revisa arriba).");
        return 1;
      }
      try {
        const canonicalForValidation = loadCanonicalMcp(stackRoot());
        const template = canonicalForValidation.servers[DEVTOOLS_MCP_SERVER];
        if (template === undefined) throw new Error("falta el servidor canónico chrome-devtools.");
        materializeCanonicalDevtoolsServer(template, injected);
        devtoolsTargetDirObserved = { version: injected.version, integrity: injected.integrity };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        p.log.error(`Chrome DevTools MCP: observación inyectada inválida para --target-dir (${detail}).`);
        if (showSummary) p.outro("Install completado con errores (revisa arriba).");
        return 1;
      }
    } else if (devtoolsPersistedObserved === null) {
      const modeLabel = isSyncCommand ? "sync" : "dry-run";
      p.log.error(`Chrome DevTools MCP: no hay versión observada verificada para materializar el servidor habilitado; ${modeLabel} no resuelve ni descarga del proveedor. Ejecuta 'jorgex-stack install --devtools' para verificar y registrar la versión observada.`);
      if (showSummary) p.outro("Install completado con errores (revisa arriba).");
      return 1;
    }
  }
  const anyDevtoolsEnabled = opts.runtimes.some((id) =>
    enabledMcpServers(id, opts.devtoolsMcpSelection?.[id], useManifest).has(DEVTOOLS_MCP_SERVER));
  const anyDevtoolsOwned = useManifest && opts.runtimes.some((id) => {
    const adapter = ADAPTERS[id];
    if (adapter === undefined) return false;
    const detection = adapter.detect();
    return detection.installed
      && ownedMcpServers(id, detection.configDir, true).has(DEVTOOLS_MCP_SERVER);
  });
  if (anyDevtoolsEnabled && devtoolsManagedInvocation === undefined) {
    const observed = isDevtoolsTargetDir ? devtoolsTargetDirObserved : devtoolsPersistedObserved;
    try {
      const receipt = loadVerifiedManagedBrowserReceipt(devtoolsStateDir, "chrome-devtools-mcp");
      if (receipt === null || observed === undefined || observed === null
        || receipt.version !== observed.version || receipt.integrity !== observed.integrity) {
        throw new Error("falta un receipt DevTools activo que coincida con la versión e integridad observadas");
      }
      devtoolsManagedInvocation = planManagedBrowserInvocation(devtoolsStateDir, "chrome-devtools-mcp", [
        "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics",
      ]);
    } catch (error) {
      p.log.error(`Chrome DevTools MCP: estado gestionado inválido (${error instanceof Error ? error.message : String(error)}). No se usará dlx.`);
      return 1;
    }
  }
  if (!anyDevtoolsEnabled && anyDevtoolsOwned && devtoolsPersistedObserved !== null) {
    try {
      const receipt = loadVerifiedManagedBrowserReceipt(devtoolsStateDir, "chrome-devtools-mcp");
      if (receipt !== null) {
        if (receipt.version !== devtoolsPersistedObserved.version
          || receipt.integrity !== devtoolsPersistedObserved.integrity) {
          throw new Error("el receipt DevTools no coincide con la observación owned");
        }
        devtoolsManagedInvocation = planManagedBrowserInvocation(devtoolsStateDir, "chrome-devtools-mcp", [
          "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics",
        ]);
      }
    } catch (error) {
      p.log.error(`Chrome DevTools MCP: no se puede retirar una entrada managed sin validar ownership (${error instanceof Error ? error.message : String(error)}).`);
      return 1;
    }
  }
  const toolPlan = opts.playwrightToolConsent === undefined
    ? null
    : resolvePlaywrightToolPlan({
      ...opts.playwrightToolConsent,
      targetDir: opts.targetDir !== undefined || opts.playwrightToolConsent.targetDir,
    });
  const projectPlaywrightPrompt = opts.dryRun && toolPlan?.persistEnabledOnSuccess === true;
  const hasFileRuntimes = opts.runtimes.length > 0;
  const shouldInspectPlaywright = useManifest
    && !opts.dryRun
    && (toolPlan === null || toolPlan.actions.length === 0)
    && loadPlaywrightCliPreference() === true;
  const playwrightCapability = opts.dryRun || !useManifest
    ? undefined
    : opts.playwrightCapability ?? (shouldInspectPlaywright ? inspectManagedPlaywrightCapability() : undefined);
  const effectivePlaywright = playwrightCapability?.effective;
  const plannedPlaywright = effectivePlaywright
    ?? (toolPlan !== null && toolPlan.actions.length > 0 ? false : undefined);
  if (preparedStyle !== undefined) {
    try {
      p.log.info(`Estilo de escritura: ${preparedStyle.sourcePath}${opts.dryRun ? " (instalación prevista; sin escrituras)" : ""}.`);
      applyWritingStyle(preparedStyle, opts.dryRun);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (hasFileRuntimes && useManifest && !opts.dryRun) ensureModelMapFile();

  p.log.info(engramBin ? `Engram detectado: ${engramBin} (se respeta, D7)` : "Engram NO detectado.");

  // El manifest solo aplica a instalaciones reales; --target-dir es de pruebas.
  const current = hasFileRuntimes && useManifest
    ? collectAllCurrentTargets(modePreference, plannedPlaywright)
    : { targets: new Set<string>(), complete: false, warnings: [] as string[] };
  const canOrphan = hasFileRuntimes && useManifest && current.complete;
  const canonicalMcp = loadCanonicalMcp(stackDir);
  const canonicalHooks = loadCanonicalHooks(stackDir);

  if (hasFileRuntimes && useManifest && (!current.complete || current.warnings.length > 0)) {
    p.log.warn("Limpieza de huérfanos deshabilitada: no se pudo construir el plan completo de todos los runtimes.");
    for (const warning of current.warnings) p.log.warn(warning);
  }

  let exitCode = 0;
  let successfulRuns = 0;
  const successfulContexts: { adapter: Adapter; ctx: InstallContext }[] = [];
  const runtimeStatuses: { name: string; status: RuntimeSyncStatus }[] = [];
  const reportStatus = (name: string, status: RuntimeSyncStatus): void => {
    runtimeStatuses.push({ name, status });
    opts.onRuntimeStatus?.(name, status);
  };
  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) {
      p.log.warn(`${id}: adapter pendiente (F3/F4) — omitido.`);
      reportStatus(id, "skipped");
      continue;
    }

    const detection = adapter.detect();
    const configDir = opts.targetDir ?? detection.configDir;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado en esta máquina — omitido.`);
      reportStatus(adapter.name, "skipped");
      continue;
    }
    const models = modelMap[id];
    if (!models) {
      p.log.error(`${adapter.name}: sin modelos seleccionados — ejecuta 'jorgex-stack models --agents ${id}'.`);
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      continue;
    }

    // Preflight del destino antes de construir/aplicar planes: una config
    // Codex custom falla aquí sin escrituras ni setup/verifier. Los skips
    // intencionales de sync/dry-run/target-dir no llegan a esta puerta.
    if (shouldRunOfficialSetup({ command: opts.command, dryRun: opts.dryRun, targetDir: opts.targetDir })) {
      const destinationError = validateOfficialSetupDestination(id, configDir, HOME);
      if (destinationError !== null) {
        p.log.error(`${adapter.name}: ${destinationError}`);
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        continue;
      }
    }

    const enabledForRuntime = enabledMcpServers(id, opts.devtoolsMcpSelection?.[id], useManifest);
    const ownedForRuntime = ownedMcpServers(id, configDir, useManifest);
    let devtoolsObservedForRuntime: ObservedVersion | undefined;
    if (isDevtoolsTargetDir) {
      if (enabledForRuntime.has(DEVTOOLS_MCP_SERVER)) {
        devtoolsObservedForRuntime = devtoolsTargetDirObserved;
      }
    } else if (enabledForRuntime.has(DEVTOOLS_MCP_SERVER)) {
      const explicitSelection = opts.devtoolsMcpSelection?.[id];
      if (explicitSelection === true) {
        devtoolsObservedForRuntime = isRealDevtoolsInstall
          ? devtoolsVerifiedObserved
          : (devtoolsPersistedObserved ?? undefined);
      } else if (explicitSelection === undefined && useManifest && devtoolsPersistedObserved !== null) {
        devtoolsObservedForRuntime = devtoolsPersistedObserved;
      }
    } else if (useManifest && ownedForRuntime.has(DEVTOOLS_MCP_SERVER) && devtoolsPersistedObserved !== null) {
      devtoolsObservedForRuntime = devtoolsPersistedObserved;
    }
    const ctx: InstallContext = {
      writingStyle,
      stackDir,
      configDir,
      ...(opts.targetDir === undefined ? {} : { targetDir: opts.targetDir }),
      mode: modePreference.mode,
      subagentConcurrency: modePreference.subagentConcurrency,
      engramBin,
      models,
      warnings: [],
      upgradePermissions: opts.upgradePermissions === true,
      enabledMcpServers: enabledForRuntime,
      ...(devtoolsObservedForRuntime === undefined ? {} : { devtoolsMcpObservedVersion: devtoolsObservedForRuntime }),
      ...((enabledForRuntime.has(DEVTOOLS_MCP_SERVER) || ownedForRuntime.has(DEVTOOLS_MCP_SERVER))
        && devtoolsManagedInvocation !== undefined
        ? { devtoolsMcpInvocation: devtoolsManagedInvocation } : {}),
      playwrightCliEnabled: projectPlaywrightPrompt
        ? (opts.playwrightToolConsent?.runtimeSelection?.[id] ?? true)
        : (useManifest && loadPlaywrightCliPreference(playwrightCliPreferenceFile(), id) === true
          && (plannedPlaywright ?? true)),
      ownedMcpServers: ownedForRuntime,
      ownedPrimaryModelFields: useManifest
        ? loadPrimaryModelOwnership(primaryModelOwnershipFile(), id, configDir)
        : new Set(),
    };

    const persistDevtoolsSelection = (): void => {
      const selection = opts.devtoolsMcpSelection?.[id];
      if (useManifest && selection !== undefined) {
        const observed = ctx.devtoolsMcpObservedVersion;
        if (selection === true && observed !== undefined) {
          saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), id, selection, observed);
        } else {
          saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), id, selection);
        }
      }
    };

    let plan = buildPlan(adapter, ctx);
    let diff = diffPlan(plan);
    let creates = diff.filter((d) => d.status === "create");
    let updates = diff.filter((d) => d.status === "update");
    let changes = diff.filter((change) => change.status !== "unchanged");

    // Huérfanos: archivos que una versión anterior instaló y el plan actual ya
    // no genera (skill renombrada/eliminada). Solo con manifest previo y visión
    // completa de los planes de todos los runtimes.
    const prevManifest = useManifest ? readManifest().runtimes[id] : undefined;
    const orphans = canOrphan && prevManifest ? findOrphans(prevManifest.owned, current.targets) : [];

    // Autenticación de bytes de los recursos estáticos OpenCode antes de
    // cualquier backup/escritura/claim. `preservedStaticTargets` son los
    // unowned ya idénticos al actual: no-op permitido, jamás reclamados.
    const staticAuths = id === "opencode"
      ? openCodeStaticResourceAuths(configDir, plan, prevManifest?.owned ?? [])
      : [];
    let preservedStaticTargets = unownedCurrentTargets(staticAuths);
    try {
      assertOpenCodeStaticResourcesUsable(staticAuths);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      continue;
    }

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(
      `${diff.length} archivos gestionados: ${creates.length} nuevos, ${updates.length} modificados, ${diff.length - changes.length} sin cambios`,
    );
    if (orphans.length > 0) p.log.info(`${orphans.length} huérfanos de versiones previas a eliminar`);
    for (const w of ctx.warnings) p.log.warn(w);

    if (opts.dryRun) {
      const preview = changes.slice(0, 40);
      const projectedPrompt = projectPlaywrightPrompt
        ? changes.find((change) => change.action.target === adapter.paths(configDir).systemPromptFile)
        : undefined;
      if (projectedPrompt && !preview.includes(projectedPrompt)) preview.push(projectedPrompt);
      for (const c of preview) p.log.message(`  ${c.status === "create" ? "+" : "~"} ${c.action.target}`);
      if (changes.length > preview.length) p.log.message(`  … y ${changes.length - preview.length} más`);
      for (const o of orphans) p.log.message(`  - ${o}`);
      reportStatus(adapter.name, "preview");
      continue;
    }

    const writeManifest = async (
      official?: OfficialSetupIfNeededResult,
      opts?: { keepPendingOrphans?: string[] },
    ): Promise<void> => {
      if (!useManifest) return;
      const unmergeTargets = new Set(adapter.planUnmerge(canonicalMcpForUnmerge(canonicalMcp, ctx.devtoolsMcpObservedVersion), canonicalHooks, ctx).map((a) => path.resolve(a.target)));
      const keepTarget = (target: string): boolean => !unmergeTargets.has(target) && !preservedStaticTargets.has(target);
      const liveOwned = plan.map((a) => path.resolve(a.target)).filter(keepTarget);
      const previousOwned = (prevManifest?.owned ?? []).map((target) => path.resolve(target)).filter(keepTarget);
      const officialFailed = official?.ran === true && !official.ok;
      let owned: string[];
      let pendingOrphans: string[];
      if (!canOrphan) {
        owned = [...new Set([...previousOwned, ...liveOwned])];
        pendingOrphans = [];
      } else if (officialFailed) {
        // Setup fallido: esta pasada no poda huérfanos; se conserva todo lo
        // previo junto a lo vivo y se deja el borrado para una pasada futura.
        owned = [...new Set([...previousOwned, ...liveOwned])];
        pendingOrphans = [...orphans];
      } else {
        const keepPending = (opts?.keepPendingOrphans ?? []).map((t) => path.resolve(t));
        owned = [...liveOwned];
        // Legacy OpenCode: nunca huérfano ni ownership drop sin reemplazo
        // oficial verificado. sync/dry-run/target-dir nunca hacen setup y
        // preservan; en install real solo se retira tras transferencia
        // verificada (el archivo oficial queda en disco).
        if (id === "opencode") {
          const legacy = legacyOpencodePluginPath(configDir);
          if (previousOwned.includes(legacy)) {
            // existsSync no distingue ausencia de ilegible: statSync sí.
            // ENOENT = ausente (sin ownership que retener); otro error =
            // desconocido → fail-closed, se retiene.
            let state: "present" | "absent" | "unknown" = "unknown";
            try {
              fs.statSync(legacy);
              state = "present";
            } catch (error) {
              const code = error instanceof Error && "code" in error
                ? (error as NodeJS.ErrnoException).code
                : undefined;
              state = code === "ENOENT" ? "absent" : "unknown";
            }
            if (state !== "absent") {
              let retire = false;
              if (state === "present" && official?.ran === true && official.ok && official.ownershipTransferred) {
                try {
                  retire = (await shouldRetireLegacyEngram({ configDir })).retire;
                } catch {
                  retire = false;
                }
              }
              if (!retire && !owned.includes(legacy)) owned.push(legacy);
            }
          }
        }
        for (const pending of keepPending) {
          if (!owned.includes(pending)) owned.push(pending);
        }
        owned = [...new Set(owned)];
        pendingOrphans = [...keepPending];
      }
      writeRuntimeManifest(id, { configDir, owned, pendingOrphans, updatedAt: new Date().toISOString() });
    };

    if (changes.length === 0 && orphans.length === 0) {
      if (useManifest) persistConfigurationOwnershipChanges(id, configDir, plan);
      persistDevtoolsSelection();
      // El setup oficial solo corre en install real; skips intencionales
      // (sync/dry-run/target-dir) preservan legacy.
      const official = await runOfficialSetupForInstall({
        runtime: id,
        configDir,
        engramBin,
        command: opts.command,
        dryRun: opts.dryRun,
        targetDir: opts.targetDir,
      });
      if (official.ran && !official.ok) {
        await writeManifest(official);
        p.log.error(formatOfficialFailure(adapter.name, official));
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        continue;
      }
      await writeManifest(official.ran ? official : undefined);
      p.log.success(`${adapter.name}: ya al día (idempotente).`);
      successfulRuns++;
      successfulContexts.push({ adapter, ctx });
      reportStatus(adapter.name, "ok");
      continue;
    }

    if (!opts.yes && process.stdout.isTTY) {
      const orphanNote = orphans.length > 0 ? ` (+ ${orphans.length} huérfanos a eliminar)` : "";
      const ok = await p.confirm({ message: `¿Aplicar ${changes.length} cambios en ${adapter.name}?${orphanNote}` });
      if (p.isCancel(ok) || !ok) {
        p.log.warn(`${adapter.name}: omitido por el usuario.`);
        reportStatus(adapter.name, "skipped");
        continue;
      }
      // La confirmación puede quedar abierta un buen rato: re-planificar para
      // no pisar lo que el runtime escribiera entremedias (p.ej. ~/.claude.json).
      plan = buildPlan(adapter, { ...ctx, warnings: [] });
      diff = diffPlan(plan);
      creates = diff.filter((d) => d.status === "create");
      updates = diff.filter((d) => d.status === "update");
      changes = diff.filter((change) => change.status !== "unchanged");
    }

    if (id === "opencode") {
      try {
        // Autenticación FINAL (post-reconfirmación) que usa `writeManifest`: una
        // creación ajena current durante el prompt debe ser un no-op unowned y
        // no un owned reclamado por la lista cacheada anterior al prompt.
        const finalStaticAuths = openCodeStaticResourceAuths(configDir, plan, prevManifest?.owned ?? []);
        assertOpenCodeStaticResourcesUsable(finalStaticAuths);
        preservedStaticTargets = unownedCurrentTargets(finalStaticAuths);
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        continue;
      }
    }

    const backup = useManifest ? createBackup([...updates.map((c) => c.action.target), ...orphans], `install-${id}`) : null;
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    applyChanges(changes, useManifest ? (action) => persistConfigurationOwnershipChanges(id, configDir, [action]) : undefined);

    // Verificación de idempotencia: re-planificar debe dar cero cambios.
    // Huérfanos diferidos hasta verificación oficial (nada irreversible
    // antes del setup).
    const verifiedOwnedMcpServers = new Set(ctx.ownedMcpServers ?? []);
    for (const action of plan) {
      if (action.kind !== "write") continue;
      for (const change of action.mcpOwnership ?? []) {
        if (change.owned) verifiedOwnedMcpServers.add(change.server);
        else verifiedOwnedMcpServers.delete(change.server);
      }
    }
    const verifyCtx: InstallContext = { ...ctx, warnings: [], ownedMcpServers: verifiedOwnedMcpServers };
    const dirty = diffPlan(buildPlan(adapter, verifyCtx)).filter((d) => d.status !== "unchanged");
    if (dirty.length > 0) {
      p.log.error(`${adapter.name}: verificación de idempotencia FALLÓ (${dirty.length} acciones inestables).`);
      for (const d of dirty.slice(0, 10)) p.log.message(`  ! ${d.action.target}`);
      exitCode = 1;
      reportStatus(adapter.name, "failed");
    } else {
      if (useManifest) persistConfigurationOwnershipChanges(id, configDir, plan);
      persistDevtoolsSelection();
      // El setup oficial corre tras los archivos Stack (backup post-Stack; el
      // restore conserva lo escrito por el Stack). Skips intencionales
      // preservan legacy.
      const official = await runOfficialSetupForInstall({
        runtime: id,
        configDir,
        engramBin,
        command: opts.command,
        dryRun: opts.dryRun,
        targetDir: opts.targetDir,
      });
      if (official.ran && !official.ok) {
        await writeManifest(official);
        p.log.error(formatOfficialFailure(adapter.name, official));
        exitCode = 1;
        reportStatus(adapter.name, "failed");
      } else {
        const pruneRoot = useManifest ? HOME : path.dirname(configDir);
        let orphanFailed: string | null = null;
        let failedIndex: number | null = null;
        for (let index = 0; index < orphans.length; index++) {
          const orphan = orphans[index]!;
          if (path.basename(orphan) === "engram.ts") continue;
          try {
            fs.rmSync(orphan, { force: true });
            pruneEmptyDirs(orphan, pruneRoot);
          } catch (error) {
            orphanFailed = `${orphan} (${error instanceof Error ? error.message : String(error)})`;
            failedIndex = index;
            break;
          }
        }
        if (orphanFailed !== null) {
          // Solo lo borrado con éxito sale de pendientes; el fallido y los
          // posteriores se conservan en owned y pendingOrphans.
          const keepPending = failedIndex === null ? [...orphans] : orphans.slice(failedIndex);
          await writeManifest(official.ran ? official : undefined, { keepPendingOrphans: keepPending });
          p.log.error(`${adapter.name}: no se pudo eliminar huérfano ${orphanFailed} — se conserva y no se reporta éxito.`);
          exitCode = 1;
          reportStatus(adapter.name, "failed");
        } else {
          await writeManifest(official.ran ? official : undefined);
          p.log.success(`${adapter.name}: ${changes.length} archivos aplicados y verificados (idempotente).`);
          successfulRuns++;
          successfulContexts.push({ adapter, ctx });
          reportStatus(adapter.name, "ok");
        }
      }
    }
  }

  if (toolPlan?.actions.length) {
    if (opts.dryRun) {
      p.log.info("Playwright CLI: árbol gestionado y Chromium previstos (dry-run; no se ejecutan).");
    } else if (exitCode === 0) {
      // T15 verified-provider: con opt-in explícito y comando real, resolver
      // el candidato exacto del proveedor antes de cualquier árbol managed o
      // escritura de preferencia. Composición compartida con stage aislado
      // en os.tmpdir, sin mutar HOME/Engram antes de verificar; SRI,
      // metadata y red fallan cerrado.
      type PlaywrightCliCandidateWithArtifact = PlaywrightCliCandidate & { artifactPath: string };
      let candidate: PlaywrightCliCandidateWithArtifact | undefined;
      let setupAttempted = false;
      let preparedEnv: NodeJS.ProcessEnv | undefined;
      let verifiedCapability: VerifiedPlaywrightCapabilitySnapshot | undefined;
      let managedReceipt: ManagedBrowserReceipt | undefined;
      let previousManagedReceipt: ManagedBrowserReceipt | null | undefined;
      const hasInjectedActivation = opts.playwrightToolDeps !== undefined;
      const rollbackFailedActivation = async (): Promise<void> => {
        if (hasInjectedActivation || managedReceipt === undefined || previousManagedReceipt === undefined) return;
        try {
          await rollbackManagedBrowserActivation(dataDir(), "@playwright/cli", managedReceipt, previousManagedReceipt);
        } catch (error) {
          p.log.error(`Playwright CLI: rollback del release gestionado incompleto (${error instanceof Error ? error.message : String(error)}). Revisa el receipt y el backup antes de reintentar.`);
        }
      };
      const baseDeps: PlaywrightToolPlanDeps = opts.playwrightToolDeps ?? {
        run: async (action) => {
          if (managedReceipt === undefined) return { ok: false, reason: "action-failed" as const };
          if (action === "install") return { ok: true };
          const result = runVerifiedManagedPlaywright(dataDir(), ["install-browser", "chromium"], { timeoutMs: 600_000 });
          return result.status === 0 && result.error === undefined
            ? { ok: true }
            : { ok: false, reason: "action-failed" as const };
        },
        persistEnabled: (enabled: boolean, observed?: ObservedVersion) => {
          const selected = opts.playwrightToolConsent?.runtimeSelection;
          const fileSelection = selected === undefined ? undefined
            : Object.fromEntries(Object.entries(selected).filter(([runtime]) => runtime !== "pi"));
          savePlaywrightCliPreference(playwrightCliPreferenceFile(), enabled, fileSelection, observed);
        },
        verify: (selected?: PlaywrightCliCandidate) => {
          if (selected === undefined || managedReceipt === undefined
            || managedReceipt.version !== selected.version || managedReceipt.integrity !== selected.integrity) return false;
          const current = loadVerifiedManagedBrowserReceipt(dataDir(), "@playwright/cli");
          if (current === null || current.rootPath !== managedReceipt.rootPath) return false;
          const version = runVerifiedManagedPlaywright(dataDir(), ["--version"], { captureOutput: true, timeoutMs: 5_000 });
          const reported = (version.stdout ?? "").trim().replace(/^playwright-cli\s+/i, "");
          const browserCache = isPlaywrightBrowserReady();
          if (version.error !== undefined || version.status !== 0 || reported !== selected.version
            || browserCache.status !== "ready" || !verifyManagedPlaywrightBrowser(dataDir())) return false;
          verifiedCapability = {
            cli: { status: "current", binPath: current.launcherPath, detectedVersion: selected.version },
            browserCache, browserVerified: true, effective: true,
          };
          return true;
        },
      };
      const activateVerifiedArtifact = async (
        runCandidate?: PlaywrightCliCandidate,
      ): Promise<PlaywrightToolPlanResult> => runPlaywrightToolPlan(toolPlan, {
        ...baseDeps,
        run: async (action, _env?, candidateForRun?) => {
          const first = await baseDeps.run(action, preparedEnv, candidateForRun);
          if (first === true || first === false || first.ok || first.reason !== "pnpm-global-bin") return first;
          if (setupAttempted || opts.dryRun || opts.targetDir !== undefined) return first;
          const consent = opts.playwrightToolConsent;
          const canAskForSetup = consent?.interactive === true && !opts.yes;
          if (!canAskForSetup) return first;
          setupAttempted = true;
          const accepted = await p.confirm({
            message: "pnpm no tiene directorio global. ¿Ejecutar 'pnpm setup' ahora? Esto modificará la configuración de tu shell.",
            initialValue: false,
          });
          if (p.isCancel(accepted) || !accepted) return first;
          const pnpmBin = resolvePnpmBin();
          if (pnpmBin === null) return first;
          const setup = baseDeps.setupPnpm?.(pnpmBin) ?? setupPnpmGlobal(pnpmBin);
          if (!setup.ok) {
            p.log.error(`pnpm setup falló: ${setup.reason}`);
            return first;
          }
          preparedEnv = setup.env;
          p.log.info("pnpm preparado para esta instalación. Abre una terminal nueva al terminar para que otras herramientas y doctor reciban el PATH actualizado.");
          return baseDeps.run(action, preparedEnv, candidateForRun);
        },
      }, runCandidate);
      let activationResult: PlaywrightToolPlanResult | undefined;
      try {
        await prepareVerifiedBrowserRelease("@playwright/cli", {
          fetchImpl: fetch,
          // The stage is a short-lived lease: activation runs before this
          // helper returns and before its finally block removes the tarball.
          withVerifiedArtifact: async (context) => {
            const { release, artifactPath } = context;
            candidate = { version: release.version, tarballUrl: release.tarballUrl, integrity: release.integrity, artifactPath };
            if (!hasInjectedActivation) {
              const pnpmBin = resolvePnpmBin();
              if (pnpmBin === null) throw new Error("pnpm no disponible para preparar Playwright gestionado");
              previousManagedReceipt = loadVerifiedManagedBrowserReceipt(dataDir(), "@playwright/cli");
              managedReceipt = await activateVerifiedBrowserArtifact(context, {
                stateDir: dataDir(), pnpmBin, fetchImpl: fetch,
              });
            }
            activationResult = await activateVerifiedArtifact(candidate);
          },
        });
        if (candidate === undefined || activationResult === undefined) {
          throw new Error("no se ejecutó la activación del artefacto verificado");
        }
      } catch (error) {
        await rollbackFailedActivation();
        const detail = error instanceof Error ? error.message : String(error);
        p.log.error(`Playwright CLI: no se pudo verificar o activar el paquete del proveedor (${detail}). Revisa el diagnóstico antes de reintentar; la nueva versión no se confirmó. Ejecuta 'jorgex-stack install --playwright' para reintentar.`);
        exitCode = 1;
      }
      if (candidate !== undefined && activationResult !== undefined) {
        const result = activationResult;
        if (!result.ok) {
          await rollbackFailedActivation();
          const pnpmRemedy = result.reason === undefined ? null : resolvePnpmFailureRemedy(result.reason);
          let reason: string;
          if (result.reason === "pnpm-global-bin") reason = `la configuración global de pnpm no está lista. ${pnpmRemedy}`;
          else if (result.failedAction === "verify") reason = "el CLI gestionado no coincide con el receipt verificado o Chromium no ha arrancado";
          else reason = pnpmRemedy ?? (result.failedAction === "install"
            ? "no se pudo preparar el paquete gestionado"
            : result.failedAction === "install-browser"
              ? "no se pudo descargar el navegador"
              : "se instalaron los componentes, pero no se pudo guardar la preferencia");
          p.log.error(`Playwright CLI: ${reason}; la nueva versión no se confirmó. Ejecuta 'jorgex-stack install --playwright' para reintentar.`);
          exitCode = 1;
        } else {
          let promptReconciliationFailed = false;
          for (const { adapter, ctx } of successfulContexts) {
            const browserCtx: InstallContext = { ...ctx,
              playwrightCliEnabled: opts.playwrightToolConsent?.runtimeSelection?.[adapter.id] ?? true, warnings: [] };
            try {
              const browserChanges = diffPlan(planSystemPrompt(adapter, browserCtx)).filter((change) => change.status !== "unchanged");
              if (browserChanges.length === 0) continue;

              const browserUpdates = browserChanges.filter((change) => change.status === "update");
              const backup = useManifest ? createBackup(browserUpdates.map((change) => change.action.target), `install-browser-${adapter.id}`) : null;
              if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);
              applyChanges(browserChanges);

              const dirty = diffPlan(planSystemPrompt(adapter, { ...browserCtx, warnings: [] }))
                .filter((change) => change.status !== "unchanged");
              if (dirty.length > 0) {
                p.log.error(`${adapter.name}: verificación de la guía de navegador FALLÓ (${dirty.length} acciones inestables).`);
                promptReconciliationFailed = true;
              }
            } catch (error) {
              p.log.error(`${adapter.name}: no se pudo actualizar la guía de navegador (${error instanceof Error ? error.message : String(error)}).`);
              exitCode = 1;
              promptReconciliationFailed = true;
            }
          }
          if (promptReconciliationFailed) {
            exitCode = 1;
            p.log.error("Playwright CLI y navegador se han instalado y la preferencia quedó activa, pero la guía de navegador quedó en estado parcial. Ejecuta 'jorgex-stack sync' para repararla.");
          } else {
            const verified = verifiedCapability ?? (preparedEnv === undefined
              ? inspectPlaywrightCapability({ browserVerified: true, expectedVersion: candidate.version })
              : inspectPlaywrightCapability({ browserVerified: true, env: preparedEnv, expectedVersion: candidate.version }));
            if (verified.effective && verified.cli.status === "current" && verified.cli.binPath !== null
              && verified.cli.detectedVersion !== null && verified.browserCache.status === "ready") {
              opts.onPlaywrightCapability?.(verified as VerifiedPlaywrightCapabilitySnapshot);
            }
            p.log.success("Playwright CLI instalado y arranque de Chromium verificado.");
          }
        }
      }
    }
  } else if (playwrightCapability !== undefined && !playwrightCapability.effective) {
    if (playwrightCapability.cli.status !== "current") {
      p.log.warn("Playwright CLI sigue habilitado, pero el paquete no está listo; sync no instala herramientas. Ejecuta 'jorgex-stack install --playwright'.");
    } else if (playwrightCapability.browserCache.status === "unreadable") {
      p.log.warn(`Playwright CLI sigue habilitado, pero no se puede leer la caché de navegadores en ${playwrightCapability.browserCache.path} (${playwrightCapability.browserCache.errorCode}). Revisa permisos o ejecuta 'jorgex-stack install --playwright'.`);
    } else if (playwrightCapability.browserCache.status === "missing") {
      p.log.warn("Playwright CLI sigue habilitado, pero falta el navegador; sync no descarga navegadores. Ejecuta 'jorgex-stack install --playwright'.");
    } else {
      p.log.warn("Playwright CLI sigue habilitado, pero Chromium no arranca; se ha retirado la guía. Ejecuta 'jorgex-stack install --playwright' para repararlo.");
    }
  }

  if (useManifest && !opts.dryRun && exitCode === 0 && successfulRuns > 0) {
    saveInstallModePreference(installModePreferenceFile(), modePreference);
  }

  if (showSummary) {
    p.log.message(formatRuntimeSummary(opts.command ?? "install", runtimeStatuses));
    p.outro(opts.dryRun
      ? exitCode === 0
        ? "Dry-run: no se ha escrito nada."
        : "Dry-run completado con errores (revisa arriba)."
      : exitCode === 0
        ? "Hecho."
        : "Install completado con errores (revisa arriba).");
  }
  return exitCode;
}
