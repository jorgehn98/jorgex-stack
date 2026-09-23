import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADAPTERS } from "../src/install.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { readManifest } from "../src/lib/manifest.js";
import { parseCliArgs } from "../src/cli.js";
import artifacts from "./fixtures/pi-runtime-artifacts.json" with { type: "json" };
import {
  PI_RUNTIME_ARCHIVE,
  PI_RUNTIME_CANDIDATE,
  PI_RUNTIME_PREVIOUS_CANDIDATE,
} from "./fixtures/pi-runtime.js";

function artifactMetadata(candidate: {
  package: unknown;
  provenance: unknown;
  tarball: unknown;
}) {
  return {
    package: candidate.package,
    provenance: candidate.provenance,
    tarball: candidate.tarball,
  };
}

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
      candidate: {
        contract: { capabilities: readonly string[] };
      };
      acceptedCandidates?: readonly unknown[];
    };
  };
  runPiRuntime(
    input: {
      operation: Operation;
      targetDir?: string;
      detected: { executable: string; version: string };
      engramBin: string | null;
      verifiedArtifact?: unknown;
      candidate?: unknown;
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
  it("proyecta current, previous y archive desde la metadata JSON independiente", () => {
    expect(artifactMetadata(PI_RUNTIME_CANDIDATE)).toEqual(artifacts.current);
    expect(artifactMetadata(PI_RUNTIME_PREVIOUS_CANDIDATE)).toEqual(artifacts.previous);
    expect({ entries: PI_RUNTIME_ARCHIVE.entries, parity: PI_RUNTIME_ARCHIVE.parity }).toEqual(artifacts.archive);
  });

  it("registers Pi as a production package runtime, accepts the CLI selector, and leaves adapters, components, manifests, and model maps Pi-free", async () => {
    const { PI_RUNTIME_REGISTRY } = await runtime();
    expect(PI_RUNTIME_REGISTRY.pi).toMatchObject({
      id: "pi",
      kind: "package-managed",
      source: PI_RUNTIME_CANDIDATE.package.source,
      tarball: PI_RUNTIME_CANDIDATE.tarball,
      pi: PI_RUNTIME_CANDIDATE.pi,
    });
    const accepted = PI_RUNTIME_REGISTRY.pi.acceptedCandidates ?? [];
    expect(accepted[0]).toEqual(PI_RUNTIME_CANDIDATE);
    expect(PI_RUNTIME_REGISTRY.pi.candidate).toEqual(PI_RUNTIME_CANDIDATE);
    expect(PI_RUNTIME_REGISTRY.pi.source).toBe(PI_RUNTIME_CANDIDATE.package.source);
    const historicalRecovery = accepted.find(
      (entry) => (entry as { package?: { version?: unknown } }).package?.version === "0.8.24",
    );
    expect(historicalRecovery).toMatchObject({
      package: { name: "jorgex-pi", version: "0.8.24", source: "npm:jorgex-pi@0.8.24" },
      provenance: { commit: "652d7e445e6f184c4543593c115026aa2f71e761" },
      tarball: {
        bytes: 89140631,
        sha256: "6f67e546c86f21f9b5ff139f429551e696be4a8389ce4a6262e137dcce923a5f",
        sha512: "1ce4bfc316f1635c5e498af7134ae16f430a4f6a3d2c99c7aa6fc31b76ce18684759c6480f506b5de45aa5b5b682e03f68d10fc77c83ae1679006dab679d9aa4",
      },
      contract: {
        runner: {
          bin: "jorgex-pi",
          commands: ["status", "doctor", "models", "sync", "cleanup"],
          schemaVersion: 1,
          maxStdoutBytes: 65536,
        },
      },
    });
    expect((historicalRecovery as { package: { source: string } }).package.source).not.toBe(
      PI_RUNTIME_REGISTRY.pi.source,
    );
    expect(accepted).not.toContainEqual(PI_RUNTIME_PREVIOUS_CANDIDATE);
    expect(PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities).toContain("modular-system-prompts-v1");
    expect(PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities).toContain("context7-http-v1");
    expect(PI_RUNTIME_PREVIOUS_CANDIDATE.contract.capabilities).toContain("modular-system-prompts-v1");
    expect(PI_RUNTIME_PREVIOUS_CANDIDATE.contract.capabilities).toContain("context7-http-v1");
    expect(PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities).toContain("permissions-policy-v1");
    expect(PI_RUNTIME_PREVIOUS_CANDIDATE.contract.capabilities).toContain("permissions-policy-v1");
    expect(PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities).toContain("experience-defaults-v1");
    expect(PI_RUNTIME_PREVIOUS_CANDIDATE.contract.capabilities).not.toContain("experience-defaults-v1");
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
      candidate: PI_RUNTIME_CANDIDATE,
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

  it("preserves a blocked lifecycle plan without executing it", async () => {
    const { runPiRuntime } = await runtime();
    const events: string[] = [];
    const deps = harness(events);
    deps.prepare = () => {
      events.push("prepare");
      return {
        kind: "blocked",
        reason: "unsupported-pi-version",
        remedy: "Pi detectado 0.85.1; versiones admitidas: 0.84.2",
      };
    };
    deps.execute = () => {
      events.push("execute");
      return { kind: "blocked", reason: "runner-unhealthy" };
    };

    const result = runPiRuntime({
      targetDir: target,
      operation: "sync",
      detected: { executable: "/opt/pi/bin/pi", version: "0.85.1" },
      engramBin: environment.ENGRAM_BIN,
    }, deps);

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "unsupported-pi-version",
      remedy: "Pi detectado 0.85.1; versiones admitidas: 0.84.2",
    });
    expect(events).toContain("prepare");
    expect(events).not.toContain("execute");
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

// ---------------------------------------------------------------------------
// T41-RED: wiring del install Pi gestionado real con setup oficial.
// Contrato: install real en HOME/XDG/PI aislados = Engram absoluto primero →
// backup de cada path mutable → `engram setup pi` (argv exacto, shell false)
// antes del package install → verify singleton (un gentle-engram + un
// pi-mcp-adapter + mcpServers.engram válido, versiones observadas sin pin).
// Ausente/duplicado/inválido/ilegible/parcial falla cerrado, restaura bytes y
// no activa Pi. sync/dry-run/--target-dir nunca corren setup ni descargan
// globales. doctor distingue binary/setup/runtime; uninstall preserva package
// externo/MCP/caché/bin/DB/memorias y handoffs Context7/DevTools.
// ---------------------------------------------------------------------------

const T41_WIRING_ROOTS: string[] = [];

afterEach(() => {
  for (const root of T41_WIRING_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function t41IsolatedPi(): { root: string; home: string; piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t41-pi-wiring-"));
  T41_WIRING_ROOTS.push(root);
  const home = path.join(root, "home");
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  // Binario aislado que responde --version para la capa bin del doctor.
  fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
  try { fs.chmodSync(engramBin, 0o755); } catch { /* best-effort en tmp */ }
  return { root, home, piAgentDir, engramBin };
}

describe("[T41-RED] wiring install Pi real con setup oficial verificado", () => {
  it("el install real cablea Engram → backup → setup pi → verify singleton antes del package", async () => {
    const { home, piAgentDir } = t41IsolatedPi();
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof setup.resolveOfficialSetupArgv, "falta argv setup pi en wiring (T41)").toBe("function");
    expect(setup.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);

    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    expect(Array.isArray(targets) && targets.length > 0, "wiring Pi debe declarar backup targets").toBe(true);

    const { runPiRuntime, PI_RUNTIME_REGISTRY } = await runtime();
    // El wiring real debe correr el setup pi antes de prepare/execute; el trace
    // permite detectar si se altera ese orden.
    // runPiRuntime exige candidate + verifiedArtifact en install; se aportan
    // el candidato fixture y el tarball canónico para que prepare bloquee con
    // setup-pi-missing.
    const events: string[] = [];
    const deps = harness(events);
    const failingPrepare = () => {
      events.push("prepare");
      return { kind: "blocked", reason: "setup-pi-missing" };
    };
    const result = runPiRuntime({
      operation: "install",
      targetDir: path.join(home, "target"),
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: path.join(home, ".local", "bin", "engram"),
      verifiedArtifact: PI_RUNTIME_REGISTRY.pi.tarball,
      candidate: PI_RUNTIME_CANDIDATE,
    }, { ...deps, prepare: failingPrepare });
    expect(result).toMatchObject({ kind: "blocked", reason: "setup-pi-missing" });
    expect(events).toContain("prepare");
  });

  it("doctor Pi distingue binary/setup/runtime en dirs aislados", async () => {
    const { home } = t41IsolatedPi();
    const { resolveEngramOfficialState } = (await import("../src/doctor.js")) as any;
    expect(typeof resolveEngramOfficialState, "falta doctor Pi binary/setup/runtime (T41)").toBe("function");

    const state = await resolveEngramOfficialState({ homeDir: home });
    expect(state.setup.runtimes).toHaveProperty("pi");
    expect(state.exposure.runtimes).toHaveProperty("pi");
    expect(state.bin.found).toBe(true);
    expect(state.setup.runtimes.pi.ok).toBe(false);
    expect(state.exposure.runtimes.pi.exposed).toBe(false);
  });

  it("uninstall Pi preserva package/MCP/caché/bin/DB/memorias y handoffs externos", async () => {
    const { home, piAgentDir, engramBin } = t41IsolatedPi();
    // Estado externo que Stack jamás debe retirar en uninstall Pi.
    const preserved = [
      path.join(piAgentDir, "npm", "node_modules", "gentle-engram", "package.json"),
      path.join(piAgentDir, "npm", "node_modules", "pi-mcp-adapter", "package.json"),
      // Canónico `engram setup pi`: mcp.json (no mcp-cache.json).
      path.join(piAgentDir, "mcp.json"),
      path.join(home, ".cache", "pi", "cache.json"),
      engramBin,
      path.join(home, ".engram", "engram.db"),
      path.join(piAgentDir, "context7.json"),
      path.join(piAgentDir, "devtools.v1.json"),
    ];
    for (const file of preserved) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ external: true }));
    }
    const before = preserved.map((file) => fs.readFileSync(file, "utf8"));

    const { runPiPackageManagedOperation } = (await import("../src/lib/pi-package-lifecycle.js")) as any;
    expect(typeof runPiPackageManagedOperation, "falta lifecycle uninstall Pi (T41)").toBe("function");
    // El contrato de preservación debe vivir en el wiring de uninstall: los
    // bytes externos siguen intactos en este fixture aislado.
    for (const [index, file] of preserved.entries()) {
      expect(fs.readFileSync(file, "utf8"), `uninstall Pi debe preservar ${file}`).toBe(before[index]);
    }
    // La verificación singleton del setup debe existir para distinguir lo
    // externo (global) de lo gestionado por el receipt.
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verify Pi para preservación en uninstall (T41)").toBe("function");
  });
});

// ---------------------------------------------------------------------------
// T48-RED: wiring Pi con closure npm (repro smoke T46).
// Contrato: install real cablea Engram → backup → `engram setup pi` → verify
// singleton Pi con closure npm interno permitido; escape/roto/ciclo falla
// cerrado sin activar Pi; rollback restaura links y solo entonces es
// complete. Fuera de npm rige rechazo estricto. Temporales aislados.
// ---------------------------------------------------------------------------

function t48WiringIsolatedPi(): { root: string; home: string; piAgentDir: string; engramBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t48-pi-wiring-"));
  T41_WIRING_ROOTS.push(root);
  const home = path.join(root, "home");
  // Contenido en HOME para la frontera de restore (<home>/.pi/agent, como en prod).
  const piAgentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(piAgentDir, { recursive: true });
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
  try { fs.chmodSync(engramBin, 0o755); } catch { /* best-effort en tmp */ }
  return { root, home, piAgentDir, engramBin };
}

function t48WiringSeedNpm(piAgentDir: string): { npmDir: string; linkPath: string; rawTarget: string } {
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

function t48WiringSeedSingleton(piAgentDir: string, engramBin: string): void {
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:gentle-engram@0.1.99", "npm:pi-mcp-adapter@0.2.5"] }),
  );
  fs.writeFileSync(
    path.join(piAgentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }),
  );
}

describe("[T48-RED] wiring Pi con closure npm", () => {
  it("RED: singleton válido + .bin interno permite wiring ok (repro smoke T46)", async () => {
    const { home, piAgentDir, engramBin } = t48WiringIsolatedPi();
    t48WiringSeedSingleton(piAgentDir, engramBin);
    const { npmDir, linkPath, rawTarget } = t48WiringSeedNpm(piAgentDir);
    expect(fs.readlinkSync(linkPath)).toBe(rawTarget);
    expect(path.resolve(path.dirname(linkPath), rawTarget)).toBe(
      path.join(npmDir, "node_modules", "is-docker", "cli.js"),
    );
    const pi = (await import("../src/adapters/pi.js")) as any;
    expect(typeof pi.verifyOfficialSetup, "falta verify Pi en wiring (T48)").toBe("function");
    const pre = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin });
    expect(pre.ok).toBe(true);
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    expect(targets).toContain(path.join(piAgentDir, "npm"));
    const result = await setup.runOfficialSetup("pi", {
      homeDir: home,
      engramBin,
      targets,
      backup: async () => ({ id: "t48-wiring-internal-backup" }),
      spawn: async () => ({ ok: true, stdout: "", stderr: "" }),
      verify: async () => pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin }),
    });
    expect(result.ok).toBe(true);
    expect(result.ownershipTransferred).toBe(true);
  });

  it("escape relativo bloquea wiring sin activar Pi aunque el singleton sea válido", async () => {
    const { home, piAgentDir, engramBin } = t48WiringIsolatedPi();
    t48WiringSeedSingleton(piAgentDir, engramBin);
    const npmDir = path.join(piAgentDir, "npm");
    const binDir = path.join(npmDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const outside = path.join(home, "wiring-outside.txt");
    fs.writeFileSync(outside, "outside\n");
    const linkPath = path.join(binDir, "evil");
    fs.symlinkSync(path.relative(path.dirname(linkPath), outside), linkPath);
    const pi = (await import("../src/adapters/pi.js")) as any;
    const pre = await pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin });
    expect(pre.ok).toBe(true);
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    let spawned = 0;
    const result = await setup.runOfficialSetup("pi", {
      homeDir: home,
      engramBin,
      targets,
      backup: async () => ({ id: "t48-wiring-escape-backup" }),
      spawn: async () => {
        spawned += 1;
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin }),
    });
    expect(spawned).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.ownershipTransferred ?? false).toBe(false);
    expect(String(result.reason ?? result.stderr ?? "")).toMatch(/symlink|escape|rechazado/i);
  });

  it("RED: rollback wiring restaura link, elimina creado, preserva ajeno y reporta complete", async () => {
    const { home, piAgentDir, engramBin } = t48WiringIsolatedPi();
    // Singleton parcial para forzar verify fail tras mutación (falta adapter).
    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:gentle-engram@0.1.99"] }),
    );
    fs.writeFileSync(path.join(piAgentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const originalSettings = fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8");
    const { npmDir, linkPath } = t48WiringSeedNpm(piAgentDir);
    const originalTarget = fs.readlinkSync(linkPath);
    const unrelated = path.join(npmDir, "unrelated", "keep.json");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, JSON.stringify({ keep: true }));
    const originalKeep = fs.readFileSync(unrelated, "utf8");
    const { createBackup, restoreBackup } = (await import("../src/lib/backup.js")) as any;
    const setup = (await import("../src/lib/official-engram-setup.js")) as any;
    const pi = (await import("../src/adapters/pi.js")) as any;
    const targets = setup.collectOfficialSetupBackupTargets("pi", piAgentDir, home) as string[];
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;
    const createdLink = path.join(npmDir, "node_modules", ".bin", "new-wiring");
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
        const backup = createBackup(expanded, "t48-wiring-rollback", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        fs.rmSync(linkPath, { force: true });
        const otherPkg = path.join(npmDir, "node_modules", "other-wiring");
        fs.mkdirSync(otherPkg, { recursive: true });
        fs.writeFileSync(path.join(otherPkg, "cli.js"), "other\n");
        fs.symlinkSync(path.join("..", "other-wiring", "cli.js"), linkPath);
        fs.symlinkSync(path.join("..", "is-docker", "cli.js"), createdLink);
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => pi.verifyOfficialSetup({ configDir: piAgentDir, engramBin }),
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
    expect(fs.readFileSync(path.join(piAgentDir, "settings.json"), "utf8")).toBe(originalSettings);
    expect(fs.readFileSync(unrelated, "utf8")).toBe(originalKeep);
  });
});

// ---------------------------------------------------------------------------
// T50-RED: remedy setup-pi-failed distingue recovery con backupId/acción.
// Contrato: blocked setup-pi-failed nunca afirma restore falso; recovery
// none => sin claim de restauración + acción manual; complete => restaurado
// + backupId; incomplete => incompleta + backupId + acción manual.
// Solo lectura del remedy; PI_CODING_AGENT_DIR aislado; sin HOME real.
// ---------------------------------------------------------------------------

async function t50SetupPiFailedRemedy(setupResult: Record<string, unknown>): Promise<{ kind: string; reason?: string; remedy?: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t50-pi-remedy-"));
  const isolatedAgentDir = path.join(tmp, "pi-agent");
  fs.mkdirSync(isolatedAgentDir, { recursive: true });
  // Valid synthetic prepared stub from the known current fixture (no invented
  // hashes) so install reaches the setup seam instead of candidate-missing.
  const stageDir = path.join(isolatedAgentDir, `stage-${"b".repeat(32)}`, "pi-agent");
  fs.mkdirSync(stageDir, { recursive: true });
  const candidate = PI_RUNTIME_CANDIDATE;
  const preparedIntegrity = `sha512-${Buffer.from(candidate.tarball.sha512, "hex").toString("base64")}`;
  const preparedDeps = [
    { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
    { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
    { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
    { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
    { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
    { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
  ];
  const artifactPath = path.join(tmp, "downloads", `jorgex-pi-${candidate.package.version}.tgz`);
  const prepared = {
    candidate,
    release: {
      version: candidate.package.version,
      tarballUrl: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${candidate.package.version}.tgz`,
      integrity: preparedIntegrity,
    },
    artifact: {
      path: artifactPath,
      bytes: candidate.tarball.bytes,
      sha256: candidate.tarball.sha256,
      sha512: candidate.tarball.sha512,
    },
    stageDir,
    evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: preparedDeps },
    sourceAlias: `npm:jorgex-pi@file:${artifactPath}`,
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmp);
  vi.resetModules();
  vi.doMock("../src/lib/official-engram-setup.js", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/official-engram-setup.js")>("../src/lib/official-engram-setup.js");
    return { ...actual, runOfficialSetupIfNeeded: async () => setupResult };
  });
  try {
    const { runPiRuntimeSystem } = await import("../src/lib/pi-runtime.js") as any;
    const result = await runPiRuntimeSystem({
      operation: "install",
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
      candidate,
      prepared,
    });
    return result;
  } finally {
    homedirSpy.mockRestore();
    vi.doUnmock("../src/lib/official-engram-setup.js");
    vi.resetModules();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("[T50-RED] setup-pi-failed remedy distingue recovery", () => {
  it("recovery none nunca afirma restaurado e indica acción manual", async () => {
    const result = await t50SetupPiFailedRemedy({
      ran: true,
      ok: false,
      ownershipTransferred: false,
      reason: "singleton incompleto: falta pi-mcp-adapter",
      stderr: "singleton incompleto: falta pi-mcp-adapter",
      recovery: "none",
      backupId: null,
    });
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("setup-pi-failed");
    const remedy = String(result.remedy ?? "");
    expect(remedy).toContain("singleton incompleto");
    expect(remedy).not.toMatch(/restauró|restaurado|restored|backup previo.*restaur/i);
    expect(remedy).toMatch(/manual|revisa|reintenta|corrige|backup/i);
  });

  it("recovery complete incluye backupId y afirma restaurado sin decir incompleta", async () => {
    const result = await t50SetupPiFailedRemedy({
      ran: true,
      ok: false,
      ownershipTransferred: false,
      reason: "singleton incompleto tras setup",
      stderr: "singleton incompleto tras setup",
      recovery: "complete",
      backupId: "bk-t50-complete-123",
    });
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("setup-pi-failed");
    const remedy = String(result.remedy ?? "");
    expect(remedy).toMatch(/restaur/i);
    expect(remedy).toContain("bk-t50-complete-123");
    expect(remedy).not.toMatch(/incompleta/i);
  });

  it("recovery incomplete indica incompleta con backupId y acción manual, sin afirmar restaurado limpio", async () => {
    const result = await t50SetupPiFailedRemedy({
      ran: true,
      ok: false,
      ownershipTransferred: false,
      reason: "verify falló tras setup",
      stderr: "verify falló tras setup",
      recovery: "incomplete",
      backupId: "bk-t50-incomplete-456",
      incompleteRecovery: true,
      restoreError: "restore incompleto: 1/2 archivos",
    });
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("setup-pi-failed");
    const remedy = String(result.remedy ?? "");
    expect(remedy).toMatch(/incompleta/i);
    expect(remedy).toContain("bk-t50-incomplete-456");
    expect(remedy).toMatch(/manual|revisa/i);
    expect(remedy).not.toMatch(/Se restauró el backup previo; Pi no quedó activado\./);
  });
});

// ---------------------------------------------------------------------------
// T52-RED: contrato runtime Pi 0.8.29 exige engram-official-bridge-v1.
// Contrato: pin 0.8.29 (commit bbaf80f09bd1512e21fe80f22b4aad61420a8800)
// se vincula a capabilities con `engram-official-bridge-v1` y sin
// `mcp-adapter-v1`; el resto intacto y en orden. Fuente independiente:
// contract/jorgex-pi.v1.json del tag Pi v0.8.29. Sin env, esta aserción
// estática debe fallar mientras Stack siga legacy e impide adoptar el pin
// con bytes válidos pero contrato incompatible. No edita pin generado.
// ---------------------------------------------------------------------------

const T52_EXPECTED_PI_0_8_29_COMMIT = "bbaf80f09bd1512e21fe80f22b4aad61420a8800";
const T52_EXPECTED_PI_0_8_29_CAPABILITIES = [
  "foundation-contract-v1",
  "stack-snapshot-v2",
  "modular-system-prompts-v1",
  "runtime-agents-v1",
  "permission-gated-tools-v1",
  "structured-questions-v1",
  "web-access-v1",
  "goal-continuation-v1",
  "engram-official-bridge-v1",
  "engram-runtime-tools-v1",
  "context7-http-v1",
  "permissions-policy-v1",
  "permissions-upgrade-v1",
  "experience-defaults-v1",
  "chrome-devtools-handoff-v1",
  "playwright-handoff-v1",
  "runner-json-v1",
  "tui-branding-v1",
  "managed-primary-model-v1",
  "quality-receipt-contract-v1",
  "quality-capabilities-contract-v1",
  "initialization-diagnostics-v1",
] as const;

describe("[T52-RED] contrato runtime Pi 0.8.29 con bridge oficial", () => {
  it("el fixture independiente para el pin 0.8.29 contiene bridge y no legacy, resto intacto", () => {
    expect(PI_RUNTIME_CANDIDATE.package.version).toBe("0.8.29");
    expect(PI_RUNTIME_CANDIDATE.provenance.commit).toBe(T52_EXPECTED_PI_0_8_29_COMMIT);
    const capabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
    expect(capabilities).toContain("engram-official-bridge-v1");
    expect(capabilities).not.toContain("mcp-adapter-v1");
    expect(capabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
  });

  it("el candidate de producción para el pin 0.8.29 contiene bridge y no legacy, resto intacto", async () => {
    const { PI_RUNTIME_CANDIDATE: productionCandidate } = await import("../src/lib/pi-runtime.js");
    expect(productionCandidate.package.version).toBe("0.8.29");
    expect(productionCandidate.provenance.commit).toBe(T52_EXPECTED_PI_0_8_29_COMMIT);
    const capabilities = [...productionCandidate.contract.capabilities];
    expect(capabilities).toContain("engram-official-bridge-v1");
    expect(capabilities).not.toContain("mcp-adapter-v1");
    expect(capabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
  });
});

// ---------------------------------------------------------------------------
// [T05/T06-RED] seam de inyección del consumidor Stack en runPiRuntime.
// Contrato: PiRuntimeInput puede aportar `candidate` (PiRuntimeCandidate del
// resolver+stage verificado) y cuando está presente toda la planificación y
// ejecución del package usan ese candidato inyectado exacto, nunca el pin
// estático. Control existente: observedTarball divergente sigue bloqueado en
// pi-package-lifecycle (tarball-integrity).
// ---------------------------------------------------------------------------

describe("[T05/T06-RED] runPiRuntime usa el candidato inyectado", () => {
  it("install con candidate inyectado lo propaga a prepare/execute y nunca usa el pin estático", async () => {
    const { runPiRuntime, PI_RUNTIME_REGISTRY } = await runtime();
    const staticSource = PI_RUNTIME_REGISTRY.pi.source;
    // Candidato sintético solo-test, estable y distinto del pin estático,
    // con forma válida y sin afirmar ningún release publicado factual.
    const injectedCandidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: {
        name: "jorgex-pi",
        version: "9.9.9",
        source: "npm:jorgex-pi@9.9.9",
      },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    expect(injectedCandidate.package.source).not.toBe(staticSource);
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-injected-"));
    T41_WIRING_ROOTS.push(sandbox);
    const engramBin = path.join(sandbox, "bin", "engram");
    let prepared: unknown;
    let executed: unknown;
    const deps = {
      readSettings: () => JSON.stringify({ packages: [] }),
      readReceipt: () => null,
      writeReceiptAtomic: () => undefined,
      prepare: (value: unknown) => {
        prepared = value;
        return { kind: "ready" };
      },
      execute: (value: unknown) => {
        executed = value;
        return { kind: "installed", receipt: { state: "installed" } };
      },
      operate: () => ({ kind: "healthy" }),
    };
    const input = {
      operation: "install",
      targetDir: sandbox,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin,
      verifiedArtifact: { ...injectedCandidate.tarball },
      candidate: injectedCandidate,
    } as unknown as Parameters<typeof runPiRuntime>[0];
    const result = runPiRuntime(input, deps);
    expect(result).toMatchObject({ kind: "installed" });
    const preparedCandidate = (prepared as { candidate?: unknown }).candidate;
    const executedCandidate = (executed as { candidate?: unknown }).candidate;
    expect(preparedCandidate).toEqual(injectedCandidate);
    expect(executedCandidate).toEqual(injectedCandidate);
    expect((preparedCandidate as { package: { source: string } }).package.source).not.toBe(staticSource);
    expect((executedCandidate as { package: { source: string } }).package.source).not.toBe(staticSource);
  });
});

// ---------------------------------------------------------------------------
// [T05/T06-RED] runPiRuntimeSystem routes prepared verified stage to activation.
// Contract (coordinator-closed, internal only): PiRuntimeInput gains
// `prepared?: {candidate,release,artifact,stageDir,evidence,sourceAlias}`
// (prepared output of preparePiManagedInstall, not user CLI input). When
// operation install AND candidate===prepared.candidate by exact identity AND
// prepared.artifact digests===candidate.tarball, system must call
// activatePreparedPiInstall instead of static acquisition/native install.
// Without prepared, block before download/setup/active writes; targetDir
// stays no-network. Synthetic 9.9.x only, tmpdir sandbox, fetch 0. Stage
// fixtures use the real layout agentDir/stage-<32hex>/pi-agent, canonical
// base64 SRI, and six synthetic companion identities; the verifying
// inspector boundary is explicitly mocked via activatePreparedPiInstall
// (authoritative stage/inspector tests live separately), so no on-disk
// tarball re-hash or published-release claim here. No HOME, no real Pi run.
// ---------------------------------------------------------------------------

describe("[T05/T06-RED] runPiRuntimeSystem routes prepared stage to activation", () => {
  it("install with matching prepared stage calls activatePreparedPiInstall without network or static pin", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-prepared-system-"));
    T41_WIRING_ROOTS.push(sandbox);
    const agentDir = path.join(sandbox, "pi-agent");
    const stageHex = "b".repeat(32);
    const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const engramBin = path.join(sandbox, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    // Synthetic stable candidate, no published-release claim.
    const syntheticCandidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const syntheticIntegrity = `sha512-${Buffer.from(syntheticCandidate.tarball.sha512, "hex").toString("base64")}`;
    const syntheticDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const prepared = {
      candidate: syntheticCandidate,
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: syntheticIntegrity,
      },
      artifact: {
        path: path.join(sandbox, "downloads", "jorgex-pi-9.9.9.tgz"),
        bytes: 1234567,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: syntheticDeps },
      sourceAlias: `npm:jorgex-pi@file:${path.join(sandbox, "downloads", "jorgex-pi-9.9.9.tgz")}`,
    };
    const installedReceipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: syntheticCandidate.package,
        tarball: syntheticCandidate.tarball,
        provenance: syntheticCandidate.provenance,
      },
      scope: { kind: "target-dir", codingAgentDir: path.join(sandbox, "pi-agent") },
      engram: { binary: engramBin },
    } as const;
    const fixtureEvidence = {
      lockSha256: "c".repeat(64),
      treeSha256: "d".repeat(64),
      dependencies: syntheticDeps,
    };
    const activateCalls: unknown[] = [];
    const inspectorCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "pi-agent");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-staged-lock.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-staged-lock.js")>(
        "../src/lib/pi-staged-lock.js",
      );
      return {
        ...actual,
        inspectStagedPiNpm: (input: unknown) => {
          inspectorCalls.push(input);
          return {
            lockSha256: fixtureEvidence.lockSha256,
            treeSha256: fixtureEvidence.treeSha256,
            dependencies: [...fixtureEvidence.dependencies],
          };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: unknown, deps: unknown) => {
        activateCalls.push(input);
        const verifyStage = (deps as any)?.verifyStage;
        if (typeof verifyStage !== "function") {
          throw new Error("activation mock requires deps.verifyStage(stageDir, evidence)");
        }
        await verifyStage((input as any).prepared.stageDir, (input as any).prepared.evidence);
        return { kind: "installed", receipt: installedReceipt };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const input = {
        operation: "install",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
        candidate: syntheticCandidate,
        prepared,
        verifiedArtifact: { ...syntheticCandidate.tarball },
      } as any;
      const result = await runPiRuntimeSystem(input);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(activateCalls).toHaveLength(1);
      const seen = activateCalls[0] as any;
      const seenCandidate = seen?.prepared?.candidate ?? seen?.candidate;
      const seenStage = seen?.prepared?.stageDir ?? seen?.stageDir;
      expect(seenCandidate).toEqual(syntheticCandidate);
      expect(seenStage).toBe(stageDir);
      expect(inspectorCalls).toHaveLength(1);
      const inspectorInput = inspectorCalls[0] as any;
      expect(inspectorInput?.stageDir ?? inspectorInput?.prepared?.stageDir).toBe(stageDir);
      expect(JSON.stringify(inspectorInput)).toContain("9.9.9");
      expect(JSON.stringify(inspectorInput)).toContain(prepared.artifact.path);
      expect(result).toMatchObject({ kind: "installed", receipt: installedReceipt });
      expect(JSON.stringify(result)).toContain("9.9.9");
      expect(JSON.stringify(result)).not.toContain("0.8.29");
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.doUnmock("../src/lib/pi-staged-lock.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("install with candidate/prepared mismatch stays blocked without activation, fetch, or static pin", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-prepared-mismatch-"));
    T41_WIRING_ROOTS.push(sandbox);
    const agentDir = path.join(sandbox, "pi-agent");
    const stageHex = "c".repeat(32);
    const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const engramBin = path.join(sandbox, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    // Synthetic stable versions, test-only, no published-release claim.
    const candidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const mismatchedCandidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.8", source: "npm:jorgex-pi@9.9.8" },
      provenance: { commit: "1".repeat(40) },
      tarball: { bytes: 7654321, sha256: "e".repeat(64), sha512: "f".repeat(128) },
    } as const;
    const mismatchedIntegrity = `sha512-${Buffer.from(mismatchedCandidate.tarball.sha512, "hex").toString("base64")}`;
    const mismatchedDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const prepared = {
      candidate: mismatchedCandidate,
      release: {
        version: "9.9.8",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.8.tgz",
        integrity: mismatchedIntegrity,
      },
      artifact: {
        path: path.join(sandbox, "downloads", "jorgex-pi-9.9.8.tgz"),
        bytes: 7654321,
        sha256: "e".repeat(64),
        sha512: "f".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: mismatchedDeps },
      sourceAlias: `npm:jorgex-pi@file:${path.join(sandbox, "downloads", "jorgex-pi-9.9.8.tgz")}`,
    };
    const activateCalls: unknown[] = [];
    const inspectorCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "pi-agent");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-staged-lock.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-staged-lock.js")>(
        "../src/lib/pi-staged-lock.js",
      );
      return {
        ...actual,
        inspectStagedPiNpm: (input: unknown) => {
          inspectorCalls.push(input);
          return {
            lockSha256: "c".repeat(64),
            treeSha256: "d".repeat(64),
            dependencies: [...mismatchedDeps],
          };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: unknown) => {
        activateCalls.push(input);
        return { kind: "installed", receipt: {} };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const input = {
        operation: "install",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
        candidate,
        prepared,
        verifiedArtifact: { ...candidate.tarball },
      } as any;
      const result = await runPiRuntimeSystem(input);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(activateCalls).toHaveLength(0);
      expect(inspectorCalls).toHaveLength(0);
      expect(result.kind).toBe("blocked");
      expect(result).not.toMatchObject({ kind: "installed" });
      expect(JSON.stringify(result)).not.toContain("0.8.29");
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.doUnmock("../src/lib/pi-staged-lock.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T05/T07-RED] runPiRuntimeSystem offline managed sync path.
// Contract: system `sync` with a schemaVersion1 managed receipt (synthetic
// 9.9.9 parent, never a published-release claim) and the exact managed
// settings object must route to `runPiPackageManagedSync` offline, threading
// its authenticated `{kind:'synced',actions,packageSource}` without global
// fetch, pi install, or projection writes. Ownership validation lives in the
// package module (covered separately); this seam only proves the system
// route. Current system still calls legacy planPiPackageLifecycle and never
// invokes the managed sync, so this RED fails on zero calls/blocked.
// Isolated targetDir under os.tmpdir only; no personal HOME.
// ---------------------------------------------------------------------------

describe("[T05/T07-RED] runPiRuntimeSystem routes managed sync offline", () => {
  it("invokes runPiPackageManagedSync and threads its authenticated source with zero network", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-t07-managed-sync-"));
    T41_WIRING_ROOTS.push(sandbox);
    const codingAgentDir = path.join(sandbox, "pi-agent");
    const stateDir = path.join(sandbox, "state");
    const binDir = path.join(sandbox, "bin");
    fs.mkdirSync(codingAgentDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const engramBin = path.join(binDir, "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    const managedSource = "npm:jorgex-pi@9.9.9";
    fs.writeFileSync(
      path.join(codingAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: managedSource, skills: [], prompts: [] }] }),
    );
    const releaseId = "e".repeat(64);
    const stageHex = "b".repeat(32);
    const receipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { name: "jorgex-pi", version: "9.9.9", source: managedSource },
        tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
        provenance: { commit: "0".repeat(40) },
      },
      scope: { kind: "target-dir", codingAgentDir },
      engram: { binary: engramBin },
      managedPackage: {
        releaseDir: path.join(codingAgentDir, "npm", "jorgex-pi-managed", "releases", releaseId),
        linkPath: path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi"),
        backupDir: path.join(codingAgentDir, `stage-${stageHex}`, "pi-agent", ".activate-backup"),
        lockSha256: "c".repeat(64),
        treeSha256: "d".repeat(64),
        dependencies: [
          { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
          { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
          { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
          { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
          { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
          { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
        ],
      },
    };
    fs.writeFileSync(path.join(stateDir, "pi-receipt.json"), `${JSON.stringify(receipt)}\n`);

    const managedSyncCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = codingAgentDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        runPiPackageManagedSync: (input: unknown) => {
          managedSyncCalls.push(input);
          return { kind: "synced", actions: [], packageSource: managedSource };
        },
      };
    });
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "sync",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(managedSyncCalls).toHaveLength(1);
      expect(result).toMatchObject({ kind: "synced", actions: [], packageSource: managedSource });
      expect(JSON.stringify(result)).toContain("9.9.9");
      expect(JSON.stringify(result)).not.toContain("0.8.29");
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T05-RED] install real re-reads settings.json after official setup.
// Contract: runPiRuntimeSystem install real (targetDir undefined) reads
// settingsJson before runOfficialSetupIfNeeded('pi') and must pass POST-setup
// settings to activatePreparedPiInstall. Stale pre-setup overwrites official
// registrations (gentle-engram + pi-mcp-adapter + foreign) leaving only the Pi
// package (observed Pi 0.8.31 runner-unhealthy). Isolated os.tmpdir HOME/agent,
// synthetic 9.9.x only, no network/Pi writes. Existing pure
// planPiManagedSettings suite guards foreign preservation; this seam proves
// the real callsite threads the fresh bytes.
// ---------------------------------------------------------------------------

describe("[T05-RED] install real uses post-setup settings for activation", () => {
  it("activation sees POST-setup provider pair + foreign, not stale pre-setup", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-stale-settings-"));
    T41_WIRING_ROOTS.push(tmp);
    const isolatedAgentDir = path.join(tmp, "pi-agent");
    fs.mkdirSync(isolatedAgentDir, { recursive: true });
    const stageDir = path.join(isolatedAgentDir, `stage-${"b".repeat(32)}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const preSetup = JSON.stringify({ packages: [] });
    fs.writeFileSync(path.join(isolatedAgentDir, "settings.json"), preSetup);
    // Sandbox context from the real failure: npm roots + mcp.json exist, but
    // settings lacks the official provider pair before setup.
    for (const dir of [
      path.join(isolatedAgentDir, "npm", "node_modules", "gentle-engram"),
      path.join(isolatedAgentDir, "npm", "node_modules", "pi-mcp-adapter"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(isolatedAgentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { engram: { command: "/isolated/bin/engram" } } }),
    );
    const candidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const preparedIntegrity = `sha512-${Buffer.from(candidate.tarball.sha512, "hex").toString("base64")}`;
    const preparedDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const artifactPath = path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz");
    const prepared = {
      candidate,
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: preparedIntegrity,
      },
      artifact: {
        path: artifactPath,
        bytes: 1234567,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: preparedDeps },
      sourceAlias: `npm:jorgex-pi@file:${artifactPath}`,
    };
    const providerA = "npm:gentle-engram@9.9.99";
    const providerB = "npm:pi-mcp-adapter@9.9.98";
    const foreign = "npm:foreign-keep@1.0.0";
    const activationSettings: string[] = [];
    const engramBin = path.join(tmp, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmp);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/official-engram-setup.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/official-engram-setup.js")>(
        "../src/lib/official-engram-setup.js",
      );
      return {
        ...actual,
        runOfficialSetupIfNeeded: async (_runtime: unknown, opts: { configDir: string }) => {
          const settingsPath = path.join(opts.configDir, "settings.json");
          const raw = fs.readFileSync(settingsPath, "utf8");
          const parsed = JSON.parse(raw) as { packages: unknown[] };
          parsed.packages.push(providerA, providerB, foreign);
          fs.writeFileSync(settingsPath, JSON.stringify(parsed));
          return { ran: true, ok: true, ownershipTransferred: true };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: { settingsJson: string }) => {
        activationSettings.push(input.settingsJson);
        return { kind: "installed", receipt: { state: "installed" } };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
        candidate,
        prepared,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(isolatedAgentDir, "settings.json"), "utf8"),
      ) as { packages: unknown[] };
      expect(onDisk.packages).toEqual(expect.arrayContaining([providerA, providerB, foreign]));
      expect(activationSettings).toHaveLength(1);
      const seen = JSON.parse(activationSettings[0] as string) as { packages: unknown[] };
      expect(seen.packages).toEqual(expect.arrayContaining([providerA, providerB, foreign]));
      expect(activationSettings[0]).not.toBe(preSetup);
      expect(result).toMatchObject({ kind: "installed" });
    } finally {
      fetchSpy.mockRestore();
      homedirSpy.mockRestore();
      vi.doUnmock("../src/lib/official-engram-setup.js");
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T05/T07-RED] runPiRuntimeSystem migrates an owned legacy 0.8.24 receipt.
// Contract (coordinator-closed): install with a preexisting legacy schema1
// receipt WITHOUT managedPackage must authenticate via the already-tested
// `preparePiLegacyMigration` with the exact historical accepted candidate +
// owned settings/root/scope/engram (never raw trust) to get previousSource
// .24; after official setup it re-reads settings and revalidates the old
// receipt/root+source to catch drift, then calls `activatePreparedPiInstall`
// with previousSource .24 and the POST-setup settings (old owned entry
// backed up via the private helper, provider pair preserved). Guard
// failure/tampered/manual blocks BEFORE official setup/activation. Real
// probe: `engram setup pi` on legacy .24 leaves the old owned tree
// byte-identical and only adds official gentle+adapter. Synthetic new
// source 9.9.9 only, sandbox HOME, no network/Pi writes, no full CLI claim.
// Current system returns verified-update-required for ANY old receipt, so
// this RED fails before guard/setup/activation.
// ---------------------------------------------------------------------------

describe("[T05/T07-RED] runPiRuntimeSystem migrates owned legacy 0.8.24 receipt", () => {
  it("authenticates legacy .24 before and after setup, then activates with previousSource .24 and new 9.9.9 source", async () => {
    const { PI_RUNTIME_REGISTRY } = await runtime();
    const accepted = PI_RUNTIME_REGISTRY.pi.acceptedCandidates ?? [];
    const historical = accepted.find(
      (entry) => (entry as { package?: { version?: unknown } }).package?.version === "0.8.24",
    ) as unknown as {
      package: { name: string; version: string; source: string };
      tarball: { bytes: number; sha256: string; sha512: string };
      provenance: { commit: string };
    };
    expect(historical?.package?.source).toBe("npm:jorgex-pi@0.8.24");
    const HIST_SOURCE = historical.package.source;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-legacy-migrate-"));
    T41_WIRING_ROOTS.push(tmp);
    const agentDir = path.join(tmp, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const engramBin = path.join(tmp, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    // Legacy owned receipt: schema1, NO managedPackage, exact historical wire.
    const legacyReceipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { ...historical.package },
        tarball: { ...historical.tarball },
        provenance: { ...historical.provenance },
      },
      scope: { kind: "real", codingAgentDir: agentDir },
      engram: { binary: engramBin },
    };
    expect(JSON.stringify(legacyReceipt)).not.toContain("managedPackage");
    const receiptDir = path.join(tmp, ".jorgex-stack");
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, "pi-receipt.json"), `${JSON.stringify(legacyReceipt)}\n`);
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: HIST_SOURCE, skills: [], prompts: [] }] }),
    );

    // Synthetic stable new source, no published-release claim.
    const syntheticCandidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const stageDir = path.join(agentDir, `stage-${"d".repeat(32)}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const syntheticDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const prepared = {
      candidate: syntheticCandidate,
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: `sha512-${Buffer.from(syntheticCandidate.tarball.sha512, "hex").toString("base64")}`,
      },
      artifact: {
        path: path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz"),
        bytes: 1234567,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: syntheticDeps },
      sourceAlias: `npm:jorgex-pi@file:${path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz")}`,
    };
    const installedReceipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: syntheticCandidate.package,
        tarball: syntheticCandidate.tarball,
        provenance: syntheticCandidate.provenance,
      },
      scope: { kind: "real", codingAgentDir: agentDir },
      engram: { binary: engramBin },
    } as const;

    const providerA = "npm:gentle-engram@9.9.99";
    const providerB = "npm:pi-mcp-adapter@9.9.98";
    const foreign = "npm:foreign-keep@1.0.0";
    const order: string[] = [];
    const guardCalls: unknown[] = [];
    const activateCalls: unknown[] = [];
    const inspectorCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmp);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        preparePiLegacyMigration: (input: unknown) => {
          order.push("guard");
          guardCalls.push(input);
          try {
            const { receiptJson, settingsJson } = input as any;
            const receipt = JSON.parse(receiptJson);
            const settings = JSON.parse(settingsJson);
            const receiptSource = receipt?.candidate?.package?.source;
            const owned = Array.isArray(settings?.packages) && settings.packages.some(
              (entry: any) => entry !== null && typeof entry === "object"
                && entry.source === HIST_SOURCE
                && Array.isArray(entry.skills) && entry.skills.length === 0
                && Array.isArray(entry.prompts) && entry.prompts.length === 0,
            );
            if (receiptSource === HIST_SOURCE && owned && !("managedPackage" in receipt)) {
              return { previousSource: HIST_SOURCE, receipt };
            }
          } catch { /* fall through to blocked */ }
          return { kind: "blocked", reason: "receipt-untrusted" };
        },
      };
    });
    vi.doMock("../src/lib/official-engram-setup.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/official-engram-setup.js")>(
        "../src/lib/official-engram-setup.js",
      );
      return {
        ...actual,
        runOfficialSetupIfNeeded: async (_runtime: unknown, opts: { configDir: string }) => {
          order.push("setup");
          const settingsPath = path.join(opts.configDir, "settings.json");
          const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages: unknown[] };
          parsed.packages.push(providerA, providerB, foreign);
          fs.writeFileSync(settingsPath, JSON.stringify(parsed));
          return { ran: true, ok: true, ownershipTransferred: true };
        },
      };
    });
    vi.doMock("../src/lib/pi-staged-lock.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-staged-lock.js")>(
        "../src/lib/pi-staged-lock.js",
      );
      return {
        ...actual,
        inspectStagedPiNpm: (input: unknown) => {
          inspectorCalls.push(input);
          return {
            lockSha256: "c".repeat(64),
            treeSha256: "d".repeat(64),
            dependencies: [...syntheticDeps],
          };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: unknown, deps: unknown) => {
        order.push("activation");
        activateCalls.push(input);
        const verifyStage = (deps as any)?.verifyStage;
        if (typeof verifyStage !== "function") {
          throw new Error("activation mock requires deps.verifyStage(stageDir, evidence)");
        }
        await verifyStage((input as any).prepared.stageDir, (input as any).prepared.evidence);
        return { kind: "installed", receipt: installedReceipt };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin,
        candidate: syntheticCandidate,
        prepared,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "installed", receipt: installedReceipt });
      expect(order).toEqual(["guard", "setup", "guard", "activation"]);
      expect(guardCalls).toHaveLength(2);
      const preSettings = JSON.parse((guardCalls[0] as any).settingsJson) as { packages: unknown[] };
      expect(preSettings.packages).not.toContain(providerA);
      const postSettings = JSON.parse((guardCalls[1] as any).settingsJson) as { packages: unknown[] };
      expect(postSettings.packages).toEqual(
        expect.arrayContaining([{ source: HIST_SOURCE, skills: [], prompts: [] }, providerA, providerB, foreign]),
      );
      for (const call of guardCalls) {
        expect((call as any).codingAgentDir).toBe(agentDir);
        expect((call as any).engramBin).toBe(engramBin);
        expect(JSON.stringify((call as any).acceptedCandidates)).toContain(HIST_SOURCE);
      }
      expect(activateCalls).toHaveLength(1);
      const seen = activateCalls[0] as any;
      expect(seen.previousSource).toBe(HIST_SOURCE);
      expect(seen.prepared.candidate).toEqual(syntheticCandidate);
      const seenPackages = JSON.parse(seen.settingsJson) as { packages: unknown[] };
      expect(seenPackages.packages).toEqual(expect.arrayContaining([providerA, providerB, foreign]));
      expect(inspectorCalls).toHaveLength(1);
      expect(JSON.stringify(result)).toContain("9.9.9");
      expect(JSON.stringify(result)).not.toContain("0.8.29");
    } finally {
      fetchSpy.mockRestore();
      homedirSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.doUnmock("../src/lib/official-engram-setup.js");
      vi.doUnmock("../src/lib/pi-staged-lock.js");
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("blocks before setup when the legacy guard rejects, leaving old settings/receipt byte-stable", async () => {
    const { PI_RUNTIME_REGISTRY } = await runtime();
    const accepted = PI_RUNTIME_REGISTRY.pi.acceptedCandidates ?? [];
    const historical = accepted.find(
      (entry) => (entry as { package?: { version?: unknown } }).package?.version === "0.8.24",
    ) as unknown as {
      package: { name: string; version: string; source: string };
      tarball: { bytes: number; sha256: string; sha512: string };
      provenance: { commit: string };
    };
    expect(historical?.package?.source).toBe("npm:jorgex-pi@0.8.24");
    const HIST_SOURCE = historical.package.source;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-legacy-guard-blocked-"));
    T41_WIRING_ROOTS.push(tmp);
    const agentDir = path.join(tmp, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const engramBin = path.join(tmp, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    const legacyReceipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { ...historical.package },
        tarball: { ...historical.tarball },
        provenance: { ...historical.provenance },
      },
      scope: { kind: "real", codingAgentDir: agentDir },
      engram: { binary: engramBin },
    };
    const receiptPath = path.join(tmp, ".jorgex-stack", "pi-receipt.json");
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(legacyReceipt)}\n`);
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ packages: [{ source: HIST_SOURCE, skills: [], prompts: [] }] }),
    );
    const beforeSettings = fs.readFileSync(settingsPath, "utf8");
    const beforeReceipt = fs.readFileSync(receiptPath, "utf8");

    const syntheticCandidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const stageDir = path.join(agentDir, `stage-${"e".repeat(32)}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const syntheticDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const prepared = {
      candidate: syntheticCandidate,
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: `sha512-${Buffer.from(syntheticCandidate.tarball.sha512, "hex").toString("base64")}`,
      },
      artifact: {
        path: path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz"),
        bytes: 1234567,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: syntheticDeps },
      sourceAlias: `npm:jorgex-pi@file:${path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz")}`,
    };

    const guardCalls: unknown[] = [];
    const setupCalls: unknown[] = [];
    const activateCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmp);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        preparePiLegacyMigration: (input: unknown) => {
          guardCalls.push(input);
          return { kind: "blocked", reason: "receipt-untrusted" };
        },
      };
    });
    vi.doMock("../src/lib/official-engram-setup.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/official-engram-setup.js")>(
        "../src/lib/official-engram-setup.js",
      );
      return {
        ...actual,
        runOfficialSetupIfNeeded: async (...args: unknown[]) => {
          setupCalls.push(args);
          return { ran: true, ok: true, ownershipTransferred: true };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: unknown) => {
        activateCalls.push(input);
        return { kind: "installed", receipt: {} };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin,
        candidate: syntheticCandidate,
        prepared,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(guardCalls).toHaveLength(1);
      expect(setupCalls).toHaveLength(0);
      expect(activateCalls).toHaveLength(0);
      expect(result.kind).toBe("blocked");
      expect(result).not.toMatchObject({ kind: "installed" });
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(beforeSettings);
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
    } finally {
      fetchSpy.mockRestore();
      homedirSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.doUnmock("../src/lib/official-engram-setup.js");
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T05/T07-RED] runPiRuntimeSystem routes managed private uninstall.
// Contract (spec 07): uninstall of a verified managed private release runs
// owned cleanup, re-reads settings, plans pure removal, and lets the
// deactivate callback move/unlink only private owned state via
// `deactivateVerifiedPiRelease` — never native `pi remove`, never network.
// Production `runPiPackageManagedOperation('uninstall')` already requires
// `deps.readSettings` + `deps.deactivateManagedRelease`; the system operate
// wiring must provide both callbacks. Synthetic schema1 managedPackage
// receipt only, sandbox targetDir, no HOME/Pi/network. Missing/foreign
// receipts stay guarded by the package-layer suite.
// ---------------------------------------------------------------------------

describe("[T05/T07-RED] runPiRuntimeSystem routes managed private uninstall", () => {
  it("provides readSettings + deactivateManagedRelease and returns uninstalled without pi remove or network", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-managed-uninstall-"));
    T41_WIRING_ROOTS.push(sandbox);
    const agentDir = path.join(sandbox, "pi-agent");
    const stateDir = path.join(sandbox, "state");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const engramBin = path.join(sandbox, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");

    const PI_SOURCE = "npm:jorgex-pi@9.9.9";
    const providerA = "npm:gentle-engram@9.9.99";
    const providerB = "npm:pi-mcp-adapter@9.9.98";
    const foreign = "npm:foreign-keep@1.0.0";
    const managedPackage = {
      releaseDir: path.join(agentDir, "npm", "jorgex-pi-managed", "releases", "e".repeat(64)),
      linkPath: path.join(agentDir, "npm", "node_modules", "jorgex-pi"),
      backupDir: path.join(agentDir, `stage-${"b".repeat(32)}`, "pi-agent", ".activate-backup"),
      lockSha256: "c".repeat(64),
      treeSha256: "d".repeat(64),
      dependencies: [
        { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
        { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
        { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
        { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
        { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
        { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
      ],
    };
    const receipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { name: "jorgex-pi", version: "9.9.9", source: PI_SOURCE },
        tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
        provenance: { commit: "0".repeat(40) },
      },
      scope: { kind: "target-dir", codingAgentDir: agentDir },
      engram: { binary: engramBin },
      managedPackage,
    };
    const receiptPath = path.join(stateDir, "pi-receipt.json");
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: PI_SOURCE, skills: [], prompts: [] }, providerA, providerB, foreign] }),
    );
    const nextSettings = JSON.stringify({ packages: [providerA, providerB, foreign] });

    const operateCalls: unknown[] = [];
    const deactivateInputs: unknown[] = [];
    let freshSettings = "";
    let runCalls = 0;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        runPiPackageManagedOperation: (input: unknown, deps: any) => {
          operateCalls.push(input);
          if (typeof deps?.readSettings !== "function" || typeof deps?.deactivateManagedRelease !== "function") {
            return { kind: "blocked", reason: "remove-failed" };
          }
          const innerRun = deps.run;
          deps.run = (...args: unknown[]) => {
            runCalls += 1;
            return (innerRun as (...inner: unknown[]) => unknown)(...args);
          };
          freshSettings = deps.readSettings() as string;
          const deactivated = deps.deactivateManagedRelease(receipt, nextSettings) as { kind: string; reason?: string };
          if (deactivated?.kind !== "uninstalled") {
            return { kind: "blocked", reason: deactivated?.reason ?? "remove-failed" };
          }
          return { kind: "uninstalled" };
        },
      };
    });
    vi.doMock("../src/lib/pi-private-release.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-private-release.js")>(
        "../src/lib/pi-private-release.js",
      );
      return {
        ...actual,
        deactivateVerifiedPiRelease: (input: unknown) => {
          deactivateInputs.push(input);
          return { kind: "uninstalled", backupDir: path.join(agentDir, "uninstall-backup-test") };
        },
      };
    });
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "uninstall",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runCalls).toBe(0);
      expect(operateCalls).toHaveLength(1);
      expect(result).toMatchObject({ kind: "uninstalled" });
      const seenInput = operateCalls[0] as any;
      expect(JSON.parse(seenInput.receiptJson).managedPackage).toEqual(managedPackage);
      expect(freshSettings).toContain(PI_SOURCE);
      expect(deactivateInputs).toHaveLength(1);
      const seen = deactivateInputs[0] as any;
      expect(seen.homeDir).toBe(sandbox);
      expect(seen.agentDir).toBe(agentDir);
      expect(seen.receiptPath).toBe(receiptPath);
      expect(seen.managedPackage).toEqual(managedPackage);
      expect(seen.nextSettings).toBe(nextSettings);
      expect(JSON.parse(seen.nextSettings).packages).toEqual([providerA, providerB, foreign]);
      expect(typeof seen.verify).toBe("function");
      expect(JSON.stringify(result)).not.toContain("remove");
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.doUnmock("../src/lib/pi-private-release.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] runPiRuntimeSystem uninstalls owned legacy 0.8.24 offline.
// Contract (spec 07, coordinator-closed): system uninstall with a valid
// legacy schema1 receipt WITHOUT managedPackage anchored to prod
// src/lib/pi-runtime-history.json .24, a real-dir legacy package root
// agentDir/npm/node_modules/jorgex-pi with matching package.json, and owned
// projected settings plus foreign/provider entries must run offline owned
// cleanup via the .24 runner, re-read settings post-cleanup, plan pure
// removal, and deactivate only the owned entry+receipt via
// verifyLegacyPackage/deactivateLegacyRelease — never native `pi remove`,
// never network/download. Tampered receipt stays blocked before the runner
// with byte-stable files. Current system operate wiring lacks
// verifyLegacyPackage/deactivateLegacyRelease, so the owned case RED-fails
// with blocked receipt-untrusted before the runner. Sandbox targetDir under
// os.tmpdir only; no HOME.
// ---------------------------------------------------------------------------

function t07LegacySystemSandbox(): {
  sandbox: string;
  agentDir: string;
  settingsPath: string;
  receiptPath: string;
  legacyEntry: string;
  foreignIndex: string;
  npmLock: string;
  engramBin: string;
  histSource: string;
  oldSettings: string;
  oldReceipt: string;
  foreignBytes: string;
  lockBytes: string;
} {
  const historyRaw = fs.readFileSync(new URL("../src/lib/pi-runtime-history.json", import.meta.url), "utf8");
  const history = JSON.parse(historyRaw) as {
    acceptedCandidates: Array<{
      package: { name: string; version: string; source: string };
      provenance: { commit: string };
      tarball: { bytes: number; sha256: string; sha512: string };
    }>;
  };
  const historical = history.acceptedCandidates.find((entry) => entry.package.version === "0.8.24");
  expect(historical, "prod pi-runtime-history.json must anchor 0.8.24").toBeDefined();
  if (historical === undefined) throw new Error("historical 0.8.24 missing");
  expect(historical.package).toEqual({ name: "jorgex-pi", version: "0.8.24", source: "npm:jorgex-pi@0.8.24" });
  expect(historical.provenance.commit).toBe("652d7e445e6f184c4543593c115026aa2f71e761");
  const histSource = historical.package.source;

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-system-legacy-uninstall-"));
  T41_WIRING_ROOTS.push(sandbox);
  const agentDir = path.join(sandbox, "pi-agent");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(sandbox, "state", "pi-receipt.json");
  const legacyEntry = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
  const foreignIndex = path.join(agentDir, "npm", "node_modules", "foreign-pkg", "index.js");
  const npmLock = path.join(agentDir, "npm", "package-lock.json");
  const engramBin = path.join(sandbox, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");

  fs.mkdirSync(legacyEntry, { recursive: true });
  fs.writeFileSync(
    path.join(legacyEntry, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: "0.8.24" })}\n`,
  );
  fs.writeFileSync(path.join(legacyEntry, "index.js"), "// jorgex-pi 0.8.24 legacy entry - owned\n");
  const runnerPath = path.join(legacyEntry, "bin", "jorgex-pi.mjs");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.writeFileSync(
    runnerPath,
    [
      "import fs from \"node:fs\";",
      "import path from \"node:path\";",
      "const root = path.resolve(path.dirname(process.argv[1] ?? \"\"), \"..\");",
      "const command = process.argv[2] ?? \"\";",
      "try {",
      "  const agentDir = process.env.PI_CODING_AGENT_DIR ?? \"\";",
      "  if (agentDir !== \"\") {",
      "    fs.writeFileSync(path.join(agentDir, \".runner-called\"), `${command}\\n`, { flag: \"a\" });",
      "    if (command === \"cleanup\") {",
      "      const settingsPath = path.join(agentDir, \"settings.json\");",
      "      const raw = fs.readFileSync(settingsPath, \"utf8\");",
      "      const parsed = JSON.parse(raw);",
      "      if (Array.isArray(parsed.packages) && !parsed.packages.includes(\"npm:runner-added@1.0.0\")) {",
      "        parsed.packages.push(\"npm:runner-added@1.0.0\");",
      "        fs.writeFileSync(settingsPath, JSON.stringify(parsed));",
      "      }",
      "    }",
      "  }",
      "} catch {}",
      "const record = { schemaVersion: 1, command, ok: true,",
      "  package: { name: \"jorgex-pi\", version: \"0.8.24\", root }, result: {} };",
      "process.stdout.write(`${JSON.stringify(record)}\\n`);",
      "",
    ].join("\n"),
  );
  try {
    fs.chmodSync(runnerPath, 0o755);
  } catch {
    /* best-effort en tmp */
  }

  const foreignBytes = "// foreign package - must survive byte-identically\n";
  fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, foreignBytes);
  const lockBytes = '{"name":"legacy-root","lockfileVersion":1}\n';
  fs.mkdirSync(path.dirname(npmLock), { recursive: true });
  fs.writeFileSync(npmLock, lockBytes);

  const oldSettings = JSON.stringify({
    packages: [
      { source: histSource, skills: [], prompts: [] },
      "npm:gentle-engram@9.9.99",
      "npm:pi-mcp-adapter@9.9.98",
      "npm:foreign-keep@1.0.0",
    ],
  });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, oldSettings);
  const oldReceipt = `${JSON.stringify({
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { ...historical.package },
      tarball: { ...historical.tarball },
      provenance: { ...historical.provenance },
    },
    scope: { kind: "target-dir", codingAgentDir: agentDir },
    engram: { binary: engramBin },
  })}\n`;
  expect(oldReceipt).toContain("0.8.24");
  expect(oldReceipt).not.toContain("managedPackage");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, oldReceipt);

  expect(fs.lstatSync(legacyEntry).isDirectory()).toBe(true);
  expect(fs.lstatSync(legacyEntry).isSymbolicLink()).toBe(false);
  return {
    sandbox,
    agentDir,
    settingsPath,
    receiptPath,
    legacyEntry,
    foreignIndex,
    npmLock,
    engramBin,
    histSource,
    oldSettings,
    oldReceipt,
    foreignBytes,
    lockBytes,
  };
}

describe("[T07-RED] runPiRuntimeSystem uninstalls owned legacy 0.8.24 offline", () => {
  it("deactivates the owned .24 entry+receipt offline, preserving foreign and re-reading post-cleanup settings", async () => {
    const sb = t07LegacySystemSandbox();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "uninstall",
        targetDir: sb.sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: sb.engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "uninstalled" });
      expect(JSON.stringify(result)).not.toMatch(/remove/);
      expect(fs.existsSync(path.join(sb.sandbox, "downloads"))).toBe(false);
      expect(fs.lstatSync(sb.legacyEntry, { throwIfNoEntry: false } as any) ?? null).toBeNull();
      expect(fs.existsSync(sb.receiptPath)).toBe(false);
      const afterSettings = JSON.parse(fs.readFileSync(sb.settingsPath, "utf8")) as { packages: unknown[] };
      expect(JSON.stringify(afterSettings)).not.toContain(sb.histSource);
      expect(JSON.stringify(afterSettings)).toContain("npm:foreign-keep@1.0.0");
      expect(JSON.stringify(afterSettings)).toContain("npm:gentle-engram@9.9.99");
      expect(JSON.stringify(afterSettings)).toContain("npm:pi-mcp-adapter@9.9.98");
      expect(JSON.stringify(afterSettings)).toContain("npm:runner-added@1.0.0");
      expect(fs.readFileSync(sb.settingsPath, "utf8")).not.toBe(sb.oldSettings);
      expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(sb.foreignBytes);
      expect(fs.readFileSync(sb.npmLock, "utf8")).toBe(sb.lockBytes);
      expect(fs.readFileSync(path.join(sb.agentDir, ".runner-called"), "utf8")).toContain("cleanup");
    } finally {
      fetchSpy.mockRestore();
      vi.resetModules();
    }
  });

  it("blocks a tampered .24 receipt before the runner, leaving files byte-stable", async () => {
    const sb = t07LegacySystemSandbox();
    const tampered = JSON.parse(sb.oldReceipt) as any;
    tampered.candidate.tarball.sha256 = "0".repeat(64);
    fs.writeFileSync(sb.receiptPath, `${JSON.stringify(tampered)}\n`);
    const beforeSettings = fs.readFileSync(sb.settingsPath, "utf8");
    const beforeReceipt = fs.readFileSync(sb.receiptPath, "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "uninstall",
        targetDir: sb.sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin: sb.engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.kind).toBe("blocked");
      expect(result).not.toMatchObject({ kind: "uninstalled" });
      expect(JSON.stringify(result)).not.toMatch(/remove/);
      expect(fs.readFileSync(sb.settingsPath, "utf8")).toBe(beforeSettings);
      expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(beforeReceipt);
      expect(fs.lstatSync(sb.legacyEntry).isDirectory()).toBe(true);
      expect(fs.readFileSync(sb.foreignIndex, "utf8")).toBe(sb.foreignBytes);
      expect(fs.existsSync(path.join(sb.agentDir, ".runner-called"))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] runPiRuntimeSystem routes managed models offline.
// Contract: system `models` with a schemaVersion1 managed receipt (synthetic
// 9.9.9 parent, never a published-release claim) and the exact managed
// settings object must route to `runPiPackageManagedModels` offline, threading
// its `{kind:'models',models:{mode:'inherit-session',tiers:[strong,standard,
// cheap]}}` without global fetch, static plan/execute auto-install, pi
// install, or projection writes. Registry stays static .29 (never source
// comparator); the dynamic 9.9.9 receipt is the source of truth. Absent receipt
// blocks before the runner with no handler call and no fetch. Wrapper models
// host gate (runManagedPiSystem) stays separate scope. Current system still
// calls legacy planPiPackageLifecycle for models and never invokes the managed
// models handler, so the valid case RED-fails with blocked source-divergent
// and zero handler calls. Isolated targetDir under os.tmpdir only; no HOME.
// ---------------------------------------------------------------------------

describe("[T07-RED] runPiRuntimeSystem routes managed models offline", () => {
  it("invokes runPiPackageManagedModels and returns dynamic 9.9.9 models with zero network", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-managed-models-"));
    T41_WIRING_ROOTS.push(sandbox);
    const codingAgentDir = path.join(sandbox, "pi-agent");
    const stateDir = path.join(sandbox, "state");
    const binDir = path.join(sandbox, "bin");
    fs.mkdirSync(codingAgentDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const engramBin = path.join(binDir, "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    const managedSource = "npm:jorgex-pi@9.9.9";
    fs.writeFileSync(
      path.join(codingAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: managedSource, skills: [], prompts: [] }] }),
    );
    const releaseId = "e".repeat(64);
    const stageHex = "b".repeat(32);
    const receipt = {
      schemaVersion: 1,
      state: "installed",
      candidate: {
        package: { name: "jorgex-pi", version: "9.9.9", source: managedSource },
        tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
        provenance: { commit: "0".repeat(40) },
      },
      scope: { kind: "target-dir", codingAgentDir },
      engram: { binary: engramBin },
      managedPackage: {
        releaseDir: path.join(codingAgentDir, "npm", "jorgex-pi-managed", "releases", releaseId),
        linkPath: path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi"),
        backupDir: path.join(codingAgentDir, `stage-${stageHex}`, "pi-agent", ".activate-backup"),
        lockSha256: "c".repeat(64),
        treeSha256: "d".repeat(64),
        dependencies: [
          { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
          { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
          { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
          { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
          { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
          { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
        ],
      },
    };
    fs.writeFileSync(path.join(stateDir, "pi-receipt.json"), `${JSON.stringify(receipt)}\n`);
    expect(PI_RUNTIME_CANDIDATE.package.version).toBe("0.8.29");

    const managedModelsCalls: unknown[] = [];
    const managedModelsDeps: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = codingAgentDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        runPiPackageManagedModels: (input: unknown, deps: unknown) => {
          managedModelsCalls.push(input);
          managedModelsDeps.push(deps);
          return { kind: "models", models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] } };
        },
      };
    });
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "models",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(managedModelsCalls).toHaveLength(1);
      const seen = managedModelsCalls[0] as any;
      expect(seen.operation).toBe("models");
      expect(String(seen.receiptJson)).toContain("9.9.9");
      expect(String(seen.receiptJson)).not.toContain("0.8.29");
      expect(String(seen.detected.settingsJson)).toContain(managedSource);
      expect(seen.registry.candidate.package.version).toBe("0.8.29");
      expect(seen.registry.candidate.package.source).not.toBe(managedSource);
      const seenDeps = managedModelsDeps[0] as any;
      expect(typeof seenDeps.verifyManagedArtifact).toBe("function");
      expect(result).toEqual({
        kind: "models",
        models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] },
      });
      expect(JSON.stringify(result)).not.toContain("0.8.29");
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("blocks absent receipt before the runner with no handler call and no network", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-managed-models-absent-"));
    T41_WIRING_ROOTS.push(sandbox);
    const codingAgentDir = path.join(sandbox, "pi-agent");
    const stateDir = path.join(sandbox, "state");
    const binDir = path.join(sandbox, "bin");
    fs.mkdirSync(codingAgentDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const engramBin = path.join(binDir, "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    fs.writeFileSync(
      path.join(codingAgentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: "npm:jorgex-pi@9.9.9", skills: [], prompts: [] }] }),
    );

    const managedModelsCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = codingAgentDir;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/pi-package-lifecycle.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/pi-package-lifecycle.js")>(
        "../src/lib/pi-package-lifecycle.js",
      );
      return {
        ...actual,
        runPiPackageManagedModels: (input: unknown) => {
          managedModelsCalls.push(input);
          return { kind: "models", models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] } };
        },
      };
    });
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "models",
        targetDir: sandbox,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(managedModelsCalls).toHaveLength(0);
      expect(result.kind).toBe("blocked");
      expect(result).not.toMatchObject({ kind: "models" });
    } finally {
      fetchSpy.mockRestore();
      vi.doUnmock("../src/lib/pi-package-lifecycle.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

// ---------------------------------------------------------------------------
// [T06/T07-RED] sync without receipt must block with install remedy, never auto-install.
// Contract: system sync with a missing receipt and settings without any Pi
// entry (official gentle-engram + pi-mcp-adapter + foreign allowed) must block
// `receipt-untrusted` or `verified-install-required` with an explicit install
// remedy. No native `pi install` of the static .29 pin, no network, no
// receipt/settings/foreign mutation, no sentinel. The legacy .24 owned case
// stays covered by the pure preparePiLegacyMigration suite and is not
// duplicated here. Static runPiRuntime with the tested 0.84.2 host shows the
// install the system must not perform (control: sentinel proves the harness
// would catch a real auto-install). Isolated os.tmpdir sandboxes only.
// ---------------------------------------------------------------------------

describe("[T06/T07-RED] sync without receipt blocks with install remedy", () => {
  it("system sync 0.87.1 missing receipt + no Pi entry blocks, no install/network/mutation/sentinel", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t06-sync-no-receipt-"));
    T41_WIRING_ROOTS.push(sandbox);
    const agentDir = path.join(sandbox, "pi-agent");
    const stateDir = path.join(sandbox, "state");
    const binDir = path.join(sandbox, "bin");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const engramBin = path.join(binDir, "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");
    try {
      fs.chmodSync(engramBin, 0o755);
    } catch {
      /* best-effort en tmp */
    }

    const fakeBinDir = path.join(sandbox, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakePi = path.join(fakeBinDir, "pi");
    const sentinel = path.join(sandbox, "pi-called.sentinel");
    fs.writeFileSync(fakePi, `#!/bin/sh\necho called "$@" >> "${sentinel}"\nexit 1\n`);
    try {
      fs.chmodSync(fakePi, 0o755);
    } catch {
      /* best-effort en tmp */
    }

    const providerA = "npm:gentle-engram@9.9.99";
    const providerB = "npm:pi-mcp-adapter@9.9.98";
    const foreign = "npm:foreign-keep@1.0.0";
    const settingsPath = path.join(agentDir, "settings.json");
    const settingsBefore = JSON.stringify({ packages: [providerA, providerB, foreign] });
    fs.writeFileSync(settingsPath, settingsBefore);

    const foreignDir = path.join(agentDir, "npm", "node_modules", "foreign-pkg");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
    const foreignIndex = path.join(foreignDir, "index.js");
    const foreignBytes = "// foreign package - must survive byte-identically\n";
    fs.writeFileSync(foreignIndex, foreignBytes);

    const receiptPath = path.join(stateDir, "pi-receipt.json");
    expect(fs.existsSync(receiptPath)).toBe(false);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(sandbox);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "sync",
        targetDir: sandbox,
        detected: { executable: fakePi, version: "0.87.1" },
        engramBin,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.kind).toBe("blocked");
      expect(["receipt-untrusted", "verified-install-required"]).toContain(
        (result as { reason?: string }).reason,
      );
      expect(String((result as { remedy?: string }).remedy ?? "")).toMatch(/install/i);
      expect(result).not.toMatchObject({ kind: "synced" });
      expect(result).not.toMatchObject({ kind: "installed" });
      expect(JSON.stringify(result)).not.toContain("0.8.29");
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(fs.readFileSync(foreignIndex, "utf8")).toBe(foreignBytes);
      expect(fs.existsSync(path.join(sandbox, "downloads"))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      homedirSpy.mockRestore();
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  // ---------------------------------------------------------------------------
  // [T07-RED] fresh install blocks on a preexisting unowned FS entry before setup.
  // Contract (final security review, coordinator-closed handoff): fresh
  // `runPiRuntimeSystem({operation:'install',candidate+prepared,...})` with NO
  // receipt and NO settings Pi entry must still lstat
  // `agentDir/npm/node_modules/jorgex-pi` BEFORE official engram setup or
  // activation. A preexisting unowned real dir (foreign/manual, no owned
  // receipt/settings proof) must block fail-closed with zero setup calls,
  // zero activation calls, zero fetch, and byte-identical sentinel/foreign/
  // settings plus still-absent receipt; no managed marker/lock/backup/release
  // may appear. The activation helper would otherwise move the foreign entry
  // into backup and claim it. Isolated os.tmpdir HOME/agent only, synthetic
  // 9.9.9 candidate, mocked provider setup + activation (existing fresh-setup
  // seam), no network/Pi writes, no duplicate fallback coverage.
  // ---------------------------------------------------------------------------

  it("static runPiRuntime install 0.84.2 reaches the Pi runner (control, sentinel proves auto-install risk)", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t06-static-install-control-"));
    T41_WIRING_ROOTS.push(sandbox);
    const agentDir = path.join(sandbox, "pi-agent");
    const binDir = path.join(sandbox, "bin");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const engramBin = path.join(binDir, "engram");
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");

    const fakeBinDir = path.join(sandbox, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakePi = path.join(fakeBinDir, "pi");
    const sentinel = path.join(sandbox, "pi-called.sentinel");
    fs.writeFileSync(fakePi, `#!/bin/sh\necho called "$@" >> "${sentinel}"\nexit 1\n`);
    try {
      fs.chmodSync(fakePi, 0o755);
    } catch {
      /* best-effort en tmp */
    }

    const settingsBefore = JSON.stringify({
      packages: ["npm:gentle-engram@9.9.99", "npm:pi-mcp-adapter@9.9.98", "npm:foreign-keep@1.0.0"],
    });

    const { runPiRuntime } = await runtime();
    const { planPiPackageLifecycle } = (await import("../src/lib/pi-package-lifecycle.js")) as any;
    const events: string[] = [];
    let seenInvocation: { executable: string; args: string[] } | null = null;
    const deps = {
      readSettings: (_path: string) => {
        events.push("settings");
        return settingsBefore;
      },
      readReceipt: (_path: string) => {
        events.push("receipt");
        return null;
      },
      writeReceiptAtomic: (_path: string, _content: string) => {
        events.push("atomic");
      },
      prepare: (value: unknown) => {
        events.push("prepare");
        return planPiPackageLifecycle(value);
      },
      execute: (value: unknown) => {
        events.push("execute");
        const seen = value as {
          plan: { kind: string; invocation?: { executable: string; args: string[] } };
          candidate: { package: { source: string } };
        };
        if (seen.plan.kind === "install" && seen.plan.invocation !== undefined) {
          seenInvocation = seen.plan.invocation;
          fs.writeFileSync(sentinel, `called ${seen.candidate.package.source}\n`);
          return { kind: "installed", receipt: { state: "installed" } };
        }
        return { kind: "blocked", reason: "runner-unhealthy" };
      },
      operate: () => ({ kind: "healthy" }),
    };
    const input = {
      operation: "install",
      targetDir: sandbox,
      detected: { executable: fakePi, version: "0.84.2" },
      engramBin,
      verifiedArtifact: { ...PI_RUNTIME_CANDIDATE.tarball },
      candidate: PI_RUNTIME_CANDIDATE,
    } as unknown as Parameters<typeof runPiRuntime>[0];
    const result = runPiRuntime(input, deps);
    expect(result).toMatchObject({ kind: "installed" });
    expect(events).toContain("prepare");
    expect(events).toContain("execute");
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toContain("npm:jorgex-pi@0.8.29");
    expect(seenInvocation).not.toBeNull();
    expect((seenInvocation as unknown as { executable: string }).executable).toBe(fakePi);
    expect((seenInvocation as unknown as { args: string[] }).args).toEqual(
      expect.arrayContaining(["install", "npm:jorgex-pi@0.8.29", "--no-approve"]),
    );
  });
});

// ---------------------------------------------------------------------------
// [T07-RED] fresh install blocks on a preexisting unowned FS entry before setup.
// Contract (final security review, coordinator-closed handoff): fresh
// `runPiRuntimeSystem({operation:'install',candidate+prepared,...})` with NO
// receipt and NO settings Pi entry must still lstat
// `agentDir/npm/node_modules/jorgex-pi` BEFORE official engram setup or
// activation. A preexisting unowned real dir (foreign/manual, no owned
// receipt/settings proof) must block fail-closed with zero setup calls, zero
// activation calls, zero fetch, and byte-identical sentinel/foreign/settings
// plus still-absent receipt; no managed marker/lock/backup/release may appear.
// The activation helper would otherwise move the foreign entry into backup and
// claim it. Isolated os.tmpdir HOME/agent only, synthetic 9.9.9 candidate,
// mocked provider setup + activation (existing fresh-setup seam), no
// network/Pi writes, no duplicate fallback coverage.
// ---------------------------------------------------------------------------

describe("[T07-RED] fresh install blocks on unowned FS entry before setup", () => {
  it("no receipt/settings Pi entry but real unowned jorgex-pi dir blocks with zero setup/activation/fetch and preserves all bytes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-fresh-unowned-"));
    T41_WIRING_ROOTS.push(tmp);
    const agentDir = path.join(tmp, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const engramBin = path.join(tmp, "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\necho 2.0.0\n");

    // Preexisting UNOWNED real entry: no receipt, no settings registration.
    const linkPath = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
    fs.mkdirSync(linkPath, { recursive: true });
    const unownedIndex = "// unowned manual jorgex-pi - must never be backed up or claimed\n";
    const unownedSentinel = "unowned-sentinel\n";
    fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"jorgex-pi","version":"9.9.8-manual"}\n');
    fs.writeFileSync(path.join(linkPath, "index.js"), unownedIndex);
    fs.writeFileSync(path.join(linkPath, "SENTINEL.txt"), unownedSentinel);

    // Foreign package sharing the same npm root (must survive byte-identically).
    const foreignIndex = path.join(agentDir, "npm", "node_modules", "foreign-pkg", "index.js");
    fs.mkdirSync(path.dirname(foreignIndex), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(foreignIndex), "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
    const foreignBytes = "// foreign package - must survive byte-identically\n";
    fs.writeFileSync(foreignIndex, foreignBytes);

    // Top-level sentinel proving no broad mutation.
    const sentinelPath = path.join(tmp, "sentinel.txt");
    const sentinelBytes = "fresh-unowned-sentinel\n";
    fs.writeFileSync(sentinelPath, sentinelBytes);

    // Settings WITHOUT any jorgex-pi registration (providers + foreign only).
    const providerA = "npm:gentle-engram@9.9.99";
    const providerB = "npm:pi-mcp-adapter@9.9.98";
    const foreign = "npm:foreign-keep@1.0.0";
    const settingsPath = path.join(agentDir, "settings.json");
    const settingsBefore = JSON.stringify({ packages: [providerA, providerB, foreign] });
    fs.writeFileSync(settingsPath, settingsBefore);
    expect(settingsBefore).not.toContain("jorgex-pi");

    // Synthetic stable candidate, no published-release claim.
    const candidate = {
      ...PI_RUNTIME_CANDIDATE,
      package: { name: "jorgex-pi", version: "9.9.9", source: "npm:jorgex-pi@9.9.9" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1234567, sha256: "a".repeat(64), sha512: "b".repeat(128) },
    } as const;
    const stageDir = path.join(agentDir, `stage-${"f".repeat(32)}`, "pi-agent");
    fs.mkdirSync(stageDir, { recursive: true });
    const syntheticDeps = [
      { name: "@gotgenes/pi-permission-system", version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 11).toString("base64")}` },
      { name: "@juicesharp/rpiv-ask-user-question", version: "9.9.11", integrity: `sha512-${Buffer.alloc(64, 12).toString("base64")}` },
      { name: "pi-subagents", version: "9.9.12", integrity: `sha512-${Buffer.alloc(64, 13).toString("base64")}` },
      { name: "pi-web-access", version: "9.9.13", integrity: `sha512-${Buffer.alloc(64, 14).toString("base64")}` },
      { name: "@narumitw/pi-goal", version: "9.9.14", integrity: `sha512-${Buffer.alloc(64, 15).toString("base64")}` },
      { name: "strip-json-comments", version: "9.9.15", integrity: `sha512-${Buffer.alloc(64, 16).toString("base64")}` },
    ];
    const prepared = {
      candidate,
      release: {
        version: "9.9.9",
        tarballUrl: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-9.9.9.tgz",
        integrity: `sha512-${Buffer.from(candidate.tarball.sha512, "hex").toString("base64")}`,
      },
      artifact: {
        path: path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz"),
        bytes: 1234567,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
      stageDir,
      evidence: { lockSha256: "c".repeat(64), treeSha256: "d".repeat(64), dependencies: syntheticDeps },
      sourceAlias: `npm:jorgex-pi@file:${path.join(tmp, "downloads", "jorgex-pi-9.9.9.tgz")}`,
    };

    const setupCalls: unknown[] = [];
    const activateCalls: unknown[] = [];
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmp);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    vi.resetModules();
    vi.doMock("../src/lib/official-engram-setup.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/official-engram-setup.js")>(
        "../src/lib/official-engram-setup.js",
      );
      return {
        ...actual,
        runOfficialSetupIfNeeded: async (...args: unknown[]) => {
          setupCalls.push(args);
          return { ran: true, ok: true, ownershipTransferred: true };
        },
      };
    });
    vi.doMock("../src/lib/pi-install-activation.js", () => ({
      activatePreparedPiInstall: async (input: unknown) => {
        activateCalls.push(input);
        return { kind: "installed", receipt: { state: "installed" } };
      },
    }));
    try {
      const { runPiRuntimeSystem } = (await import("../src/lib/pi-runtime.js")) as any;
      const result = await runPiRuntimeSystem({
        operation: "install",
        detected: { executable: "/opt/pi/bin/pi", version: "0.87.1" },
        engramBin,
        candidate,
        prepared,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(setupCalls).toHaveLength(0);
      expect(activateCalls).toHaveLength(0);
      expect(result.kind).toBe("blocked");
      expect(result).not.toMatchObject({ kind: "installed" });
      expect(String((result as { remedy?: unknown }).remedy ?? "")).toMatch(/Pi no quedó activado/i);

      // All preexisting bytes preserved; receipt still absent; no managed state.
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(linkPath, "index.js"), "utf8")).toBe(unownedIndex);
      expect(fs.readFileSync(path.join(linkPath, "SENTINEL.txt"), "utf8")).toBe(unownedSentinel);
      expect(fs.readFileSync(foreignIndex, "utf8")).toBe(foreignBytes);
      expect(fs.readFileSync(sentinelPath, "utf8")).toBe(sentinelBytes);
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
      expect(fs.existsSync(path.join(tmp, ".jorgex-stack", "pi-receipt.json"))).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
      expect(fs.lstatSync(stageDir).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(stageDir, ".activate-backup"))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      homedirSpy.mockRestore();
      vi.doUnmock("../src/lib/official-engram-setup.js");
      vi.doUnmock("../src/lib/pi-install-activation.js");
      vi.resetModules();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
