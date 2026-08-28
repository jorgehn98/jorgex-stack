import { runPiProjectionLifecycleSystem } from "./pi-projection-lifecycle.js";
import { PI_RUNTIME_CANDIDATE, runPiRuntimeSystem, type PiRuntimeInput } from "./pi-runtime.js";
import { loadPlaywrightCliPreference } from "./tool-preferences.js";

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

export interface PiManagedRuntimeDeps {
  runPackage(operation: PiManagedOperation): Promise<PiManagedPackageResult>;
  runProjection(operation: PiProjectionOperation): Promise<PiManagedProjectionResult>;
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

export async function runManagedPiOperation(
  operation: PiManagedOperation,
  deps: PiManagedRuntimeDeps,
): Promise<PiManagedOperationResult> {
  const packageResult = await deps.runPackage(operation);
  if (packageResult.kind === "manual-existing") return manualExistingResult(packageResult);
  if (operation === "models") return packageResult;

  const nextProjectionOperation = projectionOperation(operation);
  if (packageResult.kind !== "blocked") {
    return completeProjection(nextProjectionOperation, packageResult, deps);
  }

  if (packageResult.reason !== "source-divergent" || (operation !== "sync" && operation !== "update")) {
    return packageResult;
  }

  const recoveryProjection = await deps.runProjection("sync");
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
export async function runManagedPiSystem(input: PiRuntimeInput): Promise<PiManagedOperationResult> {
  const playwrightCliEnabled = input.targetDir === undefined && loadPlaywrightCliPreference() === true;
  return runManagedPiOperation(input.operation, {
    async runPackage(operation) {
      return managedPackageResult(await runPiRuntimeSystem({ ...input, operation }));
    },
    runProjection(operation) {
      const result = runPiProjectionLifecycleSystem({
        operation,
        targetDir: input.targetDir,
        packageSource: PI_RUNTIME_CANDIDATE.package.source,
        engramBin: input.engramBin,
        playwrightCliEnabled,
      });
      return Promise.resolve(result.kind === "drift"
        ? {
            kind: "drift" as const,
            paths: result.paths,
            remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
          }
        : result);
    },
  });
}
