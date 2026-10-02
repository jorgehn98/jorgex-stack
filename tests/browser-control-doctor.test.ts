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

/**
 * T13 doctor boundary (Spec 12/13, SC-06): the offline doctor must separate the
 * authenticated operational active from a retained verified candidate. Seeded
 * with the real activation pipeline on a private HOME, the doctor is expected to
 * report both versions and never present the candidate as the active/usable
 * release, without acquiring the provider, probing the relay or mutating state.
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

describe("doctor: Browser Control active/candidate separation (T13)", () => {
  it("reports active A and retained candidate B distinctly without network, relay probe or mutation", async () => {
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
        prefix: ".jorgex-doctor-t13-",
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
      const { browserControlCandidateDir } = await import("../src/lib/browser-control-runtime.js");
      const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

      const stateDir = dataDir();
      const candidateDir = browserControlCandidateDir(stateDir);
      await seedVerifiedReceipt(stateDir, ACTIVE_RELEASE, owned.root);
      await seedVerifiedReceipt(candidateDir, CANDIDATE_RELEASE, owned.root);

      // Setup guard: both real verified receipts exist before the doctor runs,
      // so a failure below can only be missing doctor behavior, never a bad
      // fixture. The active namespace must hold A, not the candidate B.
      expect(loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE)?.version).toBe(ACTIVE_VERSION);
      expect(loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE)?.version).toBe(
        CANDIDATE_VERSION,
      );

      // Poisoned network: any provider acquisition fails closed and is counted.
      vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        network.calls.push(String(input));
        throw new Error(`browser-control-doctor: unexpected network call ${String(input)}`);
      });

      const doctor = await import("../src/doctor.js");
      await doctor.runDoctor({ runtimes: ["opencode"] });

      const lines = loggedLines();
      const text = lines.join("\n");

      // Offline contract: no acquisition and no relay probe.
      expect(network.calls, "the doctor must not fetch the provider").toEqual([]);
      expect(probe.calls, "the doctor must not probe the relay").toBe(0);

      // Section and both versions must be observable.
      expect(text, `doctor output must include a Browser Control section:\n${text}`).toMatch(
        /browser.?control/i,
      );
      expect(text, "the active version must be reported").toContain(ACTIVE_VERSION);
      expect(text, "the retained candidate version must be reported").toContain(CANDIDATE_VERSION);

      // Role separation: A is the active, B is candidate/pending. A bug that
      // advertises B as the usable release cannot satisfy both finds.
      const bcLines = lines.filter((line) => /browser.?control/i.test(line));
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
      expect(loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE)?.version).toBe(ACTIVE_VERSION);
      expect(loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE)?.version).toBe(
        CANDIDATE_VERSION,
      );
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
  });
});
