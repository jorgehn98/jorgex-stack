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
    mcpNative?: { schemaVersion: number; contractPath: string };
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

// Published native MCP contract: literal expected copy of the independent
// published protocol, never derived from production code.
const NATIVE_CAPABILITY = "mcp-native-v1";

const NATIVE_BINDING = { schemaVersion: 1, contractPath: "contract/native-mcp.v1.json" };

const NATIVE_CONTRACT = {
  schemaVersion: 1,
  capability: NATIVE_CAPABILITY,
  transport: "native",
  configurationPath: "PI_CODING_AGENT_DIR/mcp.json",
  packageReceiptPath: "HOME/.jorgex-stack/pi-receipt.json",
  projectionReceiptPath: "HOME/.jorgex-stack/pi-projection-receipt.json",
  authorityField: "mcpNative",
  servers: ["engram", "context7", "chrome-devtools"],
  definitions: {
    entrypoint: "extensions/mcp-engram.mjs",
    digestExport: "digestNativeMcpDefinition",
    devtoolsExport: "resolveNativeDevtoolsDefinition",
  },
  ownership: {
    entrypoint: "extensions/native-mcp.mjs",
    export: "inspectNativeMcpOwnership",
  },
};

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

function writeNativeProducer(stageDir: string): void {
  const pkgDir = stagedPkgDir(stageDir);
  const rootPath = path.join(pkgDir, "contract", "jorgex-pi.v1.json");
  const root = JSON.parse(fs.readFileSync(rootPath, "utf8")) as {
    capabilities: string[];
    mcpNative?: unknown;
  };
  root.capabilities = [...root.capabilities, NATIVE_CAPABILITY];
  root.mcpNative = { ...NATIVE_BINDING };
  writeJson(rootPath, root);
  writeJson(path.join(pkgDir, "contract", "native-mcp.v1.json"), NATIVE_CONTRACT);

  const extensions = path.join(pkgDir, "extensions");
  fs.mkdirSync(extensions, { recursive: true });
  // Top-level throw sentinels: the candidate gate validates declarations and
  // file presence only, so importing either entrypoint must fail the run.
  fs.writeFileSync(
    path.join(extensions, "mcp-engram.mjs"),
    'throw new Error("native MCP entrypoint must not be executed by the candidate gate");\n' +
      "export function digestNativeMcpDefinition() {\n  return null;\n}\n" +
      "export function resolveNativeDevtoolsDefinition() {\n  return null;\n}\n",
  );
  fs.writeFileSync(
    path.join(extensions, "native-mcp.mjs"),
    'throw new Error("native MCP ownership entrypoint must not be executed by the candidate gate");\n' +
      "export async function inspectNativeMcpOwnership() {\n  return null;\n}\n",
  );
}

function nativeContractFile(stageDir: string): string {
  return path.join(stagedPkgDir(stageDir), "contract", "native-mcp.v1.json");
}

function nativeExtensionsDir(stageDir: string): string {
  return path.join(stagedPkgDir(stageDir), "extensions");
}

async function expectCandidateRejection(fixture: StagedFixture, expected: RegExp): Promise<void> {
  const { buildStagedPiCandidate } = await loadCandidate();
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
  ).rejects.toThrow(expected);
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

  it("accepts the published native MCP contract binding on the staged candidate", async () => {
    const { buildStagedPiCandidate } = await loadCandidate();
    const fixture = buildStagedFixture();
    writeNativeProducer(fixture.stageDir);

    const candidate = await buildStagedPiCandidate({
      stageDir: fixture.stageDir,
      release: fixture.release,
      artifact: fixture.artifact,
      commit: fixture.commit,
      hostVersion: fixture.hostVersion,
      evidence: fixture.evidence,
    });

    expect([...candidate.contract.capabilities]).toEqual([
      ...PI_RUNTIME_CANDIDATE.contract.capabilities,
      NATIVE_CAPABILITY,
    ]);
    expect(candidate.contract).toMatchObject({ mcpNative: NATIVE_BINDING });
    // Entrypoints carry throw sentinels: accepting the candidate proves the
    // gate validates declarations and presence without importing the modules.
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

describe("[T74] native MCP producer declaration and boundary negatives", () => {
  type NativeRow = { name: string; mutate: (stageDir: string) => void; expected: RegExp };

  const bindingDrift = /pi-candidate: staged root contract mcpNative binding drifts from Stack native policy/;
  const capabilityDrift = /pi-candidate: staged capabilities drift from Stack policy/;
  const nativeContractDrift = /pi-candidate: staged native MCP contract drifts from Stack native policy/;

  function mutateNativeRoot(stageDir: string, mutate: (root: Record<string, unknown>) => void): void {
    const file = path.join(stagedPkgDir(stageDir), "contract", "jorgex-pi.v1.json");
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    mutate(root);
    writeJson(file, root);
  }

  function mutateNativeContract(stageDir: string, mutate: (contract: Record<string, unknown>) => void): void {
    const file = nativeContractFile(stageDir);
    const contract = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    mutate(contract);
    writeJson(file, contract);
  }

  function withNativeFixture(mutate: (stageDir: string) => void): StagedFixture {
    const fixture = buildStagedFixture();
    writeNativeProducer(fixture.stageDir);
    mutate(fixture.stageDir);
    return fixture;
  }

  it.each<NativeRow>([
    {
      name: "rejects the native capability when the root mcpNative binding is absent",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          delete root.mcpNative;
        }),
      expected: bindingDrift,
    },
    {
      name: "rejects a root mcpNative binding with a wrong schema version",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          root.mcpNative = { schemaVersion: 2, contractPath: NATIVE_BINDING.contractPath };
        }),
      expected: bindingDrift,
    },
    {
      name: "rejects a root mcpNative binding pointing at a foreign contract path",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          root.mcpNative = { schemaVersion: 1, contractPath: "contract/foreign.v1.json" };
        }),
      expected: bindingDrift,
    },
    {
      name: "rejects a root mcpNative binding carrying an unknown field",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          root.mcpNative = { ...NATIVE_BINDING, extra: true };
        }),
      expected: bindingDrift,
    },
    {
      name: "rejects a root mcpNative binding without the native capability",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          root.capabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
        }),
      expected: /pi-candidate: staged root contract declares mcpNative without the mcp-native-v1 capability/,
    },
  ])("$name", async ({ mutate, expected }) => {
    await expectCandidateRejection(withNativeFixture(mutate), expected);
  });

  it.each<NativeRow>([
    {
      name: "rejects an unknown extra capability inserted before the terminal native capability",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          const caps = root.capabilities as string[];
          root.capabilities = [...caps.slice(0, -1), "mcp-unknown-v9", NATIVE_CAPABILITY];
        }),
      expected: capabilityDrift,
    },
    {
      name: "rejects a reordered legacy capability prefix with the native capability terminal",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          const caps = root.capabilities as string[];
          root.capabilities = [...caps.slice(0, -1)].reverse().concat(NATIVE_CAPABILITY);
        }),
      expected: capabilityDrift,
    },
    {
      name: "rejects a duplicated legacy capability",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          const caps = root.capabilities as string[];
          root.capabilities = [caps[0], ...caps];
        }),
      expected: capabilityDrift,
    },
    {
      name: "rejects the native capability placed before the legacy list",
      mutate: (stageDir) =>
        mutateNativeRoot(stageDir, (root) => {
          const caps = root.capabilities as string[];
          root.capabilities = [NATIVE_CAPABILITY, ...caps.slice(0, -1)];
        }),
      expected: capabilityDrift,
    },
  ])("$name", async ({ mutate, expected }) => {
    await expectCandidateRejection(withNativeFixture(mutate), expected);
  });

  it.each<NativeRow>([
    {
      name: "rejects a missing native MCP contract file",
      mutate: (stageDir) => fs.rmSync(nativeContractFile(stageDir)),
      expected: /pi-candidate: missing staged native MCP contract/,
    },
    {
      name: "rejects a malformed native MCP contract JSON",
      mutate: (stageDir) => fs.writeFileSync(nativeContractFile(stageDir), "{ not json"),
      expected: /pi-candidate: malformed staged native MCP contract/,
    },
    {
      name: "rejects a native MCP contract that alters the execution entrypoint",
      mutate: (stageDir) =>
        mutateNativeContract(stageDir, (contract) => {
          (contract.definitions as Record<string, unknown>).entrypoint = "extensions/foreign.mjs";
        }),
      expected: nativeContractDrift,
    },
    {
      name: "rejects a native MCP contract that alters the definition export",
      mutate: (stageDir) =>
        mutateNativeContract(stageDir, (contract) => {
          (contract.definitions as Record<string, unknown>).digestExport = "foreignDigest";
        }),
      expected: nativeContractDrift,
    },
    {
      name: "rejects a native MCP contract that alters the authority path",
      mutate: (stageDir) =>
        mutateNativeContract(stageDir, (contract) => {
          contract.projectionReceiptPath = "HOME/.jorgex-stack/foreign.json";
        }),
      expected: nativeContractDrift,
    },
    {
      name: "rejects a native MCP contract carrying an unknown field",
      mutate: (stageDir) =>
        mutateNativeContract(stageDir, (contract) => {
          contract.extra = true;
        }),
      expected: nativeContractDrift,
    },
  ])("$name", async ({ mutate, expected }) => {
    await expectCandidateRejection(withNativeFixture(mutate), expected);
  });

  it.each<NativeRow>([
    {
      name: "rejects a symlinked contract directory",
      mutate: (stageDir) => {
        const dir = path.join(stagedPkgDir(stageDir), "contract");
        const real = path.join(path.dirname(stagedPkgDir(stageDir)), "real-contract");
        fs.renameSync(dir, real);
        fs.symlinkSync(real, dir, "dir");
      },
      expected: /pi-candidate: staged contract directory must be a real directory/,
    },
    {
      name: "rejects a symlinked extensions directory",
      mutate: (stageDir) => {
        const dir = nativeExtensionsDir(stageDir);
        const real = path.join(stagedPkgDir(stageDir), "real-extensions");
        fs.renameSync(dir, real);
        fs.symlinkSync(real, dir, "dir");
      },
      expected: /pi-candidate: staged extensions directory must be a real directory/,
    },
    {
      name: "rejects a missing extensions directory",
      mutate: (stageDir) => fs.rmSync(nativeExtensionsDir(stageDir), { recursive: true }),
      expected: /pi-candidate: staged extensions directory must be a real directory/,
    },
    {
      name: "rejects a missing native MCP entrypoint file",
      mutate: (stageDir) => fs.rmSync(path.join(nativeExtensionsDir(stageDir), "mcp-engram.mjs")),
      expected: /pi-candidate: staged native MCP entrypoint must be a regular file/,
    },
    {
      name: "rejects a missing native MCP ownership entrypoint file",
      mutate: (stageDir) => fs.rmSync(path.join(nativeExtensionsDir(stageDir), "native-mcp.mjs")),
      expected: /pi-candidate: staged native MCP entrypoint must be a regular file/,
    },
    {
      name: "rejects a symlinked native MCP entrypoint",
      mutate: (stageDir) => {
        const entry = path.join(nativeExtensionsDir(stageDir), "mcp-engram.mjs");
        const target = path.join(nativeExtensionsDir(stageDir), "real-engram.mjs");
        fs.writeFileSync(target, "export {};\n");
        fs.rmSync(entry);
        fs.symlinkSync(target, entry, "file");
      },
      expected: /pi-candidate: staged native MCP entrypoint must be a regular file/,
    },
    {
      name: "rejects a directory where the native MCP entrypoint is expected",
      mutate: (stageDir) => {
        const entry = path.join(nativeExtensionsDir(stageDir), "mcp-engram.mjs");
        fs.rmSync(entry);
        fs.mkdirSync(entry);
      },
      expected: /pi-candidate: staged native MCP entrypoint must be a regular file/,
    },
  ])("$name", async ({ mutate, expected }) => {
    await expectCandidateRejection(withNativeFixture(mutate), expected);
  });
});
