import { createHash } from "node:crypto";
import { activateVerifiedPiRelease } from "./pi-private-release.js";
import {
  createManagedPiReceipt,
  planPiManagedSettings,
  type PiPackageManagedDependency,
  type PiPackageReceipt,
  type PiRuntimeCandidate,
} from "./pi-package-lifecycle.js";

export interface PreparedPiInstallEvidence {
  readonly lockSha256: string;
  readonly treeSha256: string;
  readonly dependencies: readonly PiPackageManagedDependency[];
}

export interface ActivatePreparedPiInstallInput {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly receiptPath: string;
  readonly engramBin: string;
  readonly prepared: {
    readonly candidate: PiRuntimeCandidate;
    readonly stageDir: string;
    readonly evidence: PreparedPiInstallEvidence;
  };
  readonly settingsJson: string;
  readonly previousSource: string | null;
  readonly scopeKind?: "real" | "target-dir";
}

export interface ActivatePreparedPiInstallDeps {
  readonly verifyStage: (stageDir: string, evidence: PreparedPiInstallEvidence) => void | Promise<void>;
  readonly smokeStage: (stageDir: string) => void | Promise<void>;
  readonly verifyActive: () => void | Promise<void>;
}

export type ActivatePreparedPiInstallResult = {
  kind: "installed";
  receipt: PiPackageReceipt;
};

/**
 * Composed private activation for a prepared Pi install (T07 GREEN).
 *
 * Pure composition only, no registry fetch and no native Pi install here:
 * the caller authenticates previousSource from the owned receipt and
 * supplies the preflight candidate/stage/evidence. This helper first
 * re-verifies the stage against the same evidence (no stale evidence),
 * then plans the managed settings, smokes the stage, derives the release
 * id, builds the schemaVersion 1 managed receipt, and delegates the only
 * active writes to the existing activateVerifiedPiRelease. Any helper
 * error propagates untouched so its incomplete/complete recovery marker
 * is preserved.
 */
export async function activatePreparedPiInstall(
  input: ActivatePreparedPiInstallInput,
  deps: ActivatePreparedPiInstallDeps,
): Promise<ActivatePreparedPiInstallResult> {
  const candidate = input.prepared.candidate;
  const stageDir = input.prepared.stageDir;
  const evidence = input.prepared.evidence;
  const nextSource = candidate.package.source;
  const scopeKind = input.scopeKind ?? "real";
  if (scopeKind !== "real" && scopeKind !== "target-dir") {
    throw new Error("pi-install-activation: scopeKind must be real or target-dir");
  }

  await deps.verifyStage(stageDir, evidence);

  const nextSettings = planPiManagedSettings(input.settingsJson, input.previousSource, nextSource);
  if (nextSettings === null) {
    throw new Error(
      "pi-install-activation: settings are manual, edited or ambiguous for the managed Pi entry; refusing activation",
    );
  }

  await deps.smokeStage(stageDir);

  const releaseId = createHash("sha256")
    .update(`${candidate.tarball.sha256}:${evidence.lockSha256}`)
    .digest("hex");

  const receipt = createManagedPiReceipt({
    candidate,
    scope: { kind: scopeKind, codingAgentDir: input.agentDir },
    engramBin: input.engramBin,
    stageDir,
    releaseId,
    evidence,
    state: "installed",
  });
  const nextReceipt = JSON.stringify(receipt);

  await activateVerifiedPiRelease({
    homeDir: input.homeDir,
    agentDir: input.agentDir,
    stageDir,
    releaseId,
    receiptPath: input.receiptPath,
    nextSettings,
    nextReceipt,
    verify: async () => {
      await deps.verifyActive();
    },
  });

  return { kind: "installed", receipt };
}
