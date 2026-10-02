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
import type { InstallOptions } from "../src/install.js";
import type {
  BrowserControlServiceResult,
  EnsureBrowserControlServiceInput,
} from "../src/lib/browser-control-service.js";
import type { ManagedBrowserControlServiceBinding } from "../src/lib/manifest.js";

/**
 * T12 Linux service vertical (Spec 12/13) — first RED at the EXISTING
 * `runInstall` API, without importing any module that does not exist yet.
 *
 * Contract under test: the explicit Linux opt-in (`browserControlService`)
 * reaches `runInstall` and materializes the fixed managed user unit
 * `jorgex-stack-browser-control.service` under `$XDG_CONFIG_HOME/systemd/user`,
 * built from the authenticated managed Browser Control active (Node + guard +
 * launcher + the complete `serve` runtime arg), and recorded as an owned
 * resource. It must never adopt or overwrite a foreign unit at the same path,
 * and the default (no flag) must create no unit, invoke no manager and leave the
 * native MCP projection without the external-service autostart marker.
 *
 * Artifact-only scope: creating the owned unit file is the whole effect here.
 * This fixture invokes NO manager (`systemctlCalls === []`: no
 * daemon-reload/enable/start and no HTTP probe) and leaves the native MCP
 * autostart marker untouched. The supervisor/endpoint proof and
 * `BROWSER_CONTROL_AUTOSTART=false` belong to the next vertical.
 *
 * Boundary (deliberately narrow): the Browser Control acquisition coordinator is
 * replaced by a REAL managed active projection seeded on disk through the public
 * `activateManagedBrowserTree` with a real `browserTreeSha256` (real FS, crypto
 * and managed state). The registry/relay acquisition path is not exercised here;
 * it is covered by tests/browser-control-runtime.test.ts. `systemctl` is a narrow
 * DI effect seam (`systemctlRunner`) so no real manager, DBus or personal session
 * is touched.
 *
 * RED today: `parseFlags` recognizes `--browser-control-service`, but `runInstall`
 * ignores it, so no unit file is created. The positive case fails on the missing
 * artifact — not on an API import or an invalid fixture.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BC_PACKAGE = "@opencode-ai/browser-control";
const BROWSER_CONTROL_SERVER = "browser-control";
const SERVICE_UNIT_FILENAME = "jorgex-stack-browser-control.service";

/** Fixed release fixture: real bytes, real SRI; a version bump is data, not a new framework. */
const BC_VERSION = "9.9.30";
const BC_ROOT_BYTES = Buffer.from("browser-control-service-root-bytes\n");
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
 * Narrow DI seam requested from the root API. Production currently ignores it;
 * the shape is declared here so the RED is unambiguous and a real implementation
 * can wire it without inventing a second contract.
 */
export interface BrowserControlSystemctlRunner {
  (args: readonly string[]): Promise<{ status: number; stdout: string }>;
}

/** `InstallOptions` intersection with the service opt-in and its effect seam. */
export type BrowserControlServiceInstallOptions = InstallOptions & {
  browserControlService?: boolean;
  systemctlRunner?: BrowserControlSystemctlRunner;
};

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

afterEach(() => {
  cleanupOwnedResourcesOrThrow();
  vi.doUnmock("../src/lib/browser-control-runtime.js");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

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

interface RecordingRunner {
  readonly calls: string[][];
  readonly run: BrowserControlSystemctlRunner;
}

/**
 * Fake manager effect seam. It only records argv: the artifact-only contract
 * expects zero calls, so any `systemctl` invocation fails the test instead of
 * being answered. The effective-unit/endpoint proof, `start` and its private
 * listener belong to the later verified case.
 */
function createRecordingRunner(): RecordingRunner {
  const calls: string[][] = [];
  const run: BrowserControlSystemctlRunner = async (args) => {
    calls.push([...args]);
    return { status: 0, stdout: "" };
  };
  return { calls, run };
}

interface ServiceObservables {
  readonly exitCode: number;
  readonly unitPath: string;
  readonly unitBytes: Buffer | null;
  readonly manifestOwned: readonly string[];
  readonly mcpCommand: readonly string[] | undefined;
  readonly mcpEnvironment: Record<string, unknown> | undefined;
  readonly systemctlCalls: readonly string[][];
}

interface RunServiceInput {
  readonly prefix: string;
  readonly registerOwnedRoot: (root: string) => void;
  readonly base: string;
  readonly browserControlService?: boolean;
  readonly foreignUnitBytes?: Buffer;
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

  await withIsolatedEnv({ ...process.env, ...owned.env }, async () => {
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
    const runner = createRecordingRunner();

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

    const unitBytes = fs.existsSync(unitPath) ? fs.readFileSync(unitPath) : null;
    const configPath = path.join(configDir, "opencode.json");
    type ProjectedConfig = {
      mcp?: { servers?: Record<string, { command?: string[]; environment?: Record<string, unknown> }> };
    };
    const config: ProjectedConfig = fs.existsSync(configPath)
      ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as ProjectedConfig)
      : {};
    const projected = config.mcp?.servers?.[BROWSER_CONTROL_SERVER];
    observables = {
      exitCode,
      unitPath,
      unitBytes,
      manifestOwned: readManifest().runtimes.opencode?.owned ?? [],
      mcpCommand: projected?.command,
      mcpEnvironment: projected?.environment,
      systemctlCalls: runner.calls,
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
  it("creates the fixed owned unit with the authenticated `serve` invocation when the opt-in is explicit", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-service-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    try {
      const observables = await runServiceInstall({
        prefix: ".jorgex-browser-control-service-",
        registerOwnedRoot: (root) => ownedRoots.push(root),
        base: verificationBase(),
        browserControlService: true,
      });

      // 1) The fixed user unit is materialized. This is the first RED: today the
      //    explicit opt-in is parsed but ignored, so no file exists.
      expect(
        observables.unitBytes,
        `the fixed user unit must be created at ${observables.unitPath}`,
      ).not.toBeNull();
      const unit = observables.unitBytes!.toString("utf8");

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

      // 3) Ownership: the fixed unit is recorded in the known owned list only
      //    when the explicit opt-in created it.
      expect(
        observables.manifestOwned.map((file) => path.resolve(file)),
        "the created unit must be recorded as an owned resource",
      ).toContain(path.resolve(observables.unitPath));

      // 4) Artifact-only creation writes the unit file only: it invokes NO
      //    manager. No daemon-reload/enable/start and no HTTP probe happen here;
      //    the supervisor/endpoint proof and the daemon lifecycle belong to the
      //    later verified case. Asserting the whole call log is empty is the
      //    strongest form of the restart/stop/linger/foreign negatives.
      expect(
        observables.systemctlCalls,
        "the artifact-only creation must not invoke the manager",
      ).toEqual([]);

      // 5) Without the supervisor/endpoint proof this fixture cannot produce,
      //    the external service is NOT authenticated: the native MCP autostart
      //    marker must stay native (unset or `true`), never pinned to `false`.
      //    `BROWSER_CONTROL_AUTOSTART=false` belongs to the next vertical.
      const autostart = observables.mcpEnvironment?.BROWSER_CONTROL_AUTOSTART;
      expect(
        autostart === undefined || autostart === "true",
        `an unverified external service must not pin native autostart to false (got ${String(autostart)})`,
      ).toBe(true);
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
