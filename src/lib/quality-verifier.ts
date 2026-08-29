import { createHash } from "node:crypto";
import { samePath } from "./paths.js";
import {
  QUALITY_PROFILES,
  evaluateQualityPolicy,
  type QualityControlDefinition,
  type QualityPolicyStatus,
  type QualityProfile,
} from "./quality-policy.js";
import {
  canonicalJson,
  sha256,
  validateQualityReceipt,
  type QualityReceipt,
  type QualityReceiptIdentity,
} from "./quality-receipt.js";

export type ProtectedReference = {
  ref: string;
  sha: string;
};

export type ExternalDecision = "pass" | "fail" | "incomplete";

export type ExternalAttestation = {
  issuer: string;
  executionId: string;
  identity: QualityReceipt["identity"];
  policyDigest: string;
  protectedRef: ProtectedReference;
  producer: {
    processId: string;
    worktree: string;
  };
  decision: ExternalDecision;
  subjectDigest: string;
  evidenceDigest: string;
  expiresAt: string;
  proof: string;
};

export type ExternalEvidence = {
  locator: string;
  bytes: Uint8Array;
  attestation: ExternalAttestation;
};

export type ExternalEvidenceResolution =
  | { status: "available"; evidence: ExternalEvidence }
  | { status: "expired" | "unavailable"; retryable: boolean };

export type AttestationVerification = {
  authenticated: boolean;
};

export type ExternalQualityVerifierInput = {
  receipt: QualityReceipt;
  expected: {
    identity: QualityReceipt["identity"];
    policy: Record<string, unknown>;
    protectedRef: ProtectedReference;
    evidenceLocator: string;
    issuer: string;
    executionId: string;
    subjectDigest: string;
    verifier: {
      processId: string;
      worktree: string;
    };
  };
};

export type ExternalQualityVerifierDeps = {
  /**
   * Resolves evidence under the caller's own network and resource-safety policy.
   * This verifier does not fetch, cap, or sandbox the returned bytes; the
   * implementation must enforce size, timeout, redirect, host, DNS, and SSRF limits.
   */
  resolveEvidence(locator: string): Promise<ExternalEvidenceResolution>;
  /**
   * Must authenticate the proof and issuer and bind that authentication to all
   * attestation claims. A true flag based only on shape or the issuer string is
   * not sufficient because this result is the verifier's authentication gate.
   */
  authenticateAttestation(
    attestation: ExternalAttestation,
  ): Promise<AttestationVerification>;
  now(): string;
};

/**
 * Consumers must treat `incomplete` as a non-pass. `rerunRequired` is only a
 * retry hint for evidence-resolution failure, not a general approval signal.
 */
export type ExternalQualityVerifierResult =
  | { status: "pass"; rerunRequired: false }
  | { status: "fail"; rerunRequired: false }
  | { status: "incomplete"; rerunRequired: boolean };

type UnknownRecord = Record<string, unknown>;

type PreparedVerification = {
  receipt: QualityReceipt;
  expected: ExternalQualityVerifierInput["expected"];
  policyDigest: string;
  subjectDigest: string;
  policyStatus: QualityPolicyStatus;
};

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSha(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function hexEqual(left: unknown, right: unknown): boolean {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

function isQualityProfile(value: unknown): value is QualityProfile {
  return typeof value === "string" && (QUALITY_PROFILES as readonly string[]).includes(value);
}

function isQualityReceiptIdentity(value: unknown): value is QualityReceiptIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["profile", "baseSha", "headSha", "policyDigest"])) return false;
  return isQualityProfile(value.profile)
    && isSha(value.baseSha, COMMIT_SHA_PATTERN)
    && isSha(value.headSha, COMMIT_SHA_PATTERN)
    && isSha(value.policyDigest, SHA256_PATTERN);
}

function sameQualityReceiptIdentity(
  left: QualityReceiptIdentity,
  right: QualityReceiptIdentity,
): boolean {
  return left.profile === right.profile
    && hexEqual(left.baseSha, right.baseSha)
    && hexEqual(left.headSha, right.headSha)
    && hexEqual(left.policyDigest, right.policyDigest);
}

function sameProtectedReference(left: ProtectedReference, right: ProtectedReference): boolean {
  return left.ref === right.ref && hexEqual(left.sha, right.sha);
}

function isProtectedReference(value: unknown): value is ProtectedReference {
  return isRecord(value)
    && hasExactKeys(value, ["ref", "sha"])
    && hasText(value.ref)
    && isSha(value.sha, COMMIT_SHA_PATTERN);
}

function isVerifierBoundary(value: unknown): value is { processId: string; worktree: string } {
  return isRecord(value)
    && hasExactKeys(value, ["processId", "worktree"])
    && hasText(value.processId)
    && hasText(value.worktree);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function subjectDigestFor(receipt: QualityReceipt): string {
  return sha256(canonicalJson({
    namespace: receipt.namespace,
    version: receipt.version,
    authority: receipt.authority,
    identity: receipt.identity,
    commands: receipt.commands,
    results: receipt.results,
  }));
}

function isQualityPolicy(value: unknown): value is Record<string, unknown> & {
  controls: QualityControlDefinition[];
  profile?: QualityProfile;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ["profile", "controls"]) || !Array.isArray(value.controls)) return false;

  if (Object.prototype.hasOwnProperty.call(value, "profile") && !isQualityProfile(value.profile)) return false;

  const ids = new Set<string>();
  for (const control of value.controls) {
    if (!isRecord(control)
      || !hasOnlyKeys(control, ["id", "requirement", "notApplicable"])
      || !hasText(control.id)
      || (control.requirement !== "required" && control.requirement !== "optional")
      || ids.has(control.id)
      || (Object.prototype.hasOwnProperty.call(control, "notApplicable")
        && typeof control.notApplicable !== "boolean")) {
      return false;
    }
    ids.add(control.id);
  }

  return true;
}

function isAttestation(value: unknown): value is ExternalAttestation {
  return isRecord(value)
    && hasExactKeys(value, [
      "issuer",
      "executionId",
      "identity",
      "policyDigest",
      "protectedRef",
      "producer",
      "decision",
      "subjectDigest",
      "evidenceDigest",
      "expiresAt",
      "proof",
    ])
    && hasText(value.issuer)
    && hasText(value.executionId)
    && isQualityReceiptIdentity(value.identity)
    && isSha(value.policyDigest, SHA256_PATTERN)
    && isProtectedReference(value.protectedRef)
    && isVerifierBoundary(value.producer)
    && (value.decision === "pass" || value.decision === "fail" || value.decision === "incomplete")
    && isSha(value.subjectDigest, SHA256_PATTERN)
    && isSha(value.evidenceDigest, SHA256_PATTERN)
    && hasText(value.expiresAt)
    && hasText(value.proof);
}

function isExternalEvidence(value: unknown): value is ExternalEvidence {
  return isRecord(value)
    && hasExactKeys(value, ["locator", "bytes", "attestation"])
    && hasText(value.locator)
    && value.bytes instanceof Uint8Array
    && isAttestation(value.attestation);
}

function isAttestationVerification(value: unknown): value is AttestationVerification {
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "authenticated")
    && typeof value.authenticated === "boolean";
}

function isAvailableResolution(value: unknown): value is { status: "available"; evidence: ExternalEvidence } {
  return isRecord(value)
    && hasExactKeys(value, ["status", "evidence"])
    && value.status === "available"
    && isExternalEvidence(value.evidence);
}

function isRetryableResolution(
  value: unknown,
): value is { status: "expired" | "unavailable"; retryable: boolean } {
  return isRecord(value)
    && hasExactKeys(value, ["status", "retryable"])
    && (value.status === "expired" || value.status === "unavailable")
    && typeof value.retryable === "boolean";
}

function prepareVerification(input: ExternalQualityVerifierInput): PreparedVerification | null {
  try {
    const receipt = input.receipt;
    const expected = input.expected;

    if (!isRecord(expected as unknown)
      || !isQualityReceiptIdentity(expected.identity)
      || !isQualityPolicy(expected.policy)
      || !isProtectedReference(expected.protectedRef)
      || !isVerifierBoundary(expected.verifier)
      || !hasText(expected.evidenceLocator)
      || !hasText(expected.issuer)
      || !hasText(expected.executionId)
      || !isSha(expected.subjectDigest, SHA256_PATTERN)) {
      return null;
    }

    validateQualityReceipt(receipt);
    if (!sameQualityReceiptIdentity(receipt.identity, expected.identity)) return null;
    if (receipt.authority !== "enforced" || receipt.provenance === undefined) return null;

    if (receipt.provenance.issuer !== expected.issuer
      || receipt.provenance.executionId !== expected.executionId
      || receipt.provenance.evidenceLocator !== expected.evidenceLocator) {
      return null;
    }

    if (!hexEqual(expected.protectedRef.sha, receipt.identity.baseSha)) return null;

    const policyDigest = sha256(canonicalJson(expected.policy));
    if (!hexEqual(policyDigest, expected.identity.policyDigest)
      || !hexEqual(policyDigest, receipt.identity.policyDigest)) {
      return null;
    }

    const policyProfile = expected.policy.profile ?? "routine";
    if (expected.identity.profile !== policyProfile) return null;

    const policyEvaluation = evaluateQualityPolicy({
      profile: expected.policy.profile,
      controls: expected.policy.controls,
      results: receipt.results,
    });

    if (policyEvaluation.status !== "pass") {
      return {
        receipt,
        expected,
        policyDigest,
        subjectDigest: expected.subjectDigest,
        policyStatus: policyEvaluation.status,
      };
    }

    const subjectDigest = subjectDigestFor(receipt);
    if (!hexEqual(subjectDigest, expected.subjectDigest)) return null;

    return {
      receipt,
      expected,
      policyDigest,
      subjectDigest,
      policyStatus: policyEvaluation.status,
    };
  } catch {
    return null;
  }
}

function verifyEvidenceBinding(
  evidence: ExternalEvidence,
  prepared: PreparedVerification,
): boolean {
  const { receipt, expected } = prepared;
  const provenance = receipt.provenance;
  if (provenance === undefined) return false;

  const evidenceDigest = sha256Bytes(evidence.bytes);
  const attestation = evidence.attestation;

  return evidence.locator === expected.evidenceLocator
    && evidence.locator === provenance.evidenceLocator
    && hexEqual(evidenceDigest, provenance.evidenceDigest)
    && hexEqual(evidenceDigest, attestation.evidenceDigest)
    && hexEqual(attestation.subjectDigest, prepared.subjectDigest)
    && sameQualityReceiptIdentity(attestation.identity, receipt.identity)
    && sameQualityReceiptIdentity(attestation.identity, expected.identity)
    && hexEqual(attestation.policyDigest, prepared.policyDigest)
    && hexEqual(attestation.policyDigest, receipt.identity.policyDigest)
    && sameProtectedReference(attestation.protectedRef, expected.protectedRef)
    && hexEqual(attestation.protectedRef.sha, receipt.identity.baseSha)
    && attestation.issuer === expected.issuer
    && attestation.issuer === provenance.issuer
    && attestation.executionId === expected.executionId
    && attestation.executionId === provenance.executionId
    && attestation.producer.processId !== expected.verifier.processId
    && !samePath(attestation.producer.worktree, expected.verifier.worktree);
}

async function verifyAttestation(
  evidence: ExternalEvidence,
  prepared: PreparedVerification,
  deps: ExternalQualityVerifierDeps,
): Promise<boolean> {
  let verification: unknown;
  try {
    verification = await deps.authenticateAttestation(evidence.attestation);
  } catch {
    return false;
  }

  if (!isAttestationVerification(verification) || !verification.authenticated) return false;

  try {
    if (!verifyEvidenceBinding(evidence, prepared)) return false;

    const nowMs = Date.parse(deps.now());
    const expiresAtMs = Date.parse(evidence.attestation.expiresAt);
    return Number.isFinite(nowMs) && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
  } catch {
    return false;
  }
}

function failureResult(): ExternalQualityVerifierResult {
  return { status: "fail", rerunRequired: false };
}

/**
 * Verifies an externally enforced receipt against caller-supplied expectations.
 * A `pass` requires authenticated evidence, all receipt, evidence-binding,
 * protected-reference, identity, policy, digest, and producer-boundary checks,
 * a valid expiry, and an attestation decision of `pass`.
 * This module does not track execution IDs or provide replay protection; callers
 * must enforce any one-time-use requirement outside this function.
 */
export async function verifyExternalQualityReceipt(
  input: ExternalQualityVerifierInput,
  deps: ExternalQualityVerifierDeps,
): Promise<ExternalQualityVerifierResult> {
  const prepared = prepareVerification(input);
  if (prepared === null) return failureResult();

  if (prepared.policyStatus === "fail") return failureResult();
  if (prepared.policyStatus === "incomplete") {
    return { status: "incomplete", rerunRequired: false };
  }

  if (typeof deps?.resolveEvidence !== "function"
    || typeof deps.authenticateAttestation !== "function"
    || typeof deps.now !== "function") {
    return failureResult();
  }

  let resolution: ExternalEvidenceResolution;
  try {
    resolution = await deps.resolveEvidence(prepared.expected.evidenceLocator);
  } catch {
    return { status: "incomplete", rerunRequired: true };
  }

  if (isRetryableResolution(resolution)) {
    return { status: "incomplete", rerunRequired: resolution.retryable };
  }
  if (!isAvailableResolution(resolution)) return failureResult();

  const { evidence } = resolution;
  if (!(await verifyAttestation(evidence, prepared, deps))) return failureResult();

  if (evidence.attestation.decision === "incomplete") {
    return { status: "incomplete", rerunRequired: false };
  }

  return {
    status: evidence.attestation.decision,
    rerunRequired: false,
  };
}
