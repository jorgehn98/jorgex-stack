import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { PI_RUNTIME_CANDIDATE } from "./pi-runtime.js";
import { isStableSemverVersion } from "./npm-provider.js";
import type { PiRuntimeCandidate } from "./pi-package-lifecycle.js";

export interface StagedPiCandidateRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface StagedPiCandidateArtifact {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

export interface StagedPiCandidateEvidence {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
}

export interface BuildStagedPiCandidateInput {
  stageDir: string;
  release: StagedPiCandidateRelease;
  artifact: StagedPiCandidateArtifact;
  commit: string;
  hostVersion: string;
  evidence: StagedPiCandidateEvidence;
}

const REGISTRY_HOST = "registry.npmjs.org";
const PACKAGE_NAME = "jorgex-pi";
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const COMMIT40 = /^[0-9a-f]{40}$/;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new Error(`pi-candidate: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

function assertCanonicalSri(integrity: unknown): Buffer {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail("release integrity must be canonical sha512 SRI");
  }
  const b64 = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    fail("release integrity must be canonical sha512 SRI");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    fail("release integrity must be canonical sha512 SRI");
  }
  if (bytes.length !== 64 || bytes.toString("base64") !== b64) {
    fail("release integrity must be canonical sha512 SRI");
  }
  return bytes;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function readBoundedJson(file: string, label: string): unknown {
  const st = lstatOrNull(file);
  if (st === null) fail(`missing ${label}: ${file}`);
  if (st.isSymbolicLink()) fail(`${label} must not be a symlink: ${file}`);
  if (!st.isFile()) fail(`${label} must be a regular file: ${file}`);
  if (st.size > MAX_JSON_BYTES) fail(`${label} exceeds size bound: ${file}`);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    fail(`cannot read ${label}: ${file}`);
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;
  try {
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        fail(`cannot read ${label}: ${file}`);
      }
      if (read === 0) break;
      total += read;
      if (total > MAX_JSON_BYTES) fail(`${label} exceeds size bound: ${file}`);
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors on a read-only descriptor.
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    fail(`malformed ${label}: ${file}`);
  }
}

function assertValidRelease(release: unknown): { version: string; expectedSha512: Buffer } {
  if (!isRecord(release)) fail("release must be an object");
  const { version, tarballUrl, integrity } = release;
  if (!isStableSemverVersion(version)) {
    fail(`invalid release version ${String(version)}`);
  }
  if (typeof tarballUrl !== "string") fail("foreign release tarball URL");
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    fail("foreign release tarball URL");
  }
  if (parsed.protocol !== "https:" || parsed.host !== REGISTRY_HOST || tarballUrl !== canonicalTarballUrl(version)) {
    fail("foreign release tarball URL");
  }
  return { version, expectedSha512: assertCanonicalSri(integrity) };
}

function assertValidArtifact(artifact: unknown, expectedSha512: Buffer): StagedPiCandidateArtifact {
  if (!isRecord(artifact)) fail("artifact must be an object");
  const { path: artifactPath, bytes, sha256, sha512 } = artifact;
  if (typeof artifactPath !== "string" || artifactPath === "" || !path.isAbsolute(artifactPath)) {
    fail("artifact.path must be a non-empty absolute path");
  }
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    fail("artifact.bytes must be a non-negative integer");
  }
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) {
    fail("artifact.sha256 must be 64 lowercase hex");
  }
  if (typeof sha512 !== "string" || !HEX128.test(sha512)) {
    fail("artifact.sha512 must be 128 lowercase hex");
  }
  let actual512: Buffer;
  try {
    actual512 = Buffer.from(sha512, "hex");
  } catch {
    fail("artifact.sha512 must be 128 lowercase hex");
  }
  if (actual512.length !== expectedSha512.length || !timingSafeEqual(actual512, expectedSha512)) {
    fail("artifact digest does not match release integrity");
  }
  return { path: artifactPath, bytes, sha256, sha512 };
}

function assertValidCommit(commit: unknown): string {
  if (typeof commit !== "string" || !COMMIT40.test(commit)) {
    fail("commit must be 40 lowercase hex");
  }
  return commit;
}

function assertValidEvidence(evidence: unknown): void {
  if (!isRecord(evidence)) fail("evidence must be an object");
  const { lockSha256, treeSha256, dependencies } = evidence;
  if (typeof lockSha256 !== "string" || !HEX64.test(lockSha256)) {
    fail("evidence.lockSha256 must be 64 lowercase hex");
  }
  if (typeof treeSha256 !== "string" || !HEX64.test(treeSha256)) {
    fail("evidence.treeSha256 must be 64 lowercase hex");
  }
  if (!Array.isArray(dependencies)) fail("evidence.dependencies must be an array");
  for (const dep of dependencies) {
    if (!isRecord(dep)) fail("evidence.dependencies entry must be an object");
    const { name, version, integrity } = dep;
    if (typeof name !== "string" || name === "") fail("evidence.dependencies entry misses name");
    if (typeof version !== "string" || version === "" || /\s/.test(version)) {
      fail(`evidence.dependencies entry ${String(name)} has an invalid version`);
    }
    assertCanonicalSri(integrity);
  }
}

/**
 * T06 stage-producer boundary: build the dynamic runtime candidate from the
 * already staged Pi package. Reads only the isolated stage
 * (`stageDir/npm/node_modules/jorgex-pi` manifest plus
 * `contract/jorgex-pi.v1.json`, `contract/assets.v1.json`,
 * `contract/runner.v1.json`); no network, no HOME, no active npm/settings.
 *
 * Fail-closed with `pi-candidate:` before activation on any divergent
 * identity, release, digest, commit, or producer contract outside the Stack
 * compatibility policy (`PI_RUNTIME_CANDIDATE.contract`). The policy is
 * compatibility only, never a release selector: package/source come from the
 * dynamic `release`. `hostVersion` is accepted without gating on the frozen
 * `testedVersions`; isolated Pi smoke decides compatibility later.
 * `pi.testedVersions` records the staged producer evidence verbatim.
 */
export function buildStagedPiCandidate(input: BuildStagedPiCandidateInput): PiRuntimeCandidate {
  if (!isRecord(input)) fail("input must be an object");
  const { stageDir, release, artifact, commit, hostVersion, evidence } = input as Record<string, unknown>;
  if (typeof stageDir !== "string" || stageDir === "") fail("stageDir must be a non-empty path");
  if (typeof hostVersion !== "string" || hostVersion === "") fail("hostVersion must be a non-empty string");

  const { version, expectedSha512 } = assertValidRelease(release);
  const verifiedArtifact = assertValidArtifact(artifact, expectedSha512);
  const verifiedCommit = assertValidCommit(commit);
  assertValidEvidence(evidence);

  const stageRoot = lstatOrNull(path.resolve(stageDir as string));
  if (stageRoot === null || !stageRoot.isDirectory() || stageRoot.isSymbolicLink()) {
    fail("stageDir must be a real directory");
  }
  const pkgDir = path.join(path.resolve(stageDir as string), "npm", "node_modules", PACKAGE_NAME);
  const pkgDirStat = lstatOrNull(pkgDir);
  if (pkgDirStat === null || !pkgDirStat.isDirectory() || pkgDirStat.isSymbolicLink()) {
    fail(`staged package must be a real directory: ${pkgDir}`);
  }

  const manifestRaw = readBoundedJson(path.join(pkgDir, "package.json"), "staged jorgex-pi manifest");
  if (!isRecord(manifestRaw) || manifestRaw["name"] !== PACKAGE_NAME || manifestRaw["version"] !== version) {
    fail("staged jorgex-pi manifest identity/version mismatch");
  }

  const rootContractRaw = readBoundedJson(
    path.join(pkgDir, "contract", "jorgex-pi.v1.json"),
    "staged root contract",
  );
  if (!isRecord(rootContractRaw)) fail("staged root contract must be an object");
  if (rootContractRaw["schemaVersion"] !== 1) fail("staged root contract schemaVersion must be 1");
  const contractedPackage = rootContractRaw["package"];
  if (!isRecord(contractedPackage)) fail("staged root contract misses package");
  const expectedSource = `npm:${PACKAGE_NAME}@${version}`;
  if (
    contractedPackage["name"] !== PACKAGE_NAME ||
    contractedPackage["version"] !== version ||
    contractedPackage["source"] !== expectedSource
  ) {
    fail("staged root contract package identity/source mismatch");
  }
  const contractedPi = rootContractRaw["pi"];
  if (!isRecord(contractedPi) || !Array.isArray(contractedPi["testedVersions"])) {
    fail("staged root contract misses pi.testedVersions");
  }
  const testedVersions = contractedPi["testedVersions"] as unknown[];
  if (testedVersions.length === 0 || !testedVersions.every((v): v is string => typeof v === "string" && v !== "")) {
    fail("staged root contract pi.testedVersions must be a non-empty string array");
  }
  const stagedCapabilities = rootContractRaw["capabilities"];
  if (!Array.isArray(stagedCapabilities) || !stagedCapabilities.every((c): c is string => typeof c === "string")) {
    fail("staged root contract misses capabilities");
  }

  const policy = PI_RUNTIME_CANDIDATE.contract;
  if (rootContractRaw["schemaVersion"] !== policy.schemaVersion) {
    fail("staged contract schemaVersion drifts from Stack policy");
  }
  if (
    stagedCapabilities.length !== policy.capabilities.length ||
    !stagedCapabilities.every((cap, index) => cap === (policy.capabilities as readonly string[])[index])
  ) {
    fail("staged capabilities drift from Stack policy");
  }

  const assetsRaw = readBoundedJson(path.join(pkgDir, "contract", "assets.v1.json"), "staged assets contract");
  if (!isRecord(assetsRaw)) fail("staged assets contract must be an object");
  if (assetsRaw["schemaVersion"] !== 1) fail("staged assets contract schemaVersion must be 1");
  const stagedWrites = assetsRaw["managedExternalWrites"];
  if (!Array.isArray(stagedWrites)) fail("staged assets contract misses managedExternalWrites");
  const policyWrites = policy.managedExternalWrites as readonly unknown[];
  if (
    stagedWrites.length !== policyWrites.length ||
    !stagedWrites.every((write, index) => JSON.stringify(write) === JSON.stringify(policyWrites[index]))
  ) {
    fail("staged managedExternalWrites drift from Stack policy");
  }

  const runnerRaw = readBoundedJson(path.join(pkgDir, "contract", "runner.v1.json"), "staged runner contract");
  if (!isRecord(runnerRaw)) fail("staged runner contract must be an object");
  const runnerCommands = runnerRaw["commands"];
  const runnerStdout = runnerRaw["stdout"];
  if (
    runnerRaw["schemaVersion"] !== policy.runner.schemaVersion ||
    runnerRaw["bin"] !== policy.runner.bin ||
    !Array.isArray(runnerCommands) ||
    runnerCommands.length !== policy.runner.commands.length ||
    !runnerCommands.every((cmd, index) => cmd === (policy.runner.commands as readonly string[])[index]) ||
    !isRecord(runnerStdout) ||
    runnerStdout["maxBytes"] !== policy.runner.maxStdoutBytes
  ) {
    fail("staged runner contract drifts from Stack policy");
  }

  return {
    package: { name: PACKAGE_NAME, version, source: expectedSource },
    provenance: { commit: verifiedCommit },
    tarball: { bytes: verifiedArtifact.bytes, sha256: verifiedArtifact.sha256, sha512: verifiedArtifact.sha512 },
    pi: { testedVersions: [...testedVersions] },
    contract: {
      schemaVersion: 1,
      capabilities: [...stagedCapabilities],
      runner: {
        bin: policy.runner.bin,
        commands: [...(policy.runner.commands as readonly string[])],
        schemaVersion: policy.runner.schemaVersion,
        maxStdoutBytes: policy.runner.maxStdoutBytes,
      },
      managedExternalWrites: (stagedWrites as PiRuntimeCandidate["contract"]["managedExternalWrites"]).map(
        (write) => ({ ...write }),
      ),
    },
  };
}
