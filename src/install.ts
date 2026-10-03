import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { prepareWritingStyle, applyWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot, type WritingStylePlan } from "./lib/writing-style.js";
import type { Adapter, FileAction, InstallContext, InstallModePreference, OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import {
  opencodeAdapter,
  reconcileBrowserControlEnvironment,
  resolvePreservedBrowserControlRelayPort,
  retireBrowserControlEnvironment,
} from "./adapters/opencode.js";
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
import {
  findOrphans,
  isBrowserControlAutostartStamp,
  readManifest,
  readManifestStrict,
  writeRuntimeManifest,
  type BrowserControlAutostartStamp,
  type RuntimeManifest,
} from "./lib/manifest.js";
import {
  authenticateStaticResource,
  projectedBytesByTarget,
  staticResourceBlockReason,
  staticResourceTargets,
  unownedCurrentTargets,
  type StaticResourceAuth,
  type StaticResourceRow,
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
import {
  prepareBrowserControlRuntime,
  resolveBrowserControlRelayPort,
  type BrowserControlPreviousProjection,
  type BrowserControlRuntimeResult,
} from "./lib/browser-control-runtime.js";
import {
  authenticateOwnedServiceUnitInvocation,
  browserControlAutostartEnvironment,
  browserControlAutostartProjectionSha256,
  createSystemctlRunner,
  ensureBrowserControlServiceUnit,
  inspectOwnedServiceUnitRetirement,
  preflightBrowserControlServiceUnit,
  probeInactiveOwnedServiceUnit,
  resolveBrowserControlServiceConfigBase,
  resolveBrowserControlServiceUnitPath,
  superviseBrowserControlServiceUnit,
  type BrowserControlSystemctlRunner,
} from "./lib/browser-control-service.js";
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
  devtoolsMcpPreferenceError,
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
  /**
   * Opt-in Linux explícito al servicio de usuario Browser Control
   * (`jorgex-stack-browser-control.service`). Solo install/sync/update reales en
   * Linux: `--target-dir`/dry-run nunca lo tocan. Crea la unidad fija desde el
   * active verificado y, para una unidad NUEVA, ejecuta el supervisor (preflight
   * de ausencia relay+manager, daemon-reload, enable/start y prueba de readiness
   * HTTP) antes de estampar `BROWSER_CONTROL_AUTOSTART=false`. Una unidad ya
   * existente solo se verifica, sin mutaciones.
   */
  browserControlService?: boolean;
  /** Frontera externa del manager (tests); undefined usa `systemctl` absoluto verificado. */
  systemctlRunner?: BrowserControlSystemctlRunner;
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
  // El ledger genérico por servidor también registra la marca Browser Control que
  // el propio pipeline creó; leerla es lo único que autoriza reconocer esa
  // entrada como owned (nunca la igualdad de comando).
  const marked = [DEVTOOLS_MCP_SERVER, "context7", BROWSER_CONTROL_SERVER]
    .filter((server) => loadDevtoolsMcpOwnership(file, runtime, server));
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

const BROWSER_CONTROL_SERVER = "browser-control";

/** Target fijo de la skill oficial Browser Control dentro del configDir OpenCode. */
function browserControlSkillTarget(configDir: string): string {
  return path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
}

/**
 * Proyecta el SKILL.md oficial retenido en la release `active` verificada como
 * copia byte-identical en el configDir de OpenCode. Nunca usa el canon
 * compartido `~/.agents/skills`. Sin fuente (pending/unavailable) no se proyecta
 * skill alguna; el adapter ya diagnostica el MCP pendiente.
 */
function planBrowserControlSkill(adapter: Adapter, ctx: InstallContext): FileAction[] {
  if (adapter.id !== "opencode" || ctx.browserControlSkillSource === undefined) return [];
  return [{ kind: "copy", source: ctx.browserControlSkillSource, target: browserControlSkillTarget(ctx.configDir) }];
}

export function buildContentPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planAgents(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
    ...planHooks(adapter, ctx),
    ...planPlugins(adapter, ctx),
    ...planBrowserControlSkill(adapter, ctx),
    ...(adapter.planAdditionalResources?.(ctx) ?? []),
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

function applyChanges(
  changes: PlannedChange[],
  onWritten?: (action: FileAction) => void,
  onOwnershipWritten?: (action: FileAction) => void,
): void {
  for (const { action } of changes) {
    if (action.kind === "write") {
      writeText(action.target, action.content);
      onWritten?.(action);
      if (action.mcpOwnership !== undefined || action.primaryModelOwnership !== undefined) onOwnershipWritten?.(action);
    } else {
      copyFile(action.source, action.target);
      onWritten?.(action);
    }
  }
}

/** Identidad física (dev/ino) de un leaf regular: evidencia de no-sustitución. */
interface LeafIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OwnLeaf {
  readonly exists: boolean;
  readonly bytes: Buffer | null;
  readonly identity: LeafIdentity | null;
}

/**
 * Lee un leaf de la propia proyección exigiendo archivo regular, un solo enlace
 * y sin seguir enlaces. ENOENT es ausencia legítima (target nuevo); cualquier
 * otro error (EACCES/EIO/enlace/leaf inseguro) bloquea la transacción antes de
 * escribir. Nunca sigue un alias del usuario.
 */
function readOwnLeaf(target: string): OwnLeaf {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, bytes: null, identity: null };
    throw new Error(`no se pudo inspeccionar ${target} antes de la proyección (${error instanceof Error ? error.message : String(error)})`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${target}: es un enlace simbólico; no se sigue ni se sobrescribe.`);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${target}: no es un archivo regular de un solo enlace; no se sobrescribe.`);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`${target}: no se pudo abrir sin seguir enlaces (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`${target}: leaf inseguro al abrir.`);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error(`${target}: cambió durante la inspección.`);
    return { exists: true, bytes: fs.readFileSync(fd), identity: { dev: opened.dev, ino: opened.ino } };
  } finally {
    fs.closeSync(fd);
  }
}

/** Estado pre-escritura y evidencia de la escritura propia de un target del plan. */
interface ProjectionTargetSnapshot {
  readonly target: string;
  readonly existed: boolean;
  readonly previous: Buffer | null;
  readonly previousIdentity: LeafIdentity | null;
  readonly expected: Buffer;
  written: boolean;
  afterIdentity: LeafIdentity | null;
}

/**
 * Captura el estado pre-escritura y la salida esperada de los targets exactos
 * que `applyChanges` va a modificar. Solo lee destinos del propio plan; no
 * explora datos ajenos. Un leaf inseguro o una fuente ilegible lanza y bloquea
 * la transacción antes de cualquier escritura.
 */
function snapshotProjectionTargets(changes: readonly PlannedChange[]): Map<string, ProjectionTargetSnapshot> {
  const snapshots = new Map<string, ProjectionTargetSnapshot>();
  for (const { action } of changes) {
    const target = path.resolve(action.target);
    if (snapshots.has(target)) continue;
    let expected: Buffer;
    try {
      expected = action.kind === "write" ? Buffer.from(action.content) : fs.readFileSync(action.source);
    } catch (error) {
      throw new Error(`no se pudo leer la salida esperada de ${target} (${error instanceof Error ? error.message : String(error)})`);
    }
    const leaf = readOwnLeaf(target);
    snapshots.set(target, {
      target,
      existed: leaf.exists,
      previous: leaf.bytes,
      previousIdentity: leaf.identity,
      expected,
      written: false,
      afterIdentity: null,
    });
  }
  return snapshots;
}

/** Claim de ownership que esta operación declara/escribe, con su valor previo. */
interface OwnershipClaimRecord {
  readonly runtime: RuntimeId;
  readonly configDir: string;
  readonly kind: "mcp" | "primary";
  readonly server?: string;
  readonly field?: string;
  readonly previous: boolean;
  readonly written: boolean;
  /** true solo tras confirmar el write propio (save + readback === written). */
  persisted: boolean;
}

/**
 * Persiste los claims de ownership declarados por UNA acción con evidencia por
 * campo: captura el valor previo en el primer write real, ejecuta la API de
 * save existente por claim y marca `persisted` solo tras el readback que
 * confirma el valor propio. Un save que falla antes del rename atómico deja el
 * claim en su valor previo (no persistido) y no debe bloquear la recuperación
 * de los targets. Conserva la semántica de la API: un fallo se propaga.
 */
function persistOwnershipClaimsTracked(
  action: FileAction,
  runtime: RuntimeId,
  configDir: string,
  records: Map<string, OwnershipClaimRecord>,
): void {
  if (action.kind !== "write") return;
  for (const change of action.mcpOwnership ?? []) {
    const key = `mcp:${change.server}`;
    let record = records.get(key);
    if (record === undefined) {
      record = {
        runtime,
        configDir,
        kind: "mcp",
        server: change.server,
        previous: loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), runtime, change.server),
        written: change.owned,
        persisted: false,
      };
      records.set(key, record);
    }
    if (record.persisted) continue;
    saveDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), runtime, change.server, change.owned);
    if (loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), runtime, change.server) === change.owned) {
      record.persisted = true;
    }
  }
  for (const change of action.primaryModelOwnership ?? []) {
    const key = `primary:${change.field}`;
    let record = records.get(key);
    if (record === undefined) {
      record = {
        runtime,
        configDir,
        kind: "primary",
        field: change.field,
        previous: loadPrimaryModelOwnership(primaryModelOwnershipFile(), runtime, configDir).has(change.field),
        written: change.owned,
        persisted: false,
      };
      records.set(key, record);
    }
    if (record.persisted) continue;
    savePrimaryModelOwnership(primaryModelOwnershipFile(), runtime, configDir, change.field, change.owned);
    if (loadPrimaryModelOwnership(primaryModelOwnershipFile(), runtime, configDir).has(change.field) === change.owned) {
      record.persisted = true;
    }
  }
}

/** ¿Sigue siendo observable como propia la escritura de este target? */
function targetRecoverable(snap: ProjectionTargetSnapshot): boolean {
  if (snap.afterIdentity === null) return false;
  let leaf: OwnLeaf;
  try {
    leaf = readOwnLeaf(snap.target);
  } catch {
    return false;
  }
  if (!leaf.exists || leaf.bytes === null || leaf.identity === null) return false;
  if (leaf.identity.dev !== snap.afterIdentity.dev || leaf.identity.ino !== snap.afterIdentity.ino) return false;
  return leaf.bytes.equals(snap.expected);
}

/**
 * ¿Es recuperable este claim? Un claim persistido exige observar el valor propio
 * escrito o el previo (ya restaurado); un claim que nunca se persistió solo es
 * aceptable si sigue en su valor previo, nunca se adopta por igualdad con el
 * valor escrito.
 */
function claimRecoverable(record: OwnershipClaimRecord): boolean {
  if (record.kind === "mcp") {
    const file = devtoolsMcpPreferenceFile();
    if (devtoolsMcpPreferenceError(file) !== null) return false;
    const current = loadDevtoolsMcpOwnership(file, record.runtime, record.server!);
    return record.persisted
      ? current === record.written || current === record.previous
      : current === record.previous;
  }
  const file = primaryModelOwnershipFile();
  if (primaryModelOwnershipError(file) !== null) return false;
  const current = loadPrimaryModelOwnership(file, record.runtime, record.configDir).has(record.field!);
  return record.persisted
    ? current === record.written || current === record.previous
    : current === record.previous;
}

function restoreTarget(snap: ProjectionTargetSnapshot): boolean {
  try {
    if (snap.existed) fs.writeFileSync(snap.target, snap.previous!);
    else fs.rmSync(snap.target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Inverso exacto de los claims propios: nunca reescribe el ledger completo. */
function restoreClaim(record: OwnershipClaimRecord): boolean {
  // Un claim que nunca se persistió ya está en su valor previo: no hay inverso.
  if (!record.persisted || record.previous === record.written) return true;
  try {
    if (record.kind === "mcp") {
      saveDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), record.runtime, record.server!, record.previous);
    } else {
      savePrimaryModelOwnership(primaryModelOwnershipFile(), record.runtime, record.configDir, record.field!, record.previous);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Recuperación acotada en dos fases: primero se verifica que TODA escritura y
 * claim propios sigan observables como propios; solo entonces se muta. Si algo
 * derivó a ajeno o el ledger no es verificable, no se toca nada y se conserva
 * el estado observado. No promete atomicidad comprobación+syscall (cota
 * mismo-UID).
 */
function recoverProjection(
  snapshots: readonly ProjectionTargetSnapshot[],
  claims: readonly OwnershipClaimRecord[],
): boolean {
  const written = snapshots.filter((snap) => snap.written);
  for (const snap of written) if (!targetRecoverable(snap)) return false;
  for (const record of claims) if (!claimRecoverable(record)) return false;
  for (const snap of written) if (!restoreTarget(snap)) return false;
  for (const record of claims) if (!restoreClaim(record)) return false;
  return true;
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
      // Target fijo Browser Control: se reclama aunque el plan actual no lo
      // genere (pending) para no borrar como huérfana la skill del active previo.
      if (adapter.id === "opencode") {
        targets.add(path.resolve(browserControlSkillTarget(detection.configDir)));
        // La unidad de servicio fija es un target externo del mismo row: se
        // reclama siempre para que un opt-in ausente/pending nunca la convierta
        // en huérfana ni pierda su claim.
        const serviceUnit = resolveBrowserControlServiceUnitPath();
        if (serviceUnit !== null) targets.add(path.resolve(serviceUnit));
      }
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
  // La skill Browser Control es un target fijo del adapter, aunque el plan
  // canónico actual no la genere (pending) o no cargue el estado managed: un
  // manifest coherente que la liste no debe bloquear ni quedar sin corroborar.
  recognized.add(path.resolve(browserControlSkillTarget(ctx.configDir)));
  // La unidad de servicio fija (externa al configDir, derivada del XDG config)
  // es un recurso reconocido del mismo row: un manifest coherente que la liste
  // no debe bloquear ni quedar sin corroborar.
  const serviceUnit = resolveBrowserControlServiceUnitPath();
  if (serviceUnit !== null) recognized.add(path.resolve(serviceUnit));
  return recognized;
}

/**
 * Valida la evidencia `serviceUnit` cuando existe: campos exactos, schema 1 y
 * co-presencia con la unidad owned fija. No concede ownership: un binding
 * malformado o huérfano bloquea antes de reutilizar la autoridad.
 */
function assertManagedBrowserControlServiceBinding(
  value: unknown,
  ownedPaths: readonly string[],
  inRoots: (file: string) => boolean,
  unitTarget: string | null,
): void {
  if (value === undefined) return;
  const fail = (detail: string): never => {
    throw new Error(
      `OpenCode: la evidencia 'serviceUnit' del manifest es incoherente (${detail}); se conserva el manifest y no se toca la unidad ni ningún archivo. Revisa o restaura el manifest antes de reintentar install/sync.`,
    );
  };
  if (!isPlainRecord(value)) fail("no es un objeto");
  const binding = value as Record<string, unknown>;
  const expected = ["nodePath", "port", "receiptSha256", "releaseDirectory", "schemaVersion", "unitSha256"];
  const keys = Object.keys(binding).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("campos inesperados o ausentes");
  }
  if (binding["schemaVersion"] !== 1) fail("schemaVersion distinto de 1");
  const releaseDirectory = binding["releaseDirectory"];
  if (
    typeof releaseDirectory !== "string"
    || !releaseDirectory.startsWith("release-")
    || releaseDirectory.includes("/")
    || releaseDirectory.includes("\\")
  ) {
    fail("releaseDirectory inválido");
  }
  if (typeof binding["receiptSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(binding["receiptSha256"])) fail("receiptSha256 inválido");
  if (typeof binding["unitSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(binding["unitSha256"])) fail("unitSha256 inválido");
  const nodePath = binding["nodePath"];
  if (typeof nodePath !== "string" || !path.isAbsolute(nodePath)) fail("nodePath inválido");
  const port = binding["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) fail("port inválido");
  if (unitTarget === null || !ownedPaths.some((file) => path.resolve(file) === unitTarget) || !inRoots(unitTarget)) {
    fail("falta la unidad owned fija correspondiente");
  }
}

/**
 * Valida la estampa granular de autostart cuando existe: forma exacta, schema 1,
 * digest válido y `portOwned` booleano estricto (nunca truthiness) más
 * co-presencia con el binding y la unidad owned fija. No concede ownership: un
 * estado malformado bloquea conservando recursos antes de reutilizar la
 * autoridad.
 */
function assertManagedBrowserControlAutostartStamp(
  value: unknown,
  entry: Record<string, unknown>,
  ownedPaths: readonly string[],
  inRoots: (file: string) => boolean,
  unitTarget: string | null,
): void {
  if (value === undefined) return;
  const fail = (detail: string): never => {
    throw new Error(
      `OpenCode: la estampa 'browserControlAutostart' del manifest es incoherente (${detail}); se conserva el manifest y no se toca la unidad ni ningún archivo. Revisa o restaura el manifest antes de reintentar install/sync.`,
    );
  };
  if (!isBrowserControlAutostartStamp(value)) fail("forma/schema/digest/portOwned inválidos");
  if (entry.serviceUnit === undefined) fail("falta la evidencia serviceUnit correspondiente");
  if (unitTarget === null || !ownedPaths.some((file) => path.resolve(file) === unitTarget) || !inRoots(unitTarget)) {
    fail("falta la unidad owned fija correspondiente");
  }
}

/**
 * Valida el progreso de retirada de servicio Browser Control cuando existe:
 * forma estricta (`schemaVersion`/`phase` exactos, fase conocida) y co-presencia
 * con el binding y la unidad owned fija. La estampa ENV es opcional: una
 * retirada unit-only legítima (A→B ya retiró la estampa, o nunca hubo claim ENV)
 * no la exige; cuando existe se valida por separado. Una row legacy sin fase
 * queda intacta; un progreso huérfano o malformado bloquea antes de reutilizar
 * cualquier autoridad.
 */
function assertManagedBrowserControlServiceRetirement(
  value: unknown,
  entry: Record<string, unknown>,
  ownedPaths: readonly string[],
  inRoots: (file: string) => boolean,
  unitTarget: string | null,
): void {
  if (value === undefined) return;
  const fail = (detail: string): never => {
    throw new Error(
      `OpenCode: el progreso 'browserControlServiceRetirement' del manifest es incoherente (${detail}); se conserva el manifest y no se toca la unidad ni ningún archivo. Revisa o restaura el manifest antes de reintentar install/sync.`,
    );
  };
  if (!isPlainRecord(value)) fail("no es un objeto");
  const retirement = value as Record<string, unknown>;
  const expected = ["phase", "schemaVersion"];
  const keys = Object.keys(retirement).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("campos inesperados o ausentes");
  }
  if (retirement["schemaVersion"] !== 1) fail("schemaVersion distinto de 1");
  const phase = retirement["phase"];
  if (phase !== "environment-retired" && phase !== "unit-removed" && phase !== "manager-reloaded") {
    fail("phase desconocida");
  }
  if (entry.serviceUnit === undefined) fail("falta la evidencia serviceUnit correspondiente");
  if (unitTarget === null || !ownedPaths.some((file) => path.resolve(file) === unitTarget) || !inRoots(unitTarget)) {
    fail("falta la unidad owned fija correspondiente");
  }
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
  // Excepción explícita y por igualdad exacta: la única unidad de servicio fija
  // derivada del XDG config efectivo. No se abre contención amplia por systemd/XDG.
  const serviceUnit = resolveBrowserControlServiceUnitPath();
  const serviceUnitTarget = serviceUnit === null ? null : path.resolve(serviceUnit);
  const inRoots = (file: string): boolean =>
    roots.some((root) => isContainedIn(file, root))
    || (serviceUnitTarget !== null && path.resolve(file) === serviceUnitTarget);
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

  assertManagedBrowserControlServiceBinding(entry.serviceUnit, owned as string[], inRoots, serviceUnitTarget);
  assertManagedBrowserControlAutostartStamp(
    entry.browserControlAutostart,
    entry,
    owned as string[],
    inRoots,
    serviceUnitTarget,
  );
  assertManagedBrowserControlServiceRetirement(
    entry.browserControlServiceRetirement,
    entry,
    owned as string[],
    inRoots,
    serviceUnitTarget,
  );

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
 * Autenticación de bytes de los recursos estáticos OpenCode. No sustituye
 * al ownership: el manifest coherente sigue siendo la única autoridad y el
 * digest solo clasifica el contenido (actual/legacy/desconocido) para bloquear
 * o permitir la mutación. Corre antes de writing-style, model-map, backups,
 * proyección y setup. Incluye los assets adicionales current-only del adapter
 * (fila `null`: sin canon legacy, solo bytes actuales) para que el preflight
 * bloquee un target inseguro antes de cualquier write.
 */
function openCodeStaticResourceAuths(
  adapter: Adapter,
  ctx: InstallContext,
  actions: readonly FileAction[],
  ownedPaths: readonly string[],
): StaticResourceAuth[] {
  const configDir = ctx.configDir;
  const targets = staticResourceTargets(configDir);
  const bytesByTarget = projectedBytesByTarget(actions);
  const ownedSet = new Set(ownedPaths.map((file) => path.resolve(file)));
  const auths = [...targets].map(([target, row]) =>
    authenticateStaticResource(target, row, bytesByTarget.get(target) ?? null, ownedSet.has(target), configDir));
  for (const action of adapter.planAdditionalResources?.(ctx) ?? []) {
    const target = path.resolve(action.target);
    auths.push(authenticateStaticResource(target, null, bytesByTarget.get(target) ?? null, ownedSet.has(target), configDir));
  }
  return auths;
}

/**
 * Autentica los bytes de la skill Browser Control como un recurso estático
 * adicional: unowned idéntica al active es un no-op sin claim; unowned/owned con
 * contenido distinto o estado inseguro bloquea y se preserva sin reemplazo.
 * El digest del "canon" es el de los bytes retenidos de la release activa.
 */
function browserControlSkillAuth(
  configDir: string,
  ctx: InstallContext,
  ownedPaths: readonly string[],
): StaticResourceAuth | null {
  const source = ctx.browserControlSkillSource;
  if (source === undefined) return null;
  const target = path.resolve(browserControlSkillTarget(configDir));
  let currentBytes: Buffer;
  try {
    currentBytes = fs.readFileSync(source);
  } catch {
    // Fuente ilegible: sin bytes actuales autenticables; el plan fallará cerrado.
    return null;
  }
  // Fingerprint previo A: en un update A→B el target owned conserva los bytes de
  // A. Se autentica como el canon anterior (row) mientras B es el actual; un
  // target que no coincide ni con B ni con A queda "unknown" y se preserva.
  const previousSource = ctx.browserControlPreviousSkillSource;
  let rowSource = source;
  let rowBytes = currentBytes;
  if (previousSource !== undefined && previousSource !== source) {
    try {
      rowBytes = fs.readFileSync(previousSource);
      rowSource = previousSource;
    } catch {
      rowSource = source;
      rowBytes = currentBytes;
    }
  }
  const row: StaticResourceRow = {
    source: rowSource,
    target,
    size: rowBytes.length,
    sha256: createHash("sha256").update(rowBytes).digest("hex"),
  };
  const owned = new Set(ownedPaths.map((file) => path.resolve(file))).has(target);
  return authenticateStaticResource(target, row, currentBytes, owned, path.resolve(configDir));
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
  assertOpenCodeStaticResourcesUsable(openCodeStaticResourceAuths(opencodeAdapter, ctx, buildContentPlan(opencodeAdapter, ctx), owned));
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
 * Elegibilidad de Playwright por runtime, alineada con el selector de CLI y el
 * fallback de doctor: OpenCode v2 usa Browser Control y ya no ofrece Playwright
 * CLI, así que una preferencia legacy `enabled.opencode` nunca debe disparar la
 * inspección del Playwright gestionado ni el smoke de Chromium. `runtimes` de
 * install solo contiene destinos de fichero reales (Pi vive fuera del pipeline),
 * por lo que el handoff de Pi no aplica aquí.
 */
function isPlaywrightEligibleRuntime(runtime: RuntimeId): boolean {
  return runtime !== "opencode";
}

/**
 * OpenCode v2 no ofrece el selector Playwright CLI: el caller CLI ya
 * lo rechaza, pero la API `runInstall` también debe fallar de forma honesta en
 * vez de adquirir Playwright y escribir un AGENTS.md que el runtime ya no
 * ofrece. Un runtime `pi` no es un destino Playwright de este pipeline (vive
 * fuera de `runtimes`), así que la comprobación solo mira los destinos de
 * fichero reales. Devuelve el diagnóstico o `null` si la selección es admisible.
 */
function playwrightSelectionError(opts: InstallOptions): string | null {
  const consent = opts.playwrightToolConsent;
  if (consent === undefined) return null;
  const selection = consent.runtimeSelection;
  if (selection?.opencode === true) {
    return "OpenCode v2 no ofrece Playwright CLI: usa Browser Control (CLI/skill/MCP) obligatorio. Retira la selección Playwright de OpenCode.";
  }
  const targetDir = opts.targetDir !== undefined || consent.targetDir;
  const approved = consent.command === "install" && !targetDir
    && (consent.interactive
      ? (consent.yes ? consent.explicitToolSelection : consent.confirmed)
      : consent.yes && consent.explicitToolSelection);
  // Control mixto: con solo runtimes de fichero OpenCode la adquisición global
  // sigue siendo válida si la selección explícita apunta a otro destino elegible
  // (p.ej. Pi, que se persiste por su propio handoff fuera de `runtimes`). Sin
  // otro destino seleccionado, la rama retirada se mantiene rechazada.
  const otherSelected = selection !== undefined
    && Object.entries(selection).some(([runtime, selected]) => runtime !== "opencode" && selected === true);
  if (approved && !otherSelected && opts.runtimes.length > 0 && opts.runtimes.every((id) => id === "opencode")) {
    return "OpenCode v2 no ofrece Playwright CLI: usa Browser Control (CLI/skill/MCP) obligatorio; no hay otro runtime elegible para la selección Playwright.";
  }
  return null;
}

/** Decisión de preflight del retiro del entorno de autostart propio en una rotación A→B. */
type BrowserControlRetirement =
  | { readonly kind: "none" }
  | { readonly kind: "retire"; readonly port: number; readonly portOwned: boolean }
  | { readonly kind: "block"; readonly reason: string };

/**
 * T13: preflight de SOLO LECTURA que decide si el entorno de autostart que Stack
 * introdujo para el servicio A puede retirarse ANTES de publicar la proyección
 * B. Autentica la estampa contra la proyección del active PREVIO A (nunca contra
 * B), exige que el MCP gestionado actual siga siendo la proyección A retirable y
 * comprueba por el manager que la unidad A está inactiva con el relay ausente en
 * su puerto propio. Una autoridad modificada o un estado incierto bloquea antes
 * de cualquier escritura: el caller restaura A con el rollback real.
 */
async function resolveBrowserControlRetirement(input: {
  readonly configDir: string;
  readonly row: RuntimeManifest | undefined;
  readonly previous: BrowserControlPreviousProjection | undefined;
  readonly runner: BrowserControlSystemctlRunner;
}): Promise<BrowserControlRetirement> {
  const priorStamp = input.row?.browserControlAutostart;
  if (input.previous === undefined || priorStamp === undefined) return { kind: "none" };
  const serviceConfigBase = resolveBrowserControlServiceConfigBase();
  const unitPath = resolveBrowserControlServiceUnitPath();
  if (serviceConfigBase === null || unitPath === null) {
    return { kind: "block", reason: "el XDG config efectivo no es una ruta absoluta válida" };
  }
  if (!samePath(input.configDir, path.join(serviceConfigBase, "opencode"))) {
    return {
      kind: "block",
      reason: `el perfil de la unidad (${serviceConfigBase}) no coincide con el configDir de OpenCode (${input.configDir})`,
    };
  }
  const binding = input.row?.serviceUnit;
  if (binding === undefined) {
    return {
      kind: "block",
      reason: "hay una estampa de autostart previa pero falta la evidencia serviceUnit que autentica su puerto",
    };
  }
  if (
    priorStamp.schemaVersion !== 1
    || priorStamp.projectionSha256 !== browserControlAutostartProjectionSha256(input.previous.invocation, binding.port)
  ) {
    return {
      kind: "block",
      reason: `la estampa de autostart previa no autentica contra el active A (puerto ${binding.port})`,
    };
  }
  const projected = retireBrowserControlEnvironment({
    configDir: input.configDir,
    invocation: input.previous.invocation,
    port: binding.port,
    portOwned: priorStamp.portOwned,
  });
  if (projected.kind === "blocked") return { kind: "block", reason: projected.reason };
  if (projected.kind !== "retired") {
    return {
      kind: "block",
      reason: "la estampa previa no corresponde a un entorno gestionado retirable; se conserva sin sobrescribir",
    };
  }
  const probe = await probeInactiveOwnedServiceUnit({ runner: input.runner, unitPath, port: binding.port });
  if (probe.kind !== "inactive") {
    return {
      kind: "block",
      reason: `no se acredita la unidad histórica inactiva con el relay ausente (${probe.reason})`,
    };
  }
  return { kind: "retire", port: binding.port, portOwned: priorStamp.portOwned };
}

/**
 * Continuación compartida una vez acreditado un servicio operativo (unidad
 * recién creada o unidad existente verificada en SOLO LECTURA): reconcilia el
 * entorno de autostart propio y publica la autoridad granular solo cuando esta
 * ejecución introdujo el entorno ausente o reutiliza una estampa previa
 * acreditada. No recompone el comando, no adopta un entorno por igualdad, no
 * reescribe la unidad ni invoca el manager. Devuelve 0 si el entorno quedó
 * estable y acreditado; 1 si queda pendiente y no debe declararse autostart.
 */
function reconcileVerifiedBrowserControlEnvironment(input: {
  readonly configDir: string;
  readonly invocation: { command: string; args: readonly string[] };
  readonly port: number;
  readonly releaseDirectory: string;
  readonly unitPath: string;
  readonly prior: BrowserControlAutostartStamp | undefined;
}): number {
  const environment = browserControlAutostartEnvironment(input.port);
  const projectionSha256 = browserControlAutostartProjectionSha256(input.invocation, input.port);
  const reconciled = reconcileBrowserControlEnvironment({
    configDir: input.configDir,
    invocation: input.invocation,
    environment,
  });
  const priorAccredited = input.prior !== undefined
    && input.prior.schemaVersion === 1
    && input.prior.projectionSha256 === projectionSha256;
  let stampReady = reconciled;
  let introduced = false;
  // El bit de ownership del puerto se captura de la PRIMERA reconciliación
  // `written` (lo que Stack introduce ahora), no del readback posterior: un
  // readback `unchanged` sobre una pareja ya existente no debe recapturar un
  // claim manual por igualdad.
  let introducedPortOwned = false;
  if (reconciled.kind === "written") {
    introducedPortOwned = reconciled.portOwned;
    const backup = createBackup([reconciled.file], "install-browser-control-service");
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);
    try {
      writeText(reconciled.file, reconciled.content);
      // Secuencia distinta de un `unchanged` inicial: aquí se sabe que esta
      // ejecución escribió el campo y el readback debe ser un no-op, no una
      // adopción por igualdad.
      stampReady = reconcileBrowserControlEnvironment({
        configDir: input.configDir,
        invocation: input.invocation,
        environment,
      });
      introduced = stampReady.kind === "unchanged";
    } catch (error) {
      stampReady = { kind: "blocked", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (stampReady.kind !== "unchanged") {
    const detail = "reason" in stampReady ? stampReady.reason : "estado inesperado";
    p.log.error(
      `Browser Control: el readback del entorno gestionado no quedó estable (${detail}); no se estampa el autostart.`,
    );
    return 1;
  }
  if (!introduced && !priorAccredited) {
    // `environment` canónico ya presente (p. ej. escritura manual del usuario)
    // sin que Stack lo haya creado ni exista estampa previa acreditada: se
    // conserva con conflicto accionable, sin adoptarlo por igualdad.
    p.log.error(
      `Browser Control: el MCP gestionado ya contenía un entorno (AUTOSTART=false / puerto ${input.port}) que no ha introducido Stack y no tiene una estampa previa acreditada; se conserva sin adoptar ni sobrescribir. Ajuste manual requerido.`,
    );
    return 1;
  }
  if (!priorAccredited) {
    const currentRow = readManifest().runtimes.opencode;
    if (currentRow !== undefined) {
      writeRuntimeManifest("opencode", {
        ...currentRow,
        browserControlAutostart: {
          schemaVersion: 1,
          projectionSha256,
          portOwned: introducedPortOwned,
        },
        updatedAt: new Date().toISOString(),
      });
    }
  }
  p.log.success(
    `Browser Control: servicio de usuario verificado en ${input.unitPath} (release ${input.releaseDirectory}, puerto ${input.port}); autostart externo gestionado activo.`,
  );
  return 0;
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
  // Sin runtimes resueltos se asume el conjunto completo (como el fallback de
  // doctor), pero solo los elegibles cuentan: una preferencia legacy
  // `enabled.opencode` no dispara la inspección para un destino OpenCode-only.
  const inspectableRuntimes: readonly RuntimeId[] = opts.runtimes.length > 0
    ? opts.runtimes
    : (Object.keys(ADAPTERS) as RuntimeId[]);
  const shouldInspectPlaywright = useManifest
    && !opts.dryRun
    && (toolPlan === null || toolPlan.actions.length === 0)
    && inspectableRuntimes
      .filter(isPlaywrightEligibleRuntime)
      .some((runtime) => loadPlaywrightCliPreference(playwrightCliPreferenceFile(), runtime) === true);
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

  // Browser Control: toda operación real de OpenCode
  // (install/sync/update) ejecuta el controlador cerrado. Adquiere y retiene el
  // candidato verificado en el namespace fijo `.browser-control-candidate`; con
  // el relay presente/incierto no promueve ni reinicia; con ausencia comprobada
  // publica el active y entrega la invocación MCP completa + la skill oficial.
  // dry-run y --target-dir no tocan la red del proveedor ni el relay.
  let browserControlPending = false;
  let browserControlRuntime: BrowserControlRuntimeResult | undefined;
  let browserControlRollback: (() => Promise<void>) | undefined;
  // Puerto efectivo ya resuelto y validado desde el MCP preservado (o binding
  // autenticado): el preflight/creación del servicio reutilizan ESTA misma
  // fuente en vez de volver a leer `BROWSER_CONTROL_PORT` del proceso.
  let browserControlServicePort: number | undefined;
  // El artifact de servicio solo se materializa si la proyección OpenCode quedó
  // aplicada en disco (idempotente o recién escrita); el setup oficial v1/v2
  // pendiente no la invalida.
  let opencodeProjectionApplied = false;
  let opencodeConfigDir: string | undefined;
  // Decisión del preflight A→B (solo OpenCode/Linux): se calcula una vez antes
  // de escribir y el bloque de servicio posterior solo la aplica.
  let browserControlRetire: BrowserControlRetirement = { kind: "none" };
  // Gate de recuperación: una retirada de servicio Browser Control a medias no se
  // ignora ni se repara aquí. install/update diagnostican el recovery ANTES de
  // adquirir/promover el active y de cualquier proyección, y no siembran ni
  // arrancan un servicio nuevo; el runtime opencode se salta en el bucle.
  const opencodeRetirementPending = useManifest && !opts.dryRun && opts.runtimes.includes("opencode")
    ? readManifest().runtimes.opencode?.browserControlServiceRetirement
    : undefined;
  if (opencodeRetirementPending !== undefined) {
    p.log.error(
      `OpenCode: hay una retirada de servicio Browser Control pendiente (fase '${opencodeRetirementPending.phase}'); no se proyecta ni se crea/arranca un servicio nuevo. Completa 'uninstall' para cerrar la limpieza antes de reintentar install/sync.`,
    );
    exitCode = 1;
  }
  if (opencodeRetirementPending === undefined && useManifest && !opts.dryRun && opts.runtimes.includes("opencode")) {
    try {
      const pnpmBin = resolvePnpmBin();
      if (pnpmBin === null) throw new Error("pnpm no disponible para verificar el árbol gestionado");
      // Puerto EFECTIVO resuelto ANTES de adquirir/promover/sondear: el MCP
      // `browser-control` preservado (nativo o legacy) manda sobre el shell, y el
      // binding `serviceUnit` autenticado por el manifest (forma y co-presencia
      // con la unidad owned, validado por `assertOpenCodeManifestCoherence`) debe
      // ser coherente. Sin fuente preservada se conserva el contrato anterior.
      const bcConfigDir = ADAPTERS.opencode?.detect().configDir;
      const preserved = bcConfigDir === undefined
        ? { kind: "none" as const }
        : resolvePreservedBrowserControlRelayPort(bcConfigDir);
      const bindingPort = readManifest().runtimes.opencode?.serviceUnit?.port;
      if (preserved.kind === "ambiguous") {
        browserControlRuntime = {
          kind: "unavailable",
          reason: `no se puede resolver de forma inequívoca el puerto efectivo del relay desde el MCP preservado (${preserved.reason}); no se adquiere ni se promueve`,
        };
      } else {
        const preservedPort = preserved.kind === "resolved" ? preserved.port : undefined;
        // El puerto efectivo del MCP preservado es la fuente autoritativa del
        // servicio: se conserva para el preflight y la creación de la unidad.
        browserControlServicePort = preservedPort;
        if (preservedPort !== undefined && bindingPort !== undefined && preservedPort !== bindingPort) {
          browserControlRuntime = {
            kind: "unavailable",
            reason: `el puerto efectivo del MCP preservado (${preservedPort}) no coincide con el binding del servicio (${bindingPort}); procedencia incoherente, no se adquiere ni se promueve`,
          };
        } else {
          const relayPort = preservedPort ?? bindingPort;
          browserControlRuntime = await prepareBrowserControlRuntime({
            stateDir: dataDir(),
            pnpmBin,
            fetchImpl: globalThis.fetch,
            ...(relayPort === undefined ? {} : { relayPort }),
          });
        }
      }
    } catch (error) {
      browserControlRuntime = {
        kind: "unavailable",
        reason: `no se pudo verificar el candidato del proveedor (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (browserControlRuntime.kind === "ready") {
      p.log.info(
        `Browser Control: ${browserControlRuntime.version} verificado y activo; se proyecta el MCP gestionado y la skill oficial.`,
      );
      browserControlRollback = browserControlRuntime.rollback;
    } else {
      browserControlPending = true;
      const detail = browserControlRuntime.kind === "pending"
        ? (browserControlRuntime.activeVersion === undefined
            ? `candidato verificado ${browserControlRuntime.candidateVersion} retenido en el namespace candidato y aún NO activado (no hay un active gestionado utilizable), pero ${browserControlRuntime.reason}`
            : `candidato verificado ${browserControlRuntime.candidateVersion} retenido en el namespace candidato y aún NO activado; el active ${browserControlRuntime.activeVersion} se conserva sin cambios, pero ${browserControlRuntime.reason}`)
        : browserControlRuntime.reason;
      p.log.error(
        `Browser Control: ${detail}. No se proyecta MCP/skill ni se declara la capacidad; el resultado queda pendiente y revisa el diagnóstico antes de reintentar.`,
      );
    }
  }
  // Recuperación acotada: si la proyección del caller falla tras promover una
  // release nueva, se restaura el active previo (o se retira). El candidato
  // retenido nunca se toca. Un fallo independiente de Engram no la dispara.
  const rollbackBrowserControlProjection = async (): Promise<void> => {
    const rollback = browserControlRollback;
    browserControlRollback = undefined;
    if (rollback === undefined) return;
    try {
      await rollback();
    } catch (error) {
      p.log.error(
        `Browser Control: el rollback del active quedó incompleto (${error instanceof Error ? error.message : String(error)}). Revisa el receipt gestionado antes de reintentar.`,
      );
    }
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
    if (id === "opencode") opencodeConfigDir = configDir;
    // Gate de recuperación: una retirada de servicio Browser Control a medias no
    // se ignora ni se repara aquí; el runtime se salta sin proyectar ni sembrar
    // un servicio nuevo (el diagnóstico se emitió antes de adquirir el active).
    if (id === "opencode" && opencodeRetirementPending !== undefined) {
      reportStatus(adapter.name, "failed");
      continue;
    }
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
      ...(id === "opencode" && browserControlRuntime?.kind === "ready"
        ? {
            browserControlInvocation: browserControlRuntime.invocation,
            browserControlSkillSource: browserControlRuntime.skillSource,
            ...(browserControlRuntime.previous === undefined
              ? {}
              : {
                  browserControlPreviousInvocation: browserControlRuntime.previous.invocation,
                  browserControlPreviousSkillSource: browserControlRuntime.previous.skillSource,
                }),
          }
        : {}),
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

    let plan: FileAction[];
    let diff: PlannedChange[];
    try {
      plan = buildPlan(adapter, ctx);
      diff = diffPlan(plan);
    } catch (error) {
      // Sin una promoción Browser Control pendiente de proyección, el fallo de
      // plan conserva su propagación original. Con ella, un conflicto ANTES de
      // cualquier escritura (p.ej. un MCP browser-control gestionado modificado)
      // restaura el active A para no dejar active B / config A inconsistentes.
      if (browserControlRollback === undefined) throw error;
      p.log.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      await rollbackBrowserControlProjection();
      continue;
    }
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
      ? openCodeStaticResourceAuths(adapter, ctx, plan, prevManifest?.owned ?? [])
      : [];
    if (id === "opencode") {
      const browserSkillAuth = browserControlSkillAuth(configDir, ctx, prevManifest?.owned ?? []);
      if (browserSkillAuth !== null) staticAuths.push(browserSkillAuth);
    }
    let preservedStaticTargets = unownedCurrentTargets(staticAuths);
    try {
      assertOpenCodeStaticResourcesUsable(staticAuths);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      await rollbackBrowserControlProjection();
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
      // Un pending de Browser Control no sustituye al active: si la skill ya era
      // owned, se conserva su ownership aunque el plan actual no la regenere.
      if (id === "opencode") {
        const bcSkill = path.resolve(browserControlSkillTarget(configDir));
        if (previousOwned.includes(bcSkill) && !liveOwned.includes(bcSkill)) liveOwned.push(bcSkill);
        // La unidad de servicio fija owned se conserva igual: un opt-in
        // ausente/pending nunca la convierte en huérfana ni pierde su claim.
        const serviceUnit = resolveBrowserControlServiceUnitPath();
        if (serviceUnit !== null) {
          const unitTarget = path.resolve(serviceUnit);
          if (previousOwned.includes(unitTarget) && !liveOwned.includes(unitTarget)) liveOwned.push(unitTarget);
        }
      }
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
      writeRuntimeManifest(id, {
        configDir,
        owned,
        pendingOrphans,
        ...(prevManifest?.serviceUnit === undefined ? {} : { serviceUnit: prevManifest.serviceUnit }),
        ...(prevManifest?.browserControlAutostart === undefined
          ? {}
          : { browserControlAutostart: prevManifest.browserControlAutostart }),
        ...(prevManifest?.browserControlServiceRetirement === undefined
          ? {}
          : { browserControlServiceRetirement: prevManifest.browserControlServiceRetirement }),
        updatedAt: new Date().toISOString(),
      });
    };

    // T13: preflight transaccional del retiro A→B. Antes de cualquier escritura
    // de la proyección B se autentica la estampa de autostart propia contra el
    // active PREVIO A y se acredita de solo lectura la unidad A inactiva con el
    // relay ausente. Una autoridad modificada o un estado incierto restaura el
    // active A con el rollback real y NO escribe config/manifest/proyección B.
    if (
      id === "opencode"
      && useManifest
      && !opts.dryRun
      && process.platform === "linux"
      && browserControlRuntime?.kind === "ready"
    ) {
      const decision = await resolveBrowserControlRetirement({
        configDir,
        row: prevManifest,
        previous: browserControlRuntime.previous,
        runner: opts.systemctlRunner ?? createSystemctlRunner(),
      });
      if (decision.kind === "block") {
        p.log.error(
          `Browser Control: ${decision.reason}. No se escribe la proyección B ni el manifest; se restaura el active A.`,
        );
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        await rollbackBrowserControlProjection();
        continue;
      }
      browserControlRetire = decision;
    }

    if (changes.length === 0 && orphans.length === 0) {
      if (id === "opencode") opencodeProjectionApplied = true;
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
      if (id === "opencode") browserControlRollback = undefined;
      reportStatus(adapter.name, browserControlPending && id === "opencode" ? "failed" : "ok");
      continue;
    }

    if (!opts.yes && process.stdout.isTTY) {
      const orphanNote = orphans.length > 0 ? ` (+ ${orphans.length} huérfanos a eliminar)` : "";
      const ok = await p.confirm({ message: `¿Aplicar ${changes.length} cambios en ${adapter.name}?${orphanNote}` });
      if (p.isCancel(ok) || !ok) {
        p.log.warn(`${adapter.name}: omitido por el usuario.`);
        reportStatus(adapter.name, "skipped");
        if (id === "opencode") await rollbackBrowserControlProjection();
        continue;
      }
      // La confirmación puede quedar abierta un buen rato: re-planificar para
      // no pisar lo que el runtime escribiera entremedias (p.ej. ~/.claude.json).
      try {
        plan = buildPlan(adapter, { ...ctx, warnings: [] });
        diff = diffPlan(plan);
      } catch (error) {
        if (browserControlRollback === undefined) throw error;
        p.log.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        await rollbackBrowserControlProjection();
        continue;
      }
      creates = diff.filter((d) => d.status === "create");
      updates = diff.filter((d) => d.status === "update");
      changes = diff.filter((change) => change.status !== "unchanged");
    }

    if (id === "opencode") {
      try {
        // Autenticación FINAL (post-reconfirmación) que usa `writeManifest`: una
        // creación ajena current durante el prompt debe ser un no-op unowned y
        // no un owned reclamado por la lista cacheada anterior al prompt. Debe
        // reautenticar el mismo conjunto completo que el preflight (los estáticos
        // legacy MÁS los adicionales current-only MÁS la skill Browser Control): omitir la skill dejaría
        // reclamar como owned o pisar un archivo ajeno creado durante el prompt.
        const finalStaticAuths = openCodeStaticResourceAuths(adapter, ctx, plan, prevManifest?.owned ?? []);
        const finalBrowserSkillAuth = browserControlSkillAuth(configDir, ctx, prevManifest?.owned ?? []);
        if (finalBrowserSkillAuth !== null) finalStaticAuths.push(finalBrowserSkillAuth);
        assertOpenCodeStaticResourcesUsable(finalStaticAuths);
        preservedStaticTargets = unownedCurrentTargets(finalStaticAuths);
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        reportStatus(adapter.name, "failed");
        await rollbackBrowserControlProjection();
        continue;
      }
    }

    // Transacción acotada de proyección: con una promoción Browser Control
    // pendiente, un fallo de backup/escritura no debe dejar active B/config A
    // ni escapar como excepción no controlada. Los snapshots y la recuperación
    // se preparan DENTRO de la guarda: un leaf inseguro o un error de FS se
    // controla antes de cualquier escritura y no se omite ningún target.
    let projectionSnapshots: Map<string, ProjectionTargetSnapshot> | null = null;
    const ownershipRecords = new Map<string, OwnershipClaimRecord>();
    // Evidencia FS de target (onWritten) separada de la evidencia de persistencia
    // de claims (callback de ownership). Con una promoción BC pendiente el
    // callback usa el wrapper transaccional por campo; sin ella, la API existente
    // no cambia.
    const markWritten = (action: FileAction): void => {
      const snap = projectionSnapshots?.get(path.resolve(action.target));
      if (snap === undefined) return;
      snap.written = true;
      try {
        const stat = fs.lstatSync(snap.target);
        snap.afterIdentity = { dev: stat.dev, ino: stat.ino };
      } catch {
        snap.afterIdentity = null;
      }
    };
    let dirty: PlannedChange[] = [];
    try {
      if (browserControlRollback !== undefined) projectionSnapshots = snapshotProjectionTargets(changes);
      const backup = useManifest ? createBackup([...updates.map((c) => c.action.target), ...orphans], `install-${id}`) : null;
      if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

      applyChanges(
        changes,
        browserControlRollback === undefined ? undefined : markWritten,
        useManifest
          ? (browserControlRollback !== undefined
              ? (action) => persistOwnershipClaimsTracked(action, id, configDir, ownershipRecords)
              : (action) => persistConfigurationOwnershipChanges(id, configDir, [action]))
          : undefined,
      );

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
      dirty = diffPlan(buildPlan(adapter, verifyCtx)).filter((d) => d.status !== "unchanged");
    } catch (error) {
      // Sin promoción Browser Control pendiente se conserva la propagación
      // original; con ella, el fallo tras promover B se recupera de forma
      // acotada para no dejar el active/config inconsistentes.
      if (browserControlRollback === undefined) throw error;
      p.log.error(
        `${adapter.name}: fallo al aplicar la proyección (${error instanceof Error ? error.message : String(error)}); se verifica la recuperación acotada antes de restaurar el active previo.`,
      );
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      // Un snapshot fallido antes de escribir deja el estado intacto en A: el
      // rollback es seguro. Con escrituras parciales, solo se restaura el active
      // si TODA la evidencia propia (targets y claims) se pudo revertir; si no,
      // se conserva el estado observado y se reportan ambos errores sin declarar
      // coherencia falsa.
      const recovered = projectionSnapshots === null
        ? true
        : recoverProjection([...projectionSnapshots.values()], [...ownershipRecords.values()]);
      if (recovered) {
        await rollbackBrowserControlProjection();
      } else {
        p.log.error(
          `${adapter.name}: la proyección parcial no pudo recuperarse por completo (drift ajeno, leaf inseguro o ledger no verificable); se conserva el estado observado y NO se restaura el active para no declarar una coherencia falsa. Revisa el estado gestionado antes de reintentar.`,
        );
      }
      continue;
    }
    if (dirty.length > 0) {
      p.log.error(`${adapter.name}: verificación de idempotencia FALLÓ (${dirty.length} acciones inestables).`);
      for (const d of dirty.slice(0, 10)) p.log.message(`  ! ${d.action.target}`);
      exitCode = 1;
      reportStatus(adapter.name, "failed");
      // No se hace rollback aquí: la config ya apunta al active promovido y
      // retirarlo dejaría un MCP colgando. La pasada ya falla y un sync posterior
      // repara; el rollback solo aplica antes de cualquier escritura.
    } else {
      if (id === "opencode") opencodeProjectionApplied = true;
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
          if (id === "opencode") browserControlRollback = undefined;
          reportStatus(adapter.name, browserControlPending && id === "opencode" ? "failed" : "ok");
        }
      }
    }
  }

  // El pendiente de Browser Control es un fallo honesto del resultado por capa:
  // el install no se declara completo ni con éxito mientras falte la capacidad
  // obligatoria. El estado del runtime ya se reportó como fallido en el bucle.
  if (browserControlPending) exitCode = 1;

  // T13: opt-in Linux explícito. Con el active verificado, materializa la unidad
  // fija. Una unidad ausente se preflight-ea (ausencia relay+manager), se crea y
  // el supervisor la activa (`daemon-reload`, verificación de la unidad propia
  // inactiva, `--no-reload enable`, `start`, manager operativo + `/version` con
  // pid/version/build y readback estable); después se reconcilia el entorno
  // canónico en el MCP ya generado. La autoridad solo se estampa si esta
  // ejecución introdujo el entorno ausente (readback no-op) o si reutiliza una
  // estampa previa acreditada por hash; un entorno canónico manual sin claim se
  // conserva con conflicto. Una unidad ya existente solo se verifica, sin
  // recargar/arrancar/reescribir. Un opt-in ausente o un runtime pendiente
  // nunca toca la unidad. La autoridad granular previa (estampa propia) también
  // habilita la reconciliación de solo lectura: un update A→B sin nuevo opt-in
  // no debe dejar un FALSE/puerto stale ni conservar una estampa ya inaplicable.
  const opencodeServiceRow = useManifest ? readManifest().runtimes.opencode : undefined;
  const ownAutostartAuthority = opencodeServiceRow?.browserControlAutostart !== undefined;
  if (
    (opts.browserControlService === true || ownAutostartAuthority)
    && process.platform === "linux"
    && useManifest
    && !opts.dryRun
    && browserControlRuntime?.kind === "ready"
  ) {
    if (opencodeProjectionApplied && opencodeConfigDir !== undefined) {
      const configDir = opencodeConfigDir;
      const serviceConfigBase = resolveBrowserControlServiceConfigBase();
      const unitPath = resolveBrowserControlServiceUnitPath();
      if (serviceConfigBase === null || unitPath === null) {
        p.log.error(
          "Browser Control: el XDG config efectivo no es una ruta absoluta válida; no se crea la unidad ni se toca el perfil personal.",
        );
        exitCode = 1;
      } else if (!samePath(configDir, path.join(serviceConfigBase, "opencode"))) {
        p.log.error(
          `Browser Control: el perfil de la unidad (${serviceConfigBase}) no coincide con el configDir de OpenCode (${configDir}); no se crea la unidad.`,
        );
        exitCode = 1;
      } else {
        const invocation = browserControlRuntime.invocation;
        const runner = opts.systemctlRunner ?? createSystemctlRunner();
        const row = readManifest().runtimes.opencode;
        const unitResolved = path.resolve(unitPath);
        let occupied = false;
        try {
          fs.lstatSync(unitPath);
          occupied = true;
        } catch {
          occupied = false;
        }
        // Una unidad nueva exige ausencia comprobada de relay y manager ANTES de crear.
        let preflightPending: string | null = null;
        if (!occupied && opts.browserControlService !== true) {
          // Sin opt-in explícito solo se verifica una unidad ya gestionada: una
          // estampa previa sin unidad presente es drift y no autoriza crear ni
          // arrancar nada (falla cerrado conservando la autoridad).
          preflightPending =
            `hay una estampa de autostart previa pero la unidad ${unitPath} no está presente (drift); ` +
            "se conserva la autoridad y no se crea ni arranca sin el opt-in explícito.";
        } else if (!occupied) {
          const relayPort = browserControlServicePort ?? resolveBrowserControlRelayPort();
          if (relayPort === null) {
            preflightPending = "el puerto efectivo del servicio no es un entero válido (1-65535); no se crea ni arranca el servicio.";
          } else {
            const preflight = await preflightBrowserControlServiceUnit({ runner, port: relayPort });
            if (preflight.kind === "pending") preflightPending = preflight.reason;
          }
        }
        if (preflightPending !== null) {
          p.log.error(`Browser Control: ${preflightPending} La unidad no se ha modificado ni arrancado.`);
          exitCode = 1;
        } else {
          const result = ensureBrowserControlServiceUnit({
            stateDir: dataDir(),
            unitPath,
            prevOwned: row?.owned ?? [],
            ...(row?.serviceUnit === undefined ? {} : { prevBinding: row.serviceUnit }),
            ...(browserControlServicePort === undefined ? {} : { port: browserControlServicePort }),
          });
          if (result.kind === "created" || result.kind === "unchanged") {
            if (row !== undefined) {
              writeRuntimeManifest("opencode", {
                ...row,
                owned: [...new Set([...row.owned, unitResolved])],
                serviceUnit: result.binding,
                updatedAt: new Date().toISOString(),
              });
            }
            if (result.kind === "unchanged") {
              p.log.warn(
                `Browser Control: unidad de servicio ya presente en ${result.unitPath} (release ${result.binding.releaseDirectory}); se verifica sin recargar, arrancar ni reescribir.`,
              );
              // Rotación A→B: el preflight ya autenticó (solo lectura) la estampa
              // previa contra el active A y acreditó la unidad A inactiva con el
              // relay ausente ANTES de escribir B. Aquí solo se aplica la
              // retirada del entorno propio y su readback; la estampa solo se
              // retira tras confirmar que la proyección ya no contiene los
              // campos propios. Nunca se recrea con el hash deseado de B ni se
              // recarga/arranca/reescribe la unidad histórica.
              if (browserControlRetire.kind === "retire") {
                const retired = retireBrowserControlEnvironment({
                  configDir,
                  invocation,
                  port: browserControlRetire.port,
                  portOwned: browserControlRetire.portOwned,
                });
                if (retired.kind === "blocked") {
                  p.log.error(
                    `Browser Control: ${retired.reason}; se conserva la autoridad y el entorno sin retirar.`,
                  );
                  exitCode = 1;
                } else {
                  let wrote = false;
                  if (retired.kind === "retired") {
                    const backup = createBackup([retired.file], "install-browser-control-service");
                    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);
                    try {
                      writeText(retired.file, retired.content);
                      wrote = true;
                    } catch (error) {
                      p.log.error(
                        `Browser Control: no se pudo retirar el entorno gestionado (${error instanceof Error ? error.message : String(error)}); se conserva la autoridad.`,
                      );
                      exitCode = 1;
                    }
                  }
                  if (wrote || retired.kind === "unchanged") {
                    // Readback: la estampa solo se retira tras confirmar que la
                    // proyección gestionada ya no contiene los campos propios.
                    const readback = retireBrowserControlEnvironment({
                      configDir,
                      invocation,
                      port: browserControlRetire.port,
                      portOwned: browserControlRetire.portOwned,
                    });
                    if (readback.kind !== "unchanged") {
                      const detail = "reason" in readback ? readback.reason : "estado inesperado";
                      p.log.error(
                        `Browser Control: el readback de la retirada no quedó estable (${detail}); no se retira la estampa.`,
                      );
                      exitCode = 1;
                    } else {
                      const currentRow = readManifest().runtimes.opencode;
                      if (currentRow !== undefined && currentRow.browserControlAutostart !== undefined) {
                        const nextRow = { ...currentRow };
                        delete nextRow.browserControlAutostart;
                        writeRuntimeManifest("opencode", {
                          ...nextRow,
                          updatedAt: new Date().toISOString(),
                        });
                      }
                      p.log.success(
                        `Browser Control: entorno de autostart gestionado retirado; la unidad ${result.unitPath} y su binding A se conservan sin recargar ni reiniciar.`,
                      );
                    }
                  }
                }
              } else {
                // Sin rotación A→B: una unidad existente solo se verifica en SOLO
                // LECTURA (manager/HTTP/release/build estables) y, cuando el
                // servicio queda acreditado operativo, se completa únicamente el
                // entorno de autostart propio aún pendiente. Un estado
                // ausente/inactivo/incierto mantiene el servicio pendiente con
                // salida no cero, sin mutar el manager ni reescribir la unidad.
                const verified = await inspectOwnedServiceUnitRetirement({
                  stateDir: dataDir(),
                  configDir,
                  unitPath,
                  binding: result.binding,
                  runner,
                });
                if (verified.kind === "operational") {
                  // Coherencia de fuente: el binding histórico A debe reproducir
                  // EXACTAMENTE la invocación MCP efectiva actual (comando/args
                  // completos del guard retenido), no solo versión o digest. Una
                  // unidad A reactivada que sirve una release distinta del
                  // active/MCP B no puede acreditar el servicio externo para B.
                  const invocationError = authenticateOwnedServiceUnitInvocation(
                    dataDir(),
                    result.binding,
                    invocation,
                  );
                  if (invocationError !== null) {
                    p.log.error(
                      `Browser Control: ${invocationError}; la unidad ${result.unitPath} se conserva y el servicio queda pendiente sin completar el entorno de autostart.`,
                    );
                    exitCode = 1;
                  } else {
                    const code = reconcileVerifiedBrowserControlEnvironment({
                      configDir,
                      invocation,
                      port: verified.port,
                      releaseDirectory: result.binding.releaseDirectory,
                      unitPath: result.unitPath,
                      prior: row?.browserControlAutostart,
                    });
                    if (code !== 0) exitCode = 1;
                  }
                } else {
                  const detail = verified.kind === "inactive"
                    ? "la unidad existente está inactiva y el relay ausente"
                    : verified.reason;
                  p.log.error(
                    `Browser Control: la unidad existente ${result.unitPath} no acredita un servicio operativo (${detail}); el servicio queda pendiente sin completar el entorno de autostart.`,
                  );
                  exitCode = 1;
                }
              }
            } else {
              const supervised = await superviseBrowserControlServiceUnit({
                stateDir: dataDir(),
                unitPath,
                binding: result.binding,
                runner,
              });
              if (supervised.kind === "pending") {
                p.log.error(
                  `Browser Control: la unidad ${result.unitPath} se creó pero el servicio queda pendiente/no operativo (${supervised.reason}); no se declara autostart externo.`,
                );
                exitCode = 1;
              } else {
                const code = reconcileVerifiedBrowserControlEnvironment({
                  configDir,
                  invocation,
                  port: supervised.port,
                  releaseDirectory: result.binding.releaseDirectory,
                  unitPath: result.unitPath,
                  prior: row?.browserControlAutostart,
                });
                if (code !== 0) exitCode = 1;
              }
            }
          } else if (result.kind === "preserved") {
            p.log.warn(`Browser Control: se conserva la unidad existente en ${result.unitPath} (${result.reason})`);
          } else if (result.kind === "error") {
            p.log.error(`Browser Control: ${result.reason}`);
            exitCode = 1;
          }
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
          // La adquisición global nunca reclama OpenCode (selector retirado) ni
          // consume la elección pendiente de Pi, que se persiste por su propio
          // handoff: el registro de fichero solo conserva el resto de runtimes.
          const fileSelection = selected === undefined ? undefined
            : Object.fromEntries(Object.entries(selected).filter(([runtime]) => runtime !== "pi" && runtime !== "opencode"));
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
            p.log.error("Playwright CLI y navegador se han instalado y la preferencia quedó activa, pero la guía de navegador quedó en estado parcial. Ejecuta 'jorgex-stack install' para repararla.");
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
