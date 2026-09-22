import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const automationModuleUrl = new URL("../.github/scripts/stack-pi-automation.mjs", import.meta.url).href;
const stackRepository = { full_name: "jorgehn98/jorgex-stack" };
const producerSha = "a".repeat(40);

type ValidateWake = (eventName: unknown, event: unknown) => unknown;
type ValidateProposal = (proposal: unknown) => unknown;
type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;
type PublishProposal = (proposal: unknown, api: Api) => Promise<unknown>;
type ClassifyAdoptionIdentity = (input: { version: unknown; tagCommit: unknown; pinVersion: unknown; pinCommit: unknown }) => { status: string; version?: unknown; sourceSha: string };
type ClassifySnapshotIdentity = (input: { parityCommit: unknown; stackDiff: unknown; lastTouch: unknown }) => { status: string; sourceSha: string };

interface AutomationModule {
  validateWake?: unknown;
  validateProposal?: unknown;
  publishProposal?: unknown;
  classifyAdoptionIdentity?: unknown;
  classifySnapshotIdentity?: unknown;
}

interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

interface FakeApiOptions {
  branch?: string;
  confirmedPullRequest?: Record<string, unknown>;
  currentPullRequest?: Record<string, unknown>;
  failureAt?: string;
  graphqlIsDraft?: boolean;
  mainShas?: string[];
  matchingRefs?: Array<Record<string, unknown>>;
  pullPages?: Array<Array<Record<string, unknown>>>;
  remoteTreeSha?: string;
  repository?: string;
}

async function loadModule(): Promise<AutomationModule> {
  return await import(/* @vite-ignore */ automationModuleUrl) as AutomationModule;
}

async function loadValidateWake(): Promise<ValidateWake> {
  const module = await loadModule();
  expect(module.validateWake).toBeTypeOf("function");
  return module.validateWake as ValidateWake;
}

async function loadAutomation(): Promise<{ validateProposal: ValidateProposal; publishProposal: PublishProposal }> {
  const module = await loadModule();
  expect(module.validateProposal).toBeTypeOf("function");
  expect(module.publishProposal).toBeTypeOf("function");
  return {
    validateProposal: module.validateProposal as ValidateProposal,
    publishProposal: module.publishProposal as PublishProposal,
  };
}

async function loadIdentity(): Promise<{ classifyAdoptionIdentity: ClassifyAdoptionIdentity; classifySnapshotIdentity: ClassifySnapshotIdentity }> {
  const module = await loadModule();
  expect(module.classifyAdoptionIdentity).toBeTypeOf("function");
  expect(module.classifySnapshotIdentity).toBeTypeOf("function");
  return {
    classifyAdoptionIdentity: module.classifyAdoptionIdentity as ClassifyAdoptionIdentity,
    classifySnapshotIdentity: module.classifySnapshotIdentity as ClassifySnapshotIdentity,
  };
}

describe("Stack–Pi automation wake validation", () => {
  it("accepts the three exact supported wake events on Stack main", async () => {
    const validateWake = await loadValidateWake();

    expect(() => validateWake("push", {
      ref: "refs/heads/main",
      repository: stackRepository,
    })).not.toThrow();
    expect(() => validateWake("workflow_dispatch", {
      ref: "main",
      repository: stackRepository,
    })).not.toThrow();
    expect(() => validateWake("repository_dispatch", {
      action: "pi-published-v1",
      repository: stackRepository,
      client_payload: {
        version: "1.2.3",
        producer_sha: producerSha,
        run_id: "42",
      },
    })).not.toThrow();
  });

  it.each([
    ["unsupported event", "pull_request", { repository: stackRepository }],
    ["push outside main", "push", { ref: "refs/heads/release", repository: stackRepository }],
    ["manual wake outside main", "workflow_dispatch", { ref: "refs/heads/release", repository: stackRepository }],
    ["other repository", "push", { ref: "refs/heads/main", repository: { full_name: "other/repository" } }],
    ["unknown dispatch action", "repository_dispatch", { action: "pi-published-v2", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: producerSha, run_id: "42" } }],
    ["version with a leading zero", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "01.2.3", producer_sha: producerSha, run_id: "42" } }],
    ["version containing a newline", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3\n", producer_sha: producerSha, run_id: "42" } }],
    ["non-string producer SHA", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: 42, run_id: "42" } }],
    ["uppercase producer SHA", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: producerSha.toUpperCase(), run_id: "42" } }],
    ["non-positive run id", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: producerSha, run_id: "0" } }],
    ["run id containing a newline", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: producerSha, run_id: "42\n" } }],
    ["unexpected payload field", "repository_dispatch", { action: "pi-published-v1", repository: stackRepository, client_payload: { version: "1.2.3", producer_sha: producerSha, run_id: "42", extra: true } }],
  ])("rejects %s without admitting a looser event schema", async (_label, eventName, event) => {
    const validateWake = await loadValidateWake();

    expect(() => validateWake(eventName, event)).toThrow();
  });
});

const proposalBaseSha = "a".repeat(40);
const proposalTreeSha = "b".repeat(40);
const proposalSourceSha = "c".repeat(40);
const candidateSha = "d".repeat(40);
const snapshotRepository = "jorgehn98/jorgex-pi";
const snapshotRoot = `/repos/${snapshotRepository}`;
const snapshotBranch = `codex/stack-pi-snapshot-${proposalSourceSha}`;

function snapshotProposal(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 1,
    direction: "snapshot",
    baseSha: proposalBaseSha,
    treeSha: proposalTreeSha,
    sourceSha: proposalSourceSha,
    version: null,
    files: [{ path: "contract/parity.v2.json", content: "{}\n", mode: "100644" }],
    ...overrides,
  };
}

function adoptionProposal(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 1,
    direction: "adoption",
    baseSha: proposalBaseSha,
    treeSha: proposalTreeSha,
    sourceSha: proposalSourceSha,
    version: "1.2.3",
    files: [
      { path: "src/lib/pi-runtime-pin.json", content: "{}\n", mode: "100644" },
      { path: "tests/fixtures/pi-runtime-artifacts.json", content: "{}\n", mode: "100644" },
    ],
    ...overrides,
  };
}

function fakeApi(options: FakeApiOptions = {}): { api: Api; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const repository = options.repository ?? snapshotRepository;
  const root = `/repos/${repository}`;
  const branch = options.branch ?? snapshotBranch;
  const mainShas = [...(options.mainShas ?? [])];
  const pullPages = options.pullPages ?? [[]];
  let pullReadCount = 0;
  let isReady = false;
  const pull = (draft: boolean) => ({
    state: "open",
    draft,
    head: { sha: candidateSha, repo: { full_name: repository } },
    base: { sha: proposalBaseSha, ref: "main", repo: { full_name: repository } },
    node_id: "PR_kwDOStackPi_1",
  });

  const api: Api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (options.failureAt === `${method} ${path}`) throw new Error("injected remote failure");

    if (method === "GET" && path.startsWith(`${root}/pulls?`)) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return pullPages[page - 1] ?? [];
    }
    if (method === "GET" && path === `${root}/git/matching-refs/heads/${branch}`) return options.matchingRefs ?? [];
    if (method === "GET" && path === `${root}/git/ref/heads/main`) {
      return { object: { sha: mainShas.shift() ?? proposalBaseSha } };
    }
    if (method === "GET" && path === `${root}/git/commits/${proposalBaseSha}`) {
      return { tree: { sha: "e".repeat(40) } };
    }
    if (method === "POST" && path === `${root}/git/trees`) return { sha: options.remoteTreeSha ?? proposalTreeSha };
    if (method === "POST" && path === `${root}/git/commits`) return { sha: candidateSha };
    if (method === "POST" && path === `${root}/git/refs`) return { object: { sha: candidateSha } };
    if (method === "POST" && path === `${root}/pulls`) {
      return { number: 71, node_id: "PR_kwDOStackPi_1", html_url: `https://github.com/${repository}/pull/71` };
    }
    if (method === "GET" && path === `${root}/pulls/71`) {
      pullReadCount += 1;
      if (pullReadCount === 1) return options.currentPullRequest ?? pull(true);
      return options.confirmedPullRequest ?? pull(!isReady);
    }
    if (method === "POST" && path === "/graphql") {
      isReady = options.graphqlIsDraft !== true;
      return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: !isReady } } } };
    }
    throw new Error(`unexpected GitHub API route: ${method} ${path}`);
  };

  return { api, calls };
}

function writeCalls(calls: ApiCall[]): ApiCall[] {
  return calls.filter((call) => call.method !== "GET");
}

describe("Stack–Pi proposal validation", () => {
  it("accepts the bounded snapshot and adoption proposal shapes", async () => {
    const { validateProposal } = await loadAutomation();

    expect(() => validateProposal(snapshotProposal())).not.toThrow();
    expect(() => validateProposal(adoptionProposal())).not.toThrow();
  });

  it.each([
    ["an unknown envelope field", { ...snapshotProposal(), extra: true }],
    ["a non-object envelope", null],
    ["an unsupported direction", snapshotProposal({ direction: "other" })],
    ["a non-SHA base", snapshotProposal({ baseSha: 42 })],
    ["a snapshot version", snapshotProposal({ version: "1.2.3" })],
    ["an adoption without its published version", adoptionProposal({ version: null })],
    ["an extra file field", snapshotProposal({ files: [{ path: "contract/parity.v2.json", content: "{}", mode: "100644", extra: true }] })],
    ["a traversal path", snapshotProposal({ files: [{ path: "snapshot/../escape.json", content: "{}", mode: "100644" }] })],
    ["a path with a newline", snapshotProposal({ files: [{ path: "snapshot/next\n.json", content: "{}", mode: "100644" }] })],
    ["an executable file", snapshotProposal({ files: [{ path: "contract/parity.v2.json", content: "{}", mode: "100755" }] })],
    ["case-colliding paths", snapshotProposal({ files: [
      { path: "snapshot/Parity.json", content: "{}", mode: "100644" },
      { path: "snapshot/parity.json", content: "{}", mode: "100644" },
    ] })],
    ["a file above the UTF-8 limit", snapshotProposal({ files: [{ path: "contract/parity.v2.json", content: "x".repeat(1024 * 1024 + 1), mode: "100644" }] })],
    ["more than one thousand files", snapshotProposal({ files: Array.from({ length: 1001 }, (_, index) => ({ path: `snapshot/${index}.json`, content: null, mode: "100644" })) })],
    ["an incomplete adoption allowlist", adoptionProposal({ files: [{ path: "src/lib/pi-runtime-pin.json", content: "{}", mode: "100644" }] })],
  ])("rejects %s", async (_label, proposal) => {
    const { validateProposal } = await loadAutomation();

    expect(() => validateProposal(proposal)).toThrow();
  });

  it("rejects a UTF-8 proposal above the total twelve MiB limit", async () => {
    const { validateProposal } = await loadAutomation();
    const content = "x".repeat(1024 * 1024);
    const proposal = snapshotProposal({
      files: Array.from({ length: 13 }, (_, index) => ({
        path: `snapshot/chunk-${index}.json`,
        content,
        mode: "100644",
      })),
    });

    expect(() => validateProposal(proposal)).toThrow();
  });
});

describe("Stack–Pi proposal publication", () => {
  it.each(["closed", "open"] as const)("does not mutate a %s exact branch", async (state) => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ pullPages: [[{ number: 19, state, head: { ref: snapshotBranch } }]] });

    await expect(publishProposal(snapshotProposal(), remote.api)).resolves.toEqual({ status: "existing", number: 19 });
    expect(writeCalls(remote.calls)).toEqual([]);
  });

  it("does not mutate when a human proposal is already open for the direction", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ pullPages: [[{ number: 20, state: "open", head: { ref: "codex/stack-pi-snapshot-manual" } }]] });

    await expect(publishProposal(snapshotProposal(), remote.api)).resolves.toEqual({ status: "blocked", number: 20 });
    expect(writeCalls(remote.calls)).toEqual([]);
  });

  it("does not create a candidate when its exact branch exists without a PR", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ matchingRefs: [{ ref: `refs/heads/${snapshotBranch}` }] });

    await expect(publishProposal(snapshotProposal(), remote.api)).resolves.toEqual({ status: "blocked" });
    expect(writeCalls(remote.calls)).toEqual([]);
  });

  it("pages all PR history before creating the immutable candidate", async () => {
    const { publishProposal } = await loadAutomation();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, state: "closed", head: { ref: `human/${index}` } }));
    const remote = fakeApi({ pullPages: [firstPage, []] });

    await expect(publishProposal(snapshotProposal(), remote.api)).resolves.toEqual({
      status: "ready-pending-checks",
      url: `https://github.com/${snapshotRepository}/pull/71`,
      head: candidateSha,
    });
    expect(remote.calls.filter((call) => call.path.startsWith(`${snapshotRoot}/pulls?`)).map((call) => call.path)).toEqual([
      `${snapshotRoot}/pulls?state=all&per_page=100&page=1`,
      `${snapshotRoot}/pulls?state=all&per_page=100&page=2`,
    ]);
  });

  it("does not create a ref when main moves after the candidate commit", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ mainShas: [proposalBaseSha, "f".repeat(40)] });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain(`${snapshotRoot}/git/refs`);
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain("/graphql");
  });

  it("does not mark a PR ready when main moves after the draft is created", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ mainShas: [proposalBaseSha, proposalBaseSha, "f".repeat(40)] });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).map((call) => call.path)).toContain(`${snapshotRoot}/pulls`);
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain("/graphql");
  });

  it("stops before committing when GitHub returns a different verified tree", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ remoteTreeSha: "f".repeat(40) });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain(`${snapshotRoot}/git/commits`);
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain(`${snapshotRoot}/git/refs`);
    expect(writeCalls(remote.calls).map((call) => call.path)).not.toContain(`${snapshotRoot}/pulls`);
  });

  it("creates a draft, confirms it is ready, and reports checks as pending", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi();

    await expect(publishProposal(snapshotProposal(), remote.api)).resolves.toEqual({
      status: "ready-pending-checks",
      url: `https://github.com/${snapshotRepository}/pull/71`,
      head: candidateSha,
    });
    expect(writeCalls(remote.calls).map((call) => call.path)).toEqual(expect.arrayContaining([
      `${snapshotRoot}/git/trees`,
      `${snapshotRoot}/git/commits`,
      `${snapshotRoot}/git/refs`,
      `${snapshotRoot}/pulls`,
      "/graphql",
    ]));
  });

  it("publishes an adoption only to its Stack repository", async () => {
    const { publishProposal } = await loadAutomation();
    const adoptionRepository = "jorgehn98/jorgex-stack";
    const remote = fakeApi({
      repository: adoptionRepository,
      branch: `codex/stack-pi-adoption-${proposalSourceSha}-v1.2.3`,
    });

    await expect(publishProposal(adoptionProposal(), remote.api)).resolves.toEqual({
      status: "ready-pending-checks",
      url: `https://github.com/${adoptionRepository}/pull/71`,
      head: candidateSha,
    });
  });

  it("does not retry a partial remote write failure", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ failureAt: `POST ${snapshotRoot}/pulls` });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).filter((call) => call.path === `${snapshotRoot}/git/refs`)).toHaveLength(1);
    expect(writeCalls(remote.calls).filter((call) => call.path === `${snapshotRoot}/pulls`)).toHaveLength(1);
    expect(writeCalls(remote.calls).filter((call) => call.path === "/graphql")).toHaveLength(0);
  });

  it("leaves the draft unready when its current node id is unsafe", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ currentPullRequest: {
      state: "open",
      draft: true,
      head: { sha: candidateSha, repo: { full_name: snapshotRepository } },
      base: { sha: proposalBaseSha, ref: "main", repo: { full_name: snapshotRepository } },
      node_id: "unsafe\nnode",
    } });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).filter((call) => call.path === "/graphql")).toHaveLength(0);
  });

  it("does not report ready while GitHub still returns a draft", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ graphqlIsDraft: true });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).filter((call) => call.path === "/graphql")).toHaveLength(1);
  });

  it("does not report ready when the confirmed candidate moved after the transition", async () => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ confirmedPullRequest: {
      state: "open",
      draft: false,
      head: { sha: "f".repeat(40), repo: { full_name: snapshotRepository } },
      base: { sha: proposalBaseSha, ref: "main", repo: { full_name: snapshotRepository } },
      node_id: "PR_kwDOStackPi_1",
    } });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).filter((call) => call.path === "/graphql")).toHaveLength(1);
  });

  it.each([
    ["base", {
      state: "open",
      draft: false,
      head: { sha: candidateSha, repo: { full_name: snapshotRepository } },
      base: { sha: "f".repeat(40), ref: "main", repo: { full_name: snapshotRepository } },
      node_id: "PR_kwDOStackPi_1",
    }],
    ["draft state", {
      state: "open",
      draft: true,
      head: { sha: candidateSha, repo: { full_name: snapshotRepository } },
      base: { sha: proposalBaseSha, ref: "main", repo: { full_name: snapshotRepository } },
      node_id: "PR_kwDOStackPi_1",
    }],
  ])("does not report ready when confirmation has a changed %s", async (_label, confirmedPullRequest) => {
    const { publishProposal } = await loadAutomation();
    const remote = fakeApi({ confirmedPullRequest });

    await expect(publishProposal(snapshotProposal(), remote.api)).rejects.toThrow();
    expect(writeCalls(remote.calls).filter((call) => call.path === "/graphql")).toHaveLength(1);
  });
});

describe("Stack–Pi engram protocol removal idempotency (T70)", () => {
  it("keeps passing the historic engram protocol removal acceptance to the preparer", async () => {
    const automationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "stack-pi-automation.mjs");
    const automationSource = fs.readFileSync(automationPath, "utf8");

    // La automatización posterior a 0.8.29 sigue pasando el flag histórico; una
    // baseline/candidato donde ambas paridades ya omiten engramProtocol debe
    // tratarlo como no-op en el preparador (ver prepare-pi-adoption.test.ts T70).
    expect(automationSource).toContain("acceptEngramProtocolRemoval: true");
  });
});

describe("Stack–Pi coordinator no-op reconciliation (T72/T73)", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "appdata"),
      LOCALAPPDATA: path.join(home, "localappdata"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
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

  function writeJson(root: string, relativePath: string, value: unknown): void {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function initRepo(root: string): void {
    fs.mkdirSync(root, { recursive: true });
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "T72 fixture"]);
    git(root, ["config", "user.email", "t72@example.invalid"]);
  }

  function commitAll(root: string, message: string): string {
    git(root, ["add", "--all"]);
    git(root, ["commit", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
  }

  function pinFixture(version: string, commit: string): Record<string, unknown> {
    return {
      package: { name: "jorgex-pi", version, source: `npm:jorgex-pi@${version}` },
      provenance: { commit },
      tarball: {
        bytes: 16,
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
      },
    };
  }

  it("adoption exact pin identity is noop without preparer, fetch, or writes", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "t72-adoption-noop-"));
    temporaryRoots.push(parent);
    const stackRoot = path.join(parent, "stack");
    const piRoot = path.join(parent, "pi");
    const outputDir = path.join(parent, "output");

    initRepo(piRoot);
    fs.writeFileSync(path.join(piRoot, "package.json"), '{"name":"jorgex-pi"}\n', "utf8");
    const producer = commitAll(piRoot, "pi: 0.8.29");
    git(piRoot, ["tag", "v0.8.29", producer]);
    const tagCommit = git(piRoot, ["rev-parse", "refs/tags/v0.8.29^{commit}"]);

    initRepo(stackRoot);
    writeJson(stackRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current = pinFixture("0.8.29", tagCommit);
    writeJson(stackRoot, "src/lib/pi-runtime-pin.json", current);
    writeJson(stackRoot, "tests/fixtures/pi-runtime-artifacts.json", {
      current,
      previous: pinFixture("0.8.28", "c".repeat(40)),
      archive: { entries: 1, parity: { source: { commit: tagCommit } } },
    });
    commitAll(stackRoot, "stack: pin 0.8.29");
    git(stackRoot, ["checkout", "--detach", "HEAD"]);

    // Fixture reproduce run 35768465981: latest publicado == pin canónico.
    // El no-op correcto no invoca preparer, no hace fetch/npm writes y no
    // deja proposal ni staging.
    expect(git(stackRoot, ["status", "--porcelain"])).toBe("");
    expect(git(stackRoot, ["diff", "--cached", "--name-only"])).toBe("");
    expect(fs.existsSync(path.join(outputDir, "proposal.json"))).toBe(false);

    // T73 GREEN: el coordinator clasifica identidad exacta como noop antes
    // de pending/helper/output/staging/fetch.
    const { classifyAdoptionIdentity } = await loadIdentity();
    expect(classifyAdoptionIdentity({
      version: "0.8.29",
      tagCommit,
      pinVersion: (current.package as { version: string }).version,
      pinCommit: (current.provenance as { commit: string }).commit,
    })).toEqual({ status: "unchanged", version: "0.8.29", sourceSha: tagCommit });
  });

  it("adoption same version with a different tag commit fails closed", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "t72-adoption-mutable-"));
    temporaryRoots.push(parent);
    const stackRoot = path.join(parent, "stack");
    const piRoot = path.join(parent, "pi");

    initRepo(piRoot);
    fs.writeFileSync(path.join(piRoot, "package.json"), '{"name":"jorgex-pi"}\n', "utf8");
    const producer = commitAll(piRoot, "pi: 0.8.29 republished");
    git(piRoot, ["tag", "v0.8.29", producer]);
    const tagCommit = git(piRoot, ["rev-parse", "refs/tags/v0.8.29^{commit}"]);

    // Pin anclado a otro commit con la misma versión: tag mutable.
    const pinnedCommit = "c".repeat(40);

    initRepo(stackRoot);
    writeJson(stackRoot, "package.json", { name: "jorgex-stack", private: true, type: "module" });
    const current = pinFixture("0.8.29", pinnedCommit);
    writeJson(stackRoot, "src/lib/pi-runtime-pin.json", current);
    writeJson(stackRoot, "tests/fixtures/pi-runtime-artifacts.json", {
      current,
      previous: pinFixture("0.8.28", "d".repeat(40)),
      archive: { entries: 1, parity: { source: { commit: pinnedCommit } } },
    });
    commitAll(stackRoot, "stack: pin 0.8.29 pinned");
    git(stackRoot, ["checkout", "--detach", "HEAD"]);

    // T73 GREEN: misma versión con distinto commit no es noop en el
    // coordinator; falla cerrado sin fetch ni writes.
    const { classifyAdoptionIdentity } = await loadIdentity();
    expect(() => classifyAdoptionIdentity({
      version: "0.8.29",
      tagCommit,
      pinVersion: (current.package as { version: string }).version,
      pinCommit: (current.provenance as { commit: string }).commit,
    })).toThrow(/provenance|commit|mutable|tag/i);
    expect(git(stackRoot, ["status", "--porcelain"])).toBe("");
    expect(git(stackRoot, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("snapshot preserves parity identity when stack/ has no diff and never regresses to an ancestor last-touch", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "t72-snapshot-noop-"));
    temporaryRoots.push(parent);
    const stackRoot = path.join(parent, "stack");
    const outputDir = path.join(parent, "output");

    initRepo(stackRoot);
    fs.mkdirSync(path.join(stackRoot, "stack", "agents"), { recursive: true });
    fs.writeFileSync(path.join(stackRoot, "stack", "agents", "tester.md"), "canon v1\n", "utf8");
    const lastTouch = commitAll(stackRoot, "stack: canonical source");
    fs.mkdirSync(path.join(stackRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(stackRoot, "docs", "note.md"), "non-canonical bump\n", "utf8");
    const parityCommit = commitAll(stackRoot, "release: bump without stack/ change");
    git(stackRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // Reproduce run 35768465981: parity a140809 es más nuevo que el último
    // commit que tocó stack/ (f989, ancestro); sin diff canónico posterior.
    const coordinatorLastTouch = git(stackRoot, ["log", "--first-parent", "-1", "--format=%H", "origin/main", "--", "stack/"]);
    expect(coordinatorLastTouch).toBe(lastTouch);
    expect(parityCommit).not.toBe(coordinatorLastTouch);
    expect(git(stackRoot, ["merge-base", "--is-ancestor", coordinatorLastTouch, parityCommit])).toBe("");
    expect(git(stackRoot, ["diff", "--name-only", `${parityCommit}..origin/main`, "--", "stack/"])).toBe("");

    // Ausencia de writes del no-op correcto.
    expect(git(stackRoot, ["status", "--porcelain"])).toBe("");
    expect(git(stackRoot, ["diff", "--cached", "--name-only"])).toBe("");
    expect(fs.existsSync(path.join(outputDir, "proposal.json"))).toBe(false);

    // T73 GREEN: el coordinator conserva la identidad parity y devuelve noop
    // en vez de retroceder al ancestro last-touch.
    const stackDiff = git(stackRoot, ["diff", "--name-only", `${parityCommit}..origin/main`, "--", "stack/"]);
    expect(stackDiff).toBe("");
    const { classifySnapshotIdentity } = await loadIdentity();
    expect(classifySnapshotIdentity({ parityCommit, stackDiff, lastTouch: coordinatorLastTouch })).toEqual({
      status: "unchanged",
      sourceSha: parityCommit,
    });
  });

  it("snapshot with a later canonical stack/ change selects a descendant source and invokes the preparer", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "t72-snapshot-change-"));
    temporaryRoots.push(parent);
    const stackRoot = path.join(parent, "stack");

    initRepo(stackRoot);
    fs.mkdirSync(path.join(stackRoot, "stack", "agents"), { recursive: true });
    fs.writeFileSync(path.join(stackRoot, "stack", "agents", "tester.md"), "canon v1\n", "utf8");
    commitAll(stackRoot, "stack: canonical source");
    fs.mkdirSync(path.join(stackRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(stackRoot, "docs", "note.md"), "non-canonical bump\n", "utf8");
    const parityCommit = commitAll(stackRoot, "release: bump without stack/ change");
    fs.writeFileSync(path.join(stackRoot, "stack", "agents", "tester.md"), "canon v2\n", "utf8");
    const canonicalHead = commitAll(stackRoot, "stack: later canonical change");
    git(stackRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // Caso control: sí hay cambio canónico posterior, el coordinator debe
    // avanzar a un source descendiente y llamar al preparer normalmente.
    const diff = git(stackRoot, ["diff", "--name-only", `${parityCommit}..origin/main`, "--", "stack/"]);
    expect(diff).toContain("stack/agents/tester.md");
    expect(git(stackRoot, ["merge-base", "--is-ancestor", parityCommit, canonicalHead])).toBe("");
    const selectedSource = git(stackRoot, ["log", "--first-parent", "-1", "--format=%H", "origin/main", "--", "stack/"]);
    expect(selectedSource).toBe(canonicalHead);
    expect(selectedSource).not.toBe(parityCommit);

    const { classifySnapshotIdentity } = await loadIdentity();
    expect(classifySnapshotIdentity({ parityCommit, stackDiff: diff, lastTouch: selectedSource })).toEqual({
      status: "proceed",
      sourceSha: canonicalHead,
    });
  });
});
