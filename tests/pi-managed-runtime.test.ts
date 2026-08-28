import { describe, expect, it } from "vitest";

type Operation = "install" | "sync" | "models" | "doctor" | "uninstall" | "update";
type ProjectionOperation = Exclude<Operation, "models" | "update">;

type PackageResult =
  | { kind: "installed" }
  | { kind: "synced" }
  | { kind: "models"; models: { mode: "inherit-session"; tiers: ["strong", "standard", "cheap"] } }
  | { kind: "healthy" }
  | { kind: "uninstalled" }
  | { kind: "updated" }
  | { kind: "manual-existing" }
  | { kind: "blocked"; reason: string };

type ProjectionBlockedResult = {
  kind: "blocked";
  reason: "projection-backup-failed" | "projection-cleanup-failed" | "source-divergent";
};

type ProjectionResult =
  | { kind: "installed" }
  | { kind: "synced"; changed: boolean }
  | { kind: "healthy" }
  | { kind: "drift"; paths: string[]; remedy: string }
  | { kind: "uninstalled" }
  | ProjectionBlockedResult;

type ProjectionUninstallPreparation = ProjectionBlockedResult | { kind: "prepared"; token: string };
type ProjectionUninstallCompletion = ProjectionBlockedResult | { kind: "uninstalled" };

type ManagedResult = Exclude<PackageResult, { kind: "manual-existing" }>
  | { kind: "blocked"; reason: "manual-existing" }
  | { kind: "blocked"; reason: "projection-drift"; paths: string[]; remedy: string };

type ManagedRuntimeDeps = {
  runPackage(operation: Operation): Promise<PackageResult>;
  runProjection(operation: ProjectionOperation): Promise<ProjectionResult>;
  prepareProjectionUninstall(): Promise<ProjectionUninstallPreparation>;
  completeProjectionUninstall(token: string): Promise<ProjectionUninstallCompletion>;
};

type PiManagedRuntime = {
  runManagedPiOperation(
    operation: Operation,
    deps: ManagedRuntimeDeps,
  ): Promise<ManagedResult>;
};

async function managedRuntime(): Promise<PiManagedRuntime> {
  const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as Partial<PiManagedRuntime>;
  expect(mod.runManagedPiOperation).toBeTypeOf("function");
  return mod as PiManagedRuntime;
}

const successfulResults: Record<Operation, PackageResult> = {
  install: { kind: "installed" },
  sync: { kind: "synced" },
  models: { kind: "models", models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] } },
  doctor: { kind: "healthy" },
  uninstall: { kind: "uninstalled" },
  update: { kind: "updated" },
};

function projectionSuccess(operation: ProjectionOperation, changed = false): ProjectionResult {
  if (operation === "install") return { kind: "installed" };
  if (operation === "sync") return { kind: "synced", changed };
  if (operation === "doctor") return { kind: "healthy" };
  return { kind: "uninstalled" };
}

function withUninstallLifecycle(
  deps: Omit<ManagedRuntimeDeps, "prepareProjectionUninstall" | "completeProjectionUninstall">
    & Partial<Pick<ManagedRuntimeDeps, "prepareProjectionUninstall" | "completeProjectionUninstall">>,
): ManagedRuntimeDeps {
  return {
    async prepareProjectionUninstall() {
      return { kind: "prepared", token: "projection-uninstall-token" };
    },
    async completeProjectionUninstall() {
      return { kind: "uninstalled" };
    },
    ...deps,
  };
}

describe("Pi managed package and projection coordination", () => {
  it.each([
    ["models", "models", undefined],
    ["install", "install", "install"],
    ["sync", "sync", "sync"],
    ["update", "update", "sync"],
    ["doctor", "doctor", "doctor"],
  ] as const)("runs %s through package%s", async (operation, packageOperation, projectionOperation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return successfulResults[packageOperation];
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    }));

    expect(result).toEqual(successfulResults[operation]);
    expect(trace).toEqual(projectionOperation === undefined
      ? [`package:${packageOperation}`]
      : [`package:${packageOperation}`, `projection:${projectionOperation}`]);
  });

  it("blocks doctor on projection drift while preserving diagnostic paths and remedy", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    const paths = ["C:/target/home/.agents/skills/tdd/SKILL.md"];
    const remedy = "Ejecuta sync para reparar la proyección de Pi.";

    const result = await runManagedPiOperation("doctor", withUninstallLifecycle({
      async runPackage(operation) {
        trace.push(`package:${operation}`);
        return { kind: "healthy" };
      },
      async runProjection(operation) {
        trace.push(`projection:${operation}`);
        return { kind: "drift", paths, remedy };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "projection-drift", paths, remedy });
    expect(trace).toEqual(["package:doctor", "projection:doctor"]);
  });

  it.each(["install", "sync", "models", "doctor", "uninstall", "update"] as const)("blocks %s on a manually managed Pi package without projecting", async (operation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return { kind: "manual-existing" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "manual-existing" });
    expect(trace).toEqual([`package:${operation}`]);
  });

  it.each([
    ["install", "runner-unhealthy"],
    ["sync", "receipt-corrupt"],
    ["models", "runner-unhealthy"],
    ["doctor", "runner-unhealthy"],
    ["uninstall", "runner-unhealthy"],
    ["update", "receipt-corrupt"],
  ] as const)("does not project when package %s is blocked by %s", async (operation, reason) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return { kind: "blocked", reason };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason });
    expect(trace).toEqual([`package:${operation}`]);
  });

  it.each(["sync", "update"] as const)("repairs source divergence for %s once, then completes an idempotent projection", async (operation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    let packageAttempts = 0;
    let projectionAttempts = 0;

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        packageAttempts += 1;
        return packageAttempts === 1
          ? { kind: "blocked", reason: "source-divergent" }
          : successfulResults[operation];
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        projectionAttempts += 1;
        return { kind: "synced", changed: projectionAttempts === 1 };
      },
    }));

    expect(result).toEqual(successfulResults[operation]);
    expect(trace).toEqual([
      `package:${operation}`,
      "projection:sync",
      `package:${operation}`,
      "projection:sync",
    ]);
  });

  it.each(["sync", "update"] as const)("does not retry %s when projection sync is already idempotent", async (operation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return { kind: "blocked", reason: "source-divergent" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return { kind: "synced", changed: false };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "source-divergent" });
    expect(trace).toEqual([`package:${operation}`, "projection:sync"]);
  });

  it.each(["sync", "update"] as const)("does not retry %s again when its single recovery attempt remains blocked", async (operation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    let packageAttempts = 0;

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        packageAttempts += 1;
        return packageAttempts === 1
          ? { kind: "blocked", reason: "source-divergent" }
          : { kind: "blocked", reason: "runner-unhealthy" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return { kind: "synced", changed: true };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "runner-unhealthy" });
    expect(trace).toEqual([`package:${operation}`, "projection:sync", `package:${operation}`]);
  });

  it.each([
    ["install", "install", "projection-backup-failed"],
    ["sync", "sync", "projection-backup-failed"],
    ["update", "sync", "projection-backup-failed"],
  ] as const)("propagates a %s blocked projection from %s", async (operation, projectionOperation, reason) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return successfulResults[next];
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return { kind: "blocked", reason };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason });
    expect(trace).toEqual([`package:${operation}`, `projection:${projectionOperation}`]);
  });

  it.each([
    ["a corrupt receipt", "projection-cleanup-failed"],
    ["a failed pre-uninstall backup", "projection-backup-failed"],
  ] as const)("does not uninstall the package when preparation reports %s", async (_case, reason) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("uninstall", withUninstallLifecycle({
      async runPackage(operation) {
        trace.push(`package:${operation}`);
        return { kind: "uninstalled" };
      },
      async runProjection(operation) {
        trace.push(`projection:${operation}`);
        return projectionSuccess(operation);
      },
      async prepareProjectionUninstall() {
        trace.push("prepare:uninstall");
        return { kind: "blocked", reason };
      },
    }));

    expect(trace).toEqual(["prepare:uninstall"]);
    expect(result).toEqual({ kind: "blocked", reason });
  });

  it("prepares the projection before uninstalling the package and completes it after success", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("uninstall", withUninstallLifecycle({
      async runPackage(operation) {
        trace.push(`package:${operation}`);
        return { kind: "uninstalled" };
      },
      async runProjection(operation) {
        trace.push(`projection:${operation}`);
        return projectionSuccess(operation);
      },
      async prepareProjectionUninstall() {
        trace.push("prepare:uninstall");
        return { kind: "prepared", token: "prepared-uninstall-token" };
      },
      async completeProjectionUninstall(token) {
        trace.push(`complete:${token}`);
        return { kind: "uninstalled" };
      },
    }));

    expect(result).toEqual({ kind: "uninstalled" });
    expect(trace).toEqual([
      "prepare:uninstall",
      "package:uninstall",
      "complete:prepared-uninstall-token",
    ]);
  });

  it("does not complete the projection when package uninstall is blocked", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("uninstall", withUninstallLifecycle({
      async runPackage(operation) {
        trace.push(`package:${operation}`);
        return { kind: "blocked", reason: "runner-unhealthy" };
      },
      async runProjection(operation) {
        trace.push(`projection:${operation}`);
        return projectionSuccess(operation);
      },
      async prepareProjectionUninstall() {
        trace.push("prepare:uninstall");
        return { kind: "prepared", token: "prepared-uninstall-token" };
      },
      async completeProjectionUninstall(token) {
        trace.push(`complete:${token}`);
        return { kind: "uninstalled" };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "runner-unhealthy" });
    expect(trace).toEqual(["prepare:uninstall", "package:uninstall"]);
  });

  it("propagates a completion failure and permits a fresh uninstall retry", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    let attempts = 0;

    const deps = withUninstallLifecycle({
      async runPackage(operation) {
        trace.push(`package:${operation}`);
        return { kind: "uninstalled" };
      },
      async runProjection(operation) {
        trace.push(`projection:${operation}`);
        return projectionSuccess(operation);
      },
      async prepareProjectionUninstall() {
        attempts += 1;
        const token = `prepared-uninstall-token-${attempts}`;
        trace.push(`prepare:${token}`);
        return { kind: "prepared", token };
      },
      async completeProjectionUninstall(token) {
        trace.push(`complete:${token}`);
        return token === "prepared-uninstall-token-1"
          ? { kind: "blocked", reason: "projection-cleanup-failed" }
          : { kind: "uninstalled" };
      },
    });

    await expect(runManagedPiOperation("uninstall", deps)).resolves.toEqual({
      kind: "blocked",
      reason: "projection-cleanup-failed",
    });
    await expect(runManagedPiOperation("uninstall", deps)).resolves.toEqual({ kind: "uninstalled" });
    expect(trace).toEqual([
      "prepare:prepared-uninstall-token-1",
      "package:uninstall",
      "complete:prepared-uninstall-token-1",
      "prepare:prepared-uninstall-token-2",
      "package:uninstall",
      "complete:prepared-uninstall-token-2",
    ]);
  });

  it.each(["sync", "update"] as const)("propagates a blocked recovery projection for %s", async (operation) => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation(operation, withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        return { kind: "blocked", reason: "source-divergent" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return { kind: "blocked", reason: "projection-backup-failed" };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "projection-backup-failed" });
    expect(trace).toEqual([`package:${operation}`, "projection:sync"]);
  });
});
