import path from "node:path";

type CandidatePackage = {
  readonly name: string;
  readonly version: string;
  readonly source: string;
};

type CandidateTarball = {
  readonly bytes: number;
  readonly sha256: string;
  readonly sha512: string;
};

type CandidateProvenance = {
  readonly commit: string;
};

export interface ManagedExternalWrite {
  readonly owner: "jorgex-pi";
  readonly root: "PI_CODING_AGENT_DIR";
  readonly relativePath: string;
  readonly semantics: string;
}

export interface PiRuntimeCandidate {
  readonly package: CandidatePackage;
  readonly provenance: CandidateProvenance;
  readonly tarball: CandidateTarball;
  readonly pi: { readonly testedVersions: readonly string[] };
  readonly contract: {
    readonly schemaVersion: number;
    readonly capabilities: readonly string[];
    readonly runner: {
      readonly bin: string;
      readonly commands: readonly string[];
      readonly schemaVersion: number;
      readonly maxStdoutBytes: number;
    };
    readonly managedExternalWrites: readonly ManagedExternalWrite[];
  };
}

export interface PiPackageReceipt {
  schemaVersion: 1;
  state: "installing" | "installed";
  candidate: {
    package: CandidatePackage;
    tarball: CandidateTarball;
    provenance: CandidateProvenance;
  };
  scope: {
    kind: "real" | "target-dir";
    codingAgentDir: string;
  };
  engram: {
    binary: string;
  };
}

export interface PiPackageEnvironment {
  [key: string]: string | undefined;
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN?: string;
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  TMPDIR?: string;
}

export interface PiPackageLifecycleInput {
  candidate: PiRuntimeCandidate;
  observedTarball: CandidateTarball;
  pi: {
    executable: string;
    version: string;
    packageRunner: string;
    settingsJson: string;
  };
  engramBin: string | null;
  receiptJson: string | null;
  scope: {
    kind: "real" | "target-dir";
    codingAgentDir: string;
    receiptPath: string;
    environment: PiPackageEnvironment;
  };
}

export type PiPackageLifecycleReason =
  | "tarball-integrity"
  | "unsupported-pi-version"
  | "settings-corrupt"
  | "source-divergent"
  | "duplicate-package"
  | "receipt-corrupt"
  | "receipt-upgrade-required"
  | "partial-state"
  | "engram-missing";

export interface PiPackageLifecyclePlan {
  kind: "install" | "manual-existing" | "ready" | "blocked";
  reason?: PiPackageLifecycleReason;
  invocation?: {
    executable: string;
    args: string[];
    environment: PiPackageEnvironment;
  };
  receipt?: PiPackageReceipt;
  receiptPath: string;
  ownership: {
    receipt: boolean;
    adapters: false;
    manifest: false;
    modelMap: false;
  };
}

const REQUIRED_CAPABILITIES = new Set([
  "foundation-contract-v1",
  "runner-json-v1",
  "managed-primary-model-v1",
]);
const ALLOWED_EXTERNAL_WRITES = new Set([
  "settings.json",
  "models.json",
  "jorgex-pi/sol-lifecycle.v1.json",
]);

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function managedExternalWritesAreSafe(writes: readonly ManagedExternalWrite[]): boolean {
  if (writes.length !== ALLOWED_EXTERNAL_WRITES.size) return false;
  const seen = new Set<string>();
  for (const write of writes) {
    if (write === null || typeof write !== "object" || Array.isArray(write)) return false;
    if (Object.keys(write).sort().join(",") !== "owner,relativePath,root,semantics") return false;
    if (write.owner !== "jorgex-pi" || write.root !== "PI_CODING_AGENT_DIR") return false;
    if (typeof write.relativePath !== "string" || !ALLOWED_EXTERNAL_WRITES.has(write.relativePath)) return false;
    if (/^(?:[A-Za-z]:|[\\/])/.test(write.relativePath) || write.relativePath.split(/[\\/]/).includes("..")) return false;
    if (typeof write.semantics !== "string" || write.semantics.trim() === "" || seen.has(write.relativePath)) return false;
    seen.add(write.relativePath);
  }
  return seen.size === ALLOWED_EXTERNAL_WRITES.size;
}

function ownership(receipt: boolean): PiPackageLifecyclePlan["ownership"] {
  return { receipt, adapters: false, manifest: false, modelMap: false };
}

function blocked(input: PiPackageLifecycleInput, reason: PiPackageLifecycleReason): PiPackageLifecyclePlan {
  return {
    kind: "blocked",
    reason,
    receiptPath: input.scope.receiptPath,
    ownership: ownership(input.receiptJson !== null),
  };
}

function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = Reflect.get(entry, "source");
  return typeof source === "string" ? source : null;
}

function isJorgeXPiSource(source: string): boolean {
  return source.includes("jorgex-pi");
}

type PackageSource = { entry: unknown; source: string };

function parsePackageSources(settingsJson: string): PackageSource[] | null {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packages = Reflect.get(parsed, "packages");
    if (!Array.isArray(packages)) return null;
    const sources = packages.map((entry) => ({ entry, source: packageSource(entry) }));
    return sources.every((value): value is PackageSource => value.source !== null) ? sources : null;
  } catch {
    return null;
  }
}

function isExactManagedPackage(entry: unknown, source: string): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  const skills = Reflect.get(entry, "skills");
  const prompts = Reflect.get(entry, "prompts");
  return keys.length === 3
    && keys.includes("source")
    && keys.includes("skills")
    && keys.includes("prompts")
    && Reflect.get(entry, "source") === source
    && Array.isArray(skills)
    && skills.length === 0
    && Array.isArray(prompts)
    && prompts.length === 0;
}

/**
 * Filters only the one canonical Pi registration. Foreign entries and keys
 * remain untouched; ambiguous or divergent registrations fail closed.
 */
export function filterProjectedPiPackage(settingsJson: string, source: string): string | null {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packages = Reflect.get(parsed, "packages");
    if (!Array.isArray(packages)) return null;
    const matchingSources = packages.filter((entry) => {
      const entrySource = packageSource(entry);
      return entrySource !== null && isJorgeXPiSource(entrySource);
    });
    if (matchingSources.length !== 1) return null;
    const managedEntry = matchingSources[0];
    if (isExactManagedPackage(managedEntry, source)) return JSON.stringify(parsed);
    if (managedEntry !== source) return null;
    Reflect.set(parsed, "packages", packages.map((entry) => entry === source ? {
      source,
      skills: [],
      prompts: [],
    } : entry));
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function expectedReceipt(
  candidate: PiRuntimeCandidate,
  state: PiPackageReceipt["state"],
  scope: PiPackageReceipt["scope"],
  engramBin: string,
): PiPackageReceipt {
  return {
    schemaVersion: 1,
    state,
    candidate: {
      package: candidate.package,
      tarball: candidate.tarball,
      provenance: candidate.provenance,
    },
    scope,
    engram: { binary: engramBin },
  };
}

type ReceiptParseResult = PiPackageReceipt | "upgrade-required" | null;

function parseReceiptShape(receiptJson: string): ReceiptParseResult {
  try {
    const parsed: unknown = JSON.parse(receiptJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const schemaVersion = Reflect.get(parsed, "schemaVersion");
    if (schemaVersion !== 1) return null;
    const state = Reflect.get(parsed, "state");
    const candidate = Reflect.get(parsed, "candidate");
    if ((state !== "installing" && state !== "installed")
      || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const packageValue = Reflect.get(candidate, "package");
    const tarball = Reflect.get(candidate, "tarball");
    const provenance = Reflect.get(candidate, "provenance");
    const scope = Reflect.get(parsed, "scope");
    const engram = Reflect.get(parsed, "engram");
    if (packageValue === null || typeof packageValue !== "object"
      || tarball === null || typeof tarball !== "object"
      || provenance === null || typeof provenance !== "object"
      || scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      return null;
    }
    const source = Reflect.get(packageValue, "source");
    const name = Reflect.get(packageValue, "name");
    const version = Reflect.get(packageValue, "version");
    const scopeKind = Reflect.get(scope, "kind");
    const codingAgentDir = Reflect.get(scope, "codingAgentDir");
    if (name !== "jorgex-pi"
      || typeof version !== "string"
      || typeof source !== "string"
      || source !== `npm:jorgex-pi@${version}`
      || (scopeKind !== "real" && scopeKind !== "target-dir")
      || typeof codingAgentDir !== "string") {
      return null;
    }
    if (engram === undefined) return "upgrade-required";
    if (engram === null || typeof engram !== "object" || Array.isArray(engram)
      || typeof Reflect.get(engram, "binary") !== "string"
      || !path.isAbsolute(Reflect.get(engram, "binary") as string)) {
      return null;
    }
    return parsed as PiPackageReceipt;
  } catch {
    return null;
  }
}

function parseReceipt(
  receiptJson: string,
  candidate: PiRuntimeCandidate,
  scope: PiPackageReceipt["scope"],
  engramBin: string,
): ReceiptParseResult {
  const parsed = parseReceiptShape(receiptJson);
  if (parsed === null || parsed === "upgrade-required") return parsed;
  const expected = expectedReceipt(candidate, parsed.state, scope, engramBin);
  return sameRecord(parsed, expected) ? expected : null;
}

function candidateIsValid(candidate: PiRuntimeCandidate, observed: CandidateTarball): boolean {
  return candidate.package.name === "jorgex-pi"
    && candidate.package.source === `npm:${candidate.package.name}@${candidate.package.version}`
    && candidate.contract.schemaVersion === 1
    && candidate.contract.runner.schemaVersion === 1
    && candidate.contract.runner.bin === "jorgex-pi"
    && candidate.contract.runner.maxStdoutBytes === 65_536
    && managedExternalWritesAreSafe(candidate.contract.managedExternalWrites)
    && [...REQUIRED_CAPABILITIES].every((capability) => candidate.contract.capabilities.includes(capability))
    && sameRecord(candidate.tarball, observed);
}

export function planPiPackageLifecycle(input: PiPackageLifecycleInput): PiPackageLifecyclePlan {
  if (!candidateIsValid(input.candidate, input.observedTarball)) {
    return blocked(input, "tarball-integrity");
  }
  if (!input.candidate.pi.testedVersions.includes(input.pi.version)) {
    return blocked(input, "unsupported-pi-version");
  }
  if (input.engramBin === null) return blocked(input, "engram-missing");

  const sources = parsePackageSources(input.pi.settingsJson);
  if (sources === null) return blocked(input, "settings-corrupt");
  const matchingSources = sources.filter(({ source }) => isJorgeXPiSource(source));
  const exactSources = matchingSources.filter(({ source }) => source === input.candidate.package.source);
  if (exactSources.length > 1) return blocked(input, "duplicate-package");
  if (matchingSources.some(({ source }) => source !== input.candidate.package.source)) {
    return blocked(input, "source-divergent");
  }

  let receipt: PiPackageReceipt | null = null;
  if (input.receiptJson !== null) {
    const parsedReceipt = parseReceipt(input.receiptJson, input.candidate, {
      kind: input.scope.kind,
      codingAgentDir: path.resolve(input.scope.codingAgentDir),
    }, input.engramBin);
    if (parsedReceipt === "upgrade-required") return blocked(input, "receipt-upgrade-required");
    if (parsedReceipt === null) return blocked(input, "receipt-corrupt");
    receipt = parsedReceipt;
    if (receipt.state === "installing") return blocked(input, "partial-state");
    const exactSource = exactSources[0];
    if (exactSources.length !== 1
      || exactSource === undefined
      || !isExactManagedPackage(exactSource.entry, input.candidate.package.source)) {
      return blocked(input, "source-divergent");
    }
  }

  if (exactSources.length === 1 && receipt === null) {
    return {
      kind: "manual-existing",
      receiptPath: input.scope.receiptPath,
      ownership: ownership(false),
    };
  }
  if (exactSources.length === 1 && receipt !== null) {
    return {
      kind: "ready",
      receiptPath: input.scope.receiptPath,
      ownership: ownership(true),
    };
  }

  return {
    kind: "install",
    receiptPath: input.scope.receiptPath,
    invocation: {
      executable: input.pi.executable,
      args: ["install", input.candidate.package.source, "--no-approve"],
      environment: input.scope.environment,
    },
    receipt: expectedReceipt(input.candidate, "installing", {
      kind: input.scope.kind,
      codingAgentDir: path.resolve(input.scope.codingAgentDir),
    }, input.engramBin),
    ownership: ownership(true),
  };
}

export type PiPackageOperation = "install" | "sync" | "models";

export type PiPackageExecutorResult =
  | { kind: "installed"; receipt: PiPackageReceipt }
  | { kind: "synced"; actions: unknown[] }
  | { kind: "models"; models: { mode: "inherit-session"; tiers: ["strong", "standard", "cheap"] } }
  | { kind: "manual-existing" }
  | { kind: "blocked"; reason: "pi-install-failed" | "runner-output" | "runner-unhealthy" };

export interface PiPackageExecutorInput {
  operation: PiPackageOperation;
  plan: Pick<PiPackageLifecyclePlan, "kind" | "receipt" | "invocation">;
  candidate: PiRuntimeCandidate;
  packageRunner: string;
  environment: PiPackageEnvironment;
}

export interface PiPackageExecutorDeps {
  writeReceipt(receipt: PiPackageReceipt): void;
  run(invocation: {
    executable: string;
    args: string[];
    environment: PiPackageEnvironment;
  }): { exitCode: number; stdout: string; stderr: string };
}

type RunnerCommand = Exclude<PiPackageOperation, "install"> | "doctor" | "cleanup" | "status";

interface RunnerRecord {
  schemaVersion: number;
  command: string;
  ok: boolean;
  package: { name: string; version: string; root: string };
  result: unknown;
}

function parseRunnerRecord(
  stdout: string,
  stderr: string,
  command: RunnerCommand,
  candidate: PiRuntimeCandidate,
  packageRunner: string,
): RunnerRecord | null {
  if (stderr !== "" || !stdout.endsWith("\n") || Buffer.byteLength(stdout) > candidate.contract.runner.maxStdoutBytes) {
    return null;
  }
  const body = stdout.slice(0, -1);
  if (body === "" || body.includes("\n") || body.includes("\r")) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Partial<RunnerRecord>;
    if (record.schemaVersion !== candidate.contract.runner.schemaVersion
      || record.command !== command
      || record.ok !== true
      || record.package === null
      || typeof record.package !== "object"
      || record.package.name !== candidate.package.name
      || record.package.version !== candidate.package.version
      || typeof record.package.root !== "string"
      || !path.isAbsolute(record.package.root)
      || path.resolve(packageRunner) !== path.resolve(record.package.root, "bin", "jorgex-pi.mjs")) {
      return null;
    }
    return record as RunnerRecord;
  } catch {
    return null;
  }
}

function runPackageCommand(
  input: PiPackageExecutorInput,
  deps: PiPackageExecutorDeps,
  command: RunnerCommand,
): RunnerRecord | PiPackageExecutorResult {
  const result = deps.run({
    executable: input.packageRunner,
    args: [command, "--json"],
    environment: input.environment,
  });
  if (result.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  return parseRunnerRecord(result.stdout, result.stderr, command, input.candidate, input.packageRunner)
    ?? { kind: "blocked", reason: "runner-output" };
}

function isBlockedResult(value: RunnerRecord | PiPackageExecutorResult): value is PiPackageExecutorResult {
  return "kind" in value;
}

export function executePiPackageLifecycle(
  input: PiPackageExecutorInput,
  deps: PiPackageExecutorDeps,
): PiPackageExecutorResult {
  if (input.plan.kind === "manual-existing") return { kind: "manual-existing" };

  if (input.operation === "install") {
    if (input.plan.kind !== "install" || input.plan.receipt === undefined || input.plan.invocation === undefined) {
      return { kind: "blocked", reason: "runner-unhealthy" };
    }
    deps.writeReceipt(input.plan.receipt);
    const installed = deps.run(input.plan.invocation);
    if (installed.exitCode !== 0 || installed.stderr !== "") {
      return { kind: "blocked", reason: "pi-install-failed" };
    }
    const doctor = runPackageCommand(input, deps, "doctor");
    if (isBlockedResult(doctor)) return doctor;
    const doctorResult = doctor.result;
    if (doctorResult === null || typeof doctorResult !== "object" || Reflect.get(doctorResult, "healthy") !== true) {
      return { kind: "blocked", reason: "runner-unhealthy" };
    }
    const receipt = { ...input.plan.receipt, state: "installed" as const };
    deps.writeReceipt(receipt);
    return { kind: "installed", receipt };
  }

  if (input.plan.kind !== "ready") return { kind: "blocked", reason: "runner-unhealthy" };
  const command = runPackageCommand(input, deps, input.operation);
  if (isBlockedResult(command)) return command;

  if (input.operation === "sync") {
    const result = command.result;
    if (result === null
      || typeof result !== "object"
      || (Reflect.get(result, "changed") !== true && Reflect.get(result, "changed") !== false)
      || !Array.isArray(Reflect.get(result, "actions"))) {
      return { kind: "blocked", reason: "runner-unhealthy" };
    }
    return { kind: "synced", actions: Reflect.get(result, "actions") };
  }

  const models = command.result;
  if (models === null
    || typeof models !== "object"
    || Reflect.get(models, "mode") !== "inherit-session"
    || !sameRecord(Reflect.get(models, "tiers"), ["strong", "standard", "cheap"])) {
    return { kind: "blocked", reason: "runner-unhealthy" };
  }
  return { kind: "models", models: { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] } };
}

export interface PiPackageRegistry {
  id: "pi";
  kind: "package-managed";
  candidate: PiRuntimeCandidate;
  acceptedCandidates?: readonly PiRuntimeCandidate[];
}

export interface PiPackageManagedOperationInput {
  operation: "doctor" | "uninstall" | "update";
  interactive: boolean;
  registry: PiPackageRegistry;
  detected: {
    executable: string;
    packageRunner: string;
    settingsJson: string;
  };
  engramBin: string | null;
  receiptJson: string | null;
  paths: {
    targetDir: boolean;
    codingAgentDir: string;
    receiptPath: string;
    environment: Record<string, string>;
  };
}

export interface PiPackageManagedOperationDeps {
  backupSettings(): void;
  run(invocation: {
    executable: string;
    args: string[];
    environment: Record<string, string>;
  }): { exitCode: number; stdout: string; stderr: string };
  isPackageAbsent(): boolean;
  deleteReceipt(): void;
}

export type PiPackageManagedOperationResult =
  | { kind: "healthy" }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: string; remedy?: string };

function receiptUpgradeRequired(): PiPackageManagedOperationResult {
  return {
    kind: "blocked",
    reason: "receipt-upgrade-required",
    remedy: "El receipt no enlaza Engram; usa la versión anterior de Stack para desinstalarlo y luego reinstala.",
  };
}

function validateOwnedOperationState(
  input: PiPackageManagedOperationInput,
): { receipt: PiPackageReceipt; source: string } | PiPackageManagedOperationResult {
  const sources = parsePackageSources(input.detected.settingsJson);
  if (sources === null) return { kind: "blocked", reason: "settings-corrupt" };
  const matchingSources = sources.filter(({ source }) => isJorgeXPiSource(source));
  if (matchingSources.length > 1) return { kind: "blocked", reason: "duplicate-package" };
  if (input.receiptJson === null) {
    const matchingSource = matchingSources[0];
    return matchingSource !== undefined
      && matchingSource.source === input.registry.candidate.package.source
      && isExactManagedPackage(matchingSource.entry, matchingSource.source)
      ? { kind: "blocked", reason: "manual-existing" }
      : { kind: "blocked", reason: "source-divergent" };
  }
  const parsedReceipt = parseReceiptShape(input.receiptJson);
  if (parsedReceipt === "upgrade-required") return receiptUpgradeRequired();
  if (parsedReceipt === null) return { kind: "blocked", reason: "receipt-corrupt" };
  const receipt = parsedReceipt;
  if (receipt.state !== "installed") return { kind: "blocked", reason: "partial-state" };
  const accepted = input.registry.acceptedCandidates ?? [input.registry.candidate];
  if (!accepted.some((candidate) => sameRecord(receipt.candidate, {
    package: candidate.package,
    tarball: candidate.tarball,
    provenance: candidate.provenance,
  }))) {
    return { kind: "blocked", reason: "receipt-untrusted" };
  }
  if (receipt.scope.kind !== (input.paths.targetDir ? "target-dir" : "real")
    || path.resolve(receipt.scope.codingAgentDir) !== path.resolve(input.paths.codingAgentDir)) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  if (input.engramBin !== null && path.resolve(receipt.engram.binary) !== path.resolve(input.engramBin)) {
    return { kind: "blocked", reason: "receipt-corrupt" };
  }
  const source = receipt.candidate.package.source;
  const matchingSource = matchingSources[0];
  if (matchingSources.length !== 1
    || matchingSource === undefined
    || matchingSource.source !== source
    || !isExactManagedPackage(matchingSource.entry, source)) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  return { receipt, source };
}

function operationWasBlocked(
  value: { receipt: PiPackageReceipt; source: string } | PiPackageManagedOperationResult,
): value is PiPackageManagedOperationResult {
  return "kind" in value;
}

function runManagedRunner(
  input: PiPackageManagedOperationInput,
  deps: PiPackageManagedOperationDeps,
  command: RunnerCommand,
): RunnerRecord | PiPackageManagedOperationResult {
  const result = deps.run({
    executable: input.detected.packageRunner,
    args: [command, "--json"],
    environment: input.paths.environment,
  });
  if (result.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  const parsed = parseRunnerRecord(
    result.stdout,
    result.stderr,
    command,
    input.registry.candidate,
    input.detected.packageRunner,
  );
  return parsed ?? { kind: "blocked", reason: "runner-output" };
}

function managedRunnerWasBlocked(
  value: RunnerRecord | PiPackageManagedOperationResult,
): value is PiPackageManagedOperationResult {
  return "kind" in value;
}

export function runPiPackageManagedOperation(
  input: PiPackageManagedOperationInput,
  deps: PiPackageManagedOperationDeps,
): PiPackageManagedOperationResult {
  if (input.engramBin === null && input.operation !== "uninstall") {
    return {
      kind: "blocked",
      reason: "engram-missing",
      remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
    };
  }
  if (input.operation === "uninstall" && input.receiptJson === null) {
    const sources = parsePackageSources(input.detected.settingsJson);
    if (sources === null) return { kind: "blocked", reason: "settings-corrupt" };
    if (!sources.some(({ source }) => isJorgeXPiSource(source))) {
      return deps.isPackageAbsent()
        ? { kind: "uninstalled" }
        : { kind: "blocked", reason: "absence-unverified" };
    }
  }
  const owned = validateOwnedOperationState(input);
  if (operationWasBlocked(owned)) return owned;

  if (input.operation === "doctor") {
    if (!sameRecord(owned.receipt.candidate, {
      package: input.registry.candidate.package,
      tarball: input.registry.candidate.tarball,
      provenance: input.registry.candidate.provenance,
    })) {
      return { kind: "blocked", reason: "source-divergent" };
    }
    const doctor = runManagedRunner(input, deps, "doctor");
    if (managedRunnerWasBlocked(doctor)) return doctor;
    const result = doctor.result;
    return result !== null && typeof result === "object" && Reflect.get(result, "healthy") === true
      ? { kind: "healthy" }
      : { kind: "blocked", reason: "runner-unhealthy" };
  }

  if (input.operation === "uninstall") {
    if (!sameRecord(owned.receipt.candidate, {
      package: input.registry.candidate.package,
      tarball: input.registry.candidate.tarball,
      provenance: input.registry.candidate.provenance,
    })) {
      return { kind: "blocked", reason: "source-divergent" };
    }
    const cleanup = runManagedRunner(input, deps, "cleanup");
    if (managedRunnerWasBlocked(cleanup)) return cleanup;
    deps.backupSettings();
    const removed = deps.run({
      executable: input.detected.executable,
      args: ["remove", owned.source, "--no-approve"],
      environment: input.paths.environment,
    });
    if (removed.exitCode !== 0 || removed.stderr !== "") return { kind: "blocked", reason: "remove-failed" };
    if (!deps.isPackageAbsent()) return { kind: "blocked", reason: "absence-unverified" };
    deps.deleteReceipt();
    return { kind: "uninstalled" };
  }

  const nextSource = input.registry.candidate.package.source;
  if (nextSource === owned.source) return { kind: "healthy" };
  return {
    kind: "blocked",
    reason: "verified-update-required",
    remedy: "A cross-version Pi update requires verified replacement and rollback tgz artifacts.",
  };
}
