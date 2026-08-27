import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dataDir } from "./paths.js";
import { writeText } from "./fsx.js";
import { createBackup } from "./backup.js";
import { detectEngram, lookPath, planDetectedBinCommand } from "./detect.js";
import {
  executePiPackageLifecycle,
  planPiPackageLifecycle,
  runPiPackageManagedOperation,
  type PiPackageReceipt,
  type PiRuntimeCandidate,
} from "./pi-package-lifecycle.js";

export const PI_RUNTIME_CANDIDATE = {
  package: {
    name: "jorgex-pi",
    version: "0.4.0",
    source: "npm:jorgex-pi@0.4.0",
  },
  provenance: {
    commit: "40abf9a0f7139e54da25344699c907cbdd859e27",
  },
  tarball: {
    bytes: 89_116_913,
    sha256: "6a984cf270dc204e1ccec15bcccd52b9a9eac168be68e404ca588bd54d924cd1",
    sha512: "8ec9424cb5bb313b9a29b30d39f84ab32af3004039f077573d3344c2d9564556679a370919912e1fb969780d989d56e5ccea0d06bd5056c00b67b248a68de661",
  },
  pi: {
    testedVersions: ["0.84.2"],
  },
  contract: {
    schemaVersion: 1,
    capabilities: [
      "foundation-contract-v1",
      "stack-snapshot-v2",
      "runtime-agents-v1",
      "permission-gated-tools-v1",
      "structured-questions-v1",
      "web-access-v1",
      "goal-continuation-v1",
      "mcp-adapter-v1",
      "engram-runtime-tools-v1",
      "runner-json-v1",
      "tui-branding-v1",
      "managed-primary-model-v1",
    ],
    runner: {
      bin: "jorgex-pi",
      commands: ["status", "doctor", "models", "sync", "cleanup"],
      schemaVersion: 1,
      maxStdoutBytes: 65_536,
    },
    managedExternalWrites: [
      {
        owner: "jorgex-pi",
        root: "PI_CODING_AGENT_DIR",
        relativePath: "settings.json",
        semantics: "merge a missing or matching partial defaultProvider=openai-codex and defaultModel=gpt-5.6-sol pair; preserve foreign halves; cleanup removes only receipt-owned exact values",
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
    acceptedCandidates: [PI_RUNTIME_CANDIDATE],
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
    installNative(input: { version: "1.20.0"; channels: ["brew", "go", "url"] }): Promise<boolean>;
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
    message: "Engram es obligatorio para JorgeX Pi. ¿Instalar ahora el binario mediante el canal nativo?",
    initialValue: false,
  });
  if (!accepted) return { kind: "offer", accepted: false };
  const installed = await deps.installNative({ version: "1.20.0", channels: ["brew", "go", "url"] });
  if (!installed) {
    return {
      kind: "blocked",
      reason: "engram-install-failed",
      remedy: "Instala Engram manualmente o configura ENGRAM_BIN antes de reintentar.",
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
    const hasCanonical = packages.some((entry) => entry === canonical
      || (entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && Reflect.get(entry, "source") === canonical));
    if (packages.filter((entry) => entry === alias).length !== 1 || hasCanonical) return null;
    Reflect.set(parsed, "packages", packages.map((entry) => entry === alias ? { source: canonical, skills: [] } : entry));
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
  if (doctor.exitCode !== 0 || !healthyDoctor(doctor.stdout, doctor.stderr, paths.packageRunner, input.candidate)) {
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
  if (input.operation === "install" && input.verifiedArtifact === undefined) {
    return { kind: "blocked", reason: "tarball-integrity" };
  }

  const paths = input.targetDir === undefined
    ? userPaths(input.engramBin, input.detected.executable)
    : targetPaths(input.targetDir, input.engramBin, input.detected.executable);
  const settingsJson = deps.readSettings(path.join(paths.codingAgentDir, "settings.json"));
  const receiptJson = deps.readReceipt(paths.receiptPath);
  const lifecycleInput = {
    candidate: PI_RUNTIME_CANDIDATE,
    observedTarball: input.verifiedArtifact ?? PI_RUNTIME_CANDIDATE.tarball,
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
    const result = deps.execute({
      operation: input.operation,
      plan,
      candidate: PI_RUNTIME_CANDIDATE,
      packageRunner: paths.packageRunner,
      environment: paths.environment,
    });
    persistReturnedReceipt(result, paths, deps);
    return result;
  }

  const result = deps.operate({
    operation: input.operation,
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
    removeArgs: ["remove", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
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

function hashPiTarball(file: string): { path: string; bytes: number; sha256: string; sha512: string } {
  const descriptor = fs.openSync(file, "r");
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      const chunk = buffer.subarray(0, read);
      sha256.update(chunk);
      sha512.update(chunk);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { path: file, bytes, sha256: sha256.digest("hex"), sha512: sha512.digest("hex") };
}

async function acquirePiTarball(destination: string): Promise<{ path: string; bytes: number; sha256: string; sha512: string }> {
  const existing = fs.statSync(destination, { throwIfNoEntry: false });
  if (existing?.isFile()) {
    const observed = hashPiTarball(destination);
    if (observed.bytes === PI_RUNTIME_CANDIDATE.tarball.bytes
      && observed.sha256 === PI_RUNTIME_CANDIDATE.tarball.sha256
      && observed.sha512 === PI_RUNTIME_CANDIDATE.tarball.sha512) {
      return observed;
    }
    fs.rmSync(destination, { force: true });
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${process.pid}`;
  const response = await fetch(`https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`, {
    redirect: "error",
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok || response.body === null) throw new Error(`No se pudo descargar jorgex-pi@${PI_RUNTIME_CANDIDATE.package.version} (${response.status}).`);
  const descriptor = fs.openSync(partial, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > PI_RUNTIME_CANDIDATE.tarball.bytes) throw new Error("El tarball de jorgex-pi excede el tamaño fijado.");
      let offset = 0;
      while (offset < buffer.length) offset += fs.writeSync(descriptor, buffer, offset);
    }
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  fs.renameSync(partial, destination);
  return hashPiTarball(destination);
}

function runProcess(invocation: {
  executable: string;
  args: string[];
  environment: Record<string, string | undefined>;
}): { exitCode: number; stdout: string; stderr: string } {
  const planned = /\.mjs$/i.test(invocation.executable)
    ? { command: process.execPath, args: [invocation.executable, ...invocation.args] }
    : planDetectedBinCommand(invocation.executable, invocation.args);
  if (planned === null) return { exitCode: 1, stdout: "", stderr: "unsafe executable" };
  const result = spawnSync(planned.command, planned.args, {
    encoding: "utf8",
    env: invocation.environment,
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

export async function runPiRuntimeSystem(input: PiRuntimeInput): Promise<RuntimeResult> {
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
    if (input.engramBin === null) {
      return {
        kind: "blocked",
        reason: "engram-required",
        remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
      };
    }
    const destination = input.targetDir === undefined
      ? path.join(dataDir(), "packages", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`)
      : path.join(path.resolve(input.targetDir), "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
    let artifact: ReturnType<typeof hashPiTarball>;
    try {
      artifact = await acquirePiTarball(destination);
    } catch (error) {
      return { kind: "blocked", reason: "tarball-download", remedy: error instanceof Error ? error.message : String(error) };
    }
    return installPiFromVerifiedTarball({
      targetDir: input.targetDir,
      piExecutable: input.detected.executable,
      engramBin: input.engramBin,
      candidate: {
        source: PI_RUNTIME_CANDIDATE.package.source,
        ...PI_RUNTIME_CANDIDATE.tarball,
        package: PI_RUNTIME_CANDIDATE.package,
        provenance: PI_RUNTIME_CANDIDATE.provenance,
      },
    }, {
      download: () => artifact,
      backupSettings: () => createBackup(
        [path.join(paths.codingAgentDir, "settings.json")],
        "pi-package-install",
        input.targetDir === undefined ? undefined : path.join(path.resolve(input.targetDir), "backups"),
      ),
      run: runProcess,
      readSettings: () => readOptional(path.join(paths.codingAgentDir, "settings.json"), '{"packages":[]}')!,
      rewriteSettings: (content) => writeText(path.join(paths.codingAgentDir, "settings.json"), `${content}\n`),
      writeReceiptAtomic: (content) => writeText(paths.receiptPath, content),
    });
  }
  const packageRoot = path.dirname(path.dirname(paths.packageRunner));
  const writeReceipt = (receipt: PiPackageReceipt): void => {
    writeText(paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  };
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
        isPackageAbsent: () => !fs.existsSync(packageRoot),
        deleteReceipt: () => fs.rmSync(paths.receiptPath, { force: true }),
      },
    ),
  };
  return runPiRuntime(input, deps);
}
