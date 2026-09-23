import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import pin from "./pi-runtime-pin.json" with { type: "json" };
import history from "./pi-runtime-history.json" with { type: "json" };
import { dataDir } from "./paths.js";
import { preparePiManagedInstall, type PiInstallPreflightResult } from "./pi-install-preflight.js";
import {
  activatePreparedPiInstall,
  type PreparedPiInstallEvidence,
} from "./pi-install-activation.js";
import { inspectStagedPiNpm, inventoryTreeSha256 } from "./pi-staged-lock.js";
import { smokeStagedPiRuntime } from "./pi-stage-smoke.js";
import { verifyCachedPiArtifact } from "./pi-cached-artifact.js";
import { writeText } from "./fsx.js";
import { createBackup } from "./backup.js";
import { detectEngram, lookPath, planDetectedBinCommand } from "./detect.js";
import type { EngramInstallResult } from "./engram-install.js";
import {
  executePiPackageLifecycle,
  planPiPackageLifecycle,
  runPiPackageManagedOperation,
  runPiPackageManagedSync,
  type PiAcceptedCandidate,
  type PiPackageReceipt,
  type PiRuntimeCandidate,
} from "./pi-package-lifecycle.js";

export const PI_RUNTIME_CANDIDATE = {
  ...pin,
  pi: {
    testedVersions: ["0.84.2", "0.85.1"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
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
    ],
    runner: {
      bin: "jorgex-pi",
      commands: ["status", "doctor", "models", "sync", "upgrade", "cleanup"],
      schemaVersion: 1,
      maxStdoutBytes: 65_536,
    },
    managedExternalWrites: [
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "settings.json",
        semantics: "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair plus first-visit theme=JorgeX, quietStartup=true, and hideThinkingBlock=true defaults; preserve foreign halves and existing experience values; cleanup removes only receipt-owned exact values",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "models.json",
        semantics: "merge missing providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow=872000; cleanup removes only receipt-owned exact values",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "jorgex-pi/sol-lifecycle.v1.json",
        semantics: "record field, container, and file ownership; remove the receipt when empty",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "extensions/pi-permission-system/config.json",
        semantics: "seed the generated permission policy only when absent; publish exclusively, preserve preexisting or invalid user state, and remove only an exact owned copy during cleanup",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "jorgex-pi/permissions-lifecycle.v1.json",
        semantics: "record initialization and exact permission-config ownership without storing user configuration or credentials",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "jorgex-pi/permissions-backups",
        semantics: "retain cleanup backups of exact owned permission policy bytes",
      },
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "jorgex-pi/experience-lifecycle.v1.json",
        semantics: "record first initialization and exact ownership of missing theme, quietStartup, and hideThinkingBlock fields; preserve replacements and do not reseed after initialization",
      },
    ],
  },
} as const;

export const PI_RUNTIME_REGISTRY = {
  pi: {
    id: "pi",
    kind: "package-managed",
    source: PI_RUNTIME_CANDIDATE.package.source,
    tarball: PI_RUNTIME_CANDIDATE.tarball,
    pi: PI_RUNTIME_CANDIDATE.pi,
    candidate: PI_RUNTIME_CANDIDATE,
    // Offline RECOVERY identity only from immutable Stack tag
    // v1.9.51:src/lib/pi-runtime-pin.json (jorgex-pi@0.8.24). Never a next
    // install candidate or URL; the productive selector stays 0.8.29. Old Pi
    // 0.8.24 runner is schema1/bin jorgex-pi/maxStdout65536 with
    // status,doctor,models,sync,cleanup (no upgrade) and legacy
    // mcp-adapter-v1 (not engram-official-bridge-v1/permissions-upgrade-v1).
    // Minimal PiAcceptedCandidate (package/tarball/provenance/runner only);
    // the current PiRuntimeCandidate remains structurally assignable.
    acceptedCandidates: [PI_RUNTIME_CANDIDATE, ...(history.acceptedCandidates as readonly PiAcceptedCandidate[])],
  },
} as const;

export type PiRuntimeOperation = "install" | "sync" | "models" | "doctor" | "uninstall" | "update";

export type PiEngramDecision =
  | { kind: "existing"; bin: string; scope: "host" | "target-dir" }
  | { kind: "offer"; accepted: false }
  | { kind: "blocked"; reason: string; remedy: string };

export async function resolvePiEngramRequirement(
  input: { targetDir?: string; interactive: boolean; yes: boolean },
  deps: {
    detectHost(): string | null;
    detectTarget(targetDir: string): string | null;
    confirm(input: { message: string; initialValue: false }): Promise<boolean>;
    /** Reuses Stack's verified latest-stable installer and returns its structured outcome. */
    installShared(): Promise<EngramInstallResult>;
  },
): Promise<PiEngramDecision> {
  if (input.targetDir !== undefined) {
    const targetBin = deps.detectTarget(input.targetDir);
    return targetBin === null
      ? {
          kind: "blocked",
          reason: "engram-missing-target",
          remedy: "Añade el binario Engram dentro del target-dir antes de reintentar.",
        }
      : { kind: "existing", bin: targetBin, scope: "target-dir" };
  }
  const existing = deps.detectHost();
  if (existing !== null) return { kind: "existing", bin: existing, scope: "host" };
  if (input.yes || !input.interactive) {
    return {
      kind: "blocked",
      reason: "engram-required",
      remedy: "Instala Engram de forma interactiva o configura ENGRAM_BIN antes de reintentar.",
    };
  }
  const accepted = await deps.confirm({
    message: "Engram es obligatorio para JorgeX Pi. ¿Instalar ahora el binario oficial verificado?",
    initialValue: false,
  });
  if (!accepted) return { kind: "offer", accepted: false };
  const installed = await deps.installShared();
  if (!installed.ok) {
    return {
      kind: "blocked",
      reason: "engram-install-failed",
      remedy: `La instalación de Engram falló: ${installed.reason} Instala Engram manualmente o configura ENGRAM_BIN antes de reintentar.`,
    };
  }
  const detected = deps.detectHost();
  return detected === null
    ? {
        kind: "blocked",
        reason: "engram-install-unverified",
        remedy: "La instalación terminó, pero Engram no quedó detectable; configura ENGRAM_BIN.",
      }
    : { kind: "existing", bin: detected, scope: "host" };
}

export interface PiRuntimeInput {
  operation: PiRuntimeOperation;
  targetDir?: string;
  detected: { executable: string; version: string };
  engramBin: string | null;
  verifiedArtifact?: { bytes: number; sha256: string; sha512: string };
  /**
   * Injected Pi runtime candidate (resolver + verified stage). Required for
   * deliberate install: without it install blocks before any prepare/execute
   * and never falls back to the static pin. Non-install flows keep the static
   * registry until the T07 offline-receipt work.
   */
  candidate?: PiRuntimeCandidate;
  /**
   * Trusted preflight proof (output of preparePiManagedInstall, threaded by
   * the wrapper, never user CLI input). Install with a matching candidate
   * routes this prepared stage to activation; without it install stays
   * stage-unverified and the old static acquisition never runs.
   */
  prepared?: PiInstallPreflightResult;
  /** Explicit opt-in to rewrite owned/absent Pi policy. Seed-only unless true with the upgrade capability. */
  upgradePermissions?: boolean;
}

type RuntimeResult = {
  kind: string;
  reason?: string;
  remedy?: string;
  receipt?: unknown;
  [key: string]: unknown;
};

export interface PiRuntimeDeps {
  readSettings(path: string): string;
  readReceipt(path: string): string | null;
  writeReceiptAtomic(path: string, content: string): void;
  prepare(input: unknown): unknown;
  execute(input: unknown): RuntimeResult;
  operate(input: unknown): RuntimeResult;
}

interface PiRuntimePaths {
  codingAgentDir: string;
  receiptPath: string;
  packageRunner: string;
  environment: Record<string, string>;
}

interface FlatPiCandidate {
  source: string;
  bytes: number;
  sha256: string;
  sha512: string;
  package?: PiRuntimeCandidate["package"];
  provenance?: PiRuntimeCandidate["provenance"];
  capabilities?: readonly string[];
}

type VerifiedInstallResult =
  | { kind: "installed"; receipt: PiPackageReceipt }
  | { kind: "blocked"; reason: string };

interface VerifiedInstallDeps {
  download(destination: string): { path: string; bytes: number; sha256: string; sha512: string };
  backupSettings(): void;
  run(invocation: {
    executable: string;
    args: string[];
    environment: Record<string, string>;
  }): { exitCode: number; stdout: string; stderr: string };
  readSettings(): string;
  rewriteSettings(content: string): void;
  writeReceiptAtomic(content: string): void;
}

function flatCandidateReceipt(
  candidate: FlatPiCandidate,
  scope: PiPackageReceipt["scope"],
  state: PiPackageReceipt["state"],
  engramBin: string,
): PiPackageReceipt {
  const match = /^npm:jorgex-pi@([^\s]+)$/.exec(candidate.source);
  const packageValue = candidate.package ?? {
    name: "jorgex-pi",
    version: match?.[1] ?? PI_RUNTIME_CANDIDATE.package.version,
    source: candidate.source,
  };
  return {
    schemaVersion: 1,
    state,
    candidate: {
      package: packageValue,
      tarball: { bytes: candidate.bytes, sha256: candidate.sha256, sha512: candidate.sha512 },
      provenance: candidate.provenance ?? { commit: PI_RUNTIME_CANDIDATE.provenance.commit },
    },
    scope,
    engram: { binary: engramBin },
  };
}

function normalizeInstalledSource(settingsJson: string, alias: string, canonical: string): string | null {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packages = Reflect.get(parsed, "packages");
    if (!Array.isArray(packages)) return null;
    const sourceOf = (entry: unknown): unknown => entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Reflect.get(entry, "source") : entry;
    if (packages.filter((entry) => sourceOf(entry) === alias).length !== 1
      || packages.some((entry) => sourceOf(entry) === canonical)) return null;
    Reflect.set(parsed, "packages", packages.map((entry) => {
      if (sourceOf(entry) !== alias) return entry;
      return typeof entry === "string" ? canonical : { ...entry, source: canonical };
    }));
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function healthyDoctor(stdout: string, stderr: string, packageRunner: string, candidate: FlatPiCandidate): boolean {
  if (stderr !== "" || !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) return false;
  try {
    const record: unknown = JSON.parse(stdout.slice(0, -1));
    if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
    const packageValue = Reflect.get(record, "package");
    const result = Reflect.get(record, "result");
    return Reflect.get(record, "schemaVersion") === 1
      && Reflect.get(record, "command") === "doctor"
      && Reflect.get(record, "ok") === true
      && packageValue !== null && typeof packageValue === "object"
      && Reflect.get(packageValue, "name") === "jorgex-pi"
      && Reflect.get(packageValue, "version") === (candidate.package?.version ?? /^npm:jorgex-pi@([^\s]+)$/.exec(candidate.source)?.[1])
      && path.resolve(packageRunner) === path.resolve(String(Reflect.get(packageValue, "root")), "bin", "jorgex-pi.mjs")
      && result !== null && typeof result === "object" && Reflect.get(result, "healthy") === true;
  } catch {
    return false;
  }
}

function provisionalPendingDoctor(exitCode: number, stdout: string, stderr: string, packageRunner: string, candidate: FlatPiCandidate): boolean {
  const capabilities = candidate.capabilities ?? PI_RUNTIME_CANDIDATE.contract.capabilities;
  if (!capabilities.includes("initialization-diagnostics-v1")) return false;
  if (exitCode !== 1 || stderr !== "" || !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) return false;
  try {
    const record: unknown = JSON.parse(stdout.slice(0, -1));
    if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["command", "error", "ok", "package", "result", "schemaVersion"])) return false;
    if (Reflect.get(record, "schemaVersion") !== 1) return false;
    if (Reflect.get(record, "command") !== "doctor") return false;
    if (Reflect.get(record, "ok") !== false) return false;
    const packageValue = Reflect.get(record, "package");
    if (packageValue === null || typeof packageValue !== "object" || Array.isArray(packageValue)) return false;
    if (JSON.stringify(Object.keys(packageValue).sort()) !== JSON.stringify(["name", "root", "version"])) return false;
    if (Reflect.get(packageValue, "name") !== "jorgex-pi") return false;
    if (Reflect.get(packageValue, "version") !== (candidate.package?.version ?? /^npm:jorgex-pi@([^\s]+)$/.exec(candidate.source)?.[1])) return false;
    if (path.resolve(packageRunner) !== path.resolve(String(Reflect.get(packageValue, "root")), "bin", "jorgex-pi.mjs")) return false;
    const result = Reflect.get(record, "result");
    if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
    if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["checks", "healthy"])) return false;
    if (Reflect.get(result, "healthy") !== false) return false;
    const checks = Reflect.get(result, "checks");
    if (!Array.isArray(checks) || checks.length !== 5) return false;
    const expectedIds = ["package", "engram", "context7", "permissions", "experience"];
    for (let index = 0; index < 5; index++) {
      const check = checks[index];
      if (check === null || typeof check !== "object" || Array.isArray(check)) return false;
      if (JSON.stringify(Object.keys(check).sort()) !== JSON.stringify(["id", "status"])) return false;
      if (Reflect.get(check, "id") !== expectedIds[index]) return false;
      const status = Reflect.get(check, "status");
      if (index < 3) {
        if (status !== "ok") return false;
      } else if (status !== "ok" && status !== "error") return false;
    }
    if (Reflect.get(checks[3], "status") === "ok" && Reflect.get(checks[4], "status") === "ok") return false;
    const errorValue = Reflect.get(record, "error");
    if (errorValue === null || typeof errorValue !== "object" || Array.isArray(errorValue)) return false;
    if (JSON.stringify(Object.keys(errorValue).sort()) !== JSON.stringify(["code", "message", "phase", "remedy"])) return false;
    return Reflect.get(errorValue, "phase") === "initialization"
      && Reflect.get(errorValue, "code") === "INITIALIZATION_REQUIRED"
      && Reflect.get(errorValue, "message") === "Pi initialization is pending: run sync to complete first initialization."
      && Reflect.get(errorValue, "remedy") === "Run jorgex-pi sync --json and retry.";
  } catch {
    return false;
  }
}

export function installPiFromVerifiedTarball(
  input: {
    targetDir?: string;
    piExecutable: string;
    engramBin: string;
    candidate: FlatPiCandidate;
  },
  deps: VerifiedInstallDeps,
): VerifiedInstallResult {
  const paths = input.targetDir === undefined
    ? userPaths(input.engramBin, input.piExecutable)
    : targetPaths(input.targetDir, input.engramBin, input.piExecutable);
  const destination = input.targetDir === undefined
    ? path.join(dataDir(), "packages", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`)
    : path.join(path.resolve(input.targetDir), "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
  const artifact = deps.download(destination);
  if (artifact.bytes !== input.candidate.bytes
    || artifact.sha256 !== input.candidate.sha256
    || artifact.sha512 !== input.candidate.sha512) {
    return { kind: "blocked", reason: "tarball-integrity" };
  }
  deps.backupSettings();
  const scope = {
    kind: input.targetDir === undefined ? "real" as const : "target-dir" as const,
    codingAgentDir: path.resolve(paths.codingAgentDir),
  };
  const installing = flatCandidateReceipt(input.candidate, scope, "installing", input.engramBin);
  deps.writeReceiptAtomic(`${JSON.stringify(installing)}\n`);
  const alias = `npm:jorgex-pi@file:${artifact.path}`;
  const installed = deps.run({
    executable: input.piExecutable,
    args: ["install", alias, "--no-approve"],
    environment: paths.environment,
  });
  if (installed.exitCode !== 0 || installed.stderr !== "") return { kind: "blocked", reason: "pi-install-failed" };
  const normalized = normalizeInstalledSource(deps.readSettings(), alias, input.candidate.source);
  if (normalized === null) return { kind: "blocked", reason: "settings-corrupt" };
  deps.rewriteSettings(normalized);
  const doctor = deps.run({
    executable: process.execPath,
    args: [paths.packageRunner, "doctor", "--json"],
    environment: paths.environment,
  });
  const healthy = doctor.exitCode === 0 && healthyDoctor(doctor.stdout, doctor.stderr, paths.packageRunner, input.candidate);
  const pending = provisionalPendingDoctor(doctor.exitCode, doctor.stdout, doctor.stderr, paths.packageRunner, input.candidate);
  if (!healthy && !pending) {
    return { kind: "blocked", reason: "runner-unhealthy" };
  }
  const receipt = flatCandidateReceipt(input.candidate, scope, "installed", input.engramBin);
  deps.writeReceiptAtomic(`${JSON.stringify(receipt)}\n`);
  return { kind: "installed", receipt };
}

function runtimePath(piExecutable?: string): string {
  const entries = process.platform === "win32"
    ? [piExecutable === undefined ? null : path.dirname(piExecutable), path.dirname(process.execPath), process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : null]
    : [piExecutable === undefined ? null : path.dirname(piExecutable), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(entries.filter((entry): entry is string => entry !== null))].join(path.delimiter);
}

function targetPaths(targetDir: string, engramBin: string | null, piExecutable?: string): PiRuntimePaths {
  const root = path.resolve(targetDir);
  const codingAgentDir = path.join(root, "pi-agent");
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  return {
    codingAgentDir,
    receiptPath: path.join(root, "state", "pi-receipt.json"),
    packageRunner: path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs"),
    environment: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      npm_config_cache: path.join(root, "npm-cache"),
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      PI_CODING_AGENT_DIR: codingAgentDir,
      ...(engramBin === null ? {} : { ENGRAM_BIN: engramBin }),
      PATH: runtimePath(piExecutable),
    },
  };
}

function userPaths(engramBin: string | null, piExecutable?: string): PiRuntimePaths {
  const home = os.homedir();
  const codingAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  return {
    codingAgentDir,
    receiptPath: path.join(dataDir(), "pi-receipt.json"),
    packageRunner: path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs"),
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"),
      TMPDIR: os.tmpdir(),
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      PI_CODING_AGENT_DIR: codingAgentDir,
      ...(engramBin === null ? {} : { ENGRAM_BIN: engramBin }),
      PATH: runtimePath(piExecutable),
    },
  };
}

function persistReturnedReceipt(result: RuntimeResult, paths: PiRuntimePaths, deps: PiRuntimeDeps): void {
  if (result.receipt !== undefined) {
    deps.writeReceiptAtomic(paths.receiptPath, `${JSON.stringify(result.receipt)}\n`);
  }
}

export function runPiRuntime(input: PiRuntimeInput, deps: PiRuntimeDeps): RuntimeResult {
  if (input.engramBin === null && input.operation !== "uninstall") {
    return {
      kind: "blocked",
      reason: "engram-missing",
      remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
    };
  }
  if (input.operation === "install" && input.candidate === undefined) {
    return {
      kind: "blocked",
      reason: "candidate-missing",
      remedy: "Aporta el candidato Pi verificado (resolver + stage) antes de reintentar; install deliberado nunca usa el pin estático.",
    };
  }
  if (input.operation === "install" && input.verifiedArtifact === undefined) {
    return { kind: "blocked", reason: "tarball-integrity" };
  }

  const candidate = input.candidate ?? PI_RUNTIME_CANDIDATE;
  const paths = input.targetDir === undefined
    ? userPaths(input.engramBin, input.detected.executable)
    : targetPaths(input.targetDir, input.engramBin, input.detected.executable);
  const settingsJson = deps.readSettings(path.join(paths.codingAgentDir, "settings.json"));
  const receiptJson = deps.readReceipt(paths.receiptPath);
  const lifecycleInput = {
    candidate,
    observedTarball: input.verifiedArtifact ?? candidate.tarball,
    pi: {
      executable: input.detected.executable,
      version: input.detected.version,
      packageRunner: paths.packageRunner,
      settingsJson,
    },
    engramBin: input.engramBin,
    receiptJson,
    scope: {
      kind: input.targetDir === undefined ? "real" : "target-dir",
      codingAgentDir: paths.codingAgentDir,
      receiptPath: paths.receiptPath,
      environment: paths.environment,
    },
  };

  if (input.operation === "install" || input.operation === "sync" || input.operation === "models") {
    const plan = deps.prepare(lifecycleInput);
    if (plan !== null && typeof plan === "object" && Reflect.get(plan, "kind") === "blocked") {
      return plan as RuntimeResult;
    }
    const result = deps.execute({
      operation: input.operation,
      plan,
      candidate,
      packageRunner: paths.packageRunner,
      environment: paths.environment,
      ...(input.upgradePermissions === true ? { upgradePermissions: true as const } : {}),
    });
    persistReturnedReceipt(result, paths, deps);
    return result;
  }

  const result = deps.operate({
    operation: input.operation,
    interactive: false,
    registry: input.candidate === undefined ? PI_RUNTIME_REGISTRY.pi : {
      ...PI_RUNTIME_REGISTRY.pi,
      source: candidate.package.source,
      tarball: candidate.tarball,
      pi: candidate.pi,
      candidate,
      acceptedCandidates: [candidate],
    },
    detected: {
      executable: input.detected.executable,
      packageRunner: paths.packageRunner,
      settingsJson,
    },
    engramBin: input.engramBin,
    receiptJson,
    paths: {
      targetDir: input.targetDir !== undefined,
      codingAgentDir: paths.codingAgentDir,
      receiptPath: paths.receiptPath,
      environment: paths.environment,
    },
    removeArgs: ["remove", candidate.package.source, "--no-approve"],
  });
  persistReturnedReceipt(result, paths, deps);
  return result;
}

export interface PiRuntimeDetection {
  id: "pi";
  name: "Pi";
  installed: boolean;
  executable: string | null;
  version: string | null;
  codingAgentDir: string;
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function packageVersionFromExecutable(executable: string): string | null {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(executable));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 8; depth++) {
    const manifests = [
      path.join(current, "package.json"),
      path.join(current, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ];
    for (const manifest of manifests) {
      try {
        const parsed = readJsonFile(manifest);
        if (parsed !== null && typeof parsed === "object"
          && Reflect.get(parsed, "name") === "@earendil-works/pi-coding-agent"
          && typeof Reflect.get(parsed, "version") === "string") {
          return Reflect.get(parsed, "version") as string;
        }
      } catch {
        // Continue walking; most ancestors do not contain the Pi manifest.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function detectPiRuntime(): PiRuntimeDetection {
  const executable = lookPath("pi");
  const home = os.homedir();
  return {
    id: "pi",
    name: "Pi",
    installed: executable !== null,
    executable,
    version: executable === null ? null : packageVersionFromExecutable(executable),
    codingAgentDir: process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
  };
}

export function hasManagedPiRuntime(targetDir?: string): boolean {
  const receipt = targetDir === undefined
    ? path.join(dataDir(), "pi-receipt.json")
    : path.join(path.resolve(targetDir), "state", "pi-receipt.json");
  return fs.statSync(receipt, { throwIfNoEntry: false })?.isFile() === true;
}

export function resolvePiEngramBin(targetDir?: string): string | null {
  if (targetDir === undefined) return detectEngram();
  const candidate = path.join(path.resolve(targetDir), "bin", process.platform === "win32" ? "engram.exe" : "engram");
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : null;
}

function readOptional(file: string, fallback: string | null): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

function runProcess(invocation: {
  executable: string;
  args: string[];
  environment: Record<string, string | undefined>;
  /** Isolated stage cwd only; never the active tree. */
  cwd?: string;
}): { exitCode: number; stdout: string; stderr: string } {
  const planned = /\.mjs$/i.test(invocation.executable)
    ? { command: process.execPath, args: [invocation.executable, ...invocation.args] }
    : planDetectedBinCommand(invocation.executable, invocation.args);
  if (planned === null) return { exitCode: 1, stdout: "", stderr: "unsafe executable" };
  const result = spawnSync(planned.command, planned.args, {
    encoding: "utf8",
    env: invocation.environment,
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    shell: false,
    timeout: 120_000,
    maxBuffer: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error?.message ?? ""),
  };
}

function setupPiFailedRemedy(setup: {
  reason?: string;
  stderr?: string;
  recovery?: string;
  backupId?: string | null;
  restoreError?: string;
}): string {
  // Remedy veraz según recovery: none nunca afirma restauración e indica
  // acción manual; complete afirma restaurado con backupId; incomplete
  // indica incompleta con backupId + acción manual sin afirmar limpio.
  const detail = setup.reason ?? setup.stderr ?? "setup oficial Pi falló";
  const recovery = setup.recovery ?? "none";
  const backupId = setup.backupId ?? null;
  if (recovery === "complete") {
    return backupId !== null
      ? `${detail}. Se restauró el backup ${backupId}; Pi no quedó activado.`
      : `${detail}. Se restauró el backup previo; Pi no quedó activado.`;
  }
  if (recovery === "incomplete") {
    const id = backupId !== null ? ` (backup ${backupId})` : " (sin backup válido)";
    const cause = setup.restoreError !== undefined ? ` ${setup.restoreError}.` : "";
    return `${detail}. Recuperación incompleta${id};${cause} revisa manualmente el estado y corrige la causa antes de reintentar; Pi no quedó activado.`;
  }
  const id = backupId !== null ? ` (backup ${backupId})` : " (sin backup válido)";
  return `${detail}. Sin recuperación automática${id}; revisa manualmente el estado y corrige la causa antes de reintentar; Pi no quedó activado.`;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedDepIdentities(
  deps: readonly { readonly name: string; readonly version: string; readonly integrity: string }[],
): string {
  return JSON.stringify([...deps]
    .map((dep) => ({ name: dep.name, version: dep.version, integrity: dep.integrity }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

/**
 * Pre-activation proof for a prepared install: the injected candidate must
 * equal the prepared candidate (package/tarball/provenance), the prepared
 * artifact must equal the candidate tarball (bytes/SHA), the release must
 * carry the candidate version with matching SRI, the stage must keep the
 * isolated layout, and the evidence must hold six distinct deps with
 * canonical SRI. Returns a visible mismatch description, null when matching.
 * Pure, no FS/network.
 */
function preparedInstallMismatch(candidate: PiRuntimeCandidate, prepared: PiInstallPreflightResult): string | null {
  const preparedCandidate = prepared?.candidate;
  if (preparedCandidate === undefined || preparedCandidate === null || typeof preparedCandidate !== "object") {
    return "prepared sin candidato";
  }
  if (!sameJsonValue(preparedCandidate.package, candidate.package)
    || !sameJsonValue(preparedCandidate.tarball, candidate.tarball)
    || !sameJsonValue(preparedCandidate.provenance, candidate.provenance)) {
    return "el candidato preparado no coincide con el candidato inyectado (package/tarball/provenance)";
  }
  const artifact = prepared?.artifact;
  if (artifact === undefined || artifact === null
    || artifact.bytes !== candidate.tarball.bytes
    || artifact.sha256 !== candidate.tarball.sha256
    || artifact.sha512 !== candidate.tarball.sha512) {
    return "el artefacto preparado no coincide con el tarball del candidato (bytes/SHA)";
  }
  if (typeof candidate.tarball.sha512 !== "string" || !/^[0-9a-f]{128}$/.test(candidate.tarball.sha512)) {
    return "el tarball del candidato no trae SHA-512 hexadecimal válido";
  }
  const expectedIntegrity = `sha512-${Buffer.from(candidate.tarball.sha512, "hex").toString("base64")}`;
  const release = prepared?.release;
  if (release === undefined || release === null
    || release.version !== candidate.package.version || release.integrity !== expectedIntegrity) {
    return "la release preparada no coincide con la versión/SRI del candidato";
  }
  const stageDir = prepared?.stageDir;
  if (typeof stageDir !== "string" || stageDir === ""
    || !/(^|[\\/])stage-[0-9a-f]{32}[\\/]pi-agent$/.test(path.resolve(stageDir))) {
    return "el stage preparado no tiene el layout aislado esperado (stage-<hex>/pi-agent)";
  }
  const evidence = prepared?.evidence;
  if (evidence === undefined || evidence === null
    || typeof evidence.lockSha256 !== "string" || !/^[0-9a-f]{64}$/.test(evidence.lockSha256)
    || typeof evidence.treeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(evidence.treeSha256)
    || !Array.isArray(evidence.dependencies) || evidence.dependencies.length !== 6) {
    return "la evidencia del stage no trae seis dependencias con digests hexadecimales";
  }
  const names = new Set<string>();
  for (const dep of evidence.dependencies) {
    if (dep === null || typeof dep !== "object" || Array.isArray(dep)
      || typeof (dep as { name?: unknown }).name !== "string" || (dep as { name: string }).name === ""
      || typeof (dep as { version?: unknown }).version !== "string" || (dep as { version: string }).version === ""
      || typeof (dep as { integrity?: unknown }).integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test((dep as { integrity: string }).integrity)) {
      return "la evidencia del stage trae una dependencia sin identidad/SRI canónico";
    }
    names.add((dep as { name: string }).name);
  }
  if (names.size !== 6) {
    return "la evidencia del stage trae dependencias duplicadas";
  }
  return null;
}

/**
 * True when settings.json already registers a JorgeX Pi package entry
 * (string or {source} shape). Throws on illegible shapes so the caller
 * fails closed instead of treating them as "no entry".
 */
function hasInstalledPiEntry(settingsJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    throw new Error("pi-prepared-install: settings.json ilegible; sin activación parcial");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pi-prepared-install: settings.json inválido; sin activación parcial");
  }
  const packages = Reflect.get(parsed, "packages");
  if (packages === undefined) return false;
  if (!Array.isArray(packages)) {
    throw new Error("pi-prepared-install: packages inválido en settings.json; sin activación parcial");
  }
  return packages.some((entry) => {
    const source = typeof entry === "string"
      ? entry
      : entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && typeof Reflect.get(entry, "source") === "string"
        ? Reflect.get(entry, "source") as string
        : null;
    return source !== null && source.includes("jorgex-pi");
  });
}

/**
 * Post-promotion proof for a prepared install: the published link must
 * resolve to the promoted release, the receipt must keep the prepared
 * candidate plus the managed fields, and the release inventory recomputed
 * after promotion must match the evidence. Throws on any mismatch so the
 * activation rolls back; pure reads, no writes.
 */
function verifyActivePiRelease(input: {
  agentDir: string;
  receiptPath: string;
  candidate: Pick<PiRuntimeCandidate, "package" | "tarball" | "provenance">;
  evidence: PreparedPiInstallEvidence;
}): void {
  const agentDir = path.resolve(input.agentDir);
  const npmDir = path.join(agentDir, "npm");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  let receiptRaw: string;
  try {
    receiptRaw = fs.readFileSync(input.receiptPath, "utf8");
  } catch {
    throw new Error(`pi-verify-active: no se pudo leer el receipt promovido: ${input.receiptPath}`);
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptRaw);
  } catch {
    throw new Error("pi-verify-active: el receipt promovido no es JSON válido");
  }
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("pi-verify-active: el receipt promovido es inválido");
  }
  const record = receipt as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    throw new Error("pi-verify-active: el receipt promovido no tiene schemaVersion 1");
  }
  const receiptCandidate = record["candidate"];
  if (receiptCandidate === null || typeof receiptCandidate !== "object" || Array.isArray(receiptCandidate)) {
    throw new Error("pi-verify-active: el receipt promovido no conserva el candidato");
  }
  const candidateRecord = receiptCandidate as Record<string, unknown>;
  if (!sameJsonValue(candidateRecord["package"], input.candidate.package)
    || !sameJsonValue(candidateRecord["tarball"], input.candidate.tarball)
    || !sameJsonValue(candidateRecord["provenance"], input.candidate.provenance)) {
    throw new Error("pi-verify-active: el receipt promovido no conserva el candidato preparado");
  }
  const managed = record["managedPackage"];
  if (managed === null || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("pi-verify-active: el receipt promovido no trae managedPackage");
  }
  const managedRecord = managed as Record<string, unknown>;
  if (managedRecord["lockSha256"] !== input.evidence.lockSha256
    || managedRecord["treeSha256"] !== input.evidence.treeSha256) {
    throw new Error("pi-verify-active: el receipt promovido no conserva los digests de la evidencia");
  }
  const receiptDeps = managedRecord["dependencies"];
  if (!Array.isArray(receiptDeps)
    || sortedDepIdentities(receiptDeps as { name: string; version: string; integrity: string }[])
    !== sortedDepIdentities(input.evidence.dependencies)) {
    throw new Error("pi-verify-active: el receipt promovido no conserva las seis dependencias de la evidencia");
  }
  const linkPath: unknown = managedRecord["linkPath"];
  if (typeof linkPath !== "string" || !path.isAbsolute(linkPath)) {
    throw new Error("pi-verify-active: el receipt promovido no trae un linkPath absoluto");
  }
  const linkResolved = path.resolve(linkPath);
  if (linkResolved !== path.join(npmDir, "node_modules", "jorgex-pi")) {
    throw new Error("pi-verify-active: el enlace publicado sale del entry propio");
  }
  const releaseDir: unknown = managedRecord["releaseDir"];
  if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)) {
    throw new Error("pi-verify-active: el receipt promovido no trae un releaseDir absoluto");
  }
  const releaseResolved = path.resolve(releaseDir);
  const releaseRel = path.relative(managedRoot, releaseResolved);
  if (releaseRel === "" || releaseRel === ".." || releaseRel.startsWith(`..${path.sep}`) || path.isAbsolute(releaseRel)) {
    throw new Error("pi-verify-active: el release promovido sale del root gestionado");
  }
  let target: string;
  try {
    const linkStat = fs.lstatSync(linkResolved);
    if (!linkStat.isSymbolicLink()) {
      throw new Error("pi-verify-active: el entry publicado no es un enlace");
    }
    target = fs.readlinkSync(linkResolved);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-verify-active: ")) throw error;
    throw new Error("pi-verify-active: no se pudo leer el enlace publicado");
  }
  const packageRoot = path.join(releaseResolved, "node_modules", "jorgex-pi");
  if (target === "" || path.isAbsolute(target)
    || path.resolve(path.dirname(linkResolved), target) !== packageRoot) {
    throw new Error("pi-verify-active: el enlace publicado no apunta al release promovido");
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(linkResolved);
  } catch {
    throw new Error("pi-verify-active: no se pudo resolver el realpath del enlace publicado");
  }
  if (realRoot !== packageRoot) {
    throw new Error("pi-verify-active: el realpath del runner no coincide con el release promovido");
  }
  let recomputed: string;
  try {
    recomputed = inventoryTreeSha256(releaseResolved);
  } catch {
    throw new Error("pi-verify-active: no se pudo reinventariar el release promovido");
  }
  if (recomputed !== input.evidence.treeSha256) {
    throw new Error("pi-verify-active: el inventario del release promovido difiere de la evidencia");
  }
}

export type PiRuntimePreflightOk = { candidate: PiRuntimeCandidate; prepared: PiInstallPreflightResult };
export type PiRuntimePreflightOut =
  | PiRuntimePreflightOk
  | { kind: "blocked"; reason: string; remedy: string };

function isStrictChildPath(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * T06 CLI-to-preflight: deliberate install resolves the live provider
 * candidate through the isolated managed-install preflight, without touching
 * the active npm tree, settings, receipt, official Engram setup, or the
 * static pin. Only explicit real install (targetDir undefined, Engram
 * present, absolute Pi executable) reaches the network; every other shape
 * fails closed before any download. Preflight throws stay visible and keep
 * the stage for diagnostics; the caller never falls back to static bytes.
 */
export async function preparePiRuntimeSystem(input: PiRuntimeInput): Promise<PiRuntimePreflightOut> {
  if (input.operation !== "install") {
    return {
      kind: "blocked",
      reason: "preflight-unsupported-operation",
      remedy: "El preflight Pi solo cubre install deliberado; sin red ni cambios.",
    };
  }
  if (input.targetDir !== undefined) {
    return {
      kind: "blocked",
      reason: "target-dir-preflight-unsupported",
      remedy: "La instalación con --target-dir nunca ejecuta preflight de red; aporta un stage preverificado o usa install real.",
    };
  }
  if (input.engramBin === null) {
    return {
      kind: "blocked",
      reason: "engram-required",
      remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
    };
  }
  const piExecutable = input.detected.executable;
  if (typeof piExecutable !== "string" || piExecutable === "" || !path.isAbsolute(piExecutable)) {
    return {
      kind: "blocked",
      reason: "pi-executable-missing",
      remedy: "No se detectó el ejecutable Pi absoluto; instala Pi antes de reintentar.",
    };
  }
  if (piExecutable === "npm") {
    return {
      kind: "blocked",
      reason: "pi-executable-missing",
      remedy: "El ejecutable Pi debe ser el CLI Pi detectado, nunca npm.",
    };
  }
  const homeDir = os.homedir();
  const agentDir = userPaths(input.engramBin, piExecutable).codingAgentDir;
  const downloadsDir = path.join(dataDir(), "packages");
  if (!isStrictChildPath(agentDir, homeDir)) {
    return {
      kind: "blocked",
      reason: "agent-dir-outside-home",
      remedy: `PI_CODING_AGENT_DIR (${agentDir}) está fuera de la frontera de restore HOME (${homeDir}); corrige el destino antes de reintentar; Pi no quedó activado.`,
    };
  }
  try {
    fs.mkdirSync(downloadsDir, { recursive: true });
  } catch (error) {
    return {
      kind: "blocked",
      reason: "preflight-failed",
      remedy: `No se pudo preparar el directorio de descargas Stack: ${error instanceof Error ? error.message : String(error)}. Pi no quedó activado.`,
    };
  }
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    return {
      kind: "blocked",
      reason: "preflight-failed",
      remedy: "Sin fetch global disponible para el preflight Pi; Pi no quedó activado.",
    };
  }
  try {
    const result = await preparePiManagedInstall(
      { homeDir, agentDir, piExecutable, downloadsDir },
      {
        fetchImpl: fetchImpl as typeof fetch,
        run: (executable, args, options) => runProcess({
          executable,
          args,
          environment: options.env,
          cwd: options.cwd,
        }),
      },
    );
    return { candidate: result.candidate, prepared: result };
  } catch (error) {
    const stageDir = (error as { stageDir?: unknown }).stageDir;
    const message = error instanceof Error ? error.message : String(error);
    const stageSuffix = typeof stageDir === "string" && stageDir !== ""
      ? ` Stage conservado en ${stageDir} para diagnóstico.`
      : " Stage conservado para diagnóstico cuando exista.";
    return {
      kind: "blocked",
      reason: "preflight-failed",
      remedy: `${message}.${stageSuffix} Corrige la causa y reintenta; Pi no quedó activado.`,
    };
  }
}

export async function runPiRuntimeSystem(input: PiRuntimeInput): Promise<RuntimeResult> {
  // Pi install real ordena Engram absoluto primero → `engram setup pi`
  // (backup/setup/verify singleton via runOfficialSetupIfNeeded("pi"),
  // install-only: shouldRunOfficialSetup excluye sync/dry-run/targetDir) →
  // package/projection/sync gestionados. sync/dry-run/--target-dir nunca
  // ejecutan setup ni descargas globales; el parcial restaura y no activa Pi.
  if (input.engramBin === null && input.operation !== "uninstall") return runPiRuntime(input, {
    readSettings: () => { throw new Error("unreachable"); },
    readReceipt: () => { throw new Error("unreachable"); },
    writeReceiptAtomic: () => { throw new Error("unreachable"); },
    prepare: () => { throw new Error("unreachable"); },
    execute: () => { throw new Error("unreachable"); },
    operate: () => { throw new Error("unreachable"); },
  });

  const paths = input.targetDir === undefined
    ? userPaths(input.engramBin, input.detected.executable)
    : targetPaths(input.targetDir, input.engramBin, input.detected.executable);
  if (input.operation === "install") {
    // T06/T07 deliberate install: the injected candidate plus the trusted
    // preflight proof route to prepared activation. The old static
    // acquisition/native install branch is gone: no fallback, no fetch here.
    // Every mismatch blocks before fetch, setup, or activation.
    const engramBin = input.engramBin;
    if (engramBin === null) {
      return {
        kind: "blocked",
        reason: "engram-required",
        remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
      };
    }
    const candidate = input.candidate;
    if (candidate === undefined) {
      return {
        kind: "blocked",
        reason: "candidate-missing",
        remedy: "Aporta el candidato Pi verificado (resolver + stage) antes de reintentar; install deliberado nunca usa el pin estático.",
      };
    }
    const prepared = input.prepared;
    if (prepared === undefined) {
      return {
        kind: "blocked",
        reason: "stage-unverified",
        remedy: "El install Pi exige el stage preverificado del preflight (prepared); un candidato del resolver solo nunca activa.",
      };
    }
    const mismatch = preparedInstallMismatch(candidate, prepared);
    if (mismatch !== null) {
      return {
        kind: "blocked",
        reason: "prepared-mismatch",
        remedy: `${mismatch}; Pi no quedó activado y no se descargó ni modificó nada.`,
      };
    }
    const settingsPath = path.join(paths.codingAgentDir, "settings.json");
    const settingsJson = readOptional(settingsPath, '{"packages":[]}')!;
    const receiptJson = readOptional(paths.receiptPath, null);
    let piEntry = false;
    try {
      piEntry = hasInstalledPiEntry(settingsJson);
    } catch (error) {
      return {
        kind: "blocked",
        reason: "settings-corrupt",
        remedy: `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`,
      };
    }
    if (receiptJson !== null || piEntry) {
      // No legacy migration yet and no raw receipt trust: a preexisting
      // receipt or Pi package entry needs the later verified update path,
      // never silent reuse. Nothing is touched.
      return {
        kind: "blocked",
        reason: "verified-update-required",
        remedy: "Ya existe un receipt o registro Pi instalado; la migración verificada aún no está disponible. No se modificó nada; Pi no quedó activado.",
      };
    }
    // Setup oficial solo en install real (targetDir undefined), tras la
    // prueba del stage y antes de activar. Con --target-dir se omite
    // (no-op global) y todo queda en el destino aislado.
    if (input.targetDir === undefined) {
      const { runOfficialSetupIfNeeded } = await import("./official-engram-setup.js");
      const setup = await runOfficialSetupIfNeeded("pi", {
        command: "install",
        dryRun: false,
        targetDir: undefined,
        engramBin,
        configDir: paths.codingAgentDir,
        homeDir: os.homedir(),
      });
      if (!setup.ran || !setup.ok) {
        if (!setup.ran) {
          return {
            kind: "blocked",
            reason: "setup-pi-failed",
            remedy: "setup oficial Pi omitido en install real. Sin recuperación automática (sin backup válido); revisa manualmente el estado y corrige la causa antes de reintentar; Pi no quedó activado.",
          };
        }
        return {
          kind: "blocked",
          reason: "setup-pi-failed",
          remedy: setupPiFailedRemedy(setup),
        };
      }
    }
    const homeDir = input.targetDir === undefined ? os.homedir() : path.resolve(input.targetDir);
    const agentDir = paths.codingAgentDir;
    const receiptPath = paths.receiptPath;
    const stageDir = prepared.stageDir;
    const evidence: PreparedPiInstallEvidence = {
      lockSha256: prepared.evidence.lockSha256,
      treeSha256: prepared.evidence.treeSha256,
      dependencies: [...prepared.evidence.dependencies],
    };
    const activationCandidate = prepared.candidate;
    const verifyStage = async (dir: string, proof: PreparedPiInstallEvidence): Promise<void> => {
      const observed = await inspectStagedPiNpm({
        stageDir: dir,
        tarballPath: prepared.artifact.path,
        release: prepared.release,
      });
      if (observed.lockSha256 !== proof.lockSha256 || observed.treeSha256 !== proof.treeSha256) {
        throw new Error("pi-prepared-install: el stage observado no coincide con la evidencia preparada (lock/tree); posible stage obsoleto");
      }
      if (sortedDepIdentities(observed.dependencies) !== sortedDepIdentities(proof.dependencies)) {
        throw new Error("pi-prepared-install: las dependencias observadas no coinciden con la evidencia preparada");
      }
    };
    const smokeStage = async (dir: string): Promise<void> => {
      await smokeStagedPiRuntime({ piExecutable: input.detected.executable, stageDir: dir });
    };
    const verifyActive = (): void => {
      verifyActivePiRelease({ agentDir, receiptPath, candidate: activationCandidate, evidence });
    };
    try {
      return await activatePreparedPiInstall(
        {
          homeDir,
          agentDir,
          receiptPath,
          engramBin,
          prepared: { candidate: activationCandidate, stageDir, evidence },
          settingsJson,
          previousSource: null,
          scopeKind: input.targetDir === undefined ? "real" : "target-dir",
        },
        { verifyStage, smokeStage, verifyActive },
      );
    } catch (error) {
      return {
        kind: "blocked",
        reason: "activation-failed",
        remedy: `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`,
      };
    }
  }
  const packageRoot = path.dirname(path.dirname(paths.packageRunner));
  const writeReceipt = (receipt: PiPackageReceipt): void => {
    writeText(paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  };
  if (input.operation === "sync") {
    // T07 offline managed sync: schemaVersion 1 receipt with managedPackage
    // routes to the authenticated managed sync, never the legacy resolver
    // plan. Registry stays current+historical identity, never a next install
    // selector; host testedVersions must not block this path. Invalid JSON
    // or legacy v1 without managedPackage falls through to the fail-closed
    // legacy path; raw-field presence alone never proves ownership (callee
    // validates scope/settings/link/lock/tree/cache/runner thoroughly).
    const settingsJson = readOptional(path.join(paths.codingAgentDir, "settings.json"), '{"packages":[]}')!;
    const receiptJson = readOptional(paths.receiptPath, null);
    if (receiptJson !== null) {
      let routesManaged = false;
      try {
        const parsed: unknown = JSON.parse(receiptJson);
        routesManaged = parsed !== null
          && typeof parsed === "object"
          && !Array.isArray(parsed)
          && Reflect.get(parsed, "schemaVersion") === 1
          && Reflect.get(parsed, "managedPackage") !== null
          && typeof Reflect.get(parsed, "managedPackage") === "object"
          && !Array.isArray(Reflect.get(parsed, "managedPackage"));
      } catch {
        routesManaged = false;
      }
      if (routesManaged) {
        return runPiPackageManagedSync(
          {
            operation: "sync",
            interactive: false,
            registry: PI_RUNTIME_REGISTRY.pi,
            detected: {
              executable: input.detected.executable,
              packageRunner: paths.packageRunner,
              settingsJson,
            },
            engramBin: input.engramBin,
            receiptJson,
            paths: {
              targetDir: input.targetDir !== undefined,
              codingAgentDir: paths.codingAgentDir,
              receiptPath: paths.receiptPath,
              environment: paths.environment,
            },
          },
          {
            backupSettings: () => undefined,
            run: runProcess,
            verifyManagedArtifact: (receipt) => verifyCachedPiArtifact({
              receipt,
              homeDir: input.targetDir === undefined ? os.homedir() : path.resolve(input.targetDir),
              downloadsDir: input.targetDir === undefined
                ? path.join(dataDir(), "packages")
                : path.join(path.resolve(input.targetDir), "downloads"),
            }),
            isPackageAbsent: () => !fs.existsSync(packageRoot),
            deleteReceipt: () => fs.rmSync(paths.receiptPath, { force: true }),
          },
        );
      }
    }
  }
  const deps: PiRuntimeDeps = {
    readSettings: (file) => readOptional(file, '{"packages":[]}')!,
    readReceipt: (file) => readOptional(file, null),
    writeReceiptAtomic: (file, content) => writeText(file, content),
    prepare: (value) => planPiPackageLifecycle(value as Parameters<typeof planPiPackageLifecycle>[0]),
    execute: (value) => executePiPackageLifecycle(
      value as Parameters<typeof executePiPackageLifecycle>[0],
      { writeReceipt, run: runProcess },
    ),
    operate: (value) => runPiPackageManagedOperation(
      value as Parameters<typeof runPiPackageManagedOperation>[0],
      {
        backupSettings: () => createBackup(
          [path.join(paths.codingAgentDir, "settings.json")],
          "pi-package-uninstall",
          input.targetDir === undefined ? undefined : path.join(path.resolve(input.targetDir), "backups"),
        ),
        run: runProcess,
        verifyManagedArtifact: (receipt) => verifyCachedPiArtifact({
          receipt,
          homeDir: input.targetDir === undefined ? os.homedir() : path.resolve(input.targetDir),
          downloadsDir: input.targetDir === undefined
            ? path.join(dataDir(), "packages")
            : path.join(path.resolve(input.targetDir), "downloads"),
        }),
        isPackageAbsent: () => !fs.existsSync(packageRoot),
        deleteReceipt: () => fs.rmSync(paths.receiptPath, { force: true }),
      },
    ),
  };
  return runPiRuntime(input, deps);
}
