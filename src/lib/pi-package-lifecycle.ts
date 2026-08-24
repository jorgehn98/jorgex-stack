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
    readonly managedExternalWrites: readonly string[];
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
}

export interface PiPackageEnvironment {
  PI_CODING_AGENT_DIR: string;
  ENGRAM_BIN: string;
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
]);

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function parsePackageSources(settingsJson: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const packages = Reflect.get(parsed, "packages");
    if (!Array.isArray(packages)) return null;
    const sources = packages.map(packageSource);
    return sources.every((source): source is string => source !== null) ? sources : null;
  } catch {
    return null;
  }
}

function expectedReceipt(candidate: PiRuntimeCandidate, state: PiPackageReceipt["state"]): PiPackageReceipt {
  return {
    schemaVersion: 1,
    state,
    candidate: {
      package: candidate.package,
      tarball: candidate.tarball,
      provenance: candidate.provenance,
    },
  };
}

function parseReceipt(receiptJson: string, candidate: PiRuntimeCandidate): PiPackageReceipt | null {
  try {
    const parsed: unknown = JSON.parse(receiptJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = Reflect.get(parsed, "state");
    if (state !== "installing" && state !== "installed") return null;
    const expected = expectedReceipt(candidate, state);
    return sameRecord(parsed, expected) ? expected : null;
  } catch {
    return null;
  }
}

function candidateIsValid(candidate: PiRuntimeCandidate, observed: CandidateTarball): boolean {
  return candidate.package.name === "jorgex-pi"
    && candidate.package.source === `npm:${candidate.package.name}@${candidate.package.version}`
    && candidate.contract.schemaVersion === 1
    && candidate.contract.runner.schemaVersion === 1
    && candidate.contract.runner.bin === "jorgex-pi"
    && candidate.contract.runner.maxStdoutBytes === 65_536
    && candidate.contract.managedExternalWrites.length === 0
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
  const matchingSources = sources.filter(isJorgeXPiSource);
  const exactSources = matchingSources.filter((source) => source === input.candidate.package.source);
  if (exactSources.length > 1) return blocked(input, "duplicate-package");
  if (matchingSources.some((source) => source !== input.candidate.package.source)) {
    return blocked(input, "source-divergent");
  }

  let receipt: PiPackageReceipt | null = null;
  if (input.receiptJson !== null) {
    receipt = parseReceipt(input.receiptJson, input.candidate);
    if (receipt === null) return blocked(input, "receipt-corrupt");
    if (receipt.state === "installing") return blocked(input, "partial-state");
    if (exactSources.length !== 1) return blocked(input, "partial-state");
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
      args: ["install", input.candidate.package.source],
      environment: input.scope.environment,
    },
    receipt: expectedReceipt(input.candidate, "installing"),
    ownership: ownership(true),
  };
}
