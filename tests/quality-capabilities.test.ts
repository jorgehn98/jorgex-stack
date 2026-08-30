import { describe, expect, it } from "vitest";
import {
  createLocalCapabilityReport,
  localQualityStatus,
} from "../src/lib/quality-capabilities.js";

const CAPABILITY_IDS = [
  "policy-guidance",
  "tool-approval",
  "external-verification",
] as const;

type CapabilityId = (typeof CAPABILITY_IDS)[number];

function capability(
  report: ReturnType<typeof createLocalCapabilityReport>,
  id: CapabilityId,
) {
  const result = report.capabilities.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing capability: ${id}`);
  return result;
}

describe("local quality capability report", () => {
  it("returns the fixed report envelope and does not promote prompt-only guidance", () => {
    const report = createLocalCapabilityReport("claude-code", [
      {
        id: "policy-guidance",
        state: "prompt-only",
        reason: "The prompt describes the policy but cannot enforce it",
        evidence: { source: "jorgex-stack-policy", version: "1" },
      },
    ]);

    expect(report).toMatchObject({
      namespace: "jorgex.quality.capabilities",
      version: 1,
      runtime: "claude-code",
    });
    expect(report.capabilities.map((entry) => entry.id)).toEqual(CAPABILITY_IDS);
    expect(capability(report, "policy-guidance").state).toBe("prompt-only");
    expect(report.capabilities.map((entry) => entry.state)).not.toContain("enforced");
  });

  it("keeps a manually approved action manual instead of treating approval as enforcement", () => {
    const report = createLocalCapabilityReport("codex", [
      {
        id: "tool-approval",
        state: "manual",
        reason: "The runtime requires a human approval step",
        evidence: { source: "codex-approval-policy", version: "1" },
      },
    ]);

    expect(capability(report, "tool-approval")).toMatchObject({
      id: "tool-approval",
      state: "manual",
      reason: "The runtime requires a human approval step",
      evidence: { source: "codex-approval-policy", version: "1" },
    });
    expect(capability(report, "tool-approval").state).not.toBe("enforced");
  });

  it("represents absent capabilities as unavailable and never as a local strict authority", () => {
    const report = createLocalCapabilityReport("opencode", []);

    expect(report.capabilities).toHaveLength(CAPABILITY_IDS.length);
    expect(report.capabilities.every((entry) => entry.state === "unavailable")).toBe(true);
    expect(capability(report, "external-verification").state).toBe("unavailable");
  });

  it("normalizes a claimed enforced or unknown capability state to unavailable", () => {
    const report = createLocalCapabilityReport("pi", [
      {
        id: "external-verification",
        state: "enforced",
        reason: "An untrusted local declaration claims external authority",
        evidence: { source: "local-config", version: "1" },
      },
      {
        id: "tool-approval",
        state: "future-state",
        reason: "An unknown state is not part of the contract",
      },
    ] as never);

    expect(capability(report, "external-verification").state).toBe("unavailable");
    expect(capability(report, "tool-approval").state).toBe("unavailable");
  });

  it("degrades duplicate capability IDs instead of accepting an ambiguous declaration", () => {
    const report = createLocalCapabilityReport("codex", [
      {
        id: "tool-approval",
        state: "manual",
        reason: "First declaration",
        evidence: { source: "codex-approval-policy", version: "1" },
      },
      {
        id: "tool-approval",
        state: "prompt-only",
        reason: "Conflicting duplicate declaration",
        evidence: { source: "prompt", version: "1" },
      },
    ]);

    expect(capability(report, "tool-approval").state).toBe("unavailable");
  });

  it.each([
    { name: "prompt-only", id: "policy-guidance", state: "prompt-only" },
    { name: "manual", id: "tool-approval", state: "manual" },
  ] as const)("requires source and version evidence for $name declarations", ({ id, state }) => {
    const report = createLocalCapabilityReport("claude-code", [
      {
        id,
        state,
        reason: "This declaration has no reviewed source/version pair",
        evidence: { source: " ", version: " " },
      },
    ]);

    expect(capability(report, id).state).toBe("unavailable");
  });

  it("normalizes an unknown runtime to unavailable entries", () => {
    const report = createLocalCapabilityReport("future-runtime" as never, []);

    expect(report.runtime).toBe("unknown");
    expect(report.capabilities.every((entry) => entry.state === "unavailable")).toBe(true);
  });
});

describe("local strict quality status", () => {
  it.each([
    ["routine", "pass", "pass"],
    ["elevated", "pass", "pass"],
    ["high", "pass", "incomplete"],
    ["release", "pass", "incomplete"],
    ["high", "fail", "fail"],
    ["release", "incomplete", "incomplete"],
  ] as const)("maps %s/%s to %s without weakening existing failures", (profile, status, expected) => {
    expect(localQualityStatus(profile, status)).toBe(expected);
  });
});
