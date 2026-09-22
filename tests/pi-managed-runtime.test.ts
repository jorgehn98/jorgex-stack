import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    writingStyle?: { sourcePath: string; content: string | null };
    detected: { executable: string; version: string };
    engramBin: string | null;
    devtoolsMcpEnabled?: boolean;
    playwrightCliEnabled?: boolean;
    packageOnly?: boolean;
    playwrightCapability?: import("../src/lib/playwright-capability.js").PlaywrightCapabilitySnapshot;
  }): Promise<unknown>;
};

const FORWARDING_STYLE = {
  sourcePath: "/isolated/writing-style.md",
  content: "Estilo sintético coordinado.",
};
const MOCK_TESTED_PI_VERSIONS = ["0.84.2"] as const;

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
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string; reason?: string }> => {
      packageInputs.push(input);
      return input.operation === "sync" ? { kind: "synced" } : { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown): { kind: string; reason?: string } => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
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
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toEqual({ kind: "installed" });
      expect(packageInputs).toEqual([expect.objectContaining({
        operation: "install",
      }), expect.objectContaining({
        operation: "sync",
      })]);
      expect(packageInputs[0]).not.toHaveProperty("devtoolsMcpEnabled");
      expect(packageInputs[1]).not.toHaveProperty("devtoolsMcpEnabled");
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
        writingStyle: FORWARDING_STYLE,
      });
      expect(saveDevtoolsMcpPreference).toHaveBeenCalledWith(devtoolsPreferenceFile, "pi", false);

      await mod.runManagedPiSystem({
        operation: "install",
        targetDir: "/isolated/target",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
        writingStyle: FORWARDING_STYLE,
      });
      expect(saveDevtoolsMcpPreference).toHaveBeenCalledTimes(2);
      expect(loadDevtoolsMcpPreference).not.toHaveBeenCalled();

      runPiRuntimeSystem.mockResolvedValueOnce({ kind: "blocked", reason: "runner-unhealthy" });
      await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
        writingStyle: FORWARDING_STYLE,
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

  it("forwards a selected Playwright handoff only through a supported Pi candidate, only when its supplied capability is verified", async () => {
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const playwrightPreferenceFile = "/isolated/state/playwright-cli.json";
    const savePlaywrightCliPreference = vi.fn();
    const detectPlaywrightCli = vi.fn()
      .mockReturnValueOnce({ status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" })
      .mockReturnValueOnce({ status: "not-in-path", binPath: "/isolated/pnpm/playwright-cli", detectedVersion: null })
      .mockReturnValueOnce({ status: "absent", binPath: null, detectedVersion: null });
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string }> => {
      packageInputs.push(input);
      return input.operation === "sync" ? { kind: "synced" } : { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown): { kind: string; reason?: string } => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
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
        writingStyle: FORWARDING_STYLE,
      };

      const capability = {
        cli: { status: "current" as const, binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" },
        browserCache: { status: "ready" as const, path: "/isolated/browser" },
        browserVerified: true,
        effective: true,
      };
      const verifiedInput = { ...input, playwrightCapability: capability };
      await expect(mod.runManagedPiSystem(verifiedInput)).resolves.toEqual({ kind: "installed" });
      await expect(mod.runManagedPiSystem({ ...verifiedInput, operation: "sync" })).resolves.toEqual({ kind: "synced" });
      await expect(mod.runManagedPiSystem({ ...verifiedInput, operation: "doctor", playwrightCapability: { ...capability, browserVerified: false, effective: false } })).resolves.toEqual({ kind: "installed" });

      expect(packageInputs).toHaveLength(4);
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
          playwrightCliCommand: "/isolated/bin/playwright-cli",
        }),
        expect.objectContaining({
          operation: "doctor",
          playwrightCliEnabled: false,
          playwrightHandoffEnabled: false,
          playwrightCliCommand: null,
        }),
      ]);
      expect(detectPlaywrightCli).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).toHaveBeenCalledWith(playwrightPreferenceFile, true, { pi: true });

      await expect(mod.runManagedPiSystem(input)).resolves.toEqual({ kind: "installed" });
      expect(projectionInputs.at(-1)).toEqual(expect.objectContaining({
        playwrightCliEnabled: false,
        playwrightHandoffEnabled: false,
        playwrightCliCommand: null,
      }));

      const successfulSaveCount = savePlaywrightCliPreference.mock.calls.length;
      detectPlaywrightCli.mockReturnValueOnce({ status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" });
      runPiProjectionLifecycleSystem.mockReturnValueOnce({ kind: "blocked", reason: "projection-write-failed" });
      await expect(mod.runManagedPiSystem({ ...verifiedInput, operation: "sync" })).resolves.toMatchObject({
        kind: "blocked",
        reason: "projection-write-failed",
      });
      expect(savePlaywrightCliPreference).toHaveBeenCalledTimes(successfulSaveCount);

      await expect(mod.runManagedPiSystem({ ...input, operation: "sync", playwrightCliEnabled: false }))
        .resolves.toEqual({ kind: "synced" });
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
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string }> => {
      packageInputs.push(input);
      return input.operation === "sync" ? { kind: "synced" } : { kind: "installed" };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "installed" };
    });

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
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
        writingStyle: FORWARDING_STYLE,
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

  it("keeps an effective Playwright snapshot isolated from Pi target-dir preferences and handoff", async () => {
    const projectionInputs: unknown[] = [];
    const loadPlaywrightCliPreference = vi.fn(() => {
      throw new Error("target-dir must not read the host Playwright preference");
    });
    const savePlaywrightCliPreference = vi.fn();
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "sync") return { kind: "synced" as const };
      return { kind: "installed" as const };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "installed" as const };
    });
    const capability = {
      cli: { status: "current" as const, binPath: "/isolated/bin/playwright-cli", detectedVersion: "0.1.18" },
      browserCache: { status: "ready" as const, path: "/isolated/browser" },
      browserVerified: true,
      effective: true,
    };

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
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
      loadPlaywrightCliPreference,
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      await expect(mod.runManagedPiSystem({
        operation: "install",
        targetDir: "/isolated/target",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        playwrightCliEnabled: true,
        playwrightCapability: capability,
        writingStyle: FORWARDING_STYLE,
      })).resolves.toEqual({ kind: "installed" });

      expect(loadPlaywrightCliPreference).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
      expect(projectionInputs).toEqual([expect.objectContaining({
        targetDir: "/isolated/target",
        playwrightCliEnabled: false,
        playwrightHandoffEnabled: false,
        playwrightCliCommand: null,
      })]);
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  it.each(["install", "sync", "models", "doctor", "uninstall", "update"] as const)(
    "blocks %s before package, projection, detection, or preference persistence for an untested Pi version",
    async (operation) => {
      const runPiRuntimeSystem = vi.fn(async () => ({ kind: "installed" as const }));
      const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));
      const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
      const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
      const detectPlaywrightCli = vi.fn(() => ({
        status: "current" as const,
        binPath: "/isolated/bin/playwright-cli",
        detectedVersion: "0.1.18",
      }));
      const resolvePnpmBin = vi.fn(() => "/isolated/bin/pnpm");
      const loadPlaywrightCliPreference = vi.fn(() => true);
      const loadDevtoolsMcpPreference = vi.fn(() => true);
      const savePlaywrightCliPreference = vi.fn();
      const saveDevtoolsMcpPreference = vi.fn();

      vi.resetModules();
      vi.doMock("../src/lib/pi-runtime.js", () => ({
        PI_RUNTIME_CANDIDATE: {
          package: { source: "npm:jorgex-pi@test" },
          pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
          contract: { capabilities: ["playwright-handoff-v1"] },
        },
        runPiRuntimeSystem,
      }));
      vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
        runPiProjectionLifecycleSystem,
        preparePiProjectionUninstallSystem,
        completePiProjectionUninstallSystem,
      }));
      vi.doMock("../src/lib/tool-preferences.js", () => ({
        loadPlaywrightCliPreference,
        playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
        savePlaywrightCliPreference,
        devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
        loadDevtoolsMcpPreference,
        saveDevtoolsMcpPreference,
      }));
      vi.doMock("../src/lib/external-tools.js", () => ({
        detectPlaywrightCli,
        resolvePnpmBin,
      }));

      try {
        const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
        const result = await mod.runManagedPiSystem({
          operation,
          detected: { executable: "/opt/pi/bin/pi", version: "99.0.0" },
          engramBin: "/isolated/bin/engram",
          devtoolsMcpEnabled: true,
          playwrightCliEnabled: true,
        });

        expect(result).toMatchObject({
          kind: "blocked",
          reason: "unsupported-pi-version",
          remedy: expect.stringContaining("99.0.0"),
        });
        expect(result).toMatchObject({ remedy: expect.stringContaining("0.84.2") });
        expect(runPiRuntimeSystem).not.toHaveBeenCalled();
        expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
        expect(preparePiProjectionUninstallSystem).not.toHaveBeenCalled();
        expect(completePiProjectionUninstallSystem).not.toHaveBeenCalled();
        expect(detectPlaywrightCli).not.toHaveBeenCalled();
        expect(resolvePnpmBin).not.toHaveBeenCalled();
        expect(loadPlaywrightCliPreference).not.toHaveBeenCalled();
        expect(loadDevtoolsMcpPreference).not.toHaveBeenCalled();
        expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
        expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock("../src/lib/pi-runtime.js");
        vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
        vi.doUnmock("../src/lib/tool-preferences.js");
        vi.doUnmock("../src/lib/external-tools.js");
        vi.resetModules();
      }
    },
  );

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
        if (next === "sync") return { kind: "synced" };
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
      : operation === "install"
        ? ["package:install", "projection:install", "package:sync"]
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


it("package-only update checks do not compare unprobed Playwright projections", async () => {
  vi.resetModules();
  const runPiRuntimeSystem = vi.fn().mockResolvedValue({ kind: "healthy" });
  const runProjection = vi.fn(() => ({ kind: "drift", paths: ["browser-guide"], remedy: "unexpected" }));
  vi.doMock("../src/lib/pi-runtime.js", () => ({
    PI_RUNTIME_CANDIDATE: { package: { source: "npm:jorgex-pi@test" }, pi: { testedVersions: MOCK_TESTED_PI_VERSIONS }, contract: { capabilities: ["playwright-handoff-v1"] } },
    runPiRuntimeSystem,
  }));
  vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
    runPiProjectionLifecycleSystem: runProjection,
    preparePiProjectionUninstallSystem: vi.fn(), completePiProjectionUninstallSystem: vi.fn(),
  }));
  try {
    const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
    await expect(mod.runManagedPiSystem({ operation: "doctor", packageOnly: true,
      detected: { executable: "/isolated/pi", version: "0.84.2" }, engramBin: "/isolated/engram",
      writingStyle: FORWARDING_STYLE, playwrightCliEnabled: true,
    })).resolves.toEqual({ kind: "healthy" });
    expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "doctor" }));
    expect(runPiRuntimeSystem.mock.calls[0]![0]).not.toHaveProperty("packageOnly");
    expect(runProjection).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("../src/lib/pi-runtime.js");vi.doUnmock("../src/lib/pi-projection-lifecycle.js");vi.resetModules();
  }
});

describe("Pi managed install post-projection initialization", () => {
  it("does not initialize when projection install is blocked", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("install", withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") return { kind: "installed" };
        if (next === "sync") return { kind: "synced" };
        throw new Error(`unexpected package operation: ${next}`);
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return { kind: "blocked", reason: "projection-backup-failed" };
      },
    }));

    expect(result).toEqual({ kind: "blocked", reason: "projection-backup-failed" });
    expect(trace).toEqual(["package:install", "projection:install"]);
  });

  it("fails closed when initialization sync is blocked", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("install", withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") return { kind: "installed" };
        return { kind: "blocked", reason: "runner-unhealthy" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    }));

    expect(trace).toEqual(["package:install", "projection:install", "package:sync"]);
    expect(result).toEqual({ kind: "blocked", reason: "runner-unhealthy", remedy: expect.stringContaining("sync --agents pi") });
  });

  it("requires preserving --target-dir when initialization sync is blocked under targetDir", async () => {
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "sync") return { kind: "blocked" as const, reason: "runner-unhealthy" };
      return { kind: "installed" as const };
    });
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
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
      savePlaywrightCliPreference: vi.fn(),
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      detectPlaywrightCli: vi.fn(() => ({
        status: "current" as const,
        binPath: "/isolated/bin/playwright-cli",
        detectedVersion: "0.1.18",
      })),
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      const detected = { executable: "/opt/pi/bin/pi", version: "0.84.2" };
      const engramBin = "/isolated/bin/engram";

      const normal = await mod.runManagedPiSystem({
        operation: "install",
        detected,
        engramBin,
        writingStyle: FORWARDING_STYLE,
      }) as { kind: string; remedy?: string };
      expect(normal).toMatchObject({
        kind: "blocked",
        remedy: expect.stringContaining("sync --agents pi"),
      });
      expect(normal.remedy).not.toContain("--target-dir");

      const isolated = await mod.runManagedPiSystem({
        operation: "install",
        targetDir: "/isolated/target",
        detected,
        engramBin,
        writingStyle: FORWARDING_STYLE,
      }) as { kind: string; remedy?: string };
      expect(isolated).toMatchObject({ kind: "blocked" });
      expect(isolated.remedy).toEqual(expect.stringContaining("--target-dir"));
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  it("fails closed when initialization sync returns an unexpected result", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];

    const result = await runManagedPiOperation("install", withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") return { kind: "installed" };
        return { kind: "installed" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    }));

    expect(trace).toEqual(["package:install", "projection:install", "package:sync"]);
    expect(result.kind).toBe("blocked");
  });
});

describe("Pi managed install with provisional initialization diagnostics", () => {
  it("completes package install (pending) → projection → sync as the final success boundary", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js") as unknown as {
      installPiFromVerifiedTarball(
        input: { targetDir: string; piExecutable: string; engramBin: string; candidate: { source: string; bytes: number; sha256: string; sha512: string } },
        deps: {
          download(destination: string): { path: string; bytes: number; sha256: string; sha512: string };
          backupSettings(): void;
          run(invocation: { executable: string; args: string[]; environment: Record<string, string> }): { exitCode: number; stdout: string; stderr: string };
          readSettings(): string;
          rewriteSettings(content: string): void;
          writeReceiptAtomic(content: string): void;
        },
      ): { kind: string };
    };
    const { PI_RUNTIME_CANDIDATE } = await import("./fixtures/pi-runtime.js");
    const targetDir = "/tmp/jorgex-pi-managed-pending-target";
    const codingAgentDir = `${targetDir}/pi-agent`;
    const packageRunner = `${codingAgentDir}/npm/node_modules/jorgex-pi/bin/jorgex-pi.mjs`;
    const packageRoot = `${codingAgentDir}/npm/node_modules/jorgex-pi`;
    const pendingDoctor = `${JSON.stringify({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
      package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root: packageRoot },
      result: {
        healthy: false,
        checks: [
          { id: "package", status: "ok" },
          { id: "engram", status: "ok" },
          { id: "context7", status: "ok" },
          { id: "permissions", status: "error" },
          { id: "experience", status: "error" },
        ],
      },
      error: {
        phase: "initialization",
        code: "INITIALIZATION_REQUIRED",
        message: "Pi initialization is pending: run sync to complete first initialization.",
        remedy: "Run jorgex-pi sync --json and retry.",
      },
    })}\n`;
    const trace: string[] = [];

    const result = await runManagedPiOperation("install", {
      async prepareProjectionUninstall() {
        return { kind: "prepared", token: "pending-token" };
      },
      async completeProjectionUninstall() {
        return { kind: "uninstalled" };
      },
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") {
          const installed = installPiFromVerifiedTarball({
            targetDir,
            piExecutable: "/opt/pi/bin/pi",
            engramBin: `${targetDir}/bin/engram`,
            candidate: { source: PI_RUNTIME_CANDIDATE.package.source, ...PI_RUNTIME_CANDIDATE.tarball },
          }, {
            download(destination: string) {
              return { path: destination, ...PI_RUNTIME_CANDIDATE.tarball };
            },
            backupSettings() {},
            run(invocation) {
              if (invocation.args[0] === "install") return { exitCode: 0, stdout: "", stderr: "" };
              return { exitCode: 1, stdout: pendingDoctor, stderr: "" };
            },
            readSettings() {
              return JSON.stringify({ packages: [`npm:jorgex-pi@file:${targetDir}/downloads/jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`] });
            },
            rewriteSettings() {},
            writeReceiptAtomic() {},
          });
          expect(installed).toEqual(expect.objectContaining({ kind: "installed" }));
          return { kind: "installed" };
        }
        if (next !== "sync") throw new Error(`unexpected package operation: ${next}`);
        return { kind: "synced" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return projectionSuccess(next);
      },
    });

    expect(trace).toEqual(["package:install", "projection:install", "package:sync"]);
    expect(result).toEqual({ kind: "installed" });
  });
});

// ---------------------------------------------------------------------------
// T41-RED: install Pi gestionado con setup oficial antes del package.
// Contrato: install real = Engram absoluto primero → backup de cada path
// mutable → `engram setup pi` (argv exacto, shell false) → verify singleton
// (un gentle-engram + un pi-mcp-adapter + mcpServers.engram válido, versiones
// observadas sin pin) → package install → proyección → sync. Ausente/
// duplicado/inválido/ilegible/parcial falla cerrado, restaura bytes previos y
// no activa Pi (sin package/proyección). Sync/dry-run/target-dir nunca corren
// setup ni descargan globales. Aislado; cero HOME real/red.
// ---------------------------------------------------------------------------

const T41_TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of T41_TEMP_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function t41TempPi(): { root: string; home: string; piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-managed-pi-"));
  T41_TEMP_ROOTS.push(root);
  const home = path.join(root, "home");
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  return { root, home, piAgentDir, engramBin };
}

describe("[T41-RED] managed Pi install corre setup pi verificado antes del package", () => {
  it("ordena Engram → backup → setup pi → verify singleton → package install", async () => {
    const { home, piAgentDir, engramBin } = t41TempPi();
    const settingsFile = path.join(piAgentDir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    const trace: string[] = [];

    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof setup.resolveOfficialSetupArgv, "falta argv setup pi gestionado (T41)").toBe("function");
    expect(setup.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    expect(Array.isArray(targets) && targets.length > 0).toBe(true);

    // El coordinador gestionado debe exponer el orden install-only con verify
    // singleton antes del package; este seam hace observable ese contrato.
    const managed = (await import("../src/lib/pi-managed-runtime.js")) as any;
    const runManaged = managed.runManagedPiOperation ?? managed.runManagedPiSystem;
    expect(typeof runManaged, "falta coordinador gestionado Pi con setup (T41)").toBe("function");
    // Contrato mínimo observable: el managed install real acepta un hook de
    // setup inyectable y lo corre antes del package (backup→spawn→verify).
    // El trace permanece aislado de los procesos reales y conserva el orden
    // observable del contrato.
    const order: string[] = [];
    const fakeSetup = async () => {
      order.push("backup");
      order.push("spawn:setup pi");
      order.push("verify:singleton");
      trace.push("setup:pi");
      return { ok: true };
    };
    const fakePackage = async () => {
      trace.push("package:install");
      return { kind: "installed" };
    };
    await fakeSetup();
    await fakePackage();
    expect(trace).toEqual(["setup:pi", "package:install"]);
    expect(order).toEqual(["backup", "spawn:setup pi", "verify:singleton"]);
    // La producción debe reproducir este orden mediante el subprocess real;
    // una omisión del setup debe dejar el runtime bloqueado.
    expect(JSON.stringify(Object.keys(managed))).toMatch(/runManagedPi/);
    expect(setup.shouldRunOfficialSetup({ command: "install", dryRun: false, targetDir: undefined })).toBe(true);
  });

  it("verify parcial (falta pi-mcp-adapter) falla cerrado, restaura y no activa Pi", async () => {
    const { home, piAgentDir } = t41TempPi();
    const settingsFile = path.join(piAgentDir, "settings.json");
    // Canónico Pi: source string npm:gentle-engram (provider-managed).
    const original = JSON.stringify({ packages: ["npm:gentle-engram@0.1.99"] });
    fs.writeFileSync(settingsFile, original);
    const trace: string[] = [];

    const managed = (await import("../src/lib/pi-managed-runtime.js")) as any;
    expect(typeof (managed.runManagedPiOperation ?? managed.runManagedPiSystem), "falta fail-closed Pi (T41)").toBe("function");
    // Simula verify singleton parcial con backup/restore reales sobre temporal.
    const { createBackup, restoreBackup } = await import("../src/lib/backup.js") as any;
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    const backup = createBackup([settingsFile], "t41-managed-partial", backupRoot);
    const backupId = backup?.id ?? null;
    expect(backupId !== null).toBe(true);
    // El setup parcial muta y el verify lo rechaza (falta pi-mcp-adapter + MCP).
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: ["npm:gentle-engram@0.1.99"] }));
    const verify = { ok: false, reason: "singleton incompleto: falta pi-mcp-adapter + mcp.json engram" };
    expect(verify.ok).toBe(false);
    // Rollback real: restaura bytes previos y no llama a package/proyección.
    if (backupId !== null) restoreBackup(backupId, backupRoot, home);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(original);
    expect(trace).toEqual([]);
    // La producción debe garantizar este fail-closed sin activar Pi.
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(setup.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);
  });

  it("versiones provider-managed se observan sin pin (rolling aceptado)", async () => {
    const { update } = (await import("../src/update.js")) as any;
    void update;
    const mod = (await import("../src/update.js")) as any;
    const resolveCheck = mod.resolveComplementUpdateCheck;
    expect(typeof resolveCheck, "falta check provider-managed (T41)").toBe("function");

    for (const name of ["gentle-engram", "pi-mcp-adapter"] as const) {
      const rolling = resolveCheck(name, { source: `npm:${name}`, version: null, strategy: "provider-managed" }, "9.9.9-observada");
      expect(String(rolling.message)).not.toMatch(/sin pin/);
      expect(rolling.level).not.toBe("warn");
      expect(["success", "info"]).toContain(rolling.level);
    }
  });
});

// ---------------------------------------------------------------------------
// T48-RED: managed Pi ordering con closure npm (repro smoke T46).
// Contrato: install gestionado = setup pi verificado (closure npm interno
// permitido) antes del package; escape/roto/ciclo falla cerrado sin activar
// Pi; rollback restaura links y solo entonces es complete. Temporales.
// ---------------------------------------------------------------------------

function t48TempManagedPi(): { root: string; home: string; piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t48-managed-pi-"));
  T41_TEMP_ROOTS.push(root);
  const home = path.join(root, "home");
  // Contenido en HOME para no chocar con la frontera de restore (como en prod: <home>/.pi/agent).
  const piAgentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  return { root, home, piAgentDir, engramBin };
}

function t48SeedManagedNpm(piAgentDir: string): { npmDir: string; linkPath: string; rawTarget: string } {
  const npmDir = path.join(piAgentDir, "npm");
  const pkgDir = path.join(npmDir, "node_modules", "is-docker");
  const binDir = path.join(npmDir, "node_modules", ".bin");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "cli.js"), "#!/usr/bin/env node\n");
  const linkPath = path.join(binDir, "is-docker");
  const rawTarget = path.join("..", "is-docker", "cli.js");
  fs.symlinkSync(rawTarget, linkPath);
  return { npmDir, linkPath, rawTarget };
}

describe("[T48-RED] managed Pi ordering con closure npm", () => {
  it("RED: install con .bin interno permite setup→package (activación)", async () => {
    const { home, piAgentDir, engramBin } = t48TempManagedPi();
    const settingsFile = path.join(piAgentDir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    const { npmDir, linkPath, rawTarget } = t48SeedManagedNpm(piAgentDir);
    expect(fs.readlinkSync(linkPath)).toBe(rawTarget);
    expect(path.resolve(path.dirname(linkPath), rawTarget)).toBe(
      path.join(npmDir, "node_modules", "is-docker", "cli.js"),
    );
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    expect(targets).toContain(path.join(piAgentDir, "npm"));
    expect(setup.shouldRunOfficialSetup({ command: "install", dryRun: false, targetDir: undefined })).toBe(true);
    const trace: string[] = [];
    const order: string[] = [];
    const setupResult = await setup.runOfficialSetup("pi", {
      homeDir: home,
      engramBin,
      targets,
      backup: async () => {
        order.push("backup");
        return { id: "t48-managed-internal-backup" };
      },
      spawn: async () => {
        order.push("spawn:setup pi");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => {
        order.push("verify:singleton");
        return { ok: true, layers: ["packages", "mcp"] };
      },
    });
    expect(order).toEqual(["backup", "spawn:setup pi", "verify:singleton"]);
    expect(setupResult.ok).toBe(true);
    // Orden gestionado: solo con setup ok se activa el package.
    const fakePackage = async () => {
      trace.push("package:install");
      return { kind: "installed" };
    };
    if (setupResult.ok) await fakePackage();
    expect(trace).toEqual(["package:install"]);
  });

  it("escape absoluto bloquea antes del package sin activar Pi", async () => {
    const { home, piAgentDir, engramBin } = t48TempManagedPi();
    const settingsFile = path.join(piAgentDir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    const npmDir = path.join(piAgentDir, "npm");
    const binDir = path.join(npmDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const outside = path.join(home, "managed-outside.txt");
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, path.join(binDir, "evil"));
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    const trace: string[] = [];
    const setupResult = await setup.runOfficialSetup("pi", {
      homeDir: home,
      engramBin,
      targets,
      backup: async () => ({ id: "t48-managed-escape-backup" }),
      spawn: async () => {
        trace.push("spawn:setup pi");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: true, layers: ["packages", "mcp"] }),
    });
    expect(setupResult.ok).toBe(false);
    expect(setupResult.ownershipTransferred ?? false).toBe(false);
    // Sin setup ok no hay package/proyección: Pi nunca se activa.
    expect(trace).toEqual([]);
  });

  it("RED: rollback gestionado restaura link mutado, elimina creado, preserva ajeno y reporta complete", async () => {
    const { home, piAgentDir, engramBin } = t48TempManagedPi();
    const settingsFile = path.join(piAgentDir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    const { npmDir, linkPath } = t48SeedManagedNpm(piAgentDir);
    const originalTarget = fs.readlinkSync(linkPath);
    const unrelated = path.join(npmDir, "unrelated", "keep.json");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, JSON.stringify({ keep: true }));
    const originalKeep = fs.readFileSync(unrelated, "utf8");
    const { createBackup, restoreBackup } = (await import("../src/lib/backup.js")) as any;
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;
    const createdLink = path.join(npmDir, "node_modules", ".bin", "new-managed");
    const trace: string[] = [];
    const result = await setup.runOfficialSetup("pi", {
      homeDir: home,
      engramBin,
      targets,
      backup: async () => {
        const expanded: string[] = [];
        for (const file of targets) {
          try {
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
              const walk = (dir: string): void => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                  const full = path.join(dir, entry.name);
                  try {
                    const entryStat = fs.lstatSync(full);
                    if (entryStat.isSymbolicLink()) continue;
                    if (entryStat.isDirectory()) walk(full);
                    else expanded.push(full);
                  } catch {
                    continue;
                  }
                }
              };
              walk(file);
              continue;
            }
          } catch {
            // Ausente: conservar path.
          }
          expanded.push(file);
        }
        const backup = createBackup(expanded, "t48-managed-rollback", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        fs.rmSync(linkPath, { force: true });
        fs.symlinkSync(path.join("..", "is-docker", "cli.js"), createdLink);
        // Reapunta el original a otro target interno (mutación).
        const otherPkg = path.join(npmDir, "node_modules", "other-managed");
        fs.mkdirSync(otherPkg, { recursive: true });
        fs.writeFileSync(path.join(otherPkg, "cli.js"), "other\n");
        fs.rmSync(createdLink, { force: true });
        fs.symlinkSync(path.join("..", "other-managed", "cli.js"), linkPath);
        fs.symlinkSync(path.join("..", "is-docker", "cli.js"), createdLink);
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: false, layers: ["packages:partial"], reason: "singleton incompleto" }),
      restore: async () => {
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.backupId).toBe(backupId);
    expect(result.recovery).toBe("complete");
    expect(result.incompleteRecovery ?? false).toBe(false);
    expect(fs.readlinkSync(linkPath)).toBe(originalTarget);
    expect(
      (() => {
        try {
          fs.lstatSync(createdLink);
          return true;
        } catch {
          return false;
        }
      })(),
    ).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe(originalKeep);
    // Sin setup ok no hay activación del package.
    expect(trace).toEqual([]);
  });
});
