import { describe, expect, it } from "vitest";
import {
  PI_RUNTIME_CANDIDATE,
  PI_RUNTIME_PREVIOUS_CANDIDATE,
} from "./fixtures/pi-runtime.js";

type Candidate = typeof PI_RUNTIME_CANDIDATE | typeof PI_RUNTIME_PREVIOUS_CANDIDATE;

type Environment = Record<string, string> & {
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN: string;
};
type Invocation = { executable: string; args: string[]; environment: Environment };
type Receipt = {
  schemaVersion: 1;
  state: "installed" | "installing";
  candidate: unknown;
  scope: { kind: "target-dir"; codingAgentDir: string };
  engram: { binary: string };
};
type Result =
  | { kind: "healthy" }
  | { kind: "updated"; receipt: Receipt }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: string; remedy?: string };

type PiPackageOperations = {
  runPiPackageManagedOperation(
    input: {
      operation: "doctor" | "uninstall" | "update";
      interactive: boolean;
      registry: {
        id: "pi";
        kind: "package-managed";
        candidate: Candidate;
        acceptedCandidates?: readonly Candidate[];
      };
      detected: { executable: string; packageRunner: string; settingsJson: string };
      engramBin: string | null;
      receiptJson: string | null;
      paths: { targetDir: boolean; codingAgentDir: string; receiptPath: string; environment: Environment };
    },
    deps: {
      run(invocation: Invocation): { exitCode: number; stdout: string; stderr: string };
      isPackageAbsent(): boolean;
      deleteReceipt(): void;
    },
  ): Result;
};

async function operations(): Promise<PiPackageOperations> {
  const mod = await import("../src/lib/pi-package-lifecycle.js") as Partial<PiPackageOperations>;
  expect(mod.runPiPackageManagedOperation).toBeTypeOf("function");
  return mod as PiPackageOperations;
}

const root = `/tmp/pi-target/pi-agent/packages/jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}`;
const runner = `${root}/bin/jorgex-pi.mjs`;
const source = PI_RUNTIME_CANDIDATE.package.source;
const managedProjectedPackage = { source, skills: [], prompts: [] };
const environment: Environment = {
  HOME: "/tmp/pi-target/home",
  XDG_CONFIG_HOME: "/tmp/pi-target/config",
  XDG_CACHE_HOME: "/tmp/pi-target/cache",
  TMPDIR: "/tmp/pi-target/tmp",
  PI_CODING_AGENT_DIR: "/tmp/pi-target/pi-agent",
  ENGRAM_BIN: "/tmp/pi-target/bin/engram",
};

const previousSource = PI_RUNTIME_PREVIOUS_CANDIDATE.package.source;
const previousRoot = `/tmp/pi-previous-target/pi-agent/packages/jorgex-pi-${PI_RUNTIME_PREVIOUS_CANDIDATE.package.version}`;
const previousRunner = `${previousRoot}/bin/jorgex-pi.mjs`;
const previousManagedProjectedPackage = { source: previousSource, skills: [], prompts: [] };
const previousEnvironment: Environment = {
  HOME: "/tmp/pi-previous-target/home",
  XDG_CONFIG_HOME: "/tmp/pi-previous-target/config",
  XDG_CACHE_HOME: "/tmp/pi-previous-target/cache",
  TMPDIR: "/tmp/pi-previous-target/tmp",
  PI_CODING_AGENT_DIR: "/tmp/pi-previous-target/pi-agent",
  ENGRAM_BIN: "/tmp/pi-previous-target/bin/engram",
};

// T05 RED: owned v1 historical receipt for jorgex-pi@0.8.24 from immutable
// Stack tag v1.9.51. Independent literal identity (never an install selector,
// never a re-pin); pi/contract scaffolding follows the immutable Pi producer
// v0.8.24 contract (runner schema1/bin jorgex-pi/maxStdout65536, commands
// status,doctor,models,sync,cleanup without upgrade; legacy mcp-adapter-v1
// without engram-official-bridge-v1/permissions-upgrade-v1), observed via the
// previous legacy candidate shape.
const HISTORICAL_PI_0_8_24_IDENTITY = {
  package: { name: "jorgex-pi", version: "0.8.24", source: "npm:jorgex-pi@0.8.24" },
  provenance: { commit: "652d7e445e6f184c4543593c115026aa2f71e761" },
  tarball: {
    bytes: 89140631,
    sha256: "6f67e546c86f21f9b5ff139f429551e696be4a8389ce4a6262e137dcce923a5f",
    sha512: "1ce4bfc316f1635c5e498af7134ae16f430a4f6a3d2c99c7aa6fc31b76ce18684759c6480f506b5de45aa5b5b682e03f68d10fc77c83ae1679006dab679d9aa4",
  },
} as const;
const HISTORICAL_CANDIDATE = {
  ...PI_RUNTIME_PREVIOUS_CANDIDATE,
  ...HISTORICAL_PI_0_8_24_IDENTITY,
} as unknown as Candidate;
const historicalSource = HISTORICAL_PI_0_8_24_IDENTITY.package.source;
const historicalRoot = "/tmp/pi-target/pi-agent/packages/jorgex-pi-0.8.24";
const historicalRunner = `${historicalRoot}/bin/jorgex-pi.mjs`;
const historicalManagedProjectedPackage = { source: historicalSource, skills: [], prompts: [] } as const;

function receiptFor(candidate: Candidate, candidateEnvironment: Environment): Receipt {
  return {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: candidate.package,
      tarball: candidate.tarball,
      provenance: candidate.provenance,
    },
    scope: { kind: "target-dir", codingAgentDir: candidateEnvironment.PI_CODING_AGENT_DIR },
    engram: { binary: candidateEnvironment.ENGRAM_BIN },
  };
}

const receipt = (): Receipt => receiptFor(PI_RUNTIME_CANDIDATE, environment);
const previousReceipt = (): Receipt => receiptFor(PI_RUNTIME_PREVIOUS_CANDIDATE, previousEnvironment);

function runnerJsonFor(candidate: Candidate, candidateRoot: string, command: "doctor" | "cleanup" | "status", result: object): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command,
    ok: true,
    package: { name: "jorgex-pi", version: candidate.package.version, root: candidateRoot },
    result,
  })}\n`;
}

function runnerJson(command: "doctor" | "cleanup" | "status", result: object): string {
  return runnerJsonFor(PI_RUNTIME_CANDIDATE, root, command, result);
}

function input(operation: "doctor" | "uninstall" | "update", overrides: Partial<{
  settingsJson: string;
  receiptJson: string | null;
  engramBin: string | null;
}> = {}) {
  return {
    operation,
    interactive: false,
    registry: { id: "pi" as const, kind: "package-managed" as const, candidate: PI_RUNTIME_CANDIDATE },
    detected: {
      executable: "/opt/pi/bin/pi",
      packageRunner: runner,
      settingsJson: overrides.settingsJson ?? JSON.stringify({ packages: [managedProjectedPackage] }),
    },
    engramBin: overrides.engramBin === undefined ? environment.ENGRAM_BIN : overrides.engramBin,
    receiptJson: overrides.receiptJson === undefined ? JSON.stringify(receipt()) : overrides.receiptJson,
    paths: { targetDir: true, codingAgentDir: environment.PI_CODING_AGENT_DIR, receiptPath: "/tmp/pi-target/state/pi-receipt.json", environment },
  };
}

function deps(
  events: string[],
  responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
  absent = true,
  expected: { runner: string; environment: Environment } = { runner, environment },
) {
  return {
    backupSettings() {
      events.push("backup-settings");
    },
    run(call: Invocation) {
      events.push(`${call.executable === expected.runner ? "runner" : "pi"}:${call.args.join(" ")}`);
      expect(call.environment).toEqual(expected.environment);
      const command = call.args[0];
      return command === undefined
        ? { exitCode: 1, stdout: "", stderr: "" }
        : responses[command] ?? { exitCode: 1, stdout: "", stderr: "" };
    },
    isPackageAbsent() {
      events.push("verify-absent");
      return absent;
    },
    deleteReceipt() {
      events.push("delete-receipt");
    },
  };
}

describe("Pi package-managed operations", () => {
  it("uses the package registry, isolated paths and allowlisted environment for a package-local JSON doctor", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const events: string[] = [];
    const result = runPiPackageManagedOperation(input("doctor"), deps(events, {
      doctor: { exitCode: 0, stdout: runnerJson("doctor", { healthy: true, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "ok" }] }), stderr: "" },
    }));

    expect(result).toEqual({ kind: "healthy" });
    expect(events).toEqual(["runner:doctor --json"]);
    expect(Object.keys(environment).sort()).toEqual(["ENGRAM_BIN", "HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
    expect(environment).not.toHaveProperty("PI_PACKAGE_DIR");
    expect(input("doctor").paths.receiptPath).not.toContain(".jorgex-stack");
  });

  it("blocks noninteractive missing Engram before a subprocess and never removes manual, foreign, or partial state", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const cases = [
      { name: "missing Engram", value: input("doctor", { engramBin: null }), expected: { kind: "blocked", reason: "engram-missing", remedy: expect.stringMatching(/engram/i) } },
      { name: "manual exact", value: input("uninstall", { receiptJson: null }), expected: { kind: "blocked", reason: "manual-existing" } },
      { name: "foreign package", value: input("uninstall", { settingsJson: JSON.stringify({ packages: ["file:../jorgex-pi"] }) }), expected: { kind: "blocked", reason: "source-divergent" } },
      { name: "partial receipt", value: input("uninstall", { receiptJson: JSON.stringify({ ...receipt(), state: "installing" }) }), expected: { kind: "blocked", reason: "partial-state" } },
      {
        name: "untrusted receipt history",
        value: input("update", {
          receiptJson: JSON.stringify({
            ...receipt(),
            candidate: {
              ...PI_RUNTIME_CANDIDATE,
              tarball: { ...PI_RUNTIME_CANDIDATE.tarball, sha256: "0".repeat(64) },
            },
          }),
        }),
        expected: { kind: "blocked", reason: "receipt-untrusted" },
      },
    ] as const;

    for (const testCase of cases) {
      const events: string[] = [];
      expect(runPiPackageManagedOperation(testCase.value, deps(events, {})), testCase.name).toMatchObject(testCase.expected);
      expect(events).toEqual([]);
    }
  });

  it("cleans up before exact removal, verifies absence before dropping its receipt, and preserves it when verification fails", async () => {
    const { runPiPackageManagedOperation } = await operations();
    // Safe legacy v1 uninstall: verifyLegacyPackage(receipt) before
    // backup/runner, re-read settings, deactivateLegacyRelease, never pi remove.
    expect(JSON.stringify(receipt())).not.toContain("managedPackage");
    const gentleEntry = { source: "npm:gentle-engram@9.9.99", skills: [], prompts: [] } as const;
    const foreignEntry = { source: "npm:foreign@1.0.0", skills: [], prompts: [] } as const;
    const ownedSettingsJson = JSON.stringify({ packages: [managedProjectedPackage, gentleEntry, foreignEntry] });
    const uninstallInput = input("uninstall", { settingsJson: ownedSettingsJson });
    function legacyUninstallDeps(events: string[], opts: { verify: boolean | "missing" }) {
      const base = deps(events, {
        cleanup: { exitCode: 0, stdout: runnerJson("cleanup", { changed: false, actions: [] }), stderr: "" },
      });
      const extended = {
        ...base,
        readSettings() {
          events.push("read-settings");
          return ownedSettingsJson;
        },
        deactivateLegacyRelease(receipt: unknown, nextSettings: string) {
          events.push("deactivate-legacy");
          const parsed = JSON.parse(nextSettings) as { packages: unknown[] };
          expect(parsed.packages).toHaveLength(2);
          expect(nextSettings).not.toContain(source);
          expect(nextSettings).toContain("npm:gentle-engram@9.9.99");
          expect(nextSettings).toContain("npm:foreign@1.0.0");
          expect(JSON.stringify(receipt)).toContain(source);
          return { kind: "uninstalled" } as const;
        },
      };
      if (opts.verify === "missing") return extended;
      return {
        ...extended,
        verifyLegacyPackage(receipt: unknown) {
          events.push("verify-legacy");
          expect(JSON.stringify(receipt)).toContain(source);
          return opts.verify;
        },
      };
    }

    const events: string[] = [];
    expect(runPiPackageManagedOperation(uninstallInput, legacyUninstallDeps(events, { verify: true }))).toEqual({ kind: "uninstalled" });
    expect(events).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
    expect(events.join(" ")).not.toContain("pi:remove");
    expect(events).not.toContain("verify-absent");
    expect(events).not.toContain("delete-receipt");

    const deniedEvents: string[] = [];
    expect(runPiPackageManagedOperation(uninstallInput, legacyUninstallDeps(deniedEvents, { verify: false }))).toEqual({
      kind: "blocked",
      reason: "receipt-untrusted",
    });
    expect(deniedEvents).toEqual(["verify-legacy"]);
    expect(deniedEvents).not.toContain("runner:cleanup --json");
    expect(deniedEvents).not.toContain("deactivate-legacy");
    expect(deniedEvents.join(" ")).not.toContain("pi:remove");

    const missingEvents: string[] = [];
    expect(runPiPackageManagedOperation(uninstallInput, legacyUninstallDeps(missingEvents, { verify: "missing" }))).toEqual({
      kind: "blocked",
      reason: "receipt-untrusted",
    });
    expect(missingEvents).toEqual([]);
    expect(missingEvents.join(" ")).not.toContain("pi:remove");

    const missingEngramEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      input("uninstall", { settingsJson: ownedSettingsJson, engramBin: null }),
      legacyUninstallDeps(missingEngramEvents, { verify: true }),
    )).toEqual({ kind: "uninstalled" });
    expect(missingEngramEvents).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
    expect(missingEngramEvents.join(" ")).not.toContain("pi:remove");

    // T07 RED: legacy helper throwing after verification/cleanup must surface
    // recovery-incomplete explicitly, not opaque remove-failed. Thrown
    // recovery:'complete' may stay remove-failed (rollback already done).
    const incompleteEvents: string[] = [];
    const incompleteFailure = Object.assign(
      new Error("external drift during uninstall, refusing to touch foreign state (recovery incomplete)"),
      { recovery: "incomplete" as const },
    );
    const incompleteDeps = {
      ...legacyUninstallDeps(incompleteEvents, { verify: true }),
      deactivateLegacyRelease() {
        incompleteEvents.push("deactivate-legacy");
        throw incompleteFailure;
      },
    };
    const incompleteResult = runPiPackageManagedOperation(uninstallInput, incompleteDeps);
    expect(incompleteResult).toMatchObject({ kind: "blocked" });
    expect((incompleteResult as { reason?: unknown }).reason).toMatch(/recovery-incomplete/i);
    expect((incompleteResult as { reason?: unknown }).reason).not.toBe("remove-failed");
    expect(String((incompleteResult as { remedy?: unknown }).remedy ?? "")).toMatch(/backup|marker|lock/i);
    expect(incompleteEvents).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
    expect(incompleteEvents.join(" ")).not.toContain("pi:remove");

    const completeEvents: string[] = [];
    const completeFailure = Object.assign(new Error("verify failed after removal, rolled back"), {
      recovery: "complete" as const,
    });
    const completeDeps = {
      ...legacyUninstallDeps(completeEvents, { verify: true }),
      deactivateLegacyRelease() {
        completeEvents.push("deactivate-legacy");
        throw completeFailure;
      },
    };
    expect(runPiPackageManagedOperation(uninstallInput, completeDeps)).toMatchObject({
      kind: "blocked",
      reason: "remove-failed",
    });
    expect(completeEvents).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
  });

  it("treats a receiptless retry after removal as idempotent without touching cleanup state", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const events: string[] = [];

    expect(runPiPackageManagedOperation(input("uninstall", {
      receiptJson: null,
      settingsJson: JSON.stringify({ packages: [] }),
    }), deps(events, {}))).toEqual({ kind: "uninstalled" });
    expect(events).toEqual(["verify-absent"]);
  });

  it("keeps same-candidate update idempotent and blocks cross-version mutation until a verified tgz rollback path exists", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const sameEvents: string[] = [];
    expect(runPiPackageManagedOperation(input("update"), deps(sameEvents, {}))).toEqual({ kind: "healthy" });
    expect(sameEvents).toEqual([]);

    const events: string[] = [];
    const result = runPiPackageManagedOperation({
      ...input("update"),
      registry: {
        id: "pi",
        kind: "package-managed",
        candidate: PI_RUNTIME_PREVIOUS_CANDIDATE,
        acceptedCandidates: [PI_RUNTIME_CANDIDATE, PI_RUNTIME_PREVIOUS_CANDIDATE],
      },
    }, deps(events, {}));

    expect(result).toEqual({
      kind: "blocked",
      reason: "verified-update-required",
      remedy: expect.stringMatching(/verified|tgz|tarball/i),
    });
    expect(events).toEqual([]);
  });

  it("rejects the previous pin in the new Stack context while keeping rollback on the previous Stack context explicit", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const previousPackageSettings = JSON.stringify({ packages: [previousManagedProjectedPackage] });
    const previousReceiptInCurrentScope = JSON.stringify(receiptFor(PI_RUNTIME_PREVIOUS_CANDIDATE, environment));
    const newContext = input("update", {
      settingsJson: previousPackageSettings,
      receiptJson: previousReceiptInCurrentScope,
    });
    const adoptionEvents: string[] = [];

    expect(runPiPackageManagedOperation(newContext, deps(adoptionEvents, {}))).toEqual({
      kind: "blocked",
      reason: "receipt-untrusted",
    });
    expect(adoptionEvents).toEqual([]);
    expect(newContext.receiptJson).toBe(previousReceiptInCurrentScope);
    expect(newContext.detected.settingsJson).toBe(previousPackageSettings);

    // Safe legacy v1 rollback: verifyLegacyPackage(receipt) before
    // backup/runner, re-read settings, deactivateLegacyRelease, never pi remove.
    const rollbackGentle = { source: "npm:gentle-engram@9.9.99", skills: [], prompts: [] } as const;
    const rollbackForeign = { source: "npm:foreign@1.0.0", skills: [], prompts: [] } as const;
    const rollbackSettingsJson = JSON.stringify({
      packages: [previousManagedProjectedPackage, rollbackGentle, rollbackForeign],
    });
    const rollbackReceipt = JSON.stringify(previousReceipt());
    expect(rollbackReceipt).not.toContain("managedPackage");
    function rollbackDeps(events: string[], opts: { verify: boolean | "missing" }) {
      const base = deps(events, {
        cleanup: {
          exitCode: 0,
          stdout: runnerJsonFor(PI_RUNTIME_PREVIOUS_CANDIDATE, previousRoot, "cleanup", { changed: false, actions: [] }),
          stderr: "",
        },
      }, true, { runner: previousRunner, environment: previousEnvironment });
      const extended = {
        ...base,
        readSettings() {
          events.push("read-settings");
          return rollbackSettingsJson;
        },
        deactivateLegacyRelease(receipt: unknown, nextSettings: string) {
          events.push("deactivate-legacy");
          const parsed = JSON.parse(nextSettings) as { packages: unknown[] };
          expect(parsed.packages).toHaveLength(2);
          expect(nextSettings).not.toContain(previousSource);
          expect(nextSettings).toContain("npm:gentle-engram@9.9.99");
          expect(nextSettings).toContain("npm:foreign@1.0.0");
          expect(JSON.stringify(receipt)).toContain(previousSource);
          return { kind: "uninstalled" } as const;
        },
      };
      if (opts.verify === "missing") return extended;
      return {
        ...extended,
        verifyLegacyPackage(receipt: unknown) {
          events.push("verify-legacy");
          expect(JSON.stringify(receipt)).toContain(previousSource);
          return opts.verify;
        },
      };
    }
    const rollbackEvents: string[] = [];
    const rollback = runPiPackageManagedOperation({
      operation: "uninstall",
      interactive: false,
      registry: {
        id: "pi",
        kind: "package-managed",
        candidate: PI_RUNTIME_PREVIOUS_CANDIDATE,
      },
      detected: {
        executable: "/opt/pi/bin/pi",
        packageRunner: previousRunner,
        settingsJson: rollbackSettingsJson,
      },
      engramBin: previousEnvironment.ENGRAM_BIN,
      receiptJson: rollbackReceipt,
      paths: {
        targetDir: true,
        codingAgentDir: previousEnvironment.PI_CODING_AGENT_DIR,
        receiptPath: "/tmp/pi-previous-target/state/pi-receipt.json",
        environment: previousEnvironment,
      },
    }, rollbackDeps(rollbackEvents, { verify: true }));

    expect(rollback).toEqual({ kind: "uninstalled" });
    expect(rollbackEvents).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
    expect(rollbackEvents.join(" ")).not.toContain("pi:remove");
    expect(rollbackEvents).not.toContain("verify-absent");
    expect(rollbackEvents).not.toContain("delete-receipt");

    const rollbackDeniedEvents: string[] = [];
    expect(runPiPackageManagedOperation({
      operation: "uninstall",
      interactive: false,
      registry: {
        id: "pi",
        kind: "package-managed",
        candidate: PI_RUNTIME_PREVIOUS_CANDIDATE,
      },
      detected: {
        executable: "/opt/pi/bin/pi",
        packageRunner: previousRunner,
        settingsJson: rollbackSettingsJson,
      },
      engramBin: previousEnvironment.ENGRAM_BIN,
      receiptJson: rollbackReceipt,
      paths: {
        targetDir: true,
        codingAgentDir: previousEnvironment.PI_CODING_AGENT_DIR,
        receiptPath: "/tmp/pi-previous-target/state/pi-receipt.json",
        environment: previousEnvironment,
      },
    }, rollbackDeps(rollbackDeniedEvents, { verify: false }))).toEqual({
      kind: "blocked",
      reason: "receipt-untrusted",
    });
    expect(rollbackDeniedEvents).toEqual(["verify-legacy"]);
    expect(rollbackDeniedEvents).not.toContain("runner:cleanup --json");
    expect(rollbackDeniedEvents).not.toContain("deactivate-legacy");
    expect(rollbackDeniedEvents.join(" ")).not.toContain("pi:remove");
  });

  it.each([
    ["complete projected filters", [managedProjectedPackage], { kind: "healthy" }, ["runner:doctor --json"]],
    ["canonical string after projection", [source], { kind: "blocked", reason: "source-divergent" }, []],
    ["partial filters without prompts", [{ source, skills: [] }], { kind: "blocked", reason: "source-divergent" }, []],
    ["partial filters without skills", [{ source, prompts: [] }], { kind: "blocked", reason: "source-divergent" }, []],
    ["non-empty packaged skills", [{ source, skills: ["tdd"], prompts: [] }], { kind: "blocked", reason: "source-divergent" }, []],
    ["duplicate projected filters", [managedProjectedPackage, managedProjectedPackage], { kind: "blocked", reason: "duplicate-package" }, []],
  ])("allows receipt-owned doctor only for the %s registration", async (_name, packages, expected, expectedEvents) => {
    const { runPiPackageManagedOperation } = await operations();
    const events: string[] = [];
    const result = runPiPackageManagedOperation(input("doctor", {
      settingsJson: JSON.stringify({ packages }),
    }), deps(events, {
      doctor: { exitCode: 0, stdout: runnerJson("doctor", { healthy: true }), stderr: "" },
    }));

    expect(result).toMatchObject(expected);
    expect(events).toEqual(expectedEvents);
  });

  it("blocks a receipt without an Engram binding before running doctor", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const events: string[] = [];
    const { engram: _engram, ...legacyReceipt } = receipt();
    const result = runPiPackageManagedOperation(input("doctor", {
      receiptJson: JSON.stringify(legacyReceipt),
    }), deps(events, {
      doctor: { exitCode: 0, stdout: runnerJson("doctor", { healthy: true }), stderr: "" },
    }));

    expect(result).toEqual({
      kind: "blocked",
      reason: "receipt-upgrade-required",
      remedy: expect.stringMatching(/previous|anterior|reinstall/i),
    });
    expect(events).toEqual([]);
  });

  it("accepts the owned v1 historical receipt via the old runner without re-pinning the next install", async () => {
    const { runPiPackageManagedOperation } = await operations();
    const historicalReceiptJson = JSON.stringify(receiptFor(HISTORICAL_CANDIDATE, environment));
    const historicalSettingsJson = JSON.stringify({ packages: [historicalManagedProjectedPackage] });
    const historicalInput = {
      operation: "doctor" as const,
      interactive: false,
      registry: {
        id: "pi" as const,
        kind: "package-managed" as const,
        candidate: PI_RUNTIME_CANDIDATE,
        acceptedCandidates: [PI_RUNTIME_CANDIDATE, HISTORICAL_CANDIDATE] as readonly Candidate[],
      },
      detected: {
        executable: "/opt/pi/bin/pi",
        packageRunner: historicalRunner,
        settingsJson: historicalSettingsJson,
      },
      engramBin: environment.ENGRAM_BIN,
      receiptJson: historicalReceiptJson,
      paths: {
        targetDir: true,
        codingAgentDir: environment.PI_CODING_AGENT_DIR,
        receiptPath: "/tmp/pi-target/state/pi-receipt.json",
        environment,
      },
    };
    const historicalExpected = { runner: historicalRunner, environment };

    const events: string[] = [];
    const result = runPiPackageManagedOperation(historicalInput, deps(events, {
      doctor: {
        exitCode: 0,
        stdout: runnerJsonFor(HISTORICAL_CANDIDATE, historicalRoot, "doctor", { healthy: true }),
        stderr: "",
      },
    }, true, historicalExpected));

    expect(result).toEqual({ kind: "healthy" });
    expect(events).toEqual(["runner:doctor --json"]);

    const historicalReceipt = receiptFor(HISTORICAL_CANDIDATE, environment);
    const tamperedReceiptJson = JSON.stringify({
      ...historicalReceipt,
      candidate: {
        ...HISTORICAL_PI_0_8_24_IDENTITY,
        tarball: { ...HISTORICAL_PI_0_8_24_IDENTITY.tarball, sha256: "0".repeat(64) },
      },
    });
    const tamperedEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      { ...historicalInput, receiptJson: tamperedReceiptJson },
      deps(tamperedEvents, {}, true, historicalExpected),
    )).toEqual({ kind: "blocked", reason: "receipt-untrusted" });
    expect(tamperedEvents).toEqual([]);

    const foreignEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      {
        ...historicalInput,
        detected: {
          ...historicalInput.detected,
          settingsJson: JSON.stringify({ packages: [historicalSource] }),
        },
      },
      deps(foreignEvents, {}, true, historicalExpected),
    )).toEqual({ kind: "blocked", reason: "source-divergent" });
    expect(foreignEvents).toEqual([]);
  });

  it("uninstalls the owned legacy 0.8.24 receipt offline without migrating or invoking pi remove", async () => {
    const { runPiPackageManagedOperation } = await operations();
    // Controls: legacy v1 receipt carries no managedPackage; old runner offers no upgrade.
    expect(HISTORICAL_CANDIDATE.contract.runner.commands).not.toContain("upgrade");
    const legacyReceiptJson = JSON.stringify(receiptFor(HISTORICAL_CANDIDATE, environment));
    expect(legacyReceiptJson).not.toContain("managedPackage");

    const gentleEntry = { source: "npm:gentle-engram@9.9.99", skills: [], prompts: [] } as const;
    const foreignEntry = { source: "npm:foreign@1.0.0", skills: [], prompts: [] } as const;
    const legacySettingsJson = JSON.stringify({
      packages: [historicalManagedProjectedPackage, gentleEntry, foreignEntry],
    });
    const legacyUninstallInput = {
      operation: "uninstall" as const,
      interactive: false,
      registry: {
        id: "pi" as const,
        kind: "package-managed" as const,
        candidate: PI_RUNTIME_CANDIDATE,
        acceptedCandidates: [PI_RUNTIME_CANDIDATE, HISTORICAL_CANDIDATE] as readonly Candidate[],
      },
      detected: {
        executable: "/opt/pi/bin/pi",
        packageRunner: historicalRunner,
        settingsJson: legacySettingsJson,
      },
      engramBin: environment.ENGRAM_BIN,
      receiptJson: legacyReceiptJson,
      paths: {
        targetDir: true,
        codingAgentDir: environment.PI_CODING_AGENT_DIR,
        receiptPath: "/tmp/pi-target/state/pi-receipt.json",
        environment,
      },
    };
    const legacyExpected = { runner: historicalRunner, environment };

    function legacyDeps(events: string[], opts: { verify: boolean | "missing"; settingsJson?: string }) {
      const base = deps(events, {
        cleanup: {
          exitCode: 0,
          stdout: runnerJsonFor(HISTORICAL_CANDIDATE, historicalRoot, "cleanup", { changed: false, actions: [] }),
          stderr: "",
        },
      }, true, legacyExpected);
      const extended = {
        ...base,
        readSettings() {
          events.push("read-settings");
          return opts.settingsJson ?? legacySettingsJson;
        },
        deactivateLegacyRelease(receipt: unknown, nextSettings: string) {
          events.push("deactivate-legacy");
          const parsed = JSON.parse(nextSettings) as { packages: unknown[] };
          expect(parsed.packages).toHaveLength(2);
          expect(nextSettings).not.toContain(historicalSource);
          expect(nextSettings).toContain("npm:gentle-engram@9.9.99");
          expect(nextSettings).toContain("npm:foreign@1.0.0");
          expect(JSON.stringify(receipt)).toContain("0.8.24");
          return { kind: "uninstalled" } as const;
        },
      };
      if (opts.verify === "missing") return extended;
      return {
        ...extended,
        verifyLegacyPackage(receipt: unknown) {
          events.push("verify-legacy");
          expect(JSON.stringify(receipt)).toContain("0.8.24");
          return opts.verify;
        },
      };
    }

    const events: string[] = [];
    const result = runPiPackageManagedOperation(
      legacyUninstallInput,
      legacyDeps(events, { verify: true }),
    );
    expect(result).toEqual({ kind: "uninstalled" });
    expect(events).toEqual([
      "verify-legacy",
      "backup-settings",
      "runner:cleanup --json",
      "read-settings",
      "deactivate-legacy",
    ]);
    expect(events.join(" ")).not.toContain("pi:remove");

    const legacyReceipt = receiptFor(HISTORICAL_CANDIDATE, environment);
    const tamperedReceiptJson = JSON.stringify({
      ...legacyReceipt,
      candidate: {
        ...HISTORICAL_PI_0_8_24_IDENTITY,
        tarball: { ...HISTORICAL_PI_0_8_24_IDENTITY.tarball, sha256: "0".repeat(64) },
      },
    });
    const tamperedEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      { ...legacyUninstallInput, receiptJson: tamperedReceiptJson },
      legacyDeps(tamperedEvents, { verify: true }),
    )).toEqual({ kind: "blocked", reason: "receipt-untrusted" });
    expect(tamperedEvents).not.toContain("runner:cleanup --json");
    expect(tamperedEvents).not.toContain("deactivate-legacy");
    expect(tamperedEvents.join(" ")).not.toContain("pi:remove");

    const manualEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      {
        ...legacyUninstallInput,
        detected: {
          ...legacyUninstallInput.detected,
          settingsJson: JSON.stringify({ packages: [historicalSource] }),
        },
      },
      legacyDeps(manualEvents, { verify: true }),
    )).toEqual({ kind: "blocked", reason: "source-divergent" });
    expect(manualEvents).not.toContain("runner:cleanup --json");
    expect(manualEvents).not.toContain("deactivate-legacy");
    expect(manualEvents.join(" ")).not.toContain("pi:remove");

    const deniedEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      legacyUninstallInput,
      legacyDeps(deniedEvents, { verify: false }),
    )).toMatchObject({ kind: "blocked" });
    expect(deniedEvents).not.toContain("runner:cleanup --json");
    expect(deniedEvents).not.toContain("deactivate-legacy");
    expect(deniedEvents.join(" ")).not.toContain("pi:remove");

    const missingEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      legacyUninstallInput,
      legacyDeps(missingEvents, { verify: "missing" }),
    )).toMatchObject({ kind: "blocked" });
    expect(missingEvents).not.toContain("runner:cleanup --json");
    expect(missingEvents).not.toContain("deactivate-legacy");
    expect(missingEvents.join(" ")).not.toContain("pi:remove");
  });

  it("productive registry retains the historical 0.8.24 recovery anchor without re-pinning the next install", async () => {
    const prod = await import("../src/lib/pi-runtime.js") as {
      PI_RUNTIME_CANDIDATE: { package: { version: string; source: string } };
      PI_RUNTIME_REGISTRY: {
        pi: {
          source: string;
          candidate: { package: { version: string; source: string } };
          acceptedCandidates: readonly {
            package: unknown;
            tarball: unknown;
            provenance: unknown;
            contract?: {
              runner?: {
                schemaVersion?: unknown;
                bin?: unknown;
                commands?: unknown;
                maxStdoutBytes?: unknown;
              };
            };
          }[];
        };
      };
    };

    // Recovery evidence, NOT next release pin: the productive selector stays current.
    expect(prod.PI_RUNTIME_CANDIDATE.package.version).not.toBe(HISTORICAL_PI_0_8_24_IDENTITY.package.version);
    expect(prod.PI_RUNTIME_REGISTRY.pi.candidate.package.version).not.toBe(
      HISTORICAL_PI_0_8_24_IDENTITY.package.version,
    );
    expect(prod.PI_RUNTIME_REGISTRY.pi.source).not.toBe(historicalSource);
    expect(prod.PI_RUNTIME_REGISTRY.pi.source).toBe(prod.PI_RUNTIME_CANDIDATE.package.source);

    const match = prod.PI_RUNTIME_REGISTRY.pi.acceptedCandidates.find(
      (entry) =>
        JSON.stringify(entry.package) === JSON.stringify(HISTORICAL_PI_0_8_24_IDENTITY.package) &&
        JSON.stringify(entry.tarball) === JSON.stringify(HISTORICAL_PI_0_8_24_IDENTITY.tarball) &&
        JSON.stringify(entry.provenance) === JSON.stringify(HISTORICAL_PI_0_8_24_IDENTITY.provenance),
    );
    expect(match).toBeDefined();

    const runner = match?.contract?.runner;
    expect(runner?.schemaVersion).toBe(1);
    expect(runner?.bin).toBe("jorgex-pi");
    expect(runner?.maxStdoutBytes).toBe(65_536);
    expect(runner?.commands).toEqual(["status", "doctor", "models", "sync", "cleanup"]);
    expect(runner?.commands).not.toContain("upgrade");
  });
});
