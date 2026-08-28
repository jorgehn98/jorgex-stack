const QUALITY_PROFILES = ["routine", "elevated", "high", "release"] as const;

export type QualityProfile = (typeof QUALITY_PROFILES)[number];
export type QualityControlRequirement = "required" | "optional";
export type QualityControlStatus = "pass" | "fail" | "incomplete" | "not-applicable";
export type QualityPolicyStatus = Exclude<QualityControlStatus, "not-applicable">;

export interface QualityControlDefinition {
  id: string;
  requirement: QualityControlRequirement;
  notApplicable?: boolean;
}

export interface QualityControlResult {
  controlId: string;
  status: QualityControlStatus;
  evidence?: string;
  reason?: string;
}

export interface QualityPolicyInput {
  profile?: QualityProfile;
  controls: readonly QualityControlDefinition[];
  results: readonly QualityControlResult[];
}

export interface QualityPolicyEvaluation {
  profile: QualityProfile;
  status: QualityPolicyStatus;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isQualityProfile(value: unknown): value is QualityProfile {
  return typeof value === "string" && (QUALITY_PROFILES as readonly string[]).includes(value);
}

function mergeStatus(current: QualityPolicyStatus, next: QualityPolicyStatus): QualityPolicyStatus {
  if (current === "fail" || next === "fail") return "fail";
  if (current === "incomplete" || next === "incomplete") return "incomplete";
  return "pass";
}

function resultStatus(result: QualityControlResult): QualityPolicyStatus {
  switch (result.status) {
    case "fail":
      return "fail";
    case "incomplete":
      return "incomplete";
    case "not-applicable":
      return "pass";
    case "pass":
      return hasText(result.evidence) ? "pass" : "incomplete";
    default:
      return "incomplete";
  }
}

export function evaluateQualityPolicy(input: QualityPolicyInput): QualityPolicyEvaluation {
  const requestedProfile = input.profile === undefined ? "routine" : input.profile;
  if (!isQualityProfile(requestedProfile)) {
    throw new Error(`Unknown quality profile: ${String(requestedProfile)}`);
  }

  const controls = new Map<string, QualityControlDefinition>();
  let status: QualityPolicyStatus = "pass";
  let hasRequired = false;

  for (const control of input.controls) {
    if (
      !hasText(control.id)
      || (control.requirement !== "required" && control.requirement !== "optional")
      || controls.has(control.id)
    ) {
      status = mergeStatus(status, "incomplete");
      continue;
    }

    controls.set(control.id, control);
    if (control.requirement === "required") hasRequired = true;
  }

  const results = new Map<string, QualityControlResult>();
  for (const result of input.results) {
    const control = controls.get(result.controlId);
    if (!control || results.has(result.controlId)) {
      status = mergeStatus(status, "incomplete");
    }

    if (control && !results.has(result.controlId)) {
      results.set(result.controlId, result);
    }

    if (control && result.status === "not-applicable") {
      const validException = control.requirement === "optional"
        && control.notApplicable === true
        && hasText(result.reason);
      status = mergeStatus(status, validException ? "pass" : "incomplete");
      continue;
    }

    if (control) status = mergeStatus(status, resultStatus(result));
  }

  if (!hasRequired) status = mergeStatus(status, "incomplete");

  for (const control of controls.values()) {
    if (control.requirement !== "required") continue;

    const result = results.get(control.id);
    if (!result) {
      status = mergeStatus(status, "incomplete");
      continue;
    }

    if (result.status === "not-applicable") {
      status = mergeStatus(status, "incomplete");
    } else {
      status = mergeStatus(status, resultStatus(result));
    }
  }

  return { profile: requestedProfile, status };
}
