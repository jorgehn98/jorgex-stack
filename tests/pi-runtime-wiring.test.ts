import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/install.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { readManifest } from "../src/lib/manifest.js";
import { parseCliArgs } from "../src/cli.js";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

type Environment = Record<string, string> & {
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN: string;
};
type Operation = "install" | "sync" | "models" | "doctor" | "uninstall" | "update";
type RuntimeResult = { kind: string; receipt?: unknown };

type PiRuntimeModule = {
  PI_RUNTIME_REGISTRY: {
    pi: {
      id: "pi";
      kind: "package-managed";
      source: typeof PI_RUNTIME_CANDIDATE.package.source;
      tarball: { sha256: string; sha512: string; bytes: number };
      pi: { testedVersions: readonly string[] };
    };
  };
  runPiRuntime(
    input: {
      operation: Operation;
      targetDir?: string;
      detected: { executable: string; version: string };
      engramBin: string | null;
    },
    deps: {
      readSettings(path: string): string;
      readReceipt(path: string): string | null;
      writeReceiptAtomic(path: string, content: string): void;
      prepare(input: unknown): unknown;
      execute(input: unknown): RuntimeResult;
      operate(input: unknown): RuntimeResult;
    },
  ): RuntimeResult;
};

async function runtime(): Promise<PiRuntimeModule> {
  const mod = await import("../src/lib/pi-runtime.js") as Partial<PiRuntimeModule>;
  expect(mod.PI_RUNTIME_REGISTRY).toBeDefined();
  expect(mod.runPiRuntime).toBeTypeOf("function");
  return mod as PiRuntimeModule;
}

const target = path.resolve("/tmp/jorgex-pi-target");
const codingAgentDir = path.join(target, "pi-agent");
const receiptPath = path.join(target, "state", "pi-receipt.json");
const runner = path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
const environment: Environment = {
  HOME: path.join(target, "home"),
  XDG_CONFIG_HOME: path.join(target, "config"),
  XDG_CACHE_HOME: path.join(target, "cache"),
  TMPDIR: path.join(target, "tmp"),
  PI_CODING_AGENT_DIR: codingAgentDir,
  ENGRAM_BIN: path.join(target, "bin", "engram"),
};
const installedReceipt = JSON.stringify({
  schemaVersion: 1,
  state: "installed",
  candidate: {
    package: PI_RUNTIME_CANDIDATE.package,
    tarball: PI_RUNTIME_CANDIDATE.tarball,
    provenance: PI_RUNTIME_CANDIDATE.provenance,
  },
  scope: { kind: "target-dir", codingAgentDir },
  engram: { binary: environment.ENGRAM_BIN },
});
const MANAGED_PACKAGE_REGISTRATION = {
  source: PI_RUNTIME_CANDIDATE.package.source,
  skills: [],
  prompts: [],
} as const;
const { prompts: _prompts, ...PARTIAL_MANAGED_PACKAGE_REGISTRATION } = MANAGED_PACKAGE_REGISTRATION;

function harness(events: string[]) {
  return {
    readSettings(path: string) {
      events.push(`settings:${path}`);
      return JSON.stringify({ packages: [MANAGED_PACKAGE_REGISTRATION] });
    },
    readReceipt(path: string) {
      events.push(`receipt:${path}`);
      return installedReceipt;
    },
    writeReceiptAtomic(path: string, content: string) {
      events.push(`atomic:${path}:${JSON.parse(content).state}`);
    },
    prepare(input: unknown) {
      events.push(`prepare:${JSON.stringify(input)}`);
      return { kind: "ready" };
    },
    execute(input: unknown): RuntimeResult {
      events.push(`execute:${JSON.stringify(input)}`);
      const operation = (input as { operation: Operation }).operation;
      if (operation === "sync") return { kind: "synced" };
      if (operation === "models") return { kind: "models" };
      return { kind: "installed", receipt: { state: "installed", version: PI_RUNTIME_CANDIDATE.package.version } };
    },
    operate(input: unknown): RuntimeResult {
      events.push(`operate:${JSON.stringify(input)}`);
      return { kind: "healthy" };
    },
  };
}

describe("Pi runtime wiring", () => {
  it("registers Pi as a production package runtime, accepts the CLI selector, and leaves adapters, components, manifests, and model maps Pi-free", async () => {
    const { PI_RUNTIME_REGISTRY } = await runtime();
    expect(PI_RUNTIME_REGISTRY.pi).toMatchObject({
      id: "pi",
      kind: "package-managed",
      source: PI_RUNTIME_CANDIDATE.package.source,
      tarball: PI_RUNTIME_CANDIDATE.tarball,
      pi: PI_RUNTIME_CANDIDATE.pi,
    });
    expect(parseCliArgs(["install", "--agents", "pi,codex"]).flags.agents).toEqual(["pi", "codex"]);
    expect(ADAPTERS).not.toHaveProperty("pi");
    expect(DEFAULT_MODEL_MAP).not.toHaveProperty("pi");
    expect(readManifest(path.join(target, "sentinel-manifest.json")).runtimes).not.toHaveProperty("pi");
  });

  it("builds only target-dir paths and environment, journals atomically, and routes install/sync/models/doctor/uninstall through the injected package lifecycle", async () => {
    const { runPiRuntime, PI_RUNTIME_REGISTRY } = await runtime();
    const events: string[] = [];
    const deps = harness(events);
    const common = {
      targetDir: target,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: environment.ENGRAM_BIN,
      verifiedArtifact: PI_RUNTIME_REGISTRY.pi.tarball,
    };

    expect(runPiRuntime({ ...common, operation: "install" }, deps)).toMatchObject({ kind: "installed" });
    expect(runPiRuntime({ ...common, operation: "sync" }, deps)).toMatchObject({ kind: "synced" });
    expect(runPiRuntime({ ...common, operation: "models" }, deps)).toMatchObject({ kind: "models" });
    for (const operation of ["doctor", "uninstall"] as const) {
      expect(runPiRuntime({ ...common, operation }, deps)).toMatchObject({ kind: "healthy" });
    }

    const trace = events.join("\n");
    expect(trace).toContain(`settings:${path.join(codingAgentDir, "settings.json")}`);
    expect(trace).toContain(`receipt:${receiptPath}`);
    expect(trace).toContain(`atomic:${receiptPath}:installed`);
    expect(trace).toContain(JSON.stringify(runner).slice(1, -1));
    expect(trace).toContain(PI_RUNTIME_CANDIDATE.package.source);
    expect(trace).toContain("--no-approve");
    expect(trace).toContain(JSON.stringify({ PI_CODING_AGENT_DIR: codingAgentDir }).slice(1, -1));
    expect(trace).toContain(JSON.stringify({ ENGRAM_BIN: environment.ENGRAM_BIN }).slice(1, -1));
    expect(trace).not.toContain("PI_PACKAGE_DIR");
    expect(trace).not.toContain(process.env.HOME ?? "__none__");
    expect(trace).not.toContain("NPM_TOKEN");
  });

  it("blocks missing noninteractive Engram before reads or subprocesses, and promotes only the verified update receipt", async () => {
    const { runPiRuntime } = await runtime();
    const blockedEvents: string[] = [];
    const blocked = runPiRuntime({
      operation: "doctor",
      targetDir: target,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: null,
    }, harness(blockedEvents));
    expect(blocked).toMatchObject({ kind: "blocked", reason: "engram-missing", remedy: expect.stringMatching(/engram/i) });
    expect(blockedEvents).toEqual([]);

    const updateEvents: string[] = [];
    const updateDeps = harness(updateEvents);
    updateDeps.operate = (input: unknown) => {
      updateEvents.push(`operate:${JSON.stringify(input)}`);
      return { kind: "updated", receipt: { state: "installed", version: "0.2.3" } };
    };
    expect(runPiRuntime({
      operation: "update",
      targetDir: target,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: environment.ENGRAM_BIN,
    }, updateDeps)).toMatchObject({ kind: "updated" });
    expect(updateEvents).toContain(`atomic:${receiptPath}:installed`);
    expect(updateEvents.join("\n")).not.toContain(JSON.stringify({ version: PI_RUNTIME_CANDIDATE.package.version }).slice(1));
  });

  it.each([
    ["exact managed object", [MANAGED_PACKAGE_REGISTRATION], { kind: "synced" }, ["runner:sync --json"]],
    ["legacy string source", [PI_RUNTIME_CANDIDATE.package.source], { kind: "blocked", reason: "source-divergent" }, []],
    ["partial managed object", [PARTIAL_MANAGED_PACKAGE_REGISTRATION], { kind: "blocked", reason: "source-divergent" }, []],
    ["non-empty packaged skills", [{ ...MANAGED_PACKAGE_REGISTRATION, skills: ["tdd"] }], { kind: "blocked", reason: "source-divergent" }, []],
  ])("runs receipt-owned sync only for the %s registration", async (_name, packages, expected, expectedEvents) => {
    const { runPiRuntime } = await runtime();
    const { planPiPackageLifecycle } = await import("../src/lib/pi-package-lifecycle.js");
    const events: string[] = [];
    const result = runPiRuntime({
      operation: "sync",
      targetDir: target,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: environment.ENGRAM_BIN,
    }, {
      readSettings: () => JSON.stringify({ packages }),
      readReceipt: () => installedReceipt,
      writeReceiptAtomic: () => events.push("receipt-write"),
      prepare: (value) => planPiPackageLifecycle(value as never),
      execute: (value) => {
        const plan = (value as { plan: { kind: string; reason?: string } }).plan;
        if (plan.kind !== "ready") return { kind: "blocked", reason: plan.reason };
        events.push("runner:sync --json");
        return { kind: "synced", actions: [] };
      },
      operate: () => ({ kind: "healthy" }),
    });

    expect(result).toMatchObject(expected);
    expect(events).toEqual(expectedEvents);
  });
});
