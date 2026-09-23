import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";

/**
 * T07 RED: post-promotion proof must bind receipt state/scope/engram.
 *
 * Type-design review: `verifyActivePiRelease` in `src/lib/pi-runtime.ts`
 * currently checks schema1, parent candidate, managedPackage
 * lock/tree/deps/link but NOT `state: 'installed'`, `scope.kind` /
 * `scope.codingAgentDir`, nor `engram.binary`. A non-cooperative writer
 * changing only these fields between the activation write and the verify
 * can make install return success and doctor block right after.
 *
 * Desired contract (GREEN exports the internal verifier from
 * `src/lib/pi-runtime.ts` and extends its input):
 * - `verifyActivePiRelease({ agentDir, receiptPath, candidate, evidence,
 *   scopeKind: 'target-dir', engramBin })` is a synchronous read-only FS
 *   proof: valid control does not throw and writes nothing.
 * - It throws `pi-verify-active: ...` (no writes) when the promoted receipt
 *   has `state !== 'installed'`, `scope.kind !== scopeKind`,
 *   `scope.codingAgentDir` not equal to the resolved `agentDir`, or
 *   `engram.binary !== engramBin`, even when candidate/evidence/link/tree
 *   are otherwise exact.
 *
 * Real FS seam under os.tmpdir only (never HOME, no network): a minimal
 * private release at `agentDir/npm/jorgex-pi-managed/releases/<64hex>`
 * with a real `inventoryTreeSha256`, plus the owned relative symlink
 * `npm/node_modules/jorgex-pi`. Synthetic 9.9.9 candidate + six synthetic
 * deps are test-only, never a claim about a published release.
 */

const SYNTHETIC_VERSION = "9.9.9";
const SYNTHETIC_SOURCE = `npm:jorgex-pi@${SYNTHETIC_VERSION}`;

const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const PI_INDEX = "// jorgex-pi 9.9.9 active release\nmodule.exports = 'active-pi';\n";

function syntheticHex(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
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

type VerifyActiveFn = (input: {
  agentDir: string;
  receiptPath: string;
  candidate: SyntheticCandidate;
  evidence: SyntheticEvidence;
  scopeKind: "real" | "target-dir";
  engramBin: string;
}) => void;

async function loadVerifyActivePiRelease(): Promise<VerifyActiveFn> {
  // Dynamic loader: runtime RED while the export is missing, typecheck
  // stays green via the Record cast (same pattern as other T05 REDs).
  // @ts-ignore
  const mod = (await import("../src/lib/pi-runtime.js")) as unknown as Record<string, unknown>;
  expect(typeof mod["verifyActivePiRelease"], "falta export verifyActivePiRelease T07").toBe("function");
  return mod["verifyActivePiRelease"] as VerifyActiveFn;
}

function syntheticCandidate(): SyntheticCandidate {
  return {
    package: { name: "jorgex-pi", version: SYNTHETIC_VERSION, source: SYNTHETIC_SOURCE },
    tarball: {
      bytes: 424242,
      sha256: syntheticHex("jx-t07-active-tarball-sha256"),
      sha512: syntheticHex("jx-t07-active-tarball-a") + syntheticHex("jx-t07-active-tarball-b"),
    },
    provenance: { commit: syntheticHex("jx-t07-active-provenance").slice(0, 40) },
  };
}

function syntheticDependencies(): SyntheticEvidence["dependencies"] {
  return STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(41 + index),
  }));
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ActiveSandbox = {
  agentDir: string;
  receiptPath: string;
  engramBin: string;
  candidate: SyntheticCandidate;
  evidence: SyntheticEvidence;
  releaseDir: string;
  linkPath: string;
  expectedLinkTarget: string;
};

function setupActiveSandbox(): ActiveSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-active-verify-"));
  sandboxes.push(sandbox);
  expect(sandbox.startsWith(os.tmpdir())).toBe(true);

  const agentDir = path.join(sandbox, "agent");
  const npmDir = path.join(agentDir, "npm");
  const releaseId = syntheticHex("jx-t07-active-release");
  expect(releaseId).toMatch(/^[0-9a-f]{64}$/);
  const releaseDir = path.join(npmDir, "jorgex-pi-managed", "releases", releaseId);
  const packageRoot = path.join(releaseDir, "node_modules", "jorgex-pi");
  const linkPath = path.join(npmDir, "node_modules", "jorgex-pi");
  const receiptPath = path.join(sandbox, "state", "pi-receipt.json");
  const engramBin = path.join(sandbox, "bin", "engram");

  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "jorgex-pi", version: SYNTHETIC_VERSION })}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), PI_INDEX);
  fs.writeFileSync(path.join(packageRoot, "bin", "jorgex-pi.mjs"), "// synthetic runner entry\n");
  fs.writeFileSync(
    path.join(releaseDir, "package-lock.json"),
    `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3 })}\n`,
  );

  const lockSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(releaseDir, "package-lock.json")))
    .digest("hex");
  expect(lockSha256).toMatch(/^[0-9a-f]{64}$/);
  const treeSha256 = inventoryTreeSha256(releaseDir);
  expect(treeSha256).toMatch(/^[0-9a-f]{64}$/);

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const expectedLinkTarget = path.relative(path.dirname(linkPath), packageRoot);
  expect(expectedLinkTarget).toBe(`../jorgex-pi-managed/releases/${releaseId}/node_modules/jorgex-pi`);
  fs.symlinkSync(expectedLinkTarget, linkPath, "dir");
  expect(fs.realpathSync(linkPath)).toBe(packageRoot);

  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");

  const candidate = syntheticCandidate();
  const evidence: SyntheticEvidence = {
    lockSha256,
    treeSha256,
    dependencies: syntheticDependencies(),
  };
  expect(evidence.dependencies).toHaveLength(6);

  writeReceipt({ agentDir, receiptPath, engramBin, candidate, evidence });

  return { agentDir, receiptPath, engramBin, candidate, evidence, releaseDir, linkPath, expectedLinkTarget };
}

function writeReceipt(input: {
  agentDir: string;
  receiptPath: string;
  engramBin: string;
  candidate: SyntheticCandidate;
  evidence: SyntheticEvidence;
  mutate?: (receipt: Record<string, unknown>) => void;
}): string {
  const releaseId = syntheticHex("jx-t07-active-release");
  const receipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: input.candidate.package,
      tarball: input.candidate.tarball,
      provenance: input.candidate.provenance,
    },
    scope: { kind: "target-dir", codingAgentDir: input.agentDir },
    engram: { binary: input.engramBin },
    managedPackage: {
      releaseDir: path.join(input.agentDir, "npm", "jorgex-pi-managed", "releases", releaseId),
      linkPath: path.join(input.agentDir, "npm", "node_modules", "jorgex-pi"),
      lockSha256: input.evidence.lockSha256,
      treeSha256: input.evidence.treeSha256,
      dependencies: input.evidence.dependencies.map((dep) => ({ ...dep })),
    },
  } as unknown as Record<string, unknown>;
  input.mutate?.(receipt);
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.mkdirSync(path.dirname(input.receiptPath), { recursive: true });
  fs.writeFileSync(input.receiptPath, raw);
  return raw;
}

describe("pi active receipt invariant (T07 RED)", () => {
  it("valid control passes without writes", async () => {
    const verifyActivePiRelease = await loadVerifyActivePiRelease();
    const sb = setupActiveSandbox();
    const beforeReceipt = fs.readFileSync(sb.receiptPath, "utf8");
    const beforeLink = fs.readlinkSync(sb.linkPath);
    const beforeTree = inventoryTreeSha256(sb.releaseDir);

    expect(() =>
      verifyActivePiRelease({
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        candidate: sb.candidate,
        evidence: sb.evidence,
        scopeKind: "target-dir",
        engramBin: sb.engramBin,
      }),
    ).not.toThrow();

    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readlinkSync(sb.linkPath)).toBe(beforeLink);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(beforeTree);
  });

  it("state 'installing' must throw without modifying anything", async () => {
    const verifyActivePiRelease = await loadVerifyActivePiRelease();
    const sb = setupActiveSandbox();
    const mutated = writeReceipt({
      agentDir: sb.agentDir,
      receiptPath: sb.receiptPath,
      engramBin: sb.engramBin,
      candidate: sb.candidate,
      evidence: sb.evidence,
      mutate: (receipt) => {
        receipt["state"] = "installing";
      },
    });
    expect(JSON.parse(mutated).state).toBe("installing");
    const beforeLink = fs.readlinkSync(sb.linkPath);
    const beforeTree = inventoryTreeSha256(sb.releaseDir);

    expect(() =>
      verifyActivePiRelease({
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        candidate: sb.candidate,
        evidence: sb.evidence,
        scopeKind: "target-dir",
        engramBin: sb.engramBin,
      }),
    ).toThrow(/pi-verify-active/);

    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(mutated);
    expect(fs.readlinkSync(sb.linkPath)).toBe(beforeLink);
    expect(fs.realpathSync(sb.linkPath)).toBe(path.join(sb.releaseDir, "node_modules", "jorgex-pi"));
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(beforeTree);
  });

  it("scope mismatch (kind or codingAgentDir) must throw without modifying anything", async () => {
    const verifyActivePiRelease = await loadVerifyActivePiRelease();
    const sb = setupActiveSandbox();

    const kindMutated = writeReceipt({
      agentDir: sb.agentDir,
      receiptPath: sb.receiptPath,
      engramBin: sb.engramBin,
      candidate: sb.candidate,
      evidence: sb.evidence,
      mutate: (receipt) => {
        (receipt["scope"] as Record<string, unknown>)["kind"] = "real";
      },
    });
    const beforeLink = fs.readlinkSync(sb.linkPath);
    const beforeTree = inventoryTreeSha256(sb.releaseDir);
    expect(() =>
      verifyActivePiRelease({
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        candidate: sb.candidate,
        evidence: sb.evidence,
        scopeKind: "target-dir",
        engramBin: sb.engramBin,
      }),
    ).toThrow(/pi-verify-active/);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(kindMutated);
    expect(fs.readlinkSync(sb.linkPath)).toBe(beforeLink);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(beforeTree);

    const dirMutated = writeReceipt({
      agentDir: sb.agentDir,
      receiptPath: sb.receiptPath,
      engramBin: sb.engramBin,
      candidate: sb.candidate,
      evidence: sb.evidence,
      mutate: (receipt) => {
        (receipt["scope"] as Record<string, unknown>)["codingAgentDir"] = path.join(sb.agentDir, "elsewhere");
      },
    });
    expect(() =>
      verifyActivePiRelease({
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        candidate: sb.candidate,
        evidence: sb.evidence,
        scopeKind: "target-dir",
        engramBin: sb.engramBin,
      }),
    ).toThrow(/pi-verify-active/);
    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(dirMutated);
    expect(fs.readlinkSync(sb.linkPath)).toBe(beforeLink);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(beforeTree);
  });

  it("engram.binary mismatch must throw without modifying anything", async () => {
    const verifyActivePiRelease = await loadVerifyActivePiRelease();
    const sb = setupActiveSandbox();
    const mutated = writeReceipt({
      agentDir: sb.agentDir,
      receiptPath: sb.receiptPath,
      engramBin: sb.engramBin,
      candidate: sb.candidate,
      evidence: sb.evidence,
      mutate: (receipt) => {
        (receipt["engram"] as Record<string, unknown>)["binary"] = path.join(sb.agentDir, "other-engram");
      },
    });
    const beforeLink = fs.readlinkSync(sb.linkPath);
    const beforeTree = inventoryTreeSha256(sb.releaseDir);

    expect(() =>
      verifyActivePiRelease({
        agentDir: sb.agentDir,
        receiptPath: sb.receiptPath,
        candidate: sb.candidate,
        evidence: sb.evidence,
        scopeKind: "target-dir",
        engramBin: sb.engramBin,
      }),
    ).toThrow(/pi-verify-active/);

    expect(fs.readFileSync(sb.receiptPath, "utf8")).toBe(mutated);
    expect(fs.readlinkSync(sb.linkPath)).toBe(beforeLink);
    expect(inventoryTreeSha256(sb.releaseDir)).toBe(beforeTree);
  });
});
