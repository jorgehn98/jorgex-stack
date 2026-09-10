import { describe, expect, it, vi } from "vitest";

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

type PiManagedSystem = {
  runManagedPiSystem(input: {
    operation: Operation;
    targetDir?: string;
    detected: { executable: string; version: string };
    engramBin: string | null;
    devtoolsMcpEnabled?: boolean;
    playwrightCliEnabled?: boolean;
  }): Promise<unknown>;
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
  it("forwards the explicit DevTools choice through package and projection wrappers", async () => {
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const devtoolsPreferenceFile = "/isolated/state/devtools-mcp.json";
    const loadDevtoolsMcpPreference = vi.fn(() => false);
    const saveDevtoolsMcpPreference = vi.fn();
    const runPiRuntimeSystem = vi.fn(async (input: unknown): Promise<{ kind: string; reason?: string }> => {
      packageInputs.push(input);
      return { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown): { kind: string; reason?: string } => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        contract: { capabilities: [] },
      },
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem: vi.fn(),
      completePiProjectionUninstallSystem: vi.fn(),
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      devtoolsMcpPreferenceFile: vi.fn(() => devtoolsPreferenceFile),
      loadDevtoolsMcpPreference,
      saveDevtoolsMcpPreference,
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
      });

      expect(result).toEqual({ kind: "installed" });
      expect(packageInputs).toEqual([expect.objectContaining({
        operation: "install",
      })]);
      expect(packageInputs[0]).not.toHaveProperty("devtoolsMcpEnabled");
      expect(projectionInputs).toEqual([expect.objectContaining({
        operation: "install",
        devtoolsMcpEnabled: true,
      })]);

      expect(saveDevtoolsMcpPreference).toHaveBeenCalledWith(devtoolsPreferenceFile, "pi", true);

      await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: false,
      });
      expect(saveDevtoolsMcpPreference).toHaveBeenCalledWith(devtoolsPreferenceFile, "pi", false);

      await mod.runManagedPiSystem({
        operation: "install",
        targetDir: "/isolated/target",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
      });
      expect(saveDevtoolsMcpPreference).toHaveBeenCalledTimes(2);
      expect(loadDevtoolsMcpPreference).not.toHaveBeenCalled();

      runPiRuntimeSystem.mockResolvedValueOnce({ kind: "blocked", reason: "runner-unhealthy" });
      await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
      });
      expect(saveDevtoolsMcpPreference).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  it("forwards a selected Playwright handoff only through a supported Pi candidate, including a known absolute bin outside PATH", async () => {
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const playwrightPreferenceFile = "/isolated/state/playwright-cli.json";
    const savePlaywrightCliPreference = vi.fn();
    const detectPlaywrightCli = vi.fn()
      .mockReturnValueOnce({ status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" })
      .mockReturnValueOnce({ status: "not-in-path", binPath: "/isolated/pnpm/playwright-cli", detectedVersion: null })
      .mockReturnValueOnce({ status: "absent", binPath: null, detectedVersion: null });
    const runPiRuntimeSystem = vi.fn(async (input: unknown): Promise<{ kind: string }> => {
      packageInputs.push(input);
      return { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown): { kind: string; reason?: string } => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem: vi.fn(),
      completePiProjectionUninstallSystem: vi.fn(),
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => playwrightPreferenceFile),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      detectPlaywrightCli,
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      const input = {
        operation: "install" as const,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        playwrightCliEnabled: true,
      };

      await expect(mod.runManagedPiSystem(input)).resolves.toEqual({ kind: "installed" });
      await expect(mod.runManagedPiSystem({ ...input, operation: "sync" })).resolves.toEqual({ kind: "installed" });
      await expect(mod.runManagedPiSystem({ ...input, operation: "doctor" })).resolves.toEqual({ kind: "installed" });

      expect(packageInputs).toHaveLength(3);
      expect(packageInputs[0]).not.toHaveProperty("playwrightCliEnabled");
      expect(projectionInputs).toEqual([
        expect.objectContaining({
          operation: "install",
          playwrightCliEnabled: true,
          playwrightHandoffEnabled: true,
          playwrightCliCommand: "/isolated/bin/playwright-cli",
        }),
        expect.objectContaining({
          operation: "sync",
          playwrightCliEnabled: true,
          playwrightHandoffEnabled: true,
          playwrightCliCommand: "/isolated/pnpm/playwright-cli",
        }),
        expect.objectContaining({
          operation: "doctor",
          playwrightCliEnabled: true,
          playwrightHandoffEnabled: true,
          playwrightCliCommand: null,
        }),
      ]);
      expect(detectPlaywrightCli).toHaveBeenCalledTimes(3);
      expect(savePlaywrightCliPreference).toHaveBeenCalledWith(playwrightPreferenceFile, true, { pi: true });

      const successfulSaveCount = savePlaywrightCliPreference.mock.calls.length;
      detectPlaywrightCli.mockReturnValueOnce({ status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" });
      runPiProjectionLifecycleSystem.mockReturnValueOnce({ kind: "blocked", reason: "projection-write-failed" });
      await expect(mod.runManagedPiSystem({ ...input, operation: "sync" })).resolves.toMatchObject({
        kind: "blocked",
        reason: "projection-write-failed",
      });
      expect(savePlaywrightCliPreference).toHaveBeenCalledTimes(successfulSaveCount);

      await expect(mod.runManagedPiSystem({ ...input, operation: "sync", playwrightCliEnabled: false }))
        .resolves.toEqual({ kind: "installed" });
      expect(projectionInputs.at(-1)).toEqual(expect.objectContaining({
        operation: "sync",
        playwrightCliEnabled: false,
        playwrightHandoffEnabled: false,
        playwrightCliCommand: null,
      }));
      expect(savePlaywrightCliPreference).toHaveBeenCalledWith(playwrightPreferenceFile, true, { pi: false });
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  it.each([
    ["an unsupported Pi candidate", undefined],
    ["a target-dir projection", "/isolated/target"],
  ] as const)("does not resolve or project a Playwright handoff for %s", async (_case, targetDir) => {
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const savePlaywrightCliPreference = vi.fn();
    const detectPlaywrightCli = vi.fn(() => ({
      status: "current",
      binPath: "/isolated/bin/playwright-cli",
      detectedVersion: "0.1.18",
    }));
    const runPiRuntimeSystem = vi.fn(async (input: unknown): Promise<{ kind: string }> => {
      packageInputs.push(input);
      return { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        contract: { capabilities: [] },
      },
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem: vi.fn(),
      completePiProjectionUninstallSystem: vi.fn(),
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      detectPlaywrightCli,
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      await expect(mod.runManagedPiSystem({
        operation: "install",
        targetDir: targetDir ?? undefined,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        playwrightCliEnabled: true,
      })).resolves.toEqual({ kind: "installed" });

      expect(packageInputs[0]).not.toHaveProperty("playwrightCliEnabled");
      expect(projectionInputs[0]).toEqual(expect.objectContaining({
        targetDir: targetDir ?? undefined,
      }));
      expect((projectionInputs[0] as Record<string, unknown>).playwrightHandoffEnabled).not.toBe(true);
      expect(detectPlaywrightCli).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

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
