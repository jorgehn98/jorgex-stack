import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { FileAction, OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import { ADAPTERS, assertOpenCodeManifestCoherence, buildContentPlan, makeContext } from "./install.js";
import { DEVTOOLS_MCP_SERVER, loadCanonicalHooks, loadCanonicalMcp, materializeCanonicalDevtoolsServerForRemoval } from "./lib/canonical.js";
import { createBackup } from "./lib/backup.js";
import {
  inspectCachedBrowserControlRuntime,
  type BrowserControlReady,
  type BrowserControlUnavailable,
} from "./lib/browser-control-runtime.js";
import { isContainedIn, pruneEmptyDirs, writeText } from "./lib/fsx.js";
import {
  isBrowserControlAutostartStamp,
  readManifest,
  removeRuntimeManifest,
  writeRuntimeManifest,
  type BrowserControlServiceRetirementPhase,
  type RuntimeManifest,
} from "./lib/manifest.js";
import {
  authenticateOwnedServiceUnitBinding,
  authenticateOwnedServiceUnitBytes,
  browserControlAutostartProjectionSha256,
  createSystemctlRunner,
  disableOwnedServiceUnit,
  inspectOwnedServiceUnitFile,
  inspectOwnedServiceUnitRetirement,
  inspectStoppedOwnedServiceUnit,
  reloadOwnedServiceUnitManager,
  removeOwnedServiceUnitFile,
  resolveBrowserControlServiceConfigBase,
  resolveBrowserControlServiceUnitPath,
  restoreOwnedServiceUnitFile,
  stopOwnedServiceUnit,
  type BrowserControlSystemctlRunner,
} from "./lib/browser-control-service.js";
import {
  authenticateStaticResource,
  projectedBytesByTarget,
  staticResourceBlockReason,
  staticResourceTargets,
  type StaticResourceRow,
} from "./lib/opencode-static-resources.js";
import {
  inspectBrowserControlEnvironmentRetirement,
  inspectOpencodePluginFile,
  retireBrowserControlEnvironment,
} from "./adapters/opencode.js";
import { HOME, dataDir, samePath, stackRoot } from "./lib/paths.js";
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
  /**
   * Borde externo del manager para la retirada de la unidad de servicio Browser
   * Control owned. Sin DI, una operación real Linux sobre unidad owned usa el
   * runner de producción verificado; sin unidad owned, target-dir u otros hosts
   * no se invoca. Nunca un modo test-only del producto.
   */
  systemctlRunner?: BrowserControlSystemctlRunner;
}

/** MCP gestionado de Browser Control en OpenCode v2 (mismo nombre que el adapter). */
const BROWSER_CONTROL_SERVER = "browser-control";

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
 * Preflight offline de la skill Browser Control owned. La autoridad del canon es
 * la lectura cacheada del active verificado (`inspectCachedBrowserControlRuntime`,
 * nunca el candidato ni el preparador de adquisición): de ella se deriva la
 * fuente retenida —ya validada regular/confinada/UTF-8 estricta— y se autentica
 * la copia proyectada con la misma clasificación estática que el resto de
 * recursos OpenCode. Un target unowned no se autentica ni se borra (la
 * coincidencia manual no crea propiedad). Un owned que no se pueda acreditar
 * —sin active verificado o bytes distintos— se conserva y bloquea la retirada en
 * vez de borrarse a ciegas.
 */
function browserControlSkillBlockReason(
  configDir: string,
  ownedPaths: readonly string[],
  browserControl: BrowserControlReady | BrowserControlUnavailable,
): string | null {
  const target = path.resolve(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  if (!ownedPaths.some((file) => path.resolve(file) === target)) return null;

  const preserve = (detail: string): string => `${target}: ${detail}; se conserva sin borrar ni reclamar.`;
  if (browserControl.kind !== "ready") {
    return preserve(
      `no hay un active gestionado verificado que acredite los bytes de la skill (${browserControl.reason})`,
    );
  }
  const source = browserControl.skillSource;
  let currentBytes: Buffer;
  try {
    currentBytes = fs.readFileSync(source);
  } catch {
    return preserve(`la fuente verificada de la skill no se puede leer (${source})`);
  }
  const row: StaticResourceRow = {
    source,
    target,
    size: currentBytes.length,
    sha256: createHash("sha256").update(currentBytes).digest("hex"),
  };
  return staticResourceBlockReason(authenticateStaticResource(target, row, currentBytes, true, configDir));
}

const RETIREMENT_PHASES: readonly BrowserControlServiceRetirementPhase[] = [
  "environment-retired",
  "unit-removed",
  "manager-reloaded",
];

function isRetirementPhase(value: unknown): value is BrowserControlServiceRetirementPhase {
  return typeof value === "string" && (RETIREMENT_PHASES as readonly string[]).includes(value);
}

/**
 * Retirada real de la unidad de servicio Browser Control owned, con recuperación
 * por fases dentro de la misma row. Valida perfil, ruta fija, binding retenido,
 * guard y estampa de autostart; prueba de solo lectura el estado del manager;
 * retira el entorno ENV canónico (backup+readback), para/deshabilita la unidad
 * EXACTA, retira el archivo propio (backup+readback) y hace el `daemon-reload`
 * final. Cada fase se persiste tras el readback que la acredita y antes del
 * siguiente efecto: si la escritura falla, no se continúa. Un estado
 * incierto/drift devuelve `pending` conservando recursos y autoridad; un archivo
 * o servicio ajeno reaparecido bloquea sin adoptar ni mutar, sin repetir
 * stop/disable/restart.
 */
async function retireOwnedBrowserControlService(input: {
  readonly stateDir: string;
  readonly configDir: string;
  readonly unitPath: string;
  readonly row: RuntimeManifest | undefined;
  readonly invocation: { readonly command: string; readonly args: readonly string[] } | undefined;
  readonly runner: BrowserControlSystemctlRunner;
}): Promise<{ readonly kind: "retired" } | { readonly kind: "pending"; readonly reason: string }> {
  const pending = (reason: string): { readonly kind: "pending"; readonly reason: string } => ({ kind: "pending", reason });
  const row = input.row;
  const binding = row?.serviceUnit;
  const stamp = row?.browserControlAutostart;
  const progress = row?.browserControlServiceRetirement;
  const unitPath = path.resolve(input.unitPath);

  // Autenticación común: perfil, target fijo, forma del progreso y binding
  // retenido/guard. La estampa ENV es OPCIONAL: la autoridad de la unidad es el
  // binding/owned autenticado, nunca un FALSE manual fabricado.
  const derived = resolveBrowserControlServiceUnitPath();
  if (derived === null || path.resolve(derived) !== unitPath) {
    return pending("la unidad no está en la ruta fija derivada del XDG config/HOME efectivo");
  }
  const base = resolveBrowserControlServiceConfigBase();
  if (base === null || !samePath(input.configDir, path.join(base, "opencode"))) {
    return pending("el perfil de la unidad no coincide con el configDir de OpenCode");
  }
  if (binding === undefined) return pending("la unidad owned no tiene evidencia serviceUnit");
  if (progress !== undefined && (progress.schemaVersion !== 1 || !isRetirementPhase(progress.phase))) {
    return pending("el progreso de retirada del manifest es incoherente");
  }

  // Estampa granular opcional: forma/schema/digest/`portOwned` estrictos y
  // autenticación contra el active verificado ANTES de cualquier mutación. Sin
  // estampa no se retira ningún campo ENV ajeno y la unidad se autentica por su
  // binding histórico (la invocación actual B puede diferir de la unidad A).
  let invocation: { readonly command: string; readonly args: readonly string[] } | undefined;
  if (stamp !== undefined) {
    if (!isBrowserControlAutostartStamp(stamp)) {
      return pending("la estampa browserControlAutostart del manifest es incoherente (forma/schema/digest/portOwned); se conserva sin mutar");
    }
    invocation = input.invocation;
    if (invocation === undefined) {
      return pending("no hay una invocación MCP gestionada verificada para autenticar la estampa");
    }
    if (stamp.projectionSha256 !== browserControlAutostartProjectionSha256(invocation, binding.port)) {
      return pending("la estampa de autostart no autentica contra el active verificado");
    }
  }

  // Con la unidad ya ausente (unit-removed/manager-reloaded) la fase se apoya en
  // el binding retenido/guard autenticados, no solo en el flag; en
  // environment-retired los bytes reales se autentican en su rama.
  if (progress !== undefined && progress.phase !== "environment-retired") {
    const bindingAuth = authenticateOwnedServiceUnitBinding(input.stateDir, binding);
    if (bindingAuth !== null) return pending(bindingAuth);
  }

  // Persiste la fase tras el readback conservando el row COMPLETO (inventario,
  // pendingOrphans, binding y estampa históricos): un checkpoint nunca trunca la
  // autoridad que el reintento aún necesita.
  const persistPhase = (phase: BrowserControlServiceRetirementPhase): string | null => {
    try {
      writeRuntimeManifest("opencode", {
        ...(row ?? { configDir: input.configDir, owned: [unitPath], updatedAt: new Date().toISOString() }),
        configDir: input.configDir,
        owned: row?.owned ?? [unitPath],
        browserControlServiceRetirement: { schemaVersion: 1, phase },
        updatedAt: new Date().toISOString(),
      });
      return null;
    } catch (error) {
      return `no se pudo persistir la fase de retirada '${phase}' (${error instanceof Error ? error.message : String(error)})`;
    }
  };

  // Sin estampa no hay claim ENV que verificar: la fase ENV es un no-op.
  const environmentRetired = (): { readonly kind: "retired" } | { readonly kind: "pending"; readonly reason: string } => {
    if (stamp === undefined || invocation === undefined) return { kind: "retired" };
    const inspection = inspectBrowserControlEnvironmentRetirement({
      configDir: input.configDir,
      invocation,
      port: binding.port,
      portOwned: stamp.portOwned,
    });
    return inspection.kind === "retired" ? { kind: "retired" } : pending(inspection.reason);
  };

  const phase = progress?.phase;

  if (phase === "manager-reloaded") {
    // Fase final: la limpieza del manager ya está acreditada; solo se verifica el
    // estado recuperable y se permite terminar el unmerge/manifest ordinario sin
    // repetir ninguna mutación de manager.
    const file = inspectOwnedServiceUnitFile(unitPath);
    if (file.kind !== "absent") return pending("la unidad reapareció tras completar la retirada; se conserva sin mutar");
    const env = environmentRetired();
    if (env.kind !== "retired") return pending(env.reason);
    const state = await inspectStoppedOwnedServiceUnit(input.runner, unitPath, binding.port);
    if (state.kind === "pending") return pending(state.reason);
    return { kind: "retired" };
  }

  // Prefijo específico de fase: autenticación de recursos, retirada de ENV y
  // stop/disable. Tras él, TODAS las ramas convergen en una única continuación
  // `remove → persist(unit-removed) → reload → persist(manager-reloaded)`.
  if (phase === "unit-removed") {
    // Archivo ya retirado: solo queda el reload final. No se repite stop/disable
    // ni se reincorporan bytes de unidad/ENV.
    const file = inspectOwnedServiceUnitFile(unitPath);
    if (file.kind !== "absent") return pending("la unidad reapareció tras retirar el archivo; se conserva sin mutar");
    const env = environmentRetired();
    if (env.kind !== "retired") return pending(env.reason);
    const state = await inspectStoppedOwnedServiceUnit(input.runner, unitPath, binding.port);
    if (state.kind === "pending") return pending(state.reason);
  } else if (phase === "environment-retired") {
    // ENV ya retirado: la unidad debe seguir presente y canónica, el manager
    // inactivo con el relay ausente; no se repite stop.
    const env = environmentRetired();
    if (env.kind !== "retired") return pending(env.reason);
    const file = inspectOwnedServiceUnitFile(unitPath);
    if (file.kind === "absent") return pending("la unidad owned no existe tras 'environment-retired' (drift); se conserva el progreso");
    if (file.kind === "unsafe") return pending(file.reason);
    const auth = authenticateOwnedServiceUnitBytes(input.stateDir, binding, file.bytes);
    if (auth !== null) return pending(auth);
    const state = await inspectStoppedOwnedServiceUnit(input.runner, unitPath, binding.port);
    if (state.kind !== "inactive") {
      return pending(state.kind === "pending" ? state.reason : "la unidad no está inactiva tras 'environment-retired'");
    }
  } else {
    // Sin fase acreditada: flujo completo. Una unidad ausente sin progreso sigue
    // siendo drift y falla cerrado.
    const state = await inspectOwnedServiceUnitRetirement({
      stateDir: input.stateDir,
      configDir: input.configDir,
      unitPath,
      binding,
      runner: input.runner,
    });
    if (state.kind === "pending") return pending(state.reason);

    // Preflight de SOLO LECTURA antes de cualquier efecto: un entorno no
    // retirable bloquea sin parar/deshabilitar. El snapshot no se reutiliza tras
    // la espera del manager (se recomputa abajo).
    const envPreflight = stamp !== undefined && invocation !== undefined
      ? retireBrowserControlEnvironment({
        configDir: input.configDir,
        invocation,
        port: binding.port,
        portOwned: stamp.portOwned,
      })
      : null;
    if (envPreflight !== null && envPreflight.kind === "blocked") return pending(envPreflight.reason);

    if (state.kind === "operational") {
      const stopped = await stopOwnedServiceUnit({ runner: input.runner, unitPath, port: binding.port });
      if (stopped.kind === "pending") return pending(stopped.reason ?? "stop incierto");
    }
    const disabled = await disableOwnedServiceUnit(input.runner);
    if (disabled.kind === "pending") return pending(disabled.reason ?? "disable incierto");

    if (stamp !== undefined && invocation !== undefined) {
      // Recomputar tras la espera del manager: nunca se escribe el snapshot
      // capturado antes de `stop`. Se releen los bytes y se retiran solo los
      // campos propios, preservando ediciones ajenas compatibles; un drift
      // incompatible bloquea.
      const envPlan = retireBrowserControlEnvironment({
        configDir: input.configDir,
        invocation,
        port: binding.port,
        portOwned: stamp.portOwned,
      });
      if (envPlan.kind === "blocked") return pending(envPlan.reason);
      if (envPlan.kind === "retired") {
        try {
          createBackup([envPlan.file], "uninstall-browser-control-service");
          writeText(envPlan.file, envPlan.content);
        } catch (error) {
          return pending(`no se pudo retirar el entorno gestionado (${error instanceof Error ? error.message : String(error)})`);
        }
        const readback = retireBrowserControlEnvironment({
          configDir: input.configDir,
          invocation,
          port: binding.port,
          portOwned: stamp.portOwned,
        });
        if (readback.kind !== "unchanged") return pending("el readback de la retirada del entorno no quedó estable");
      }
    }
    const persistedEnv = persistPhase("environment-retired");
    if (persistedEnv !== null) return pending(persistedEnv);
  }

  // Continuación común única.
  const removed = removeOwnedServiceUnitFile({ stateDir: input.stateDir, unitPath, binding });
  if (removed.kind === "pending") return pending(removed.reason ?? "retirada del archivo incierta");
  const persistedUnit = persistPhase("unit-removed");
  if (persistedUnit !== null) {
    // El unlink se completó pero su checkpoint no: se restauran los bytes propios
    // autenticados (sin clobber) para reentrar legítimamente desde
    // 'environment-retired'. Un reemplazo ajeno se conserva.
    const restored = restoreOwnedServiceUnitFile({ stateDir: input.stateDir, unitPath, binding });
    if (restored.kind === "restored") {
      return pending(`${persistedUnit}; se restauraron los bytes propios autenticados de la unidad y se reentra desde 'environment-retired'`);
    }
    return pending(`${persistedUnit}; la restauración de los bytes propios de la unidad falló (${restored.reason}). No se finge que la unidad esté presente: revisa el estado antes de reintentar`);
  }
  const reloaded = await reloadOwnedServiceUnitManager(input.runner);
  if (reloaded.kind === "pending") return pending(reloaded.reason ?? "daemon-reload incierto");
  const persistedReload = persistPhase("manager-reloaded");
  if (persistedReload !== null) return pending(persistedReload);
  return { kind: "retired" };
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
    const usingRealConfig = opts.targetDir === undefined;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado — omitido.`);
      continue;
    }
    // Uninstall real: la misma coherencia manifest/configDir/inventario de
    // install DEBE acreditarse antes de dar autoridad a `prevOwned` (backup,
    // borrado o unmerge). Sin el version-gate de install: retirar configuración
    // no exige v2. Con --target-dir no se lee el manifest real.
    if (opts.targetDir === undefined && id === "opencode") {
      try {
        assertOpenCodeManifestCoherence(configDir);
      } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        continue;
      }
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

    // Browser Control gestionado: la lectura offline cacheada del active
    // verificado (`inspectCachedBrowserControlRuntime`, sin prepareRuntime, red ni
    // sondeo) aporta la invocación del launcher y la fuente de skill ya
    // validadas. El adapter solo retira el objeto canónico EXACTO con esa
    // invocación; sin ella falla cerrado. Un active ausente/drift se diagnostica
    // aquí y se conserva la entrada, la skill y su ownership sin borrar.
    const browserControl = usingRealConfig && id === "opencode"
      ? inspectCachedBrowserControlRuntime(dataDir())
      : null;
    // Invocación del active retenido: autentica la estampa histórica incluso
    // cuando el MCP gestionado ya se retiró (retry de una retirada a medias).
    const activeBrowserControlInvocation = browserControl !== null && browserControl.kind === "ready"
      ? browserControl.invocation
      : undefined;
    if (id === "opencode" && ctx.ownedMcpServers?.has(BROWSER_CONTROL_SERVER) === true) {
      if (browserControl !== null && browserControl.kind === "ready") {
        ctx.browserControlInvocation = browserControl.invocation;
      } else {
        p.log.warn(
          `OpenCode: no se pudo autenticar el MCP gestionado 'browser-control' (${browserControl?.reason ?? "no hay un active gestionado verificado"}); se conserva la entrada y su ownership sin borrar nada. Revisa el receipt gestionado antes de reintentar.`,
        );
      }
    }

    // Preflight de SOLO LECTURA de todo lo que puede bloquear la retirada
    // (coherencia manifest ya acreditada arriba, recursos estáticos y skill
    // owned autenticados contra el active verificado). Se resuelve ANTES de
    // cualquier efecto destructivo —incluida la retirada del servicio owned
    // (stop/disable/borrado de unidad/retirada de entorno)— para que un bloqueo
    // conserve íntegros unidad, claim, binding, estampa, MCP y skill.
    const prevOwned = usingRealConfig ? (readManifest().runtimes[id]?.owned ?? []) : [];
    // Unidad de servicio Browser Control: el lifecycle verificado se ejecuta más
    // abajo; su claim owned decide si hay algo que retirar y qué conservar.
    const serviceUnitPath = usingRealConfig && id === "opencode" ? resolveBrowserControlServiceUnitPath() : null;
    const ownedServiceUnit = serviceUnitPath !== null
      && prevOwned.some((file) => path.resolve(file) === path.resolve(serviceUnitPath));
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
    // Skill Browser Control: mismo preflight estático ANTES de cualquier backup
    // o borrado, sobre la lectura offline cacheada. Solo se autentica cuando está
    // owned; unowned no se borra.
    if (staticBlock === null && id === "opencode" && usingRealConfig && browserControl !== null) {
      staticBlock = browserControlSkillBlockReason(configDir, prevOwned, browserControl);
    }
    if (staticBlock !== null) {
      p.log.error(`OpenCode: ${staticBlock} No se borra ni respalda nada; el ownership se conserva.`);
      exitCode = 1;
      continue;
    }

    // scopedMcp se comparte entre el pre-plan de solo lectura y el plan real.
    const devtoolsServer = mcpForUnmerge.servers[DEVTOOLS_MCP_SERVER];
    const scopedMcp = devtoolsServer !== undefined && ctx.ownedMcpServers?.has(DEVTOOLS_MCP_SERVER)
      ? { servers: { ...mcpForUnmerge.servers, [DEVTOOLS_MCP_SERVER]: {
        ...materializeCanonicalDevtoolsServerForRemoval(devtoolsServer, ctx.devtoolsMcpObservedVersion),
        ...(ctx.devtoolsMcpInvocation === undefined ? {} : {
          command: ctx.devtoolsMcpInvocation.command,
          args: [...ctx.devtoolsMcpInvocation.args],
        }),
      } } }
      : mcpForUnmerge;

    // Pre-planificación real de SOLO LECTURA (ctx con warnings aisladas) ANTES de
    // cualquier efecto: detecta un bloqueo del unmerge sin haber parado/retirado
    // aún el servicio. El resultado se descarta y se recomputa tras retirar ENV
    // para no resucitar campos.
    try {
      adapter.planUnmerge(scopedMcp, hooks, { ...ctx, warnings: [...ctx.warnings] });
    } catch (error) {
      p.log.error(`${adapter.name}: no se pudo planificar la limpieza en ${configDir} — ${error instanceof Error ? error.message : String(error)}.`);
      exitCode = 1;
      continue;
    }

    // T13: retirada real de la unidad de servicio Browser Control owned. Se
    // ejecuta tras el preflight y ANTES del unmerge/borrado ordinario para que
    // la retirada del entorno canónico convierta el MCP en el objeto exacto que
    // el adapter puede retirar, sin perder la autoridad del mismo row. Un estado
    // incierto/drift devuelve `pending` y conserva unidad/claim/binding.
    let serviceRetired = false;
    let servicePendingReason: string | null = null;
    if (usingRealConfig && id === "opencode" && process.platform === "linux" && !opts.dryRun) {
      const manifestRow = readManifest().runtimes[id];
      if (ownedServiceUnit && serviceUnitPath !== null) {
        const retirement = await retireOwnedBrowserControlService({
          stateDir: dataDir(),
          configDir,
          unitPath: serviceUnitPath,
          row: manifestRow,
          invocation: ctx.browserControlInvocation ?? activeBrowserControlInvocation,
          runner: opts.systemctlRunner ?? createSystemctlRunner(),
        });
        if (retirement.kind === "retired") serviceRetired = true;
        else servicePendingReason = retirement.reason;
      }
    }

    // Una retirada de servicio pendiente INTERRUMPE la limpieza ordinaria de
    // OpenCode: se preserva el row COMPLETO (inventario, binding, estampa, fase)
    // y también el MCP/skill/recursos estáticos y la config de usuario, para que
    // el reintento pueda retirar cada recurso canónico. Nunca se libera el claim
    // MCP ni se trunca `owned` a la unidad.
    if (!opts.dryRun && usingRealConfig && id === "opencode" && ownedServiceUnit && serviceUnitPath !== null && !serviceRetired) {
      p.log.warn(
        `${adapter.name}: retirada de servicio Browser Control pendiente: ${serviceUnitPath} se conserva con su claim, binding y fase (${servicePendingReason ?? "estado incierto"}). No se continúa la limpieza ordinaria ni se libera el inventario/MCP; corrige el estado indicado y reintenta el uninstall.`,
      );
      exitCode = 1;
      continue;
    }

    let unmerge: FileAction[];
    try {
      unmerge = adapter.planUnmerge(scopedMcp, hooks, ctx);
    } catch (error) {
      p.log.error(`${adapter.name}: no se pudo planificar la limpieza en ${configDir} — ${error instanceof Error ? error.message : String(error)}.`);
      exitCode = 1;
      continue;
    }
    const mergedTargets = new Set(unmerge.map((a) => path.resolve(a.target)));
    // Lo instalado = plan actual ∪ manifest (cubre archivos que versiones
    // anteriores instalaron y el plan actual ya no genera). `prevOwned` y la
    // autoridad de la unidad ya se leyeron en el preflight de solo lectura.
    // En instalación real los targets pueden vivir fuera del configDir
    // (~/.agents/skills): borrado y poda se anclan a HOME. Nada fuera de esa
    // frontera se borra, aunque el manifest (estado local editable) lo liste.
    const pruneRoot = usingRealConfig ? HOME : path.dirname(configDir);
    const planTargets = [
      ...new Set([...buildContentPlan(adapter, ctx).map((a) => path.resolve(a.target)), ...prevOwned.map((t) => path.resolve(t))]),
    ].filter((t) => !mergedTargets.has(t) && fs.existsSync(t));

    const deleteTargets = planTargets.filter((t) => {
      if (skippedStaticTargets.has(t) || retained.has(t) || !isContainedIn(t, pruneRoot)) return false;
      // La unidad de servicio owned se conserva hasta que exista el lifecycle
      // verificado (stop/disable autenticados); borrarla a ciegas dejaría al
      // manager apuntando a bytes ausentes.
      if (ownedServiceUnit && serviceUnitPath !== null && path.resolve(t) === path.resolve(serviceUnitPath)) return false;
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
    if (usingRealConfig) {
      // Solo se llega aquí sin retirada pendiente: no hay unidad owned o la
      // unidad ya se retiró con backup/readback. El row completo se libera; el
      // paquete retenido, el candidato, los datos del navegador y la
      // configuración de usuario de Engram permanecen.
      removeRuntimeManifest(id);
    }
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
