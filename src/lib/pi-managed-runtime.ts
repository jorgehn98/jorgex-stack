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
import { resolvePnpmBin } from "./external-tools.js";
import type { PlaywrightCapabilitySnapshot } from "./playwright-capability.js";
import { piSystemPromptFile } from "../adapters/pi.js";
import { assertSystemPromptFile } from "./system-prompt-sections.js";
import { prepareVerifiedBrowserRelease, verifyDevtoolsCliArtifact } from "./browser-provider.js";

const DEVTOOLS_STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isCanonicalDevtoolsIntegrity(integrity: unknown): integrity is string {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return false;
  const b64 = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  return bytes.length === 64 && bytes.toString("base64") === b64;
}

function isValidDevtoolsObserved(value: unknown): value is ObservedVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === "string"
    && DEVTOOLS_STABLE_SEMVER.test(record.version)
    && isCanonicalDevtoolsIntegrity(record.integrity);
}

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

/** Coordina el paquete Pi con la proyección compartida de Stack. */
export async function runManagedPiSystem(input: PiRuntimeInput & {
  devtoolsMcpEnabled?: boolean;
  devtoolsMcpObservedVersion?: ObservedVersion | null;
  writingStyle?: WritingStyleSnapshot;
  writingStyleMode?: InstallMode;
  playwrightCliEnabled?: boolean;
  playwrightCapability?: PlaywrightCapabilitySnapshot;
  packageOnly?: boolean;
  upgradePermissions?: boolean;
}): Promise<PiManagedOperationResult> {
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
    packageOnly,
    writingStyle: suppliedStyle,
    writingStyleMode,
    upgradePermissions: requestedUpgrade,
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
  const devtoolsMcpEnabled = explicitDevtools
    ?? (input.targetDir === undefined && loadDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi"));
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
  if (needsDevtoolsObservation) {
    if (input.targetDir !== undefined) {
      devtoolsMcpObservedVersion = isValidDevtoolsObserved(injectedDevtoolsObserved)
        ? { version: injectedDevtoolsObserved.version, integrity: injectedDevtoolsObserved.integrity }
        : null;
    } else if ((input.operation === "install" || input.operation === "update") && explicitDevtools === true) {
      if (isValidDevtoolsObserved(injectedDevtoolsObserved)) {
        devtoolsMcpObservedVersion = { version: injectedDevtoolsObserved.version, integrity: injectedDevtoolsObserved.integrity };
        devtoolsVerifiedForPersist = devtoolsMcpObservedVersion;
      } else {
        let release: { version: string; integrity: string };
        try {
          const pnpmBin = resolvePnpmBin();
          if (pnpmBin === null) throw new Error("pnpm no disponible para comprobar los flags del CLI de DevTools");
          release = await prepareVerifiedBrowserRelease("chrome-devtools-mcp", {
            fetchImpl: globalThis.fetch,
            smoke: async ({ release, artifactPath, stageDir }) => {
              await verifyDevtoolsCliArtifact({ release, artifactPath, stageDir, pnpmBin });
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
        if (!isValidDevtoolsObserved(observed)) {
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
  const devtoolsMcpVersion = devtoolsMcpObservedVersion?.version ?? null;
  const supportsPlaywright = (PI_RUNTIME_CANDIDATE.contract.capabilities as readonly string[]).includes("playwright-handoff-v1");
  const persistedPlaywright = input.targetDir === undefined
    && loadPlaywrightCliPreference(undefined, "pi") === true;
  const selectedPlaywright = explicitPlaywright
    ?? persistedPlaywright;
  const playwrightCapabilityEffective = playwrightCapability?.effective === true;
  const playwrightCliEnabled = input.targetDir === undefined && supportsPlaywright
    && selectedPlaywright
    && playwrightCapabilityEffective;
  const playwrightCliCommand = playwrightCliEnabled && input.operation !== "uninstall" && input.operation !== "models"
    ? playwrightCapability?.cli.binPath ?? null
    : null;
  const playwrightCliVersion = playwrightCliEnabled && input.operation !== "uninstall" && input.operation !== "models"
    ? playwrightCapability?.cli.detectedVersion ?? null
    : null;
  let effectivePackageSource: string = PI_RUNTIME_CANDIDATE.package.source;
  const projectionInput = {
    writingStyle,
    targetDir: input.targetDir,
    packageSource: PI_RUNTIME_CANDIDATE.package.source,
    engramBin: input.engramBin,
    playwrightCliEnabled,
    playwrightHandoffEnabled: playwrightCliEnabled,
    playwrightCliCommand,
    playwrightCliVersion,
    devtoolsMcpEnabled,
    pnpmBin: devtoolsMcpEnabled && input.operation !== "uninstall" ? resolvePnpmBin() : null,
    devtoolsMcpVersion,
  };
  if (preparedStyle !== undefined && input.operation !== "doctor") applyWritingStyle(preparedStyle);
  const result = await runManagedPiOperation(input.operation, {
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
        && ((operation === "install" && raw.kind === "installed")
          || (operation === "update" && raw.kind === "updated"))) {
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
          (operation === "update" && raw.kind === "healthy")) &&
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
  });
  if (input.targetDir === undefined && explicitDevtools !== undefined
    && (input.operation === "install" || input.operation === "sync" || input.operation === "update") && result.kind !== "blocked") {
    if (explicitDevtools === true && devtoolsVerifiedForPersist !== undefined) {
      saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi", true, devtoolsVerifiedForPersist);
    } else {
      saveDevtoolsMcpPreference(devtoolsMcpPreferenceFile(), "pi", explicitDevtools);
    }
  }
  if (input.targetDir === undefined && supportsPlaywright && explicitPlaywright !== undefined
    && (input.operation === "install" || input.operation === "sync") && result.kind !== "blocked") {
    savePlaywrightCliPreference(playwrightCliPreferenceFile(), true, { pi: explicitPlaywright });
  }
  return result;
}
