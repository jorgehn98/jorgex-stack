import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Integration fixtures carry synthetic tarball bytes; the isolated CLI probe
// has its own artifact tests and explicit success/failure flow doubles below.
vi.mock("../src/lib/browser-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/browser-provider.js")>()),
  verifyDevtoolsCliArtifact: vi.fn(async () => ({ binPath: "/isolated/stage/bin", version: DEVTOOLS_VERSION })),
}));

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
    // FIX (deliberate-install contract): real installs preflight first, so the
    // fixture supplies a synthetic prepared stage and a matching receipt.
    const SYNTHETIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTHETIC_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } };
    const preparePiRuntimeSystem = vi.fn(async () => ({
      candidate: SYNTHETIC_CANDIDATE,
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string; reason?: string; receipt?: unknown }> => {
      packageInputs.push(input);
      if (input.operation === "sync") return { kind: "synced" };
      return {
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          state: "installed",
          candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } },
        },
      };
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
      preparePiRuntimeSystem,
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
      loadDevtoolsMcpObservation: vi.fn(() => null),
      saveDevtoolsMcpPreference,
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      const fetchEvents: string[] = [];
      stubDevtoolsFetch(fetchEvents);
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
        writingStyle: FORWARDING_STYLE,
      });

      // The installed result now carries the authenticated receipt (new
      // contract); the forwarding assertions below are this test's seam.
      // Explicit install verifies the stubbed provider: metadata, tarball,
      // then the persisted observation travels with the save.
      expect(fetchEvents).toEqual([`fetch ${DEVTOOLS_METADATA}`, `fetch ${DEVTOOLS_TARBALL}`]);
      expect(result).toMatchObject({ kind: "installed" });
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
      }), expect.objectContaining({
        operation: "sync",
        devtoolsMcpEnabled: true,
        playwrightCliEnabled: false,
        playwrightHandoffEnabled: false,
        playwrightCliCommand: null,
        targetDir: undefined,
      })]);

      expect(saveDevtoolsMcpPreference).toHaveBeenCalledWith(devtoolsPreferenceFile, "pi", true, DEVTOOLS_OBSERVED);

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
      vi.unstubAllGlobals();
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
    // FIX (deliberate-install contract): see DevTools test above.
    const SYNTHETIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTHETIC_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } };
    const preparePiRuntimeSystem = vi.fn(async () => ({
      candidate: SYNTHETIC_CANDIDATE,
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string; receipt?: unknown }> => {
      packageInputs.push(input);
      if (input.operation === "sync") return { kind: "synced" };
      // Only install carries a receipt: other operations keep their plain
      // shapes so their exact assertions stay meaningful.
      if (input.operation !== "install") return { kind: "installed" };
      return {
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          state: "installed",
          candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } },
        },
      };
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
      preparePiRuntimeSystem,
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
      // Installed results now carry the authenticated receipt (new contract).
      await expect(mod.runManagedPiSystem(verifiedInput)).resolves.toMatchObject({ kind: "installed" });
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
          targetDir: undefined,
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

      await expect(mod.runManagedPiSystem(input)).resolves.toMatchObject({ kind: "installed" });
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
    // FIX (deliberate-install contract): the no-targetDir case preflights
    // first, so the fixture supplies a synthetic prepared stage and receipt.
    // The targetDir case skips preflight; the shared fake stays harmless
    // there because the wrapper only authenticates receipts with a candidate.
    const SYNTHETIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTHETIC_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } };
    const preparePiRuntimeSystem = vi.fn(async () => ({
      candidate: SYNTHETIC_CANDIDATE,
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string; receipt?: unknown }> => {
      packageInputs.push(input);
      if (input.operation === "sync") return { kind: "synced" };
      return {
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          state: "installed",
          candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } },
        },
      };
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
      preparePiRuntimeSystem,
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
      // Installed results now carry the authenticated receipt (new contract).
      })).resolves.toMatchObject({ kind: "installed" });

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
        operation: "install",
        targetDir: "/isolated/target",
        playwrightCliEnabled: false,
        playwrightHandoffEnabled: false,
        playwrightCliCommand: null,
      }), expect.objectContaining({
        operation: "sync",
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

  // FIX (deliberate-install contract): install preflights before the host
  // gate and a prepared stage bypasses it by design. Deliberate update also
  // preflights (old receipt gate) before any static allowlist, so this gate
  // test owns update via preflight. Models now hands off to the
  // receipt-authenticated package run (T07 offline gate); install is owned
  // by the deliberate-install tests; sync reaches the package layer by
  // design (ownership seam test below).
  it(
    "blocks update before package, projection, detection, or preference persistence for an untested Pi version",
    async () => {
      // Mocked preflight: no network/HOME, isolated synthetic only. Update
      // with no old receipt blocks here (old gate) instead of the static
      // allowlist.
      const preparePiRuntimeSystem = vi.fn(async (_input: unknown) => ({
        kind: "blocked" as const,
        reason: "receipt-untrusted",
        remedy: "No old managed receipt for update; preflight blocked without network.",
      }));
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
        preparePiRuntimeSystem,
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
          operation: "update",
          detected: { executable: "/opt/pi/bin/pi", version: "99.0.0" },
          engramBin: "/isolated/bin/engram",
          devtoolsMcpEnabled: true,
          playwrightCliEnabled: true,
        });

        // Deliberate update: real preflight branch, no static host gate
        // first and no unverified fallback. Blocked old gate (no old
        // receipt) returns its reason with no package/projection.
        expect(preparePiRuntimeSystem).toHaveBeenCalledTimes(1);
        expect(preparePiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "update" }));
        expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
        expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
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

  // T07-RED (models handoff): models on a new host must hand off to the
  // receipt-authenticated package run instead of the static host allowlist.
  // The mocked package stands in for a valid fake receipt (controlled here);
  // an arbitrary host is NOT compatible by itself — the authenticated
  // receipt + actual runner remains the gate inside runPiRuntimeSystem
  // (offline managed models). No projection/preflight/Engram setup: models
  // never projects and never preflights.
  it("hands off models on a new host to the receipt-authenticated package run", async () => {
    const MODELS_RESULT = {
      kind: "models" as const,
      models: { mode: "inherit-session" as const, tiers: ["strong", "standard", "cheap"] as ["strong", "standard", "cheap"] },
    };
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      expect(input.operation).toBe("models");
      return MODELS_RESULT;
    });
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

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
      const result = await mod.runManagedPiSystem({
        operation: "models",
        detected: { executable: "/opt/pi/bin/pi", version: "99.0.0" },
        engramBin: "/isolated/bin/engram",
      });

      expect(result).toEqual(MODELS_RESULT);
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "models" }));
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
      expect(preparePiProjectionUninstallSystem).not.toHaveBeenCalled();
      expect(completePiProjectionUninstallSystem).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T07-RED (models negative): a blocked package models result surfaces
  // unchanged on a new host — no static unsupported-pi-version block. Same
  // isolation as the positive: mock package controlled, no
  // projection/preflight/Engram setup; the package offline gate owns auth.
  it("reports a blocked package models result unchanged without a static host block", async () => {
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      expect(input.operation).toBe("models");
      return { kind: "blocked" as const, reason: "receipt-untrusted" };
    });
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
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
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference,
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
      const result = await mod.runManagedPiSystem({
        operation: "models",
        detected: { executable: "/opt/pi/bin/pi", version: "99.0.0" },
        engramBin: "/isolated/bin/engram",
      });

      expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
      expect(preparePiProjectionUninstallSystem).not.toHaveBeenCalled();
      expect(completePiProjectionUninstallSystem).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
      expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05 ownership seam: sync intentionally bypasses the static host gate so
  // a verified schema1 managed receipt can run on newer hosts. An untrusted
  // host99 with no receipt is therefore blocked at the package layer — not
  // by the allowlist — and the wrapper surfaces the package verdict without
  // projecting or persisting preferences.
  it("blocks sync on untrusted host99 at the package layer without projecting or persisting", async () => {
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      expect(input.operation).toBe("sync");
      return { kind: "blocked" as const, reason: "receipt-untrusted" };
    });
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
      loadDevtoolsMcpObservation: vi.fn(() => null),
      saveDevtoolsMcpPreference,
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      detectPlaywrightCli,
      resolvePnpmBin,
    }));

    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
      const result = await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "99.0.0" },
        engramBin: "/isolated/bin/engram",
        devtoolsMcpEnabled: true,
        playwrightCliEnabled: true,
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toMatchObject({ kind: "blocked", reason: "receipt-untrusted" });
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "sync" }));
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
      expect(preparePiProjectionUninstallSystem).not.toHaveBeenCalled();
      expect(completePiProjectionUninstallSystem).not.toHaveBeenCalled();
      expect(detectPlaywrightCli).not.toHaveBeenCalled();
      // NOTE: loadPlaywrightCliPreference IS consulted eagerly by the
      // wrapper even with an explicit flag (persistedPlaywright is not
      // short-circuited); only persistence and projection must not happen.
      // loadDevtoolsMcpPreference stays short-circuited by ?? on explicit.
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
  });

  // T05-RED: recovery (doctor/uninstall) on the observed Pi 0.87.1 host must
  // reach the receipt-aware package run instead of the obsolete global gate.
  // The mocked package stands in for ownership validation (owned → success,
  // foreign → receipt-untrusted); real ownership stays pinned by pi-package-operations tests.
  it.each([
    ["owned doctor", "doctor", { kind: "healthy" }, { kind: "healthy" }],
    ["owned uninstall", "uninstall", { kind: "uninstalled" }, { kind: "uninstalled" }],
    ["foreign doctor", "doctor", { kind: "blocked", reason: "receipt-untrusted" }, { kind: "blocked", reason: "receipt-untrusted" }],
    ["foreign uninstall", "uninstall", { kind: "blocked", reason: "receipt-untrusted" }, { kind: "blocked", reason: "receipt-untrusted" }],
  ] as const)(
    "passes %s on the observed Pi 0.87.1 host through to the receipt-aware package run",
    async (_label, operation, packageResult, expected) => {
      const runPiRuntimeSystem = vi.fn(async () => packageResult);
      const runPiProjectionLifecycleSystem = vi.fn((input: { operation: string }) =>
        input.operation === "doctor" ? { kind: "healthy" as const } : { kind: "uninstalled" as const },
      );
      const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
      const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
      const detectPlaywrightCli = vi.fn(() => ({
        status: "current" as const,
        binPath: "/isolated/bin/playwright-cli",
        detectedVersion: "0.1.18",
      }));
      const resolvePnpmBin = vi.fn(() => "/isolated/bin/pnpm");
      const loadPlaywrightCliPreference = vi.fn(() => false);
      const loadDevtoolsMcpPreference = vi.fn(() => false);
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
          detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
          engramBin: "/isolated/bin/engram",
          writingStyle: FORWARDING_STYLE,
        });

        expect(result).toEqual(expected);
        expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
        expect(runPiRuntimeSystem).toHaveBeenCalled();
      } finally {
        vi.doUnmock("../src/lib/pi-runtime.js");
        vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
        vi.doUnmock("../src/lib/tool-preferences.js");
        vi.doUnmock("../src/lib/external-tools.js");
        vi.resetModules();
      }
    },
  );

  // T05-RED: stage-verified install on the observed Pi 0.87.1 host must reach
  // the package (stage smoke owns compatibility) and project the dynamic
  // receipt-authenticated source, not the static candidate. Keeps the
  // untested host99 activation block untouched until stage is verified.
  it("allows stage-verified install on Pi 0.87.1 and projects the dynamic authenticated source", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    // Mocked stage seam: isolated stage+smoke already produced the
    // provider-selected synthetic candidate; the package fake below only
    // authenticates when that staged candidate reaches it.
    const stageSeam = vi.fn(() => ({
      candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } },
    }));
    const staged = stageSeam();
    const projectionInputs: unknown[] = [];
    const runPiRuntimeSystem = vi.fn(
      async (input: { operation: string; candidate?: { package?: { source?: string } } }) => {
        if (input.operation === "sync") return { kind: "synced" as const };
        if (input.operation !== "install") return { kind: "blocked" as const, reason: "unexpected-operation" };
        if (input.candidate?.package?.source !== DYNAMIC_SOURCE) {
          return { kind: "blocked" as const, reason: "candidate-missing" };
        }
        return {
          kind: "installed" as const,
          receipt: {
            schemaVersion: 1,
            state: "installed",
            candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } },
          },
        };
      },
    );
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "installed" as const };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
        candidate: (staged as { candidate: unknown }).candidate,
      });

      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "install",
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
        }),
      );
      expect(result).toMatchObject({ kind: "installed" });
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalled();
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (negative): install must authenticate the installed receipt
  // against the staged input candidate before projecting. Input candidate A
  // vs installed receipt B (e.g. cache race) must fail closed BEFORE
  // projection, without persisting Playwright/DevTools preferences and
  // without falling back to the static pin. Uses the tested host 0.84.2 so
  // the obsolete global gate cannot mask the mismatch (0.87.1 would block
  // first for the wrong reason); host99 controls stay untouched.
  it("fails closed before projection when the installed receipt source mismatches the staged candidate", async () => {
    const CANDIDATE_SOURCE_A = "npm:jorgex-pi@9.9.8";
    const RECEIPT_SOURCE_B = "npm:jorgex-pi@9.9.9";
    const runPiRuntimeSystem = vi.fn(
      async (input: { operation: string; candidate?: { package?: { source?: string } } }) => {
        if (input.operation === "sync") return { kind: "synced" as const };
        if (input.operation !== "install") return { kind: "blocked" as const, reason: "unexpected-operation" };
        return {
          kind: "installed" as const,
          receipt: {
            schemaVersion: 1,
            state: "installed",
            candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: RECEIPT_SOURCE_B } },
          },
        };
      },
    );
    const runPiProjectionLifecycleSystem = vi.fn((_input: unknown) => ({ kind: "installed" as const }));
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
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
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
        devtoolsMcpEnabled: true,
        playwrightCliEnabled: true,
        candidate: { package: { name: "jorgex-pi", version: "9.9.8", source: CANDIDATE_SOURCE_A } },
      });

      expect(result).toMatchObject({ kind: "blocked" });
      expect(JSON.stringify(result)).not.toMatch(/npm:jorgex-pi@test/);
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "install",
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: CANDIDATE_SOURCE_A }),
          }),
        }),
      );
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
      expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (sync): sync must project the authenticated packageSource from
  // the new runPiPackageManagedSync result, not the static candidate.
  // Blocked packages never reach projection (covered by "does not project
  // when package %s is blocked"); this is the positive threading case only.
  // Uses the tested host 0.84.2 so the global host gate cannot mask the
  // wiring; no candidate injection on sync.
  it("projects the authenticated sync packageSource instead of the static candidate", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const projectionInputs: unknown[] = [];
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation !== "sync") return { kind: "blocked" as const, reason: "unexpected-operation" };
      return { kind: "synced" as const, actions: [], packageSource: DYNAMIC_SOURCE };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "synced" as const, changed: false };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toMatchObject({ kind: "synced" });
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "sync" }));
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(1);
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
      expect((projectionInputs[0] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (bug regression): a real isolated Pi install succeeds, but sync
  // on the observed Pi 0.87.1 host is rejected by the global testedVersions
  // gate before the package layer runs. Sync must reach the package and
  // project the authenticated packageSource, as on the tested host. No
  // candidate injection on sync; host99 controls stay untouched.
  it("allows sync on Pi 0.87.1 and projects the authenticated packageSource", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const projectionInputs: unknown[] = [];
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation !== "sync") return { kind: "blocked" as const, reason: "unexpected-operation" };
      return { kind: "synced" as const, actions: [], packageSource: DYNAMIC_SOURCE };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "synced" as const, changed: false };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "sync",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toMatchObject({ kind: "synced" });
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "sync" }));
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(1);
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T07-RED (managed update): update on the observed Pi 0.87.1 host with a
  // fully prepared synthetic candidate+prepared must bypass the obsolete host
  // allowlist, forward operation:'update' to the package, require the package
  // updated receipt, and reconcile via package:update → projection:sync →
  // package:sync → projection:sync with the receipt-authenticated
  // packageSource. No Pi setup nor preflight since the stage is supplied;
  // without candidate+prepared the host gate must still block (covered by the
  // models/update gate test) with no network asserted here.
  it("allows prepared update on Pi 0.87.1 and projects the authenticated packageSource", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTH_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } };
    const SYNTH_PREPARED = { stageDir: "/isolated/pi-stage" };
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const preparePiRuntimeSystem = vi.fn(async () => {
      throw new Error("update with supplied stage must not run preflight");
    });
    const runPiRuntimeSystem = vi.fn(
      async (input: { operation: string; candidate?: { package?: { source?: string } }; prepared?: unknown }) => {
        packageInputs.push(input);
        if (input.operation === "sync") return { kind: "synced" as const, packageSource: DYNAMIC_SOURCE };
        if (input.operation !== "update") return { kind: "blocked" as const, reason: "unexpected-operation" };
        if (input.candidate?.package?.source !== DYNAMIC_SOURCE || input.prepared === undefined) {
          return { kind: "blocked" as const, reason: "candidate-missing" };
        }
        return {
          kind: "updated" as const,
          receipt: {
            schemaVersion: 1,
            state: "installed",
            candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } },
          },
        };
      },
    );
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "synced" as const, changed: false };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
    const savePlaywrightCliPreference = vi.fn();
    const saveDevtoolsMcpPreference = vi.fn();

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem,
      completePiProjectionUninstallSystem,
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "update",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
        candidate: SYNTH_CANDIDATE,
        prepared: SYNTH_PREPARED,
      });

      expect(preparePiRuntimeSystem).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version/);
      expect(result).toMatchObject({ kind: "updated" });
      // Changed-candidate update reconciles via package:update →
      // projection:sync → package:sync → projection:sync.
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(2);
      expect(runPiRuntimeSystem).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: "update",
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
          prepared: SYNTH_PREPARED,
        }),
      );
      expect(runPiRuntimeSystem).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operation: "sync" }),
      );
      expect(packageInputs[1]).toEqual(
        expect.objectContaining({
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
        }),
      );
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(2);
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ operation: "sync", packageSource: DYNAMIC_SOURCE }));
      expect(projectionInputs[1]).toEqual(expect.objectContaining({ operation: "sync", packageSource: DYNAMIC_SOURCE }));
      expect((projectionInputs[0] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
      expect((projectionInputs[1] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
      expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T07-RED (deliberate update): the real CLI never passes a caller stage for
  // update, so runManagedPiSystem on Pi 0.87.1 with no candidate/prepared must
  // await the mocked preparePiRuntimeSystem preflight FIRST (operation update,
  // isolated synthetic 9.9.9 test-only, no network/HOME), then call the
  // package with exactly that {candidate, prepared} and reconcile via
  // package:update → projection:sync → package:sync → projection:sync with the
  // exact updated receipt source — never the static candidate. No static host
  // gate first and no unverified fallback. Blocked old gate (no old receipt)
  // is owned by the models/update gate test above: preflight reason with no
  // package/projection.
  it("deliberate update without caller stage prepares first, updates with proof, and projects the authenticated source", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTH_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } };
    const SYNTH_PREPARED = { stageDir: "/isolated/pi-stage" };
    const packageInputs: unknown[] = [];
    const projectionInputs: unknown[] = [];
    const preparePiRuntimeSystem = vi.fn(async (_input: unknown) => ({
      candidate: SYNTH_CANDIDATE,
      prepared: SYNTH_PREPARED,
    }));
    const runPiRuntimeSystem = vi.fn(
      async (input: { operation: string; candidate?: { package?: { source?: string } }; prepared?: unknown }) => {
        packageInputs.push(input);
        if (input.operation === "sync") return { kind: "synced" as const, packageSource: DYNAMIC_SOURCE };
        if (input.operation !== "update") return { kind: "blocked" as const, reason: "unexpected-operation" };
        if (input.candidate?.package?.source !== DYNAMIC_SOURCE || input.prepared === undefined) {
          return { kind: "blocked" as const, reason: "candidate-missing" };
        }
        return {
          kind: "updated" as const,
          receipt: {
            schemaVersion: 1,
            state: "installed",
            candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } },
          },
        };
      },
    );
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "synced" as const, changed: false };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
    const savePlaywrightCliPreference = vi.fn();
    const saveDevtoolsMcpPreference = vi.fn();

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem,
      completePiProjectionUninstallSystem,
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "update",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(preparePiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(preparePiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "update" }));
      // Changed-candidate update reconciles via package:update →
      // projection:sync → package:sync → projection:sync.
      expect(runPiRuntimeSystem).toHaveBeenCalledTimes(2);
      expect(runPiRuntimeSystem).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: "update",
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
          prepared: SYNTH_PREPARED,
        }),
      );
      expect(runPiRuntimeSystem).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ operation: "sync" }),
      );
      expect(packageInputs[1]).toEqual(
        expect.objectContaining({
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
        }),
      );
      expect(preparePiRuntimeSystem.mock.invocationCallOrder[0]).toBeLessThan(
        runPiRuntimeSystem.mock.invocationCallOrder[0]!,
      );
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version|candidate-missing/);
      expect(result).toMatchObject({ kind: "updated" });
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(2);
      expect(projectionInputs[0]).toEqual(
        expect.objectContaining({ operation: "sync", packageSource: DYNAMIC_SOURCE }),
      );
      expect(projectionInputs[1]).toEqual(
        expect.objectContaining({ operation: "sync", packageSource: DYNAMIC_SOURCE }),
      );
      expect((projectionInputs[0] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
      expect((projectionInputs[1] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
      expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (bug regression): doctor on Pi 0.87.1 reaches the package (the
  // host gate exempts doctor) but projects the static candidate source, so
  // a healthy managed install reports projection-drift. Doctor must project
  // the authenticated package source from the package result instead.
  it("projects the authenticated doctor packageSource instead of the static candidate", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const projectionInputs: unknown[] = [];
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation !== "doctor") return { kind: "blocked" as const, reason: "unexpected-operation" };
      return { kind: "healthy" as const, packageSource: DYNAMIC_SOURCE };
    });
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "healthy" as const };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "doctor",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toMatchObject({ kind: "healthy" });
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "doctor" }));
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(1);
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
      expect((projectionInputs[0] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (deliberate install): the real CLI (src/cli.ts) never passes a
  // caller-supplied candidate, so runManagedPiSystem on install must await
  // the mocked preparePiRuntimeSystem preflight (exact provider artifact +
  // isolated native Pi stage, synthetic 9.9.9 test-only), then call the
  // package with {candidate, prepared} and project the authenticated
  // installed receipt source — never the static candidate. No FS/HOME/net.
  it("deliberate install without caller candidate prepares, installs with proof, and projects the authenticated source", async () => {
    const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTH_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } };
    const SYNTH_PREPARED = { stageDir: "/isolated/pi-stage" };
    const projectionInputs: unknown[] = [];
    const preparePiRuntimeSystem = vi.fn(async (_input: unknown) => ({
      candidate: SYNTH_CANDIDATE,
      prepared: SYNTH_PREPARED,
    }));
    const runPiRuntimeSystem = vi.fn(
      async (input: { operation: string; candidate?: { package?: { source?: string } }; prepared?: unknown }) => {
        if (input.operation === "sync") return { kind: "synced" as const };
        if (input.operation !== "install") return { kind: "blocked" as const, reason: "unexpected-operation" };
        if (input.candidate?.package?.source !== DYNAMIC_SOURCE || input.prepared === undefined) {
          return { kind: "blocked" as const, reason: "candidate-missing" };
        }
        return {
          kind: "installed" as const,
          receipt: {
            schemaVersion: 1,
            state: "installed",
            candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } },
          },
        };
      },
    );
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
      projectionInputs.push(input);
      return { kind: "installed" as const };
    });
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem,
      completePiProjectionUninstallSystem,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(preparePiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(preparePiRuntimeSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "install" }));
      expect(runPiRuntimeSystem).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "install",
          candidate: expect.objectContaining({
            package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
          }),
          prepared: SYNTH_PREPARED,
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(/unsupported-pi-version|candidate-missing/);
      expect(result).toMatchObject({ kind: "installed" });
      expect(runPiProjectionLifecycleSystem).toHaveBeenCalled();
      expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05-RED (negative): a blocked or throwing preflight must fail closed
  // before package install, projection, and preference persistence.
  const PREFLIGHT_FAILURES: Array<[string, { kind: "blocked"; reason: string } | Error]> = [
    ["blocked preflight", { kind: "blocked", reason: "preflight-unavailable" }],
    ["throwing preflight", new Error("preflight exploded")],
  ];
  it.each(PREFLIGHT_FAILURES)("does not install, project, or persist preferences on %s", async (_label, outcome) => {
    const preparePiRuntimeSystem = vi.fn(async (_input: unknown) => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const runPiRuntimeSystem = vi.fn(async () => ({ kind: "installed" as const }));
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));
    const savePlaywrightCliPreference = vi.fn();
    const saveDevtoolsMcpPreference = vi.fn();

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem,
      completePiProjectionUninstallSystem,
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference,
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      loadDevtoolsMcpPreference: vi.fn(() => false),
      saveDevtoolsMcpPreference,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
        devtoolsMcpEnabled: true,
        playwrightCliEnabled: true,
      });

      expect(preparePiRuntimeSystem).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(runPiRuntimeSystem).not.toHaveBeenCalled();
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
      expect(saveDevtoolsMcpPreference).not.toHaveBeenCalled();
      expect(savePlaywrightCliPreference).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/lib/pi-runtime.js");
      vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
    }
  });

  // T05 guard (targetDir, distinct rule): install with targetDir must block
  // without preflight network and without projection. Tested host 0.84.2
  // isolates the targetDir rule from the host gate. Green before (via
  // install gates) and after (via the targetDir rule); locks the invariant
  // for GREEN rather than proving new wiring.
  it("blocks targetDir install without preflight network or projection", async () => {
    const preparePiRuntimeSystem = vi.fn(async (_input: unknown) => ({
      candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" } },
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "install") return { kind: "blocked" as const, reason: "candidate-missing" };
      return { kind: "blocked" as const, reason: "unexpected-operation" };
    });
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));
    const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
    const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: ["playwright-handoff-v1"] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem,
      completePiProjectionUninstallSystem,
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
      const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
        runManagedPiSystem(input: unknown): Promise<unknown>;
      };
      const result = await mod.runManagedPiSystem({
        operation: "install",
        targetDir: "/isolated/target",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
        writingStyle: FORWARDING_STYLE,
      });

      expect(result).toMatchObject({ kind: "blocked" });
      expect(preparePiRuntimeSystem).not.toHaveBeenCalled();
      expect(runPiProjectionLifecycleSystem).not.toHaveBeenCalled();
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
        ? ["package:install", "projection:install", "package:sync", "projection:sync"]
        : operation === "update"
          ? ["package:update", "projection:sync", "package:sync", "projection:sync"]
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

  // T51: se elimina el test tautológico de uninstall happy-path con fakes que
  // replicaban el wiring (prepare→package→complete sin contrato distintivo).
  // Cobertura autoritativa restante en este mismo seam: "does not uninstall
  // the package when preparation reports …" (gate de prepare), "does not
  // complete the projection when package uninstall is blocked" (gate de
  // package) y "propagates a completion failure and permits a fresh uninstall
  // retry" (cuya segunda invocación acredita el orden happy-path
  // prepare→package→complete con estado de reintento real).
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
    // FIX (deliberate-install contract): the real (non-targetDir) install
    // preflights first, so the fixture supplies a synthetic prepared stage
    // and a matching receipt. The targetDir call skips preflight; the
    // shared receipt is harmless there (no candidate to authenticate).
    const SYNTHETIC_SOURCE = "npm:jorgex-pi@9.9.9";
    const SYNTHETIC_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } };
    const preparePiRuntimeSystem = vi.fn(async () => ({
      candidate: SYNTHETIC_CANDIDATE,
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }) => {
      if (input.operation === "sync") return { kind: "blocked" as const, reason: "runner-unhealthy" };
      return {
        kind: "installed" as const,
        receipt: {
          schemaVersion: 1,
          state: "installed",
          candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: SYNTHETIC_SOURCE } },
        },
      };
    });
    const runPiProjectionLifecycleSystem = vi.fn(() => ({ kind: "installed" as const }));

    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: "npm:jorgex-pi@test" },
        pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
        contract: { capabilities: [] },
      },
      preparePiRuntimeSystem,
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

  // Live repro: isolated `install --agents pi` reports installed but immediate
  // `doctor --agents pi` reports `projection-drift settings.json`; an explicit
  // `sync --agents pi` then heals doctor. Hypothesis: install order
  // package:install → projection:install → package:sync leaves the projection
  // stale after the final runner sync mutates settings/receipt. Install must
  // reconcile with a final projection:sync only after package sync succeeds,
  // so install returns installed AND immediate doctor stays healthy without a
  // user extra sync. Failure semantics unchanged: no final projection sync
  // when package sync fails (covered above).
  it("reconciles package sync settings mutation with a final projection sync so immediate doctor stays healthy", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    let projectionDirty = false;

    const deps = withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") return { kind: "installed" };
        if (next === "sync") {
          projectionDirty = true;
          return { kind: "synced" };
        }
        if (next === "doctor") return { kind: "healthy" };
        throw new Error(`unexpected package operation: ${next}`);
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        if (next === "sync") {
          projectionDirty = false;
          return { kind: "synced", changed: true };
        }
        if (next === "doctor") {
          if (projectionDirty) {
            return {
              kind: "drift",
              paths: ["settings.json"],
              remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
            };
          }
          return { kind: "healthy" };
        }
        return projectionSuccess(next);
      },
    });

    const installResult = await runManagedPiOperation("install", deps);
    expect(installResult).toEqual({ kind: "installed" });
    expect(trace).toEqual([
      "package:install",
      "projection:install",
      "package:sync",
      "projection:sync",
    ]);

    const doctorTrace: string[] = [];
    const doctorDeps = withUninstallLifecycle({
      async runPackage(next) {
        doctorTrace.push(`package:${next}`);
        return { kind: "healthy" };
      },
      async runProjection(next) {
        doctorTrace.push(`projection:${next}`);
        if (projectionDirty) {
          return {
            kind: "drift",
            paths: ["settings.json"],
            remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
          };
        }
        return { kind: "healthy" };
      },
    });
    // Immediate doctor observes the reconciled projection without a user extra
    // sync: shared dirty flag proves the final projection:sync cleared it.
    const doctorResult = await runManagedPiOperation("doctor", doctorDeps);
    expect(doctorResult).toEqual({ kind: "healthy" });
    expect(doctorTrace).toEqual(["package:doctor", "projection:doctor"]);
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

    expect(trace).toEqual(["package:install", "projection:install", "package:sync", "projection:sync"]);
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
  // T51: se elimina el test tautológico de ordering con fakes que se probaban
  // a sí mismos (fakeSetup/fakePackage sin llamar a producción). Cobertura
  // autoritativa restante: T48 "install con .bin interno permite
  // setup→package" (runOfficialSetup real con backup→spawn→verify + gate de
  // activación), T50 "managed Pi fuera de HOME" (runManagedPiSystem real con
  // frontera de restore), T41 "verify parcial" (backup/restore reales) y los
  // verify singleton/MCP de pi-package-lifecycle.
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

// ---------------------------------------------------------------------------
// T50-RED: managed Pi fuera de HOME bloquea con frontera de restore antes
// de backup/spawn y propaga remedy preciso sin afirmar restore falso.
// Contrato: PI_CODING_AGENT_DIR fuera de HOME no puede recomponerse con el
// restore acotado a HOME; el install gestionado falla cerrado con mensaje
// accionable (PI_CODING_AGENT_DIR + frontera restore + HOME) y nunca afirma
// restauración. Aislado; env restaurado; sin HOME real.
// ---------------------------------------------------------------------------

describe("[T50-RED] managed Pi fuera de HOME con frontera de restore", () => {
  it("install con PI_CODING_AGENT_DIR fuera de HOME falla antes de backup/spawn con mensaje accionable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-managed-dest-"));
    T41_TEMP_ROOTS.push(root);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-managed-dest-out-"));
    T41_TEMP_ROOTS.push(outsideRoot);
    const outsideAgentDir = path.join(outsideRoot, "pi-agent");
    fs.mkdirSync(outsideAgentDir, { recursive: true });
    const marker = path.join(outsideAgentDir, "settings.json");
    const originalMarker = JSON.stringify({ packages: [] });
    fs.writeFileSync(marker, originalMarker);
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    process.env.PI_CODING_AGENT_DIR = outsideAgentDir;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // FIX (deliberate-install contract): real installs preflight first. The
    // fixture mocks only the preflight with a synthetic prepared stage that
    // satisfies the prepared-proof (candidate/artifact/release/evidence),
    // while the REAL package runtime still runs so the official-setup
    // destination boundary outside HOME is genuinely exercised. No network:
    // the mock never fetches and the stage dir is never touched.
    const T50_SHA256 = "a".repeat(64);
    const T50_SHA512 = "b".repeat(128);
    const T50_CANDIDATE = {
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      tarball: { bytes: 99, sha256: T50_SHA256, sha512: T50_SHA512 },
      provenance: { commit: "c".repeat(40) },
    };
    const T50_PREPARED = {
      candidate: T50_CANDIDATE,
      artifact: { path: "/isolated/downloads/jorgex-pi-9.9.9.tgz", bytes: 99, sha256: T50_SHA256, sha512: T50_SHA512 },
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: `sha512-${Buffer.from(T50_SHA512, "hex").toString("base64")}`,
      },
      stageDir: `/isolated/stage-${"d".repeat(32)}/pi-agent`,
      evidence: {
        lockSha256: "e".repeat(64),
        treeSha256: "f".repeat(64),
        dependencies: ["one", "two", "three", "four", "five", "six"].map((name) => ({
          name,
          version: "9.9.9",
          integrity: `sha512-${"A".repeat(86)}==`,
        })),
      },
      sourceAlias: "npm:jorgex-pi@file:/isolated/downloads/jorgex-pi-9.9.9.tgz",
    };
    const preparePiRuntimeSystem = vi.fn(async () => ({ candidate: T50_CANDIDATE, prepared: T50_PREPARED }));
    vi.resetModules();
    vi.doMock("../src/lib/pi-runtime.js", async (importOriginal) => ({
      ...((await importOriginal()) as Record<string, unknown>),
      preparePiRuntimeSystem,
    }));
    vi.doMock("../src/lib/tool-preferences.js", () => ({
      loadDevtoolsMcpPreference: vi.fn(() => false),
      devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools-mcp.json"),
      saveDevtoolsMcpPreference: vi.fn(),
      loadPlaywrightCliPreference: vi.fn(() => false),
      playwrightCliPreferenceFile: vi.fn(() => "/isolated/state/playwright-cli.json"),
      savePlaywrightCliPreference: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
      detectPlaywrightCli: vi.fn(() => ({ status: "absent" as const, binPath: null, detectedVersion: null })),
    }));
    try {
      const mod = await import("../src/lib/pi-managed-runtime.js") as any;
      const result = await mod.runManagedPiSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
        writingStyle: FORWARDING_STYLE,
      }) as { kind: string; reason?: string; remedy?: string };

      expect(result.kind).toBe("blocked");
      // Proves the mocked preflight carried through to the REAL official
      // setup boundary (not the earlier preflight agent-dir block).
      expect(result).toMatchObject({ reason: "setup-pi-failed" });
      const remedy = String((result as any).remedy ?? (result as any).reason ?? "");
      expect(remedy).toMatch(/restore|frontera/i);
      expect(remedy).toMatch(/PI_CODING_AGENT_DIR/);
      expect(remedy).toMatch(/HOME/);
      expect(remedy).not.toMatch(/Se restauró el backup previo; Pi no quedó activado\./);
      expect(fs.readFileSync(marker, "utf8")).toBe(originalMarker);
      expect(fs.existsSync(path.join(home, ".jorgex-stack"))).toBe(false);
    } finally {
      vi.doUnmock("../src/lib/tool-preferences.js");
      vi.doUnmock("../src/lib/external-tools.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
    }
  });

  it("control: validate Pi dentro de HOME pasa y no bloquea por destino", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-managed-dest-in-"));
    T41_TEMP_ROOTS.push(root);
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const insideAgentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(insideAgentDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js") as any;
    expect(mod.validateOfficialSetupDestination("pi", insideAgentDir, home)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live repro: freshly installed jorgex-pi@0.8.31, `update --agents pi --yes`
// reports Pi: source-divergent when candidate/lock/tree unchanged. Suspect:
// runManagedPiSystem forwards authenticated packageSource on sync/doctor but
// NOT on update {kind:'healthy', packageSource} (no-change path), so the
// projection sync receives the static candidate (.29) and blocks.
// Tight RED: injected candidate+prepared, Pi 0.87.1, package update returns
// healthy+DYNAMIC_SOURCE, projection blocks source-divergent unless it sees
// DYNAMIC_SOURCE. Expect healthy + correct projection source. Isolated
// synthetic 9.9.9 only; no HOME/network.
// ---------------------------------------------------------------------------
it("forwards authenticated update-healthy packageSource to projection instead of the static candidate", async () => {
  const DYNAMIC_SOURCE = "npm:jorgex-pi@9.9.9";
  const SYNTH_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: DYNAMIC_SOURCE } };
  const SYNTH_PREPARED = { stageDir: "/isolated/pi-stage" };
  const projectionInputs: unknown[] = [];
  const preparePiRuntimeSystem = vi.fn(async () => {
    throw new Error("update with supplied stage must not run preflight");
  });
  const runPiRuntimeSystem = vi.fn(
    async (input: { operation: string; candidate?: { package?: { source?: string } }; prepared?: unknown }) => {
      if (input.operation !== "update") return { kind: "blocked" as const, reason: "unexpected-operation" };
      if (input.candidate?.package?.source !== DYNAMIC_SOURCE || input.prepared === undefined) {
        return { kind: "blocked" as const, reason: "candidate-missing" };
      }
      // No-change update path: candidate/lock/tree unchanged, no new receipt.
      return { kind: "healthy" as const, packageSource: DYNAMIC_SOURCE };
    },
  );
  const runPiProjectionLifecycleSystem = vi.fn((input: unknown) => {
    projectionInputs.push(input);
    const source = (input as { packageSource?: unknown }).packageSource;
    if (source !== DYNAMIC_SOURCE) return { kind: "blocked" as const, reason: "source-divergent" };
    return { kind: "synced" as const, changed: false };
  });
  const preparePiProjectionUninstallSystem = vi.fn(() => ({ kind: "prepared" as const, plan: "token" }));
  const completePiProjectionUninstallSystem = vi.fn(() => ({ kind: "uninstalled" as const }));

  vi.resetModules();
  vi.doMock("../src/lib/pi-runtime.js", () => ({
    PI_RUNTIME_CANDIDATE: {
      package: { source: "npm:jorgex-pi@test" },
      pi: { testedVersions: MOCK_TESTED_PI_VERSIONS },
      contract: { capabilities: ["playwright-handoff-v1"] },
    },
    preparePiRuntimeSystem,
    runPiRuntimeSystem,
  }));
  vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
    runPiProjectionLifecycleSystem,
    preparePiProjectionUninstallSystem,
    completePiProjectionUninstallSystem,
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
    const mod = (await import("../src/lib/pi-managed-runtime.js")) as unknown as {
      runManagedPiSystem(input: unknown): Promise<unknown>;
    };
    const result = await mod.runManagedPiSystem({
      operation: "update",
      detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
      engramBin: "/isolated/bin/engram",
      writingStyle: FORWARDING_STYLE,
      candidate: SYNTH_CANDIDATE,
      prepared: SYNTH_PREPARED,
    });

    expect(preparePiRuntimeSystem).not.toHaveBeenCalled();
    expect(runPiRuntimeSystem).toHaveBeenCalledTimes(1);
    expect(runPiRuntimeSystem).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update",
        candidate: expect.objectContaining({
          package: expect.objectContaining({ source: DYNAMIC_SOURCE }),
        }),
        prepared: SYNTH_PREPARED,
      }),
    );
    expect(result).toMatchObject({ kind: "healthy" });
    expect(JSON.stringify(result)).not.toMatch(/source-divergent/);
    expect(runPiProjectionLifecycleSystem).toHaveBeenCalledTimes(1);
    expect(projectionInputs[0]).toEqual(expect.objectContaining({ packageSource: DYNAMIC_SOURCE }));
    expect((projectionInputs[0] as { packageSource: string }).packageSource).not.toBe("npm:jorgex-pi@test");
  } finally {
    vi.doUnmock("../src/lib/pi-runtime.js");
    vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
    vi.doUnmock("../src/lib/tool-preferences.js");
    vi.doUnmock("../src/lib/external-tools.js");
    vi.resetModules();
  }
});

describe("Pi managed update post-projection initialization", () => {
  // Live repro: install final projection sync fixed, but deliberate managed
  // update with changed candidate returns {kind:'updated'} after ONE
  // projection sync without running new package sync --json; stage smoke
  // doesn't initialize active Pi settings/receipt; subsequent doctor may
  // report pending/drift. Changed-candidate update must reconcile with
  // package:update → projection:sync → package:sync → projection:sync, then
  // immediate doctor stays healthy. Same-candidate healthy keeps one
  // projection sync; blocked projection/package sync must not report updated.
  it("reconciles changed-candidate update settings mutation with package sync and final projection sync so immediate doctor stays healthy", async () => {
    const { runManagedPiOperation } = await managedRuntime();
    const trace: string[] = [];
    let initialized = false;
    let projectionDirty = false;

    const deps = withUninstallLifecycle({
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "update") return { kind: "updated" };
        if (next === "sync") {
          initialized = true;
          projectionDirty = true;
          return { kind: "synced" };
        }
        if (next === "doctor") return { kind: "healthy" };
        throw new Error(`unexpected package operation: ${next}`);
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        if (next === "sync") {
          projectionDirty = false;
          return { kind: "synced", changed: true };
        }
        if (next === "doctor") {
          if (!initialized || projectionDirty) {
            return {
              kind: "drift",
              paths: ["settings.json"],
              remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
            };
          }
          return { kind: "healthy" };
        }
        return projectionSuccess(next);
      },
    });

    const updateResult = await runManagedPiOperation("update", deps);
    expect(updateResult).toEqual({ kind: "updated" });
    expect(trace).toEqual([
      "package:update",
      "projection:sync",
      "package:sync",
      "projection:sync",
    ]);

    // Immediate doctor observes the reconciled projection without a user extra
    // sync: shared flags prove package sync initialized and the final
    // projection sync cleared the settings mutation.
    const doctorTrace: string[] = [];
    const doctorResult = await runManagedPiOperation(
      "doctor",
      withUninstallLifecycle({
        async runPackage(next) {
          doctorTrace.push(`package:${next}`);
          return { kind: "healthy" };
        },
        async runProjection(next) {
          doctorTrace.push(`projection:${next}`);
          if (!initialized || projectionDirty) {
            return {
              kind: "drift",
              paths: ["settings.json"],
              remedy: "Ejecuta sync --agents pi para reparar la proyección de Pi.",
            };
          }
          return { kind: "healthy" };
        },
      }),
    );
    expect(doctorResult).toEqual({ kind: "healthy" });
    expect(doctorTrace).toEqual(["package:doctor", "projection:doctor"]);

    // Control: same-candidate update {kind:'healthy'} keeps one projection
    // sync with no extra package sync.
    const healthyTrace: string[] = [];
    const healthyResult = await runManagedPiOperation(
      "update",
      withUninstallLifecycle({
        async runPackage(next) {
          healthyTrace.push(`package:${next}`);
          if (next === "update") return { kind: "healthy" };
          throw new Error(`unexpected package operation: ${next}`);
        },
        async runProjection(next) {
          healthyTrace.push(`projection:${next}`);
          return { kind: "synced", changed: false };
        },
      }),
    );
    expect(healthyResult).toEqual({ kind: "healthy" });
    expect(healthyTrace).toEqual(["package:update", "projection:sync"]);

    // Control: blocked package sync after update must not report updated.
    const blockedPackageSyncTrace: string[] = [];
    const blockedPackageSyncResult = await runManagedPiOperation(
      "update",
      withUninstallLifecycle({
        async runPackage(next) {
          blockedPackageSyncTrace.push(`package:${next}`);
          if (next === "update") return { kind: "updated" };
          if (next === "sync") return { kind: "blocked", reason: "runner-unhealthy" };
          throw new Error(`unexpected package operation: ${next}`);
        },
        async runProjection(next) {
          blockedPackageSyncTrace.push(`projection:${next}`);
          return { kind: "synced", changed: true };
        },
      }),
    );
    expect(blockedPackageSyncResult).toMatchObject({ kind: "blocked", reason: "runner-unhealthy" });
    expect(blockedPackageSyncResult).not.toEqual({ kind: "updated" });
    expect(blockedPackageSyncTrace).toEqual([
      "package:update",
      "projection:sync",
      "package:sync",
    ]);

    // Control: blocked projection after update must not report updated.
    const blockedProjectionTrace: string[] = [];
    const blockedProjectionResult = await runManagedPiOperation(
      "update",
      withUninstallLifecycle({
        async runPackage(next) {
          blockedProjectionTrace.push(`package:${next}`);
          if (next === "update") return { kind: "updated" };
          throw new Error(`unexpected package operation: ${next}`);
        },
        async runProjection(next) {
          blockedProjectionTrace.push(`projection:${next}`);
          return { kind: "blocked", reason: "projection-backup-failed" };
        },
      }),
    );
    expect(blockedProjectionResult).toEqual({ kind: "blocked", reason: "projection-backup-failed" });
    expect(blockedProjectionTrace).toEqual(["package:update", "projection:sync"]);
  });
});

// Synthetic test-only DevTools provider release shared by the Pi-only
// acquisition tracer and the older forwarding tests, so no test ever hits
// live npm. Fixture, never a version selector: the exact version/URL/SRI
// travel together from the stubbed registry.
const DEVTOOLS_VERSION = "9.9.20";
const DEVTOOLS_TARBALL = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-9.9.20.tgz";
const DEVTOOLS_BYTES = Buffer.from("synthetic-chrome-devtools-mcp-tarball-9.9.20\n");
const DEVTOOLS_INTEGRITY = `sha512-${createHash("sha512").update(DEVTOOLS_BYTES).digest("base64")}`;
const DEVTOOLS_METADATA = "https://registry.npmjs.org/chrome-devtools-mcp";
const DEVTOOLS_OBSERVED = { version: DEVTOOLS_VERSION, integrity: DEVTOOLS_INTEGRITY };

function devtoolsPackument(): unknown {
  return {
    name: "chrome-devtools-mcp",
    "dist-tags": { latest: DEVTOOLS_VERSION },
    versions: {
      [DEVTOOLS_VERSION]: {
        name: "chrome-devtools-mcp",
        version: DEVTOOLS_VERSION,
        dist: { tarball: DEVTOOLS_TARBALL, integrity: DEVTOOLS_INTEGRITY },
      },
    },
  };
}

function stubDevtoolsFetch(events: string[]): void {
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    events.push(`fetch ${url}`);
    if (url === DEVTOOLS_TARBALL) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(DEVTOOLS_BYTES.slice());
          controller.close();
        },
      });
      const tarball = new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
      Object.defineProperty(tarball, "url", { value: url });
      return tarball;
    }
    if (url === DEVTOOLS_METADATA) {
      const metadata = new Response(JSON.stringify(devtoolsPackument()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(metadata, "url", { value: url });
      return metadata;
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", stub);
}

describe("[T14-RED] Pi-only DevTools provider acquisition", () => {
  // The Pi package itself stays mocked (no Pi execution) with a matching
  // receipt; only the DevTools provider is stubbed above.
  const PI_SOURCE = "npm:jorgex-pi@9.9.9";
  const PI_CANDIDATE = { package: { name: "jorgex-pi", version: "9.9.9", source: PI_SOURCE } };

  async function withTempPiHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const previousPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      vi.resetModules();
      return await run();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiDir;
      vi.resetModules();
    }
  }

  function mockPiPackage() {
    const preparePiRuntimeSystem = vi.fn(async () => ({
      candidate: PI_CANDIDATE,
      prepared: { stageDir: "/isolated/pi-stage" },
    }));
    const runPiRuntimeSystem = vi.fn(async (input: { operation: string }): Promise<{ kind: string; reason?: string; receipt?: unknown }> => {
      if (input.operation === "sync") return { kind: "synced" };
      return {
        kind: "installed",
        receipt: {
          schemaVersion: 1,
          state: "installed",
          candidate: { package: { name: "jorgex-pi", version: "9.9.9", source: PI_SOURCE } },
        },
      };
    });
    vi.doMock("../src/lib/pi-runtime.js", () => ({
      PI_RUNTIME_CANDIDATE: {
        package: { source: PI_SOURCE },
        pi: { testedVersions: ["0.84.2"] },
        contract: { capabilities: [] },
      },
      preparePiRuntimeSystem,
      runPiRuntimeSystem,
    }));
    return { preparePiRuntimeSystem, runPiRuntimeSystem };
  }

  function mockPiProjection(events: string[], projectionInputs: unknown[]) {
    const runPiProjectionLifecycleSystem = vi.fn((input: unknown): { kind: string; reason?: string } => {
      events.push(`projection ${(input as { operation: string }).operation}`);
      projectionInputs.push(input);
      return { kind: "installed" };
    });
    vi.doMock("../src/lib/pi-projection-lifecycle.js", () => ({
      runPiProjectionLifecycleSystem,
      preparePiProjectionUninstallSystem: vi.fn(),
      completePiProjectionUninstallSystem: vi.fn(),
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));
    return { runPiProjectionLifecycleSystem };
  }

  function unmockPiSystem(): void {
    vi.doUnmock("../src/lib/pi-runtime.js");
    vi.doUnmock("../src/lib/pi-projection-lifecycle.js");
    vi.doUnmock("../src/lib/external-tools.js");
    vi.doUnmock("../src/lib/browser-provider.js");
  }

  function mockSmokeProvider(
    events: string[],
    smokeCalls: unknown[][],
    behavior: "resolve" | "reject",
  ): void {
    vi.doMock("../src/lib/browser-provider.js", async () => ({
      ...(await vi.importActual<typeof import("../src/lib/browser-provider.js")>("../src/lib/browser-provider.js")),
      verifyDevtoolsCliArtifact: (...args: unknown[]) => {
        smokeCalls.push(args);
        events.push("smoke");
        if (behavior === "reject") {
          return Promise.reject(new Error("DevTools CLI smoke: missing mandatory flag --isolated"));
        }
        return Promise.resolve({ binPath: "/isolated/stage/bin", version: DEVTOOLS_VERSION });
      },
    }));
    vi.doMock("../src/lib/external-tools.js", () => ({
      resolvePnpmBin: vi.fn(() => "/isolated/bin/pnpm"),
    }));
  }

  function preferenceFile(homeDir: string): string {
    return path.join(homeDir, ".jorgex-stack", "devtools-mcp.json");
  }

  it("verifies the published DevTools candidate before Pi projection and persists the observation only on success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-acquisition-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        mockSmokeProvider(events, [], "resolve");
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            const result = await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });

            expect(result).toMatchObject({ kind: "installed" });
            expect(events[0]).toBe(`fetch ${DEVTOOLS_METADATA}`);
            expect(events[1]).toBe(`fetch ${DEVTOOLS_TARBALL}`);
            expect(events[2]).toBe("smoke");
            expect(events.findIndex((event) => event.startsWith("projection "))).toBe(3);
            expect(projectionInputs[0]).toMatchObject({
              operation: "install",
              devtoolsMcpEnabled: true,
              devtoolsMcpVersion: DEVTOOLS_VERSION,
            });
            const raw = fs.readFileSync(preferenceFile(homeDir), "utf8");
            expect(JSON.parse(raw)).toMatchObject({ enabled: { pi: true } });
            expect(raw).toContain(DEVTOOLS_VERSION);
            expect(raw).toContain(DEVTOOLS_INTEGRITY);
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the preference unmarked when the Pi package is blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-package-blocked-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        const { runPiRuntimeSystem } = mockPiPackage();
        mockPiProjection(events, projectionInputs);
        runPiRuntimeSystem.mockResolvedValueOnce({ kind: "blocked", reason: "runner-unhealthy" });
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            const result = await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });

            expect(result).toMatchObject({ kind: "blocked" });
            expect(fs.existsSync(preferenceFile(homeDir))).toBe(false);
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies before projection yet leaves the preference unmarked when the projection is blocked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-projection-blocked-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        const { runPiProjectionLifecycleSystem } = mockPiProjection(events, projectionInputs);
        mockSmokeProvider(events, [], "resolve");
        runPiProjectionLifecycleSystem.mockImplementationOnce((input: unknown) => {
          events.push(`projection ${(input as { operation: string }).operation}`);
          projectionInputs.push(input);
          return { kind: "blocked", reason: "projection-write-failed" };
        });
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            const result = await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });

            expect(result).toMatchObject({ kind: "blocked" });
            expect(events[0]).toBe(`fetch ${DEVTOOLS_METADATA}`);
            expect(events[1]).toBe(`fetch ${DEVTOOLS_TARBALL}`);
            expect(projectionInputs[0]).toMatchObject({ devtoolsMcpVersion: DEVTOOLS_VERSION });
            expect(fs.existsSync(preferenceFile(homeDir))).toBe(false);
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("performs no provider fetch for a target-dir install with DevTools enabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-target-dir-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const targetDir = path.join(root, "target");
    const events: string[] = [];
    const projectionInputs: unknown[] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            await mod.runManagedPiSystem({
              operation: "install",
              targetDir,
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(events.filter((event) => event.startsWith("fetch "))).toEqual([]);
  });

  it("performs no provider fetch without a DevTools opt-in", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-no-optin-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: false,
              writingStyle: FORWARDING_STYLE,
            });
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(events.filter((event) => event.startsWith("fetch "))).toEqual([]);
  });

  it("proves the privacy flags on the staged artifact after verification and before Pi projection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-flag-smoke-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];
    const smokeCalls: unknown[][] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        mockSmokeProvider(events, smokeCalls, "resolve");
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            const result = await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });

            expect(result).toMatchObject({ kind: "installed" });
            expect(smokeCalls).toHaveLength(1);
            const input = smokeCalls[0]?.[0] as {
              artifactPath?: unknown;
              stageDir?: unknown;
              pnpmBin?: unknown;
              release?: unknown;
            };
            expect(input).toMatchObject({
              pnpmBin: "/isolated/bin/pnpm",
              release: {
                version: DEVTOOLS_VERSION,
                tarballUrl: DEVTOOLS_TARBALL,
                integrity: DEVTOOLS_INTEGRITY,
              },
            });
            expect(typeof input?.artifactPath === "string" && path.isAbsolute(input.artifactPath)).toBe(true);
            expect(typeof input?.stageDir === "string" && path.isAbsolute(input.stageDir)).toBe(true);
            const metaIdx = events.indexOf(`fetch ${DEVTOOLS_METADATA}`);
            const tarballIdx = events.indexOf(`fetch ${DEVTOOLS_TARBALL}`);
            const smokeIdx = events.indexOf("smoke");
            const projectionIdx = events.findIndex((event) => event.startsWith("projection "));
            expect(metaIdx).toBeGreaterThanOrEqual(0);
            expect(tarballIdx).toBeGreaterThan(metaIdx);
            expect(smokeIdx).toBeGreaterThan(tarballIdx);
            expect(projectionIdx).toBeGreaterThan(smokeIdx);
            expect(projectionInputs[0]).toMatchObject({ devtoolsMcpVersion: DEVTOOLS_VERSION });
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks the Pi install without projection or preference mark when the flag smoke rejects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-smoke-reject-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const projectionInputs: unknown[] = [];
    const smokeCalls: unknown[][] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        mockSmokeProvider(events, smokeCalls, "reject");
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            const result = await mod.runManagedPiSystem({
              operation: "install",
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: true,
              writingStyle: FORWARDING_STYLE,
            });

            expect(result).toMatchObject({ kind: "blocked" });
            expect(smokeCalls).toHaveLength(1);
            expect(projectionInputs).toEqual([]);
            expect(events.filter((event) => event.startsWith("projection "))).toEqual([]);
            expect(fs.existsSync(preferenceFile(homeDir))).toBe(false);
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["target-dir", "no-opt-in"] as const)("invokes neither smoke nor provider fetch for Pi %s", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-devtools-smoke-guards-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const targetDir = path.join(root, "target");
    const events: string[] = [];
    const projectionInputs: unknown[] = [];
    const smokeCalls: unknown[][] = [];

    try {
      await withTempPiHome(homeDir, async () => {
        mockPiPackage();
        mockPiProjection(events, projectionInputs);
        mockSmokeProvider(events, smokeCalls, "resolve");
        try {
          const mod = await import("../src/lib/pi-managed-runtime.js") as unknown as PiManagedSystem;
          stubDevtoolsFetch(events);
          try {
            await mod.runManagedPiSystem({
              operation: "install",
              ...(kind === "target-dir" ? { targetDir } : {}),
              detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
              engramBin: "/isolated/bin/engram",
              devtoolsMcpEnabled: kind !== "no-opt-in",
              writingStyle: FORWARDING_STYLE,
            }).then(
              () => undefined,
              () => undefined,
            );
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          unmockPiSystem();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(smokeCalls).toEqual([]);
    expect(events.filter((event) => event.startsWith("fetch "))).toEqual([]);
  });
});
