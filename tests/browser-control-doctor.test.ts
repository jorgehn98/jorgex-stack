import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
} from "./helpers/bounded-process.js";
import { writeOpenCodeBinary } from "./helpers/opencode-binary.js";
import {
  createOwnedVerificationHome,
  removeTemporaryRoots,
  resolveVerificationDiskBase,
} from "./helpers/pnpm-tooling.js";
import type { StageVerifiedBrowserTreeResult } from "../src/lib/browser-stage.js";
import type {
  BrowserControlReady,
  BrowserControlUnavailable,
} from "../src/lib/browser-control-runtime.js";

/**
 * T13 doctor boundary (Spec 12/13, SC-06): the offline doctor must separate the
 * authenticated operational active from a retained verified candidate. Seeded
 * with the real activation pipeline on a private HOME, the doctor is expected to
 * report both versions and never present the candidate as the active/usable
 * release, without acquiring the provider, probing the relay or mutating state.
 * A retained candidate coincident with the active (same version AND same
 * whole-root SRI) is not a release awaiting promotion, so it must not inherit the
 * pending-activation remedy either.
 *
 * Boundary doubles are deliberately narrow: only `probeBrowserControlRelay` is
 * spied (the cached inspector under test stays real) and `fetch` is poisoned.
 * `node:crypto`, `browserTreeSha256`, `activateManagedBrowserTree` and
 * `loadVerifiedManagedBrowserReceipt` all run real.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BC_PACKAGE = "@opencode-ai/browser-control";
const BROWSER_CONTROL_SERVER = "browser-control";

const ACTIVE_VERSION = "9.9.40";
const CANDIDATE_VERSION = "9.9.41";

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

const probe = vi.hoisted(() => ({ calls: 0 }));
const network = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@clack/prompts", () => ({
  intro: prompts.intro,
  outro: prompts.outro,
  log: prompts.log,
}));

vi.mock("../src/lib/browser-control-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/browser-control-runtime.js")>();
  return {
    ...actual,
    probeBrowserControlRelay: async () => {
      probe.calls += 1;
      throw new Error("browser-control-doctor: the offline doctor must not probe the relay");
    },
  };
});

function loggedLines(): string[] {
  return [
    prompts.log.info,
    prompts.log.warn,
    prompts.log.error,
    prompts.log.success,
    prompts.log.message,
  ].flatMap((group) => group.mock.calls.map((call) => String(call[0])));
}

/** Warn/error output only: a healthy projection never lands here. */
function problemLines(): string[] {
  return [prompts.log.warn, prompts.log.error].flatMap((group) =>
    group.mock.calls.map((call) => String(call[0])),
  );
}

interface ReleaseFixture {
  readonly version: string;
  readonly integrity: string;
  readonly tarballUrl: string;
}

function makeRelease(version: string): ReleaseFixture {
  const rootBytes = Buffer.from(`doctor-browser-control-root-${version}\n`);
  return {
    version,
    integrity: `sha512-${createHash("sha512").update(rootBytes).digest("base64")}`,
    tarballUrl: `https://registry.npmjs.org/@opencode-ai/browser-control/-/browser-control-${version}.tgz`,
  };
}

const ACTIVE_RELEASE = makeRelease(ACTIVE_VERSION);
const CANDIDATE_RELEASE = makeRelease(CANDIDATE_VERSION);
// The post-promotion state: the retained candidate is the very release already
// active, coincident in version AND whole-root SRI.
const COINCIDENT_RELEASE = makeRelease(ACTIVE_VERSION);

interface Witness {
  readonly stageDir: string;
  readonly nodeModulesPath: string;
  readonly treePath: string;
  readonly entryPath: string;
}

/** Real on-disk package tree: metadata, declared bin and the official skill. */
function writeWitnessTree(root: string, release: ReleaseFixture): Witness {
  const stageDir = path.join(root, `doctor-witness-${release.version}`);
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treePath = path.join(nodeModulesPath, "@opencode-ai", "browser-control");
  const entryPath = path.join(treePath, "dist", "cli.js");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(treePath, "package.json"),
    `${JSON.stringify(
      {
        name: BC_PACKAGE,
        version: release.version,
        bin: { [BROWSER_CONTROL_SERVER]: "dist/cli.js" },
        engines: { node: ">=22.19.0" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, Buffer.from(`doctor-browser-control-entry-${release.version}\n`));
  const skillPath = path.join(treePath, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    skillPath,
    ["---", "name: browser-control", `description: doctor fixture ${release.version}`, "---", ""].join("\n"),
  );
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

/** Publishes a verified managed receipt through the real activation pipeline. */
async function seedVerifiedReceipt(stateDir: string, release: ReleaseFixture, root: string): Promise<void> {
  const witness = writeWitnessTree(root, release);
  const stage = await import("../src/lib/browser-stage.js");
  const staged: StageVerifiedBrowserTreeResult = {
    treePath: witness.treePath,
    nodeModulesPath: witness.nodeModulesPath,
    treeSha256: stage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
    closure: [{ name: BC_PACKAGE, version: release.version, integrity: release.integrity }],
  };
  const { activateManagedBrowserTree } = await import("../src/lib/browser-managed.js");
  await activateManagedBrowserTree({
    stateDir,
    packageName: BC_PACKAGE,
    release: { version: release.version, tarballUrl: release.tarballUrl, integrity: release.integrity },
    staged,
    entryPath: witness.entryPath,
  });
}

const ISOLATED_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PATH",
  "OPENCODE_CONFIG_DIR",
  "ENGRAM_BIN",
  "BROWSER_CONTROL_PORT",
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
  probe.calls = 0;
  network.calls.length = 0;
});

/** Identity of a managed receipt that is observable without exposing raw shas. */
interface ReceiptFingerprint {
  readonly present: boolean;
  readonly version: string | null;
  readonly integrity: string | null;
}

interface OfflineDoctorRun {
  readonly lines: string[];
  readonly text: string;
  readonly problems: string[];
  readonly activeBefore: ReceiptFingerprint;
  readonly activeAfter: ReceiptFingerprint;
  readonly candidateBefore: ReceiptFingerprint;
  readonly candidateAfter: ReceiptFingerprint;
}

function receiptFingerprint(
  receipt: { readonly version: string; readonly integrity: string } | null,
): ReceiptFingerprint {
  return receipt === null
    ? { present: false, version: null, integrity: null }
    : { present: true, version: receipt.version, integrity: receipt.integrity };
}

/**
 * Estado de la proyección nativa obligatoria (skill oficial + MCP) dentro del
 * configDir OpenCode. `canonical` es el control: debe diagnosticarse sano.
 */
type ProjectionState = "missing" | "modified" | "canonical";

/**
 * Proyecta la skill oficial y el MCP `browser-control` en el configDir. Solo se
 * usa tras sembrar el active real; la invocación esperada se obtiene del lector
 * cacheado real, no se inventa. `missing` no escribe nada; `modified` desvía
 * ambos bytes y comando; `canonical` reproduce exactamente lo que proyectaría
 * install (skill byte-identical + `{ type: local, command: [command, ...args] }`).
 */
function seedProjection(
  configDir: string,
  stateDir: string,
  inspectActive: (stateDir: string) => BrowserControlReady | BrowserControlUnavailable,
  kind: ProjectionState,
): void {
  if (kind === "missing") return;
  const active = inspectActive(stateDir);
  if (active.kind !== "ready") {
    throw new Error(`fixture: el active debe estar ready para sembrar la proyección (${active.kind})`);
  }
  const skillTarget = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true, mode: 0o700 });
  const mcpFile = path.join(configDir, "opencode.json");
  if (kind === "canonical") {
    fs.copyFileSync(active.skillSource, skillTarget);
    fs.writeFileSync(
      mcpFile,
      `${JSON.stringify(
        {
          mcp: {
            servers: {
              [BROWSER_CONTROL_SERVER]: {
                type: "local",
                command: [active.invocation.command, ...active.invocation.args],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  fs.writeFileSync(
    skillTarget,
    "<!-- skill desviada: no son los bytes de la release activa -->\n",
  );
  fs.writeFileSync(
    mcpFile,
    `${JSON.stringify(
      {
        mcp: {
          servers: {
            [BROWSER_CONTROL_SERVER]: {
              type: "local",
              command: ["/drifted/browser-control", "mcp"],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Boots a private HOME, seeds the given verified receipts through the real
 * activation pipeline, poisons fetch, runs the offline doctor and returns the
 * captured output plus the receipt fingerprints before and after the run. Probe
 * and network counters stay at module scope; each test asserts them once the
 * helper resolves, so a failure below can only be missing doctor behavior.
 */
async function runOfflineDoctor(options: {
  readonly activeRelease: ReleaseFixture;
  readonly candidateRelease: ReleaseFixture;
  readonly prefix: string;
  readonly projection?: ProjectionState;
}): Promise<OfflineDoctorRun> {
  const ownedRoots: string[] = [];
  const releaseRoots = registerOwnedResourceCleanup("browser-control-doctor-roots", () =>
    removeTemporaryRoots(ownedRoots),
  );
  const savedEnv = new Map<string, string | undefined>();
  try {
    const base = resolveVerificationDiskBase({
      repoRoot: REPO_ROOT,
      env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
    });
    const owned = createOwnedVerificationHome({
      base,
      // Neutral prefix: the fixture path must never spell "browser control",
      // so the section assertion only ever matches the doctor's own output.
      prefix: options.prefix,
      register: (root) => ownedRoots.push(root),
    });

    const binDir = path.join(owned.root, "bin");
    writeOpenCodeBinary(binDir, { output: "opencode v2.0.20" });
    const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

    for (const key of ISOLATED_KEYS) savedEnv.set(key, process.env[key]);
    for (const [key, value] of Object.entries(owned.env)) process.env[key] = value;
    process.env.PATH = binDir;
    process.env.OPENCODE_CONFIG_DIR = configDir;
    // Ambient port is deliberately invalid: even a stray probe cannot reach a
    // real relay or fall back to 19989.
    process.env.BROWSER_CONTROL_PORT = "not-a-port";
    delete process.env.ENGRAM_BIN;

    vi.resetModules();
    const { dataDir } = await import("../src/lib/paths.js");
    const { browserControlCandidateDir, inspectCachedBrowserControlRuntime } = await import(
      "../src/lib/browser-control-runtime.js"
    );
    const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

    const stateDir = dataDir();
    const candidateDir = browserControlCandidateDir(stateDir);
    await seedVerifiedReceipt(stateDir, options.activeRelease, owned.root);
    await seedVerifiedReceipt(candidateDir, options.candidateRelease, owned.root);
    seedProjection(configDir, stateDir, inspectCachedBrowserControlRuntime, options.projection ?? "missing");

    const activeBefore = receiptFingerprint(loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE));
    const candidateBefore = receiptFingerprint(
      loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE),
    );

    // Poisoned network: any provider acquisition fails closed and is counted.
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      network.calls.push(String(input));
      throw new Error(`browser-control-doctor: unexpected network call ${String(input)}`);
    });

    const doctor = await import("../src/doctor.js");
    await doctor.runDoctor({ runtimes: ["opencode"] });

    const lines = loggedLines();
    return {
      lines,
      text: lines.join("\n"),
      problems: problemLines(),
      activeBefore,
      activeAfter: receiptFingerprint(loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE)),
      candidateBefore,
      candidateAfter: receiptFingerprint(
        loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE),
      ),
    };
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
    cleanupOwnedResourcesOrThrow();
    releaseRoots();
  }
}

describe("doctor: Browser Control active/candidate separation (T13)", () => {
  it("reports active A and retained candidate B distinctly without network, relay probe or mutation", async () => {
    const run = await runOfflineDoctor({
      activeRelease: ACTIVE_RELEASE,
      candidateRelease: CANDIDATE_RELEASE,
      prefix: ".jorgex-doctor-t13-",
    });

    // Setup guard: both real verified receipts exist before the doctor runs,
    // so a failure below can only be missing doctor behavior, never a bad
    // fixture. The active namespace must hold A, not the candidate B.
    expect(run.activeBefore).toEqual({
      present: true,
      version: ACTIVE_VERSION,
      integrity: ACTIVE_RELEASE.integrity,
    });
    expect(run.candidateBefore).toEqual({
      present: true,
      version: CANDIDATE_VERSION,
      integrity: CANDIDATE_RELEASE.integrity,
    });

    // Offline contract: no acquisition and no relay probe.
    expect(network.calls, "the doctor must not fetch the provider").toEqual([]);
    expect(probe.calls, "the doctor must not probe the relay").toBe(0);

    // Section and both versions must be observable.
    expect(run.text, `doctor output must include a Browser Control section:\n${run.text}`).toMatch(
      /browser.?control/i,
    );
    expect(run.text, "the active version must be reported").toContain(ACTIVE_VERSION);
    expect(run.text, "the retained candidate version must be reported").toContain(CANDIDATE_VERSION);

    // Role separation: A is the active, B is candidate/pending. A bug that
    // advertises B as the usable release cannot satisfy both finds.
    const bcLines = run.lines.filter((line) => /browser.?control/i.test(line));
    const activeLine = bcLines.find(
      (line) => line.includes(ACTIVE_VERSION) && /activ/i.test(line),
    );
    const candidateLine = bcLines.find(
      (line) => line.includes(CANDIDATE_VERSION) && /candidat|pendient/i.test(line),
    );
    expect(
      activeLine,
      `the active ${ACTIVE_VERSION} must be reported as active:\n${bcLines.join("\n")}`,
    ).toBeDefined();
    expect(
      candidateLine,
      `the retained ${CANDIDATE_VERSION} must be reported as candidate/pending:\n${bcLines.join("\n")}`,
    ).toBeDefined();

    // Read-only: neither namespace is mutated by the diagnostic.
    expect(run.activeAfter).toEqual(run.activeBefore);
    expect(run.candidateAfter).toEqual(run.candidateBefore);
  });

  it("does not report a retained candidate coincident with the active as pending activation", async () => {
    const run = await runOfflineDoctor({
      activeRelease: COINCIDENT_RELEASE,
      candidateRelease: COINCIDENT_RELEASE,
      prefix: ".jorgex-doctor-t13-coincident-",
    });

    // Setup guard: the retained candidate is identity-coincident with the
    // active, not merely the same version: both the version and the whole-root
    // SRI derived from the real fixture bytes must match.
    expect(run.activeBefore).toEqual({
      present: true,
      version: ACTIVE_VERSION,
      integrity: COINCIDENT_RELEASE.integrity,
    });
    expect(run.candidateBefore.present).toBe(true);
    expect(run.candidateBefore.version).toBe(run.activeBefore.version);
    expect(run.candidateBefore.integrity).toBe(run.activeBefore.integrity);

    // Offline contract: no acquisition and no relay probe.
    expect(network.calls, "the doctor must not fetch the provider").toEqual([]);
    expect(probe.calls, "the doctor must not probe the relay").toBe(0);

    // The section, the active role and the candidate role must all survive: a
    // fix that hides the coincident candidate would lose its identity.
    expect(run.text, `doctor output must include a Browser Control section:\n${run.text}`).toMatch(
      /browser.?control/i,
    );
    const bcLines = run.lines.filter((line) => /browser.?control/i.test(line));
    const activeLine = bcLines.find(
      (line) =>
        line.includes(ACTIVE_VERSION) && /\bactive\b/i.test(line) && !/candidat/i.test(line),
    );
    const candidateLine = bcLines.find(
      (line) => line.includes(ACTIVE_VERSION) && /candidat/i.test(line),
    );
    expect(
      activeLine,
      `the active ${ACTIVE_VERSION} must be reported as active:\n${bcLines.join("\n")}`,
    ).toBeDefined();
    expect(
      candidateLine,
      `the coincident retained ${ACTIVE_VERSION} must still be reported as candidate:\n${bcLines.join("\n")}`,
    ).toBeDefined();

    // A candidate coincident with the active is not awaiting activation and
    // must not carry the retained-candidate remedy (stop the relay / promote).
    expect(
      run.text,
      `a candidate coincident with the active must not be reported as pending activation:\n${run.text}`,
    ).not.toMatch(/pendiente de activaci[oó]n/i);
    expect(
      candidateLine ?? "",
      `a candidate coincident with the active must not instruct to stop the relay or promote:\n${bcLines.join("\n")}`,
    ).not.toMatch(/coordina la parada|parada del relay|debe promoverse/i);

    // Read-only: neither namespace is mutated by the diagnostic.
    expect(run.activeAfter).toEqual(run.activeBefore);
    expect(run.candidateAfter).toEqual(run.candidateBefore);
  });
});

describe("doctor: Browser Control projected native skill/MCP integrity (T13)", () => {
  it.each([
    { state: "missing" as const, label: "missing" },
    { state: "modified" as const, label: "drifted" },
  ])(
    "diagnoses a $label projected skill/MCP instead of declaring the active projection healthy",
    async ({ state }) => {
      const run = await runOfflineDoctor({
        activeRelease: ACTIVE_RELEASE,
        candidateRelease: CANDIDATE_RELEASE,
        prefix: `.jorgex-doctor-projection-${state}-`,
        projection: state,
      });

      // Setup guard: the cached authenticated active A really exists, so a
      // failure below is missing doctor behavior, not a bad fixture.
      expect(run.activeBefore).toEqual({
        present: true,
        version: ACTIVE_VERSION,
        integrity: ACTIVE_RELEASE.integrity,
      });

      // Offline contract: no acquisition and no relay probe.
      expect(network.calls, "the doctor must not fetch the provider").toEqual([]);
      expect(probe.calls, "the doctor must not probe the relay").toBe(0);

      // Honest layer evidence: the authenticated active is still reported...
      expect(run.text, "the active version must be reported").toContain(ACTIVE_VERSION);

      // ...but the mandatory projected native skill/MCP are absent/drifted, so
      // the doctor must diagnose the projection at its own layer rather than
      // declaring the active healthy "with its managed projection".
      const browserControlProblems = run.problems.filter((line) => /browser.?control/i.test(line));
      expect(
        browserControlProblems,
        `the doctor must diagnose the ${state} projected browser-control skill/MCP at the browser-control layer:\n${run.text}`,
      ).not.toEqual([]);
      expect(
        run.text,
        `the doctor must not claim the managed projection is healthy while it is ${state}:\n${run.text}`,
      ).not.toMatch(/verificado con su proyección gestionada/i);

      // Read-only: neither namespace is mutated by the diagnostic.
      expect(run.activeAfter).toEqual(run.activeBefore);
      expect(run.candidateAfter).toEqual(run.candidateBefore);
    },
  );

  it("does not report a browser-control projection problem when the native skill and MCP are canonical", async () => {
    const run = await runOfflineDoctor({
      activeRelease: ACTIVE_RELEASE,
      candidateRelease: CANDIDATE_RELEASE,
      prefix: ".jorgex-doctor-projection-canonical-",
      projection: "canonical",
    });

    // Setup guard: the active exists and the projection was seeded from it.
    expect(run.activeBefore.present).toBe(true);
    expect(network.calls, "the doctor must not fetch the provider").toEqual([]);
    expect(probe.calls, "the doctor must not probe the relay").toBe(0);

    // Control: a canonical projection must not be flagged as a problem, so the
    // fix cannot pass by always warning.
    const browserControlProblems = run.problems.filter((line) => /browser.?control/i.test(line));
    expect(
      browserControlProblems,
      `a canonical projected skill/MCP must not be reported as a problem:\n${run.text}`,
    ).toEqual([]);

    expect(run.activeAfter).toEqual(run.activeBefore);
  });
});
