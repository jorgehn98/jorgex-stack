import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { FileAction, OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import { ADAPTERS, buildContentPlan, makeContext } from "./install.js";
import { DEVTOOLS_MCP_SERVER, loadCanonicalHooks, loadCanonicalMcp, materializeCanonicalDevtoolsServerForRemoval } from "./lib/canonical.js";
import { createBackup } from "./lib/backup.js";
import { isContainedIn, pruneEmptyDirs, writeText } from "./lib/fsx.js";
import { readManifest, removeRuntimeManifest } from "./lib/manifest.js";
import {
  authenticateStaticResource,
  projectedBytesByTarget,
  staticResourceBlockReason,
  staticResourceTargets,
  type StaticResourceRow,
} from "./lib/opencode-static-resources.js";
import { inspectOpencodePluginFile } from "./adapters/opencode.js";
import { HOME, stackRoot } from "./lib/paths.js";
import { readRealPiProjectionOwned } from "./lib/pi-projection-lifecycle.js";
import { assertSystemPromptFile } from "./lib/system-prompt-sections.js";
import {
  browserPreferenceErrors,
  devtoolsMcpPreferenceFile,
  playwrightCliPreferenceFile,
  primaryModelOwnershipError,
  primaryModelOwnershipFile,
  saveDevtoolsMcpOwnership,
  savePlaywrightCliPreference,
  savePrimaryModelOwnership,
} from "./lib/tool-preferences.js";

export interface UninstallOptions extends OpenCodeTargetEvidenceOption {
  runtimes: RuntimeId[];
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  /** D7: desregistrar Engram exige el sí explícito (flag o confirmación). */
  removeEngram: boolean;
  /** Desactiva el opt-in gestionado; nunca retira paquetes globales ajenos. */
  removePlaywright: boolean;
}

export function resolvePlaywrightUninstallPlan(input: { disableManaged: boolean }): {
  disablePreference: boolean;
  preserveBrowserData: boolean;
} {
  return {
    disablePreference: input.disableManaged,
    preserveBrowserData: true,
  };
}

/**
 * Chequeo de preservación (`engram setup opencode`, misma ruta que el legacy):
 * se conserva en uninstall tanto el contenido oficial como una lectura
 * desconocida (fail closed). Solo el legacy aún propio puede retirarse con
 * --remove-engram. Usa la clasificación compartida; `unknown` jamás se
 * clasifica como legacy.
 */
export function isOfficialEngramPluginFile(file: string): boolean {
  const state = inspectOpencodePluginFile(file);
  return state === "official" || state === "unknown";
}

/**
 * Retira SOLO lo gestionado por el stack (criterio de aceptación 6 del PRD):
 * borra los archivos enteramente nuestros y reescribe los compartidos sin
 * nuestras secciones/claves. Backup automático antes de tocar nada.
 */
export async function runUninstall(opts: UninstallOptions): Promise<number> {
  p.intro(`jorgex-stack ${opts.dryRun ? "uninstall (dry-run)" : "uninstall"}`);
  try {
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
  const useBrowserPreferences = opts.targetDir === undefined;
  const preferenceErrors = useBrowserPreferences
    ? [...browserPreferenceErrors(), primaryModelOwnershipError()].filter((error): error is string => error !== null)
    : [];
  if (preferenceErrors.length > 0) {
    for (const error of preferenceErrors) p.log.error(error);
    p.outro("Uninstall cancelado: corrige el estado de configuración indicado arriba antes de reintentar.");
    return 1;
  }
  const removesSharedSkills = opts.runtimes.some((runtime) => runtime === "codex" || runtime === "opencode");
  const piProjection = useBrowserPreferences && removesSharedSkills
    ? readRealPiProjectionOwned()
    : { kind: "absent" as const };
  if (piProjection.kind === "corrupt") {
    p.log.error(`Pi: receipt de proyección inválido en ${piProjection.file}. Restaura o repara ese receipt antes de reintentar.`);
    p.outro("Uninstall cancelado: restaura o repara el receipt de proyección de Pi antes de reintentar.");
    return 1;
  }
  if (piProjection.kind === "unreadable") {
    p.log.error(`Pi: receipt de proyección ilegible en ${piProjection.file} (${piProjection.code}). Revisa los permisos o el estado de E/S antes de reintentar.`);
    p.outro("Uninstall cancelado: revisa los permisos o el estado de E/S del receipt de proyección de Pi antes de reintentar.");
    return 1;
  }
  const stackDir = stackRoot();
  const mcp = loadCanonicalMcp(stackDir);
  const hooks = loadCanonicalHooks(stackDir);
  let exitCode = 0;

  // D7: Engram guarda las memorias del usuario. Por defecto se CONSERVA todo
  // (registro MCP, plugin engram.ts); desregistrarlo exige el sí explícito.
  // Las memorias (~/.engram) y el binario no se tocan en ningún caso.
  let removeEngram = opts.removeEngram;
  if (!removeEngram && !opts.yes && !opts.dryRun && process.stdout.isTTY) {
    const answer = await p.confirm({
      message:
        "¿Quitar también el registro de Engram (MCP/plugin) de los runtimes? Tus memorias (~/.engram) y el binario NO se tocan en ningún caso.",
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelado — no se ha tocado nada.");
      return 1;
    }
    removeEngram = answer === true;
  }
  const mcpForUnmerge = removeEngram
    ? mcp
    : { servers: Object.fromEntries(Object.entries(mcp.servers).filter(([name]) => name !== "engram")) };
  if (!removeEngram) {
    p.log.info("Engram se conserva: memorias, binario y registro intactos (usa --remove-engram para desregistrarlo).");
  }

  // Archivos compartidos entre runtimes (p.ej. ~/.agents/skills sirve a Codex
  // Y OpenCode): si un runtime que NO se desinstala sigue instalado, sus
  // targets se conservan — desinstalar Codex no debe llevarse las skills que
  // OpenCode usa.
  const retained = new Set<string>();
  if (useBrowserPreferences) {
    if (piProjection.kind === "valid") {
      for (const target of piProjection.owned) retained.add(target);
    }
    for (const keep of Object.values(ADAPTERS)) {
      if (opts.runtimes.includes(keep.id)) continue;
      const detection = keep.detect();
      if (!detection.installed) continue;
      const keepCtx = makeContext(keep, detection.configDir, undefined, true, undefined, false);
      if (!keepCtx) continue;
      for (const action of buildContentPlan(keep, keepCtx)) retained.add(path.resolve(action.target));
    }
  }

  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) {
      p.log.warn(`${id}: sin adapter — omitido.`);
      continue;
    }
    const detection = adapter.detect();
    const configDir = opts.targetDir ?? detection.configDir;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado — omitido.`);
      continue;
    }
    let ctx: ReturnType<typeof makeContext>;
    try { ctx = makeContext(adapter, configDir, undefined, useBrowserPreferences, undefined, undefined, opts.targetDir); }
    catch (error) {
      p.log.error(`${adapter.name}: no se pudo verificar el estado managed browser (${error instanceof Error ? error.message : String(error)}).`);
      exitCode = 1;
      continue;
    }
    if (!ctx) continue;
    ctx.preserveEngram = !removeEngram;

    let unmerge: FileAction[];
    try {
      const devtools = mcpForUnmerge.servers[DEVTOOLS_MCP_SERVER];
      const scopedMcp = devtools !== undefined && ctx.ownedMcpServers?.has(DEVTOOLS_MCP_SERVER)
        ? { servers: { ...mcpForUnmerge.servers, [DEVTOOLS_MCP_SERVER]: {
          ...materializeCanonicalDevtoolsServerForRemoval(devtools, ctx.devtoolsMcpObservedVersion),
          ...(ctx.devtoolsMcpInvocation === undefined ? {} : {
            command: ctx.devtoolsMcpInvocation.command,
            args: [...ctx.devtoolsMcpInvocation.args],
          }),
        } } }
        : mcpForUnmerge;
      unmerge = adapter.planUnmerge(scopedMcp, hooks, ctx);
    } catch (error) {
      p.log.error(`${adapter.name}: no se pudo planificar la limpieza en ${configDir} — ${error instanceof Error ? error.message : String(error)}.`);
      exitCode = 1;
      continue;
    }
    const mergedTargets = new Set(unmerge.map((a) => path.resolve(a.target)));
    // Lo instalado = plan actual ∪ manifest (cubre archivos que versiones
    // anteriores instalaron y el plan actual ya no genera).
    const usingRealConfig = opts.targetDir === undefined;
    const prevOwned = usingRealConfig ? (readManifest().runtimes[id]?.owned ?? []) : [];
    // En instalación real los targets pueden vivir fuera del configDir
    // (~/.agents/skills): borrado y poda se anclan a HOME. Nada fuera de esa
    // frontera se borra, aunque el manifest (estado local editable) lo liste.
    const pruneRoot = usingRealConfig ? HOME : path.dirname(configDir);
    const planTargets = [
      ...new Set([...buildContentPlan(adapter, ctx).map((a) => path.resolve(a.target)), ...prevOwned.map((t) => path.resolve(t))]),
    ].filter((t) => !mergedTargets.has(t) && fs.existsSync(t));

    // Recursos estáticos OpenCode: unowned → se omiten sin leer/borrar/reclamar;
    // owned → solo se retiran con bytes actuales o legacy v1 acreditados. Un
    // owned modificado/desconocido/enlace bloquea ANTES de backup o borrado.
    const staticResources = id === "opencode" ? staticResourceTargets(configDir) : new Map<string, StaticResourceRow>();
    const skippedStaticTargets = new Set<string>();
    let staticBlock: string | null = null;
    if (staticResources.size > 0) {
      const projected = projectedBytesByTarget(buildContentPlan(adapter, ctx));
      const ownedSet = new Set(prevOwned.map((t) => path.resolve(t)));
      for (const [target, row] of staticResources) {
        if (!ownedSet.has(target)) {
          skippedStaticTargets.add(target);
          continue;
        }
        const auth = authenticateStaticResource(target, row, projected.get(target) ?? null, true, configDir);
        const reason = staticResourceBlockReason(auth);
        if (reason !== null) {
          staticBlock = reason;
          break;
        }
      }
    }
    if (staticBlock !== null) {
      p.log.error(`OpenCode: ${staticBlock} No se borra ni respalda nada; el ownership se conserva.`);
      exitCode = 1;
      continue;
    }

    const deleteTargets = planTargets.filter((t) => {
      if (skippedStaticTargets.has(t) || retained.has(t) || !isContainedIn(t, pruneRoot)) return false;
      if (path.basename(t) !== "engram.ts") return true;
      // Tri-estado del plugin oficial: official y unknown se preservan;
      // legacy-or-foreign y absent solo se retiran con --remove-engram.
      const state = inspectOpencodePluginFile(t);
      if (state === "official" || state === "unknown") return false;
      return !ctx.preserveEngram;
    });
    const sharedKept = planTargets.length - deleteTargets.length;

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(`${deleteTargets.length} archivos a borrar, ${unmerge.length} archivos compartidos a limpiar`);
    if (sharedKept > 0) p.log.info(`${sharedKept} archivos se conservan: otros runtimes instalados los siguen usando.`);

    if (opts.dryRun) continue;

    let backup;
    try {
      backup = createBackup(
        [...deleteTargets, ...unmerge.map((a) => a.target).filter((t) => fs.existsSync(t))],
        `uninstall-${id}`,
      );
    } catch (error) {
      p.log.error(`${adapter.name}: no se pudo respaldar una configuración ilegible en ${configDir} — ${error instanceof Error ? error.message : String(error)}.`);
      exitCode = 1;
      continue;
    }
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    for (const target of deleteTargets) {
      fs.rmSync(target, { force: true });
      pruneEmptyDirs(target, pruneRoot);
    }
    for (const action of unmerge) {
      if (action.kind !== "write") continue;
      if (action.content.trim() === "") {
        fs.rmSync(action.target, { force: true });
      } else {
        writeText(action.target, action.content);
      }
      if (usingRealConfig) {
        for (const change of action.mcpOwnership ?? []) {
          saveDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), id, change.server, change.owned);
        }
        for (const change of action.primaryModelOwnership ?? []) {
          savePrimaryModelOwnership(primaryModelOwnershipFile(), id, configDir, change.field, change.owned);
        }
      }
    }
    if (usingRealConfig) {
      for (const field of ctx.ownedPrimaryModelFields ?? []) {
        savePrimaryModelOwnership(primaryModelOwnershipFile(), id, configDir, field, false);
      }
    }
    if (usingRealConfig) removeRuntimeManifest(id);
    p.log.success(`${adapter.name}: stack retirado (lo tuyo queda intacto).`);
  }

  // --target-dir no modifica la preferencia real; un global ajeno nunca es propio.
  const playwrightPlan = resolvePlaywrightUninstallPlan({
    disableManaged: opts.targetDir === undefined && opts.removePlaywright,
  });
  if (opts.removePlaywright && opts.targetDir !== undefined) {
    p.log.info("Playwright CLI: --target-dir conserva la preferencia, el árbol gestionado y los datos del navegador.");
  } else if (playwrightPlan.disablePreference) {
    if (opts.dryRun) {
      p.log.info("Playwright CLI: se desactivaría la preferencia; árbol gestionado, paquetes globales y navegadores se conservan.");
    } else {
      try {
        const file = playwrightCliPreferenceFile();
        if (fs.existsSync(file)) createBackup([file], "uninstall-playwright-preference");
        savePlaywrightCliPreference(file, false);
        p.log.success("Playwright CLI: preferencia desactivada; árbol gestionado, paquetes globales y navegadores conservados.");
      } catch (error) {
        p.log.error(`Playwright CLI: no se pudo desactivar la preferencia (${error instanceof Error ? error.message : String(error)}). Corrígela y reintenta.`);
        exitCode = 1;
      }
    }
  } else {
    p.log.info("Playwright CLI: preferencia, árbol gestionado, paquetes globales y datos del navegador conservados.");
  }

  p.outro(opts.dryRun
    ? "Dry-run: no se ha tocado nada."
    : exitCode === 0
      ? "Hecho. Usa 'restore' si quieres volver atrás."
      : "Uninstall completado con errores (revisa arriba).");
  return exitCode;
}
