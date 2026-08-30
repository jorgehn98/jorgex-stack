import type { QualityPolicyStatus, QualityProfile } from "./quality-policy.js";
import { hasHealthyManagedMarkdownMarkers } from "./filemerge.js";

export const QUALITY_CAPABILITY_NAMESPACE = "jorgex.quality.capabilities" as const;
export const QUALITY_CAPABILITY_VERSION = 1 as const;

export const QUALITY_CAPABILITY_IDS = [
  "policy-guidance",
  "tool-approval",
  "external-verification",
] as const;

export type QualityCapabilityId = (typeof QUALITY_CAPABILITY_IDS)[number];
export const QUALITY_CAPABILITY_STATES = ["enforced", "prompt-only", "manual", "unavailable"] as const;
export type QualityCapabilityState = (typeof QUALITY_CAPABILITY_STATES)[number];
export type LocalQualityCapabilityState = Exclude<QualityCapabilityState, "enforced">;
export type QualityCapabilityRuntime = "claude-code" | "codex" | "opencode" | "pi" | "unknown";

export interface QualityCapabilityEvidence {
  source: string;
  version: string;
}

export interface QualityCapabilityDeclaration {
  id: string;
  state: string;
  reason?: string;
  evidence?: unknown;
}

export interface LocalQualityCapability {
  id: QualityCapabilityId;
  state: LocalQualityCapabilityState;
  reason: string;
  evidence?: QualityCapabilityEvidence;
}

export interface LocalQualityCapabilityReport {
  namespace: typeof QUALITY_CAPABILITY_NAMESPACE;
  version: typeof QUALITY_CAPABILITY_VERSION;
  runtime: QualityCapabilityRuntime;
  capabilities: LocalQualityCapability[];
}

const UNAVAILABLE_REASON = "No reviewed local declaration is available";
const EXTERNAL_VERIFICATION_REASON = "External verification is available only through the external verifier";

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRuntime(value: string): value is Exclude<QualityCapabilityRuntime, "unknown"> {
  return value === "claude-code" || value === "codex" || value === "opencode" || value === "pi";
}

function hasValidEvidence(value: unknown): value is QualityCapabilityEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as { source?: unknown; version?: unknown };
  return hasText(evidence.source) && hasText(evidence.version);
}

function unavailableCapability(id: QualityCapabilityId, reason = UNAVAILABLE_REASON): LocalQualityCapability {
  return { id, state: "unavailable", reason };
}

function declarationFor(
  id: QualityCapabilityId,
  declarations: readonly QualityCapabilityDeclaration[],
  runtime: QualityCapabilityRuntime,
): LocalQualityCapability {
  if (runtime === "unknown") {
    return unavailableCapability(id, "Runtime is unknown; local capability cannot be established");
  }

  if (id === "external-verification") {
    return unavailableCapability(id, EXTERNAL_VERIFICATION_REASON);
  }

  const matches = declarations.filter((declaration) => declaration?.id === id);
  if (matches.length === 0) return unavailableCapability(id);
  if (matches.length !== 1) return unavailableCapability(id, "Duplicate capability declarations are ambiguous");

  const declaration = matches[0]!;
  const state = declaration.state;
  const reason = hasText(declaration.reason) ? declaration.reason.trim() : undefined;
  if (!reason) return unavailableCapability(id, "Capability declaration has no reason");
  if (state !== "prompt-only" && state !== "manual" && state !== "unavailable") {
    return unavailableCapability(id, "Capability state is not a supported local state");
  }

  if (state === "unavailable") return { id, state, reason };
  if (!hasValidEvidence(declaration.evidence)) {
    return unavailableCapability(id, "Capability declaration lacks reviewed source/version evidence");
  }

  const evidence = declaration.evidence;
  return {
    id,
    state,
    reason,
    evidence: {
      source: evidence.source.trim(),
      version: evidence.version.trim(),
    },
  };
}

/**
 * Detects a well-formed managed markdown marker pair without interpreting its
 * content. The markers do not establish who wrote the section or prove runtime
 * enforcement.
 */
export function hasManagedMarkdownSection(content: string | null, name: string): boolean {
  return content !== null && hasHealthyManagedMarkdownMarkers(content, name);
}

/**
 * Creates the local diagnostic envelope. Local declarations can never produce
 * `enforced`; malformed, ambiguous, or unreviewed declarations fail closed.
 */
export function createLocalCapabilityReport(
  runtime: string,
  declarations: readonly QualityCapabilityDeclaration[],
): LocalQualityCapabilityReport {
  const normalizedRuntime: QualityCapabilityRuntime = isRuntime(runtime) ? runtime : "unknown";
  return {
    namespace: QUALITY_CAPABILITY_NAMESPACE,
    version: QUALITY_CAPABILITY_VERSION,
    runtime: normalizedRuntime,
    capabilities: QUALITY_CAPABILITY_IDS.map((id) => declarationFor(id, declarations, normalizedRuntime)),
  };
}

/** Local plans cannot close strict profiles without external verification. */
export function localQualityStatus(profile: QualityProfile, status: QualityPolicyStatus): QualityPolicyStatus {
  if ((profile === "high" || profile === "release") && status === "pass") return "incomplete";
  return status;
}
