import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * T05 RED: pure managed receipt creation (tests only, no product change).
 *
 * Desired contract (GREEN to implement in src/lib/pi-package-lifecycle.ts):
 * - `createManagedPiReceipt({ candidate, scope, engramBin, stageDir,
 *   releaseId, evidence, state })` is pure (no FS writes, no network) and
 *   returns `PiPackageReceipt & { managedPackage }` with schemaVersion 1
 *   preserved (published Pi 0.8.31 mcp-engram.ts rejects schema 2).
 * - Base shape reuses the existing Stack receipt: exact
 *   package/tarball/provenance from the trusted candidate, scope
 *   { kind, codingAgentDir }, engram { binary }, state installing/installed.
 * - `managedPackage` derives strictly:
 *   releaseDir = agentDir/npm/jorgex-pi-managed/releases/<64hex releaseId>,
 *   linkPath = agentDir/npm/node_modules/jorgex-pi,
 *   backupDir = stageDir/.activate-backup with stageDir exact
 *   agentDir/stage-<32hex>/pi-agent,
 *   lockSha256/treeSha256 passed through from inspected stage evidence,
 *   six observed deps { name, version, integrity } passed through.
 * - Rejects (throw, no writes): stageDir outside agentDir, forged releaseId
 *   (not 64 lowercase hex), evidence dep count !== 6.
 *
 * Synthetic 9.9.9 candidate + six synthetic deps are test-only and never a
 * claim about a published Pi release nor a next-version selector. No
 * production pin is imported here. Temp sandboxes under os.tmpdir only.
 */

const SYNTHETIC_VERSION = "9.9.9";

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

function syntheticHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

type SyntheticCandidate = {
  package: { name: string; version: string; source: string };
  tarball: { bytes: number; sha256: string; sha512: string };
  provenance: { commit: string };
};

type SyntheticEvidence = {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
};

function syntheticCandidate(): SyntheticCandidate {
  return {
    package: {
      name: "jorgex-pi",
      version: SYNTHETIC_VERSION,
      source: `npm:jorgex-pi@${SYNTHETIC_VERSION}`,
    },
    tarball: {
      bytes: 424242,
      sha256: syntheticHex("synthetic-t05-tarball-sha256"),
      sha512: syntheticHex("synthetic-t05-tarball-sha512-a") + syntheticHex("synthetic-t05-tarball-sha512-b"),
    },
    provenance: { commit: syntheticHex("synthetic-t05-provenance").slice(0, 40) },
  };
}

function syntheticEvidence(): SyntheticEvidence {
  return {
    lockSha256: syntheticHex("synthetic-t05-lock"),
    treeSha256: syntheticHex("synthetic-t05-tree"),
    dependencies: STAGED_DEP_NAMES.map((name, index) => ({
      name,
      version: syntheticDepVersion(index),
      integrity: syntheticIntegrity(21 + index),
    })),
  };
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type ValidInput = {
  sandbox: string;
  agentDir: string;
  stageDir: string;
  releaseId: string;
  engramBin: string;
  candidate: SyntheticCandidate;
  evidence: SyntheticEvidence;
};

function setupValidInput(): ValidInput {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t05-managed-receipt-"));
  sandboxes.push(sandbox);
  const agentDir = path.join(sandbox, "agent");
  const stageHex = syntheticHex("jx-t05-managed-stage").slice(0, 32);
  const stageDir = path.join(agentDir, `stage-${stageHex}`, "pi-agent");
  const releaseId = syntheticHex("jx-t05-managed-release");
  const engramBin = path.join(sandbox, "bin", "engram");
  expect(releaseId).toMatch(/^[a-f0-9]{64}$/);
  expect(stageHex).toMatch(/^[a-f0-9]{32}$/);
  return {
    sandbox,
    agentDir,
    stageDir,
    releaseId,
    engramBin,
    candidate: syntheticCandidate(),
    evidence: syntheticEvidence(),
  };
}

function listAllFiles(root: string): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      }
    }
  }
  return found.sort();
}

async function loadCreateManagedPiReceipt(): Promise<
  (input: {
    candidate: SyntheticCandidate;
    scope: { kind: "real" | "target-dir"; codingAgentDir: string };
    engramBin: string;
    stageDir: string;
    releaseId: string;
    evidence: SyntheticEvidence;
    state: "installing" | "installed";
  }) => unknown
> {
  const mod = (await import("../src/lib/pi-package-lifecycle.js")) as unknown as Record<
    string,
    unknown
  >;
  expect(
    typeof mod["createManagedPiReceipt"],
    "falta createManagedPiReceipt puro T05",
  ).toBe("function");
  return mod["createManagedPiReceipt"] as (
    input: {
      candidate: SyntheticCandidate;
      scope: { kind: "real" | "target-dir"; codingAgentDir: string };
      engramBin: string;
      stageDir: string;
      releaseId: string;
      evidence: SyntheticEvidence;
      state: "installing" | "installed";
    },
  ) => unknown;
}

describe("T05 RED managed receipt creation (pure, schemaVersion 1)", () => {
  it("builds the exact schemaVersion1 receipt with derived managedPackage for synthetic 9.9.9 and six deps, without writes", async () => {
    const createManagedPiReceipt = await loadCreateManagedPiReceipt();
    const { sandbox, agentDir, stageDir, releaseId, engramBin, candidate, evidence } =
      setupValidInput();
    const before = listAllFiles(sandbox);

    const expectedReleaseDir = path.join(
      agentDir,
      "npm",
      "jorgex-pi-managed",
      "releases",
      releaseId,
    );
    const expectedLinkPath = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
    const expectedBackupDir = path.join(stageDir, ".activate-backup");

    for (const state of ["installing", "installed"] as const) {
      const receipt = createManagedPiReceipt({
        candidate,
        scope: { kind: "target-dir", codingAgentDir: agentDir },
        engramBin,
        stageDir,
        releaseId,
        evidence,
        state,
      });

      expect(receipt).toEqual({
        schemaVersion: 1,
        state,
        candidate: {
          package: candidate.package,
          tarball: candidate.tarball,
          provenance: candidate.provenance,
        },
        scope: { kind: "target-dir", codingAgentDir: path.resolve(agentDir) },
        engram: { binary: engramBin },
        managedPackage: {
          releaseDir: expectedReleaseDir,
          linkPath: expectedLinkPath,
          backupDir: expectedBackupDir,
          lockSha256: evidence.lockSha256,
          treeSha256: evidence.treeSha256,
          dependencies: evidence.dependencies,
        },
      });
    }

    // Pure constructor: no FS writes (derived paths are returned, not created).
    expect(fs.existsSync(expectedReleaseDir)).toBe(false);
    expect(fs.existsSync(expectedLinkPath)).toBe(false);
    expect(fs.existsSync(expectedBackupDir)).toBe(false);
    expect(listAllFiles(sandbox)).toEqual(before);
    // Six observed deps, distinct synthetic version, schemaVersion 1 preserved.
    expect(evidence.dependencies).toHaveLength(6);
    expect(candidate.package.version).toBe("9.9.9");
  });

  it("rejects a stageDir outside the agent dir with no writes", async () => {
    const createManagedPiReceipt = await loadCreateManagedPiReceipt();
    const { sandbox, agentDir, releaseId, engramBin, candidate, evidence } = setupValidInput();
    const outsideStage = path.join(sandbox, "outside", "pi-agent");
    const before = listAllFiles(sandbox);

    expect(() =>
      createManagedPiReceipt({
        candidate,
        scope: { kind: "target-dir", codingAgentDir: agentDir },
        engramBin,
        stageDir: outsideStage,
        releaseId,
        evidence,
        state: "installing",
      }),
    ).toThrow(/stageDir/);
    expect(listAllFiles(sandbox)).toEqual(before);
    expect(fs.existsSync(outsideStage)).toBe(false);
  });

  it("rejects a forged releaseId with no writes", async () => {
    const createManagedPiReceipt = await loadCreateManagedPiReceipt();
    const { sandbox, agentDir, stageDir, engramBin, candidate, evidence } = setupValidInput();
    const before = listAllFiles(sandbox);

    expect(() =>
      createManagedPiReceipt({
        candidate,
        scope: { kind: "target-dir", codingAgentDir: agentDir },
        engramBin,
        stageDir,
        releaseId: "A".repeat(64),
        evidence,
        state: "installing",
      }),
    ).toThrow(/releaseId/);
    expect(listAllFiles(sandbox)).toEqual(before);
  });

  it("rejects mismatched evidence dep count with no writes", async () => {
    const createManagedPiReceipt = await loadCreateManagedPiReceipt();
    const { sandbox, agentDir, stageDir, releaseId, engramBin, candidate, evidence } =
      setupValidInput();
    const before = listAllFiles(sandbox);
    const shortEvidence: SyntheticEvidence = {
      ...evidence,
      dependencies: evidence.dependencies.slice(0, 5),
    };
    expect(shortEvidence.dependencies).toHaveLength(5);

    expect(() =>
      createManagedPiReceipt({
        candidate,
        scope: { kind: "target-dir", codingAgentDir: agentDir },
        engramBin,
        stageDir,
        releaseId,
        evidence: shortEvidence,
        state: "installing",
      }),
    ).toThrow(/dependenc/);
    expect(listAllFiles(sandbox)).toEqual(before);
  });
});
