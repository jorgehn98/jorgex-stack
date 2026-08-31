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
    const cleanup = { exitCode: 0, stdout: runnerJson("cleanup", { changed: false, actions: [] }), stderr: "" };
    const remove = { exitCode: 0, stdout: "", stderr: "" };

    const events: string[] = [];
    expect(runPiPackageManagedOperation(input("uninstall"), deps(events, { cleanup, remove }))).toEqual({ kind: "uninstalled" });
    expect(events).toEqual([
      "runner:cleanup --json",
      "backup-settings",
      `pi:remove ${source} --no-approve`,
      "verify-absent",
      "delete-receipt",
    ]);

    const failedEvents: string[] = [];
    expect(runPiPackageManagedOperation(input("uninstall"), deps(failedEvents, { cleanup, remove }, false))).toEqual({
      kind: "blocked",
      reason: "absence-unverified",
    });
    expect(failedEvents).not.toContain("delete-receipt");

    const missingEngramEvents: string[] = [];
    expect(runPiPackageManagedOperation(
      input("uninstall", { engramBin: null }),
      deps(missingEngramEvents, { cleanup, remove }),
    )).toEqual({ kind: "uninstalled" });
    expect(missingEngramEvents).toEqual([
      "runner:cleanup --json",
      "backup-settings",
      `pi:remove ${source} --no-approve`,
      "verify-absent",
      "delete-receipt",
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

    const rollbackReceipt = JSON.stringify(previousReceipt());
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
        settingsJson: previousPackageSettings,
      },
      engramBin: previousEnvironment.ENGRAM_BIN,
      receiptJson: rollbackReceipt,
      paths: {
        targetDir: true,
        codingAgentDir: previousEnvironment.PI_CODING_AGENT_DIR,
        receiptPath: "/tmp/pi-previous-target/state/pi-receipt.json",
        environment: previousEnvironment,
      },
    }, deps(rollbackEvents, {
      cleanup: {
        exitCode: 0,
        stdout: runnerJsonFor(PI_RUNTIME_PREVIOUS_CANDIDATE, previousRoot, "cleanup", { changed: false, actions: [] }),
        stderr: "",
      },
      remove: { exitCode: 0, stdout: "", stderr: "" },
    }, true, { runner: previousRunner, environment: previousEnvironment }));

    expect(rollback).toEqual({ kind: "uninstalled" });
    expect(rollbackEvents).toEqual([
      "runner:cleanup --json",
      "backup-settings",
      `pi:remove ${previousSource} --no-approve`,
      "verify-absent",
      "delete-receipt",
    ]);
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
});
