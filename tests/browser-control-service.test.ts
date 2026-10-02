import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { InstallOptions } from "../src/install.js";
import type {
  BrowserControlServiceResult,
  EnsureBrowserControlServiceInput,
} from "../src/lib/browser-control-service.js";
import type { ManagedBrowserControlServiceBinding } from "../src/lib/manifest.js";

/**
 * T12/T13 Linux service vertical (Spec 12/13) — the positive `runInstall` case
 * evolves to the complete supervisor contract at the EXISTING API, without
 * importing any module that does not exist yet.
 *
 * Contract under test: the explicit Linux opt-in (`browserControlService`)
 * reaches `runInstall`, materializes the fixed managed user unit
 * `jorgex-stack-browser-control.service` under `$XDG_CONFIG_HOME/systemd/user`
 * (built from the authenticated managed active: Node + guard + launcher + the
 * complete `serve` runtime arg), records it as owned, and then supervises it:
 * `daemon-reload`, `--no-reload enable` and `start` (and nothing else), probes
 * the served `/version` on the owned loopback port, performs a stable readback,
 * pins `BROWSER_CONTROL_AUTOSTART=false` + the literal port in the native MCP
 * projection and records the `browserControlAutostart` stamp `{schemaVersion:1,
 * projectionSha256, portOwned:true}`. It must never adopt or overwrite a foreign
 * unit at the same path. Default (no flag) and foreign-preservation controls keep
 * their zero-effect contracts; the artifact-only guarantee of the unit creator is
 * retained by the direct `ensureBrowserControlServiceUnit` cases below, so no
 * fictitious artifact-only product mode is introduced.
 *
 * Boundary (deliberately narrow): the Browser Control acquisition coordinator is
 * replaced by a REAL managed active projection seeded on disk through the public
 * `activateManagedBrowserTree` with a real `browserTreeSha256` (real FS, crypto
 * and managed state). `systemctl` is a narrow DI effect seam
 * (`systemctlRunner`) that answers the exact Name=Value protocol and starts an
 * OWN loopback `/version` on the reserved port when `start` is issued; no real
 * manager, DBus, personal session or browser is touched, and the reserved port is
 * owned and closed by this test.
 *
 * RED today: `parseFlags` recognizes `--browser-control-service` and the unit is
 * created, but `runInstall` ignores the supervisor — no manager verb is issued,
 * no `/version` is probed, and neither `BROWSER_CONTROL_AUTOSTART=false` nor the
 * `browserControlAutostart` stamp is produced. The positive case fails on the
 * missing supervisor operations, not on an API import or an invalid fixture.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BC_PACKAGE = "@opencode-ai/browser-control";
const BROWSER_CONTROL_SERVER = "browser-control";
const SERVICE_UNIT_FILENAME = "jorgex-stack-browser-control.service";

/** Fixed release fixture: real bytes, real SRI; a version bump is data, not a new framework. */
const BC_VERSION = "9.9.30";
/**
 * Synthetic identity of the retained entry, never the published literal. The
 * supervisor extracts `browserControlBuildId` statically from the authenticated
 * launcher and must match it against the served `/version` buildId; a valid UTC
 * millisecond string so the production `Date` roundtrip holds.
 */
const BC_BUILD_ID = "2026-10-02T00:00:00.000Z";
const BC_ROOT_BYTES = Buffer.from(
  [
    `var browserControlBuildId = "${BC_BUILD_ID}";`,
    `var browserControlVersion = "${BC_VERSION}";`,
    "",
  ].join("\n"),
  "utf8",
);
const BC_SKILL_BYTES = Buffer.from(
  ["---", "name: browser-control", "description: service fixture, not the published skill", "---", "", "# fixture", ""].join("\n"),
  "utf8",
);
const BC_INTEGRITY = `sha512-${createHash("sha512").update(BC_ROOT_BYTES).digest("base64")}`;
const BC_TARBALL_URL = `https://registry.npmjs.org/${BC_PACKAGE}/-/${BROWSER_CONTROL_SERVER}-${BC_VERSION}.tgz`;

/**
 * Distinct active B for the rotation case: separate version and byte content so
 * the promoted release and its tree/launcher/receipt digests differ from A.
 * Data for the same fixture harness, not a second framework.
 */
const BC_VERSION_B = "9.9.31";
const BC_ROOT_BYTES_B = Buffer.from("browser-control-service-root-bytes-B\n");
const BC_INTEGRITY_B = `sha512-${createHash("sha512").update(BC_ROOT_BYTES_B).digest("base64")}`;
const BC_TARBALL_URL_B = `https://registry.npmjs.org/${BC_PACKAGE}/-/${BROWSER_CONTROL_SERVER}-${BC_VERSION_B}.tgz`;

/**
 * Narrow DI seam of the manager process boundary: argv in, bounded
 * `{status, stdout}` out. It represents only the external `systemctl` edge — it
 * never returns a controller `ready` or simulated receipts.
 */
export interface BrowserControlSystemctlRunner {
  (args: readonly string[]): Promise<{ status: number; stdout: string }>;
}

/** `InstallOptions` intersection with the service opt-in and its effect seam. */
export type BrowserControlServiceInstallOptions = InstallOptions & {
  browserControlService?: boolean;
  systemctlRunner?: BrowserControlSystemctlRunner;
};

/**
 * Granular autostart authority of the verified external service in the manifest
 * row (Spec T13). Declared locally until the source field exists, so the RED
 * does not import a not-yet-existing API; it is layered on the public manifest
 * shape, never cast into an unrelated type.
 */
export interface BrowserControlAutostartStamp {
  readonly schemaVersion: number;
  readonly projectionSha256: string;
  readonly portOwned: boolean;
}

interface AutostartManifestRow {
  readonly owned?: readonly string[];
  readonly serviceUnit?: ManagedBrowserControlServiceBinding;
  readonly browserControlAutostart?: BrowserControlAutostartStamp;
}

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
  },
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    intro: prompts.intro,
    outro: prompts.outro,
    confirm: prompts.confirm,
    log: { ...actual.log, ...prompts.log },
  };
});

/**
 * Process-boundary guard. `runUninstall` has no DI runner (unlike install's
 * `systemctlRunner`), so the only seam that can prove "no manager was invoked"
 * is the real spawn surface. The spies delegate to the real functions so the
 * existing install fixtures keep working; the uninstall case poisons them and
 * asserts they were never called with a manager/process.
 */
const childProcessSpies = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessSpies.spawn.mockImplementation(actual.spawn);
  childProcessSpies.spawnSync.mockImplementation(actual.spawnSync);
  childProcessSpies.execFile.mockImplementation(actual.execFile);
  childProcessSpies.execFileSync.mockImplementation(actual.execFileSync);
  return {
    ...actual,
    spawn: childProcessSpies.spawn,
    spawnSync: childProcessSpies.spawnSync,
    execFile: childProcessSpies.execFile,
    execFileSync: childProcessSpies.execFileSync,
  };
});

afterEach(() => {
  cleanupOwnedResourcesOrThrow();
  vi.doUnmock("../src/lib/browser-control-runtime.js");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

/**
 * The four process-boundary delegates whose invocation the uninstall guards
 * observe. `runUninstall` has no DI runner, so the real spawn surface is the
 * seam; the install and uninstall phases share it in the same private HOME.
 */
const childProcessDelegates = [
  childProcessSpies.spawn,
  childProcessSpies.spawnSync,
  childProcessSpies.execFile,
  childProcessSpies.execFileSync,
] as const;

/**
 * Aggregate invocation count across every process-boundary delegate. Callers
 * compare two snapshots to obtain a delta: the install phase legitimately runs
 * real delegates (the OpenCode v2 `--version` gate), so an absolute count would
 * misattribute those calls to the removal.
 */
function processDelegateCallTotal(): number {
  return childProcessDelegates.reduce((total, delegate) => total + delegate.mock.calls.length, 0);
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
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG_DIR",
  "BROWSER_CONTROL_PORT",
] as const;

async function withIsolatedEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ISOLATED_KEYS) {
    saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    vi.resetModules();
    return await run();
  } finally {
    for (const key of ISOLATED_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

interface WitnessTree {
  readonly stageDir: string;
  readonly nodeModulesPath: string;
  readonly treePath: string;
  readonly entryPath: string;
}

/** Real on-disk Browser Control package tree with the official skill path. */
function writeWitnessTree(
  root: string,
  fixture: { readonly version?: string; readonly entryBytes?: Buffer } = {},
): WitnessTree {
  const version = fixture.version ?? BC_VERSION;
  const entryBytes = fixture.entryBytes ?? BC_ROOT_BYTES;
  const stageDir = path.join(root, "witness-stage");
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treePath = path.join(nodeModulesPath, "@opencode-ai", "browser-control");
  const entryPath = path.join(treePath, "dist", "cli.js");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(treePath, "package.json"),
    `${JSON.stringify(
      {
        name: BC_PACKAGE,
        version,
        bin: { [BROWSER_CONTROL_SERVER]: "dist/cli.js" },
        engines: { node: ">=22.19.0" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, entryBytes);
  const skillPath = path.join(treePath, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(skillPath, BC_SKILL_BYTES);
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

interface ManagerRunner {
  readonly calls: string[][];
  readonly run: BrowserControlSystemctlRunner;
}

/**
 * Recording-only runner for the zero-effect controls (default/foreign). Every
 * invocation is recorded and answered with an empty, successful reply; the
 * controls assert the call log stays empty, so an unexpected manager mutation
 * fails the test instead of being simulated.
 */
function createRecordingRunner(): ManagerRunner {
  const calls: string[][] = [];
  const run: BrowserControlSystemctlRunner = async (args) => {
    calls.push([...args]);
    return { status: 0, stdout: "" };
  };
  return { calls, run };
}

/** Manager verbs that mutate state; a read-only `show` is never one of them. */
const SERVICE_MUTATING_VERBS = new Set([
  "daemon-reload",
  "enable",
  "disable",
  "start",
  "stop",
  "restart",
  "reload",
  "mask",
  "unmask",
  "linger",
]);

/** First non-option argv token: the systemctl verb, independent of option order. */
function serviceVerb(argv: readonly string[]): string | undefined {
  return argv.find((token) => token !== "systemctl" && !token.startsWith("-"));
}

interface SupervisorManagerFixture extends ManagerRunner {
  /** Ordered external-boundary log: manager calls and the served `/version`. */
  readonly events: string[];
  readonly versionRequests: string[];
  readonly close: () => Promise<void>;
}

/**
 * Fake manager that answers only the closed supervisor protocol and, when
 * `start` is issued, brings up this test's OWN loopback `/version` on the
 * reserved port. The returned pid is the current process, so the production
 * readiness check (HTTP pid === readback MainPID) is grounded in a real process
 * without spawning Node, systemctl, DBus or a browser. `connections` are closed
 * by `close()` before the caller removes any file.
 */
function createSupervisorManagerFixture(input: {
  readonly unitPath: string;
  readonly port: number;
  /**
   * External write that lands WHILE the `start` verb runs, after the real
   * external start and before the caller's final reconcile. It represents a
   * concurrent user/manual config write, never a forged manager/controller
   * reply.
   */
  readonly onStart?: () => void | Promise<void>;
}): SupervisorManagerFixture {
  const calls: string[][] = [];
  const events: string[] = [];
  const versionRequests: string[] = [];
  let reloaded = false;
  let started = false;
  let server: Server | undefined;

  const showOutput = (): string => {
    const lines = [
      `Id=${SERVICE_UNIT_FILENAME}`,
      `LoadState=${reloaded ? "loaded" : "not-found"}`,
      `FragmentPath=${reloaded ? input.unitPath : ""}`,
      "DropInPaths=",
      "NeedDaemonReload=no",
      `ActiveState=${started ? "active" : "inactive"}`,
      `SubState=${started ? "running" : "dead"}`,
    ];
    if (started) lines.push(`MainPID=${process.pid}`);
    return `${lines.join("\n")}\n`;
  };

  const startVersionServer = async (): Promise<void> => {
    if (server !== undefined) return;
    const created = createServer((request, response) => {
      versionRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      events.push("version:GET /version");
      if (request.method === "GET" && request.url === "/version") {
        // Identity/build/protocol only: never sessions, targets or URLs.
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            pid: process.pid,
            version: BC_VERSION,
            buildId: BC_BUILD_ID,
            managed: false,
            protocol: 2,
          }),
        );
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(input.port, "127.0.0.1", () => resolve());
    });
    server = created;
  };

  const run: BrowserControlSystemctlRunner = async (args) => {
    calls.push([...args]);
    const verb = serviceVerb(args);
    events.push(`call:${verb ?? "unknown"}`);
    switch (verb) {
      case "show":
        return { status: 0, stdout: showOutput() };
      case "daemon-reload":
        reloaded = true;
        return { status: 0, stdout: "" };
      case "enable":
        return { status: 0, stdout: "" };
      case "start":
        started = true;
        await startVersionServer();
        await input.onStart?.();
        return { status: 0, stdout: "" };
      default:
        return { status: 1, stdout: "" };
    }
  };

  return {
    calls,
    events,
    versionRequests,
    run,
    close: async () => {
      const active = server;
      server = undefined;
      if (active === undefined) return;
      await new Promise<void>((resolve) => {
        active.closeAllConnections?.();
        active.close(() => resolve());
      });
    },
  };
}

/**
 * Reserves an ephemeral loopback port and closes its listener, leaving a
 * genuine `ECONNREFUSED` behind: the preflight must observe relay absence on
 * this exact owned port, never the default 19989 or a personal relay. The same
 * port is later bound exclusively by the fake supervisor `start`.
 */
async function reserveOwnedLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.on("clientError", () => undefined);
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

/**
 * External write at the FS boundary: the user hand-writes the native MCP
 * `environment` (the exact canonical FALSE + literal port) on the managed
 * launcher already projected. Like a late manual config confirmation, it is
 * genuine external state, not a forged controller/manager reply.
 */
function writeManualBrowserControlEnvironment(configDir: string, port: number): void {
  const file = path.join(configDir, "opencode.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcp?: { servers?: Record<string, { environment?: Record<string, string> }> };
  };
  const entry = config.mcp?.servers?.[BROWSER_CONTROL_SERVER];
  if (entry === undefined) throw new Error("fixture: the managed MCP must be projected before start");
  entry.environment = { BROWSER_CONTROL_AUTOSTART: "false", BROWSER_CONTROL_PORT: String(port) };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

interface ServiceObservables {
  readonly exitCode: number;
  readonly unitPath: string;
  readonly unitBytes: Buffer | null;
  readonly manifestOwned: readonly string[];
  readonly manifestAutostart: BrowserControlAutostartStamp | undefined;
  readonly manifestServiceUnit: ManagedBrowserControlServiceBinding | undefined;
  readonly mcpCommand: readonly string[] | undefined;
  readonly mcpEnvironment: Record<string, unknown> | undefined;
  readonly systemctlCalls: readonly string[][];
  /** Ordered external-boundary log (manager calls and served `/version`). */
  readonly supervisorEvents: readonly string[];
  readonly versionRequests: readonly string[];
  /** The real managed launcher invocation the MCP projection must reproduce. */
  readonly expectedMcpCommand: readonly string[];
}

interface RunServiceInput {
  readonly prefix: string;
  readonly registerOwnedRoot: (root: string) => void;
  readonly base: string;
  readonly browserControlService?: boolean;
  readonly foreignUnitBytes?: Buffer;
  /** When present, installs the supervisor-protocol fake on the owned port. */
  readonly supervisor?: { readonly port: number };
  /**
   * When true, an EXTERNAL writer (the user) sets the manual native MCP
   * `environment` to the exact canonical values while the manager `start` verb
   * runs — i.e. between the original MCP projection and the final reconcile.
   */
  readonly manualEnvironmentAtStart?: boolean;
  /**
   * Runs INSIDE the isolated HOME after `runInstall` verified the service and
   * BEFORE the observables are read, so a case can act on the verified root
   * (e.g. run the real `runUninstall`) in the same private HOME and have the
   * returned observables reflect that later state.
   */
  readonly onVerified?: (ctx: VerifiedServiceContext) => void | Promise<void>;
}

/** Private paths of a verified install, exposed only for the in-place callback. */
interface VerifiedServiceContext {
  readonly configDir: string;
  readonly unitPath: string;
}

/**
 * Runs a real `runInstall` with a real managed active Browser Control projection
 * and returns the observable service artifacts. The coordinator boundary is the
 * only substitute; adapter detection, manifest, config projection and the FS all
 * run real.
 */
async function runServiceInstall(input: RunServiceInput): Promise<ServiceObservables> {
  const owned = createOwnedVerificationHome({
    base: input.base,
    prefix: input.prefix,
    register: input.registerOwnedRoot,
  });
  let observables: ServiceObservables | undefined;

  const isolatedEnv: NodeJS.ProcessEnv = { ...process.env, ...owned.env };
  if (input.supervisor !== undefined) {
    // The owned, reserved-then-closed port: absent at preflight, served by the
    // fake supervisor `start`, and pinned literally in the MCP projection.
    isolatedEnv.BROWSER_CONTROL_PORT = String(input.supervisor.port);
  }

  await withIsolatedEnv(isolatedEnv, async () => {
    const home = owned.env.HOME!;
    const stateDir = path.join(home, ".jorgex-stack");
    const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
    const unitPath = path.join(owned.env.XDG_CONFIG_HOME!, "systemd", "user", SERVICE_UNIT_FILENAME);

    if (input.foreignUnitBytes !== undefined) {
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, input.foreignUnitBytes);
    }

    const witness = writeWitnessTree(path.join(owned.root, "witness"));
    const { browserTreeSha256 } = await import("../src/lib/browser-stage.js");
    const { activateManagedBrowserTree, planManagedBrowserInvocation } = await import(
      "../src/lib/browser-managed.js"
    );
    const receipt = await activateManagedBrowserTree({
      stateDir,
      packageName: BC_PACKAGE,
      release: { version: BC_VERSION, tarballUrl: BC_TARBALL_URL, integrity: BC_INTEGRITY },
      staged: {
        treePath: witness.treePath,
        nodeModulesPath: witness.nodeModulesPath,
        treeSha256: browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
        closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_INTEGRITY }],
      },
      entryPath: witness.entryPath,
    });
    // Real authenticated projection of the active: Node + guard eval + launcher.
    const ready = {
      kind: "ready" as const,
      version: receipt.version,
      invocation: planManagedBrowserInvocation(stateDir, BC_PACKAGE, ["mcp"]),
      skillSource: path.join(
        receipt.treePath,
        "@opencode-ai",
        "browser-control",
        "skills",
        BROWSER_CONTROL_SERVER,
        "SKILL.md",
      ),
    };
    // The exact managed launcher argv the MCP projection must reproduce.
    const expectedMcpCommand = [ready.invocation.command, ...ready.invocation.args];
    vi.doMock("../src/lib/browser-control-runtime.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/lib/browser-control-runtime.js")>(
          "../src/lib/browser-control-runtime.js",
        );
      return {
        ...actual,
        prepareBrowserControlRuntime: async () => ready,
        inspectCachedBrowserControlRuntime: () => ready,
      };
    });

    const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), { output: "opencode v2.0.20" });
    const install = await import("../src/install.js");
    const { readManifest } = await import("../src/lib/manifest.js");
    const supervisorSpec = input.supervisor;
    const supervisor = supervisorSpec === undefined
      ? undefined
      : createSupervisorManagerFixture({
          unitPath,
          port: supervisorSpec.port,
          ...(input.manualEnvironmentAtStart === true
            ? { onStart: () => writeManualBrowserControlEnvironment(configDir, supervisorSpec.port) }
            : {}),
        });
    const runner: ManagerRunner = supervisor ?? createRecordingRunner();

    const opencode = install.ADAPTERS.opencode!;
    const originalDetect = opencode.detect;
    opencode.detect = () => ({
      id: "opencode",
      name: "OpenCode",
      installed: true,
      binPath: opencodeBin,
      configDir,
    });

    let exitCode: number;
    try {
      const options: BrowserControlServiceInstallOptions = {
        runtimes: ["opencode"],
        command: "install",
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        engramBin: null,
        browserControlService: input.browserControlService,
        systemctlRunner: runner.run,
      };
      exitCode = await install.runInstall(options);
    } finally {
      opencode.detect = originalDetect;
      // Close this test's own listener (and its connections) before any owned
      // root is removed by the caller's cleanup.
      await supervisor?.close();
    }

    // The case may now act on the verified root (same private HOME). Observables
    // below are read afterwards, so they witness the later state.
    if (input.onVerified !== undefined) {
      await input.onVerified({ configDir, unitPath });
    }

    const unitBytes = fs.existsSync(unitPath) ? fs.readFileSync(unitPath) : null;
    const configPath = path.join(configDir, "opencode.json");
    type ProjectedConfig = {
      mcp?: { servers?: Record<string, { command?: string[]; environment?: Record<string, unknown> }> };
    };
    const config: ProjectedConfig = fs.existsSync(configPath)
      ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as ProjectedConfig)
      : {};
    const projected = config.mcp?.servers?.[BROWSER_CONTROL_SERVER];
    const manifestRow = readManifest().runtimes.opencode as AutostartManifestRow | undefined;
    observables = {
      exitCode,
      unitPath,
      unitBytes,
      manifestOwned: manifestRow?.owned ?? [],
      manifestAutostart: manifestRow?.browserControlAutostart,
      manifestServiceUnit: manifestRow?.serviceUnit,
      mcpCommand: projected?.command,
      mcpEnvironment: projected?.environment,
      systemctlCalls: runner.calls,
      supervisorEvents: supervisor?.events ?? [],
      versionRequests: supervisor?.versionRequests ?? [],
      expectedMcpCommand,
    };
  });

  if (observables === undefined) {
    throw new Error("browser-control-service: the isolated install did not run");
  }
  return observables;
}

function verificationBase(): string {
  return resolveVerificationDiskBase({
    repoRoot: REPO_ROOT,
    env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
  });
}

describe.skipIf(process.platform !== "linux")("[T12-RED] Browser Control Linux user service", () => {
  it("creates the fixed owned unit and supervises it with the authenticated `serve` invocation when the opt-in is explicit", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
      });

      // 1) The fixed user unit is materialized and recorded as owned.
      expect(
        observables.unitBytes,
        `the fixed user unit must be created at ${observables.unitPath}`,
      ).not.toBeNull();
      const unit = observables.unitBytes!.toString("utf8");
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "the created unit must be recorded as an owned resource",
      ).toContain(path.resolve(observables.unitPath));

      // 2) ExecStart is direct argv (no shell, no elevation), uses the
      //    authenticated Node and the complete `serve` runtime arg.
      const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "";
      expect(execStart, "the unit must declare a single ExecStart").not.toBe("");
      expect(execStart.startsWith("ExecStart=:"), "ExecStart must use ':' to disable env expansion").toBe(true);
      expect(execStart).not.toMatch(/ExecStart=[+!]/);
      expect(execStart).not.toContain("/bin/sh");
      expect(execStart).not.toMatch(/\bbash\b/);
      expect(execStart).toContain(process.execPath);
      expect(execStart).toContain("--input-type=module");
      expect(execStart).toContain("--eval");
      expect(execStart).toMatch(/\bserve\b/);
      expect(execStart).not.toMatch(/\bmcp\b/);
      // Literal `%` must be doubled for systemd specifier safety.
      expect(unit.replaceAll("%%", "")).not.toContain("%");

      // 3) The supervisor issues EXACTLY daemon-reload, --no-reload enable and
      //    start (this order), and never restart/stop/--now/--force/linger.
      const mutating = observables.systemctlCalls
        .map((argv) => serviceVerb(argv))
        .filter((verb): verb is string => verb !== undefined && SERVICE_MUTATING_VERBS.has(verb));
      expect(
        mutating,
        "the only manager mutations must be daemon-reload, --no-reload enable and start",
      ).toEqual(["daemon-reload", "enable", "start"]);
      const preflightShowEvent = observables.supervisorEvents.indexOf("call:show");
      const daemonReloadEvent = observables.supervisorEvents.indexOf("call:daemon-reload");
      expect(
        preflightShowEvent,
        "the absent-unit preflight read must precede any mutating verb",
      ).toBeGreaterThanOrEqual(0);
      expect(preflightShowEvent).toBeLessThan(daemonReloadEvent);
      const enableArgs = observables.systemctlCalls.find((argv) => serviceVerb(argv) === "enable") ?? [];
      expect(enableArgs, "enable must suppress the implicit daemon reload").toContain("--no-reload");
      const flattened = observables.systemctlCalls.flat();
      for (const forbidden of ["restart", "stop", "reload", "disable", "mask", "linger", "--now", "--force"]) {
        expect(flattened, `the supervisor must never issue ${forbidden}`).not.toContain(forbidden);
      }
      expect(
        flattened,
        "the supervisor must operate in the user scope, never system/global",
      ).not.toContain("--system");
      expect(flattened).not.toContain("--global");
      expect(flattened).toContain("--user");

      // 4) The owned `/version` endpoint is probed after `start` and a stable
      //    operational readback follows it (observed at the process boundary).
      expect(
        observables.versionRequests.length,
        "the supervisor must probe the owned /version endpoint",
      ).toBeGreaterThanOrEqual(1);
      const startEvent = observables.supervisorEvents.indexOf("call:start");
      const firstVersionEvent = observables.supervisorEvents.indexOf("version:GET /version");
      expect(startEvent, "start must be issued before the endpoint exists").toBeGreaterThanOrEqual(0);
      expect(
        firstVersionEvent,
        "the /version probe must happen after start",
      ).toBeGreaterThan(startEvent);
      expect(
        observables.supervisorEvents.lastIndexOf("call:show"),
        "a stable manager readback must follow the /version probe",
      ).toBeGreaterThan(firstVersionEvent);

      // 5) The pinned MCP projection is the REAL managed launcher (same guarded
      //    CLI), so the `false` below is grounded in the authenticated active —
      //    not in a fabricated artifact-only mode.
      expect(observables.mcpCommand).toEqual(observables.expectedMcpCommand);
      expect(observables.mcpCommand?.[0]).toBe(process.execPath);
      expect(observables.mcpCommand?.slice(-1)).toEqual(["mcp"]);
      expect(observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART).toBe("false");
      expect(observables.mcpEnvironment?.BROWSER_CONTROL_PORT).toBe(String(port));

      // 6) The autostart authority is the introduced stamp, with no extra fields.
      const stamp = observables.manifestAutostart;
      expect(stamp, "the verified service must record its autostart authority").toBeDefined();
      expect(Object.keys(stamp!).sort(), "only the introduced stamp fields are present").toEqual([
        "portOwned",
        "projectionSha256",
        "schemaVersion",
      ]);
      expect(stamp!.schemaVersion).toBe(1);
      expect(stamp!.portOwned).toBe(true);
      expect(stamp!.projectionSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  /**
   * Negative granularity of the autostart authority (Spec T13): a
   * `BROWSER_CONTROL_AUTOSTART=false` + literal port that the USER wrote by hand
   * on the managed MCP before Stack ever claimed it must be preserved with a
   * conflict, never adopted by equality. The external write lands exactly while
   * the manager `start` verb runs (between the original projection and the final
   * environment reconcile) and there is no prior `browserControlAutostart`
   * stamp. Stack must not stamp `portOwned:true` for an environment it did not
   * create, must not print the managed-autostart success marker, and must not
   * roll back or stop the just-started service to hide the conflict: the unit,
   * its claim/binding and the manual environment all survive.
   */
  it("preserves a manual canonical MCP environment with conflict instead of adopting it by equality", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-manual-env-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-manual-env-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
        manualEnvironmentAtStart: true,
      });

      // 1) No authority is stamped for an environment Stack never created and
      //    had no prior claim for. (RED today: reconcile reports `unchanged` and
      //    install stamps `portOwned:true` by equality.)
      expect.soft(
        observables.manifestAutostart,
        "a manual FALSE without a prior claim must never be adopted by equality",
      ).toBeUndefined();

      // 2) The conflict is explicit and actionable, never the managed-autostart
      //    ready/success marker.
      const conflictDiagnostics = [
        ...prompts.log.warn.mock.calls.map((call) => String(call[0] ?? "")),
        ...prompts.log.error.mock.calls.map((call) => String(call[0] ?? "")),
      ];
      expect.soft(
        conflictDiagnostics.some(
          (message) => /browser.?control/i.test(message) && /(manual|entorno|environment)/i.test(message),
        ),
        `the manual environment must be reported as an actionable conflict (got ${JSON.stringify(conflictDiagnostics)})`,
      ).toBe(true);
      const successMessages = prompts.log.success.mock.calls.map((call) => String(call[0] ?? ""));
      expect.soft(
        successMessages.some((message) => /autostart/i.test(message)),
        `the managed-autostart success marker must not be emitted for a manual environment (got ${JSON.stringify(successMessages)})`,
      ).toBe(false);

      // 3) The own initial activation legitimately ran: the conflict must not be
      //    hidden by rolling back, stopping or disabling the service.
      const verbs = observables.systemctlCalls.map((argv) => serviceVerb(argv));
      expect.soft(verbs, "the own initial activation may run the manager start").toContain("start");
      const flattened = observables.systemctlCalls.flat();
      for (const forbidden of ["stop", "restart", "disable"]) {
        expect.soft(flattened, `the conflict must not issue ${forbidden}`).not.toContain(forbidden);
      }

      // 4) The unit, its claim/binding and the manual environment survive
      //    verbatim.
      expect.soft(observables.unitBytes, "the created unit must be preserved").not.toBeNull();
      expect.soft(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "the created unit must remain claimed",
      ).toContain(path.resolve(observables.unitPath));
      expect.soft(observables.manifestServiceUnit, "the serviceUnit binding must remain").toBeDefined();
      expect.soft(observables.manifestServiceUnit?.unitSha256, "the binding must witness the preserved unit").toBe(
        createHash("sha256").update(observables.unitBytes!).digest("hex"),
      );
      expect.soft(observables.mcpEnvironment, "the manual environment must be preserved verbatim").toEqual({
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(port),
      });
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  it("does not create a unit, invoke a manager or set autostart when the opt-in is absent", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-default-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-default-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
      });

      expect(observables.unitBytes, "no unit may be created without the explicit opt-in").toBeNull();
      expect(observables.systemctlCalls, "no manager may be invoked without the explicit opt-in").toEqual([]);
      // The native MCP is still projected from the authenticated active: the
      // default is autostart nativo, not a missing capability.
      expect(observables.mcpCommand?.[0]).toBe(process.execPath);
      expect(observables.mcpCommand?.slice(-1)).toEqual(["mcp"]);
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART,
        "native MCP autostart stays untouched without a verified external service",
      ).toBeUndefined();
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
      ).not.toContain(path.resolve(observables.unitPath));
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  it("preserves a foreign existing unit at the fixed path without adopting or overwriting it", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-foreign-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const foreignBytes = Buffer.from(
      [
        "[Unit]",
        "Description=foreign browser-control service",
        "",
        "[Service]",
        "ExecStart=/usr/bin/foreign-browser-control serve",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-foreign-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        foreignUnitBytes: foreignBytes,
      });

      expect(observables.unitBytes, "the foreign unit must survive the run").not.toBeNull();
      expect(observables.unitBytes, "the foreign unit bytes must not be overwritten").toEqual(foreignBytes);
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "a manual unit at the fixed path must not be claimed as owned",
      ).not.toContain(path.resolve(observables.unitPath));
      const adopted = observables.systemctlCalls.filter((args) => /(^|\s)(enable|start)(\s|$)/.test(args.join(" ")));
      expect(adopted, "a foreign unit must not be enabled or started").toEqual([]);
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });
});

interface ManagedServiceFixture {
  readonly stateDir: string;
  readonly unitPath: string;
  readonly configDir: string;
  readonly binding: ManagedBrowserControlServiceBinding;
  readonly unitBytes: Buffer;
  readonly inode: number;
  /** Bound from the same fresh registry as the fixture's managed active. */
  readonly ensure: (input: EnsureBrowserControlServiceInput) => BrowserControlServiceResult;
}

/**
 * Builds a REAL managed active (staged tree + activated receipt on disk under a
 * private HOME) and creates the fixed owned unit through the public
 * `ensureBrowserControlServiceUnit`, then hands the created artifact and the
 * authenticated `ensure` to the case. No coordinator mock, no manager, no
 * network: real FS, real crypto and the real managed state.
 */
async function withCreatedManagedServiceUnit<T>(
  input: {
    readonly prefix: string;
    readonly registerOwnedRoot: (root: string) => void;
    readonly base: string;
  },
  run: (fixture: ManagedServiceFixture) => T | Promise<T>,
): Promise<T> {
  const owned = createOwnedVerificationHome({
    base: input.base,
    prefix: input.prefix,
    register: input.registerOwnedRoot,
  });
  // Presence of the holder is the execution flag: a generic `void` callback
  // legitimately returns `undefined`, so the value alone cannot prove the run.
  let outcome: { readonly value: T } | undefined;
  await withIsolatedEnv({ ...process.env, ...owned.env, BROWSER_CONTROL_PORT: "19989" }, async () => {
    const stateDir = path.join(owned.env.HOME!, ".jorgex-stack");
    const { ensureBrowserControlServiceUnit, resolveBrowserControlServiceUnitPath } = await import(
      "../src/lib/browser-control-service.js"
    );
    const unitPath = resolveBrowserControlServiceUnitPath();
    if (unitPath === null) throw new Error("fixture: XDG_CONFIG_HOME must resolve an absolute unit path");

    const witness = writeWitnessTree(path.join(owned.root, "witness"));
    const { browserTreeSha256 } = await import("../src/lib/browser-stage.js");
    const { activateManagedBrowserTree } = await import("../src/lib/browser-managed.js");
    const receipt = await activateManagedBrowserTree({
      stateDir,
      packageName: BC_PACKAGE,
      release: { version: BC_VERSION, tarballUrl: BC_TARBALL_URL, integrity: BC_INTEGRITY },
      staged: {
        treePath: witness.treePath,
        nodeModulesPath: witness.nodeModulesPath,
        treeSha256: browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
        closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_INTEGRITY }],
      },
      entryPath: witness.entryPath,
    });
    if (receipt.version !== BC_VERSION) throw new Error("fixture: the managed active is not the staged release");

    const created = ensureBrowserControlServiceUnit({ stateDir, unitPath, prevOwned: [] });
    if (created.kind !== "created") throw new Error(`fixture: expected the first ensure to create, got ${created.kind}`);

    outcome = {
      value: await run({
        stateDir,
        unitPath,
        configDir: path.join(owned.env.XDG_CONFIG_HOME!, "opencode"),
        binding: created.binding,
        unitBytes: fs.readFileSync(unitPath),
        inode: fs.statSync(unitPath).ino,
        ensure: ensureBrowserControlServiceUnit,
      }),
    };
  });
  if (outcome === undefined) throw new Error("browser-control-service: the direct ensure fixture did not run");
  return outcome.value;
}

describe.skipIf(process.platform !== "linux")(
  "[T12-RED] Browser Control owned service binding is authenticated against the retained active",
  () => {
    /**
     * The regular-owned branch must not accept a binding just because its
     * `unitSha256` matches the file. The binding is a WITNESS of the release
     * that authorized the bytes: `receiptSha256` and `nodePath` here (the rest
     * of the binding follows the same authority) must match the authenticated
     * active, or the unit fails closed and keeps its bytes, inode and authority
     * untouched. Today only the digest is compared, so a tampered field is
     * silently re-claimed as `unchanged`.
     */
    it.each([
      {
        label: "receiptSha256",
        tamper: (binding: ManagedBrowserControlServiceBinding): ManagedBrowserControlServiceBinding => ({
          ...binding,
          receiptSha256: "0".repeat(64),
        }),
      },
      {
        label: "nodePath",
        tamper: (binding: ManagedBrowserControlServiceBinding): ManagedBrowserControlServiceBinding => ({
          ...binding,
          nodePath: "/unapproved/node",
        }),
      },
    ])(
      "fails closed when the recorded $label does not match the authenticated active",
      async (variant) => {
        const ownedRoots: string[] = [];
        const releaseRoots = registerOwnedResourceCleanup("browser-control-service-binding-roots", () =>
          removeTemporaryRoots(ownedRoots),
        );
        try {
          await withCreatedManagedServiceUnit(
            {
              prefix: ".jorgex-browser-control-service-binding-",
              registerOwnedRoot: (root) => ownedRoots.push(root),
              base: verificationBase(),
            },
            (fixture) => {
              // Fixture invariant: the on-disk bytes still match the recorded
              // unit digest, so the ONLY defect is the tampered metadata field.
              // A digest-only check cannot observe it.
              const onDisk = fs.readFileSync(fixture.unitPath);
              expect(createHash("sha256").update(onDisk).digest("hex")).toBe(fixture.binding.unitSha256);

              const result = fixture.ensure({
                stateDir: fixture.stateDir,
                unitPath: fixture.unitPath,
                prevOwned: [fixture.unitPath],
                prevBinding: variant.tamper(fixture.binding),
              });

              expect(
                result.kind,
                `a ${variant.label} that does not match the authenticated active must fail closed, got ${result.kind}`,
              ).toBe("error");

              // Fail closed preserves bytes and inode: no rewrite, no
              // re-creation, no ownership re-claim. The unit stays a regular
              // owned file whose content is byte-identical.
              const after = fs.statSync(fixture.unitPath);
              expect(fs.readFileSync(fixture.unitPath)).toEqual(fixture.unitBytes);
              expect(after.ino).toBe(fixture.inode);
            },
          );
        } finally {
          cleanupOwnedResourcesOrThrow();
          releaseRoots();
        }
      },
    );
  },
);

describe.skipIf(process.platform !== "linux")(
  "[T12] Browser Control owned service binding stays bound to the retained release and rejects unsafe ancestors",
  () => {
    /**
     * Rotation case: the owned unit A was authorized by the retained active A.
     * A distinct active B is then promoted through the same public activation
     * API (separate root, version and byte hash). The active pointer now names
     * B, but binding A must still authenticate against its OWN retained
     * release A. `ensure` must return `unchanged` without touching the unit
     * bytes/inode or rewriting the active pointer to A, and the real retained
     * validator (not a fake receipt) is what accepts A.
     */
    it("keeps the historical binding A unchanged after a distinct active B is promoted", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-rotation-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      try {
        await withCreatedManagedServiceUnit(
          {
            prefix: ".jorgex-browser-control-service-rotation-",
            registerOwnedRoot: (root) => ownedRoots.push(root),
            base: verificationBase(),
          },
          async (fixture) => {
            const { browserTreeSha256 } = await import("../src/lib/browser-stage.js");
            const { activateManagedBrowserTree, loadVerifiedRetainedBrowserRelease } = await import(
              "../src/lib/browser-managed.js"
            );

            // The retained release A authenticates while it is still active, and
            // its basename is exactly what the unit binding recorded.
            const activeA = loadVerifiedRetainedBrowserRelease(fixture.stateDir, BC_PACKAGE);
            expect(activeA, "fixture: the retained active A must authenticate").not.toBeNull();
            expect(activeA!.releaseDirectory).toBe(fixture.binding.releaseDirectory);
            expect(activeA!.receiptSha256).toBe(fixture.binding.receiptSha256);

            // Promote a DISTINCT active B: separate root dirname, version and
            // tree/byte hash, through the same public activation API.
            const witnessB = writeWitnessTree(path.join(path.dirname(fixture.stateDir), "witness-b"), {
              version: BC_VERSION_B,
              entryBytes: BC_ROOT_BYTES_B,
            });
            const receiptB = await activateManagedBrowserTree({
              stateDir: fixture.stateDir,
              packageName: BC_PACKAGE,
              release: { version: BC_VERSION_B, tarballUrl: BC_TARBALL_URL_B, integrity: BC_INTEGRITY_B },
              staged: {
                treePath: witnessB.treePath,
                nodeModulesPath: witnessB.nodeModulesPath,
                treeSha256: browserTreeSha256(witnessB.nodeModulesPath, witnessB.stageDir),
                closure: [{ name: BC_PACKAGE, version: BC_VERSION_B, integrity: BC_INTEGRITY_B }],
              },
              entryPath: witnessB.entryPath,
            });
            expect(receiptB.version).toBe(BC_VERSION_B);

            const activeB = loadVerifiedRetainedBrowserRelease(fixture.stateDir, BC_PACKAGE);
            expect(activeB, "the promoted active B must authenticate").not.toBeNull();
            expect(
              activeB!.releaseDirectory,
              "the active pointer must now name a release distinct from the unit's binding A",
            ).not.toBe(fixture.binding.releaseDirectory);
            expect(activeB!.receiptSha256).not.toBe(fixture.binding.receiptSha256);

            const result = fixture.ensure({
              stateDir: fixture.stateDir,
              unitPath: fixture.unitPath,
              prevOwned: [fixture.unitPath],
              prevBinding: fixture.binding,
            });
            if (result.kind !== "unchanged") {
              throw new Error(`expected the historical binding A to stay unchanged, got ${result.kind}`);
            }
            // The result hands back A's binding verbatim, not B's.
            expect(result.binding).toEqual(fixture.binding);

            // No rewrite: unit bytes and inode are intact.
            expect(fs.readFileSync(fixture.unitPath)).toEqual(fixture.unitBytes);
            expect(fs.statSync(fixture.unitPath).ino).toBe(fixture.inode);

            // No actual pointer write: the active stays B after ensure. A private
            // manager is not part of this synchronous API, so the pointer and the
            // byte/inode witness are the full mutation surface.
            const activeAfterEnsure = loadVerifiedRetainedBrowserRelease(fixture.stateDir, BC_PACKAGE);
            expect(activeAfterEnsure!.releaseDirectory).toBe(activeB!.releaseDirectory);
            expect(activeAfterEnsure!.receiptSha256).toBe(activeB!.receiptSha256);
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });

    /**
     * Physical-path case: after the owned unit is created, its parent directory
     * is replaced with an own symlink alias to an own backup parent (rolled back
     * in `finally`). The on-disk bytes still match `binding.unitSha256`, so a
     * digest-only check would re-claim the unit. `ensure` must instead reject the
     * symlinked ancestor, leave bytes/inode untouched and change no claim (no
     * rewrite, no replacement of the alias, no new file).
     */
    it("rejects an owned unit whose parent was replaced by an own symlink alias", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-ancestor-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      try {
        await withCreatedManagedServiceUnit(
          {
            prefix: ".jorgex-browser-control-service-ancestor-",
            registerOwnedRoot: (root) => ownedRoots.push(root),
            base: verificationBase(),
          },
          (fixture) => {
            // Digest-only logic would accept: the bytes still match the digest.
            const onDisk = fs.readFileSync(fixture.unitPath);
            expect(createHash("sha256").update(onDisk).digest("hex")).toBe(fixture.binding.unitSha256);

            const unitName = path.basename(fixture.unitPath);
            const parent = path.dirname(fixture.unitPath);
            const backupParent = path.join(path.dirname(parent), `${path.basename(parent)}-owned-backup`);
            let replaced = false;
            try {
              fs.renameSync(parent, backupParent);
              fs.symlinkSync(backupParent, parent, "dir");
              replaced = true;

              const result = fixture.ensure({
                stateDir: fixture.stateDir,
                unitPath: fixture.unitPath,
                prevOwned: [fixture.unitPath],
                prevBinding: fixture.binding,
              });
              expect(
                result.kind,
                `a symlinked ancestor must fail closed even though unitSha256 matches, got ${result.kind}`,
              ).toBe("error");

              // Fail closed preserved everything: the alias is still a symlink,
              // the target file kept its bytes and inode and no file was created
              // or removed inside the own backup parent.
              expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
              expect(fs.readFileSync(fixture.unitPath)).toEqual(fixture.unitBytes);
              expect(fs.statSync(fixture.unitPath).ino).toBe(fixture.inode);
              expect(fs.readdirSync(backupParent).sort()).toEqual([unitName]);
            } finally {
              // Roll back the own alias before the owned root cleanup, restoring
              // the original parent directory.
              if (replaced) {
                try { fs.rmSync(parent, { force: true }); } catch { /* best effort */ }
                try { fs.renameSync(backupParent, parent); } catch { /* best effort */ }
              }
            }
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "[T12-RED] Browser Control service creation preserves a foreign replacement detected at the write fault boundary",
  () => {
    /**
     * Detected-replacement case at the known FS fault boundary (portable, not a
     * simulated UID attack): the owned unit is opened with `wx` and written
     * through the returned fd, but between the open and the write the fixed path
     * is swapped for a FOREIGN regular file and the write faults (`EIO`). The
     * path no longer names the fd's inode, so any path-based cleanup deletes the
     * foreign file. `ensure` must fail closed and preserve the foreign bytes and
     * inode: it must not claim ownership and must not read back the swapped file
     * as its own. Today both the write catch and the readback branch call
     * `rmSync(unitPath)` blind, so this is RED on the first assertion.
     */
    it("fails closed and keeps the foreign file when the opened fd write faults after an external swap", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-writefault-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      try {
        await withCreatedManagedServiceUnit(
          {
            prefix: ".jorgex-browser-control-service-writefault-",
            registerOwnedRoot: (root) => ownedRoots.push(root),
            base: verificationBase(),
          },
          (fixture) => {
            // Fresh, absent unit: drop the owned file the fixture created so the
            // next `ensure` takes the creation path with no prior claim/binding.
            fs.rmSync(fixture.unitPath);

            const foreignBytes = Buffer.from(
              [
                "[Unit]",
                "Description=foreign replacement detected at the write boundary",
                "",
                "[Service]",
                "ExecStart=/usr/bin/foreign-browser-control serve",
                "",
              ].join("\n"),
              "utf8",
            );
            let foreignInode: number | undefined;
            let swapped = false;
            const originalWriteFileSync = fs.writeFileSync;
            const writeSpy = vi.spyOn(fs, "writeFileSync");
            writeSpy.mockImplementation(((file: unknown, content: unknown, options: unknown) => {
              // Only the opened-fd write belongs to the detected boundary.
              if (typeof file !== "number") {
                return originalWriteFileSync(file as string, content as string, options as never);
              }
              // The owned bytes land on the still-open fd/inode first.
              originalWriteFileSync(file, content as never, options as never);
              // Known replacement point: move the owned inode aside and place a
              // foreign regular file at the fixed path, then fault the write.
              fs.renameSync(fixture.unitPath, `${fixture.unitPath}.owned-backup`);
              originalWriteFileSync(fixture.unitPath, foreignBytes);
              foreignInode = fs.statSync(fixture.unitPath).ino;
              swapped = true;
              const error = new Error(
                "EIO: simulated fault after the foreign replacement",
              ) as NodeJS.ErrnoException;
              error.code = "EIO";
              throw error;
            }) as typeof fs.writeFileSync);

            let result: BrowserControlServiceResult | undefined;
            try {
              result = fixture.ensure({
                stateDir: fixture.stateDir,
                unitPath: fixture.unitPath,
                prevOwned: [],
              });
            } finally {
              // Restore the global spy before the owned root teardown.
              writeSpy.mockRestore();
            }

            if (result === undefined) throw new Error("fixture: ensure did not return a result");
            if (!swapped) throw new Error("fixture: the opened-fd write was never intercepted");
            expect(
              fs.existsSync(fixture.unitPath),
              "the detected foreign replacement must be preserved, not deleted by path",
            ).toBe(true);
            expect(fs.readFileSync(fixture.unitPath), "the foreign bytes must survive verbatim").toEqual(foreignBytes);
            expect(fs.statSync(fixture.unitPath).ino, "the preserved file must be the foreign inode").toBe(foreignInode);
            expect(result.kind, "a detected replacement at the write fault must fail closed").toBe("error");
            expect(result, "no ownership claim may be emitted for the foreign file").not.toHaveProperty("binding");
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "[T12] Browser Control service creation preserves same-inode byte drift detected at readback",
  () => {
    /**
     * Drift-at-readback case, distinct from the substitution case above: the
     * owned unit is opened with `wx`, the fd write completes normally (no EIO),
     * but before the producer readback an external writer mutates the SAME
     * inode through the path (`r+` + truncate, no new inode) with foreign bytes.
     * The path still names the fd's inode, so an inode-only cleanup would delete
     * it; the cleanup must ALSO require the bytes to equal the expected write and
     * therefore preserve the drifted artifact without claiming ownership. This
     * proves observable-change detection for the same UID: it does not promise a
     * portable CAS against deliberate same-UID manipulation.
     */
    it("fails closed and keeps the drifted bytes and inode when a same-inode external write lands before readback", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-readback-drift-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      try {
        await withCreatedManagedServiceUnit(
          {
            prefix: ".jorgex-browser-control-service-readback-drift-",
            registerOwnedRoot: (root) => ownedRoots.push(root),
            base: verificationBase(),
          },
          (fixture) => {
            // Fresh, absent unit: drop the owned file the fixture created so the
            // next `ensure` takes the creation path with no prior claim/binding.
            fs.rmSync(fixture.unitPath);

            const foreignBytes = Buffer.from(
              [
                "[Unit]",
                "Description=external same-inode drift before readback",
                "",
                "[Service]",
                "ExecStart=/usr/bin/foreign-browser-control serve",
                "",
              ].join("\n"),
              "utf8",
            );
            const originalWriteFileSync = fs.writeFileSync;
            const writeSpy = vi.spyOn(fs, "writeFileSync");
            let openedInode: number | undefined;
            let drifted = false;
            writeSpy.mockImplementation(((file: unknown, content: unknown, options: unknown) => {
              // Only the owned fd write belongs to the boundary; any path write
              // is delegated untouched.
              if (typeof file !== "number") {
                return originalWriteFileSync(file as string, content as string, options as never);
              }
              // The canonical bytes land on the still-open fd/inode first.
              originalWriteFileSync(file, content as never, options as never);
              if (!drifted) {
                openedInode = fs.fstatSync(file).ino;
                // Known drift point: rewrite the SAME inode through the path
                // (`r+` + truncate keeps dev/ino) instead of replacing it.
                originalWriteFileSync(fixture.unitPath, foreignBytes, { flag: "r+" } as never);
                fs.truncateSync(fixture.unitPath, foreignBytes.length);
                drifted = true;
              }
              return undefined;
            }) as typeof fs.writeFileSync);

            let result: BrowserControlServiceResult | undefined;
            try {
              result = fixture.ensure({
                stateDir: fixture.stateDir,
                unitPath: fixture.unitPath,
                prevOwned: [],
              });
            } finally {
              // Restore the global spy before the owned root teardown.
              writeSpy.mockRestore();
            }

            if (result === undefined) throw new Error("fixture: ensure did not return a result");
            if (!drifted || openedInode === undefined) {
              throw new Error("fixture: the opened-fd write was never intercepted");
            }

            expect(
              fs.existsSync(fixture.unitPath),
              "the drifted same-inode artifact must be preserved, not deleted by inode match",
            ).toBe(true);
            expect(
              fs.readFileSync(fixture.unitPath),
              "the external drift bytes must survive verbatim",
            ).toEqual(foreignBytes);
            expect(
              fs.statSync(fixture.unitPath).ino,
              "the preserved artifact must still be the inode the fd created (no substitution)",
            ).toBe(openedInode);
            expect(result.kind, "external byte drift detected at readback must fail closed").toBe("error");
            expect(result, "no ownership claim may be emitted for the drifted file").not.toHaveProperty("binding");
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "[T12] Browser Control service uninstall keeps the owned unit and reports the pending service without a false success",
  () => {
    /**
     * Honest-status case for the artifact vertical. The owned unit exists with a
     * coherent ownership manifest (the explicit `ensure` claim plus its
     * `serviceUnit` binding). The authenticated supervisor stop/disable belongs
     * to the verified service lifecycle, so a real `runUninstall` cannot complete
     * the removal: it must keep the unit, its claim and its binding, and must
     * report the pending service with a non-zero exit instead of the global
     * success outro.
     *
     * The cached active is read by the REAL offline inspector
     * (`inspectCachedBrowserControlRuntime`, no module mock). `fetch` is poisoned
     * to prove no acquisition, the process boundary is poisoned to prove no
     * manager is invoked, and the ambient relay port is made invalid to prove
     * uninstall does not depend on it. Root state is observed from the real
     * manifest and filesystem, never from a mocked helper.
     */
    it("keeps the unit, claim and binding and returns a non-zero pending status", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-uninstall-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      try {
        await withCreatedManagedServiceUnit(
          {
            prefix: ".jorgex-browser-control-service-uninstall-",
            registerOwnedRoot: (root) => ownedRoots.push(root),
            base: verificationBase(),
          },
          async (fixture) => {
            const { writeRuntimeManifest, readManifest } = await import("../src/lib/manifest.js");
            // Coherent owned authority: the fixed unit is the only owned target
            // and its binding is the one `ensure` authenticated against the
            // retained active.
            writeRuntimeManifest("opencode", {
              configDir: fixture.configDir,
              owned: [fixture.unitPath],
              serviceUnit: fixture.binding,
              updatedAt: new Date().toISOString(),
            });

            // Ambient relay port defense: uninstall must never parse or use it.
            process.env.BROWSER_CONTROL_PORT = "not-a-port";

            // No acquisition: any registry/network attempt fails the run.
            const fetchPoison = vi.fn(() => {
              throw new Error("uninstall must not acquire Browser Control over the network");
            });
            vi.stubGlobal("fetch", fetchPoison);

            // No manager: no DI runner exists, so any spawn is a real regression.
            const managerSpies = [
              childProcessSpies.spawn,
              childProcessSpies.spawnSync,
              childProcessSpies.execFile,
              childProcessSpies.execFileSync,
            ];
            const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
            const poisonManager = (): never => {
              throw new Error("uninstall must not invoke a process manager");
            };
            for (const spy of managerSpies) spy.mockImplementation(poisonManager);

            const install = await import("../src/install.js");
            const adapter = install.ADAPTERS.opencode!;
            const originalDetect = adapter.detect;
            adapter.detect = () => ({
              id: "opencode",
              name: "OpenCode",
              installed: true,
              binPath: null,
              configDir: fixture.configDir,
            });

            let exitCode: number;
            try {
              const uninstall = await import("../src/uninstall.js");
              exitCode = await uninstall.runUninstall({
                runtimes: ["opencode"],
                dryRun: false,
                yes: true,
                removeEngram: false,
                removePlaywright: false,
              });
            } finally {
              adapter.detect = originalDetect;
              managerSpies.forEach((spy, index) => {
                const previous = previousImplementations[index];
                if (previous === undefined) spy.mockReset();
                else spy.mockImplementation(previous);
              });
            }

            const manifestRow = readManifest().runtimes.opencode;
            const ownedAfter = (manifestRow?.owned ?? []).map((file) => path.resolve(file));
            const diagnostics = [...prompts.log.warn.mock.calls, ...prompts.log.error.mock.calls]
              .map((call) => String(call[0] ?? ""));
            const outroMessages = prompts.outro.mock.calls.map((call) => String(call[0] ?? ""));

            // The pending service is a real, not-yet-completed removal: the exit
            // code and the final outro must not claim a clean full success...
            expect.soft(
              exitCode,
              "a pending Browser Control service removal must not return the clean-success exit 0",
            ).not.toBe(0);
            expect.soft(
              outroMessages.some((message) => /^Hecho\./.test(message)),
              `the global success outro must not be printed while the service is pending (got ${JSON.stringify(outroMessages)})`,
            ).toBe(false);
            expect.soft(
              diagnostics.some((message) =>
                message.includes(SERVICE_UNIT_FILENAME) && /conserva|pendiente/i.test(message),
              ),
              `an actionable pending-service diagnostic must name the preserved unit (got ${JSON.stringify(diagnostics)})`,
            ).toBe(true);

            // ...while the owned artifact, its claim and its binding stay intact.
            expect.soft(fs.existsSync(fixture.unitPath), "the owned unit file must survive").toBe(true);
            expect.soft(fs.readFileSync(fixture.unitPath), "the unit bytes must be untouched").toEqual(fixture.unitBytes);
            expect.soft(fs.statSync(fixture.unitPath).ino, "the unit inode must be untouched").toBe(fixture.inode);
            expect.soft(ownedAfter, "the manifest must keep the unit claim").toContain(path.resolve(fixture.unitPath));
            expect.soft(manifestRow?.serviceUnit, "the serviceUnit binding must survive verbatim").toEqual(fixture.binding);

            // No acquisition and no manager boundary were touched.
            expect.soft(fetchPoison, "uninstall must not perform network acquisition").not.toHaveBeenCalled();
            for (const spy of managerSpies) {
              expect.soft(spy, "uninstall must not spawn a manager process").not.toHaveBeenCalled();
            }
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);

interface PendingUninstallAuthority {
  readonly uninstallExitCode: number;
  /** Granular autostart authority copied verbatim from the manifest before uninstall. */
  readonly stampBefore: BrowserControlAutostartStamp | undefined;
  readonly serviceUnitBefore: ManagedBrowserControlServiceBinding | undefined;
  readonly unitBytesBefore: Buffer;
  readonly unitInodeBefore: number;
  /** Poison-call baseline immediately before the removal and its post-run delta. */
  readonly fetchCallBaseline: number;
  readonly fetchCallDelta: number;
  readonly managerCallBaseline: number;
  readonly managerCallDelta: number;
  readonly diagnostics: readonly string[];
}

/**
 * Real `runUninstall` against the service a real `runInstall` just verified, in
 * the same private HOME. `fetch` and the process boundary are poisoned so the
 * pending removal must prove no acquisition and no manager mutation, mirroring
 * the direct uninstall case. The code under test is the existing uninstall
 * manifest-write branch, never a forged manager/controller reply.
 */
async function runPendingUninstallInPlace(ctx: VerifiedServiceContext): Promise<PendingUninstallAuthority> {
  const { readManifest } = await import("../src/lib/manifest.js");
  const rowBefore = readManifest().runtimes["opencode"] as AutostartManifestRow | undefined;
  const unitBytesBefore = fs.readFileSync(ctx.unitPath);
  const unitInodeBefore = fs.statSync(ctx.unitPath).ino;

  // Ambient relay port defense: uninstall must never parse or use it.
  process.env.BROWSER_CONTROL_PORT = "not-a-port";

  const fetchPoison = vi.fn(() => {
    throw new Error("uninstall must not acquire Browser Control over the network");
  });
  vi.stubGlobal("fetch", fetchPoison);

  const managerSpies = [...childProcessDelegates];
  const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
  const poisonManager = (): never => {
    throw new Error("uninstall must not invoke a process manager");
  };
  for (const spy of managerSpies) spy.mockImplementation(poisonManager);

  const install = await import("../src/install.js");
  const adapter = install.ADAPTERS.opencode!;
  const originalDetect = adapter.detect;
  adapter.detect = () => ({
    id: "opencode",
    name: "OpenCode",
    installed: true,
    binPath: null,
    configDir: ctx.configDir,
  });

  let uninstallExitCode: number;
  let fetchCallBaseline = 0;
  let fetchCallDelta = 0;
  let managerCallBaseline = 0;
  let managerCallDelta = 0;
  try {
    const uninstall = await import("../src/uninstall.js");
    // Snapshot immediately before the removal: the preceding install phase runs
    // real delegates (the OpenCode v2 `--version` gate), so the absolute count
    // would misattribute those calls to the uninstall. The contract is the
    // DELTA over all four process delegates.
    fetchCallBaseline = fetchPoison.mock.calls.length;
    managerCallBaseline = processDelegateCallTotal();
    uninstallExitCode = await uninstall.runUninstall({
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: false,
    });
    fetchCallDelta = fetchPoison.mock.calls.length - fetchCallBaseline;
    managerCallDelta = processDelegateCallTotal() - managerCallBaseline;
  } finally {
    adapter.detect = originalDetect;
    managerSpies.forEach((spy, index) => {
      const previous = previousImplementations[index];
      if (previous === undefined) spy.mockReset();
      else spy.mockImplementation(previous);
    });
  }

  return {
    uninstallExitCode,
    stampBefore: rowBefore?.browserControlAutostart,
    serviceUnitBefore: rowBefore?.serviceUnit,
    unitBytesBefore,
    unitInodeBefore,
    fetchCallBaseline,
    fetchCallDelta,
    managerCallBaseline,
    managerCallDelta,
    diagnostics: [...prompts.log.warn.mock.calls, ...prompts.log.error.mock.calls]
      .map((call) => String(call[0] ?? "")),
  };
}

describe.skipIf(process.platform !== "linux")(
  "[T12-RED] Browser Control pending uninstall preserves the verified service autostart authority",
  () => {
    /**
     * Authority-loss case on the REAL install→uninstall lifecycle. A real
     * `runInstall` with the explicit Linux opt-in creates and supervises the
     * owned unit, pins the canonical `BROWSER_CONTROL_AUTOSTART=false` + literal
     * port on the managed MCP and records the granular
     * `browserControlAutostart` stamp. The authenticated stop/disable lifecycle
     * does not exist yet, so the real `runUninstall` must leave the unit, its
     * claim and its binding pending.
     *
     * The granular authority must survive exactly as recorded: the pending
     * branch currently rewrites the manifest row with only `owned` and
     * `serviceUnit`, silently dropping `browserControlAutostart` while the
     * canonical manual-free environment it authorizes stays in the config, so a
     * later recovery can no longer tell a Stack-introduced environment from a
     * user's manual one. The first RED is the lost stamp (`manifestAutostart`
     * undefined after the pending uninstall); the preserved unit/claim/binding
     * and environment are scenario integrity.
     */
    it("keeps the granular autostart authority verbatim across a pending uninstall", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-pending-authority-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const port = await reserveOwnedLoopbackPort();
      let evidence: PendingUninstallAuthority | undefined;
      try {
        // The install runs the real supervisor and produces the stamp; the
        // callback then runs the real uninstall in the same private HOME, so the
        // observables below witness the pending-removal state.
        const observables = await runServiceInstall({
          prefix: ".jorgex-browser-control-service-pending-authority-",
          registerOwnedRoot: (root) => ownedRoots.push(root),
          base: verificationBase(),
          browserControlService: true,
          supervisor: { port },
          onVerified: async (ctx) => {
            evidence = await runPendingUninstallInPlace(ctx);
          },
        });

        if (evidence === undefined) {
          throw new Error("fixture: the in-place uninstall callback did not run");
        }
        const shown = evidence;

        // Scenario integrity: the supervised install produced the granular
        // authority the uninstall must not drop. The install exit code is not
        // asserted here because the harness reports other unrelated pending
        // state; the stamp itself is the precondition.
        expect(
          shown.stampBefore,
          "the verified install must have recorded the granular autostart authority before uninstall",
        ).toBeDefined();

        // The removal is honestly pending: never a clean success.
        expect(
          shown.uninstallExitCode,
          "a pending Browser Control removal must not return the clean-success exit 0",
        ).not.toBe(0);
        expect(
          prompts.outro.mock.calls.map((call) => String(call[0] ?? "")).some((message) => /^Hecho\./.test(message)),
          "the global success outro must not be printed while the service is pending",
        ).toBe(false);
        expect(
          shown.diagnostics.some((message) =>
            message.includes(SERVICE_UNIT_FILENAME) && /conserva|pendiente/i.test(message),
          ),
          `the pending-service diagnostic must name the preserved unit (got ${JSON.stringify(shown.diagnostics)})`,
        ).toBe(true);

        // The owned artifact, its claim and its binding survive verbatim.
        expect(observables.unitBytes, "the owned unit file must survive the pending uninstall").not.toBeNull();
        expect(observables.unitBytes, "the unit bytes must be untouched").toEqual(shown.unitBytesBefore);
        expect(fs.statSync(observables.unitPath).ino, "the unit inode must be untouched").toBe(shown.unitInodeBefore);
        expect(
          observables.manifestOwned.map((file) => path.resolve(file)),
          "the manifest must keep the unit claim",
        ).toContain(path.resolve(observables.unitPath));
        expect(
          observables.manifestServiceUnit,
          "the serviceUnit binding must survive verbatim",
        ).toEqual(shown.serviceUnitBefore);

        // PRIMARY RED: the pending manifest write only preserves `owned` and
        // `serviceUnit` today, so the granular authority is lost here.
        expect(
          observables.manifestAutostart,
          "the pending uninstall must preserve the granular autostart authority verbatim",
        ).toEqual(shown.stampBefore);

        // The canonical manual-free environment the authority covers is retained,
        // asserting only the two owned fields (no whole-object ownership of user
        // extras), so recovery can still resolve what Stack introduced.
        expect(observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART).toBe("false");
        expect(observables.mcpEnvironment?.BROWSER_CONTROL_PORT).toBe(String(port));

        // The install phase legitimately invokes the process boundary (the
        // OpenCode v2 `--version` gate), so the contract is the removal's DELTA
        // across all four delegates: none may advance past the pre-removal
        // snapshot. No acquisition and no manager boundary were touched.
        expect(
          shown.fetchCallDelta,
          "the uninstall must not perform network acquisition",
        ).toBe(0);
        expect(
          shown.managerCallDelta,
          "the uninstall must not spawn a manager process",
        ).toBe(0);
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);
