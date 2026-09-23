import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";

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

/**
 * Offline recovery identity for a previously accepted Pi release.
 * Contains package/tarball/provenance/runner only; never pretends the old
 * release has current capabilities. A full PiRuntimeCandidate is
 * structurally assignable to this minimal shape.
 */
export interface PiAcceptedCandidate {
  readonly package: CandidatePackage;
  readonly provenance: CandidateProvenance;
  readonly tarball: CandidateTarball;
  readonly contract: {
    readonly runner: {
      readonly bin: string;
      readonly commands: readonly string[];
      readonly schemaVersion: number;
      readonly maxStdoutBytes: number;
    };
  };
}

export interface PiPackageManagedDependency {
  name: string;
  version: string;
  integrity: string;
}

export interface PiPackageManagedEvidence {
  releaseDir: string;
  linkPath: string;
  backupDir: string;
  lockSha256: string;
  treeSha256: string;
  dependencies: PiPackageManagedDependency[];
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
  managedPackage?: PiPackageManagedEvidence;
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
/** Opt-in permissions upgrade: rewrites owned/absent policy via the package runner. Never default; seed-only without flag or capability. */
export const PERMISSIONS_UPGRADE_CAPABILITY = "permissions-upgrade-v1";

export function supportsPermissionsUpgrade(capabilities: readonly string[]): boolean {
  return Array.isArray(capabilities) && capabilities.includes(PERMISSIONS_UPGRADE_CAPABILITY);
}
const ALLOWED_EXTERNAL_WRITES = new Set([
  "settings.json",
  "models.json",
  "jorgex-pi/sol-lifecycle.v1.json",
]);
const PERMISSIONS_EXTERNAL_WRITES = new Set([
  ...ALLOWED_EXTERNAL_WRITES,
  "extensions/pi-permission-system/config.json",
  "jorgex-pi/permissions-lifecycle.v1.json",
  "jorgex-pi/permissions-backups",
]);
const EXPERIENCE_EXTERNAL_WRITES = new Set([
  ...PERMISSIONS_EXTERNAL_WRITES,
  "jorgex-pi/experience-lifecycle.v1.json",
]);

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function managedExternalWritesAreSafe(writes: readonly ManagedExternalWrite[], capabilities: readonly string[]): boolean {
  if (!Array.isArray(capabilities)) return false;
  const permissions = capabilities.includes("permissions-policy-v1");
  const experience = capabilities.includes("experience-defaults-v1");
  if (experience && !permissions) return false;
  if (supportsPermissionsUpgrade(capabilities) && !permissions) return false;
  const allowed = experience ? EXPERIENCE_EXTERNAL_WRITES : permissions ? PERMISSIONS_EXTERNAL_WRITES : ALLOWED_EXTERNAL_WRITES;
  if (writes.length !== allowed.size) return false;
  const seen = new Set<string>();
  for (const write of writes) {
    if (write === null || typeof write !== "object" || Array.isArray(write)) return false;
    if (Object.keys(write).sort().join(",") !== "owner,relativePath,root,semantics") return false;
    if (write.owner !== "jorgex-pi" || write.root !== "PI_CODING_AGENT_DIR") return false;
    if (typeof write.relativePath !== "string" || !allowed.has(write.relativePath)) return false;
    if (/^(?:[A-Za-z]:|[\\/])/.test(write.relativePath) || write.relativePath.split(/[\\/]/).includes("..")) return false;
    if (typeof write.semantics !== "string" || write.semantics.trim() === "" || seen.has(write.relativePath)) return false;
    seen.add(write.relativePath);
  }
  return seen.size === allowed.size;
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

/**
 * Pure settings planner for the managed Pi entry. The caller authenticates
 * the old receipt separately; a bare string entry never counts as owned.
 * Fresh appends only when no JorgeX Pi entry exists; owned migration
 * replaces only the one exact managed object. Fail-closed, no FS access.
 */
export function planPiManagedSettings(
  settingsJson: string,
  previousSource: string | null,
  nextSource: string,
): string | null {
  if (typeof settingsJson !== "string" || typeof nextSource !== "string" || nextSource === "") return null;
  if (previousSource !== null && (typeof previousSource !== "string" || previousSource === "")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const packages = Reflect.get(parsed, "packages");
  if (!Array.isArray(packages)) return null;
  const sources = packages.map((entry) => packageSource(entry));
  if (sources.some((source) => source === null)) return null;
  const piIndexes: number[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (typeof source === "string" && isJorgeXPiSource(source)) piIndexes.push(index);
  }
  if (previousSource === null) {
    if (piIndexes.length !== 0) return null;
    packages.push({ source: nextSource, skills: [], prompts: [] });
    return JSON.stringify(parsed);
  }
  if (piIndexes.length !== 1) return null;
  const index = piIndexes[0];
  if (index === undefined || sources[index] !== previousSource) return null;
  if (!isExactManagedPackage(packages[index], previousSource)) return null;
  if (nextSource === previousSource) return JSON.stringify(parsed);
  packages[index] = { source: nextSource, skills: [], prompts: [] };
  return JSON.stringify(parsed);
}

/**
 * Pure settings planner for verified managed-release removal. The caller
 * authenticates the receipt separately; a bare string entry never counts as
 * owned. Removes only the one exact managed object, preserving
 * gentle-engram/adapter/foreign entries and top-level keys/order.
 * Fail-closed, no FS access.
 */
export function planPiManagedRemoval(
  settingsJson: string,
  ownedSource: string,
): string | null {
  if (typeof settingsJson !== "string" || typeof ownedSource !== "string" || ownedSource === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const packages = Reflect.get(parsed, "packages");
  if (!Array.isArray(packages)) return null;
  const sources = packages.map((entry) => packageSource(entry));
  if (sources.some((source) => source === null)) return null;
  const piIndexes: number[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (typeof source === "string" && isJorgeXPiSource(source)) piIndexes.push(index);
  }
  if (piIndexes.length !== 1) return null;
  const index = piIndexes[0];
  if (index === undefined || sources[index] !== ownedSource) return null;
  if (!isExactManagedPackage(packages[index], ownedSource)) return null;
  packages.splice(index, 1);
  return JSON.stringify(parsed);
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

export interface CreateManagedPiReceiptInput {
  readonly candidate: Pick<PiRuntimeCandidate, "package" | "tarball" | "provenance">;
  readonly scope: { readonly kind: "real" | "target-dir"; readonly codingAgentDir: string };
  readonly engramBin: string;
  readonly stageDir: string;
  readonly releaseId: string;
  readonly evidence: {
    readonly lockSha256: string;
    readonly treeSha256: string;
    readonly dependencies: readonly PiPackageManagedDependency[];
  };
  readonly state: PiPackageReceipt["state"];
}

function assertPureAbsolutePath(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  if (raw.includes("\0") || raw.includes("\n") || raw.includes("\r")) {
    throw new Error(`${label} contains symlink path literal or escape`);
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${label} must be an absolute directory: ${raw}`);
  }
  if (raw.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must not contain escape segments (..): ${raw}`);
  }
  return path.resolve(raw);
}

/**
 * Pure managed receipt builder (T07 GREEN, no FS/network).
 *
 * Returns the schemaVersion 1 receipt (accepted by published Pi 0.8.31
 * `mcp-engram.ts`, which rejects schema 2 and ignores the additional
 * `managedPackage` field) with strictly validated `managedPackage` derived
 * from the isolated stage: releaseDir under
 * `npm/jorgex-pi-managed/releases/<64hex>`, linkPath at
 * `npm/node_modules/jorgex-pi`, backupDir at `stageDir/.activate-backup`
 * with stageDir exactly `agentDir/stage-<32hex>/pi-agent`, plus observed
 * lock/tree digests and six distinct deps with canonical sha512 SRI.
 * Throws before returning on any invalid absolute dir, symlink literal or
 * escape, bad id, dep, or field. Reuses `expectedReceipt`, `isHex64`,
 * `isCanonicalSha512` and `isStrictChild`; no filesystem or network access,
 * never a future version selector.
 */
export function createManagedPiReceipt(input: CreateManagedPiReceiptInput): PiPackageReceipt {
  if (!isObjectRecord(input)) throw new Error("input must be an object");
  const { candidate, scope, engramBin, stageDir, releaseId, evidence, state } = input as Record<string, unknown>;

  if (!isObjectRecord(candidate)) throw new Error("candidate must be an object");
  const pkg = (candidate as Record<string, unknown>)["package"];
  const tarball = (candidate as Record<string, unknown>)["tarball"];
  const provenance = (candidate as Record<string, unknown>)["provenance"];
  if (!isObjectRecord(pkg) || pkg["name"] !== "jorgex-pi") {
    throw new Error("candidate.package.name must be jorgex-pi");
  }
  const version = pkg["version"];
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`candidate.package.version must be stable semver, got ${String(version)}`);
  }
  if (pkg["source"] !== `npm:jorgex-pi@${version}`) {
    throw new Error(`candidate.package.source must be npm:jorgex-pi@${version}`);
  }
  if (!isObjectRecord(tarball)) throw new Error("candidate.tarball must be an object");
  const bytes = tarball["bytes"];
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) {
    throw new Error("candidate.tarball.bytes must be a positive integer");
  }
  if (!isHex64(tarball["sha256"])) {
    throw new Error("candidate.tarball.sha256 must be 64 lowercase hex");
  }
  if (typeof tarball["sha512"] !== "string" || !/^[a-f0-9]{128}$/.test(tarball["sha512"] as string)) {
    throw new Error("candidate.tarball.sha512 must be 128 lowercase hex");
  }
  if (!isObjectRecord(provenance) || typeof provenance["commit"] !== "string" || !/^[a-f0-9]{40}$/.test(provenance["commit"] as string)) {
    throw new Error("candidate.provenance.commit must be 40 lowercase hex");
  }

  if (!isObjectRecord(scope)) throw new Error("scope must be an object");
  const kind = (scope as Record<string, unknown>)["kind"];
  if (kind !== "real" && kind !== "target-dir") throw new Error("scope.kind must be real or target-dir");
  const agentDir = assertPureAbsolutePath(
    (scope as Record<string, unknown>)["codingAgentDir"],
    "scope.codingAgentDir (agentDir)",
  );

  const engramResolved = assertPureAbsolutePath(engramBin, "engramBin");
  if (state !== "installing" && state !== "installed") {
    throw new Error("state must be installing or installed");
  }

  const stageResolved = assertPureAbsolutePath(stageDir, "stageDir");
  if (!isStrictChild(agentDir, stageResolved)) {
    throw new Error(`stageDir must be a strict child of the agentDir scope: ${String(stageDir)}`);
  }
  const stageRel = path.relative(agentDir, stageResolved);
  const stageParts = stageRel.split(path.sep);
  if (stageParts.length !== 2 || !/^stage-[0-9a-f]{32}$/.test(stageParts[0] ?? "") || stageParts[1] !== "pi-agent") {
    throw new Error(`stageDir must be exactly agentDir/stage-<32hex>/pi-agent: ${String(stageDir)}`);
  }

  if (typeof releaseId !== "string" || !isHex64(releaseId)) {
    throw new Error(`releaseId must be 64 lowercase hex: ${String(releaseId)}`);
  }

  if (!isObjectRecord(evidence)) throw new Error("evidence must be an object");
  const ev = evidence as Record<string, unknown>;
  if (!isHex64(ev["lockSha256"])) throw new Error("evidence.lockSha256 must be 64 lowercase hex");
  if (!isHex64(ev["treeSha256"])) throw new Error("evidence.treeSha256 must be 64 lowercase hex");
  const deps = ev["dependencies"];
  if (!Array.isArray(deps) || deps.length !== 6) {
    throw new Error(`evidence.dependencies must contain exactly six observed dependencies, got ${Array.isArray(deps) ? deps.length : String(deps)}`);
  }
  const seen = new Set<string>();
  for (const dep of deps) {
    if (!isObjectRecord(dep)) throw new Error("evidence.dependencies entry must be an object");
    const { name, version: depVersion, integrity } = dep as Record<string, unknown>;
    if (typeof name !== "string" || name === "" || /\s/.test(name)) {
      throw new Error(`evidence.dependencies entry has an invalid name: ${String(name)}`);
    }
    if (typeof depVersion !== "string" || depVersion === "" || /\s/.test(depVersion as string)) {
      throw new Error(`evidence.dependencies entry ${String(name)} has an invalid version`);
    }
    if (!isCanonicalSha512(integrity)) {
      throw new Error(`evidence.dependencies entry ${String(name)} integrity must be canonical sha512 SRI`);
    }
    if (seen.has(name as string)) throw new Error(`evidence.dependencies duplicate name: ${String(name)}`);
    seen.add(name as string);
  }

  const npmDir = path.join(agentDir, "npm");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const releaseDir = path.join(managedRoot, "releases", releaseId as string);
  const linkPath = path.join(npmDir, "node_modules", "jorgex-pi");
  const backupDir = path.join(stageResolved, ".activate-backup");
  if (!isStrictChild(managedRoot, path.resolve(releaseDir))) {
    throw new Error(`releaseDir escapes its managed root (symlink escape rejected): ${releaseDir}`);
  }
  if (path.resolve(linkPath) !== linkPath || path.resolve(linkPath) !== path.join(npmDir, "node_modules", "jorgex-pi")) {
    throw new Error(`linkPath escapes its npm root (symlink escape rejected): ${linkPath}`);
  }
  if (!isStrictChild(agentDir, path.resolve(backupDir)) || path.resolve(backupDir) !== backupDir) {
    throw new Error(`backupDir escapes its agentDir scope (symlink escape rejected): ${backupDir}`);
  }
  if (backupDir === npmDir || isStrictChild(npmDir, backupDir)) {
    throw new Error(`backupDir must live under the stage dir, outside the npm root: ${backupDir}`);
  }

  const base = expectedReceipt(
    candidate as unknown as PiRuntimeCandidate,
    state as PiPackageReceipt["state"],
    { kind: kind as "real" | "target-dir", codingAgentDir: agentDir },
    engramResolved,
  );
  return {
    ...base,
    managedPackage: {
      releaseDir,
      linkPath,
      backupDir,
      lockSha256: ev["lockSha256"] as string,
      treeSha256: ev["treeSha256"] as string,
      dependencies: (deps as PiPackageManagedDependency[]).map((dep) => ({ ...dep })),
    },
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
    && managedExternalWritesAreSafe(candidate.contract.managedExternalWrites, candidate.contract.capabilities)
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

export type PiManagedPrimaryModels = {
  mode: "managed-primary";
  primary: { provider: "openai-codex"; model: "gpt-5.6-sol"; contextWindow: 872000 };
  tiers: ["strong", "standard", "cheap"];
};

/**
 * Exact producer models shape (runner-response.v1 `modelsResult`): mode
 * `managed-primary` with primary openai-codex/gpt-5.6-sol/872000 and tiers
 * exact. Rejects missing/wrong primary fields, obsolete `inherit-session`,
 * and any other mode. Single shared validator for both executor paths.
 */
function parseManagedPrimaryModels(value: unknown): PiManagedPrimaryModels | null {
  if (!isObjectRecord(value)) return null;
  if (Object.keys(value).sort().join(",") !== "mode,primary,tiers") return null;
  if (value["mode"] !== "managed-primary") return null;
  const primary = value["primary"];
  if (!isObjectRecord(primary)) return null;
  if (Object.keys(primary).sort().join(",") !== "contextWindow,model,provider") return null;
  if (primary["provider"] !== "openai-codex"
    || primary["model"] !== "gpt-5.6-sol"
    || primary["contextWindow"] !== 872000) {
    return null;
  }
  if (!sameRecord(value["tiers"], ["strong", "standard", "cheap"])) return null;
  return {
    mode: "managed-primary",
    primary: { provider: "openai-codex", model: "gpt-5.6-sol", contextWindow: 872000 },
    tiers: ["strong", "standard", "cheap"],
  };
}

export type PiPackageExecutorResult =
  | { kind: "installed"; receipt: PiPackageReceipt }
  | { kind: "synced"; actions: unknown[]; upgraded?: boolean; policySha256?: string }
  | { kind: "models"; models: PiManagedPrimaryModels }
  | { kind: "manual-existing" }
  | { kind: "blocked"; reason: "pi-install-failed" | "runner-output" | "runner-unhealthy" };

export interface PiPackageExecutorInput {
  operation: PiPackageOperation;
  plan: Pick<PiPackageLifecyclePlan, "kind" | "receipt" | "invocation">;
  candidate: PiRuntimeCandidate;
  packageRunner: string;
  environment: PiPackageEnvironment;
  /** Explicit opt-in to rewrite owned/absent Pi policy via the runner upgrade command. Seed-only unless true with the upgrade capability. */
  upgradePermissions?: boolean;
}

export interface PiPackageExecutorDeps {
  writeReceipt(receipt: PiPackageReceipt): void;
  run(invocation: {
    executable: string;
    args: string[];
    environment: PiPackageEnvironment;
  }): { exitCode: number; stdout: string; stderr: string };
}

type RunnerCommand = Exclude<PiPackageOperation, "install"> | "doctor" | "cleanup" | "status" | "upgrade";

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
  candidate: PiAcceptedCandidate,
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

/** Retryable race-loser signal from the Pi runner: exit 1 with stdout JSON error.code CONFIG_LOCKED. Only this signal is retried. */
const CONFIG_LOCKED_SIGNAL = "CONFIG_LOCKED";
/** Bounded upgrade retries on the lock signal before failing visibly. No unbounded loops. */
const UPGRADE_LOCK_RETRIES = 2;

function stdoutHasConfigLockedSignal(stdout: string): boolean {
  const body = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (body === "" || body.includes("\n") || body.includes("\r")) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const error = Reflect.get(parsed, "error");
    if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
    return Reflect.get(error, "code") === CONFIG_LOCKED_SIGNAL;
  } catch {
    return false;
  }
}

function isConfigLockedFailure(result: { exitCode: number; stdout: string; stderr: string }): boolean {
  if (result.exitCode !== 1) return false;
  return stdoutHasConfigLockedSignal(result.stdout) || result.stderr.includes(CONFIG_LOCKED_SIGNAL);
}

function runUpgradeWithLockRetry(
  input: PiPackageExecutorInput,
  deps: PiPackageExecutorDeps,
): RunnerRecord | PiPackageExecutorResult {
  let retries = 0;
  for (;;) {
    const raw = deps.run({
      executable: input.packageRunner,
      args: ["upgrade", "--json"],
      environment: input.environment,
    });
    if (raw.exitCode !== 0) {
      if (isConfigLockedFailure(raw) && retries < UPGRADE_LOCK_RETRIES) {
        retries += 1;
        continue;
      }
      return { kind: "blocked", reason: "runner-unhealthy" };
    }
    return parseRunnerRecord(raw.stdout, raw.stderr, "upgrade", input.candidate, input.packageRunner)
      ?? { kind: "blocked", reason: "runner-output" };
  }
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
    const syncActions = Reflect.get(result, "actions") as unknown[];
    if (input.upgradePermissions !== true || !supportsPermissionsUpgrade(input.candidate.contract.capabilities)) {
      return { kind: "synced", actions: syncActions };
    }
    const upgrade = runUpgradeWithLockRetry(input, deps);
    if (isBlockedResult(upgrade)) return upgrade;
    const upgraded = upgrade.result;
    if (upgraded === null || typeof upgraded !== "object" || Array.isArray(upgraded)) {
      return { kind: "blocked", reason: "runner-output" };
    }
    const changed = Reflect.get(upgraded, "changed");
    const actions = Reflect.get(upgraded, "actions");
    if ((changed !== true && changed !== false) || !Array.isArray(actions)) {
      return { kind: "blocked", reason: "runner-unhealthy" };
    }
    if (typeof Reflect.get(upgraded, "policy") === "string" || typeof Reflect.get(upgraded, "config") === "string") {
      return { kind: "blocked", reason: "runner-output" };
    }
    if (changed === true) {
      const policySha256 = Reflect.get(upgraded, "policySha256");
      if (typeof policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(policySha256)) {
        return { kind: "blocked", reason: "runner-output" };
      }
      return { kind: "synced", actions: [...syncActions, ...actions], upgraded: true, policySha256 };
    }
    return { kind: "synced", actions: [...syncActions, ...actions], upgraded: false };
  }

  const models = parseManagedPrimaryModels(command.result);
  if (models === null) {
    return { kind: "blocked", reason: "runner-unhealthy" };
  }
  return { kind: "models", models };
}

export interface PiPackageRegistry {
  id: "pi";
  kind: "package-managed";
  candidate: PiRuntimeCandidate;
  acceptedCandidates?: readonly PiAcceptedCandidate[];
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
  /** Offline cache check for a provider-selected managed parent (tarball bytes/SRI, no network). */
  verifyManagedArtifact?(receipt: PiPackageReceipt): boolean;
  /** Re-reads settings.json after the owned cleanup runner may have rewritten it. Managed/legacy uninstall only. */
  readSettings?(): string;
  /** Moves/unlinks only the private owned legacy entry and receipt. Legacy uninstall only. */
  deactivateLegacyRelease?(receipt: PiPackageReceipt, nextSettings: string): { kind: "uninstalled" } | { kind: "blocked"; reason: string };
  /** Ownership check for an accepted legacy v1 receipt without managedPackage (no network). Legacy uninstall only. */
  verifyLegacyPackage?(receipt: PiPackageReceipt): boolean;
  /** Moves/unlinks only the private owned entry, release, and receipt. Managed uninstall only. */
  deactivateManagedRelease?(receipt: PiPackageReceipt, nextSettings: string): { kind: "uninstalled" } | { kind: "blocked"; reason: string };
  run(invocation: {
    executable: string;
    args: string[];
    environment: Record<string, string>;
  }): { exitCode: number; stdout: string; stderr: string };
  isPackageAbsent(): boolean;
  deleteReceipt(): void;
}

export type PiPackageManagedOperationResult =
  | { kind: "healthy"; packageSource?: string }
  | { kind: "uninstalled" }
  | { kind: "blocked"; reason: string; remedy?: string };

function receiptUpgradeRequired(): Extract<PiPackageManagedOperationResult, { kind: "blocked" }> {
  return {
    kind: "blocked",
    reason: "receipt-upgrade-required",
    remedy: "El receipt no enlaza Engram; usa la versión anterior de Stack para desinstalarlo y luego reinstala.",
  };
}

type OwnedOperationState = {
  receipt: PiPackageReceipt;
  source: string;
  matchedCandidate: PiAcceptedCandidate;
};

function validateOwnedOperationState(
  input: PiPackageManagedOperationInput,
): OwnedOperationState | PiPackageManagedOperationResult {
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
  const matchedCandidate = accepted.find((candidate) => sameRecord(receipt.candidate, {
    package: candidate.package,
    tarball: candidate.tarball,
    provenance: candidate.provenance,
  }));
  if (matchedCandidate === undefined) {
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
  return { receipt, source, matchedCandidate };
}

function operationWasBlocked(
  value: OwnedOperationState | PiPackageManagedOperationResult,
): value is PiPackageManagedOperationResult {
  return "kind" in value;
}

function runManagedRunner(
  input: PiPackageManagedOperationInput,
  deps: PiPackageManagedOperationDeps,
  command: RunnerCommand,
  candidate: PiAcceptedCandidate = input.registry.candidate,
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
    candidate,
    input.detected.packageRunner,
  );
  return parsed ?? { kind: "blocked", reason: "runner-output" };
}

function managedRunnerWasBlocked(
  value: RunnerRecord | PiPackageManagedOperationResult,
): value is PiPackageManagedOperationResult {
  return "kind" in value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStrictChild(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCanonicalSha512(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const b64 = value.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  return bytes.length === 64 && bytes.toString("base64") === b64;
}

type ManagedDoctorCheck =
  | { kind: "ok"; packageRoot: string; realRoot: string }
  | { kind: "blocked"; reason: string };

function checkManagedPackageForDoctor(
  input: Pick<PiPackageManagedOperationInput, "paths">,
  managedRaw: unknown,
): ManagedDoctorCheck {
  if (!isObjectRecord(managedRaw)) return { kind: "blocked", reason: "receipt-corrupt" };
  const { releaseDir, linkPath, backupDir, lockSha256, treeSha256, dependencies } = managedRaw;
  if (
    typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)
    || typeof linkPath !== "string" || !path.isAbsolute(linkPath)
    || typeof backupDir !== "string" || !path.isAbsolute(backupDir)
    || !isHex64(lockSha256)
    || !isHex64(treeSha256)
    || !Array.isArray(dependencies)
    || dependencies.length !== 6
  ) {
    return { kind: "blocked", reason: "receipt-corrupt" };
  }
  const seen = new Set<string>();
  for (const dep of dependencies) {
    if (!isObjectRecord(dep)) return { kind: "blocked", reason: "receipt-corrupt" };
    const { name, version, integrity } = dep;
    if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "" || /\s/.test(version)) {
      return { kind: "blocked", reason: "receipt-corrupt" };
    }
    if (!isCanonicalSha512(integrity)) return { kind: "blocked", reason: "receipt-corrupt" };
    if (seen.has(name)) return { kind: "blocked", reason: "receipt-corrupt" };
    seen.add(name);
  }

  const agentDir = path.resolve(input.paths.codingAgentDir);
  const npmDir = path.join(agentDir, "npm");
  const managedRoot = path.join(npmDir, "jorgex-pi-managed");
  const releaseResolved = path.resolve(releaseDir);
  const linkResolved = path.resolve(linkPath);
  const backupResolved = path.resolve(backupDir);
  if (!isStrictChild(managedRoot, releaseResolved)) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  if (!isStrictChild(agentDir, backupResolved)) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  const backupRel = path.relative(agentDir, backupResolved);
  const backupParts = backupRel.split(path.sep);
  if (
    backupParts.length !== 3
    || !/^stage-[0-9a-f]{32}$/.test(backupParts[0] ?? "")
    || backupParts[1] !== "pi-agent"
    || backupParts[2] !== ".activate-backup"
  ) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  if (backupResolved === npmDir || isStrictChild(npmDir, backupResolved)) {
    return { kind: "blocked", reason: "source-divergent" };
  }
  if (linkResolved !== path.join(npmDir, "node_modules", "jorgex-pi")) {
    return { kind: "blocked", reason: "source-divergent" };
  }

  let releaseStat: fs.Stats | null = null;
  try {
    releaseStat = fs.lstatSync(releaseResolved);
  } catch {
    return { kind: "blocked", reason: "link-drift" };
  }
  if (releaseStat === null || !releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    return { kind: "blocked", reason: "link-drift" };
  }
  try {
    let cur = backupResolved;
    for (;;) {
      const st = fs.lstatSync(cur);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return { kind: "blocked", reason: "link-drift" };
      }
      if (cur === agentDir) break;
      const parent = path.dirname(cur);
      if (parent === cur) return { kind: "blocked", reason: "source-divergent" };
      cur = parent;
    }
  } catch {
    return { kind: "blocked", reason: "link-drift" };
  }

  const packageRoot = path.join(releaseResolved, "node_modules", "jorgex-pi");
  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(linkResolved);
  } catch {
    return { kind: "blocked", reason: "link-drift" };
  }
  if (linkStat === null || !linkStat.isSymbolicLink()) return { kind: "blocked", reason: "link-drift" };
  let target: string;
  try {
    target = fs.readlinkSync(linkResolved);
  } catch {
    return { kind: "blocked", reason: "link-drift" };
  }
  if (target === "" || path.isAbsolute(target)) return { kind: "blocked", reason: "link-drift" };
  if (path.resolve(path.dirname(linkResolved), target) !== packageRoot) {
    return { kind: "blocked", reason: "link-drift" };
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(linkResolved);
  } catch {
    return { kind: "blocked", reason: "link-drift" };
  }
  if (realRoot !== packageRoot || !isStrictChild(npmDir, realRoot)) {
    return { kind: "blocked", reason: "link-drift" };
  }

  const lockPath = path.join(releaseResolved, "package-lock.json");
  let lockStat: fs.Stats | null = null;
  try {
    lockStat = fs.lstatSync(lockPath);
  } catch {
    return { kind: "blocked", reason: "lock-drift" };
  }
  if (lockStat === null || !lockStat.isFile() || lockStat.isSymbolicLink()) {
    return { kind: "blocked", reason: "lock-drift" };
  }
  let lockBytes: Buffer;
  try {
    lockBytes = fs.readFileSync(lockPath);
  } catch {
    return { kind: "blocked", reason: "lock-drift" };
  }
  if (createHash("sha256").update(lockBytes).digest("hex") !== lockSha256) {
    return { kind: "blocked", reason: "lock-drift" };
  }
  let lockJson: unknown;
  try {
    lockJson = JSON.parse(lockBytes.toString("utf8")) as unknown;
  } catch {
    return { kind: "blocked", reason: "lock-drift" };
  }
  if (!isObjectRecord(lockJson) || !isObjectRecord(lockJson["packages"])) {
    return { kind: "blocked", reason: "lock-drift" };
  }
  const packages = lockJson["packages"] as Record<string, unknown>;
  for (const dep of dependencies as PiPackageManagedDependency[]) {
    const entry = packages[`node_modules/${dep.name}`];
    if (!isObjectRecord(entry) || entry["version"] !== dep.version || entry["integrity"] !== dep.integrity) {
      return { kind: "blocked", reason: "receipt-corrupt" };
    }
  }

  let recomputed: string;
  try {
    recomputed = inventoryTreeSha256(releaseResolved);
  } catch {
    return { kind: "blocked", reason: "tree-drift" };
  }
  if (recomputed !== treeSha256) return { kind: "blocked", reason: "tree-drift" };

  return { kind: "ok", packageRoot, realRoot };
}

function parseManagedDoctorRunner(
  stdout: string,
  stderr: string,
  candidate: PiRuntimeCandidate,
  expectedRoot: string,
): RunnerRecord | null {
  if (stderr !== "" || !stdout.endsWith("\n") || Buffer.byteLength(stdout) > candidate.contract.runner.maxStdoutBytes) {
    return null;
  }
  const body = stdout.slice(0, -1);
  if (body === "" || body.includes("\n") || body.includes("\r")) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObjectRecord(parsed)) return null;
    const record = parsed as Partial<RunnerRecord>;
    if (record.schemaVersion !== candidate.contract.runner.schemaVersion
      || record.command !== "doctor"
      || record.ok !== true
      || !isObjectRecord(record.package)
      || record.package["name"] !== candidate.package.name
      || record.package["version"] !== candidate.package.version
      || typeof record.package["root"] !== "string"
      || !path.isAbsolute(record.package["root"] as string)
      || path.resolve(record.package["root"] as string) !== expectedRoot) {
      return null;
    }
    return record as RunnerRecord;
  } catch {
    return null;
  }
}

/**
 * Offline runner envelope for a provider-selected managed release: bounded
 * single-line JSON, schema1, ok:true, identity from the validated receipt
 * parent plus the validated private realpath, size/schema policy from the
 * frozen registry candidate. Never the current pin version as identity.
 */
function parseOfflineManagedRunner(
  stdout: string,
  stderr: string,
  command: "doctor" | "sync" | "cleanup" | "models",
  receipt: PiPackageReceipt,
  registryCandidate: PiRuntimeCandidate,
  expectedRoot: string,
): RunnerRecord | null {
  if (stderr !== "" || !stdout.endsWith("\n") || Buffer.byteLength(stdout) > registryCandidate.contract.runner.maxStdoutBytes) {
    return null;
  }
  const body = stdout.slice(0, -1);
  if (body === "" || body.includes("\n") || body.includes("\r")) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObjectRecord(parsed)) return null;
    const record = parsed as Partial<RunnerRecord>;
    if (record.schemaVersion !== registryCandidate.contract.runner.schemaVersion
      || record.command !== command
      || record.ok !== true
      || !isObjectRecord(record.package)
      || record.package["name"] !== receipt.candidate.package.name
      || record.package["version"] !== receipt.candidate.package.version
      || typeof record.package["root"] !== "string"
      || !path.isAbsolute(record.package["root"] as string)
      || path.resolve(record.package["root"] as string) !== expectedRoot) {
      return null;
    }
    return record as RunnerRecord;
  } catch {
    return null;
  }
}

export type VerifyOfflineManagedPiReleaseInput = Pick<
  PiPackageManagedOperationInput,
  "detected" | "engramBin" | "receiptJson" | "paths"
>;

export type VerifyOfflineManagedPiReleaseDeps = Pick<PiPackageManagedOperationDeps, "verifyManagedArtifact">;

export type VerifyOfflineManagedPiReleaseResult =
  | { kind: "ok"; receipt: PiPackageReceipt; realRoot: string }
  | Extract<PiPackageManagedOperationResult, { kind: "blocked" }>;

type OfflineManagedCheck = VerifyOfflineManagedPiReleaseResult;

/**
 * Shared offline gate for a provider-selected managed release: authenticates
 * the schema1 managedPackage receipt (scope/engram/exact managed source),
 * validates link/backup/lock/tree evidence, then requires the cached-tgz
 * callback. Never accepts a legacy receipt without managedPackage and never
 * consults the current pin identity; the caller parses the runner with the
 * receipt identity plus the registry runner policy. No runner, no writes.
 */
export function verifyOfflineManagedPiRelease(
  input: VerifyOfflineManagedPiReleaseInput,
  deps: VerifyOfflineManagedPiReleaseDeps,
): VerifyOfflineManagedPiReleaseResult {
  const sources = parsePackageSources(input.detected.settingsJson);
  if (sources === null) return { kind: "blocked", reason: "settings-corrupt" };
  const matchingSources = sources.filter(({ source }) => isJorgeXPiSource(source));
  if (matchingSources.length > 1) return { kind: "blocked", reason: "duplicate-package" };
  if (input.receiptJson === null) return { kind: "blocked", reason: "receipt-untrusted" };
  const parsedReceipt = parseReceiptShape(input.receiptJson);
  if (parsedReceipt === "upgrade-required") return receiptUpgradeRequired();
  if (parsedReceipt === null) return { kind: "blocked", reason: "receipt-corrupt" };
  const receipt = parsedReceipt;
  if (receipt.state !== "installed") return { kind: "blocked", reason: "partial-state" };
  const managedRaw = (receipt as { managedPackage?: unknown }).managedPackage;
  if (managedRaw === undefined) return { kind: "blocked", reason: "receipt-untrusted" };
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
  const checked = checkManagedPackageForDoctor(input, managedRaw);
  if (checked.kind === "blocked") return checked;
  if (typeof deps.verifyManagedArtifact !== "function") {
    return { kind: "blocked", reason: "receipt-untrusted" };
  }
  let verified = false;
  try {
    verified = deps.verifyManagedArtifact(receipt) === true;
  } catch {
    return { kind: "blocked", reason: "receipt-untrusted" };
  }
  if (!verified) return { kind: "blocked", reason: "receipt-untrusted" };
  return { kind: "ok", receipt, realRoot: checked.realRoot };
}

function runOfflineManagedDoctor(
  input: PiPackageManagedOperationInput,
  deps: PiPackageManagedOperationDeps,
): PiPackageManagedOperationResult {
  const validated = verifyOfflineManagedPiRelease(input, deps);
  if (validated.kind === "blocked") return validated;
  const raw = deps.run({
    executable: input.detected.packageRunner,
    args: ["doctor", "--json"],
    environment: input.paths.environment,
  });
  if (raw.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  const doctor = parseOfflineManagedRunner(raw.stdout, raw.stderr, "doctor", validated.receipt, input.registry.candidate, validated.realRoot);
  if (doctor === null) return { kind: "blocked", reason: "runner-output" };
  const result = doctor.result;
  return result !== null && typeof result === "object" && Reflect.get(result, "healthy") === true
    ? { kind: "healthy", packageSource: validated.receipt.candidate.package.source }
    : { kind: "blocked", reason: "runner-unhealthy" };
}

export type PiPackageManagedSyncInput = Omit<PiPackageManagedOperationInput, "operation"> & {
  operation: "sync";
};

export type PiPackageManagedSyncResult =
  | { kind: "synced"; actions: unknown[]; packageSource: string }
  | { kind: "blocked"; reason: string; remedy?: string };

/**
 * Offline sync for a verified managed private release. Shares the offline
 * gate with doctor (receipt auth, evidence, cached-tgz callback) and parses
 * the `sync` runner record with the receipt parent identity plus the
 * registry runner policy. Never a future version selector.
 */
export function runPiPackageManagedSync(
  input: PiPackageManagedSyncInput,
  deps: PiPackageManagedOperationDeps,
): PiPackageManagedSyncResult {
  if (input.engramBin === null) {
    return {
      kind: "blocked",
      reason: "engram-missing",
      remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
    };
  }
  const validated = verifyOfflineManagedPiRelease(input, deps);
  if (validated.kind === "blocked") return validated;
  const raw = deps.run({
    executable: input.detected.packageRunner,
    args: ["sync", "--json"],
    environment: input.paths.environment,
  });
  if (raw.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  const synced = parseOfflineManagedRunner(raw.stdout, raw.stderr, "sync", validated.receipt, input.registry.candidate, validated.realRoot);
  if (synced === null) return { kind: "blocked", reason: "runner-output" };
  const result = synced.result;
  if (result === null
    || typeof result !== "object"
    || (Reflect.get(result, "changed") !== true && Reflect.get(result, "changed") !== false)
    || !Array.isArray(Reflect.get(result, "actions"))) {
    return { kind: "blocked", reason: "runner-unhealthy" };
  }
  return {
    kind: "synced",
    actions: Reflect.get(result, "actions") as unknown[],
    packageSource: validated.receipt.candidate.package.source,
  };
}

export type PiPackageManagedModelsInput = Omit<PiPackageManagedOperationInput, "operation"> & {
  operation: "models";
};

export type PiPackageManagedModelsResult =
  | { kind: "models"; models: PiManagedPrimaryModels }
  | { kind: "blocked"; reason: string; remedy?: string };

/**
 * Offline models for a verified managed private release. Shares the offline
 * gate with doctor/sync (receipt auth, evidence, cached-tgz callback) and
 * parses the `models` runner record with the receipt parent identity plus the
 * registry runner policy. Requires exact managed-primary producer shape.
 * Never a future version selector, no downloads or mutations.
 */
export function runPiPackageManagedModels(
  input: PiPackageManagedModelsInput,
  deps: PiPackageManagedOperationDeps,
): PiPackageManagedModelsResult {
  if (input.engramBin === null) {
    return {
      kind: "blocked",
      reason: "engram-missing",
      remedy: "Instala Engram o configura un ENGRAM_BIN absoluto antes de reintentar.",
    };
  }
  const validated = verifyOfflineManagedPiRelease(input, deps);
  if (validated.kind === "blocked") return validated;
  const raw = deps.run({
    executable: input.detected.packageRunner,
    args: ["models", "--json"],
    environment: input.paths.environment,
  });
  if (raw.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  const parsed = parseOfflineManagedRunner(raw.stdout, raw.stderr, "models", validated.receipt, input.registry.candidate, validated.realRoot);
  if (parsed === null) return { kind: "blocked", reason: "runner-output" };
  const models = parseManagedPrimaryModels(parsed.result);
  if (models === null) {
    return { kind: "blocked", reason: "runner-unhealthy" };
  }
  return { kind: "models", models };
}

/**
 * Shared deactivate failure mapping: an incomplete-recovery throw retains
 * backup/marker/lock and must surface explicitly, never as opaque
 * remove-failed. Normal or recovery:'complete' throws stay remove-failed.
 */
function mapDeactivateError(error: unknown): Extract<PiPackageManagedOperationResult, { kind: "blocked" }> {
  if (error !== null
    && typeof error === "object"
    && Reflect.get(error as object, "recovery") === "incomplete") {
    return {
      kind: "blocked",
      reason: "recovery-incomplete",
      remedy: "Retained backup/marker/lock requires manual inspection; do not retry uninstall until resolved.",
    };
  }
  return { kind: "blocked", reason: "remove-failed" };
}

/**
 * Offline uninstall for a verified managed private release. Shares the
 * offline gate with doctor/sync (receipt auth, evidence, cached-tgz
 * callback), journals settings before the owned `cleanup` runner, re-reads
 * settings after cleanup, plans pure removal of the owned entry, and lets
 * the deactivate callback move/unlink only private owned state. Never a
 * native `pi remove`; legacy receipts without managedPackage keep the old
 * path. Never a future version selector.
 */
function runOfflineManagedUninstall(
  input: PiPackageManagedOperationInput,
  deps: PiPackageManagedOperationDeps,
): PiPackageManagedOperationResult {
  const validated = verifyOfflineManagedPiRelease(input, deps);
  if (validated.kind === "blocked") return validated;
  if (typeof deps.readSettings !== "function" || typeof deps.deactivateManagedRelease !== "function") {
    return { kind: "blocked", reason: "remove-failed" };
  }
  deps.backupSettings();
  const raw = deps.run({
    executable: input.detected.packageRunner,
    args: ["cleanup", "--json"],
    environment: input.paths.environment,
  });
  if (raw.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
  const cleaned = parseOfflineManagedRunner(raw.stdout, raw.stderr, "cleanup", validated.receipt, input.registry.candidate, validated.realRoot);
  if (cleaned === null) return { kind: "blocked", reason: "runner-output" };
  let freshSettings: string;
  try {
    freshSettings = deps.readSettings();
  } catch {
    return { kind: "blocked", reason: "remove-failed" };
  }
  const nextSettings = planPiManagedRemoval(freshSettings, validated.receipt.candidate.package.source);
  if (nextSettings === null) return { kind: "blocked", reason: "source-divergent" };
  let deactivated: { kind: "uninstalled" } | { kind: "blocked"; reason: string };
  try {
    deactivated = deps.deactivateManagedRelease(validated.receipt, nextSettings);
  } catch (error) {
    return mapDeactivateError(error);
  }
  if (deactivated.kind !== "uninstalled") {
    return { kind: "blocked", reason: deactivated.reason };
  }
  return { kind: "uninstalled" };
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
  if (input.operation === "uninstall" && input.receiptJson !== null) {
    const probe = parseReceiptShape(input.receiptJson);
    if (probe !== null && probe !== "upgrade-required" && probe.managedPackage !== undefined) {
      return runOfflineManagedUninstall(input, deps);
    }
  }
  const owned = validateOwnedOperationState(input);
  if (operationWasBlocked(owned)) {
    if (input.operation === "doctor" && owned.kind === "blocked" && owned.reason === "receipt-untrusted") {
      return runOfflineManagedDoctor(input, deps);
    }
    return owned;
  }

  if (input.operation === "doctor") {
    const managedRaw = (owned.receipt as { managedPackage?: unknown }).managedPackage;
    if (managedRaw !== undefined) {
      if (!sameRecord(owned.receipt.candidate, {
        package: input.registry.candidate.package,
        tarball: input.registry.candidate.tarball,
        provenance: input.registry.candidate.provenance,
      })) {
        return { kind: "blocked", reason: "source-divergent" };
      }
      const checked = checkManagedPackageForDoctor(input, managedRaw);
      if (checked.kind === "blocked") return checked;
      const raw = deps.run({
        executable: input.detected.packageRunner,
        args: ["doctor", "--json"],
        environment: input.paths.environment,
      });
      if (raw.exitCode !== 0) return { kind: "blocked", reason: "runner-unhealthy" };
      const doctor = parseManagedDoctorRunner(raw.stdout, raw.stderr, input.registry.candidate, checked.realRoot);
      if (doctor === null) return { kind: "blocked", reason: "runner-output" };
      const result = doctor.result;
      return result !== null && typeof result === "object" && Reflect.get(result, "healthy") === true
        ? { kind: "healthy" }
        : { kind: "blocked", reason: "runner-unhealthy" };
    }
    const doctor = runManagedRunner(input, deps, "doctor", owned.matchedCandidate);
    if (managedRunnerWasBlocked(doctor)) return doctor;
    const result = doctor.result;
    return result !== null && typeof result === "object" && Reflect.get(result, "healthy") === true
      ? { kind: "healthy" }
      : { kind: "blocked", reason: "runner-unhealthy" };
  }

  if (input.operation === "uninstall") {
    // Legacy v1 without managedPackage: offline deactivation via the owned
    // accepted runner. Applies to any owned accepted parent (.24,
    // historical .29); never `pi remove` on the shared npm root.
    if (typeof deps.verifyLegacyPackage !== "function") {
      return { kind: "blocked", reason: "receipt-untrusted" };
    }
    let legacyVerified = false;
    try {
      legacyVerified = deps.verifyLegacyPackage(owned.receipt) === true;
    } catch {
      return { kind: "blocked", reason: "receipt-untrusted" };
    }
    if (!legacyVerified) return { kind: "blocked", reason: "receipt-untrusted" };
    if (typeof deps.readSettings !== "function" || typeof deps.deactivateLegacyRelease !== "function") {
      return { kind: "blocked", reason: "remove-failed" };
    }
    deps.backupSettings();
    const cleanup = runManagedRunner(input, deps, "cleanup", owned.matchedCandidate);
    if (managedRunnerWasBlocked(cleanup)) return cleanup;
    let freshSettings: string;
    try {
      freshSettings = deps.readSettings();
    } catch {
      return { kind: "blocked", reason: "remove-failed" };
    }
    const nextSettings = planPiManagedRemoval(freshSettings, owned.source);
    if (nextSettings === null) return { kind: "blocked", reason: "source-divergent" };
    let deactivated: { kind: "uninstalled" } | { kind: "blocked"; reason: string };
    try {
      deactivated = deps.deactivateLegacyRelease(owned.receipt, nextSettings);
    } catch (error) {
      return mapDeactivateError(error);
    }
    if (deactivated.kind !== "uninstalled") {
      return { kind: "blocked", reason: deactivated.reason };
    }
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

export interface PiLegacyMigrationInput {
  readonly receiptJson: string | null;
  readonly settingsJson: string;
  readonly codingAgentDir: string;
  readonly engramBin: string;
  readonly scopeKind: "real" | "target-dir";
  readonly acceptedCandidates: readonly PiAcceptedCandidate[];
}

export type PiLegacyMigrationResult =
  | { readonly previousSource: string; readonly receipt: PiPackageReceipt }
  | { readonly kind: "blocked"; readonly reason: string };

function legacyBlocked(reason: string): Extract<PiLegacyMigrationResult, { kind: "blocked" }> {
  return { kind: "blocked", reason };
}

/**
 * T07 GREEN legacy v1 read-only migration guard (pure, no writes/runner/network).
 *
 * Authenticates a schemaVersion 1 LEGACY receipt WITHOUT managedPackage whose
 * {package,tarball,provenance} matches exactly one accepted historical recovery
 * candidate, with exact scope kind/codingAgentDir and engram binary, exactly one
 * Stack managed package entry, and a real (non-symlink) legacy package root
 * `agentDir/npm/node_modules/jorgex-pi` with matching installed package.json.
 * Reuses parseReceiptShape, accepted-candidate identity match (sameRecord),
 * isExactManagedPackage and parsePackageSources. Fail-closed with a stable
 * reason; never removes state and never treats raw JSON as crypto proof.
 */
export function preparePiLegacyMigration(input: PiLegacyMigrationInput): PiLegacyMigrationResult {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return legacyBlocked("receipt-corrupt");
    }
    const { receiptJson, settingsJson, codingAgentDir, engramBin, scopeKind, acceptedCandidates } = input;

    if (scopeKind !== "real" && scopeKind !== "target-dir") {
      return legacyBlocked("source-divergent");
    }
    if (typeof codingAgentDir !== "string" || codingAgentDir === "" || !path.isAbsolute(codingAgentDir)) {
      return legacyBlocked("source-divergent");
    }
    if (typeof engramBin !== "string" || engramBin === "") {
      return legacyBlocked("engram-missing");
    }
    if (!path.isAbsolute(engramBin)) {
      return legacyBlocked("receipt-corrupt");
    }
    if (typeof settingsJson !== "string") {
      return legacyBlocked("settings-corrupt");
    }
    if (!Array.isArray(acceptedCandidates) || acceptedCandidates.length === 0) {
      return legacyBlocked("receipt-untrusted");
    }
    if (receiptJson === null) {
      return legacyBlocked("receipt-untrusted");
    }
    if (typeof receiptJson !== "string") {
      return legacyBlocked("receipt-corrupt");
    }

    const parsedReceipt = parseReceiptShape(receiptJson);
    if (parsedReceipt === "upgrade-required") {
      return legacyBlocked("receipt-upgrade-required");
    }
    if (parsedReceipt === null) {
      return legacyBlocked("receipt-corrupt");
    }
    if (parsedReceipt.state !== "installed") {
      return legacyBlocked("partial-state");
    }
    if (Reflect.get(parsedReceipt as unknown as Record<string, unknown>, "managedPackage") !== undefined) {
      return legacyBlocked("receipt-untrusted");
    }

    const matched = acceptedCandidates.find((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const pkg = Reflect.get(candidate, "package");
      const tarball = Reflect.get(candidate, "tarball");
      const provenance = Reflect.get(candidate, "provenance");
      if (pkg === null || typeof pkg !== "object" || tarball === null || typeof tarball !== "object"
        || provenance === null || typeof provenance !== "object") {
        return false;
      }
      return sameRecord(parsedReceipt.candidate, {
        package: candidate.package,
        tarball: candidate.tarball,
        provenance: candidate.provenance,
      });
    });
    if (matched === undefined) {
      return legacyBlocked("receipt-untrusted");
    }

    if (!path.isAbsolute(parsedReceipt.scope.codingAgentDir)) {
      return legacyBlocked("source-divergent");
    }
    if (parsedReceipt.scope.kind !== scopeKind
      || path.resolve(parsedReceipt.scope.codingAgentDir) !== path.resolve(codingAgentDir)) {
      return legacyBlocked("source-divergent");
    }
    if (path.resolve(parsedReceipt.engram.binary) !== path.resolve(engramBin)) {
      return legacyBlocked("receipt-corrupt");
    }

    const sources = parsePackageSources(settingsJson);
    if (sources === null) {
      return legacyBlocked("settings-corrupt");
    }
    const matchingSources = sources.filter(({ source }) => isJorgeXPiSource(source));
    if (matchingSources.length > 1) {
      return legacyBlocked("duplicate-package");
    }
    if (matchingSources.length !== 1) {
      return legacyBlocked("source-divergent");
    }
    const matchingSource = matchingSources[0];
    if (matchingSource === undefined
      || matchingSource.source !== matched.package.source
      || !isExactManagedPackage(matchingSource.entry, matched.package.source)) {
      return legacyBlocked("source-divergent");
    }

    const agentDirResolved = path.resolve(codingAgentDir);
    const packageRoot = path.join(agentDirResolved, "npm", "node_modules", "jorgex-pi");
    const ancestors = [
      agentDirResolved,
      path.join(agentDirResolved, "npm"),
      path.join(agentDirResolved, "npm", "node_modules"),
      packageRoot,
    ];
    for (const dir of ancestors) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(dir);
      } catch {
        return legacyBlocked("link-drift");
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return legacyBlocked("link-drift");
      }
    }

    const manifestPath = path.join(packageRoot, "package.json");
    let manifestStat: fs.Stats;
    try {
      manifestStat = fs.lstatSync(manifestPath);
    } catch {
      return legacyBlocked("link-drift");
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return legacyBlocked("link-drift");
    }
    if (manifestStat.size > 65_536) {
      return legacyBlocked("receipt-corrupt");
    }
    let manifestBytes: Buffer;
    try {
      manifestBytes = fs.readFileSync(manifestPath);
    } catch {
      return legacyBlocked("link-drift");
    }
    if (manifestBytes.byteLength > 65_536) {
      return legacyBlocked("receipt-corrupt");
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    } catch {
      return legacyBlocked("receipt-corrupt");
    }
    if (!isObjectRecord(manifest)
      || manifest["name"] !== "jorgex-pi"
      || manifest["version"] !== matched.package.version) {
      return legacyBlocked("receipt-corrupt");
    }

    return { previousSource: matched.package.source, receipt: parsedReceipt };
  } catch {
    return legacyBlocked("receipt-corrupt");
  }
}
