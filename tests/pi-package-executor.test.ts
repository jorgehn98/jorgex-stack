import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

type PiPackageEnvironment = {
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN: string;
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  TMPDIR?: string;
};

type Receipt = {
  schemaVersion: 1;
  state: "installing" | "installed";
  candidate: {
    package: typeof PI_RUNTIME_CANDIDATE.package;
    tarball: typeof PI_RUNTIME_CANDIDATE.tarball;
    provenance: typeof PI_RUNTIME_CANDIDATE.provenance;
  };
  scope: { kind: "target-dir"; codingAgentDir: string };
  engram: { binary: string };
};

type Plan = {
  kind: "install" | "manual-existing" | "ready";
  receipt?: Receipt;
  invocation?: { executable: string; args: string[]; environment: PiPackageEnvironment };
};

type ExecutorResult =
  | { kind: "installed"; receipt: Receipt }
  | { kind: "synced"; actions: [] }
  | { kind: "models"; models: { mode: "inherit-session"; tiers: ["strong", "standard", "cheap"] } }
  | { kind: "manual-existing" }
  | { kind: "blocked"; reason: "pi-install-failed" | "runner-output" | "runner-unhealthy" };

type PiPackageExecutor = {
  executePiPackageLifecycle(
    input: {
      operation: "install" | "sync" | "models";
      plan: Plan;
      candidate: typeof PI_RUNTIME_CANDIDATE;
      packageRunner: string;
      environment: PiPackageEnvironment;
    },
    deps: {
      writeReceipt(receipt: Receipt): void;
      run(invocation: { executable: string; args: string[]; environment: PiPackageEnvironment }): {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
    },
  ): ExecutorResult;
};

async function executor(): Promise<PiPackageExecutor> {
  const mod = await import("../src/lib/pi-package-lifecycle.js") as Partial<PiPackageExecutor>;
  expect(mod.executePiPackageLifecycle).toBeTypeOf("function");
  return mod as PiPackageExecutor;
}

const environment: PiPackageEnvironment = {
  HOME: "/tmp/target/home",
  XDG_CONFIG_HOME: "/tmp/target/config",
  XDG_CACHE_HOME: "/tmp/target/cache",
  TMPDIR: "/tmp/target/tmp",
  PI_CODING_AGENT_DIR: "/tmp/target/pi-agent",
  ENGRAM_BIN: "/tmp/target/bin/engram",
};
const packageRunner = "/tmp/target/pi-agent/packages/jorgex-pi-0.1.0/bin/jorgex-pi.mjs";

function receipt(state: Receipt["state"]): Receipt {
  return {
    schemaVersion: 1,
    state,
    candidate: {
      package: PI_RUNTIME_CANDIDATE.package,
      tarball: PI_RUNTIME_CANDIDATE.tarball,
      provenance: PI_RUNTIME_CANDIDATE.provenance,
    },
    scope: { kind: "target-dir", codingAgentDir: environment.PI_CODING_AGENT_DIR },
    engram: { binary: environment.ENGRAM_BIN },
  };
}

function runnerResponse(command: "doctor" | "sync" | "models"): string {
  const result = command === "doctor"
    ? { healthy: true, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "ok" }] }
    : command === "sync"
      ? { changed: false, actions: [] }
      : { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] };
  return JSON.stringify({
    schemaVersion: 1,
    command,
    ok: true,
    package: { name: "jorgex-pi", version: "0.1.0", root: "/tmp/target/pi-agent/packages/jorgex-pi-0.1.0" },
    result,
  });
}

function installPlan(): Plan {
  return {
    kind: "install",
    invocation: {
      executable: "/opt/pi/bin/pi",
      args: ["install", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
      environment,
    },
    receipt: receipt("installing"),
  };
}

describe("Pi package executor", () => {
  it("journals before Pi mutates, verifies through the package-local runner, and promotes ownership only after doctor succeeds", async () => {
    const { executePiPackageLifecycle } = await executor();
    const events: string[] = [];
    const invocations: { executable: string; args: string[]; environment: PiPackageEnvironment }[] = [];

    const result = executePiPackageLifecycle({
      operation: "install",
      plan: installPlan(),
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner,
      environment,
    }, {
      writeReceipt(next) {
        events.push(`receipt:${next.state}`);
      },
      run(invocation) {
        invocations.push(invocation);
        events.push(`run:${invocation.args[0]}`);
        return invocation.args[0] === "install"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `${runnerResponse("doctor")}\n`, stderr: "" };
      },
    });

    expect(result).toEqual({ kind: "installed", receipt: receipt("installed") });
    expect(events).toEqual(["receipt:installing", "run:install", "run:doctor", "receipt:installed"]);
    expect(invocations).toEqual([
      { executable: "/opt/pi/bin/pi", args: ["install", "npm:jorgex-pi@0.1.0", "--no-approve"], environment },
      { executable: packageRunner, args: ["doctor", "--json"], environment },
    ]);
    expect(invocations.every((invocation) => invocation.environment.PI_CODING_AGENT_DIR === "/tmp/target/pi-agent")).toBe(true);
    expect(invocations.every((invocation) => invocation.environment.ENGRAM_BIN === "/tmp/target/bin/engram")).toBe(true);
  });

  it("does not promote the receipt when the runner is not a single valid JSON response, and never mutates a manual install", async () => {
    const { executePiPackageLifecycle } = await executor();
    const receiptWrites: Receipt[] = [];
    const invalid = executePiPackageLifecycle({
      operation: "install",
      plan: installPlan(),
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner,
      environment,
    }, {
      writeReceipt(next) {
        receiptWrites.push(next);
      },
      run(invocation) {
        return invocation.args[0] === "install"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `${runnerResponse("doctor")}\n${runnerResponse("doctor")}\n`, stderr: "unexpected" };
      },
    });
    expect(invalid).toEqual({ kind: "blocked", reason: "runner-output" });
    expect(receiptWrites).toEqual([receipt("installing")]);

    const manualCalls: string[] = [];
    const manual = executePiPackageLifecycle({
      operation: "install",
      plan: { kind: "manual-existing" },
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner,
      environment,
    }, {
      writeReceipt: () => manualCalls.push("receipt"),
      run: () => {
        manualCalls.push("run");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(manual).toEqual({ kind: "manual-existing" });
    expect(manualCalls).toEqual([]);
  });

  it("runs sync and models only through the package-local runner, without Pi install, receipt changes, or model-map input", async () => {
    const { executePiPackageLifecycle } = await executor();
    const calls: { executable: string; args: string[]; environment: PiPackageEnvironment }[] = [];
    const receiptWrites: Receipt[] = [];
    const deps = {
      writeReceipt(next: Receipt) {
        receiptWrites.push(next);
      },
      run(invocation: { executable: string; args: string[]; environment: PiPackageEnvironment }) {
        calls.push(invocation);
        const command = invocation.args[0] as "sync" | "models";
        return { exitCode: 0, stdout: `${runnerResponse(command)}\n`, stderr: "" };
      },
    };
    const input = {
      plan: { kind: "ready" as const },
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner,
      environment,
    };

    expect(executePiPackageLifecycle({ ...input, operation: "sync" }, deps)).toEqual({ kind: "synced", actions: [] });
    expect(executePiPackageLifecycle({ ...input, operation: "models" }, deps)).toEqual({
      kind: "models",
      models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] },
    });
    expect(calls).toEqual([
      { executable: packageRunner, args: ["sync", "--json"], environment },
      { executable: packageRunner, args: ["models", "--json"], environment },
    ]);
    expect(receiptWrites).toEqual([]);
  });
});
