import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

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
        candidate: typeof PI_RUNTIME_CANDIDATE;
        acceptedCandidates?: readonly (typeof PI_RUNTIME_CANDIDATE)[];
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

const receipt = (): Receipt => ({ schemaVersion: 1, state: "installed", candidate: {
  package: PI_RUNTIME_CANDIDATE.package,
  tarball: PI_RUNTIME_CANDIDATE.tarball,
  provenance: PI_RUNTIME_CANDIDATE.provenance,
}, scope: { kind: "target-dir", codingAgentDir: environment.PI_CODING_AGENT_DIR }, engram: { binary: environment.ENGRAM_BIN } });

function runnerJson(command: "doctor" | "cleanup" | "status", result: object): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command,
    ok: true,
    package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root },
    result,
  })}\n`;
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

function deps(events: string[], responses: Record<string, { exitCode: number; stdout: string; stderr: string }>, absent = true) {
  return {
    backupSettings() {
      events.push("backup-settings");
    },
    run(call: Invocation) {
      events.push(`${call.executable === runner ? "runner" : "pi"}:${call.args.join(" ")}`);
      expect(call.environment).toEqual(environment);
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

    const next = {
      ...PI_RUNTIME_CANDIDATE,
      package: { ...PI_RUNTIME_CANDIDATE.package, version: "0.2.3", source: "npm:jorgex-pi@0.2.3" },
    } as unknown as typeof PI_RUNTIME_CANDIDATE;
    const events: string[] = [];
    const result = runPiPackageManagedOperation({
      ...input("update"),
      registry: { id: "pi", kind: "package-managed", candidate: next, acceptedCandidates: [PI_RUNTIME_CANDIDATE, next] },
    }, deps(events, {}));

    expect(result).toEqual({
      kind: "blocked",
      reason: "verified-update-required",
      remedy: expect.stringMatching(/verified|tgz|tarball/i),
    });
    expect(events).toEqual([]);
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
