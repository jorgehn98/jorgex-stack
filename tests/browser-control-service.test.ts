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
import type { UninstallOptions } from "../src/uninstall.js";
import type {
  BrowserControlServiceResult,
  EnsureBrowserControlServiceInput,
} from "../src/lib/browser-control-service.js";
import type { BrowserControlReady } from "../src/lib/browser-control-runtime.js";
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
/**
 * External user edit of the projected owned `SKILL.md`: a regular, contained
 * UTF-8 file whose digest differs from the retained active, so the static
 * preflight must classify it `unknown` and block before any destructive effect.
 */
const USER_SKILL_BYTES = Buffer.from(
  ["---", "name: browser-control", "description: user-edited projected skill", "---", "", "# user edit", ""].join("\n"),
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

/** `UninstallOptions` intersection with the manager effect seam (declared until the source exposes it). */
export type BrowserControlServiceUninstallOptions = UninstallOptions & {
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

/**
 * Unreachable manager fixture for the pending/unknown controls: every query is
 * recorded and answered with a bounded, non-zero "cannot consult" reply. It
 * represents ONLY the external manager edge (no controller ready, no receipts)
 * and lets a case prove the removal issued read-only queries and never a
 * mutating verb, without invoking a real `systemctl`, DBus or a personal
 * service.
 */
function createUnreachableManagerFixture(): ManagerRunner {
  const calls: string[][] = [];
  const run: BrowserControlSystemctlRunner = async (args) => {
    calls.push([...args]);
    return { status: 1, stdout: "" };
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

/**
 * Manager-reported state at the moment of a `show`. A full-service-uninstall
 * case uses these readbacks to prove the pre-stop unit was operational and the
 * readback after `stop` credited it inactive/dead/PID0 with the OWN relay down
 * before `disable`, without snapshotting every interleaved read.
 */
interface SupervisorReadback {
  readonly active: boolean;
  readonly subState: string;
  readonly mainPid: number;
  readonly relayUp: boolean;
}

interface SupervisorManagerFixture extends ManagerRunner {
  /** Ordered external-boundary log: manager calls and the served `/version`. */
  readonly events: string[];
  readonly versionRequests: string[];
  /** State reported by each `show`, in call order (one entry per `show`). */
  readonly readbacks: SupervisorReadback[];
  readonly close: () => Promise<void>;
  /**
   * Stops ONLY this fixture's own `/version` server and makes the fake manager
   * report the owned unit loaded/inactive/dead/MainPID=0 (no mutation verb is
   * recorded): the rotation case needs unit A credibly inactive and the relay
   * absent before it promotes B.
   */
  readonly deactivate: () => Promise<void>;
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
   * pid declared by the served `/version`, independent of the manager
   * `MainPID`. Defaults to this process so the positive readiness contract
   * (`HTTP pid === readback MainPID`) is grounded in a real process; a distinct
   * value models an external responder that is NOT the unit the manager started.
   */
  readonly versionPid?: number;
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
  const readbacks: SupervisorReadback[] = [];
  let reloaded = false;
  let started = false;
  let enabled = false;
  let server: Server | undefined;

  const showOutput = (): string => {
    const lines = [
      `Id=${SERVICE_UNIT_FILENAME}`,
      `LoadState=${reloaded ? "loaded" : "not-found"}`,
      `FragmentPath=${reloaded ? input.unitPath : ""}`,
      "DropInPaths=",
      "NeedDaemonReload=no",
      `UnitFileState=${enabled ? "enabled" : "disabled"}`,
      `ActiveState=${started ? "active" : "inactive"}`,
      `SubState=${started ? "running" : "dead"}`,
      // MainPID is part of the manager identity: 0 is the documented
      // "no main process" value for an inactive/dead unit.
      `MainPID=${started ? process.pid : 0}`,
    ];
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
            pid: input.versionPid ?? process.pid,
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
        readbacks.push({
          active: started,
          subState: started ? "running" : "dead",
          mainPid: started ? process.pid : 0,
          relayUp: server !== undefined,
        });
        return { status: 0, stdout: showOutput() };
      case "daemon-reload":
        reloaded = true;
        return { status: 0, stdout: "" };
      case "enable":
        enabled = true;
        return { status: 0, stdout: "" };
      case "start":
        started = true;
        await startVersionServer();
        await input.onStart?.();
        return { status: 0, stdout: "" };
      case "stop":
        // The OWN `/version` server is the unit's relay: stopping the unit
        // closes it, and the fake manager now reports inactive/dead/PID0.
        started = false;
        await stopServer();
        return { status: 0, stdout: "" };
      case "disable":
        enabled = false;
        return { status: 0, stdout: "" };
      default:
        return { status: 1, stdout: "" };
    }
  };

  const stopServer = async (): Promise<void> => {
    const active = server;
    server = undefined;
    if (active === undefined) return;
    await new Promise<void>((resolve) => {
      active.closeAllConnections?.();
      active.close(() => resolve());
    });
  };

  return {
    calls,
    events,
    versionRequests,
    readbacks,
    run,
    close: stopServer,
    deactivate: async () => {
      // Own-server control: the unit is now inactive and the relay is absent.
      started = false;
      await stopServer();
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
 * `environment` (the exact map given by the case) on the managed launcher
 * already projected. Like a late manual config confirmation, it is genuine
 * external state, not a forged controller/manager reply.
 */
function writeManualBrowserControlEnvironment(
  configDir: string,
  environment: Readonly<Record<string, string>>,
): void {
  const file = path.join(configDir, "opencode.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcp?: { servers?: Record<string, { environment?: Record<string, string> }> };
  };
  const entry = config.mcp?.servers?.[BROWSER_CONTROL_SERVER];
  if (entry === undefined) throw new Error("fixture: the managed MCP must be projected before start");
  entry.environment = { ...environment };
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
  readonly supervisor?: { readonly port: number; readonly versionPid?: number };
  /**
   * When true, an EXTERNAL writer (the user) sets the manual native MCP
   * `environment` to the exact canonical values while the manager `start` verb
   * runs — i.e. between the original MCP projection and the final reconcile.
   */
  readonly manualEnvironmentAtStart?: boolean;
  /**
   * When present, an EXTERNAL writer (the user) sets the manual native MCP
   * `environment` to this exact map while the manager `start` verb runs. Unlike
   * `manualEnvironmentAtStart` it can carry user extras and omit canonical
   * fields, modelling a hand-written environment Stack must merge into rather
   * than adopt by equality.
   */
  readonly manualEnvironment?: Readonly<Record<string, string>>;
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
  /** OpenCode binary used by the detection double, for an in-place second install. */
  readonly opencodeBin: string;
  /**
   * Mutable `ready` projection the mocked coordinator returns on each call: a
   * case may authenticate a promoted active B and hand its real invocation (with
   * the previous active A projection) to a second `runInstall`.
   */
  readonly runtime: { current: BrowserControlReady };
  /** Supervisor manager fixture: own-server control plus runner/call log. */
  readonly manager?: SupervisorManagerFixture;
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
    const ready: BrowserControlReady = {
      kind: "ready",
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
    // Mutable coordinator projection: a case may hand the next call an
    // authenticated active B (with the previous A projection) without re-mocking.
    const runtime: { current: BrowserControlReady } = { current: ready };
    vi.doMock("../src/lib/browser-control-runtime.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/lib/browser-control-runtime.js")>(
          "../src/lib/browser-control-runtime.js",
        );
      return {
        ...actual,
        prepareBrowserControlRuntime: async () => runtime.current,
        inspectCachedBrowserControlRuntime: () => runtime.current,
      };
    });

    const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), { output: "opencode v2.0.20" });
    const install = await import("../src/install.js");
    const { readManifest } = await import("../src/lib/manifest.js");
    const supervisorSpec = input.supervisor;
    let supervisor: SupervisorManagerFixture | undefined;
    if (supervisorSpec !== undefined) {
      const manualEnvironment = input.manualEnvironment
        ?? (input.manualEnvironmentAtStart === true
          ? { BROWSER_CONTROL_AUTOSTART: "false", BROWSER_CONTROL_PORT: String(supervisorSpec.port) }
          : undefined);
      supervisor = createSupervisorManagerFixture({
        unitPath,
        port: supervisorSpec.port,
        ...(supervisorSpec.versionPid === undefined ? {} : { versionPid: supervisorSpec.versionPid }),
        ...(manualEnvironment === undefined
          ? {}
          : { onStart: () => writeManualBrowserControlEnvironment(configDir, manualEnvironment) }),
      });
    }
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
    }

    // The case may now act on the verified root (same private HOME) while this
    // test's OWN listener is still up, so a full-service-uninstall preflight can
    // observe the operational relay before `stop` closes it. Observables below
    // are read afterwards, so they witness the later state.
    try {
      if (input.onVerified !== undefined) {
        await input.onVerified({
          configDir,
          unitPath,
          opencodeBin,
          runtime,
          ...(supervisor === undefined ? {} : { manager: supervisor }),
        });
      }
    } finally {
      // Close this test's own listener (and its connections) before any owned
      // root is removed by the caller's cleanup.
      await supervisor?.close();
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

interface ServiceRotationEvidence {
  /** Granular authority recorded by the real supervised A before B is promoted. */
  readonly stampBefore: BrowserControlAutostartStamp | undefined;
  /** Unit A binding recorded by the real supervised A. */
  readonly bindingBefore: ManagedBrowserControlServiceBinding | undefined;
  readonly unitBytesBefore: Buffer;
  /** MCP command projected by the real supervised A. */
  readonly commandBefore: readonly string[] | undefined;
  /** MCP environment (with the external user extra) right before the second run. */
  readonly environmentBefore: Record<string, unknown> | undefined;
  /** Exact managed launcher argv B must be projected with. */
  readonly expectedCommandB: readonly string[];
  /** Manager calls issued ONLY by the second `runInstall`. */
  readonly secondInstallCalls: readonly string[][];
  /** Exit code reported by the second real `runInstall`. */
  readonly secondInstallExitCode: number;
  /** Byte-for-byte managed config right before the second run (command A + user extra). */
  readonly configBytesBefore: Buffer;
  /** Byte-for-byte managed config right after the second run. */
  readonly configBytesAfter: Buffer;
  /** Authenticated active A identity captured while A is still the active. */
  readonly activeRootPathBefore: string;
  readonly activeReceiptShaBefore: string;
  /** Active identity after the second run: A when a failed rotation rolled back. */
  readonly activeRootPathAfter: string | null;
  readonly activeReceiptShaAfter: string | null;
  /** Exact authority row present during the second run (the tampered variant when requested). */
  readonly stampDuringSecondRun: BrowserControlAutostartStamp | undefined;
}

/** Optional tamper of the recorded authority applied before the second run. */
interface ServiceRotationInput {
  /**
   * Valid-but-wrong 64-hex digest written into the recorded autostart authority
   * before the second run. The environment, unit file and launcher guard stay
   * untouched: only the recorded `projectionSha256` is corrupted, so the
   * authority no longer authenticates against active A.
   */
  readonly tamperProjectionSha256?: string;
  /**
   * Origin of the port already declared on the managed MCP before the rotation.
   * `"stack"` (default): the first supervised install introduced the canonical
   * pair, so this helper seeds the unrelated user extra. `"manual"`: the user
   * hand-wrote the coherent literal port plus the extra during the first install
   * (`manualEnvironment`), so the helper must not re-seed them and the case
   * proves they came from the harness, not from the rotation.
   */
  readonly portOrigin?: "stack" | "manual";
}

/**
 * Rotation control for the `portOwned:true` case. After the real supervised
 * install of A produced its granular authority, it stops ONLY this fixture's own
 * `/version` server (so the fake manager reports the owned unit
 * loaded/inactive/dead/MainPID=0 without any mutation verb), promotes the
 * distinct verified active B through the real managed activation (real
 * FS/crypto) and runs a second real `runInstall` whose coordinator projection is
 * B with the authenticated previous A. The ENV reconcile under test runs real:
 * nothing here fakes it.
 *
 * The acquisition DTO is modelled faithfully: `previous` carries A's
 * authenticated invocation and `rollback` is the REAL public
 * `rollbackManagedBrowserActivation` bound to B's receipt and A's receipt, so a
 * failed rotation that must restore A is never simulated by a mock. With
 * `tamperProjectionSha256` the recorded authority is corrupted in place (and
 * only there) right before the second run, modelling a drifted/foreign stamp
 * whose provenance Stack cannot authenticate.
 */
async function advanceInactiveServiceAToB(
  ctx: VerifiedServiceContext,
  input: ServiceRotationInput = {},
): Promise<ServiceRotationEvidence> {
  const manager = ctx.manager;
  if (manager === undefined) {
    throw new Error("fixture: the service rotation requires the supervisor manager");
  }
  const { readManifest, writeRuntimeManifest } = await import("../src/lib/manifest.js");
  const rowBefore = readManifest().runtimes.opencode as AutostartManifestRow | undefined;
  const unitBytesBefore = fs.readFileSync(ctx.unitPath);

  const configPath = path.join(ctx.configDir, "opencode.json");
  type ProjectedConfig = {
    mcp?: { servers?: Record<string, { command?: string[]; environment?: Record<string, unknown> }> };
  };
  const configBefore = JSON.parse(fs.readFileSync(configPath, "utf8")) as ProjectedConfig;
  const entryBefore = configBefore.mcp?.servers?.[BROWSER_CONTROL_SERVER];
  if (entryBefore === undefined) {
    throw new Error("fixture: the managed Browser Control MCP must exist before the rotation");
  }
  // External user write: an unrelated extra must survive the environment removal.
  // With a Stack-owned port this helper seeds it; with a manual port the first
  // install already carried it, so the case proves the harness, not the helper,
  // introduced the manual literal and the extra.
  if ((input.portOrigin ?? "stack") === "stack") {
    entryBefore.environment = { ...(entryBefore.environment ?? {}), USER_NOTE: "preserve-me" };
  }
  fs.writeFileSync(configPath, `${JSON.stringify(configBefore, null, 2)}\n`);
  const commandBefore = entryBefore.command;
  const environmentBefore = entryBefore.environment;
  // Snapshot the exact managed config the second run must leave untouched when
  // the authority cannot be authenticated.
  const configBytesBefore = fs.readFileSync(configPath);

  const stateDir = path.join(process.env.HOME!, ".jorgex-stack");
  const {
    activateManagedBrowserTree,
    loadVerifiedRetainedBrowserRelease,
    planManagedBrowserInvocation,
    planManagedBrowserInvocationForRetainedRelease,
    rollbackManagedBrowserActivation,
  } = await import("../src/lib/browser-managed.js");
  const { browserTreeSha256 } = await import("../src/lib/browser-stage.js");

  // A's authenticated projection is captured while A is still the active.
  const activeA = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);
  if (activeA === null) throw new Error("fixture: the first install must retain an active A");
  const activeRootPathBefore = activeA.receipt.rootPath;
  const activeReceiptShaBefore = activeA.receiptSha256;
  const invocationA = planManagedBrowserInvocationForRetainedRelease(activeA, ["mcp"]);
  const skillSourceA = path.join(
    activeA.receipt.treePath,
    "@opencode-ai",
    "browser-control",
    "skills",
    BROWSER_CONTROL_SERVER,
    "SKILL.md",
  );

  // Corrupt ONLY the recorded projection digest when requested: the environment,
  // unit file and launcher guard remain untouched, so the authority no longer
  // authenticates against active A while every other input stays real.
  if (input.tamperProjectionSha256 !== undefined) {
    const fullRow = readManifest().runtimes.opencode;
    if (fullRow === undefined || fullRow.browserControlAutostart === undefined) {
      throw new Error("fixture: the tamper variant requires the recorded autostart authority");
    }
    writeRuntimeManifest("opencode", {
      ...fullRow,
      browserControlAutostart: {
        ...fullRow.browserControlAutostart,
        projectionSha256: input.tamperProjectionSha256,
      },
      updatedAt: new Date().toISOString(),
    });
  }
  const stampDuringSecondRun = readManifest().runtimes.opencode?.browserControlAutostart;

  // Stop ONLY this fixture's own HTTP server: unit A is now credibly inactive
  // and the relay is absent on the owned port.
  await manager.deactivate();

  // Promote the distinct active B for real (managed FS + crypto).
  const witnessB = writeWitnessTree(path.join(path.dirname(stateDir), "witness-b"), {
    version: BC_VERSION_B,
    entryBytes: BC_ROOT_BYTES_B,
  });
  const receiptB = await activateManagedBrowserTree({
    stateDir,
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
  const readyB: BrowserControlReady = {
    kind: "ready",
    version: receiptB.version,
    invocation: planManagedBrowserInvocation(stateDir, BC_PACKAGE, ["mcp"]),
    skillSource: path.join(
      receiptB.treePath,
      "@opencode-ai",
      "browser-control",
      "skills",
      BROWSER_CONTROL_SERVER,
      "SKILL.md",
    ),
    previous: { version: activeA.receipt.version, invocation: invocationA, skillSource: skillSourceA },
    // The real acquisition DTO always ships this bounded recovery when it
    // promoted a new active: restore A (or remove B) through the public API.
    rollback: async () => {
      await rollbackManagedBrowserActivation(stateDir, BC_PACKAGE, receiptB, activeA.receipt);
    },
  };
  ctx.runtime.current = readyB;
  const expectedCommandB = [readyB.invocation.command, ...readyB.invocation.args];

  const install = await import("../src/install.js");
  const opencode = install.ADAPTERS.opencode!;
  const originalDetect = opencode.detect;
  opencode.detect = () => ({
    id: "opencode",
    name: "OpenCode",
    installed: true,
    binPath: ctx.opencodeBin,
    configDir: ctx.configDir,
  });

  const callsBefore = manager.calls.length;
  let secondInstallExitCode: number;
  try {
    secondInstallExitCode = await install.runInstall({
      runtimes: ["opencode"],
      command: "install",
      dryRun: false,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
      engramBin: null,
      browserControlService: true,
      systemctlRunner: manager.run,
    });
  } finally {
    opencode.detect = originalDetect;
  }

  const configBytesAfter = fs.readFileSync(configPath);
  const activeAfter = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);

  return {
    stampBefore: rowBefore?.browserControlAutostart,
    bindingBefore: rowBefore?.serviceUnit,
    unitBytesBefore,
    commandBefore,
    environmentBefore,
    expectedCommandB,
    secondInstallCalls: manager.calls.slice(callsBefore),
    secondInstallExitCode,
    configBytesBefore,
    configBytesAfter,
    activeRootPathBefore,
    activeReceiptShaBefore,
    activeRootPathAfter: activeAfter?.receipt.rootPath ?? null,
    activeReceiptShaAfter: activeAfter?.receiptSha256 ?? null,
    stampDuringSecondRun,
  };
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
   * A→B rotation with a Stack-owned port (Spec T13, authority granular del
   * entorno). A real supervised install of A records the `portOwned:true`
   * authority and introduces the canonical FALSE + literal port on the managed
   * MCP. Then ONLY the fixture's own `/version` server is stopped and the fake
   * manager reports unit A loaded/inactive/dead/MainPID=0; the distinct verified
   * active B is promoted through the real managed activation and a second real
   * `runInstall` projects B's managed launcher.
   *
   * Contract: before changing the command A→B Stack authenticates the recorded
   * authority against A, and because the service is credibly inactive and the
   * relay absent it retires ONLY the environment it introduced — the canonical
   * FALSE and the still-canonical owned port — preserving the user extra, unit A
   * and binding A, and projects B with native autostart. The stamp is retired
   * after the readback and the second run issues only read-only manager probes
   * (no daemon-reload/enable/start/restart/reload). RED today: the occupied unit
   * branch keeps the stale FALSE/port and the stamp while the command advances.
   */
  it("retires the Stack-owned autostart environment and preserves unit/binding A when an inactive service A is advanced to B", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-rotation-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    let rotation: ServiceRotationEvidence | undefined;
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-rotation-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
        onVerified: async (ctx) => {
          rotation = await advanceInactiveServiceAToB(ctx);
        },
      });
      if (rotation === undefined) throw new Error("fixture: the rotation callback did not run");
      const shown = rotation;

      // Scenario integrity: the real supervised A recorded its granular
      // authority, introduced the canonical pair and the user extra landed
      // before the second run.
      expect(shown.stampBefore, "the supervised A must have recorded its granular authority").toBeDefined();
      expect(shown.stampBefore?.portOwned, "the introduced port belongs to Stack").toBe(true);
      expect(shown.bindingBefore, "the supervised A must have recorded its unit binding").toBeDefined();
      expect(shown.environmentBefore).toMatchObject({
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(port),
        USER_NOTE: "preserve-me",
      });
      expect(
        shown.commandBefore,
        "scenario integrity: the pre-rotation MCP command must be A's, not B's",
      ).not.toEqual(shown.expectedCommandB);

      // B is projected with its real managed launcher guard.
      expect(
        observables.mcpCommand,
        "the MCP must advance to B's real managed invocation",
      ).toEqual(shown.expectedCommandB);
      expect(observables.mcpCommand?.[0]).toBe(process.execPath);
      expect(observables.mcpCommand?.slice(-1)).toEqual(["mcp"]);

      // Stack retires ONLY the environment it introduced: the canonical FALSE
      // and the still-canonical port disappear, the user extra survives.
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART,
        "the Stack-introduced FALSE must be retired",
      ).toBeUndefined();
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_PORT,
        "the Stack-introduced canonical port must be retired",
      ).toBeUndefined();
      expect(observables.mcpEnvironment?.USER_NOTE, "the user extra must survive").toBe("preserve-me");

      // The granular authority is retired after the readback.
      expect(
        observables.manifestAutostart,
        "the retired environment must not keep its autostart authority",
      ).toBeUndefined();

      // Unit A and its binding are preserved verbatim: no rewrite, no restart.
      expect(observables.unitBytes, "unit A must survive the rotation").not.toBeNull();
      expect(observables.unitBytes, "unit A bytes must be untouched").toEqual(shown.unitBytesBefore);
      expect(observables.manifestServiceUnit, "binding A must survive verbatim").toEqual(shown.bindingBefore);

      // The second run issues read-only manager probes only: it must credit the
      // unit inactive (at least one `show`) and never mutate it.
      const secondVerbs = shown.secondInstallCalls
        .map((argv) => serviceVerb(argv))
        .filter((verb): verb is string => verb !== undefined);
      expect(
        secondVerbs,
        "the second run must credit unit A inactive with a manager read",
      ).toContain("show");
      for (const forbidden of [
        "daemon-reload",
        "enable",
        "start",
        "restart",
        "reload",
        "stop",
        "disable",
        "mask",
        "linger",
      ]) {
        expect(
          secondVerbs,
          `the second run must not issue ${forbidden} on an already-verified unit`,
        ).not.toContain(forbidden);
      }
      expect(
        secondVerbs.every((verb) => verb === "show"),
        `the second run may only read the manager state (got ${JSON.stringify(secondVerbs)})`,
      ).toBe(true);
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  /**
   * A→B rotation with a MANUAL port (Spec T13, autoridad granular del entorno).
   * The real supervised install of A introduces only the canonical FALSE into an
   * environment whose literal managed port and `USER_NOTE` were hand-written by
   * the user (`manualEnvironment`), so the recorded stamp is the real
   * `portOwned:false` authority. Then ONLY the fixture's own `/version` server is
   * stopped and the fake manager reports unit A loaded/inactive/dead/MainPID=0;
   * the distinct verified active B is promoted through the real managed
   * activation and a second real `runInstall` projects B's managed launcher.
   *
   * Contract: Stack retires ONLY the FALSE it introduced and the stamp, and
   * preserves the manual port literal and the user extra verbatim — the manual
   * port was never Stack's, so it must not be removed with the owned pair. Unit A
   * and binding A survive untouched and the second run issues only read-only
   * manager probes. Result is GREEN when the code is correct: no RED is fabricated
   * for an already-implemented branch.
   */
  it("retires only the introduced FALSE and preserves the manual port and extras when an inactive service A is advanced to B", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-rotation-manual-port-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    const manualEnvironment = { BROWSER_CONTROL_PORT: String(port), USER_NOTE: "preserve-me" } as const;
    let rotation: ServiceRotationEvidence | undefined;
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-rotation-manual-port-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
        manualEnvironment,
        onVerified: async (ctx) => {
          rotation = await advanceInactiveServiceAToB(ctx, { portOrigin: "manual" });
        },
      });
      if (rotation === undefined) throw new Error("fixture: the rotation callback did not run");
      const shown = rotation;

      // Scenario integrity: the real supervised A recorded a `portOwned:false`
      // authority (the manual literal was never claimed by Stack), introduced the
      // canonical FALSE and the harness landed the user extra before the second
      // run.
      expect(shown.stampBefore, "the supervised A must have recorded its granular authority").toBeDefined();
      expect(
        shown.stampBefore?.portOwned,
        "the manual literal port must not be claimed by Stack",
      ).toBe(false);
      expect(shown.bindingBefore, "the supervised A must have recorded its unit binding").toBeDefined();
      expect(shown.bindingBefore?.port, "the binding must witness the managed port").toBe(port);
      expect(shown.environmentBefore).toMatchObject({
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(port),
        USER_NOTE: "preserve-me",
      });
      expect(
        shown.commandBefore,
        "scenario integrity: the pre-rotation MCP command must be A's, not B's",
      ).not.toEqual(shown.expectedCommandB);

      // B is projected with its real managed launcher guard.
      expect(
        observables.mcpCommand,
        "the MCP must advance to B's real managed invocation",
      ).toEqual(shown.expectedCommandB);
      expect(observables.mcpCommand?.[0]).toBe(process.execPath);
      expect(observables.mcpCommand?.slice(-1)).toEqual(["mcp"]);

      // Stack retires ONLY the FALSE it introduced: the manual port literal and
      // the user extra survive verbatim.
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART,
        "the Stack-introduced FALSE must be retired",
      ).toBeUndefined();
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_PORT,
        "the manual port literal must survive verbatim",
      ).toBe(String(port));
      expect(observables.mcpEnvironment?.USER_NOTE, "the user extra must survive").toBe("preserve-me");

      // The granular authority is retired after the readback.
      expect(
        observables.manifestAutostart,
        "the retired environment must not keep its autostart authority",
      ).toBeUndefined();

      // Unit A and its binding are preserved verbatim: no rewrite, no restart.
      expect(observables.unitBytes, "unit A must survive the rotation").not.toBeNull();
      expect(observables.unitBytes, "unit A bytes must be untouched").toEqual(shown.unitBytesBefore);
      expect(observables.manifestServiceUnit, "binding A must survive verbatim").toEqual(shown.bindingBefore);

      // The second run issues read-only manager probes only: it must credit the
      // unit inactive (at least one `show`) and never mutate it.
      const secondVerbs = shown.secondInstallCalls
        .map((argv) => serviceVerb(argv))
        .filter((verb): verb is string => verb !== undefined);
      expect(
        secondVerbs,
        "the second run must credit unit A inactive with a manager read",
      ).toContain("show");
      for (const forbidden of [
        "daemon-reload",
        "enable",
        "start",
        "restart",
        "reload",
        "stop",
        "disable",
        "mask",
        "linger",
      ]) {
        expect(
          secondVerbs,
          `the second run must not issue ${forbidden} on an already-verified unit`,
        ).not.toContain(forbidden);
      }
      expect(
        secondVerbs.every((verb) => verb === "show"),
        `the second run may only read the manager state (got ${JSON.stringify(secondVerbs)})`,
      ).toBe(true);
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  /**
   * Negative authority authentication before the A→B transition (Spec T13): the
   * recorded granular authority is corrupted at the exact field that proves
   * which projection Stack introduced (`projectionSha256`), while the
   * environment, unit file and launcher guard stay untouched. Because the
   * authority no longer authenticates against active A, Stack must not advance
   * the managed MCP to B's command: it must fail closed and restore active A
   * through the acquisition DTO's REAL rollback BEFORE any write, leaving the
   * config byte-for-byte A (command, canonical FALSE/port and the user extra),
   * unit/binding A and the recorded authority unrewritten.
   *
   * RED today: the command is advanced to B first and the authority is only
   * checked afterwards, so the managed config keeps B's launcher with the stale
   * FALSE while active B is never rolled back to A.
   */
  it("fails closed and keeps the A projection when the recorded autostart authority does not authenticate before an A→B rotation", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-rotation-tamper-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    const tamperedProjectionSha256 = "ab".repeat(32);
    let rotation: ServiceRotationEvidence | undefined;
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-rotation-tamper-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
        onVerified: async (ctx) => {
          rotation = await advanceInactiveServiceAToB(ctx, { tamperProjectionSha256: tamperedProjectionSha256 });
        },
      });
      if (rotation === undefined) throw new Error("fixture: the rotation callback did not run");
      const shown = rotation;

      // Scenario integrity: A's real authority and binding were recorded, the
      // user extra landed and ONLY the recorded digest was corrupted.
      expect(shown.stampBefore, "the supervised A must have recorded its granular authority").toBeDefined();
      expect(shown.bindingBefore, "the supervised A must have recorded its unit binding").toBeDefined();
      expect(shown.stampDuringSecondRun, "the tampered authority must be present for the second run").toBeDefined();
      expect(shown.stampDuringSecondRun!.projectionSha256).toBe(tamperedProjectionSha256);
      expect(
        shown.stampDuringSecondRun!.projectionSha256,
        "the tampered digest must differ from A's authenticated digest",
      ).not.toBe(shown.stampBefore!.projectionSha256);
      expect(shown.stampDuringSecondRun!.schemaVersion).toBe(shown.stampBefore!.schemaVersion);
      expect(shown.stampDuringSecondRun!.portOwned).toBe(shown.stampBefore!.portOwned);
      expect(shown.environmentBefore).toMatchObject({
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(port),
        USER_NOTE: "preserve-me",
      });
      expect(
        shown.commandBefore,
        "scenario integrity: the pre-rotation MCP command must be A's, not B's",
      ).not.toEqual(shown.expectedCommandB);

      // The invalid authority is an honest failure, never a clean success.
      expect(
        shown.secondInstallExitCode,
        "an authority that does not authenticate must fail the run",
      ).not.toBe(0);

      // PRIMARY: the managed MCP must not advance to B before authenticating A.
      expect.soft(
        observables.mcpCommand,
        "the MCP must stay on A's launcher when the authority cannot authenticate",
      ).toEqual(shown.commandBefore);
      expect.soft(
        observables.mcpEnvironment,
        "the Stack-introduced FALSE/port and the user extra must stay A's",
      ).toEqual(shown.environmentBefore);
      expect.soft(
        shown.configBytesAfter,
        "the managed config must remain byte-for-byte A",
      ).toEqual(shown.configBytesBefore);

      // The preparation promoted B for real, so the REAL rollback must restore A.
      expect.soft(
        shown.activeRootPathAfter,
        "the promoted B must be rolled back to active A before any write",
      ).toBe(shown.activeRootPathBefore);
      expect.soft(
        shown.activeReceiptShaAfter,
        "active A must authenticate again after the rollback",
      ).toBe(shown.activeReceiptShaBefore);

      // Unit, binding and the (corrupt) authority must not be overwritten.
      expect.soft(observables.unitBytes, "unit A must survive untouched").toEqual(shown.unitBytesBefore);
      expect.soft(
        observables.manifestServiceUnit,
        "binding A must survive verbatim",
      ).toEqual(shown.bindingBefore);
      expect.soft(
        observables.manifestAutostart,
        "the recorded authority must not be rewritten or dropped",
      ).toEqual(shown.stampDuringSecondRun);

      // The failed rotation never mutates the manager: no reload/start/stop.
      const secondVerbs = shown.secondInstallCalls
        .map((argv) => serviceVerb(argv))
        .filter((verb): verb is string => verb !== undefined);
      for (const forbidden of [
        "daemon-reload",
        "enable",
        "start",
        "restart",
        "reload",
        "stop",
        "disable",
        "mask",
        "linger",
      ]) {
        expect.soft(
          secondVerbs,
          `the failed rotation must not issue ${forbidden} on unit A`,
        ).not.toContain(forbidden);
      }
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

  /**
   * Granular merge (Spec T13): the user hand-writes a valid/coherent manual
   * environment on the managed MCP — the literal managed port (equal to the one
   * the service will use) plus an unrelated `USER_NOTE`, and NO autostart flag.
   * Stack introduces the canonical `BROWSER_CONTROL_AUTOSTART=false` into that
   * existing environment, preserving the manual port literal and the user extra
   * verbatim, and records the granular authority with `portOwned:false`: the
   * port was already there, so it must not be claimed by equality with the
   * managed port. The verified-service marker is emitted only after the full
   * manager/version proof. Today the reconcile rejects any non-exact
   * `environment` as foreign/corrupt, so this is RED on the missing merge, the
   * missing `false`, the missing stamp and the missing marker.
   */
  it("merges the introduced FALSE into a manual MCP environment without claiming the manual port or dropping user extras", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-manual-merge-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    const manualEnvironment = { BROWSER_CONTROL_PORT: String(port), USER_NOTE: "preserve-me" } as const;
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-manual-merge-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        supervisor: { port },
        manualEnvironment,
      });

      // 1) Stack introduces the canonical FALSE while preserving the manual
      //    port literal and the user's extra field verbatim.
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART,
        "the verified service must introduce the canonical autostart FALSE",
      ).toBe("false");
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_PORT,
        "the manual port literal must survive verbatim",
      ).toBe(String(port));
      expect(
        observables.mcpEnvironment?.USER_NOTE,
        "the user extra must survive verbatim",
      ).toBe("preserve-me");

      // 2) The granular authority carries only the introduced fields, and the
      //    port was NOT introduced by Stack: `portOwned` must be false, never
      //    adopted by equality with the managed port.
      const stamp = observables.manifestAutostart;
      expect(stamp, "the verified service must record its granular autostart authority").toBeDefined();
      expect(Object.keys(stamp!).sort(), "only the introduced stamp fields are present").toEqual([
        "portOwned",
        "projectionSha256",
        "schemaVersion",
      ]);
      expect(stamp!.schemaVersion).toBe(1);
      expect(stamp!.portOwned).toBe(false);
      expect(stamp!.projectionSha256).toMatch(/^[0-9a-f]{64}$/);

      // 3) The managed-autostart success marker is emitted only after the full
      //    manager/version proof.
      const successMessages = prompts.log.success.mock.calls.map((call) => String(call[0] ?? ""));
      expect(
        successMessages.some((message) => /autostart/i.test(message)),
        `the verified service must emit the managed-autostart marker (got ${JSON.stringify(successMessages)})`,
      ).toBe(true);

      // 4) The owned unit, its claim and its serviceUnit binding survive the
      //    merge, bound to the preserved unit bytes.
      expect(observables.unitBytes, "the owned unit must be preserved").not.toBeNull();
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "the created unit must remain claimed",
      ).toContain(path.resolve(observables.unitPath));
      expect(observables.manifestServiceUnit, "the serviceUnit binding must remain").toBeDefined();
      expect(observables.manifestServiceUnit?.port, "the binding must witness the managed port").toBe(port);
      expect(
        observables.manifestServiceUnit?.unitSha256,
        "the binding must witness the preserved unit",
      ).toBe(createHash("sha256").update(observables.unitBytes!).digest("hex"));
    } finally {
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });

  /**
   * Negative readiness (Spec T12/T13): the manager reports the owned unit
   * active/running with `MainPID` = this process, but the served `/version`
   * declares a DIFFERENT pid. The pid equality is the identity proof that the
   * HTTP responder is the process the manager started; a mismatch means the
   * endpoint is not attributable to the unit, so the service must stay pending.
   * Stack must not claim the granular autostart authority, must not project the
   * canonical `BROWSER_CONTROL_AUTOSTART=false` + literal port on the managed
   * MCP, must not print the managed-autostart success marker, and must not roll
   * back the service it just started (no stop/disable/restart). The unit, its
   * owned claim and its binding must survive.
   */
  it("keeps the service pending without claiming autostart when the /version pid is not the unit MainPID", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-pid-mismatch-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const port = await reserveOwnedLoopbackPort();
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-pid-mismatch-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
        // The served /version reports a pid that is NOT the manager MainPID
        // (process.pid) on the same owned loopback port: a genuine external
        // responder, never a forged manager reply.
        supervisor: { port, versionPid: process.pid + 1 },
      });

      // Scenario integrity: the mismatch is observed during readiness, after
      // the service was created, enabled, started and its /version probed.
      expect(observables.unitBytes, "the owned unit must exist before readiness fails").not.toBeNull();
      const verbs = observables.systemctlCalls.map((argv) => serviceVerb(argv));
      expect(verbs, "the readiness comparison requires the started unit").toContain("start");
      expect(
        observables.versionRequests.length,
        "the supervisor must probe the owned /version endpoint",
      ).toBeGreaterThanOrEqual(1);

      // 1) Honest pending: an actionable diagnostic naming the preserved unit,
      //    never the managed-autostart success marker.
      const diagnostics = [
        ...prompts.log.warn.mock.calls.map((call) => String(call[0] ?? "")),
        ...prompts.log.error.mock.calls.map((call) => String(call[0] ?? "")),
      ];
      expect(
        diagnostics.some(
          (message) => message.includes(SERVICE_UNIT_FILENAME) && /pendiente|operativo/i.test(message),
        ),
        `the pid mismatch must be reported as a pending service (got ${JSON.stringify(diagnostics)})`,
      ).toBe(true);
      const successMessages = prompts.log.success.mock.calls.map((call) => String(call[0] ?? ""));
      expect(
        successMessages.some((message) => /autostart/i.test(message)),
        `the managed-autostart success marker must not be emitted for a pid mismatch (got ${JSON.stringify(successMessages)})`,
      ).toBe(false);

      // 2) No granular authority is stamped and no canonical managed
      //    environment is projected: the `false`/port pair belongs only to a
      //    VERIFIED service.
      expect(
        observables.manifestAutostart,
        "a pid mismatch must not stamp the granular autostart authority",
      ).toBeUndefined();
      expect(
        observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART,
        "an unverified service must not project the managed autostart environment",
      ).toBeUndefined();
      expect(observables.mcpEnvironment?.BROWSER_CONTROL_PORT).toBeUndefined();

      // 3) The failed readiness must not mutate the manager beyond the intended
      //    initial activation: no rollback, stop, disable or relaunch.
      const flattened = observables.systemctlCalls.flat();
      for (const forbidden of ["stop", "restart", "disable", "reload"]) {
        expect(flattened, `the pid mismatch must not issue ${forbidden}`).not.toContain(forbidden);
      }

      // 4) The owned artifact, its claim and its binding survive the pending
      //    readiness.
      expect(observables.unitBytes, "the owned unit file must survive").not.toBeNull();
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "the created unit must remain claimed",
      ).toContain(path.resolve(observables.unitPath));
      expect(observables.manifestServiceUnit, "the serviceUnit binding must remain").toBeDefined();
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

            // The explicit runner is the ONLY manager boundary and represents an
            // UNREACHABLE manager: the removal may only read it (show) and must
            // never issue a mutating verb, while no real process is spawned.
            const manager = createUnreachableManagerFixture();
            const managerSpies = [
              childProcessSpies.spawn,
              childProcessSpies.spawnSync,
              childProcessSpies.execFile,
              childProcessSpies.execFileSync,
            ];
            const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
            const poisonManager = (): never => {
              throw new Error("uninstall must not invoke a real process manager");
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
              const options: BrowserControlServiceUninstallOptions = {
                runtimes: ["opencode"],
                dryRun: false,
                yes: true,
                removeEngram: false,
                removePlaywright: false,
                systemctlRunner: manager.run,
              };
              exitCode = await uninstall.runUninstall(options);
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

            // The unreachable manager is only ever read: no mutating verb and no
            // real process boundary were touched.
            const managerVerbs = manager.calls.map((argv) => serviceVerb(argv));
            for (const forbidden of SERVICE_MUTATING_VERBS) {
              expect.soft(
                managerVerbs,
                `an unreachable manager must not trigger ${forbidden}`,
              ).not.toContain(forbidden);
            }
            expect.soft(
              manager.calls.every((argv) => serviceVerb(argv) === "show"),
              `the removal may only read the unreachable manager (got ${JSON.stringify(manager.calls)})`,
            ).toBe(true);
            expect.soft(fetchPoison, "uninstall must not perform network acquisition").not.toHaveBeenCalled();
            for (const spy of managerSpies) {
              expect.soft(spy, "uninstall must not spawn a real manager process").not.toHaveBeenCalled();
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
  /** Queries issued by the removal through the explicit UNREACHABLE manager runner. */
  readonly managerCalls: readonly string[][];
  readonly diagnostics: readonly string[];
}

/**
 * Real `runUninstall` against the service a real `runInstall` just verified, in
 * the same private HOME. `fetch` and the real process boundary are poisoned and
 * the explicit manager runner is an UNREACHABLE one, so the pending removal must
 * prove no acquisition, no real spawn and read-only manager queries. The code
 * under test is the existing uninstall branch, never a forged
 * manager/controller reply.
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

  // Explicit UNREACHABLE manager: the removal may only query it read-only.
  const manager = createUnreachableManagerFixture();

  const managerSpies = [...childProcessDelegates];
  const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
  const poisonManager = (): never => {
    throw new Error("uninstall must not invoke a real process manager");
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
    const options: BrowserControlServiceUninstallOptions = {
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: false,
      systemctlRunner: manager.run,
    };
    uninstallExitCode = await uninstall.runUninstall(options);
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
    managerCalls: manager.calls,
    diagnostics: [...prompts.log.warn.mock.calls, ...prompts.log.error.mock.calls]
      .map((call) => String(call[0] ?? "")),
  };
}

interface FullServiceUninstallEvidence {
  readonly uninstallExitCode: number;
  /** Granular autostart authority copied verbatim from the manifest before uninstall. */
  readonly stampBefore: BrowserControlAutostartStamp | undefined;
  readonly serviceUnitBefore: ManagedBrowserControlServiceBinding | undefined;
  readonly unitBytesBefore: Buffer;
  readonly unitInodeBefore: number;
  readonly unitPathResolved: string;
  /** Owned unit file state after the removal (null when the file is gone). */
  readonly unitBytesAfter: Buffer | null;
  readonly unitInodeAfter: number | null;
  /** Projected owned skill target and its bytes/inode before and after removal. */
  readonly skillPath: string;
  readonly skillBytesBefore: Buffer;
  readonly skillInodeBefore: number;
  readonly skillBytesAfter: Buffer | null;
  readonly skillInodeAfter: number | null;
  /** Manifest authority after the removal. */
  readonly manifestOwnedAfter: readonly string[];
  readonly manifestAutostartAfter: BrowserControlAutostartStamp | undefined;
  readonly manifestServiceUnitAfter: ManagedBrowserControlServiceBinding | undefined;
  /** Managed MCP projection after the removal. */
  readonly mcpCommandAfter: readonly string[] | undefined;
  readonly mcpEnvironmentAfter: Record<string, unknown> | undefined;
  /** Retained active package tree/SRI before and after the removal. */
  readonly activeTreeShaBefore: string;
  readonly activeTreeShaAfter: string | null;
  /** Manager calls issued ONLY by the uninstall (fake runner baseline sliced). */
  readonly uninstallManagerCalls: readonly string[][];
  /** Ordered external-boundary log of the uninstall only. */
  readonly uninstallEvents: readonly string[];
  /** Requests that reached the OWN `/version` server during the uninstall. */
  readonly uninstallVersionRequests: readonly string[];
  /** State reported by each uninstall `show`, aligned with `uninstallManagerCalls`. */
  readonly uninstallReadbacks: readonly SupervisorReadback[];
  /** Poison-call baselines/deltas immediately before and after the removal. */
  readonly fetchCallDelta: number;
  readonly processDelegateDelta: number;
  readonly fakeRunnerCallDelta: number;
  readonly unitBackedUp: boolean;
  readonly userCustomSurvived: boolean;
  readonly engramPreserved: boolean;
  readonly activeRootPathBefore: string;
  readonly activeReceiptShaBefore: string;
  readonly activeRootPathAfter: string | null;
  readonly activeReceiptShaAfter: string | null;
  readonly diagnostics: readonly string[];
  readonly outroMessages: readonly string[];
}

/**
 * Minimal typed hook of the full-removal helper: an external writer (the user)
 * may mutate projected state in the same private HOME after the verified install
 * and before the removal, modelling drift the removal must authenticate before
 * any destructive effect.
 */
interface FullUninstallHooks {
  readonly beforeRemoval?: (ctx: VerifiedServiceContext) => void;
  /**
   * Wraps the removal's injected manager seam. A case may fault the FIRST
   * `daemon-reload` issued after the unit file was already removed, modelling a
   * partial removal whose final reload failed, and then let a retry observe the
   * recoverable state. It only wraps the removal; the install phase is untouched.
   */
  readonly wrapRunner?: (runner: BrowserControlSystemctlRunner) => BrowserControlSystemctlRunner;
}

/**
 * Real `runUninstall` against the canonical Stack-owned service a real
 * `runInstall` just verified, in the same private HOME, with the explicit
 * manager seam (`systemctlRunner`) so the removal can stop/disable the OWN unit
 * without a real manager. `fetch` and the process boundary are poisoned so the
 * removal must prove no acquisition and no real spawn, mirroring the pending
 * case; the fake runner represents only the external manager edge.
 */
async function runFullUninstallInPlace(
  ctx: VerifiedServiceContext,
  hooks?: FullUninstallHooks,
): Promise<FullServiceUninstallEvidence> {
  const manager = ctx.manager;
  if (manager === undefined) {
    throw new Error("fixture: the full service uninstall requires the supervisor manager");
  }
  const { readManifest } = await import("../src/lib/manifest.js");
  const rowBefore = readManifest().runtimes["opencode"] as AutostartManifestRow | undefined;
  const unitBytesBefore = fs.readFileSync(ctx.unitPath);
  const unitInodeBefore = fs.statSync(ctx.unitPath).ino;
  const unitPathResolved = path.resolve(ctx.unitPath);

  const skillPath = path.join(ctx.configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  const skillBytesBefore = fs.readFileSync(skillPath);
  const skillInodeBefore = fs.statSync(skillPath).ino;

  const stateDir = path.join(process.env.HOME!, ".jorgex-stack");
  const { loadVerifiedRetainedBrowserRelease } = await import("../src/lib/browser-managed.js");
  const activeBefore = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);
  if (activeBefore === null) throw new Error("fixture: the first install must retain an active release");

  // External write at the FS boundary: an unrelated top-level user key must
  // survive the canonical removal (never whole-file ownership).
  const configPath = path.join(ctx.configDir, "opencode.json");
  const configBefore = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  configBefore["x-user-note"] = "preserve-me";
  fs.writeFileSync(configPath, `${JSON.stringify(configBefore, null, 2)}\n`);

  // Case-specific external write: the user may mutate projected owned state
  // (e.g. edit the projected SKILL.md) before the removal authenticates it.
  hooks?.beforeRemoval?.(ctx);

  // No acquisition: any registry/network attempt fails the run.
  const fetchPoison = vi.fn(() => {
    throw new Error("uninstall must not acquire Browser Control over the network");
  });
  vi.stubGlobal("fetch", fetchPoison);

  // No real manager: the injected runner is the ONLY manager boundary.
  const managerSpies = [...childProcessDelegates];
  const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
  const poisonManager = (): never => {
    throw new Error("uninstall must not spawn a real process manager");
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
  let fetchCallDelta = 0;
  let processDelegateDelta = 0;
  let fakeRunnerCallDelta = 0;
  const callsBefore = manager.calls.length;
  const eventsBefore = manager.events.length;
  const versionRequestsBefore = manager.versionRequests.length;
  const readbacksBefore = manager.readbacks.length;
  const warnBefore = prompts.log.warn.mock.calls.length;
  const errorBefore = prompts.log.error.mock.calls.length;
  const runner = hooks?.wrapRunner?.(manager.run) ?? manager.run;
  try {
    const uninstall = await import("../src/uninstall.js");
    // Snapshot immediately before the removal: the preceding install phase runs
    // real delegates (the OpenCode v2 `--version` gate), so the contract is the
    // DELTA over all four process delegates.
    const fetchCallBaseline = fetchPoison.mock.calls.length;
    const processDelegateBaseline = processDelegateCallTotal();
    const fakeRunnerCallBaseline = manager.calls.length;
    const options: BrowserControlServiceUninstallOptions = {
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: false,
      systemctlRunner: runner,
    };
    uninstallExitCode = await uninstall.runUninstall(options);
    fetchCallDelta = fetchPoison.mock.calls.length - fetchCallBaseline;
    processDelegateDelta = processDelegateCallTotal() - processDelegateBaseline;
    fakeRunnerCallDelta = manager.calls.length - fakeRunnerCallBaseline;
  } finally {
    adapter.detect = originalDetect;
    managerSpies.forEach((spy, index) => {
      const previous = previousImplementations[index];
      if (previous === undefined) spy.mockReset();
      else spy.mockImplementation(previous);
    });
  }

  const { listBackups } = await import("../src/lib/backup.js");
  const unitBackedUp = listBackups().some((backup) =>
    backup.files.some((entry) => path.resolve(entry.original) === unitPathResolved),
  );
  const configAfter = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const activeAfter = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);
  const rowAfter = readManifest().runtimes["opencode"] as AutostartManifestRow | undefined;
  const projectedAfter = (configAfter as {
    mcp?: { servers?: Record<string, { command?: string[]; environment?: Record<string, unknown> }> };
  }).mcp?.servers?.[BROWSER_CONTROL_SERVER];
  const unitBytesAfter = fs.existsSync(ctx.unitPath) ? fs.readFileSync(ctx.unitPath) : null;
  const unitInodeAfter = fs.existsSync(ctx.unitPath) ? fs.statSync(ctx.unitPath).ino : null;
  const skillBytesAfter = fs.existsSync(skillPath) ? fs.readFileSync(skillPath) : null;
  const skillInodeAfter = fs.existsSync(skillPath) ? fs.statSync(skillPath).ino : null;

  return {
    uninstallExitCode,
    stampBefore: rowBefore?.browserControlAutostart,
    serviceUnitBefore: rowBefore?.serviceUnit,
    unitBytesBefore,
    unitInodeBefore,
    unitPathResolved,
    unitBytesAfter,
    unitInodeAfter,
    skillPath,
    skillBytesBefore,
    skillInodeBefore,
    skillBytesAfter,
    skillInodeAfter,
    manifestOwnedAfter: rowAfter?.owned ?? [],
    manifestAutostartAfter: rowAfter?.browserControlAutostart,
    manifestServiceUnitAfter: rowAfter?.serviceUnit,
    mcpCommandAfter: projectedAfter?.command,
    mcpEnvironmentAfter: projectedAfter?.environment,
    activeTreeShaBefore: activeBefore.receipt.treeSha256,
    activeTreeShaAfter: activeAfter?.receipt.treeSha256 ?? null,
    uninstallManagerCalls: manager.calls.slice(callsBefore),
    uninstallEvents: manager.events.slice(eventsBefore),
    uninstallVersionRequests: manager.versionRequests.slice(versionRequestsBefore),
    uninstallReadbacks: manager.readbacks.slice(readbacksBefore),
    fetchCallDelta,
    processDelegateDelta,
    fakeRunnerCallDelta,
    unitBackedUp,
    userCustomSurvived: configAfter["x-user-note"] === "preserve-me",
    engramPreserved: prompts.log.info.mock.calls
      .map((call) => String(call[0] ?? ""))
      .some((message) => /Engram se conserva/.test(message)),
    activeRootPathBefore: activeBefore.receipt.rootPath,
    activeReceiptShaBefore: activeBefore.receiptSha256,
    activeRootPathAfter: activeAfter?.receipt.rootPath ?? null,
    activeReceiptShaAfter: activeAfter?.receiptSha256 ?? null,
    diagnostics: [
      ...prompts.log.warn.mock.calls.slice(warnBefore),
      ...prompts.log.error.mock.calls.slice(errorBefore),
    ].map((call) => String(call[0] ?? "")),
    outroMessages: prompts.outro.mock.calls.map((call) => String(call[0] ?? "")),
  };
}

/**
 * Minimal evidence of a SECOND real `runUninstall` in the same private HOME
 * after a partial removal. The unit and skill files may already be absent, so
 * this helper never reads them before the run: their absence is the recoverable
 * state under test, never a fixture error.
 */
interface ServiceRetirementRetryEvidence {
  readonly uninstallExitCode: number;
  /** Whether the owned unit file still existed immediately before the retry. */
  readonly unitExistsBefore: boolean;
  readonly manifestOwnedAfter: readonly string[];
  readonly manifestAutostartAfter: BrowserControlAutostartStamp | undefined;
  readonly manifestServiceUnitAfter: ManagedBrowserControlServiceBinding | undefined;
  readonly mcpCommandAfter: readonly string[] | undefined;
  readonly mcpEnvironmentAfter: Record<string, unknown> | undefined;
  /** Manager verbs issued ONLY by the retry. */
  readonly managerVerbs: readonly (string | undefined)[];
  readonly fetchCallDelta: number;
  readonly processDelegateDelta: number;
  readonly userCustomSurvived: boolean;
  readonly activeRootPathBefore: string;
  readonly activeRootPathAfter: string | null;
  readonly activeReceiptShaBefore: string;
  readonly activeReceiptShaAfter: string | null;
  readonly diagnostics: readonly string[];
  readonly outroMessages: readonly string[];
}

/**
 * Real `runUninstall` retry after a partial removal, in the same private HOME.
 * `fetch` and the process boundary are poisoned exactly as in the full-removal
 * helper, so the retry must close through the injected manager seam without
 * acquisition or a real spawn. The manager is left inactive/dead/MainPID=0 with
 * the OWN relay absent by the first run.
 */
async function runServiceRetirementRetryInPlace(
  ctx: VerifiedServiceContext,
): Promise<ServiceRetirementRetryEvidence> {
  const manager = ctx.manager;
  if (manager === undefined) {
    throw new Error("fixture: the retirement retry requires the supervisor manager");
  }
  const { readManifest } = await import("../src/lib/manifest.js");
  const unitExistsBefore = fs.existsSync(ctx.unitPath);

  const stateDir = path.join(process.env.HOME!, ".jorgex-stack");
  const { loadVerifiedRetainedBrowserRelease } = await import("../src/lib/browser-managed.js");
  const activeBefore = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);
  if (activeBefore === null) throw new Error("fixture: the retained active must survive the partial removal");

  // External write at the FS boundary: the unrelated user key must survive the
  // retry as it did the first removal attempt.
  const configPath = path.join(ctx.configDir, "opencode.json");
  const configBefore = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  configBefore["x-user-note"] = "preserve-me";
  fs.writeFileSync(configPath, `${JSON.stringify(configBefore, null, 2)}\n`);

  const fetchPoison = vi.fn(() => {
    throw new Error("uninstall must not acquire Browser Control over the network");
  });
  vi.stubGlobal("fetch", fetchPoison);

  const managerSpies = [...childProcessDelegates];
  const previousImplementations = managerSpies.map((spy) => spy.getMockImplementation());
  const poisonManager = (): never => {
    throw new Error("uninstall must not spawn a real process manager");
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

  const callsBefore = manager.calls.length;
  const warnBefore = prompts.log.warn.mock.calls.length;
  const errorBefore = prompts.log.error.mock.calls.length;
  let uninstallExitCode: number;
  let fetchCallDelta = 0;
  let processDelegateDelta = 0;
  try {
    const uninstall = await import("../src/uninstall.js");
    const fetchCallBaseline = fetchPoison.mock.calls.length;
    const processDelegateBaseline = processDelegateCallTotal();
    uninstallExitCode = await uninstall.runUninstall({
      runtimes: ["opencode"],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: false,
      systemctlRunner: manager.run,
    });
    fetchCallDelta = fetchPoison.mock.calls.length - fetchCallBaseline;
    processDelegateDelta = processDelegateCallTotal() - processDelegateBaseline;
  } finally {
    adapter.detect = originalDetect;
    managerSpies.forEach((spy, index) => {
      const previous = previousImplementations[index];
      if (previous === undefined) spy.mockReset();
      else spy.mockImplementation(previous);
    });
  }

  const configAfter = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const activeAfter = loadVerifiedRetainedBrowserRelease(stateDir, BC_PACKAGE);
  const rowAfter = readManifest().runtimes["opencode"] as AutostartManifestRow | undefined;
  const projectedAfter = (configAfter as {
    mcp?: { servers?: Record<string, { command?: string[]; environment?: Record<string, unknown> }> };
  }).mcp?.servers?.[BROWSER_CONTROL_SERVER];

  return {
    uninstallExitCode,
    unitExistsBefore,
    manifestOwnedAfter: rowAfter?.owned ?? [],
    manifestAutostartAfter: rowAfter?.browserControlAutostart,
    manifestServiceUnitAfter: rowAfter?.serviceUnit,
    mcpCommandAfter: projectedAfter?.command,
    mcpEnvironmentAfter: projectedAfter?.environment,
    managerVerbs: manager.calls.slice(callsBefore).map((argv) => serviceVerb(argv)),
    fetchCallDelta,
    processDelegateDelta,
    userCustomSurvived: configAfter["x-user-note"] === "preserve-me",
    activeRootPathBefore: activeBefore.receipt.rootPath,
    activeRootPathAfter: activeAfter?.receipt.rootPath ?? null,
    activeReceiptShaBefore: activeBefore.receiptSha256,
    activeReceiptShaAfter: activeAfter?.receiptSha256 ?? null,
    diagnostics: [
      ...prompts.log.warn.mock.calls.slice(warnBefore),
      ...prompts.log.error.mock.calls.slice(errorBefore),
    ].map((call) => String(call[0] ?? "")),
    outroMessages: prompts.outro.mock.calls.map((call) => String(call[0] ?? "")),
  };
}

/**
 * Faults ONLY the first `daemon-reload` seen by a removal runner and delegates
 * every other verb to the real fake manager. The first removal therefore fails
 * its final reload AFTER the unit file was removed and the environment retired,
 * leaving a recoverable partial state; the retry (which does not wrap the
 * runner) sees a successful reload.
 */
function failFirstDaemonReload(): {
  readonly wrap: (runner: BrowserControlSystemctlRunner) => BrowserControlSystemctlRunner;
} {
  let faulted = false;
  return {
    wrap: (runner) => async (args) => {
      if (!faulted && serviceVerb(args) === "daemon-reload") {
        faulted = true;
        return { status: 1, stdout: "" };
      }
      return runner(args);
    },
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
          "the uninstall must not spawn a real manager process",
        ).toBe(0);

        // The explicit runner represents an UNREACHABLE manager: the pending
        // removal may only read it (show) and must never issue a mutating verb.
        const pendingManagerVerbs = shown.managerCalls.map((argv) => serviceVerb(argv));
        for (const forbidden of SERVICE_MUTATING_VERBS) {
          expect(
            pendingManagerVerbs,
            `an unreachable manager must not trigger ${forbidden}`,
          ).not.toContain(forbidden);
        }
        expect(
          shown.managerCalls.every((argv) => serviceVerb(argv) === "show"),
          `the pending removal may only read the unreachable manager (got ${JSON.stringify(shown.managerCalls)})`,
        ).toBe(true);
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "[T12-RED] Browser Control full service uninstall retires the canonical Stack-owned service",
  () => {
    /**
     * Full-removal case on the REAL install→uninstall lifecycle. A real
     * `runInstall` with the explicit Linux opt-in creates and supervises the
     * owned unit, pins the canonical `BROWSER_CONTROL_AUTOSTART=false` + literal
     * port on the managed MCP and records the granular `browserControlAutostart`
     * stamp. The callback then runs the real `runUninstall` in the same private
     * HOME through the explicit manager seam, so the removal can prove the OWN
     * unit operational BEFORE `stop`, stop/disable it exactly (no restart/force/
     * global/linger), remove the canonical unit file with backup, retire the
     * canonical FALSE/port and the manifest claims, and only then `daemon-reload`
     * and report the global success.
     *
     * RED today: `runUninstall` has no manager lifecycle, so it preserves the
     * unit, its claim/binding/stamp and returns exit 1 without issuing any
     * stop/disable/daemon-reload or removing the file.
     */
    it("stops, disables and removes the canonical owned unit with backup and retires its claims", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-full-uninstall-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const port = await reserveOwnedLoopbackPort();
      let evidence: FullServiceUninstallEvidence | undefined;
      try {
        const observables = await runServiceInstall({
          prefix: ".jorgex-browser-control-service-full-uninstall-",
          registerOwnedRoot: (root) => ownedRoots.push(root),
          base: verificationBase(),
          browserControlService: true,
          supervisor: { port },
          onVerified: async (ctx) => {
            evidence = await runFullUninstallInPlace(ctx);
          },
        });
        if (evidence === undefined) throw new Error("fixture: the in-place full uninstall callback did not run");
        const shown = evidence;

        // Scenario integrity: the supervised install produced the canonical
        // owned unit, its binding and the granular authority this removal retires.
        expect(shown.stampBefore, "the supervised install must have recorded the granular authority").toBeDefined();
        expect(shown.stampBefore?.portOwned, "the canonical port belongs to Stack").toBe(true);
        expect(shown.serviceUnitBefore, "the supervised install must have recorded its unit binding").toBeDefined();
        expect(shown.serviceUnitBefore?.port, "the binding must witness the managed port").toBe(port);
        expect(shown.unitBytesBefore.length, "the canonical unit must exist before the removal").toBeGreaterThan(0);

        // 1) The canonical service lifecycle runs only through the injected
        //    manager seam: no real process was spawned and no network acquired.
        expect(shown.processDelegateDelta, "the removal must not spawn a real manager").toBe(0);
        expect(shown.fetchCallDelta, "the removal must not acquire over the network").toBe(0);
        expect(shown.fakeRunnerCallDelta, "the removal must use the injected manager seam").toBeGreaterThan(0);

        // 2) Preflight proved the OWN unit operational BEFORE `stop`: the
        //    manager read it active/running with its MainPID, the authenticated
        //    `/version` answered on the OWN port, and the readback was stable.
        const verbs = shown.uninstallManagerCalls.map((argv) => serviceVerb(argv));
        const stopIndex = verbs.indexOf("stop");
        const disableIndex = verbs.indexOf("disable");
        const reloadIndex = verbs.indexOf("daemon-reload");
        expect(stopIndex, "the removal must stop the OWN unit").toBeGreaterThanOrEqual(0);
        expect(disableIndex, "the removal must disable the OWN unit").toBeGreaterThan(stopIndex);
        expect(reloadIndex, "the removal must daemon-reload after removing the unit").toBeGreaterThan(disableIndex);

        const showsBeforeStop = verbs
          .map((verb, index) => (verb === "show" && index < stopIndex ? index : -1))
          .filter((index) => index >= 0);
        expect(showsBeforeStop.length, "the preflight must read the OWN unit before stop").toBeGreaterThanOrEqual(2);
        for (const index of showsBeforeStop) {
          const ordinal = verbs.filter((verb, at) => verb === "show" && at < index).length;
          const readback = shown.uninstallReadbacks[ordinal]!;
          expect(readback.active, "the unit must be operational before stop").toBe(true);
          expect(readback.subState).toBe("running");
          expect(readback.mainPid, "the operational readback must witness the MainPID").toBe(process.pid);
          expect(readback.relayUp, "the OWN relay must be up before stop").toBe(true);
        }
        expect(
          shown.uninstallEvents.indexOf("version:GET /version"),
          "the authenticated /version must be probed before stop",
        ).toBeGreaterThanOrEqual(0);
        expect(shown.uninstallEvents.indexOf("version:GET /version")).toBeLessThan(stopIndex);
        expect(shown.uninstallVersionRequests.length).toBeGreaterThanOrEqual(1);

        // 3) After `stop` the OWN relay is gone and the readback credits the
        //    unit inactive/dead/PID0 BEFORE `disable`.
        const showsAfterStop = verbs
          .map((verb, index) => (verb === "show" && index > stopIndex && index < disableIndex ? index : -1))
          .filter((index) => index >= 0);
        expect(showsAfterStop.length, "the removal must read the unit back after stop").toBeGreaterThanOrEqual(1);
        const postStopIndex = showsAfterStop[showsAfterStop.length - 1]!;
        const postStopOrdinal = verbs.filter((verb, at) => verb === "show" && at < postStopIndex).length;
        const postStopReadback = shown.uninstallReadbacks[postStopOrdinal]!;
        expect(postStopReadback.active, "the stopped unit must be inactive").toBe(false);
        expect(postStopReadback.subState).toBe("dead");
        expect(postStopReadback.mainPid).toBe(0);
        expect(postStopReadback.relayUp, "the OWN relay must be down before disable").toBe(false);

        // 4) Exact mutating sequence on the OWN unit only.
        const mutating = verbs.filter((verb): verb is string => verb !== undefined && SERVICE_MUTATING_VERBS.has(verb));
        expect(mutating, "the only manager mutations must be stop, disable and the final daemon-reload").toEqual([
          "stop",
          "disable",
          "daemon-reload",
        ]);
        const disableArgs = shown.uninstallManagerCalls.find((argv) => serviceVerb(argv) === "disable") ?? [];
        expect(disableArgs, "disable must suppress the implicit daemon reload").toContain("--no-reload");
        const flattened = shown.uninstallManagerCalls.flat();
        for (const forbidden of ["restart", "reload", "mask", "unmask", "linger", "--force", "--global", "--system", "--now"]) {
          expect(flattened, `the removal must never issue ${forbidden}`).not.toContain(forbidden);
        }
        expect(flattened, "the removal must operate in the user scope").toContain("--user");
        for (const argv of shown.uninstallManagerCalls) {
          const verb = serviceVerb(argv);
          if (verb === "stop" || verb === "disable") {
            expect(argv, `the ${verb} verb must name the exact OWN unit`).toContain(SERVICE_UNIT_FILENAME);
            expect(argv.some((token) => token.includes("*"))).toBe(false);
          }
        }

        // 5) The canonical unit file is removed with a backup; its manifest
        //    claims are gone after the readback.
        expect(observables.unitBytes, "the canonical unit file must be removed").toBeNull();
        expect(fs.existsSync(shown.unitPathResolved), "the unit path must be free after removal").toBe(false);
        expect(shown.unitBackedUp, "the removed unit must have been backed up first").toBe(true);
        expect(
          observables.manifestOwned.map((file) => path.resolve(file)),
          "the owned claim must be retired",
        ).not.toContain(shown.unitPathResolved);
        expect(observables.manifestServiceUnit, "the serviceUnit binding must be retired").toBeUndefined();
        expect(observables.manifestAutostart, "the granular authority must be retired").toBeUndefined();

        // 6) The Stack-introduced canonical FALSE/port are retired (or the whole
        //    canonical MCP entry is removed), never left stale.
        const mcpEntryRemoved = observables.mcpCommand === undefined && observables.mcpEnvironment === undefined;
        const envRetired = observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART === undefined
          && observables.mcpEnvironment?.BROWSER_CONTROL_PORT === undefined;
        expect(mcpEntryRemoved || envRetired, "the canonical managed environment must be retired").toBe(true);

        // 7) Only the managed service is removed: user config, Engram and the
        //    retained browser runtime survive.
        expect(shown.userCustomSurvived, "an unrelated user config key must survive").toBe(true);
        expect(shown.engramPreserved, "Engram must be preserved without --remove-engram").toBe(true);
        expect(shown.activeRootPathAfter, "the retained active root must survive").toBe(shown.activeRootPathBefore);
        expect(shown.activeReceiptShaAfter, "the retained active must still authenticate").toBe(
          shown.activeReceiptShaBefore,
        );

        // 8) The complete removal reports success; no pending diagnostic remains.
        expect(shown.uninstallExitCode, "a completed canonical removal must exit 0").toBe(0);
        expect(
          shown.outroMessages.some((message) => /^Hecho\./.test(message)),
          "the complete removal must print the global success outro",
        ).toBe(true);
        expect(
          shown.diagnostics.some((message) => message.includes(SERVICE_UNIT_FILENAME)),
          "no pending-service diagnostic must remain after a complete removal",
        ).toBe(false);
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });

    /**
     * Fail-closed ordering case on the REAL install→uninstall lifecycle. A real
     * `runInstall` with the explicit Linux opt-in creates and supervises the
     * owned unit and projects the canonical owned `SKILL.md`. Before the removal
     * the user edits ONLY that projected skill with different bytes, so the
     * static preflight cannot authenticate it. The removal must abort before ANY
     * destructive effect: no mutating manager verb, the owned unit, its
     * claim/binding/stamp, the canonical MCP environment and the user-modified
     * skill all survive, and the retained active package/SRI is intact.
     *
     * RED today: `retireOwnedBrowserControlService` runs before the static
     * resource/skill preflight, so the service is already stopped, disabled and
     * its unit file removed (and the canonical environment retired) by the time
     * the skill block aborts. The first RED is the mutating manager verbs and the
     * missing unit file while the skill is blocked.
     */
    it("aborts before any destructive effect when the projected owned skill is user-modified", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-skill-blocked-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const port = await reserveOwnedLoopbackPort();
      let evidence: FullServiceUninstallEvidence | undefined;
      try {
        const observables = await runServiceInstall({
          prefix: ".jorgex-browser-control-service-skill-blocked-",
          registerOwnedRoot: (root) => ownedRoots.push(root),
          base: verificationBase(),
          browserControlService: true,
          supervisor: { port },
          onVerified: async (ctx) => {
            evidence = await runFullUninstallInPlace(ctx, {
              beforeRemoval: (verified) => {
                fs.writeFileSync(
                  path.join(verified.configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md"),
                  USER_SKILL_BYTES,
                );
              },
            });
          },
        });
        if (evidence === undefined) throw new Error("fixture: the in-place blocked uninstall callback did not run");
        const shown = evidence;

        // Scenario integrity: the supervised install produced the canonical
        // owned unit and the canonical owned skill this case then drifts.
        expect(shown.stampBefore, "the supervised install must record the granular authority").toBeDefined();
        expect(shown.serviceUnitBefore, "the supervised install must record its unit binding").toBeDefined();
        expect(shown.serviceUnitBefore?.port, "the binding must witness the managed port").toBe(port);
        expect(shown.unitBytesBefore.length, "the canonical unit must exist before the removal").toBeGreaterThan(0);
        expect(shown.skillBytesBefore, "the install must project the canonical skill").toEqual(BC_SKILL_BYTES);
        expect(
          shown.skillBytesBefore.equals(USER_SKILL_BYTES),
          "the user edit must differ from the canonical skill",
        ).toBe(false);

        // The blocked removal is honest: non-zero exit and no global success.
        expect.soft(shown.uninstallExitCode, "a blocked removal must exit 1").toBe(1);
        expect.soft(
          shown.outroMessages.some((message) => /^Hecho\./.test(message)),
          "the global success outro must not be printed while the skill block aborts",
        ).toBe(false);

        // No destructive effect reached the manager: only a read-only `show` is
        // acceptable, and never a mutating verb.
        const verbs = shown.uninstallManagerCalls.map((argv) => serviceVerb(argv));
        for (const forbidden of SERVICE_MUTATING_VERBS) {
          expect.soft(verbs, `the skill preflight must abort before ${forbidden}`).not.toContain(forbidden);
        }
        expect.soft(
          verbs.every((verb) => verb === "show"),
          `the blocked removal may only read the manager (got ${JSON.stringify(shown.uninstallManagerCalls)})`,
        ).toBe(true);

        // The owned unit file survives byte-identical and by inode, and was not
        // backed up for removal.
        expect.soft(shown.unitBytesAfter, "the owned unit must survive the blocked removal").not.toBeNull();
        expect.soft(shown.unitBytesAfter, "the unit bytes must be untouched").toEqual(shown.unitBytesBefore);
        expect.soft(shown.unitInodeAfter, "the unit inode must be untouched").toBe(shown.unitInodeBefore);
        expect.soft(shown.unitBackedUp, "the blocked removal must not have removed the unit").toBe(false);

        // The user-modified skill survives verbatim with its inode.
        expect.soft(shown.skillBytesAfter, "the user-modified skill must survive").not.toBeNull();
        expect.soft(shown.skillBytesAfter, "the user skill bytes must be preserved verbatim").toEqual(USER_SKILL_BYTES);
        expect.soft(shown.skillInodeAfter, "the skill inode must be untouched").toBe(shown.skillInodeBefore);

        // The manifest claim, binding and granular stamp survive verbatim.
        expect.soft(
          shown.manifestOwnedAfter.map((file) => path.resolve(file)),
          "the manifest must keep the unit claim",
        ).toContain(shown.unitPathResolved);
        expect.soft(
          shown.manifestServiceUnitAfter,
          "the serviceUnit binding must survive verbatim",
        ).toEqual(shown.serviceUnitBefore);
        expect.soft(
          shown.manifestAutostartAfter,
          "the granular authority must survive verbatim",
        ).toEqual(shown.stampBefore);

        // The canonical managed MCP environment is intact.
        expect.soft(
          shown.mcpEnvironmentAfter?.BROWSER_CONTROL_AUTOSTART,
          "the canonical FALSE must be retained",
        ).toBe("false");
        expect.soft(
          shown.mcpEnvironmentAfter?.BROWSER_CONTROL_PORT,
          "the literal managed port must be retained",
        ).toBe(String(port));
        expect.soft(
          shown.mcpCommandAfter,
          "the managed launcher must be retained",
        ).toEqual(observables.expectedMcpCommand);

        // The retained active package tree/SRI is intact.
        expect.soft(shown.activeTreeShaAfter, "the retained active tree must authenticate").toBe(shown.activeTreeShaBefore);
        expect.soft(shown.activeRootPathAfter, "the retained active root must survive").toBe(shown.activeRootPathBefore);
        expect.soft(
          shown.activeReceiptShaAfter,
          "the retained active receipt must authenticate",
        ).toBe(shown.activeReceiptShaBefore);

        // No acquisition and no real manager process.
        expect.soft(shown.fetchCallDelta, "the blocked removal must not acquire over the network").toBe(0);
        expect.soft(shown.processDelegateDelta, "the blocked removal must not spawn a real manager").toBe(0);

        // The abort diagnostic names the skill target.
        expect.soft(
          shown.diagnostics.some((message) => message.includes("SKILL.md")),
          `the skill block diagnostic must name the preserved skill (got ${JSON.stringify(shown.diagnostics)})`,
        ).toBe(true);
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });

    /**
     * Partial-removal recovery on the REAL install→uninstall lifecycle. A real
     * `runInstall` with the explicit Linux opt-in creates and supervises the
     * owned unit. The first real `runUninstall` then stops/disables the OWN unit,
     * retires the canonical environment and removes the unit file with backup,
     * but its FINAL `daemon-reload` fails (injected fault, first reload only), so
     * the removal is left pending with the file already gone and the
     * claims/binding/authority still recorded — a consistent, recoverable state.
     *
     * A retry in the same private HOME must observe the manager
     * inactive/dead/MainPID=0 with the OWN relay absent, finish WITHOUT
     * re-stopping or restarting, complete the final reload and release the
     * claims/serviceUnit/autostart, exiting 0 while user config and the retained
     * active stay intact.
     *
     * RED today: the retry rejects the absent unit file as `drift` (the
     * preflight demands the file), so it preserves the claims again and exits 1;
     * the removal never closes.
     */
    it("recovers a partial removal whose final daemon-reload failed and closes on retry", async () => {
      const ownedRoots: string[] = [];
      const releaseRoots = registerOwnedResourceCleanup("browser-control-service-partial-reload-roots", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const port = await reserveOwnedLoopbackPort();
      let firstRun: FullServiceUninstallEvidence | undefined;
      let retry: ServiceRetirementRetryEvidence | undefined;
      try {
        const observables = await runServiceInstall({
          prefix: ".jorgex-browser-control-service-partial-reload-",
          registerOwnedRoot: (root) => ownedRoots.push(root),
          base: verificationBase(),
          browserControlService: true,
          supervisor: { port },
          onVerified: async (ctx) => {
            const fault = failFirstDaemonReload();
            firstRun = await runFullUninstallInPlace(ctx, { wrapRunner: fault.wrap });
            retry = await runServiceRetirementRetryInPlace(ctx);
          },
        });
        if (firstRun === undefined || retry === undefined) {
          throw new Error("fixture: the in-place partial-removal callbacks did not run");
        }
        const partial = firstRun;
        const closed = retry;

        // --- First run: the removal advanced past stop/disable/removal and only
        //     the final reload failed. The file is gone but the claims and the
        //     authority survive, so the state is consistent and recoverable.
        expect(partial.stampBefore, "the supervised install must record the granular authority").toBeDefined();
        expect(partial.serviceUnitBefore, "the supervised install must record its unit binding").toBeDefined();
        expect(partial.serviceUnitBefore?.port, "the binding must witness the managed port").toBe(port);
        expect(partial.unitBytesBefore.length, "the canonical unit must exist before the removal").toBeGreaterThan(0);

        expect(partial.uninstallExitCode, "a partial removal must exit non-zero").not.toBe(0);
        expect(partial.unitBytesAfter, "the partial removal must have removed the unit file").toBeNull();
        expect(partial.unitBackedUp, "the removed unit must have been backed up").toBe(true);

        // The claims, binding and granular authority survive the partial state.
        expect(
          partial.manifestOwnedAfter.map((file) => path.resolve(file)),
          "the partial removal must keep the unit claim recoverable",
        ).toContain(partial.unitPathResolved);
        expect(
          partial.manifestServiceUnitAfter,
          "the partial removal must keep the binding recoverable",
        ).toEqual(partial.serviceUnitBefore);
        expect(
          partial.manifestAutostartAfter,
          "the partial removal must keep the authority recoverable",
        ).toEqual(partial.stampBefore);

        // The canonical environment is already retired (entry gone or fields gone).
        const partialEntryRemoved = partial.mcpCommandAfter === undefined && partial.mcpEnvironmentAfter === undefined;
        const partialEnvRetired = partial.mcpEnvironmentAfter?.BROWSER_CONTROL_AUTOSTART === undefined
          && partial.mcpEnvironmentAfter?.BROWSER_CONTROL_PORT === undefined;
        expect(partialEntryRemoved || partialEnvRetired, "the canonical environment must already be retired").toBe(true);

        // No acquisition, no real manager, and no global success while pending.
        expect(partial.fetchCallDelta, "the removal must not acquire over the network").toBe(0);
        expect(partial.processDelegateDelta, "the removal must not spawn a real manager").toBe(0);
        expect(
          partial.outroMessages.some((message) => /^Hecho\./.test(message)),
          "the partial removal must not print the global success outro",
        ).toBe(false);
        expect(
          partial.diagnostics.some((message) =>
            message.includes(SERVICE_UNIT_FILENAME) && /conserva|pendiente|retirada/i.test(message),
          ),
          `the partial removal must diagnose the pending service (got ${JSON.stringify(partial.diagnostics)})`,
        ).toBe(true);

        // --- Retry: the unit file is already gone and the manager is
        //     inactive/dead/PID0 with the OWN relay absent. The retry must close
        //     the removal without re-stopping or restarting the service.
        expect(closed.unitExistsBefore, "the unit file must already be gone before the retry").toBe(false);

        // PRIMARY RED today: the retry rejects the absent file as drift and
        // preserves the claims again, so it never exits 0.
        expect.soft(closed.uninstallExitCode, "the retry must close the removal with exit 0").toBe(0);
        expect.soft(
          closed.manifestOwnedAfter.map((file) => path.resolve(file)),
          "the retry must retire the owned unit claim",
        ).not.toContain(path.resolve(observables.unitPath));
        expect.soft(closed.manifestServiceUnitAfter, "the retry must retire the serviceUnit binding").toBeUndefined();
        expect.soft(closed.manifestAutostartAfter, "the retry must retire the granular authority").toBeUndefined();

        // The retry must never re-stop or restart the already-inactive unit.
        const retryMutating = closed.managerVerbs.filter(
          (verb): verb is string => verb !== undefined && SERVICE_MUTATING_VERBS.has(verb),
        );
        expect.soft(retryMutating, "the retry must not re-stop the inactive unit").not.toContain("stop");
        expect.soft(retryMutating, "the retry must not restart the inactive unit").not.toContain("restart");

        // User config and the retained active stay intact.
        expect.soft(closed.userCustomSurvived, "an unrelated user config key must survive the retry").toBe(true);
        expect.soft(
          closed.activeRootPathAfter,
          "the retained active root must survive the retry",
        ).toBe(closed.activeRootPathBefore);
        expect.soft(
          closed.activeReceiptShaAfter,
          "the retained active must still authenticate after the retry",
        ).toBe(closed.activeReceiptShaBefore);

        // The retry completes honestly: global success and no pending diagnostic.
        expect.soft(
          closed.outroMessages.some((message) => /^Hecho\./.test(message)),
          "the closed removal must print the global success outro",
        ).toBe(true);
        expect.soft(
          closed.diagnostics.some((message) => message.includes(SERVICE_UNIT_FILENAME)),
          `no pending-service diagnostic must remain after the retry (got ${JSON.stringify(closed.diagnostics)})`,
        ).toBe(false);
        expect.soft(closed.fetchCallDelta, "the retry must not acquire over the network").toBe(0);
        expect.soft(closed.processDelegateDelta, "the retry must not spawn a real manager").toBe(0);
      } finally {
        cleanupOwnedResourcesOrThrow();
        releaseRoots();
      }
    });
  },
);
