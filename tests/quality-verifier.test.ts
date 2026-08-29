import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createQualityReceipt,
  sha256,
  type QualityReceipt,
} from "../src/lib/quality-receipt.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const POLICY = {
  controls: [{ id: "typecheck", requirement: "required" }],
  profile: "routine",
};
const POLICY_DIGEST = sha256(canonicalJson(POLICY));
const EVIDENCE_LOCATOR = "https://ci.example.invalid/runs/42/quality";
const EVIDENCE_BYTES = new TextEncoder().encode("external-quality-evidence-v1");
const EVIDENCE_DIGEST = sha256Bytes(EVIDENCE_BYTES);
const TRUSTED_ISSUER = "ci.example.invalid";
const TRUSTED_EXECUTION_ID = "quality-run-42";
type ProtectedReference = {
  ref: string;
  sha: string;
};

const PROTECTED_REF: ProtectedReference = {
  ref: "refs/heads/main",
  sha: BASE_SHA,
};
const NOW = "2026-08-29T12:00:00.000Z";
const VERIFIER_WORKTREE = process.platform === "win32"
  ? "C:\\workspace\\quality-verifier"
  : "/workspace/quality-verifier";
const PRODUCER_WORKTREE = process.platform === "win32"
  ? "C:\\ci\\quality\\run-42"
  : "/ci/quality/run-42";

type ExternalDecision = "pass" | "fail" | "incomplete";

type ExternalAttestation = {
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

type AttestationClaims = Omit<ExternalAttestation, "proof">;

type ExternalEvidence = {
  locator: string;
  bytes: Uint8Array;
  attestation: ExternalAttestation;
};

type ExternalEvidenceResolution =
  | { status: "available"; evidence: ExternalEvidence }
  | { status: "expired" | "unavailable"; retryable: boolean };

type AttestationVerification = {
  authenticated: boolean;
};

type ExternalQualityVerifierInput = {
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

type ExternalQualityVerifierDeps = {
  resolveEvidence(locator: string): Promise<ExternalEvidenceResolution>;
  authenticateAttestation(attestation: ExternalAttestation): Promise<AttestationVerification>;
  now(): string;
};

type ExternalQualityVerifierResult = {
  status: "pass" | "fail" | "incomplete";
  rerunRequired: boolean;
};

type VerifierModule = {
  verifyExternalQualityReceipt(
    input: ExternalQualityVerifierInput,
    deps: ExternalQualityVerifierDeps,
  ): Promise<ExternalQualityVerifierResult>;
};

type Fixture = {
  input: ExternalQualityVerifierInput;
  evidence: ExternalEvidence;
  deps: ExternalQualityVerifierDeps;
  resolveCalls: string[];
  attestationCalls: ExternalAttestation[];
};

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function attestationClaims(attestation: ExternalAttestation): AttestationClaims {
  return {
    issuer: attestation.issuer,
    executionId: attestation.executionId,
    identity: attestation.identity,
    policyDigest: attestation.policyDigest,
    protectedRef: attestation.protectedRef,
    producer: attestation.producer,
    decision: attestation.decision,
    subjectDigest: attestation.subjectDigest,
    evidenceDigest: attestation.evidenceDigest,
    expiresAt: attestation.expiresAt,
  };
}

function signAttestation(claims: AttestationClaims): ExternalAttestation {
  return {
    ...claims,
    proof: sha256(canonicalJson(claims)),
  };
}

function resignAttestation(
  fixture: Fixture,
  mutate: (claims: AttestationClaims) => void,
): void {
  const claims = attestationClaims(fixture.evidence.attestation);
  mutate(claims);
  fixture.evidence.attestation = signAttestation(claims);
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

function enforcedReceipt(): QualityReceipt {
  return createQualityReceipt({
    authority: "enforced",
    identity: {
      profile: "routine",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policyDigest: POLICY_DIGEST,
    },
    commands: [{
      commandId: "typecheck",
      executable: "pnpm",
      argv: ["exec", "vitest", "run"],
      exitCode: 0,
      durationMs: 123,
      output: { stdout: "quality check completed\n", stderr: "" },
    }],
    results: [{
      controlId: "typecheck",
      status: "pass",
      evidence: "exit=0",
    }],
    provenance: {
      issuer: TRUSTED_ISSUER,
      executionId: TRUSTED_EXECUTION_ID,
      evidenceLocator: EVIDENCE_LOCATOR,
      evidenceDigest: EVIDENCE_DIGEST,
    },
  });
}

function makeFixture(): Fixture {
  const receipt = enforcedReceipt();
  const subjectDigest = subjectDigestFor(receipt);
  const attestation = signAttestation({
    issuer: TRUSTED_ISSUER,
    executionId: TRUSTED_EXECUTION_ID,
    identity: { ...receipt.identity },
    policyDigest: POLICY_DIGEST,
    protectedRef: { ...PROTECTED_REF },
    producer: {
      processId: "ci-process-42",
      worktree: PRODUCER_WORKTREE,
    },
    decision: "pass",
    subjectDigest,
    evidenceDigest: EVIDENCE_DIGEST,
    expiresAt: "2026-08-29T13:00:00.000Z",
  });
  const evidence: ExternalEvidence = {
    locator: EVIDENCE_LOCATOR,
    bytes: EVIDENCE_BYTES.slice(),
    attestation,
  };
  const resolveCalls: string[] = [];
  const attestationCalls: Fixture["attestationCalls"] = [];
  const evidenceByLocator = new Map([[EVIDENCE_LOCATOR, evidence]]);

  return {
    input: {
      receipt,
      expected: {
        identity: { ...receipt.identity },
        policy: POLICY,
        protectedRef: { ...PROTECTED_REF },
        evidenceLocator: EVIDENCE_LOCATOR,
        issuer: TRUSTED_ISSUER,
        executionId: TRUSTED_EXECUTION_ID,
        subjectDigest,
        verifier: {
          processId: "verifier-process-1",
          worktree: VERIFIER_WORKTREE,
        },
      },
    },
    evidence,
    resolveCalls,
    attestationCalls,
    deps: {
      resolveEvidence: async (locator) => {
        resolveCalls.push(locator);
        const resolved = evidenceByLocator.get(locator);
        return resolved === undefined
          ? { status: "unavailable", retryable: false }
          : { status: "available", evidence: resolved };
      },
      authenticateAttestation: async (attestation) => {
        attestationCalls.push(attestation);
        return {
          authenticated: attestation.proof === sha256(canonicalJson(attestationClaims(attestation))),
        };
      },
      now: () => NOW,
    },
  };
}

async function loadVerifier(): Promise<VerifierModule["verifyExternalQualityReceipt"]> {
  const module = await import("../src/lib/quality-verifier.js") as unknown as VerifierModule;
  return module.verifyExternalQualityReceipt;
}

async function verify(
  fixture: Fixture,
  resolution?: ExternalEvidenceResolution,
): Promise<ExternalQualityVerifierResult> {
  const verifyExternalQualityReceipt = await loadVerifier();
  const deps = resolution === undefined
    ? fixture.deps
    : { ...fixture.deps, resolveEvidence: async () => resolution };
  return verifyExternalQualityReceipt(fixture.input, deps);
}

describe("verifyExternalQualityReceipt", () => {
  it("control de setup: construye un receipt enforced y sus digests canónicos", () => {
    const receipt = enforcedReceipt();

    expect(receipt.authority).toBe("enforced");
    expect(receipt.identity.policyDigest).toBe(sha256(canonicalJson(POLICY)));
    expect(subjectDigestFor(receipt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mantiene la evidencia opaca y autentica toda la metadata decisiva", () => {
    const fixture = makeFixture();

    expect(Object.keys(fixture.evidence).sort()).toEqual(["attestation", "bytes", "locator"]);
    expect(fixture.evidence.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.keys(fixture.evidence.attestation).sort()).toEqual([
      "decision",
      "evidenceDigest",
      "executionId",
      "expiresAt",
      "identity",
      "issuer",
      "policyDigest",
      "producer",
      "proof",
      "protectedRef",
      "subjectDigest",
    ]);
    expect(fixture.evidence.attestation.proof).toBe(
      sha256(canonicalJson(attestationClaims(fixture.evidence.attestation))),
    );
  });

  it("solo devuelve pass con autoridad, identidad, policy, boundary, provenance y attestation verificadas", async () => {
    const fixture = makeFixture();
    const result = await verify(fixture);

    expect(result).toEqual({ status: "pass", rerunRequired: false });
    expect(fixture.resolveCalls).toEqual([EVIDENCE_LOCATOR]);
    expect(fixture.attestationCalls).toEqual([fixture.evidence.attestation]);
  });

  it("rechaza receipt local y receipt enforced autoemitido", async () => {
    const localFixture = makeFixture();
    localFixture.input.receipt = createQualityReceipt({
      authority: "local",
      identity: localFixture.input.expected.identity,
      commands: [{
        commandId: "typecheck",
        executable: "pnpm",
        argv: ["exec", "vitest", "run"],
        exitCode: 0,
        durationMs: 123,
        output: { stdout: "quality check completed\n", stderr: "" },
      }],
      results: [{ controlId: "typecheck", status: "pass", evidence: "exit=0" }],
    });
    expect((await verify(localFixture)).status).toBe("fail");
    expect(localFixture.resolveCalls).toEqual([]);
    expect(localFixture.attestationCalls).toEqual([]);

    const selfIssuedFixture = makeFixture();
    selfIssuedFixture.evidence.attestation.proof = "self-issued-proof";
    expect((await verify(selfIssuedFixture)).status).toBe("fail");

    const invalidFixture = makeFixture();
    invalidFixture.input.receipt = {
      ...invalidFixture.input.receipt,
      authority: "invalid",
    } as unknown as QualityReceipt;
    expect(await verify(invalidFixture)).toEqual({ status: "fail", rerunRequired: false });
    expect(invalidFixture.resolveCalls).toEqual([]);
    expect(invalidFixture.attestationCalls).toEqual([]);
  });

  it.each([
    {
      name: "receipt identity",
      mutate: (fixture: Fixture) => {
        fixture.input.receipt = {
          ...fixture.input.receipt,
          identity: { ...fixture.input.receipt.identity, headSha: "c".repeat(40) },
        };
      },
    },
    {
      name: "attestation identity",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.identity = {
          ...fixture.evidence.attestation.identity,
          headSha: "c".repeat(40),
        };
      },
    },
    {
      name: "attestation policy",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.policyDigest = sha256(canonicalJson({ ...POLICY, profile: "elevated" }));
      },
    },
    {
      name: "expected policy digest",
      mutate: (fixture: Fixture) => {
        fixture.input.expected.policy = { ...POLICY, profile: "elevated" };
      },
    },
    {
      name: "attestation protected ref",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.protectedRef = {
          ...fixture.evidence.attestation.protectedRef,
          ref: "refs/heads/feature",
        };
      },
    },
    {
      name: "attestation protected ref SHA",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.protectedRef = {
          ...fixture.evidence.attestation.protectedRef,
          sha: HEAD_SHA,
        };
      },
    },
    {
      name: "expected protected ref SHA",
      mutate: (fixture: Fixture) => {
        fixture.input.expected.protectedRef = {
          ...fixture.input.expected.protectedRef,
          sha: HEAD_SHA,
        };
      },
    },
    {
      name: "protected ref SHA unrelated to base SHA",
      mutate: (fixture: Fixture) => {
        fixture.input.expected.protectedRef = {
          ...fixture.input.expected.protectedRef,
          sha: HEAD_SHA,
        };
        fixture.evidence.attestation.protectedRef = {
          ...fixture.evidence.attestation.protectedRef,
          sha: HEAD_SHA,
        };
      },
    },
    {
      name: "process boundary",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.producer = {
          ...fixture.evidence.attestation.producer,
          processId: fixture.input.expected.verifier.processId,
        };
      },
    },
    {
      name: "worktree boundary",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.producer = {
          ...fixture.evidence.attestation.producer,
          worktree: fixture.input.expected.verifier.worktree,
        };
      },
    },
    {
      name: "issuer",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.issuer = "untrusted.example.invalid";
      },
    },
    {
      name: "executionId",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.executionId = "quality-run-other";
      },
    },
    {
      name: "locator",
      mutate: (fixture: Fixture) => {
        fixture.evidence.locator = "https://ci.example.invalid/runs/99/quality";
      },
    },
    {
      name: "receipt evidence digest",
      mutate: (fixture: Fixture) => {
        if (fixture.input.receipt.provenance === undefined) throw new Error("missing provenance");
        fixture.input.receipt.provenance.evidenceDigest = "0".repeat(64);
      },
    },
    {
      name: "evidence bytes",
      mutate: (fixture: Fixture) => {
        fixture.evidence.bytes = new TextEncoder().encode("tampered-quality-evidence");
      },
    },
    {
      name: "attestation evidence digest",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.evidenceDigest = "0".repeat(64);
      },
    },
    {
      name: "attestation subjectDigest",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.subjectDigest = "0".repeat(64);
      },
    },
    {
      name: "decision without re-signing",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.decision = "fail";
      },
    },
    {
      name: "attestation",
      mutate: (fixture: Fixture) => {
        fixture.evidence.attestation.proof = "self-issued-proof";
      },
    },
  ])("devuelve fail ante mismatch de $name", async ({ mutate }) => {
    const fixture = makeFixture();
    mutate(fixture);

    expect(await verify(fixture)).toEqual({ status: "fail", rerunRequired: false });
  });

  it.each([
    {
      name: "identity",
      mutate: (claims: AttestationClaims) => {
        claims.identity = { ...claims.identity, headSha: "c".repeat(40) };
      },
    },
    {
      name: "policyDigest",
      mutate: (claims: AttestationClaims) => {
        claims.policyDigest = sha256(canonicalJson({ ...POLICY, profile: "elevated" }));
      },
    },
    {
      name: "protectedRef",
      mutate: (claims: AttestationClaims) => {
        claims.protectedRef = { ...claims.protectedRef, ref: "refs/heads/feature" };
      },
    },
    {
      name: "issuer",
      mutate: (claims: AttestationClaims) => {
        claims.issuer = "untrusted.example.invalid";
      },
    },
    {
      name: "executionId",
      mutate: (claims: AttestationClaims) => {
        claims.executionId = "quality-run-other";
      },
    },
    {
      name: "subjectDigest",
      mutate: (claims: AttestationClaims) => {
        claims.subjectDigest = "0".repeat(64);
      },
    },
    {
      name: "evidenceDigest",
      mutate: (claims: AttestationClaims) => {
        claims.evidenceDigest = "0".repeat(64);
      },
    },
  ])("compara el claim autenticado $name con expected/receipt", async ({ mutate }) => {
    const fixture = makeFixture();
    resignAttestation(fixture, mutate);

    expect(await verify(fixture)).toEqual({ status: "fail", rerunRequired: false });
  });

  it("rechaza un producer autenticado dentro del boundary del verifier", async () => {
    const fixture = makeFixture();
    resignAttestation(fixture, (claims) => {
      claims.producer = {
        ...claims.producer,
        processId: fixture.input.expected.verifier.processId,
      };
    });

    expect(await verify(fixture)).toEqual({ status: "fail", rerunRequired: false });
  });

  it("trata el mismo worktree como igual sin distinguir mayúsculas solo en paths Windows", async () => {
    const fixture = makeFixture();
    resignAttestation(fixture, (claims) => {
      claims.producer = {
        ...claims.producer,
        worktree: fixture.input.expected.verifier.worktree.toUpperCase(),
      };
    });

    expect(await verify(fixture)).toEqual(process.platform === "win32"
      ? { status: "fail", rerunRequired: false }
      : { status: "pass", rerunRequired: false });
  });

  it("no confía solo en el issuer string cuando la attestation no está autenticada", async () => {
    const fixture = makeFixture();
    fixture.evidence.attestation = {
      ...fixture.evidence.attestation,
      proof: "self-issued-proof",
      issuer: TRUSTED_ISSUER,
      executionId: TRUSTED_EXECUTION_ID,
    };

    expect(await verify(fixture)).toEqual({ status: "fail", rerunRequired: false });
  });

  it("rechaza una attestation autenticada pero expirada", async () => {
    const fixture = makeFixture();
    resignAttestation(fixture, (claims) => {
      claims.expiresAt = "2026-08-29T11:59:59.999Z";
    });

    expect(await verify(fixture)).toEqual({ status: "fail", rerunRequired: false });
  });

  it.each([
    { status: "expired" as const, retryable: true },
    { status: "expired" as const, retryable: false },
    { status: "unavailable" as const, retryable: true },
    { status: "unavailable" as const, retryable: false },
  ])("devuelve incomplete para locator $status y rerunRequired=$retryable solo si es retryable", async ({ status, retryable }) => {
    const fixture = makeFixture();

    expect(await verify(fixture, { status, retryable })).toEqual({
      status: "incomplete",
      rerunRequired: retryable,
    });
  });

  it.each(["fail", "incomplete"] as const)("propaga decision externa %s y nunca la eleva a pass", async (decision) => {
    const fixture = makeFixture();
    resignAttestation(fixture, (claims) => {
      claims.decision = decision;
    });

    expect(await verify(fixture)).toEqual({ status: decision, rerunRequired: false });
  });

  it.each(["fail", "incomplete"] as const)("no eleva un receipt con resultado %s aunque la evidencia diga pass", async (status) => {
    const fixture = makeFixture();
    const [firstResult] = fixture.input.receipt.results;
    if (firstResult === undefined) throw new Error("missing receipt result");

    fixture.input.receipt = {
      ...fixture.input.receipt,
      results: [status === "fail"
        ? { ...firstResult, status: "fail" }
        : { ...firstResult, status: "incomplete" }],
    };

    expect(await verify(fixture)).toEqual({ status, rerunRequired: false });
  });
});
