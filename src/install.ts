import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Adapter, FileAction, InstallContext, InstallModePreference, RuntimeId } from "./adapters/types.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { HOME, stackRoot } from "./lib/paths.js";
import { detectEngram } from "./lib/detect.js";
import { copyFile, pruneEmptyDirs, readTextIfExists, sameFileContent, writeText } from "./lib/fsx.js";
import { ensureModelMapFile, loadModelMap } from "./lib/model-map.js";
import { DEFAULT_INSTALL_MODE_PREFERENCE, installModePreferenceFile, loadInstallModePreference, normalizeInstallModePreference, saveInstallModePreference } from "./lib/install-mode.js";
import { createBackup } from "./lib/backup.js";
import { DEVTOOLS_MCP_SERVER, loadCanonicalHooks, loadCanonicalMcp } from "./lib/canonical.js";
import { findOrphans, readManifest, writeRuntimeManifest } from "./lib/manifest.js";
import { planSystemPrompt } from "./components/system-prompt.js";
import { planAgents } from "./components/agents.js";
import { planSkills } from "./components/skills.js";
import { planCommands } from "./components/commands.js";
import { planHooks } from "./components/hooks.js";
import { planMcp } from "./components/mcp.js";
import { planPlugins } from "./components/plugins.js";
import {
  detectPlaywrightCli,
  executePlaywrightToolAction as executeExternalPlaywrightToolAction,
  isPlaywrightBrowserReady,
  resolvePnpmBin,
  resolvePnpmFailureRemedy,
  type PlaywrightCliAction,
  type PlaywrightToolActionFailureReason,
  type PlaywrightToolActionResult,
} from "./lib/external-tools.js";
import {
  browserPreferenceErrors,
  devtoolsMcpPreferenceFile,
  loadDevtoolsMcpOwnership,
  loadDevtoolsMcpPreference,
  loadPlaywrightCliPreference,
  loadPrimaryModelOwnership,
  playwrightCliPreferenceFile,
  primaryModelOwnershipError,
  primaryModelOwnershipFile,
  saveDevtoolsMcpPreference,
  saveDevtoolsMcpOwnership,
  savePlaywrightCliPreference,
  savePrimaryModelOwnership,
} from "./lib/tool-preferences.js";

export const ADAPTERS: Partial<Record<RuntimeId, Adapter>> = {
  opencode: opencodeAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export interface InstallOptions {
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
  /** Elecciones explícitas del MCP DevTools para este install; undefined usa el estado persistido. */
  devtoolsMcpSelection?: Partial<Record<RuntimeId, boolean>>;
}

export type PlaywrightToolAction = Extract<PlaywrightCliAction, "install" | "install-browser" | "remove">;
export type PlaywrightInstallAction = Exclude<PlaywrightToolAction, "remove">;

/** Puente de instalación al ejecutor tipado de external-tools. */
export function executePlaywrightToolAction(action: PlaywrightCliAction): PlaywrightToolActionResult {
  return executeExternalPlaywrightToolAction(action, resolvePnpmBin());
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
}

export interface PlaywrightToolPlanDeps {
  run: (action: PlaywrightInstallAction) => Promise<boolean | PlaywrightToolActionResult>;
  persistEnabled: (enabled: boolean) => void;
}

export type PlaywrightToolPlanResult =
  | { ok: true }
  | {
      ok: false;
      failedAction: PlaywrightInstallAction | "persist";
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
): Promise<PlaywrightToolPlanResult> {
  for (const action of plan.actions) {
    try {
      const result = await deps.run(action);
      if (result === false) return { ok: false, failedAction: action };
      if (result !== true && !result.ok) return { ok: false, failedAction: action, reason: result.reason };
    } catch {
      return { ok: false, failedAction: action };
    }
  }
  if (plan.persistEnabledOnSuccess) {
    try {
      deps.persistEnabled(true);
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

function ownedMcpServers(runtime: RuntimeId, useBrowserPreferences = true): ReadonlySet<string> {
  if (!useBrowserPreferences) return new Set();
  const file = devtoolsMcpPreferenceFile();
  return loadDevtoolsMcpOwnership(file, runtime, DEVTOOLS_MCP_SERVER) ? new Set([DEVTOOLS_MCP_SERVER]) : new Set();
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

/** Contexto de instalación para un runtime, o null si no hay model-map. */
export function makeContext(
  adapter: Adapter,
  configDir: string,
  mode: InstallModePreference = DEFAULT_INSTALL_MODE_PREFERENCE,
  useBrowserPreferences = true,
): InstallContext | null {
  const models = loadModelMap()[adapter.id];
  if (!models) return null;
  return {
    stackDir: stackRoot(),
    configDir,
    mode: mode.mode,
    subagentConcurrency: mode.subagentConcurrency,
    engramBin: detectEngram(),
    models,
    warnings: [],
    enabledMcpServers: enabledMcpServers(adapter.id, undefined, useBrowserPreferences),
    playwrightCliEnabled: useBrowserPreferences && loadPlaywrightCliPreference() === true,
    ownedMcpServers: ownedMcpServers(adapter.id, useBrowserPreferences),
    ownedPrimaryModelFields: useBrowserPreferences
      ? loadPrimaryModelOwnership(primaryModelOwnershipFile(), adapter.id, configDir)
      : new Set(),
  };
}

export function buildPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planAgents(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
    ...planHooks(adapter, ctx),
    ...planMcp(adapter, ctx),
    ...planPlugins(adapter, ctx),
  ];
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
): { targets: Set<string>; complete: boolean; warnings: string[] } {
  const targets = new Set<string>();
  let complete = true;
  const warnings: string[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const detection = adapter.detect();
    if (!detection.installed) continue;
    const ctx = makeContext(adapter, detection.configDir, mode);
    if (!ctx) {
      complete = false;
      warnings.push(`${adapter.name}: limpieza de huérfanos deshabilitada — falta contexto/model-map instalable para este runtime.`);
      continue;
    }
    try {
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

export async function runInstall(opts: InstallOptions): Promise<number> {
  p.intro(`jorgex-stack ${opts.dryRun ? "install (dry-run)" : "install"}`);

  const stackDir = stackRoot();
  const engramBin = detectEngram();
  const modePreference = opts.mode === undefined
    ? (opts.targetDir === undefined ? loadInstallModePreference() : DEFAULT_INSTALL_MODE_PREFERENCE)
    : normalizeInstallModePreference(opts.mode);
  const useManifest = opts.targetDir === undefined;
  const preferenceErrors = useManifest
    ? [...browserPreferenceErrors(), primaryModelOwnershipError()].filter((error): error is string => error !== null)
    : [];
  if (preferenceErrors.length > 0) {
    for (const error of preferenceErrors) p.log.error(error);
    p.outro("Install cancelado: corrige el estado de configuración indicado arriba antes de reintentar.");
    return 1;
  }
  const toolPlan = opts.playwrightToolConsent === undefined
    ? null
    : resolvePlaywrightToolPlan({
      ...opts.playwrightToolConsent,
      targetDir: opts.targetDir !== undefined || opts.playwrightToolConsent.targetDir,
    });
  const projectPlaywrightPrompt = opts.dryRun && toolPlan?.persistEnabledOnSuccess === true;
  const modelMap = loadModelMap();
  if (useManifest) ensureModelMapFile();

  p.log.info(engramBin ? `Engram detectado: ${engramBin} (se respeta, D7)` : "Engram NO detectado.");

  // El manifest solo aplica a instalaciones reales; --target-dir es de pruebas.
  const current = useManifest
    ? collectAllCurrentTargets(modePreference)
    : { targets: new Set<string>(), complete: false, warnings: [] as string[] };
  const canOrphan = useManifest && current.complete;
  const canonicalMcp = loadCanonicalMcp(stackDir);
  const canonicalHooks = loadCanonicalHooks(stackDir);

  if (useManifest && (!current.complete || current.warnings.length > 0)) {
    p.log.warn("Limpieza de huérfanos deshabilitada: no se pudo construir el plan completo de todos los runtimes.");
    for (const warning of current.warnings) p.log.warn(warning);
  }

  let exitCode = 0;
  let successfulRuns = 0;
  const successfulContexts: { adapter: Adapter; ctx: InstallContext }[] = [];
  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) {
      p.log.warn(`${id}: adapter pendiente (F3/F4) — omitido.`);
      continue;
    }

    const detection = adapter.detect();
    const configDir = opts.targetDir ?? detection.configDir;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado en esta máquina — omitido.`);
      continue;
    }
    const models = modelMap[id];
    if (!models) {
      p.log.error(`${adapter.name}: sin modelos seleccionados — ejecuta 'jorgex-stack models --agents ${id}'.`);
      exitCode = 1;
      continue;
    }

    const ctx: InstallContext = {
      stackDir,
      configDir,
      mode: modePreference.mode,
      subagentConcurrency: modePreference.subagentConcurrency,
      engramBin,
      models,
      warnings: [],
      enabledMcpServers: enabledMcpServers(id, opts.devtoolsMcpSelection?.[id], useManifest),
      playwrightCliEnabled: projectPlaywrightPrompt || (useManifest && loadPlaywrightCliPreference() === true),
      ownedMcpServers: ownedMcpServers(id, useManifest),
      ownedPrimaryModelFields: useManifest
        ? loadPrimaryModelOwnership(primaryModelOwnershipFile(), id, configDir)
        : new Set(),
    };

    const persistDevtoolsSelection = (): void => {
      const selection = opts.devtoolsMcpSelection?.[id];
      if (useManifest && selection !== undefined) {
        saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), id, selection);
      }
    };

    let plan = buildPlan(adapter, ctx);
    let diff = diffPlan(plan);
    let creates = diff.filter((d) => d.status === "create");
    let updates = diff.filter((d) => d.status === "update");
    let changes = [...creates, ...updates];

    // Huérfanos: archivos que una versión anterior instaló y el plan actual ya
    // no genera (skill renombrada/eliminada). Solo con manifest previo y visión
    // completa de los planes de todos los runtimes.
    const prevManifest = useManifest ? readManifest().runtimes[id] : undefined;
    const orphans = canOrphan && prevManifest ? findOrphans(prevManifest.owned, current.targets) : [];

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
      continue;
    }

    const writeManifest = (): void => {
      if (!useManifest) return;
      const unmergeTargets = new Set(adapter.planUnmerge(canonicalMcp, canonicalHooks, ctx).map((a) => path.resolve(a.target)));
      const keepTarget = (target: string): boolean => !unmergeTargets.has(target);
      const liveOwned = plan.map((a) => path.resolve(a.target)).filter(keepTarget);
      const previousOwned = (prevManifest?.owned ?? []).map((target) => path.resolve(target)).filter(keepTarget);
      const owned = canOrphan ? liveOwned : [...new Set([...previousOwned, ...liveOwned])];
      writeRuntimeManifest(id, { configDir, owned, updatedAt: new Date().toISOString() });
    };

    if (changes.length === 0 && orphans.length === 0) {
      writeManifest();
      if (useManifest) persistConfigurationOwnershipChanges(id, configDir, plan);
      persistDevtoolsSelection();
      p.log.success(`${adapter.name}: ya al día (idempotente).`);
      successfulRuns++;
      successfulContexts.push({ adapter, ctx });
      continue;
    }

    if (!opts.yes && process.stdout.isTTY) {
      const orphanNote = orphans.length > 0 ? ` (+ ${orphans.length} huérfanos a eliminar)` : "";
      const ok = await p.confirm({ message: `¿Aplicar ${changes.length} cambios en ${adapter.name}?${orphanNote}` });
      if (p.isCancel(ok) || !ok) {
        p.log.warn(`${adapter.name}: omitido por el usuario.`);
        continue;
      }
      // La confirmación puede quedar abierta un buen rato: re-planificar para
      // no pisar lo que el runtime escribiera entremedias (p.ej. ~/.claude.json).
      plan = buildPlan(adapter, { ...ctx, warnings: [] });
      diff = diffPlan(plan);
      creates = diff.filter((d) => d.status === "create");
      updates = diff.filter((d) => d.status === "update");
      changes = [...creates, ...updates];
    }

    const backup = useManifest ? createBackup([...updates.map((c) => c.action.target), ...orphans], `install-${id}`) : null;
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    applyChanges(changes, useManifest ? (action) => persistConfigurationOwnershipChanges(id, configDir, [action]) : undefined);
    const pruneRoot = useManifest ? HOME : path.dirname(configDir);
    for (const orphan of orphans) {
      fs.rmSync(orphan, { force: true });
      pruneEmptyDirs(orphan, pruneRoot);
    }

    // Verificación de idempotencia: re-planificar debe dar cero cambios.
    const verifyCtx: InstallContext = { ...ctx, warnings: [] };
    const dirty = diffPlan(buildPlan(adapter, verifyCtx)).filter((d) => d.status !== "unchanged");
    if (dirty.length > 0) {
      p.log.error(`${adapter.name}: verificación de idempotencia FALLÓ (${dirty.length} acciones inestables).`);
      for (const d of dirty.slice(0, 10)) p.log.message(`  ! ${d.action.target}`);
      exitCode = 1;
    } else {
      writeManifest();
      if (useManifest) persistConfigurationOwnershipChanges(id, configDir, plan);
      persistDevtoolsSelection();
      p.log.success(`${adapter.name}: ${changes.length} archivos aplicados y verificados (idempotente).`);
      successfulRuns++;
      successfulContexts.push({ adapter, ctx });
    }
  }

  if (toolPlan?.actions.length) {
    if (opts.dryRun) {
      p.log.info("Playwright CLI: instalación global y navegador previstos (dry-run; no se ejecutan).");
    } else if (exitCode === 0) {
      const result = await runPlaywrightToolPlan(toolPlan, opts.playwrightToolDeps ?? {
        run: async (action) => executePlaywrightToolAction(action),
        persistEnabled: (enabled) => savePlaywrightCliPreference(playwrightCliPreferenceFile(), enabled),
      });
      if (!result.ok) {
        const pnpmRemedy = result.reason === undefined ? null : resolvePnpmFailureRemedy(result.reason);
        const reason = result.reason === "pnpm-global-bin"
          ? `la configuración global de pnpm no está lista. ${pnpmRemedy}`
          : pnpmRemedy ?? (result.failedAction === "install"
          ? "no se pudo instalar el paquete global"
          : result.failedAction === "install-browser"
            ? "no se pudo descargar el navegador"
            : "se instalaron los componentes, pero no se pudo guardar la preferencia");
        p.log.error(`Playwright CLI: ${reason}; la preferencia no se ha marcado como habilitada. Ejecuta 'jorgex-stack install --playwright' para reintentar.`);
        exitCode = 1;
      } else {
        let promptReconciliationFailed = false;
        for (const { adapter, ctx } of successfulContexts) {
          const browserCtx: InstallContext = { ...ctx, playwrightCliEnabled: true, warnings: [] };
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
          p.log.error("Playwright CLI y navegador se han instalado y la preferencia está activada, pero la guía de navegador quedó en estado parcial. Ejecuta 'jorgex-stack sync' para repararla.");
        } else {
          p.log.success("Playwright CLI y navegador instalados.");
        }
      }
    }
  } else if (useManifest && opts.playwrightToolConsent?.command === "sync" && loadPlaywrightCliPreference() === true) {
    const cli = detectPlaywrightCli();
    if (cli.status !== "current") {
      p.log.warn("Playwright CLI sigue habilitado, pero el paquete no está listo; sync no instala herramientas. Ejecuta 'jorgex-stack install --playwright'.");
    } else {
      const browserCache = isPlaywrightBrowserReady();
      if (browserCache.status === "unreadable") {
        p.log.warn(`Playwright CLI sigue habilitado, pero no se puede leer la caché de navegadores en ${browserCache.path} (${browserCache.errorCode}). Revisa permisos o ejecuta 'jorgex-stack install --playwright'.`);
      } else if (browserCache.status === "missing") {
        p.log.warn("Playwright CLI sigue habilitado, pero falta el navegador; sync no descarga navegadores. Ejecuta 'jorgex-stack install --playwright'.");
      }
    }
  }

  if (useManifest && !opts.dryRun && exitCode === 0 && successfulRuns > 0) {
    saveInstallModePreference(installModePreferenceFile(), modePreference);
  }

  p.outro(opts.dryRun
    ? exitCode === 0
      ? "Dry-run: no se ha escrito nada."
      : "Dry-run completado con errores (revisa arriba)."
    : exitCode === 0
      ? "Hecho."
      : "Install completado con errores (revisa arriba).");
  return exitCode;
}
