import { prepareWritingStyle, applyWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot } from "./writing-style.js";
import { loadInstallModePreference } from "./install-mode.js";
import type { InstallMode } from "../adapters/types.js";
import {
  completePiProjectionUninstallSystem,
  preparePiProjectionUninstallSystem,
  runPiProjectionLifecycleSystem,
} from "./pi-projection-lifecycle.js";
import { PI_RUNTIME_CANDIDATE, preparePiRuntimeSystem, runPiRuntimeSystem, type PiRuntimeInput } from "./pi-runtime.js";
import { devtoolsMcpPreferenceFile, loadDevtoolsMcpObservation, loadDevtoolsMcpPreference, loadPlaywrightCliPreference, playwrightCliPreferenceFile, savePlaywrightCliPreference, saveDevtoolsMcpPreference, type ObservedVersion } from "./tool-preferences.js";
import { isValidObservedVersion } from "./npm-provider.js";
import { resolvePnpmBin } from "./external-tools.js";
import type { PlaywrightCapabilitySnapshot } from "./playwright-capability.js";
import { piSystemPromptFile } from "../adapters/pi.js";
import { assertSystemPromptFile } from "./system-prompt-sections.js";
import { activateVerifiedBrowserArtifact, prepareVerifiedBrowserRelease } from "./browser-provider.js";
import { detectChromiumExecutable, loadVerifiedManagedBrowserReceipt } from "./browser-managed.js";
import { requirePiBrowserHandoffSchemas } from "./pi-browser-contract.js";
import { refreshPiPlaywright } from "./pi-browser-update.js";
import { dataDir, stackRoot } from "./paths.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { updatePiProviderPackages } from "./pi-provider-update.js";
import { piProviderReceiptPath, verifyPiProviderReceipt } from "./pi-provider-receipt.js";
import { reconcileNativeAuthorityAfterCleanup, runNativePiMcpPhase, type NativeMcpPreparedWrite } from "./pi-native-phase.js";
import {
  NATIVE_MCP_SERVER_NAMES,
  inspectNativeMcpOwnership,
  isInstalledNativePackage,
  parseNativeMcpAuthorityStrict,
  readNativeMcpSnapshot,
  removeNativeMcpEntries,
  restoreOwnedWrite,
  writeNativeMcpConfig,
  type NativeMcpOwnershipResult,
  type NativeMcpServerName,
  type NativeMcpSnapshot,
} from "./pi-native-mcp.js";
import type { PiProjectionMcpNativeAuthority } from "./pi-projection-lifecycle.js";
import { resolveActivePiEntry } from "./pi-private-release.js";
import { verifyOfflineManagedPiRelease } from "./pi-package-lifecycle.js";
import { verifyCachedPiArtifact } from "./pi-cached-artifact.js";
import { createBackup } from "./backup.js";
import { writeText } from "./fsx.js";
import path from "node:path";

export type PiManagedOperation = "install" | "sync" | "models" | "doctor" | "uninstall" | "update";
type PiProjectionOperation = Exclude<PiManagedOperation, "models" | "update">;

export type PiManagedPackageResult =
  | { kind: "installed" }
  | { kind: "synced" }
  | { kind: "models"; models: unknown }
  | { kind: "healthy" }
  | { kind: "uninstalled" }
  | { kind: "updated" }
  | { kind: "manual-existing"; remedy?: string }
  | { kind: "blocked"; reason: string; remedy?: string };

export type PiManagedProjectionResult =
  | { kind: "installed" }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[]; remedy: string }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: string; remedy?: string };

export type PiManagedOperationResult = Exclude<PiManagedPackageResult, { kind: "manual-existing" }>
  | { kind: "blocked"; reason: "projection-drift"; paths: string[]; remedy: string };

type PiManagedPackageOutcome = Exclude<PiManagedPackageResult, { kind: "manual-existing" }>;
type PiManagedProjectionUninstallPreparation =
  | { kind: "prepared"; token: unknown }
  | Extract<PiManagedProjectionResult, { kind: "blocked" }>;
type PiManagedProjectionUninstallCompletion =
  | { kind: "uninstalled" }
  | Extract<PiManagedProjectionResult, { kind: "blocked" }>;

export interface PiManagedRuntimeDeps {
  runPackage(operation: PiManagedOperation): Promise<PiManagedPackageResult>;
  runProjection(operation: PiProjectionOperation): Promise<PiManagedProjectionResult>;
  prepareProjectionUninstall(): Promise<PiManagedProjectionUninstallPreparation>;
  completeProjectionUninstall(token: unknown): Promise<PiManagedProjectionUninstallCompletion>;
  /** Native-only operational readback, run after authority publication and before the internal sync. */
  beforeInitialization?(): Promise<{ kind: "ok" } | { kind: "blocked"; reason: string; remedy?: string }>;
  /** Native-only cleanup eligibility, run before the private package is deactivated. */
  beforePackageDeactivation?(): Promise<{ kind: "ok" } | { kind: "blocked"; reason: string; remedy?: string }>;
  installInitRemedy?: string;
}

function projectionOperation(operation: Exclude<PiManagedOperation, "models">): PiProjectionOperation {
  return operation === "update" ? "sync" : operation;
}

function manualExistingResult(packageResult: Extract<PiManagedPackageResult, { kind: "manual-existing" }>): PiManagedOperationResult {
  return packageResult.remedy === undefined
    ? { kind: "blocked", reason: "manual-existing" }
    : { kind: "blocked", reason: "manual-existing", remedy: packageResult.remedy };
}

async function completeProjection(
  operation: PiProjectionOperation,
  packageResult: PiManagedPackageOutcome,
  deps: PiManagedRuntimeDeps,
): Promise<PiManagedOperationResult> {
  const projectionResult = await deps.runProjection(operation);
  if (projectionResult.kind === "drift") {
    return {
      kind: "blocked",
      reason: "projection-drift",
      paths: projectionResult.paths,
      remedy: projectionResult.remedy,
    };
  }
  return projectionResult.kind === "blocked" ? projectionResult : packageResult;
}

const INSTALL_INIT_REMEDY = "Corrige la causa y ejecuta sync --agents pi para completar la inicialización.";

const INSTALL_INIT_TARGET_REMEDY =
  "Corrige la causa y ejecuta sync --agents pi con el mismo --target-dir para completar la inicialización.";

function withInstallInitRemedy(
  result: Extract<PiManagedPackageResult, { kind: "blocked" }>,
  fallbackRemedy: string,
): PiManagedOperationResult {
  return result.remedy === undefined
    ? { kind: "blocked", reason: result.reason, remedy: fallbackRemedy }
    : result;
}

async function completeWithInitialization(
  packageResult: PiManagedPackageOutcome,
  deps: PiManagedRuntimeDeps,
  initialProjection: PiProjectionOperation = "install",
): Promise<PiManagedOperationResult> {
  const projected = await completeProjection(initialProjection, packageResult, deps);
  if (projected.kind === "blocked") return projected;
  if (deps.beforeInitialization !== undefined) {
    const checked = await deps.beforeInitialization();
    if (checked.kind === "blocked") {
      return checked.remedy === undefined
        ? { kind: "blocked", reason: checked.reason, remedy: deps.installInitRemedy ?? INSTALL_INIT_REMEDY }
        : checked;
    }
  }
  const fallbackRemedy = deps.installInitRemedy ?? INSTALL_INIT_REMEDY;
  const initResult = await deps.runPackage("sync");
  if (initResult.kind === "synced") {
    const reconciled = await completeProjection("sync", packageResult, deps);
    if (reconciled.kind === "blocked") {
      if ("remedy" in reconciled && reconciled.remedy !== undefined) return reconciled;
      return { ...reconciled, remedy: fallbackRemedy };
    }
    return packageResult;
  }
  if (initResult.kind === "manual-existing") return manualExistingResult(initResult);
  if (initResult.kind === "blocked") return withInstallInitRemedy(initResult, fallbackRemedy);
  return { kind: "blocked", reason: "runner-unhealthy", remedy: fallbackRemedy };
}

export async function runManagedPiOperation(
  operation: PiManagedOperation,
  deps: PiManagedRuntimeDeps,
): Promise<PiManagedOperationResult> {
  if (operation === "uninstall") {
    const preparation = await deps.prepareProjectionUninstall();
    if (preparation.kind === "blocked") return preparation;

    if (deps.beforePackageDeactivation !== undefined) {
      const checked = await deps.beforePackageDeactivation();
      if (checked.kind === "blocked") {
        return checked.remedy === undefined
          ? { kind: "blocked", reason: checked.reason, remedy: "Revisa la comprobación nativa antes de reintentar; no se desactivó nada." }
          : checked;
      }
    }

    const packageResult = await deps.runPackage(operation);
    if (packageResult.kind === "manual-existing") return manualExistingResult(packageResult);
    if (packageResult.kind === "blocked") return packageResult;
    return deps.completeProjectionUninstall(preparation.token);
  }

  const packageResult = await deps.runPackage(operation);
  if (packageResult.kind === "manual-existing") return manualExistingResult(packageResult);
  if (operation === "models") return packageResult;

  if (operation === "install" && packageResult.kind !== "blocked") {
    return completeWithInitialization(packageResult, deps);
  }

  if (operation === "update" && packageResult.kind === "updated") {
    return completeWithInitialization(packageResult, deps, "sync");
  }

  const nextProjectionOperation = projectionOperation(operation);
  if (packageResult.kind !== "blocked") {
    return completeProjection(nextProjectionOperation, packageResult, deps);
  }

  if (packageResult.reason !== "source-divergent" || (operation !== "sync" && operation !== "update")) {
    return packageResult;
  }

  const recoveryProjection = await deps.runProjection("sync");
  if (recoveryProjection.kind === "blocked") return recoveryProjection;
  if (recoveryProjection.kind !== "synced" || !recoveryProjection.changed) return packageResult;

  const retryResult = await deps.runPackage(operation);
  if (retryResult.kind === "manual-existing") return manualExistingResult(retryResult);
  if (retryResult.kind === "blocked") return retryResult;
  return completeProjection("sync", retryResult, deps);
}

function managedPackageResult(
  result: Awaited<ReturnType<typeof runPiRuntimeSystem>>,
): PiManagedPackageResult {
  if (result.kind === "manual-existing") {
    return {
      kind: "manual-existing",
      remedy: result.remedy ?? "Pi ya está configurado manualmente; conserva esa configuración o elimínala antes de ejecutar sync --agents pi.",
    };
  }
  if (result.kind === "models") return { kind: "models", models: result.models };
  return result as Exclude<PiManagedPackageResult, { kind: "manual-existing" } | { kind: "models" }>;
}

/**
 * Authenticates the active managed Pi package offline (receipt/cache/link/tree
 * bytes) BEFORE any operational checker module is imported or executed, reusing
 * the existing Stack offline gate. Topology (`resolveActivePiEntry`) proves the
 * link shape; this proves the code that will actually run.
 */
function authenticateActiveNativePackage(args: {
  readonly activeAgentDir: string;
  readonly homeDir: string;
  readonly targetDir: string | undefined;
  readonly executable: string;
  readonly engramBin: string | null;
}): { kind: "ok"; realRoot: string } | { kind: "blocked"; reason: string; remedy: string } {
  const receiptPath = path.join(args.homeDir, ".jorgex-stack", "pi-receipt.json");
  const settingsPath = path.join(args.activeAgentDir, "settings.json");
  let settingsJson: string;
  let receiptJson: string | null;
  try {
    settingsJson = fs.readFileSync(settingsPath, "utf8");
    receiptJson = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, "utf8") : null;
  } catch (error) {
    return {
      kind: "blocked",
      reason: "native-receipt-unreadable",
      remedy: `${error instanceof Error ? error.message : String(error)}; revisa el receipt/settings nativos antes de reintentar.`,
    };
  }
  const downloadsDir = path.join(args.homeDir, ".jorgex-stack", "packages");
  const validated = verifyOfflineManagedPiRelease(
    {
      detected: {
        executable: args.executable,
        packageRunner: path.join(args.activeAgentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs"),
        settingsJson,
      },
      engramBin: args.engramBin,
      receiptJson,
      paths: {
        targetDir: args.targetDir !== undefined,
        codingAgentDir: args.activeAgentDir,
        receiptPath,
        environment: { HOME: args.homeDir, PI_CODING_AGENT_DIR: args.activeAgentDir },
      },
    },
    { verifyManagedArtifact: (receipt) => verifyCachedPiArtifact({ receipt, homeDir: args.homeDir, downloadsDir }) },
  );
  if (validated.kind === "blocked") {
    return {
      kind: "blocked",
      reason: "native-package-untrusted",
      remedy: "El paquete Pi gestionado no supera la prueba offline (bytes/cache/link/árbol); no se importa el checker operativo.",
    };
  }
  return { kind: "ok", realRoot: validated.realRoot };
}

/** Raw bytes of a file, or null when it is absent/unreadable. */
function readRawOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Prior native claim names in the projection receipt, or null when absent/unreadable. */
function previousNativeClaimNames(homeDir: string): NativeMcpServerName[] | null {
  const path0 = path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");
  const raw = readRawOrNull(path0);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let authority;
  try { authority = parseNativeMcpAuthorityStrict(Reflect.get(parsed, "mcpNative")); } catch { return null; }
  if (authority === null) return null;
  return Object.keys(authority.entries) as NativeMcpServerName[];
}

/**
 * Authenticates the active managed package offline and inspects its ownership,
 * capturing config + authority bytes before the checker and revalidating them
 * after, so stale eligibility can never authorize new content. Shared by the
 * pre-phase update claim gate and the pre-deactivation cleanup guard.
 */
async function inspectAuthenticatedNativeOwnership(args: {
  readonly activeAgentDir: string;
  readonly homeDir: string;
  readonly targetDir: string | undefined;
  readonly executable: string;
  readonly engramBin: string | null;
}): Promise<
  | { kind: "blocked"; reason: string; remedy: string }
  | { kind: "ok"; ownership: NativeMcpOwnershipResult; snapshot: NativeMcpSnapshot; authorityRaw: string | null }
> {
  const activeEntry = resolveActivePiEntry(args.activeAgentDir);
  if (activeEntry.kind === "absent") {
    return { kind: "blocked", reason: "native-active-entry-absent", remedy: "La entrada nativa activa falta; no se modificó nada." };
  }
  const authenticated = authenticateActiveNativePackage({
    activeAgentDir: args.activeAgentDir,
    homeDir: args.homeDir,
    targetDir: args.targetDir,
    executable: args.executable,
    engramBin: args.engramBin,
  });
  if (authenticated.kind === "blocked") return authenticated;
  if (path.resolve(authenticated.realRoot) !== path.resolve(activeEntry.packageRoot)) {
    return { kind: "blocked", reason: "native-package-drift", remedy: "La raíz autenticada no coincide con la topología del enlace activo; no se modificó nada." };
  }
  const authorityFile = path.join(args.homeDir, ".jorgex-stack", "pi-projection-receipt.json");
  const before = readNativeMcpSnapshot(args.activeAgentDir);
  const authorityBefore = readRawOrNull(authorityFile);
  const ownership = await inspectNativeMcpOwnership(authenticated.realRoot, {
    env: { HOME: args.homeDir, USERPROFILE: args.homeDir, PI_CODING_AGENT_DIR: args.activeAgentDir },
    platform: process.platform,
    cwd: process.cwd(),
    projectTrusted: false,
  });
  const after = readNativeMcpSnapshot(args.activeAgentDir);
  if (after.raw !== before.raw || readRawOrNull(authorityFile) !== authorityBefore) {
    return { kind: "blocked", reason: "native-config-changed", remedy: "mcp.json o la autoridad nativa cambiaron durante la comprobación; se conservan sin modificar." };
  }
  return { kind: "ok", ownership, snapshot: before, authorityRaw: authorityBefore };
}

/**
 * True when `<home>/.jorgex-stack/pi-receipt.json` is a schema1 managed receipt.
 * An install over such a receipt is the update path (the same decision the
 * runtime preflight makes), so the native phase must not run as fresh.
 */
function hasManagedPiReceipt(homeDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(homeDir, ".jorgex-stack", "pi-receipt.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && Reflect.get(parsed, "schemaVersion") === 1
      && Reflect.get(parsed, "managedPackage") !== undefined
      && Reflect.get(parsed, "managedPackage") !== null
      && typeof Reflect.get(parsed, "managedPackage") === "object"
      && !Array.isArray(Reflect.get(parsed, "managedPackage"));
  } catch {
    return false;
  }
}

/** Coordina el paquete Pi con la proyección compartida de Stack. */
export async function runManagedPiSystem(input: PiRuntimeInput & {
  devtoolsMcpEnabled?: boolean;
  devtoolsMcpObservedVersion?: ObservedVersion | null;
  writingStyle?: WritingStyleSnapshot;
  writingStyleMode?: InstallMode;
  playwrightCliEnabled?: boolean;
  playwrightCapability?: PlaywrightCapabilitySnapshot;
  playwrightRefresh?: boolean;
  packageOnly?: boolean;
  upgradePermissions?: boolean;
  engramTypeboxCompat?: boolean;
}): Promise<PiManagedOperationResult> {
  // Authenticate existing provenance before acquiring or activating Pi itself;
  // later provider checks still protect against concurrent changes.
  if (input.targetDir === undefined) {
    const guardHomeDir = os.homedir();
    const guardAgentDir = path.dirname(piSystemPromptFile());
    let receiptStat: fs.Stats | undefined;
    try {
      receiptStat = fs.lstatSync(piProviderReceiptPath(guardHomeDir), { throwIfNoEntry: false });
    } catch (error) {
      return {
        kind: "blocked",
        reason: "provider-receipt-invalid",
        remedy: `No se pudo comprobar el recibo gestionado de providers Pi (${error instanceof Error ? error.message : String(error)}); no se modificó nada.`,
      };
    }
    if (receiptStat !== undefined) {
      try {
        verifyPiProviderReceipt({ homeDir: guardHomeDir, agentDir: guardAgentDir });
      } catch (error) {
        return {
          kind: "blocked",
          reason: "provider-receipt-invalid",
          remedy: `El recibo gestionado de providers Pi es inválido o drifted (${error instanceof Error ? error.message : String(error)}); no se modificó nada.`,
        };
      }
    }
  }
  // T06 deliberate install/update: the real CLI never passes a caller stage, so
  // resolve the live provider preflight before the obsolete host gate. TargetDir
  // never runs preflight network; injected candidate/prepared skip it.
  // Blocked/throwing preflight fails closed before package/projection/prefs.
  let effectiveCandidate = input.candidate;
  let effectivePrepared = input.prepared;
  if ((input.operation === "install" || input.operation === "update") && input.targetDir === undefined && effectiveCandidate === undefined && effectivePrepared === undefined) {
    let preflight: unknown;
    try {
      const prepare = preparePiRuntimeSystem as unknown as ((value: PiRuntimeInput) => Promise<unknown>) | undefined;
      if (typeof prepare !== "function") throw new Error("pi-install-preflight: preparePiRuntimeSystem no disponible");
      preflight = await prepare(input);
    } catch (error) {
      return {
        kind: "blocked",
        reason: "preflight-failed",
        remedy: error instanceof Error ? error.message : String(error),
      };
    }
    if (preflight !== null && typeof preflight === "object" && "kind" in preflight
      && (preflight as { kind: unknown }).kind === "blocked") {
      return preflight as { kind: "blocked"; reason: string; remedy?: string };
    }
    const ok = preflight as { candidate?: PiRuntimeInput["candidate"]; prepared?: PiRuntimeInput["prepared"] };
    if (ok.candidate === undefined || ok.prepared === undefined) {
      return {
        kind: "blocked",
        reason: "preflight-failed",
        remedy: "El preflight Pi no devolvió candidato preparado; revisa el stage y reintenta.",
      };
    }
    effectiveCandidate = ok.candidate;
    effectivePrepared = ok.prepared;
  }
  const supportedVersions: readonly string[] = PI_RUNTIME_CANDIDATE.pi.testedVersions;
  const hasStagedCandidate = input.operation === "install" && effectiveCandidate !== undefined;
  const hasStagedUpdate = input.operation === "update" && effectiveCandidate !== undefined && effectivePrepared !== undefined;
  const bypassHostGate =
    hasStagedCandidate || hasStagedUpdate || input.operation === "sync" || input.operation === "doctor" || input.operation === "uninstall" || input.operation === "models";
  if (!bypassHostGate && !supportedVersions.includes(input.detected.version)) {
    return {
      kind: "blocked",
      reason: "unsupported-pi-version",
      remedy: `Pi ${input.detected.version} no está entre las versiones verificadas (${supportedVersions.join(", ")}). Actualiza Stack a una versión compatible antes de gestionar Pi.`,
    };
  }
  const {
    devtoolsMcpEnabled: explicitDevtools,
    devtoolsMcpObservedVersion: injectedDevtoolsObserved,
    playwrightCliEnabled: explicitPlaywright,
    playwrightCapability,
    playwrightRefresh,
    packageOnly,
    writingStyle: suppliedStyle,
    writingStyleMode,
    upgradePermissions: requestedUpgrade,
    engramTypeboxCompat: requestedEngramTypeboxCompat,
    ...runtimeInput
  } = input;
  const supportsPermissionsUpgrade = (PI_RUNTIME_CANDIDATE.contract.capabilities as readonly string[]).includes("permissions-upgrade-v1");
  const upgradePermissions = requestedUpgrade === true && supportsPermissionsUpgrade;
  if (input.operation === "doctor" && packageOnly) {
    const result = managedPackageResult(await runPiRuntimeSystem(runtimeInput));
    return result.kind === "manual-existing" ? manualExistingResult(result) : result;
  }
  const readsStyle = input.operation !== "uninstall" && input.operation !== "models";
  if (input.operation !== "models") {
    try { assertSystemPromptFile(piSystemPromptFile(input.targetDir), input.targetDir); }
    catch (error) {
      return { kind: "blocked", reason: "projection-prompt-markers", remedy: error instanceof Error ? error.message : String(error) };
    }
  }
  const preparedStyle = readsStyle && suppliedStyle === undefined
    ? prepareWritingStyle(resolveWritingStyleFile({ targetDir: input.targetDir }), { rootDir: input.targetDir })
    : undefined;
  const style = readsStyle ? suppliedStyle ?? preparedStyle : undefined;
  const mode = readsStyle
    ? writingStyleMode ?? (input.targetDir === undefined ? loadInstallModePreference().mode : "human")
    : "human";
  const writingStyle = style && mode === "programmatic" ? { ...style, content: null } : style;
  const persistedDevtools = explicitDevtools === undefined
    && input.targetDir === undefined
    && loadDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi");
  const devtoolsMcpEnabled = explicitDevtools ?? persistedDevtools;
  const needsDevtoolsObservation = devtoolsMcpEnabled === true
    && input.operation !== "uninstall"
    && input.operation !== "models";
  // T15 Pi-only verified provider: explicit true + real scope + deliberate
  // install/update with no valid injected observation resolves the exact
  // provider candidate via the shared helper BEFORE projection. targetDir
  // never fetches nor reads global prefs (valid injected only); sync/doctor
  // never fetch; no opt-in never fetches.
  let devtoolsMcpObservedVersion: ObservedVersion | null = null;
  let devtoolsVerifiedForPersist: ObservedVersion | undefined;
  const devtoolsManagedStateDir = input.targetDir === undefined
    ? dataDir()
    : path.join(input.targetDir, "home", ".jorgex-stack");
  const deliberateBrowserOperation = input.targetDir === undefined
    && (input.operation === "install" || input.operation === "update");
  const devtoolsRefreshRequested = deliberateBrowserOperation
    && devtoolsMcpEnabled === true
    && explicitDevtools !== false;
  if (needsDevtoolsObservation) {
    if (input.targetDir !== undefined) {
      devtoolsMcpObservedVersion = isValidObservedVersion(injectedDevtoolsObserved)
        ? { version: injectedDevtoolsObserved.version, integrity: injectedDevtoolsObserved.integrity }
        : null;
    } else if (devtoolsRefreshRequested) {
      if (isValidObservedVersion(injectedDevtoolsObserved)) {
        devtoolsMcpObservedVersion = { version: injectedDevtoolsObserved.version, integrity: injectedDevtoolsObserved.integrity };
        devtoolsVerifiedForPersist = devtoolsMcpObservedVersion;
      } else {
        let release: { version: string; integrity: string };
        try {
          const pnpmBin = resolvePnpmBin();
          if (pnpmBin === null) throw new Error("pnpm no disponible para preparar el árbol gestionado de DevTools");
          release = await prepareVerifiedBrowserRelease("chrome-devtools-mcp", {
            fetchImpl: globalThis.fetch,
            withVerifiedArtifact: async (context) => {
              await activateVerifiedBrowserArtifact(context, {
                stateDir: devtoolsManagedStateDir, pnpmBin, fetchImpl: globalThis.fetch,
                browserExecutablePath: detectChromiumExecutable(),
              });
            },
          });
        } catch (error) {
          return {
            kind: "blocked",
            reason: "devtools-verification-failed",
            remedy: error instanceof Error ? error.message : String(error),
          };
        }
        const observed = { version: release.version, integrity: release.integrity };
        if (!isValidObservedVersion(observed)) {
          return {
            kind: "blocked",
            reason: "devtools-verification-failed",
            remedy: "Chrome DevTools MCP: versión observada inválida del proveedor; preferencia no marcada.",
          };
        }
        devtoolsMcpObservedVersion = observed;
        devtoolsVerifiedForPersist = observed;
      }
    } else {
      devtoolsMcpObservedVersion = loadDevtoolsMcpObservation();
    }
  }
  if (needsDevtoolsObservation) {
    try {
      if (input.targetDir !== undefined) {
        const target = fs.lstatSync(input.targetDir);
        const home = fs.lstatSync(path.join(input.targetDir, "home"));
        if (!target.isDirectory() || target.isSymbolicLink() || !home.isDirectory() || home.isSymbolicLink()) {
          throw new Error("HOME del target Pi no es un directorio real aislado");
        }
      }
      const receipt = loadVerifiedManagedBrowserReceipt(devtoolsManagedStateDir, "chrome-devtools-mcp");
      if (receipt === null || devtoolsMcpObservedVersion === null
        || receipt.version !== devtoolsMcpObservedVersion.version
        || receipt.integrity !== devtoolsMcpObservedVersion.integrity) {
        throw new Error("falta un receipt DevTools activo coincidente con la versión e integridad observadas");
      }
    } catch (error) {
      return { kind: "blocked", reason: "devtools-verification-failed",
        remedy: error instanceof Error ? error.message : String(error) };
    }
  }
  if (input.targetDir === undefined && devtoolsVerifiedForPersist !== undefined) {
    // The browser phase has committed verified bytes. Keep its observation
    // aligned even if Pi later fails, without enabling a fresh Pi selection.
    saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi",
      loadDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi") === true, devtoolsVerifiedForPersist);
  }
  const devtoolsMcpVersion = devtoolsMcpObservedVersion?.version ?? null;
  const supportsPlaywright = (PI_RUNTIME_CANDIDATE.contract.capabilities as readonly string[]).includes("playwright-handoff-v1");
  const persistedPlaywright = input.targetDir === undefined
    && loadPlaywrightCliPreference(undefined, "pi") === true;
  const selectedPlaywright = explicitPlaywright
    ?? persistedPlaywright;
  let effectivePlaywrightCapability = playwrightCapability;
  let refreshedPlaywright: Awaited<ReturnType<typeof refreshPiPlaywright>> | undefined;
  const skipPlaywrightRefresh = playwrightRefresh === false;
  const injectedPlaywrightCapability = input.operation === "install" && explicitPlaywright === true
    && playwrightCapability?.effective === true;
  if (deliberateBrowserOperation && input.operation === "install" && supportsPlaywright
    && explicitPlaywright === true && !skipPlaywrightRefresh && !injectedPlaywrightCapability) {
    return { kind: "blocked", reason: "playwright-capability-unverified", remedy: "El opt-in nuevo de Playwright requiere la adquisición y verificación del CLI antes de proyectarse en Pi." };
  }
  const playwrightRefreshRequested = deliberateBrowserOperation
    && supportsPlaywright
    && selectedPlaywright === true
    && !skipPlaywrightRefresh
    && !injectedPlaywrightCapability;
  if (playwrightRefreshRequested) {
    const pnpmBin = resolvePnpmBin();
    if (pnpmBin === null) {
      return {
        kind: "blocked",
        reason: "playwright-refresh-failed",
        remedy: "pnpm no está disponible para actualizar el Playwright gestionado de Pi; instala pnpm y reintenta.",
      };
    }
    try {
      refreshedPlaywright = await refreshPiPlaywright({ stateDir: dataDir(), pnpmBin });
      effectivePlaywrightCapability = refreshedPlaywright.capability;
      savePlaywrightCliPreference(playwrightCliPreferenceFile(), true,
        { pi: persistedPlaywright }, refreshedPlaywright.observed);
    } catch (error) {
      return {
        kind: "blocked",
        reason: "playwright-refresh-failed",
        remedy: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const playwrightCapabilityEffective = effectivePlaywrightCapability?.effective === true;
  const playwrightCliEnabled = input.targetDir === undefined && supportsPlaywright
    && selectedPlaywright
    && playwrightCapabilityEffective;
  const playwrightManagedStateDir = playwrightCliEnabled && input.operation !== "uninstall" && input.operation !== "models"
    ? dataDir() : undefined;
  const playwrightDispatcherPath = playwrightManagedStateDir === undefined
    ? undefined : path.join(path.dirname(stackRoot()), "dist", "browser-playwright.js");
  // Native transport is selected only from the verified candidate contract.
  // The native provider/config phase runs before the private Pi activation and
  // before projection, so the granular authority is published by the projection
  // receipt and the active checker runs before the internal sync.
  // Native transport is selected from the verified candidate contract, or, when
  // no new candidate is injected (diagnose/sync/models/uninstall), from the
  // validated installed contract — never by defaulting to legacy. A corrupt
  // owned link/contract blocks generically instead of silently falling back.
  const activeAgentDir = path.dirname(piSystemPromptFile(input.targetDir));
  let installedNative = false;
  if (effectiveCandidate === undefined) {
    try {
      installedNative = isInstalledNativePackage(activeAgentDir);
    } catch (error) {
      return {
        kind: "blocked",
        reason: "native-installed-invalid",
        remedy: `${error instanceof Error ? error.message : String(error)}; revisa el enlace y el receipt nativos antes de reintentar.`,
      };
    }
  }
  const nativeTransport = effectiveCandidate?.contract?.mcpNative !== undefined || installedNative;
  const nativeHomeDir = input.targetDir === undefined ? os.homedir() : path.join(path.resolve(input.targetDir), "home");
  // All native backups for a target stay under the validated target root; only
  // the real scope uses the default HOME backup area.
  const nativeBackupRoot = input.targetDir === undefined ? undefined : path.join(path.resolve(input.targetDir), "backups");
  let nativeAuthority: PiProjectionMcpNativeAuthority | undefined;
  let nativePrepared: NativeMcpPreparedWrite | undefined;
  if (nativeTransport && (input.operation === "install" || input.operation === "update")) {
    if (effectivePrepared === undefined) {
      return { kind: "blocked", reason: "stage-unverified", remedy: "La fase nativa exige el stage preverificado del preflight." };
    }
    if (input.engramBin === null) {
      return { kind: "blocked", reason: "engram-required", remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar." };
    }
    if (input.targetDir !== undefined && input.nativeProviderStage === undefined) {
      return {
        kind: "blocked",
        reason: "native-target-provider-required",
        remedy: "El target nativo aislado exige el stage de provider ya verificado inyectado; no se descarga en el target.",
      };
    }
    // Install over an already-managed install routes to the update branch (the
    // same preflight decision the runtime makes), so the phase must not re-seed a
    // fresh registration; a truly absent receipt stays fresh.
    const nativeFresh = input.operation === "install" && !hasManagedPiReceipt(nativeHomeDir);
    // On a non-fresh native update (including install routed to update), the OLD
    // active package and its native claims must be authenticated before this
    // operation promotes providers or prepares/publishes anything. The
    // post-activation checker remains a distinct fresh/activation proof.
    if (!nativeFresh) {
      const claims = previousNativeClaimNames(nativeHomeDir);
      if (claims !== null && claims.length > 0) {
        const inspected = await inspectAuthenticatedNativeOwnership({
          activeAgentDir,
          homeDir: nativeHomeDir,
          targetDir: input.targetDir,
          executable: input.detected.executable,
          engramBin: input.engramBin,
        });
        if (inspected.kind === "blocked") {
          return { kind: "blocked", reason: inspected.reason, remedy: inspected.remedy };
        }
        if (inspected.ownership.package.state !== "verified") {
          return { kind: "blocked", reason: "native-package-unverified", remedy: "La comprobación nativa activa no acreditó el paquete (estado no verified); no se renueva la autoridad. Pi no quedó activado." };
        }
        for (const name of claims) {
          const server = inspected.ownership.servers[name];
          if (server.state === "absent") continue; // the phase reports the precise claim-absent error
          if (server.state !== "managed") {
            return { kind: "blocked", reason: "native-authority-unverifiable", remedy: `La comprobación nativa activa no acredita la reclamación previa de ${name} como managed/verified; no se renueva la autoridad. Pi no quedó activado.` };
          }
        }
      }
    }
    const phase = await runNativePiMcpPhase({
      homeDir: nativeHomeDir,
      agentDir: activeAgentDir,
      engramBin: input.engramBin,
      piExecutable: input.detected.executable,
      stageDir: effectivePrepared.stageDir,
      fresh: nativeFresh,
      bootstrapDirs: nativeFresh,
      ...(input.targetDir === undefined ? {} : { targetDir: input.targetDir }),
      ...(requestedEngramTypeboxCompat === undefined ? {} : { engramTypeboxCompat: requestedEngramTypeboxCompat }),
      ...(nativeBackupRoot === undefined ? {} : { backupRoot: nativeBackupRoot }),
      ...(needsDevtoolsObservation ? { devtoolsManagedStateDir } : {}),
      ...(input.nativeProviderStage === undefined ? {} : { providerStage: input.nativeProviderStage }),
    });
    if (phase.kind === "blocked") return { kind: "blocked", reason: phase.reason, remedy: phase.remedy };
    nativeAuthority = phase.authority;
    nativePrepared = phase.prepared;
  }
  // Canonical native target artifact cache: place the injected, already-verified
  // artifact under `<target>/home/.jorgex-stack/packages` (local copy, no target
  // network) so the active checker's package proof reads the same bytes.
  if (nativeTransport && input.targetDir !== undefined && effectivePrepared !== undefined && effectiveCandidate !== undefined) {
    const cacheDir = path.join(path.resolve(input.targetDir), "home", ".jorgex-stack", "packages");
    const cacheFile = path.join(cacheDir, `jorgex-pi-${effectiveCandidate.package.version}.tgz`);
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(cacheFile)) {
        const bytes = fs.readFileSync(effectivePrepared.artifact.path);
        if (createHash("sha256").update(bytes).digest("hex") !== effectivePrepared.artifact.sha256) {
          throw new Error("injected Pi artifact digest does not match its verified evidence");
        }
        fs.writeFileSync(cacheFile, bytes, { mode: 0o600 });
      }
    } catch (error) {
      return { kind: "blocked", reason: "native-cache-failed", remedy: `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.` };
    }
  }
  let effectivePackageSource: string = PI_RUNTIME_CANDIDATE.package.source;
  // Pending native MCP config write: the phase prepared the owned entries and the
  // exact CAS snapshots; the existing projection lifecycle invokes this after the
  // handoff is applied/readback and before publishing the final receipt/authority.
  // It exposes rollback of its exact MCP write (no one-shot "done" flag), so the
  // lifecycle can recover until the receipt actually commits.
  const pendingNativeConfigWrite = nativePrepared === undefined ? undefined : (() => {
    const prepared = nativePrepared;
    let wrote = false;
    let ownRaw: string | null = null;
    const currentRaw = (): string | null => readNativeMcpSnapshot(prepared.agentDir).raw;
    const rollbackOwnWrite = (): boolean => {
      if (!wrote || ownRaw === null) return true;
      if (currentRaw() !== ownRaw) return false; // concurrent drift: preserve
      try {
        restoreOwnedWrite(prepared.snapshot.file, ownRaw, prepared.snapshot.raw);
        return true;
      } catch {
        return false;
      }
    };
    const write = (): { kind: "ok"; recover: () => boolean; paths: string[] } => {
      let baseRaw = prepared.snapshot.raw;
      let baseParsed = prepared.snapshot.parsed;
      if (prepared.removals.length > 0) {
        const removed = removeNativeMcpEntries({
          agentDir: prepared.agentDir,
          names: [...prepared.removals],
          expectedRaw: baseRaw,
          expectedParsed: baseParsed,
          ...(prepared.backupRoot === undefined ? {} : { backupRoot: prepared.backupRoot }),
        });
        ownRaw = removed.writtenRaw;
        wrote = true;
        const afterRemoval = readNativeMcpSnapshot(prepared.agentDir);
        baseRaw = afterRemoval.raw;
        baseParsed = afterRemoval.parsed;
      }
      if (prepared.created.length > 0) {
        const written = writeNativeMcpConfig({
          agentDir: prepared.agentDir,
          servers: [...prepared.created],
          expectedRaw: baseRaw,
          expectedParsed: baseParsed,
          ...(prepared.backupRoot === undefined ? {} : { backupRoot: prepared.backupRoot }),
        });
        ownRaw = written.writtenRaw;
        wrote = true;
      }
      return { kind: "ok" as const, recover: rollbackOwnWrite, paths: [prepared.snapshot.file] };
    };
    return () => {
      if (wrote && ownRaw !== null && currentRaw() === ownRaw) {
        return { kind: "ok" as const, recover: rollbackOwnWrite, paths: [prepared.snapshot.file] };
      }
      try {
        return write();
      } catch (error) {
        // Roll back this callback's own partial config only while it still holds
        // our bytes; report incomplete recovery otherwise.
        const rolledBack = rollbackOwnWrite();
        return {
          kind: "blocked" as const,
          reason: "native-config-write-failed",
          remedy: `${error instanceof Error ? error.message : String(error)};${rolledBack ? "" : " recuperación incompleta del config nativo;"} revisa mcp.json y reintenta.`,
        };
      }
    };
  })();
  const projectionInput = {
    writingStyle,
    targetDir: input.targetDir,
    packageSource: PI_RUNTIME_CANDIDATE.package.source,
    engramBin: input.engramBin,
    playwrightCliEnabled,
    playwrightHandoffEnabled: playwrightCliEnabled,
    playwrightCliCommand: null,
    playwrightCliVersion: null,
    playwrightManagedStateDir,
    playwrightDispatcherPath,
    devtoolsMcpEnabled,
    devtoolsManagedStateDir: needsDevtoolsObservation ? devtoolsManagedStateDir : undefined,
    pnpmBin: null,
    devtoolsMcpVersion,
    ...(input.nativeLayout === true ? { nativeLayout: true } : {}),
    ...(nativeAuthority === undefined ? {} : { nativeMcpAuthority: nativeAuthority }),
    ...(pendingNativeConfigWrite === undefined ? {} : { pendingNativeConfigWrite }),
  };
  if (preparedStyle !== undefined && input.operation !== "doctor") applyWritingStyle(preparedStyle);
  let result = await runManagedPiOperation(input.operation, {
    installInitRemedy: input.targetDir === undefined ? undefined : INSTALL_INIT_TARGET_REMEDY,
    async runPackage(operation) {
      const raw = await runPiRuntimeSystem({
        ...runtimeInput,
        candidate: effectiveCandidate,
        ...(effectivePrepared === undefined ? {} : { prepared: effectivePrepared }),
        operation,
        ...(upgradePermissions ? { upgradePermissions: true as const } : {}),
      });
      if (effectiveCandidate !== undefined
        && ((operation === "install" || operation === "update")
          && (raw.kind === "installed" || raw.kind === "updated"))) {
        const expected = effectiveCandidate.package;
        const receipt = raw.receipt as
          | { candidate?: { package?: { name?: unknown; version?: unknown; source?: unknown } }; package?: { name?: unknown; version?: unknown; source?: unknown } }
          | undefined;
        const observed = receipt?.candidate?.package ?? receipt?.package;
        if (
          observed?.name !== expected.name ||
          observed?.version !== expected.version ||
          observed?.source !== expected.source
        ) {
          return {
            kind: "blocked",
            reason: "receipt-mismatch",
            remedy: "El receipt instalado no coincide con el candidato preparado; revisa el stage y reintenta.",
          } as const;
        }
        effectivePackageSource = observed.source as string;
      }
      if (
        ((operation === "sync" && raw.kind === "synced") ||
          (operation === "doctor" && raw.kind === "healthy") ||
          ((operation === "update" || operation === "install") && raw.kind === "healthy")) &&
        "packageSource" in raw &&
        raw.packageSource !== undefined
      ) {
        const provided = raw.packageSource;
        if (
          typeof provided !== "string" ||
          !/^npm:jorgex-pi@((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.test(provided)
        ) {
          return {
            kind: "blocked",
            reason: "package-source-invalid",
            remedy: "La fuente del paquete sincronizado es inválida; revisa el receipt y reintenta.",
          } as const;
        }
        effectivePackageSource = provided;
      }
      return managedPackageResult(raw);
    },
    runProjection(operation) {
      if (playwrightCliEnabled || devtoolsMcpEnabled) {
        const packageRoot = path.join(path.dirname(piSystemPromptFile(input.targetDir)), "npm", "node_modules", "jorgex-pi");
        try {
          requirePiBrowserHandoffSchemas(packageRoot, {
            ...(playwrightCliEnabled ? { playwright: 2 } : {}),
            ...(devtoolsMcpEnabled ? { devtools: 3 } : {}),
          });
        } catch (error) {
          return Promise.resolve({ kind: "blocked" as const, reason: "browser-handoff-unsupported",
            remedy: `${error instanceof Error ? error.message : String(error)}. Ejecuta install --agents pi con un paquete compatible antes de activar el navegador.` });
        }
      }
      const result = runPiProjectionLifecycleSystem({
        operation,
        ...projectionInput,
        packageSource: effectivePackageSource,
      });
      return Promise.resolve(result.kind === "drift"
        ? {
            kind: "drift" as const,
            paths: result.paths,
            remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
          }
        : result);
    },
    prepareProjectionUninstall() {
      const result = preparePiProjectionUninstallSystem({ operation: "uninstall", ...projectionInput });
      return Promise.resolve(result.kind === "prepared" ? { kind: "prepared" as const, token: result.plan } : result);
    },
    completeProjectionUninstall(token) {
      return Promise.resolve(completePiProjectionUninstallSystem(token, { operation: "uninstall", ...projectionInput }));
    },
    ...(nativeTransport && input.operation === "uninstall" ? {
      beforePackageDeactivation: async (): Promise<{ kind: "ok" } | { kind: "blocked"; reason: string; remedy?: string }> => {
        try {
          const inspected = await inspectAuthenticatedNativeOwnership({
            activeAgentDir,
            homeDir: nativeHomeDir,
            targetDir: input.targetDir,
            executable: input.detected.executable,
            engramBin: input.engramBin,
          });
          if (inspected.kind === "blocked") {
            return { kind: "blocked" as const, reason: inspected.reason, remedy: `${inspected.remedy} No se desactivó nada.` };
          }
          const removable = inspected.ownership.package.state === "verified"
            ? NATIVE_MCP_SERVER_NAMES.filter((name) => inspected.ownership.servers[name].state === "managed" && inspected.ownership.servers[name].cleanupEligible === true)
            : [];
          if (removable.length > 0) {
            removeNativeMcpEntries({
              agentDir: activeAgentDir,
              names: removable,
              expectedRaw: inspected.snapshot.raw,
              expectedParsed: inspected.snapshot.parsed,
              ...(nativeBackupRoot === undefined ? {} : { backupRoot: nativeBackupRoot }),
            });
          }
          reconcileNativeAuthorityAfterCleanup({
            homeDir: nativeHomeDir,
            agentDir: activeAgentDir,
            scopeKind: input.targetDir === undefined ? "real" : "target-dir",
            removable,
            ownership: inspected.ownership,
            expectedAuthorityRaw: inspected.authorityRaw,
            ...(nativeBackupRoot === undefined ? {} : { backupRoot: nativeBackupRoot }),
          });
          return { kind: "ok" as const };
        } catch (error) {
          return {
            kind: "blocked" as const,
            reason: "native-cleanup-failed",
            remedy: `${error instanceof Error ? error.message : String(error)}; revisa mcp.json y la autoridad antes de reintentar. No se desactivó nada.`,
          };
        }
      },
    } : {}),
    ...(nativeTransport ? {
      beforeInitialization: async (): Promise<{ kind: "ok" } | { kind: "blocked"; reason: string; remedy?: string }> => {
        try {
          const activeEntry = resolveActivePiEntry(activeAgentDir);
          if (activeEntry.kind === "absent") {
            return { kind: "blocked" as const, reason: "native-active-entry-absent", remedy: "La entrada nativa activa falta; inicialización nativa pendiente." };
          }
          const authenticated = authenticateActiveNativePackage({
            activeAgentDir,
            homeDir: nativeHomeDir,
            targetDir: input.targetDir,
            executable: input.detected.executable,
            engramBin: input.engramBin,
          });
          if (authenticated.kind === "blocked") return authenticated;
          if (path.resolve(authenticated.realRoot) !== path.resolve(activeEntry.packageRoot)) {
            return { kind: "blocked" as const, reason: "native-package-drift", remedy: "La raíz autenticada no coincide con la topología del enlace activo; inicialización nativa pendiente." };
          }
          const before = readNativeMcpSnapshot(activeAgentDir);
          const ownership = await inspectNativeMcpOwnership(
            authenticated.realRoot,
            {
              env: { HOME: nativeHomeDir, USERPROFILE: nativeHomeDir, PI_CODING_AGENT_DIR: activeAgentDir },
              platform: process.platform,
              cwd: process.cwd(),
              projectTrusted: false,
            },
          );
          const after = readNativeMcpSnapshot(activeAgentDir);
          if (after.raw !== before.raw) {
            return { kind: "blocked" as const, reason: "native-config-changed", remedy: "mcp.json cambió durante la comprobación; se conserva sin modificar e inicialización nativa pendiente." };
          }
          const conflicts = Object.values(ownership.servers).filter((server) => server.state === "conflict");
          if (ownership.package.state === "conflict" || conflicts.length > 0) {
            return {
              kind: "blocked" as const,
              reason: "native-checker-conflict",
              remedy: "El paquete Pi quedó activado; la comprobación nativa detectó un conflicto de propiedad sobre mcp.json/autoridad. Resuélvelo y ejecuta sync --agents pi para completar la inicialización.",
            };
          }
          if (nativeAuthority !== undefined
            && Object.keys(nativeAuthority.entries).length > 0
            && ownership.package.state !== "verified") {
            return {
              kind: "blocked" as const,
              reason: "native-package-unverified",
              remedy: "El paquete Pi quedó activado; la comprobación nativa no acreditó el paquete (estado no verified). Revisa receipt/artefacto y ejecuta sync --agents pi para completar la inicialización.",
            };
          }
          return { kind: "ok" as const };
        } catch (error) {
          return {
            kind: "blocked" as const,
            reason: "native-checker-failed",
            remedy: `El paquete Pi quedó activado; la comprobación nativa falló: ${error instanceof Error ? error.message : String(error)}. Inicialización nativa pendiente; ejecuta sync --agents pi para reintentar.`,
          };
        }
      },
    } : {}),
  });
  if (!nativeTransport && input.targetDir === undefined && (input.operation === "install" || input.operation === "update") && result.kind !== "blocked") {
    try {
      if (input.engramBin === null) throw new Error("Engram no disponible para verificar los providers Pi");
      const providers = await updatePiProviderPackages({
        homeDir: os.homedir(), agentDir: path.dirname(piSystemPromptFile()),
        piExecutable: input.detected.executable, engramBin: input.engramBin,
        ...(requestedEngramTypeboxCompat === true ? { engramTypeboxCompat: true as const } : {}),
      });
      if (providers.kind === "updated" && result.kind === "healthy") result = { kind: "updated" };
    } catch (error) {
      return { kind: "blocked", reason: "provider-update-failed", remedy: `La fase principal de Pi terminó, pero la actualización de providers está incompleta: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (input.targetDir === undefined
    && (explicitDevtools !== undefined || devtoolsVerifiedForPersist !== undefined)
    && (input.operation === "install" || input.operation === "sync" || input.operation === "update")
    && result.kind !== "blocked") {
    if (devtoolsVerifiedForPersist !== undefined) {
      saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi", true, devtoolsVerifiedForPersist);
    } else if (explicitDevtools !== undefined) {
      saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi", explicitDevtools);
    }
  }
  if (input.targetDir === undefined && supportsPlaywright
    && (explicitPlaywright !== undefined || refreshedPlaywright !== undefined)
    && (input.operation === "install" || input.operation === "sync" || input.operation === "update")
    && result.kind !== "blocked") {
    if (refreshedPlaywright !== undefined) {
      savePlaywrightCliPreference(
        playwrightCliPreferenceFile(),
        true,
        { pi: true },
        refreshedPlaywright.observed,
      );
    } else {
      savePlaywrightCliPreference(playwrightCliPreferenceFile(), true, { pi: explicitPlaywright ?? true });
    }
  }
  return result;
}
