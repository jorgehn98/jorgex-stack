import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type PreparePiAdoption = (
  input: {
    root: string;
    piDir: string;
    version: string;
    apply?: boolean;
    acceptDevtoolsHandoff?: boolean;
    acceptPlaywrightHandoff?: boolean;
    acceptPlaywrightSkillRemoval?: boolean;
    acceptPiVersion?: string;
  },
  dependencies?: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
) => Promise<{
  status: "unchanged" | "prepared";
  version: string;
  changedPaths: string[];
}>;

const adoptionModuleUrl = new URL("../.github/scripts/prepare-pi-adoption.mjs", import.meta.url).href;
const PIN_PATH = "src/lib/pi-runtime-pin.json";
const ARTIFACTS_PATH = "tests/fixtures/pi-runtime-artifacts.json";
const tarballUrl = (version: string) => `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
const temporaryRoots: string[] = [];
const PLAYWRIGHT_SKILL_FILES = ["SKILL.md", "references/guide.md"] as const;

function playwrightSkillContent(relativePath: string): string {
  return `legacy Playwright skill ${relativePath}\n`;
}

type Pin = {
  package: { name: "jorgex-pi"; version: string; source: string };
  provenance: { commit: string };
  tarball: { bytes: number; sha256: string; sha512: string };
};

type Artifacts = {
  current: Pin;
  previous: Pin;
  archive: { entries: number; parity: { source: { commit: string } } };
};

type PiVersionContract = {
  readonly minimumVersion: string;
  readonly maximumVersion: string;
  readonly testedVersions: readonly string[];
};

const DEFAULT_PI_VERSION_CONTRACT: PiVersionContract = {
  minimumVersion: "0.84.2",
  maximumVersion: "0.84.2",
  testedVersions: ["0.84.2"],
};

type AdoptionFixture = {
  root: string;
  piDir: string;
  version: string;
  current: Pin;
  next: Pin;
  sourceCommit: string;
  nextArchive: Artifacts["archive"];
  previousTarball: Buffer;
  tarball: Buffer;
};

function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    GIT_CONFIG_GLOBAL: path.join(root, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  }).trim();
}

function gitArchive(root: string, commit: string): Buffer {
  return execFileSync("git", ["archive", "--format=tar.gz", "--prefix=package/", commit], {
    cwd: root,
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function commit(root: string, message: string): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function initializeGit(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "JorgeX adoption fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha512(value: Buffer): string {
  return createHash("sha512").update(value).digest("hex");
}

function pin(version: string, producer: string, tarball: Buffer): Pin {
  return {
    package: { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` },
    provenance: { commit: producer },
    tarball: { bytes: tarball.byteLength, sha256: sha256(tarball), sha512: sha512(tarball) },
  };
}

function writePiRelease(
  root: string,
  version: string,
  sourceCommit: string,
  options: {
    runnerCommands?: string[];
    devtoolsHandoff?: boolean;
    devtoolsCapability?: boolean;
    devtoolsExclusion?: boolean;
    playwrightHandoff?: boolean;
    playwrightSkill?: boolean;
    playwrightSkillTree?: boolean;
    persistentControlSkill?: boolean;
    extraArchiveFile?: { path: string; content: string };
    removeArchiveFile?: string;
    rootContractMutation?: boolean;
    extraCapabilities?: string[];
    piVersionContract?: PiVersionContract;
  } = {},
): void {
  const devtoolsCapability = options.devtoolsCapability ?? options.devtoolsHandoff ?? false;
  const devtoolsExclusion = options.devtoolsExclusion ?? !devtoolsCapability;
  const piVersionContract = options.piVersionContract ?? DEFAULT_PI_VERSION_CONTRACT;
  const playwrightSkillEnabled = options.playwrightSkill ?? false;
  const playwrightSkillTree = options.playwrightSkillTree ?? playwrightSkillEnabled;
  const capabilities = [
    "foundation-contract-v1",
    ...(devtoolsCapability ? ["chrome-devtools-handoff-v1"] : []),
    ...(options.playwrightHandoff ? ["playwright-handoff-v1"] : []),
    "runner-json-v1",
    ...(options.extraCapabilities ?? []),
  ];
  const packageIdentity = { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` };
  writeJson(root, "package.json", {
    name: packageIdentity.name,
    version,
    type: "module",
    bin: { "jorgex-pi": "./bin/jorgex-pi.mjs" },
    files: ["agents", "assets", "bin", "contract", "extensions", "snapshot/agents"],
    dependencies: { "pi-web-access": "0.24.1" },
  });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "jorgex-pi.mjs"), "export {};\n", "utf8");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "tester.md"), "fixture agent\n", "utf8");
  fs.mkdirSync(path.join(root, "assets", "system-prompt"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "system-prompt", "AGENTS.md"), "fixture policy\n", "utf8");
  fs.mkdirSync(path.join(root, "snapshot", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "snapshot", "agents", "tester.md"), "fixture agent\n", "utf8");
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(root, "extensions", "bootstrap.ts"), "export const bootstrap = true;\n", "utf8");
  const playwrightExtension = path.join(root, "extensions", "playwright.ts");
  if (options.playwrightHandoff) fs.writeFileSync(playwrightExtension, "export const playwright = true;\n", "utf8");
  else if (fs.existsSync(playwrightExtension)) fs.unlinkSync(playwrightExtension);
  const playwrightSkillRoot = path.join(root, "skills", "playwright-cli");
  if (playwrightSkillTree) {
    for (const relativePath of PLAYWRIGHT_SKILL_FILES) {
      const file = path.join(playwrightSkillRoot, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, playwrightSkillContent(relativePath), "utf8");
    }
  } else {
    fs.rmSync(playwrightSkillRoot, { recursive: true, force: true });
  }
  const controlSkillRoot = path.join(root, "skills", "control-skill");
  if (options.persistentControlSkill) {
    const controlSkillFile = path.join(controlSkillRoot, "SKILL.md");
    fs.mkdirSync(path.dirname(controlSkillFile), { recursive: true });
    fs.writeFileSync(controlSkillFile, "persistent control skill\n", "utf8");
  } else {
    fs.rmSync(controlSkillRoot, { recursive: true, force: true });
  }
  if (options.extraArchiveFile) {
    const extraFile = path.join(root, options.extraArchiveFile.path);
    fs.mkdirSync(path.dirname(extraFile), { recursive: true });
    fs.writeFileSync(extraFile, options.extraArchiveFile.content, "utf8");
  }
  if (options.removeArchiveFile) fs.rmSync(path.join(root, options.removeArchiveFile), { force: true });

  writeJson(root, "contract/jorgex-pi.v1.json", {
    schemaVersion: 1,
    package: packageIdentity,
    pi: options.rootContractMutation
      ? { ...piVersionContract, minimumVersion: "0.84.3" }
      : piVersionContract,
    capabilities,
    snapshot: { contractPath: "contract/parity.v2.json", schemaVersion: 2 },
    assets: { manifestVersion: 1, manifestPath: "contract/assets.v1.json" },
    components: { inventoryPath: "contract/components.v1.json" },
    runtimeAgents: { contractPath: "contract/runtime-agents.v1.json" },
    runner: { contractPath: "contract/runner.v1.json" },
    schemas: {
      runnerResponse: "contract/schemas/runner-response.v1.schema.json",
      qualityReceipt: "contract/schemas/quality-receipt.v1.schema.json",
      qualityCapabilities: "contract/schemas/quality-capabilities.v1.schema.json",
    },
  });
  writeJson(root, "contract/runner.v1.json", {
    schemaVersion: 1,
    protocolVersion: 1,
    bin: "jorgex-pi",
    entrypoint: "bin/jorgex-pi.mjs",
    commands: options.runnerCommands ?? ["doctor", "sync"],
    exitCodes: { success: 0, unhealthy: 1, usage: 2, internal: 3 },
    stdout: { format: "json", records: 1, trailingNewline: true, maxBytes: 65_536 },
    responseSchema: "contract/schemas/runner-response.v1.schema.json",
  });
  writeJson(root, "contract/assets.v1.json", {
    schemaVersion: 1,
    manifestVersion: 1,
    ownership: "package",
    resources: ["agents", "assets/system-prompt", "contract/parity.v2.json", "snapshot/agents"],
    managedExternalWrites: [],
    preservedExternalState: [],
  });
  writeJson(root, "contract/components.v1.json", { schemaVersion: 1, components: ["agents", "assets"] });
  writeJson(root, "contract/runtime-agents.v1.json", { schemaVersion: 1, agents: ["tester"] });
  for (const schema of ["runner-response", "quality-receipt", "quality-capabilities"]) {
    writeJson(root, `contract/schemas/${schema}.v1.schema.json`, { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" });
  }
  const paritySkills = options.persistentControlSkill
    ? [{
      name: "control-skill",
      sourcePath: "stack/skills/control-skill",
      targetPath: "skills/control-skill",
      files: [{ path: "SKILL.md", sha256: sha256(Buffer.from("persistent control skill\n", "utf8")) }],
    }]
    : [];
  if (playwrightSkillEnabled) {
    paritySkills.push({
      name: "playwright-cli",
      sourcePath: "stack/skills/playwright-cli",
      targetPath: "skills/playwright-cli",
      files: PLAYWRIGHT_SKILL_FILES.map((relativePath) => ({
        path: relativePath,
        sha256: sha256(Buffer.from(playwrightSkillContent(relativePath), "utf8")),
      })),
    });
  }
  writeJson(root, "contract/parity.v2.json", {
    schemaVersion: 2,
    source: { repository: "https://github.com/jorgehn98/jorgex-stack", commit: sourceCommit },
    agents: [{ name: "tester", sourcePath: "stack/agents/tester.md", targetPath: "snapshot/agents/tester.md" }],
    skills: paritySkills,
    exclusions: devtoolsExclusion
      ? [{ kind: "capability-integration", id: "chrome-devtools-capability-handoff" }]
      : [],
  });
}

function archiveEntries(root: string, tarball: Buffer): number {
  const archive = path.join(root, "candidate.tgz");
  fs.writeFileSync(archive, tarball);
  const output = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    env: isolatedGitEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  return output.trimEnd().split(/\r?\n/).filter(Boolean).length;
}

function replaceArchiveMember(root: string, tarball: Buffer, member: string, content: string, outputMember = member): Buffer {
  const workspace = fs.mkdtempSync(path.join(path.dirname(root), "tarball-edit-"));
  const archive = path.join(workspace, "source.tgz");
  const extraction = path.join(workspace, "extract");
  fs.writeFileSync(archive, tarball);
  fs.mkdirSync(extraction);
  execFileSync("tar", ["-xzf", archive, "-C", extraction], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (outputMember !== member) fs.renameSync(path.join(extraction, member), path.join(extraction, outputMember));
  fs.writeFileSync(path.join(extraction, outputMember), content, "utf8");
  return execFileSync("tar", ["-czf", "-", "-C", extraction, "package"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
}

function createAdoptionFixture(options: {
  runnerCommands?: string[];
  previousDevtoolsHandoff?: boolean;
  devtoolsHandoff?: boolean;
  devtoolsCapability?: boolean;
  devtoolsExclusion?: boolean;
  previousPlaywrightHandoff?: boolean;
  playwrightHandoff?: boolean;
  previousPlaywrightSkill?: boolean;
  playwrightSkill?: boolean;
  producerPlaywrightSkillTree?: boolean;
  sourcePlaywrightSkill?: boolean;
  previousExtraArchiveFile?: { path: string; content: string };
  removeExtraArchiveFile?: string;
  extraArchiveFile?: { path: string; content: string };
  rootContractMutation?: boolean;
  extraCapabilities?: string[];
  piVersionContract?: PiVersionContract;
} = {}): AdoptionFixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-adoption-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "stack");
  const piDir = path.join(parent, "pi");
  fs.mkdirSync(root, { recursive: true });
  initializeGit(root);
  writeJson(root, "package.json", { name: "jorgex-stack", private: true, type: "module" });
  fs.mkdirSync(path.join(root, "stack", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "stack", "agents", "tester.md"), "old source\n", "utf8");
  const previousSourceCommit = commit(root, "stack: previous source");
  fs.writeFileSync(path.join(root, "stack", "agents", "tester.md"), "new source\n", "utf8");
  if (options.sourcePlaywrightSkill) {
    for (const relativePath of PLAYWRIGHT_SKILL_FILES) {
      const file = path.join(root, "stack", "skills", "playwright-cli", relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `source Playwright skill ${relativePath}\n`, "utf8");
    }
  }
  const sourceCommit = commit(root, "stack: source candidate");
  const retainControlSkill = options.previousPlaywrightSkill === true && options.playwrightSkill === false;

  fs.mkdirSync(piDir, { recursive: true });
  initializeGit(piDir);
  writePiRelease(piDir, "0.8.7", previousSourceCommit, {
    devtoolsHandoff: options.previousDevtoolsHandoff,
    playwrightHandoff: options.previousPlaywrightHandoff,
    playwrightSkill: options.previousPlaywrightSkill,
    persistentControlSkill: retainControlSkill,
    extraArchiveFile: options.previousExtraArchiveFile,
  });
  const oldProducer = commit(piDir, "pi: 0.8.7");
  git(piDir, ["tag", "v0.8.7", oldProducer]);
  const oldTarball = gitArchive(piDir, oldProducer);
  const current = pin("0.8.7", oldProducer, oldTarball);

  const artifacts: Artifacts = {
    current,
    previous: {
      package: { name: "jorgex-pi", version: "0.8.6", source: "npm:jorgex-pi@0.8.6" },
      provenance: { commit: "0".repeat(40) },
      tarball: { bytes: 1, sha256: "0".repeat(64), sha512: "0".repeat(128) },
    },
    archive: { entries: archiveEntries(parent, oldTarball), parity: { source: { commit: previousSourceCommit } } },
  };
  writeJson(root, PIN_PATH, current);
  writeJson(root, ARTIFACTS_PATH, artifacts);
  commit(root, "stack: pin 0.8.7");
  git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);
  git(root, ["switch", "-c", "adoption-test"]);

  writePiRelease(piDir, "0.8.8", sourceCommit, {
    runnerCommands: options.runnerCommands,
    devtoolsHandoff: options.devtoolsHandoff,
    devtoolsCapability: options.devtoolsCapability,
    devtoolsExclusion: options.devtoolsExclusion,
    playwrightHandoff: options.playwrightHandoff,
    playwrightSkill: options.playwrightSkill,
    playwrightSkillTree: options.producerPlaywrightSkillTree,
    persistentControlSkill: retainControlSkill,
    extraArchiveFile: options.extraArchiveFile,
    removeArchiveFile: options.removeExtraArchiveFile,
    rootContractMutation: options.rootContractMutation,
    extraCapabilities: options.extraCapabilities,
    piVersionContract: options.piVersionContract,
  });
  const nextProducer = commit(piDir, "pi: 0.8.8");
  git(piDir, ["tag", "v0.8.8", nextProducer]);
  git(piDir, ["update-ref", "refs/remotes/origin/main", nextProducer]);
  const tarball = gitArchive(piDir, nextProducer);
  const next = pin("0.8.8", nextProducer, tarball);

  return {
    root,
    piDir,
    version: "0.8.8",
    current,
    next,
    sourceCommit,
    nextArchive: { entries: archiveEntries(parent, tarball), parity: { source: { commit: sourceCommit } } },
    previousTarball: oldTarball,
    tarball,
  };
}

function registryFetch(
  fixture: AdoptionFixture,
  options: {
    integrity?: string;
    previousIntegrity?: string;
    tarball?: string;
    nextTarballBytes?: Buffer;
    previousTarballBytes?: Buffer;
  } = {},
) {
  const nextTarball = options.nextTarballBytes ?? fixture.tarball;
  const previousTarball = options.previousTarballBytes ?? fixture.previousTarball;
  const sri = (value: Buffer) => `sha512-${Buffer.from(sha512(value), "hex").toString("base64")}`;
  const metadataResponse = (version: string, artifact: Buffer, artifactUrl: string, integrity?: string) => new Response(JSON.stringify({
    name: "jorgex-pi",
    version,
    dist: { tarball: artifactUrl, integrity: integrity ?? sri(artifact) },
  }), { status: 200, headers: { "content-type": "application/json" } });

  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url) === `https://registry.npmjs.org/jorgex-pi/${fixture.version}`) {
      return metadataResponse(fixture.version, nextTarball, options.tarball ?? tarballUrl(fixture.version), options.integrity);
    }
    if (String(url) === `https://registry.npmjs.org/jorgex-pi/${fixture.current.package.version}`) {
      return metadataResponse(fixture.current.package.version, previousTarball, tarballUrl(fixture.current.package.version), options.previousIntegrity);
    }
    if (String(url) === tarballUrl(fixture.version)) return new Response(new Uint8Array(nextTarball), { status: 200 });
    if (String(url) === tarballUrl(fixture.current.package.version)) return new Response(new Uint8Array(previousTarball), { status: 200 });
    throw new Error(`Unexpected fixture fetch: ${String(url)}`);
  });
}

function rootState(fixture: AdoptionFixture): { pin: Pin; artifacts: Artifacts; status: string } {
  return {
    pin: readJson<Pin>(fixture.root, PIN_PATH),
    artifacts: readJson<Artifacts>(fixture.root, ARTIFACTS_PATH),
    status: git(fixture.root, ["status", "--porcelain"]),
  };
}

function commitBaselineMutation(
  fixture: AdoptionFixture,
  mutate: (current: Record<string, unknown>, artifacts: Record<string, unknown>) => void,
): void {
  const current = readJson<Record<string, unknown>>(fixture.root, PIN_PATH);
  const artifacts = readJson<Record<string, unknown>>(fixture.root, ARTIFACTS_PATH);
  mutate(current, artifacts);
  writeJson(fixture.root, PIN_PATH, current);
  writeJson(fixture.root, ARTIFACTS_PATH, artifacts);
  commit(fixture.root, "stack: malformed metadata baseline");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preparePiAdoption", () => {
  it("acepta sólo la incorporación explícita de Pi 0.85.1 y ajusta sus límites", async () => {
    const fixture = createAdoptionFixture({
      piVersionContract: {
        minimumVersion: "0.84.2",
        maximumVersion: "0.85.1",
        testedVersions: ["0.84.2", "0.85.1"],
      },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPiVersion: "0.85.1",
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it.each([
    ["retira la versión anterior", {
      minimumVersion: "0.85.1",
      maximumVersion: "0.85.1",
      testedVersions: ["0.85.1"],
    }],
    ["añade otra versión además de la aceptada", {
      minimumVersion: "0.84.2",
      maximumVersion: "0.85.1",
      testedVersions: ["0.84.2", "0.84.3", "0.85.1"],
    }],
    ["añade una versión intermedia en lugar de la aceptada", {
      minimumVersion: "0.84.2",
      maximumVersion: "0.84.3",
      testedVersions: ["0.84.2", "0.84.3"],
    }],
  ] as const)("rechaza una transición que %s aunque se confirme Pi 0.85.1", async (_case, piVersionContract) => {
    const fixture = createAdoptionFixture({ piVersionContract });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPiVersion: "0.85.1",
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("acepta la transición completa de DevTools sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ devtoolsHandoff: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptDevtoolsHandoff: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta la transición exacta de Playwright con bootstrap compartido sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta la retirada exacta de la skill Playwright sólo con confirmación explícita", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/parity\.v2\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("acepta conjuntamente la retirada de la skill y el handoff Playwright explícito", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightSkill: true,
      playwrightHandoff: true,
      playwrightSkill: false,
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies))
      .rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);
    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
      acceptPlaywrightSkillRemoval: true,
    }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });
  }, 15_000);

  it("rechaza un archivo ajeno añadido junto a la retirada confirmada", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      extraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un archivo ajeno retirado junto a la retirada confirmada", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      previousExtraArchiveFile: { path: "extensions/unrelated.ts", content: "export const unrelated = true;\n" },
      removeExtraArchiveFile: "extensions/unrelated.ts",
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado ajeno con el mismo inventario esperado", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/renamed.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/archive inventory.*review/i);

    expect(fetch).toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball previo corrupto y conserva pin y fixture", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
    });
    const previousTarball = replaceArchiveMember(
      fixture.root,
      fixture.previousTarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = false;\n",
    );
    const fetch = registryFetch(fixture, { previousTarballBytes: previousTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("no permite que la confirmación de retirada relaje otro cambio de contrato", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      runnerCommands: ["doctor", "sync", "cleanup"],
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/runner\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada si el productor conserva la carpeta de la skill", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      producerPlaywrightSkillTree: true,
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright skill must be absent from producer/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada si la fuente Stack fusionada conserva la carpeta de la skill", async () => {
    const fixture = createAdoptionFixture({
      previousPlaywrightHandoff: true,
      playwrightHandoff: true,
      previousPlaywrightSkill: true,
      playwrightSkill: false,
      sourcePlaywrightSkill: true,
    });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightSkillRemoval: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright skill must be absent from Stack source/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un archivo adicional junto al delta de Playwright confirmado", async () => {
    const fixture = createAdoptionFixture({
      playwrightHandoff: true,
      extraArchiveFile: { path: "extensions/extra.ts", content: "export const extra = true;\n" },
    });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright archive inventory requires exactly the reviewed module addition/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un renombrado con el mismo número esperado de entradas", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const renamedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = true;\n",
      "package/extensions/other.ts",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: renamedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright archive inventory requires exactly the reviewed module addition/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza un tarball previo que no coincide con sus bytes fijados", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const previousTarball = replaceArchiveMember(
      fixture.root,
      fixture.previousTarball,
      "package/extensions/bootstrap.ts",
      "export const bootstrap = false;\n",
    );
    const fetch = registryFetch(fixture, { previousTarballBytes: previousTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza el contenido de playwright.ts si el tarball no coincide con el blob Git del productor", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true });
    const substitutedTarball = replaceArchiveMember(
      fixture.root,
      fixture.tarball,
      "package/extensions/playwright.ts",
      "export const playwright = false;\n",
    );
    const fetch = registryFetch(fixture, { nextTarballBytes: substitutedTarball });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      apply: true,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Playwright module does not match producer/);

    expect(rootState(fixture)).toEqual(before);
  }, 15_000);

  it("rechaza una mutación ajena del contrato raíz aunque se confirme Playwright", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true, rootContractMutation: true });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una capability adicional junto a la transición confirmada de Playwright", async () => {
    const fixture = createAdoptionFixture({ playwrightHandoff: true, extraCapabilities: ["unexpected-capability-v1"] });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la retirada de Playwright aunque se confirme la transición", async () => {
    const fixture = createAdoptionFixture({ previousPlaywrightHandoff: true, playwrightHandoff: false });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptPlaywrightHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/jorgex-pi\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([
    ["sólo añade la capability", { devtoolsCapability: true, devtoolsExclusion: true }],
    ["sólo retira la exclusión", { devtoolsCapability: false, devtoolsExclusion: false }],
  ])("rechaza una transición parcial con confirmación (%s)", async (_label, options) => {
    const fixture = createAdoptionFixture(options);
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza la transición inversa aunque se confirme DevTools", async () => {
    const fixture = createAdoptionFixture({ previousDevtoolsHandoff: true, devtoolsHandoff: false });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una capability adicional junto a la transición confirmada", async () => {
    const fixture = createAdoptionFixture({ devtoolsHandoff: true, extraCapabilities: ["unexpected-capability-v1"] });
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("mantiene la adopción ordinaria compatible aunque se confirme DevTools", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({
      root: fixture.root,
      piDir: fixture.piDir,
      version: fixture.version,
      acceptDevtoolsHandoff: true,
    }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([false, true])("conserva los datos tras fallar la segunda escritura (rollback incompleto: %s)", async (failRollback) => {
    const fixture = createAdoptionFixture();
    const { preparePiAdoption } = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const pinPath = path.join(fixture.root, PIN_PATH);
    const artifactsPath = path.join(fixture.root, ARTIFACTS_PATH);
    const originalPin = fs.readFileSync(pinPath);
    const originalArtifacts = fs.readFileSync(artifactsPath);
    const before = rootState(fixture);
    const publishFailure = new Error("Injected second publication failure");
    const rollbackFailure = new Error("Injected pin restoration failure");
    const realRename = fs.renameSync;
    let stage: string | undefined;
    let pinAtSecondWrite: unknown;
    let failure: unknown;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const source = String(from);
      const parent = path.dirname(source);
      const isStage = path.dirname(parent) === fixture.root && path.basename(parent).startsWith(".pi-adoption-");
      if (isStage && path.basename(source) === "1.new" && String(to) === artifactsPath) {
        stage = parent;
        pinAtSecondWrite = readJson<Pin>(fixture.root, PIN_PATH);
        throw publishFailure;
      }
      if (failRollback && stage !== undefined && source === path.join(stage, "0.old") && String(to) === pinPath) {
        throw rollbackFailure;
      }
      realRename(from, to);
    });
    try {
      syncBuiltinESMExports();
      await preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, {
        fetch: registryFetch(fixture),
        now: () => 0,
        sleep: async () => undefined,
      });
    } catch (error) {
      failure = error;
    } finally {
      rename.mockRestore();
      syncBuiltinESMExports();
    }

    // The fault must occur after the first real publication, not during validation.
    expect(pinAtSecondWrite).toEqual(fixture.next);
    expect(stage).toBeDefined();
    expect(fs.readFileSync(artifactsPath)).toEqual(originalArtifacts);
    if (failRollback) {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ message: "Adoption rollback incomplete", cause: publishFailure, errors: [rollbackFailure], recoveryPath: stage });
      expect(fs.statSync(stage!).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(stage!, "0.old"))).toEqual(originalPin);
      expect(fs.existsSync(pinPath)).toBe(false);
    } else {
      expect(failure).toBe(publishFailure);
      expect(fs.readFileSync(pinPath)).toEqual(originalPin);
      expect(rootState(fixture)).toEqual(before);
      expect(fs.existsSync(stage!)).toBe(false);
    }
  }, 15_000);

  it("ignora GIT_COMMON_DIR heredado de otro repositorio en un no-op válido", async () => {
    const fixture = createAdoptionFixture();
    const { preparePiAdoption } = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const previous = process.env.GIT_COMMON_DIR;
    const fetch = vi.fn();
    let result: Awaited<ReturnType<PreparePiAdoption>> | undefined;
    let failure: unknown;
    try {
      process.env.GIT_COMMON_DIR = path.join(fixture.piDir, ".git");
      result = await preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.7" }, { fetch });
    } catch (error) {
      failure = error;
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previous;
    }

    expect(rootState(fixture)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(result).toEqual({ status: "unchanged", version: "0.8.7", changedPaths: [] });
  });

  it("expone el preparador async de adopción con dependencias inyectables", async () => {
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as {
      preparePiAdoption?: unknown;
    };

    expect(module.preparePiAdoption).toBeTypeOf("function");
    void (module.preparePiAdoption as PreparePiAdoption);
  });

  it("valida el tag y tar Git reales en dry-run, rota sólo los dos JSON al aplicar, y queda idempotente", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture);
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    const dependencies = { fetch: fetch as typeof globalThis.fetch, now: () => 0, sleep: async () => undefined };

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(rootState(fixture)).toEqual(before);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, dependencies)).resolves.toEqual({
      status: "prepared",
      version: fixture.version,
      changedPaths: [PIN_PATH, ARTIFACTS_PATH],
    });
    expect(readJson<Pin>(fixture.root, PIN_PATH)).toEqual(fixture.next);
    expect(readJson<Artifacts>(fixture.root, ARTIFACTS_PATH)).toEqual({
      current: fixture.next,
      previous: fixture.current,
      archive: fixture.nextArchive,
    });

    commit(fixture.root, "stack: adopt 0.8.8");
    const callsBeforeIdempotence = fetch.mock.calls.length;
    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, dependencies)).resolves.toEqual({
      status: "unchanged",
      version: fixture.version,
      changedPaths: [],
    });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeIdempotence);
    expect(rootState(fixture).status).toBe("");
  }, 15_000);

  it.each(["0.8.7", "0.8.6"])("no consulta npm para una versión igual o anterior (%s)", async (version) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).resolves.toEqual({ status: "unchanged", version, changedPaths: [] });

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("agota la lectura retryable con reloj inyectado y conserva el checkout", async () => {
    const fixture = createAdoptionFixture();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);
    let now = 0;
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      sleep,
    })).rejects.toThrow(/not publicly available/i);

    expect(fetch).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
    expect(now).toBeGreaterThan(0);
    expect(rootState(fixture)).toEqual(before);
  });

  it.each([
    {
      label: "campo ajeno en el pin actual",
      expected: /Unsupported pin fields/,
      mutate: (current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        current.unexpected = true;
        (artifacts.current as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en el pin previous",
      expected: /Unsupported pin fields/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        (artifacts.previous as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en artifacts",
      expected: /Unsupported fixture metadata/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        artifacts.unexpected = true;
      },
    },
    {
      label: "campo ajeno en archive",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        (artifacts.archive as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en parity",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        ((artifacts.archive as Record<string, unknown>).parity as Record<string, unknown>).unexpected = true;
      },
    },
    {
      label: "campo ajeno en source",
      expected: /strictly deep-equal/,
      mutate: (_current: Record<string, unknown>, artifacts: Record<string, unknown>) => {
        const parity = (artifacts.archive as Record<string, unknown>).parity as Record<string, unknown>;
        (parity.source as Record<string, unknown>).unexpected = true;
      },
    },
  ])("rechaza %s sin borrar metadata", async ({ expected, mutate }) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    commitBaselineMutation(fixture, mutate);
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.7", apply: true }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(expected);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un SRI SHA512 distinto y preserva ambos JSON", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture, { integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version, apply: true }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Registry SRI mismatch/);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un tarball npm que no sea la URL exacta publicada", async () => {
    const fixture = createAdoptionFixture();
    const fetch = registryFetch(fixture, { tarball: "https://registry.npmjs.org/jorgex-pi/-/other-package.tgz" });
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Unexpected registry artifact origin/);

    expect(fetch).toHaveBeenCalledOnce();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza una versión cuyo tag Pi exacto no existe antes de consultar npm", async () => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: "0.8.9" }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza cambios de contrato antes de consultar npm", async () => {
    const fixture = createAdoptionFixture({ runnerCommands: ["doctor", "sync", "cleanup"] });
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/contract\/runner\.v1\.json compatibility requires manual review/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un checkout Stack dirty antes de consultar npm", async () => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    fs.writeFileSync(path.join(fixture.root, "uncommitted.txt"), "user work\n", "utf8");
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Stack checkout must be clean and exclusively owned/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it.each(["--assume-unchanged", "--skip-worktree"])("rechaza %s que oculta una edición local", async (flag) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const target = path.join(fixture.root, PIN_PATH);
    git(fixture.root, ["update-index", flag, "--", PIN_PATH]);
    fs.appendFileSync(target, " ", "utf8");
    const before = rootState(fixture);

    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Hidden index flags are unsupported/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });

  it("rechaza un destino JSON simbólico antes de consultar npm", async (ctx) => {
    const fixture = createAdoptionFixture();
    const fetch = vi.fn();
    const module = await import(/* @vite-ignore */ adoptionModuleUrl) as { preparePiAdoption: PreparePiAdoption };
    const destination = path.join(fixture.root, ARTIFACTS_PATH);
    const outside = path.join(path.dirname(fixture.root), "outside-artifacts.json");
    fs.renameSync(destination, outside);
    try {
      fs.symlinkSync(outside, destination);
    } catch {
      fs.renameSync(outside, destination);
      ctx.skip("El entorno no permite crear symlinks de archivo.");
      return;
    }
    commit(fixture.root, "stack: symbolic adoption destination");
    const before = rootState(fixture);

    await expect(module.preparePiAdoption({ root: fixture.root, piDir: fixture.piDir, version: fixture.version }, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => 0,
      sleep: async () => undefined,
    })).rejects.toThrow(/Unsafe adoption destination/);

    expect(fetch).not.toHaveBeenCalled();
    expect(rootState(fixture)).toEqual(before);
  });
});
