import { runPiProjectionLifecycleSystem } from "./pi-projection-lifecycle.js";
import { PI_RUNTIME_CANDIDATE, runPiRuntimeSystem, type PiRuntimeInput } from "./pi-runtime.js";
import { loadPlaywrightCliPreference } from "./tool-preferences.js";

export type PiManagedOperation = "install" | "sync" | "models" | "doctor" | "uninstall" | "update";
type PiProjectionOperation = Exclude<PiManagedOperation, "models" | "update">;

export type PiManagedPackageResult =
  | { kind: "installed" }
  | { kind: "synced" }
  | { kind: "models"; models?: unknown }
  | { kind: "healthy" }
  | { kind: "uninstalled" }
  | { kind: "updated" }
  | { kind: "blocked"; reason: string; remedy?: string };

export type PiManagedProjectionResult =
  | { kind: "installed" }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[] }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: string; remedy?: string };

export type PiManagedOperationResult = PiManagedPackageResult | { kind: "blocked"; reason: "projection-drift"; remedy?: string };

export interface PiManagedRuntimeDeps {
  runPackage(operation: PiManagedOperation): Promise<PiManagedPackageResult>;
  runProjection(operation: PiProjectionOperation): Promise<PiManagedProjectionResult>;
}

function projectionOperation(operation: Exclude<PiManagedOperation, "models">): PiProjectionOperation {
  return operation === "update" ? "sync" : operation;
}

async function completeProjection(
  operation: PiProjectionOperation,
  packageResult: PiManagedPackageResult,
  deps: PiManagedRuntimeDeps,
): Promise<PiManagedOperationResult> {
  const projectionResult = await deps.runProjection(operation);
  if (projectionResult.kind === "drift") return { kind: "blocked", reason: "projection-drift" };
  return projectionResult.kind === "blocked" ? projectionResult : packageResult;
}

export async function runManagedPiOperation(
  operation: PiManagedOperation,
  deps: PiManagedRuntimeDeps,
): Promise<PiManagedOperationResult> {
  const packageResult = await deps.runPackage(operation);
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
  if (retryResult.kind === "blocked") return retryResult;
  return completeProjection("sync", retryResult, deps);
}

/** Coordina el paquete Pi con la proyección compartida de Stack. */
export async function runManagedPiSystem(input: PiRuntimeInput): Promise<PiManagedOperationResult> {
  const playwrightCliEnabled = input.targetDir === undefined && loadPlaywrightCliPreference() === true;
  return runManagedPiOperation(input.operation, {
    runPackage: (operation) => runPiRuntimeSystem({ ...input, operation }) as Promise<PiManagedPackageResult>,
    runProjection: (operation) => Promise.resolve(runPiProjectionLifecycleSystem({
      operation,
      targetDir: input.targetDir,
      packageSource: PI_RUNTIME_CANDIDATE.package.source,
      engramBin: input.engramBin,
      playwrightCliEnabled,
    })),
  });
}