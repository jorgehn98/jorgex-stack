import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "../src/lib/pi-runtime.js";

/**
 * [T05/T06-RED] verified runtime candidate from the already staged Pi package.
 *
 * Intended code-facing contract (no production change here):
 * - `buildStagedPiCandidate({ stageDir, release: { version, tarballUrl, integrity },
 *   artifact: { path, bytes, sha256, sha512 }, commit, hostVersion,
 *   evidence: { lockSha256, treeSha256, dependencies } }): PiRuntimeCandidate`
 *   exported from `src/lib/pi-candidate.ts` (sync or async; the test awaits it).
 * - `stageDir` is the isolated Pi stage agent dir holding the staged npm tree
 *   at `stageDir/npm/node_modules/jorgex-pi`. The builder reads the staged
 *   installed `package.json` plus
 *   `contract/jorgex-pi.v1.json`, `contract/assets.v1.json`,
 *   `contract/runner.v1.json` — no network, no HOME, no active npm/settings.
 * - Exact published identity: staged `package.json` name/version and staged
 *   contract `package { name, version, source }` must equal
 *   `jorgex-pi / release.version / npm:jorgex-pi@release.version`; otherwise
 *   throw `pi-candidate:` before activation.
 * - Stack policy is compatibility only (`PI_RUNTIME_CANDIDATE.contract` from
 *   `src/lib/pi-runtime.ts`): producer `schemaVersion` 1 plus runner
 *   `bin`/`schemaVersion`/`commands`/`maxBytes` must align the policy, staged
 *   `capabilities` and `managedExternalWrites` must be accepted with no unknown
 *   writes; otherwise throw `pi-candidate:` before activation. The policy is
 *   never a package release selector: package/source come from the dynamic
 *   `release`, never from the frozen pin.
 * - `hostVersion` compatibility must NOT rely on static `testedVersions`;
 *   only stage smoke later decides. A host outside the frozen list still
 *   yields a candidate.
 * - Returns the dynamic candidate: `package`/`source` from `release`,
 *   `tarball` observed `{ bytes, sha256, sha512 }` hex from `artifact`,
 *   `provenance.commit` from the public Pi tag (`commit`), `pi.testedVersions`
 *   producer evidence from the staged contract, and the validated `contract`.
 *
 * Fixture notes:
 * - All paths live in an `os.tmpdir()` sandbox (never real HOME). Synthetic
 *   stable `9.9.9` package version, `9.8.x` host/tested versions, synthetic
 *   `aaaa…` commit, and synthetic `9.9.1x` companion identities only prove the
 *   builder observes the staged evidence instead of hardcoding the frozen
 *   `0.8.29` pin. They are not claims about any real published version/hash.
 * - The tarball bytes are a real temp file whose `sha256`/`sha512` hex and
 *   `sha512-` SRI are computed from those bytes, so a strict builder that
 *   cross-checks `artifact.sha512` hex against `release.integrity` base64
 *   still passes; a shape-only builder also passes.
 * - Policy `capabilities`/`managedExternalWrites`/`runner` are copied from the
 *   live `PI_RUNTIME_CANDIDATE.contract` so the test stays in sync with Stack
 *   policy without freezing literals. The positive keeps them exact; the
 *   negatives mutate exactly one axis (extra foreign write, wrong runner bin).
 */

type CandidateRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type CandidateArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
};

type CandidateEvidence = {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
};

type CandidateInput = {
  stageDir: string;
  release: CandidateRelease;
  artifact: CandidateArtifact;
  commit: string;
  hostVersion: string;
  evidence: CandidateEvidence;
};

type PiCandidate = {
  package: { name: string; version: string; source: string };
  provenance: { commit: string };
  tarball: { bytes: number; sha256: string; sha512: string };
  pi: { testedVersions: readonly string[] };
  contract: {
    schemaVersion: number;
    capabilities: readonly string[];
    runner: {
      bin: string;
      commands: readonly string[];
      schemaVersion: number;
      maxStdoutBytes: number;
    };
    managedExternalWrites: ReadonlyArray<{
      owner: string;
      root: string;
      relativePath: string;
      semantics: string;
    }>;
  };
};

type PiCandidateModule = {
  buildStagedPiCandidate(input: CandidateInput): PiCandidate | Promise<PiCandidate>;
};

const candidateSpecifier = new URL("../src/lib/pi-candidate.js", import.meta.url).href;

async function loadCandidate(): Promise<PiCandidateModule> {
  const mod = (await import(/* @vite-ignore */ candidateSpecifier)) as Partial<PiCandidateModule>;
  expect(
    mod.buildStagedPiCandidate,
    "buildStagedPiCandidate must be exported from src/lib/pi-candidate.ts",
  ).toBeTypeOf("function");
  return mod as PiCandidateModule;
}

// Synthetic stable package version, distinct from the frozen 0.8.29 pin.
const STAGED_VERSION = "9.9.9";
// Synthetic host outside both the frozen testedVersions and the staged
// producer evidence: proves the builder does not gate on static lists.
const HOST_VERSION = "9.8.0";
// Synthetic producer evidence carried in the staged contract.
const STAGED_TESTED_VERSIONS = ["9.8.7"] as const;
// Synthetic informational tag commit (40 lowercase hex, clearly not a real claim).
const PRODUCER_COMMIT = "a".repeat(40);

// Shape-only companion names frozen with tests/fixtures/pi-runtime.ts
// (`bundledDependencies`); versions/hashes below are synthetic.
const STAGED_DEP_NAMES = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "pi-subagents",
  "pi-web-access",
  "@narumitw/pi-goal",
  "strip-json-comments",
] as const;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function syntheticIntegrity(fill: number): string {
  return `sha512-${Buffer.alloc(64, fill).toString("base64")}`;
}

function syntheticDepVersion(index: number): string {
  return `9.9.${10 + index}`;
}

function canonicalParentTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

type StagedFixture = {
  stageDir: string;
  release: CandidateRelease;
  artifact: CandidateArtifact;
  commit: string;
  hostVersion: string;
  evidence: CandidateEvidence;
};

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildStagedFixture(): StagedFixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-candidate-"));
  sandboxes.push(sandbox);

  const stageDir = path.join(sandbox, "stage");
  const pkgDir = path.join(stageDir, "npm", "node_modules", "jorgex-pi");
  fs.mkdirSync(path.join(pkgDir, "contract"), { recursive: true });

  // Observed tarball bytes: real temp file, digests computed from it.
  const tarballBytes = Buffer.from("synthetic-test-tarball-bytes-9.9.9\n", "utf8");
  const tarballPath = path.join(sandbox, "downloads", `jorgex-pi-${STAGED_VERSION}.tgz`);
  fs.mkdirSync(path.dirname(tarballPath), { recursive: true });
  fs.writeFileSync(tarballPath, tarballBytes);
  const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const sha512 = createHash("sha512").update(tarballBytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;

  const release: CandidateRelease = {
    version: STAGED_VERSION,
    tarballUrl: canonicalParentTarballUrl(STAGED_VERSION),
    integrity,
  };
  const artifact: CandidateArtifact = {
    path: tarballPath,
    bytes: tarballBytes.byteLength,
    sha256,
    sha512,
  };

  // Stack compatibility policy only (never a release selector).
  const policyCaps = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
  const policyWrites = PI_RUNTIME_CANDIDATE.contract.managedExternalWrites.map((write) => ({ ...write }));
  const policyRunner = {
    bin: PI_RUNTIME_CANDIDATE.contract.runner.bin,
    commands: [...PI_RUNTIME_CANDIDATE.contract.runner.commands],
    schemaVersion: PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion,
    maxStdoutBytes: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes,
  };

  const packageSource = `npm:jorgex-pi@${STAGED_VERSION}`;
  const companionDeps: Record<string, string> = {};
  for (const name of STAGED_DEP_NAMES) companionDeps[name] = "*";

  writeJson(path.join(pkgDir, "package.json"), {
    name: "jorgex-pi",
    version: STAGED_VERSION,
    dependencies: companionDeps,
  });
  writeJson(path.join(pkgDir, "contract", "jorgex-pi.v1.json"), {
    schemaVersion: 1,
    package: { name: "jorgex-pi", version: STAGED_VERSION, source: packageSource },
    pi: { testedVersions: [...STAGED_TESTED_VERSIONS] },
    capabilities: policyCaps,
  });
  writeJson(path.join(pkgDir, "contract", "assets.v1.json"), {
    schemaVersion: 1,
    managedExternalWrites: policyWrites,
  });
  writeJson(path.join(pkgDir, "contract", "runner.v1.json"), {
    schemaVersion: policyRunner.schemaVersion,
    bin: policyRunner.bin,
    commands: policyRunner.commands,
    stdout: { maxBytes: policyRunner.maxStdoutBytes },
  });

  const dependencies = STAGED_DEP_NAMES.map((name, index) => ({
    name,
    version: syntheticDepVersion(index),
    integrity: syntheticIntegrity(11 + index),
  }));

  return {
    stageDir,
    release,
    artifact,
    commit: PRODUCER_COMMIT,
    hostVersion: HOST_VERSION,
    evidence: {
      lockSha256: "c".repeat(64),
      treeSha256: "d".repeat(64),
      dependencies,
    },
  };
}

function stagedPkgDir(stageDir: string): string {
  return path.join(stageDir, "npm", "node_modules", "jorgex-pi");
}

describe("[T05/T06-RED] staged Pi runtime candidate before activation", () => {
  it("builds a dynamic candidate from the staged install, distinct from the frozen pin", async () => {
    const { buildStagedPiCandidate } = await loadCandidate();
    const fixture = buildStagedFixture();

    const candidate = await buildStagedPiCandidate({
      stageDir: fixture.stageDir,
      release: fixture.release,
      artifact: fixture.artifact,
      commit: fixture.commit,
      hostVersion: fixture.hostVersion,
      evidence: fixture.evidence,
    });

    // Dynamic identity from the release, never the frozen pin.
    expect(candidate.package).toEqual({
      name: "jorgex-pi",
      version: STAGED_VERSION,
      source: `npm:jorgex-pi@${STAGED_VERSION}`,
    });
    expect(candidate.package.source).not.toBe(PI_RUNTIME_CANDIDATE.package.source);
    expect(candidate.package.version).not.toBe(PI_RUNTIME_CANDIDATE.package.version);
    // Observed tarball digest+bytes, not release SRI text.
    expect(candidate.tarball).toEqual({
      bytes: fixture.artifact.bytes,
      sha256: fixture.artifact.sha256,
      sha512: fixture.artifact.sha512,
    });
    // Informational tag commit flows through verbatim.
    expect(candidate.provenance).toEqual({ commit: PRODUCER_COMMIT });
    expect(candidate.provenance.commit).not.toBe(PI_RUNTIME_CANDIDATE.provenance.commit);
    // Producer evidence, not the frozen host list; host gate stays open here.
    expect([...candidate.pi.testedVersions]).toEqual([...STAGED_TESTED_VERSIONS]);
    expect([...candidate.pi.testedVersions]).not.toEqual([...PI_RUNTIME_CANDIDATE.pi.testedVersions]);
    expect(fixture.hostVersion).not.toContain(candidate.pi.testedVersions[0] ?? "__none__");
    // Validated contract aligns the Stack compatibility policy.
    expect(candidate.contract.schemaVersion).toBe(1);
    expect([...candidate.contract.capabilities]).toEqual([...PI_RUNTIME_CANDIDATE.contract.capabilities]);
    expect(candidate.contract.runner).toEqual({ ...PI_RUNTIME_CANDIDATE.contract.runner });
    expect(candidate.contract.managedExternalWrites).toEqual([
      ...PI_RUNTIME_CANDIDATE.contract.managedExternalWrites,
    ]);

    // Independence from the frozen pin literals that motivated the shape.
    const encoded = JSON.stringify(candidate);
    expect(encoded).not.toContain("0.8.29");
    expect(encoded).not.toContain(PI_RUNTIME_CANDIDATE.provenance.commit);
  });

  it("rejects an extra foreign managedExternalWrite before activation", async () => {
    const { buildStagedPiCandidate } = await loadCandidate();
    const fixture = buildStagedFixture();

    const assetsPath = path.join(stagedPkgDir(fixture.stageDir), "contract", "assets.v1.json");
    const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8")) as {
      managedExternalWrites: Array<Record<string, string>>;
    };
    assets.managedExternalWrites.push({
      owner: "jorgex-pi",
      root: "PI_CODING_AGENT_DIR",
      relativePath: "evil/foreign.json",
      semantics: "foreign write must reject before activation",
    });
    writeJson(assetsPath, assets);

    await expect(
      Promise.resolve().then(() =>
        buildStagedPiCandidate({
          stageDir: fixture.stageDir,
          release: fixture.release,
          artifact: fixture.artifact,
          commit: fixture.commit,
          hostVersion: fixture.hostVersion,
          evidence: fixture.evidence,
        }),
      ),
    ).rejects.toThrow(/pi-candidate:/);
  });

  it("rejects a wrong runner contract before activation", async () => {
    const { buildStagedPiCandidate } = await loadCandidate();
    const fixture = buildStagedFixture();

    const runnerPath = path.join(stagedPkgDir(fixture.stageDir), "contract", "runner.v1.json");
    const runner = JSON.parse(fs.readFileSync(runnerPath, "utf8")) as Record<string, unknown>;
    writeJson(runnerPath, { ...runner, bin: "evil-bin" });

    await expect(
      Promise.resolve().then(() =>
        buildStagedPiCandidate({
          stageDir: fixture.stageDir,
          release: fixture.release,
          artifact: fixture.artifact,
          commit: fixture.commit,
          hostVersion: fixture.hostVersion,
          evidence: fixture.evidence,
        }),
      ),
    ).rejects.toThrow(/pi-candidate:/);
  });
});
