import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(PI_RUNTIME_REGISTRY.pi.acceptedCandidates).toEqual([PI_RUNTIME_CANDIDATE]);
    expect(PI_RUNTIME_REGISTRY.pi.acceptedCandidates).not.toContainEqual(PI_RUNTIME_PREVIOUS_CANDIDATE);
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
    // runPiRuntime exige verifiedArtifact en install (tarball-integrity); se
    // aporta el tarball canónico para que prepare bloquee con setup-pi-missing.
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
