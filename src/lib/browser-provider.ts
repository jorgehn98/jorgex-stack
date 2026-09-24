import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planDetectedBinCommand } from "./detect.js";
import {
  downloadVerifiedNpmPackageTarball,
  resolveLatestNpmPackageRelease,
  type NpmPackageRelease,
} from "./npm-provider.js";

export interface BrowserPackageRelease {
  version: string;
  tarballUrl: string;
  integrity: string;
}

export interface BrowserReleaseSmokeContext {
  packageName: string;
  release: BrowserPackageRelease;
  artifactPath: string;
  stageDir: string;
}

export interface PrepareVerifiedBrowserReleaseOptions {
  fetchImpl: typeof fetch;
  stageParent?: string;
  /**
   * Optional post-verification hook, invoked with the private stage still
   * alive after the SRI download succeeds and before stage cleanup. Lets a
   * high-level installer wire artifact smoke checks (e.g. the DevTools CLI
   * privacy-flag proof) without changing this shared acquisition.
   */
  smoke?: (context: BrowserReleaseSmokeContext) => void | Promise<void>;
}

const PLAYWRIGHT_PKG = "@playwright/cli";
const DEVTOOLS_PKG = "chrome-devtools-mcp";

function fail(message: string): never {
  throw new Error(`browser-provider: ${message}`);
}

function asBrowserError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("browser-provider: ")) return error;
  if (error instanceof Error) {
    const detail = error.message.startsWith("npm-provider: ")
      ? error.message.slice("npm-provider: ".length)
      : error.message;
    return new Error(`browser-provider: ${detail}`);
  }
  return new Error(`browser-provider: ${String(error)}`);
}

function assertBrowserPackage(packageName: unknown): asserts packageName is typeof PLAYWRIGHT_PKG | typeof DEVTOOLS_PKG {
  if (packageName !== PLAYWRIGHT_PKG && packageName !== DEVTOOLS_PKG) {
    fail("unknown browser package");
  }
}

function resolveStageParent(stageParent: unknown): string {
  if (stageParent === undefined) return os.tmpdir();
  if (typeof stageParent !== "string" || stageParent === "" || !path.isAbsolute(stageParent)) {
    fail("invalid stage parent");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(stageParent);
  } catch {
    fail("invalid stage parent");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid stage parent");
  return stageParent;
}

/**
 * Shared verified acquisition for browser opt-ins (`@playwright/cli` and
 * `chrome-devtools-mcp`). Resolves the exact stable `dist-tags.latest`
 * candidate via the generic npm provider, then verifies the tarball SRI in
 * a unique private stage under the provided real absolute parent (default
 * `os.tmpdir()`). Returns only the observed `{ version, tarballUrl,
 * integrity }` after verified bytes; the stage is always removed. An optional
 * smoke hook may execute the verified package inside that private stage.
 */
export async function prepareVerifiedBrowserRelease(
  packageName: string,
  options: PrepareVerifiedBrowserReleaseOptions,
): Promise<BrowserPackageRelease> {
  assertBrowserPackage(packageName);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid options");
  }
  const { fetchImpl, stageParent, smoke } = options as PrepareVerifiedBrowserReleaseOptions;
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (smoke !== undefined && typeof smoke !== "function") fail("smoke must be a function");
  const parent = resolveStageParent(stageParent);

  let stageDir: string | null = null;
  try {
    try {
      stageDir = fs.mkdtempSync(path.join(parent, "jorgex-browser-"));
    } catch (error) {
      throw asBrowserError(error);
    }
    try {
      fs.chmodSync(stageDir, 0o700);
    } catch {
      // Best effort; mkdtemp already creates a private directory.
    }

    let release: NpmPackageRelease;
    try {
      release = await resolveLatestNpmPackageRelease(packageName, fetchImpl as typeof fetch);
    } catch (error) {
      throw asBrowserError(error);
    }
    const artifactPath = path.join(stageDir, "browser-package.tgz");
    try {
      await downloadVerifiedNpmPackageTarball(
        packageName,
        release,
        artifactPath,
        fetchImpl as typeof fetch,
      );
    } catch (error) {
      throw asBrowserError(error);
    }
    if (smoke !== undefined) {
      try {
        await smoke({ packageName, release, artifactPath, stageDir });
      } catch (error) {
        throw asBrowserError(error);
      }
    }
    return { version: release.version, tarballUrl: release.tarballUrl, integrity: release.integrity };
  } catch (error) {
    throw asBrowserError(error);
  } finally {
    if (stageDir !== null) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the destination was never published outside the stage.
      }
    }
  }
}

/**
 * T15 artifact seam: SRI alone cannot prove a future DevTools CLI still
 * accepts the four mandatory privacy flags. This helper installs the exact
 * local tarball isolated (`pnpm add --ignore-scripts <tarball>`) inside a
 * validated private stage, then invokes its declared CLI entry with fixed
 * flags plus `--help` and probes the package's argument parser directly to
 * prove their effects — without launching Chrome or a browser profile. Child
 * calls use a sanitized stage-scoped env (no ambient HOME or credentials).
 * Unit tests inject `run`, so the external package is never executed there.
 */
export const DEVTOOLS_PRIVACY_FLAGS: readonly string[] = [
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
];

const DEVTOOLS_BIN_NAME = "chrome-devtools-mcp";
const MAX_HELP_STDOUT_BYTES = 64 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEVTOOLS_PARSER_PROBE = `
import { pathToFileURL } from "node:url";
const { parseArguments } = await import(pathToFileURL(process.argv[1]).href);
if (typeof parseArguments !== "function") process.exit(1);
const parsed = parseArguments("probe", [
  process.execPath, process.argv[1],
  "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"
], process.env);
process.stdout.write(JSON.stringify([
  parsed.isolated, parsed.redactNetworkHeaders, parsed.performanceCrux, parsed.usageStatistics
]));
`;

export interface DevtoolsCliRunResult {
  status: number;
  stdout: string;
}

export type DevtoolsCliRun = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<DevtoolsCliRunResult>;

export interface VerifyDevtoolsCliArtifactInput {
  artifactPath: string;
  stageDir: string;
  pnpmBin: string;
  release: NpmPackageRelease;
}

export interface VerifyDevtoolsCliArtifactDeps {
  run?: DevtoolsCliRun;
}

export interface VerifiedDevtoolsCliArtifact {
  binPath: string;
  version: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertInsideStage(realStage: string, candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (resolved !== realStage && !resolved.startsWith(realStage + path.sep)) {
    fail(`${label} escapes the stage`);
  }
  return resolved;
}

/**
 * Default process runner: direct argv without `shell: true`. On Windows a
 * `.cmd`/`.bat` shim cannot run directly, so it goes through cmd.exe with
 * validated literal parts via the shared planner (null on metacharacters =
 * fail closed). Injected doubles always receive the raw `pnpmBin` untouched.
 */
async function defaultDevtoolsCliRun(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<DevtoolsCliRunResult> {
  const planned = planDetectedBinCommand(command, args);
  if (planned === null) throw new Error("devtools runner refused an unsafe windows command");
  const result = spawnSync(planned.command, planned.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: DEFAULT_RUN_TIMEOUT_MS,
    maxBuffer: MAX_HELP_STDOUT_BYTES + 1024,
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error("devtools runner terminated by signal");
  return { status: result.status, stdout: result.stdout };
}

/**
 * Build the restricted child env from scratch: every directory-backed key
 * points inside the stage, PATH carries only the stage bin, and CI plus the
 * update notifier are disabled. Nothing is inherited from `process.env`, so
 * no ambient marker, secret, HOME, or browser profile can leak through.
 */
function restrictedStageEnv(stageDir: string): NodeJS.ProcessEnv {
  const home = path.join(stageDir, "home");
  const config = path.join(stageDir, "config");
  const cache = path.join(stageDir, "cache");
  const tmp = path.join(stageDir, "tmp");
  const bin = path.join(stageDir, "bin");
  for (const dir of [home, config, cache, tmp, bin, path.join(stageDir, "pnpm-home")]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      fail("cannot prepare the stage env");
    }
  }
  // The stage `.bin` shims start with `#!/usr/bin/env node`, so a stage-only
  // PATH must resolve node inside the stage. A symlink to the running
  // interpreter (same approach as virtualenvs) keeps PATH fully
  // stage-bounded; its realpath escapes by design but it only re-exposes the
  // current runtime under the restricted env. Best effort: without it the
  // spawn fails closed with a clear error.
  try {
    const nodeLink = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
    if (fs.lstatSync(nodeLink, { throwIfNoEntry: false }) === undefined) {
      fs.symlinkSync(process.execPath, nodeLink);
    }
  } catch {
    // Best effort; the help probe fails closed if node stays unresolvable.
  }
  return {
    HOME: home,
    USERPROFILE: home,
    PNPM_HOME: path.join(stageDir, "pnpm-home"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(stageDir, "local-share"),
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: path.join(stageDir, "state"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    PATH: bin,
    CI: "true",
    NO_UPDATE_NOTIFIER: "1",
  };
}

async function runDevtoolsCli(
  run: DevtoolsCliRun,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<DevtoolsCliRunResult> {
  try {
    return await run(command, args, { cwd, env });
  } catch (error) {
    throw asBrowserError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Install the exact local DevTools tarball isolated and prove the mandatory
 * privacy flags via `--help`. Fails closed (without config writes outside
 * the stage) on a non-regular artifact, an escaping stage, a manifest
 * name/version mismatch against the provided release, a missing or escaping
 * stage-local bin, a nonzero help status, an over-bound or flag-incomplete
 * help output, an incompatible parser, or any spawn failure.
 */
export async function verifyDevtoolsCliArtifact(
  input: VerifyDevtoolsCliArtifactInput,
  deps?: VerifyDevtoolsCliArtifactDeps,
): Promise<VerifiedDevtoolsCliArtifact> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid artifact input");
  }
  const { artifactPath, stageDir, pnpmBin, release } = input;
  if (typeof artifactPath !== "string" || artifactPath === "" || !path.isAbsolute(artifactPath)) {
    fail("invalid artifact path");
  }
  let artifactStat: fs.Stats;
  try {
    artifactStat = fs.lstatSync(artifactPath);
  } catch {
    fail("invalid artifact path");
  }
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) fail("invalid artifact path");
  if (typeof stageDir !== "string" || stageDir === "" || !path.isAbsolute(stageDir)) {
    fail("invalid stage directory");
  }
  let stageStat: fs.Stats;
  try {
    stageStat = fs.lstatSync(stageDir);
  } catch {
    fail("invalid stage directory");
  }
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail("invalid stage directory");
  let realStage: string;
  try {
    realStage = fs.realpathSync(stageDir);
  } catch {
    fail("invalid stage directory");
  }
  // The synthetic test double uses a non-existent absolute pnpm path, so the
  // bin is validated lexically only here and resolved at spawn time.
  if (typeof pnpmBin !== "string" || pnpmBin === "" || !path.isAbsolute(pnpmBin)) {
    fail("invalid pnpm bin");
  }
  if (release === null || typeof release !== "object" || Array.isArray(release)
    || typeof release.version !== "string" || release.version === "") fail("invalid release");
  const run = deps?.run ?? defaultDevtoolsCliRun;
  if (typeof run !== "function") fail("run must be a function");

  // Literal stage paths for cwd/env (never realpath: on systems where tmp is
  // a symlink the resolved form would break stage-scoped env assertions);
  // containment itself is always checked against the resolved stage.
  const env = restrictedStageEnv(stageDir);

  const install = await runDevtoolsCli(
    run,
    pnpmBin,
    ["add", "--ignore-scripts", artifactPath],
    stageDir,
    env,
    "devtools isolated install",
  );
  if (typeof install.status !== "number" || install.status !== 0) {
    fail("devtools isolated install failed");
  }

  const packageDir = path.join(stageDir, "node_modules", DEVTOOLS_BIN_NAME);
  let realPackageDir: string;
  let manifestRaw: string;
  try {
    realPackageDir = assertInsideStage(realStage, fs.realpathSync(packageDir), "devtools package");
    const realManifest = assertInsideStage(realPackageDir, fs.realpathSync(path.join(realPackageDir, "package.json")), "devtools manifest");
    manifestRaw = fs.readFileSync(realManifest, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-provider: ")) throw error;
    throw asBrowserError(`devtools manifest unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw) as unknown;
  } catch {
    fail("devtools manifest is not JSON");
  }
  if (!isRecord(manifest) || manifest["name"] !== DEVTOOLS_BIN_NAME) fail("unexpected devtools manifest");
  if (manifest["version"] !== release.version) fail("devtools version drift");

  const binPath = path.join(stageDir, "node_modules", ".bin", DEVTOOLS_BIN_NAME);
  try {
    const binStat = fs.lstatSync(binPath);
    if (!binStat.isFile() && !binStat.isSymbolicLink()) fail("devtools bin is not executable");
    assertInsideStage(realStage, fs.realpathSync(binPath), "devtools bin");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-provider: ")) throw error;
    fail("devtools bin is missing or unreadable");
  }

  // pnpm's .bin shim needs sed/dirname/uname on Unix, which a private PATH
  // intentionally lacks. Invoke the package-declared JS entry with this Node
  // process, after proving that the real entry stays inside this package.
  const bin = manifest["bin"];
  const entry = typeof bin === "string" ? bin : isRecord(bin) ? bin[DEVTOOLS_BIN_NAME] : null;
  if (typeof entry !== "string" || entry === "" || path.isAbsolute(entry)) fail("invalid devtools bin entry");
  let scriptPath: string;
  try {
    scriptPath = assertInsideStage(realPackageDir, fs.realpathSync(path.join(realPackageDir, entry)), "devtools bin entry");
    if (!fs.statSync(scriptPath).isFile()) fail("devtools bin entry is not a file");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-provider: ")) throw error;
    fail("devtools bin entry is missing or unreadable");
  }

  const help = await runDevtoolsCli(
    run,
    process.execPath,
    [scriptPath, ...DEVTOOLS_PRIVACY_FLAGS, "--help"],
    stageDir,
    env,
    "devtools help probe",
  );
  if (typeof help.status !== "number" || help.status !== 0) fail("devtools help probe failed");
  if (typeof help.stdout !== "string") fail("devtools help probe failed");
  if (Buffer.byteLength(help.stdout, "utf8") > MAX_HELP_STDOUT_BYTES) {
    fail("devtools help output exceeds its bound");
  }
  for (const flag of DEVTOOLS_PRIVACY_FLAGS) {
    const advertised = help.stdout.includes(flag)
      || (flag === "--redact-network-headers" && help.stdout.includes("--redactNetworkHeaders"));
    if (!advertised) fail(`devtools help is missing ${flag}`);
  }

  // --help exits before yargs validates its arguments (even an unknown flag
  // returns 0). Probe the package's parser directly, without starting Chrome,
  // to verify the exact configured flags have their intended boolean effects.
  const parserModule = path.join(realPackageDir, "build", "src", "config", "mcp-options.js");
  let realParserModule: string;
  try {
    realParserModule = assertInsideStage(realPackageDir, fs.realpathSync(parserModule), "devtools parser");
    if (!fs.statSync(realParserModule).isFile()) fail("devtools parser is not a file");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("browser-provider: ")) throw error;
    fail("devtools parser is missing or unreadable");
  }
  const probeEnv = { ...env };
  delete probeEnv.CI; // Otherwise CI alone forces usageStatistics=false, masking an ignored flag.
  const parserProbe = await runDevtoolsCli(
    run,
    process.execPath,
    ["--input-type=module", "-e", DEVTOOLS_PARSER_PROBE, realParserModule],
    stageDir,
    probeEnv,
    "devtools parser probe",
  );
  if (parserProbe.status !== 0 || parserProbe.stdout?.trim() !== "[true,true,false,false]") {
    fail("devtools parser does not honor the mandatory privacy flags");
  }
  return { binPath, version: release.version };
}
