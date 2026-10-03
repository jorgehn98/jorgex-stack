import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { RuntimeDetection } from "../src/lib/detect.js";
import type { BrowserControlRuntimeResult } from "../src/lib/browser-control-runtime.js";

/**
 * T12/T13 vertical — integración raíz de Browser Control (Spec 12/13).
 *
 * Contrato observable a través de la API `runInstall` existente, sin importar
 * módulos inexistentes. Una instalación real de OpenCode v2 adquiere el paquete
 * obligatorio `@opencode-ai/browser-control` desde el registro (metadata latest
 * + tarball SRI) y lo retiene como candidato verificado en
 * `<stateDir>/.browser-control-candidate`.
 *
 * - Relay presente/incierto: el candidato queda pendiente y NO se promueve; no
 *   hay MCP `browser-control` ni skill que apunten al candidato.
 * - Ausencia comprobada (`ECONNREFUSED` en el puerto efectivo): el candidato se
 *   promueve al namespace operativo real, el MCP usa la invocación completa del
 *   launcher `active` (`planManagedBrowserInvocation(stateDir, pkg, ["mcp"])`) y
 *   la skill oficial del paquete se proyecta byte-identical en
 *   `<configDir>/skills/browser-control/SKILL.md`. Nunca se apunta al candidato.
 *
 * Frontera del doble (deliberadamente estrecha): solo se sustituye
 * `stageVerifiedBrowserTree` por un testigo real en disco; `node:crypto`,
 * `browserTreeSha256`, `activateManagedBrowserTree` y
 * `loadVerifiedManagedBrowserReceipt` corren reales. El fetch externo se
 * stubea (packument + tarball del root) y el relay es un servidor HTTP propio
 * o un puerto efímero ya cerrado. Cualquier otro fetch falla cerrado.
 *
 * El SKILL.md sintético del testigo es un payload de fixture explícito: no
 * acredita la skill oficial publicada, solo comprueba que los bytes retenidos
 * se proyectan byte-exactos.
 *
 * RED de primera ejecución (caso ausencia): hoy la retención ya funciona pero
 * `runInstall` no promueve ni proyecta el active, así que el receipt activo es
 * nulo y la aserción falla por comportamiento ausente, no por setup inválido.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BC_PACKAGE = "@opencode-ai/browser-control";
const BC_METADATA_URL = `https://registry.npmjs.org/${BC_PACKAGE}`;

/**
 * A published Browser Control release fixture: exact root tarball bytes plus the
 * official skill payload, with the SRI computed from those bytes. The same
 * fixture supports the acquisition/retention cases (release A) and the managed
 * update case (release B): a version bump is data, not a new fixture framework.
 */
interface BrowserControlReleaseFixture {
  readonly version: string;
  readonly rootBytes: Buffer;
  readonly skillBytes: Buffer;
  readonly integrity: string;
  readonly tarballUrl: string;
}

function makeRelease(version: string): BrowserControlReleaseFixture {
  const rootBytes = Buffer.from(`official-browser-control-root-${version}\n`);
  const skillBytes = Buffer.from(
    [
      "---",
      "name: browser-control",
      `description: synthetic fixture payload ${version}, not the published skill`,
      "---",
      "",
      `# Browser Control (fixture ${version})`,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    version,
    rootBytes,
    skillBytes,
    integrity: `sha512-${createHash("sha512").update(rootBytes).digest("base64")}`,
    tarballUrl: `https://registry.npmjs.org/${BC_PACKAGE}/-/${BC_PACKAGE.slice(BC_PACKAGE.lastIndexOf("/") + 1)}-${version}.tgz`,
  };
}

const RELEASE_A = makeRelease("9.9.30");
const RELEASE_B = makeRelease("9.9.31");

// Aliases for the acquisition/retention cases (release A).
const BC_VERSION = RELEASE_A.version;
const BC_TARBALL_URL = RELEASE_A.tarballUrl;
const BC_ROOT_BYTES = RELEASE_A.rootBytes;
const BC_ROOT_INTEGRITY = RELEASE_A.integrity;

const BROWSER_CONTROL_SERVER = "browser-control";
const BC_CANDIDATE_DIRNAME = ".browser-control-candidate";

/**
 * Payload sintético de la skill oficial: bytes de fixture, NO una prueba de la
 * skill publicada. La proyección real debe ser byte-identical a lo retenido.
 */
const BC_SKILL_BYTES = RELEASE_A.skillBytes;

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
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/browser-stage.js");
  vi.clearAllMocks();
});

type Witness = {
  stageDir: string;
  nodeModulesPath: string;
  treePath: string;
  entryPath: string;
};

function writeWitnessTree(
  root: string,
  release: BrowserControlReleaseFixture = RELEASE_A,
  options: { includeSkill?: boolean } = {},
): Witness {
  const stageDir = path.join(root, `witness-stage-${release.version}`);
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
  fs.writeFileSync(entryPath, release.rootBytes);
  if (options.includeSkill !== false) {
    // Skill oficial dentro del paquete verificado (package.json: files). Se
    // escribe antes del digest para que el árbol real la incluya.
    const skillPath = path.join(treePath, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(skillPath, release.skillBytes);
  }
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

/** Staged witness for a release, with its real tree digest. */
function stagedWitness(
  witness: Witness,
  release: BrowserControlReleaseFixture,
  digest: (nodeModulesPath: string, stageDir: string) => string,
): StageVerifiedBrowserTreeResult {
  return {
    treePath: witness.treePath,
    nodeModulesPath: witness.nodeModulesPath,
    treeSha256: digest(witness.nodeModulesPath, witness.stageDir),
    closure: [{ name: BC_PACKAGE, version: release.version, integrity: release.integrity }],
  };
}

/**
 * Installs the narrow `stageVerifiedBrowserTree` double over the real module
 * graph: the actual module is imported and only the stage boundary is replaced.
 * The double is the same for every case; only the staged result (or the async
 * side effect) differs.
 */
function mockStagedBrowserTree(
  stage: (
    options: { readonly release: { readonly version: string } },
  ) => StageVerifiedBrowserTreeResult | Promise<StageVerifiedBrowserTreeResult>,
): void {
  vi.doMock("../src/lib/browser-stage.js", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/browser-stage.js")>(
        "../src/lib/browser-stage.js",
      );
    return { ...actual, stageVerifiedBrowserTree: stage };
  });
}


/** Generic provider fixture: only the Browser Control metadata and its root tarball. */
function registryFetch(
  seen: string[],
  current: () => BrowserControlReleaseFixture = () => RELEASE_A,
): typeof fetch {
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const release = current();
    const url = String(input);
    seen.push(url);
    if (url === BC_METADATA_URL) {
      const packument = {
        name: BC_PACKAGE,
        "dist-tags": { latest: release.version },
        versions: {
          [release.version]: {
            name: BC_PACKAGE,
            version: release.version,
            dist: { tarball: release.tarballUrl, integrity: release.integrity },
          },
        },
      };
      const response = new Response(JSON.stringify(packument), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url === release.tarballUrl) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(release.rootBytes.slice());
          controller.close();
        },
      });
      const response = new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`browser-control-runtime: unexpected provider fetch ${url}`);
  };
  return stub as unknown as typeof fetch;
}

async function startRelayVersionServer(
  requests: string[],
  port = 0,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    if (request.method === "GET" && request.url === "/version") {
      // Identity/build/protocol only: never sessions, targets or URLs.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ name: BC_PACKAGE, version: "0.8.3", build: "browser-control", protocol: 1 }));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // `port = 0` conserva el puerto efímero; un puerto explícito permite ocupar
    // un endpoint propio ya reservado (relay que aparece tarde).
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function closeRelayServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Owns an ephemeral loopback port and closes its listener, leaving a genuine
 * ECONNREFUSED behind. Never falls back to the default 19989 or the personal
 * relay: the caller probes exactly this reserved-then-closed port.
 */
async function reserveClosedRelayPort(): Promise<number> {
  const server = createServer();
  server.on("clientError", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

function loggedLines(): string[] {
  const groups = [
    prompts.log.info,
    prompts.log.warn,
    prompts.log.error,
    prompts.log.success,
    prompts.log.message,
    prompts.log.step,
  ];
  return groups.flatMap((group) => group.mock.calls.map((call) => String(call[0])));
}

function findFilesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  if (!fs.existsSync(root)) return hits;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (fs.readFileSync(full, "utf8").includes(needle)) hits.push(full);
      } catch {
        // Unreadable/binary projections cannot carry a projected path.
      }
    }
  };
  visit(root);
  return hits;
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

/**
 * Creates the private verification home for one runtime case and registers
 * its root with the shared owned-resource owner. The owner stops owned
 * process groups/listeners first and then removes the root, so cases never
 * arm their own release; registration happens before any resource IO.
 */
function createOwnedRuntimeHome(prefix: string) {
  const ownedRoots: string[] = [];
  let unregister: (() => void) | undefined;
  unregister = registerOwnedResourceCleanup(`browser-control-runtime-${prefix}`, () => {
    removeTemporaryRoots(ownedRoots);
    unregister?.();
  });
  const base = resolveVerificationDiskBase({
    repoRoot: REPO_ROOT,
    env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
  });
  return createOwnedVerificationHome({
    base,
    prefix,
    register: (root) => ownedRoots.push(root),
  });
}


/**
 * Observables of the late-authentication window: a foreign writer creates the
 * official Browser Control skill target inside the real apply-changes
 * confirmation, after the pre-prompt plan/authentication and before the
 * post-prompt re-plan/final authentication.
 */
interface LateAuthObservables {
  readonly exitCode: number;
  readonly confirmOpened: boolean;
  readonly bytesAtCreation: Buffer;
  readonly inoAtCreation: number;
  readonly bytesAfter: Buffer;
  readonly inoAfter: number;
  readonly ownedIncludesSkill: boolean;
  readonly errors: string[];
}

/**
 * Runs a real OpenCode v2 install that promotes the verified active Browser
 * Control release, with the interactive confirmation window (`yes: false`, fake
 * TTY). The foreign writer creates `<configDir>/skills/browser-control/SKILL.md`
 * inside `p.confirm` before it resolves `true`; only the post-confirmation
 * authentication may decide whether that file is claimed or replaced.
 */
async function runBrowserSkillConfirmWindow(foreignBytes: Buffer): Promise<LateAuthObservables> {
  const fetched: string[] = [];
  let originalTty: PropertyDescriptor | undefined;
  try {
    const owned = createOwnedRuntimeHome(".jorgex-browser-control-late-auth-");
    // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989/59999.
    const closedPort = await reserveClosedRelayPort();
    originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });

    let observables: LateAuthObservables | undefined;
    await withIsolatedEnv(
      { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(closedPort) },
      async () => {
        const witness = writeWitnessTree(owned.root);
        const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
          output: "opencode v2.0.20",
        });
        const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
        const skillTarget = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

        const actualStage = await import("../src/lib/browser-stage.js");
        const witnessStaged = {
          treePath: witness.treePath,
          nodeModulesPath: witness.nodeModulesPath,
          treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
          closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
        };
        mockStagedBrowserTree(async () => witnessStaged);
        vi.stubGlobal("fetch", registryFetch(fetched));

        const install = await import("../src/install.js");
        const { readManifest } = await import("../src/lib/manifest.js");

        const opencode = install.ADAPTERS.opencode!;
        const originalDetect = opencode.detect;
        opencode.detect = () => ({
          id: "opencode",
          name: "OpenCode",
          installed: true,
          binPath: opencodeBin,
          configDir,
        });

        let confirmOpened = false;
        let bytesAtCreation = Buffer.alloc(0);
        let inoAtCreation = -1;
        // The foreign writer acts exactly inside the real apply-changes
        // confirmation: after the pre-prompt plan/authentication and before the
        // post-prompt re-plan/final authentication. Only this window is
        // represented; no internal call ordering is asserted.
        prompts.confirm.mockReset();
        prompts.confirm.mockImplementation(async (options) => {
          const message = String((options as { message?: unknown } | undefined)?.message ?? "");
          if (!confirmOpened && message.includes("Aplicar") && message.includes("OpenCode")) {
            confirmOpened = true;
            fs.mkdirSync(path.dirname(skillTarget), { recursive: true, mode: 0o700 });
            fs.writeFileSync(skillTarget, foreignBytes);
            bytesAtCreation = fs.readFileSync(skillTarget);
            inoAtCreation = fs.statSync(skillTarget).ino;
          }
          return true;
        });

        let exitCode: number;
        try {
          exitCode = await install.runInstall({
            runtimes: ["opencode"],
            command: "install",
            dryRun: false,
            yes: false,
            mode: { mode: "human", subagentConcurrency: "serial" },
            engramBin: null,
          });
        } finally {
          opencode.detect = originalDetect;
        }

        const ownedPaths = readManifest().runtimes.opencode?.owned ?? [];
        observables = {
          exitCode,
          confirmOpened,
          bytesAtCreation,
          inoAtCreation,
          bytesAfter: fs.readFileSync(skillTarget),
          inoAfter: fs.statSync(skillTarget).ino,
          ownedIncludesSkill: ownedPaths.some((file) => path.resolve(file) === path.resolve(skillTarget)),
          errors: prompts.log.error.mock.calls.map((call) => String(call[0] ?? "")),
        };
      },
    );
    if (observables === undefined) {
      throw new Error("browser-control-runtime: the late-authentication window did not run");
    }
    return observables;
  } finally {
    if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", originalTty);
    cleanupOwnedResourcesOrThrow();
  }
}

describe.skipIf(process.platform !== "linux")("[T12-RED] Browser Control runtime integration", () => {
  it("retains a verified Browser Control candidate without activating it while the relay is present", async () => {
    // Owned-resource owner armed before the first root or server exists.
    let relay: Server | undefined;
    const fetched: string[] = [];
    const relayRequests: string[] = [];

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-runtime-");
      const startedRelay = await startRelayVersionServer(relayRequests);
      relay = startedRelay.server;

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(startedRelay.port) },
        async () => {
          const witness = writeWitnessTree(owned.root);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");

          // Real tree digest from the real module before the narrow boundary double.
          const actualStage = await import("../src/lib/browser-stage.js");
          const witnessStaged = {
            treePath: witness.treePath,
            nodeModulesPath: witness.nodeModulesPath,
            treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
            closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
          };
          mockStagedBrowserTree(async () => witnessStaged);
          vi.stubGlobal("fetch", registryFetch(fetched));

          const install = await import("../src/install.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          opencode.detect = () => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });

          let code: number;
          try {
            code = await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });
          } finally {
            opencode.detect = originalDetect;
          }

          // 1) Mandatory acquisition: registry latest + root tarball SRI only.
          expect(fetched, "Browser Control acquisition must hit the registry latest + root tarball").toEqual([
            BC_METADATA_URL,
            BC_TARBALL_URL,
          ]);

          // 2) Verified candidate retained under the fixed candidate namespace (Spec T13).
          const candidateDir = path.join(dataDir(), ".browser-control-candidate");
          const candidate = loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE);
          expect(candidate, "a verified candidate receipt must be retained").not.toBeNull();
          expect(candidate).toMatchObject({
            schemaVersion: 1,
            packageName: BC_PACKAGE,
            version: BC_VERSION,
            integrity: BC_ROOT_INTEGRITY,
          });
          expect(path.resolve(candidate!.rootPath).startsWith(path.resolve(candidateDir))).toBe(true);

          // 3) Never activated: the operational namespace stays empty.
          expect(loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE)).toBeNull();
          expect(
            fs.existsSync(path.join(dataDir(), ".browser-managed", BROWSER_CONTROL_SERVER, "active.v1.json")),
          ).toBe(false);

          // 4) The relay gate ran against our own random port.
          expect(relayRequests, "the relay gate must probe /version on BROWSER_CONTROL_PORT").toContain(
            "GET /version",
          );

          // 5) No active projection may point at the candidate.
          const configPath = path.join(configDir, "opencode.json");
          const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
            mcp?: { servers?: Record<string, unknown> };
          };
          expect(config.mcp?.servers?.[BROWSER_CONTROL_SERVER]).toBeUndefined();
          expect(fs.existsSync(path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md"))).toBe(false);
          expect(findFilesContaining(configDir, candidateDir), "no projection may reference the candidate").toEqual(
            [],
          );

          // 6) Honest pending: not complete, nonzero, actionable diagnostic.
          expect(code).not.toBe(0);
          expect(prompts.outro).not.toHaveBeenCalledWith("Hecho.");
          const diagnostics = loggedLines().join("\n");
          expect(diagnostics).toMatch(/browser.?control/i);
          expect(diagnostics).toMatch(/pendient|candidat/i);
        },
      );
    } finally {
      await closeRelayServer(relay);
      cleanupOwnedResourcesOrThrow();
    }
  });

  it("promotes the verified candidate to the real state and projects MCP+skill when the relay is absent", async () => {
    const fetched: string[] = [];

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-absent-");
      // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989/59999.
      const closedPort = await reserveClosedRelayPort();

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(closedPort) },
        async () => {
          const witness = writeWitnessTree(owned.root);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");

          const actualStage = await import("../src/lib/browser-stage.js");
          const witnessStaged = {
            treePath: witness.treePath,
            nodeModulesPath: witness.nodeModulesPath,
            treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
            closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
          };
          mockStagedBrowserTree(async () => witnessStaged);
          vi.stubGlobal("fetch", registryFetch(fetched));

          const install = await import("../src/install.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt, planManagedBrowserInvocation } =
            await import("../src/lib/browser-managed.js");

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          opencode.detect = () => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });

          try {
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });
          } finally {
            opencode.detect = originalDetect;
          }

          // 1) Acquisition runs exactly once even though the relay is absent:
          //    registry latest + root tarball SRI, no re-fetch on promotion.
          expect(fetched, "Browser Control acquisition must hit the registry latest + root tarball").toEqual([
            BC_METADATA_URL,
            BC_TARBALL_URL,
          ]);

          // 2) Verified absence promotes the candidate to the real operational
          //    namespace; the active receipt points at the managed release,
          //    never at the candidate.
          const active = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
          expect(
            active,
            "verified relay absence must publish the active managed Browser Control receipt",
          ).not.toBeNull();
          if (active === null) return;
          expect(active).toMatchObject({
            schemaVersion: 1,
            packageName: BC_PACKAGE,
            version: BC_VERSION,
            integrity: BC_ROOT_INTEGRITY,
          });
          const managedRoot = path.join(dataDir(), ".browser-managed", BROWSER_CONTROL_SERVER);
          expect(path.resolve(active.rootPath).startsWith(path.resolve(managedRoot))).toBe(true);
          expect(active.rootPath).not.toContain(BC_CANDIDATE_DIRNAME);

          // 3) The caller MCP is the full active launcher guard invocation with
          //    exactly one `mcp` runtime arg, never the candidate.
          const planner = planManagedBrowserInvocation(dataDir(), BC_PACKAGE, ["mcp"]);
          const configPath = path.join(configDir, "opencode.json");
          const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
            mcp?: { servers?: Record<string, { type?: string; command?: string[] }> };
          };
          const projected = config.mcp?.servers?.[BROWSER_CONTROL_SERVER];
          expect(projected?.type).toBe("local");
          expect(projected?.command, "MCP must carry the verified active invocation").toEqual([
            planner.command,
            ...planner.args,
          ]);
          // Independent golden: Node + guard eval + non-empty guard source +
          // active launcher + the single `mcp` runtime arg. Only the guard's
          // presence is asserted, never its algorithm.
          expect(projected?.command?.[0]).toBe(process.execPath);
          expect(projected?.command?.slice(1, 3)).toEqual(["--input-type=module", "--eval"]);
          expect(typeof projected?.command?.[3]).toBe("string");
          expect((projected?.command?.[3] ?? "").length).toBeGreaterThan(0);
          expect(projected?.command?.slice(-2)).toEqual([active.launcherPath, "mcp"]);
          expect((projected?.command ?? []).filter((arg) => arg === "mcp")).toHaveLength(1);

          // 4) The official skill payload is projected byte-identical into the
          //    OpenCode config dir, never the shared global ~/.agents/skills.
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
          expect(fs.existsSync(projectedSkill), "the active skill must be projected").toBe(true);
          if (fs.existsSync(projectedSkill)) {
            expect(fs.readFileSync(projectedSkill)).toEqual(BC_SKILL_BYTES);
          }
          expect(
            fs.existsSync(
              path.join(owned.env.HOME!, ".agents", "skills", BROWSER_CONTROL_SERVER, "SKILL.md"),
            ),
            "the shared global .agents skills home must not be a projection requirement",
          ).toBe(false);

          // 5) No projection may reference the candidate namespace.
          expect(
            findFilesContaining(configDir, BC_CANDIDATE_DIRNAME),
            "no projection may reference the candidate",
          ).toEqual([]);

          // 6) A real second install is idempotent: the matching verified active
          //    is reused without re-promotion, and the active receipt, MCP
          //    invocation and skill bytes stay byte-identical.
          const firstActive = {
            version: active.version,
            integrity: active.integrity,
            rootPath: active.rootPath,
            launcherPath: active.launcherPath,
            launcherSha256: active.launcherSha256,
            treeSha256: active.treeSha256,
            entryPath: active.entryPath,
          };
          const firstCommand = projected?.command ?? [];
          const firstSkill = fs.readFileSync(projectedSkill);

          vi.clearAllMocks();
          opencode.detect = () => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });
          try {
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });
          } finally {
            opencode.detect = originalDetect;
          }
          // The aggregate OpenCode status is "failed" because of the independent
          // Engram prerequisite (SC-07), so the Browser Control result is read
          // from its own diagnostic: the second install must reuse the verified
          // active, never fall back to pending/unavailable.
          const secondLogs = loggedLines();
          expect(
            secondLogs.some((line) => /Browser Control: .*verificado y activo/.test(line)),
            `the second install must reuse the verified active (ready): ${secondLogs.join(" | ")}`,
          ).toBe(true);
          expect(
            secondLogs.some((line) => /Browser Control: .*No se proyecta MCP\/skill/.test(line)),
            "the second install must not fall back to pending/unavailable",
          ).toBe(false);

          const secondActive = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
          expect(secondActive, "the reused active receipt must remain").not.toBeNull();
          expect({
            version: secondActive?.version,
            integrity: secondActive?.integrity,
            rootPath: secondActive?.rootPath,
            launcherPath: secondActive?.launcherPath,
            launcherSha256: secondActive?.launcherSha256,
            treeSha256: secondActive?.treeSha256,
            entryPath: secondActive?.entryPath,
          }).toEqual(firstActive);
          const secondConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
            mcp?: { servers?: Record<string, { command?: string[] }> };
          };
          expect(
            secondConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.command,
            "the projected MCP invocation must not change on a second install",
          ).toEqual(firstCommand);
          expect(
            fs.readFileSync(projectedSkill),
            "the projected skill bytes must not change on a second install",
          ).toEqual(firstSkill);
          expect(firstSkill).toEqual(BC_SKILL_BYTES);
        },
      );
    } finally {
      cleanupOwnedResourcesOrThrow();
    }
  });

  it("reuses the verified active without promotion when the relay is present and latest already matches", async () => {
    const fetched: string[] = [];
    const relayRequests: string[] = [];
    let relay: Server | undefined;
    let stageCalls = 0;

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-relay-present-");
      // First install: genuine absence on our own reserved-and-closed port.
      const closedPort = await reserveClosedRelayPort();

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(closedPort) },
        async () => {
          const witness = writeWitnessTree(owned.root);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
          const configPath = path.join(configDir, "opencode.json");
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

          const actualStage = await import("../src/lib/browser-stage.js");
          const witnessStaged = {
            treePath: witness.treePath,
            nodeModulesPath: witness.nodeModulesPath,
            treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
            closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
          };
          mockStagedBrowserTree(async () => {
            stageCalls += 1;
            return witnessStaged;
          });
          vi.stubGlobal("fetch", registryFetch(fetched));

          const install = await import("../src/install.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

          const activePointer = path.join(
            dataDir(),
            ".browser-managed",
            BROWSER_CONTROL_SERVER,
            "active.v1.json",
          );
          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          const detection = (): RuntimeDetection => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });
          opencode.detect = detection;

          try {
            // 1) First real install with the relay absent publishes verified active A.
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });
            const activeA = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(activeA, "the first install must publish verified active A").not.toBeNull();
            if (activeA === null) return;
            expect(activeA.version).toBe(RELEASE_A.version);
            const firstActive = {
              version: activeA.version,
              integrity: activeA.integrity,
              rootPath: activeA.rootPath,
              launcherPath: activeA.launcherPath,
              launcherSha256: activeA.launcherSha256,
              treeSha256: activeA.treeSha256,
              entryPath: activeA.entryPath,
            };
            const firstPointerBytes = fs.readFileSync(activePointer);
            const configA = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, { command?: string[] }> };
            };
            const firstCommand = configA.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.command;
            expect(firstCommand, "the first install must project the managed MCP").toBeDefined();
            const firstSkill = fs.readFileSync(projectedSkill);
            expect(firstSkill).toEqual(BC_SKILL_BYTES);
            expect(stageCalls, "the first install stages the verified candidate exactly once").toBe(1);

            // 2) The relay becomes present with a valid /version identity while
            //    the provider latest still resolves to the already-active A.
            const startedRelay = await startRelayVersionServer(relayRequests);
            relay = startedRelay.server;
            process.env.BROWSER_CONTROL_PORT = String(startedRelay.port);

            // 3) A real second install re-resolves latest A and verifies its SRI.
            vi.clearAllMocks();
            opencode.detect = detection;
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });

            expect(fetched.slice(2), "the second install must re-resolve latest A and verify its SRI").toEqual([
              BC_METADATA_URL,
              BC_TARBALL_URL,
            ]);
            expect(relayRequests, "the relay gate must probe /version on BROWSER_CONTROL_PORT").toContain(
              "GET /version",
            );

            // 4) No promotion/restart: no re-staging, and the active pointer
            //    bytes, launcher and roots stay byte-identical.
            expect(stageCalls, "reuse must not stage/promote the retained candidate again").toBe(1);
            expect(fs.readFileSync(activePointer), "the active pointer bytes must not change").toEqual(
              firstPointerBytes,
            );
            const secondActive = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(secondActive, "the reused active receipt must remain").not.toBeNull();
            expect({
              version: secondActive?.version,
              integrity: secondActive?.integrity,
              rootPath: secondActive?.rootPath,
              launcherPath: secondActive?.launcherPath,
              launcherSha256: secondActive?.launcherSha256,
              treeSha256: secondActive?.treeSha256,
              entryPath: secondActive?.entryPath,
            }).toEqual(firstActive);

            // 5) Projection unchanged: managed MCP invocation and skill bytes.
            const configSecond = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, { command?: string[] }> };
            };
            expect(
              configSecond.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.command,
              "the projected MCP invocation must not change on relay-present reuse",
            ).toEqual(firstCommand);
            expect(
              fs.existsSync(projectedSkill),
              "the projected skill must survive relay-present reuse",
            ).toBe(true);
            expect(
              fs.readFileSync(projectedSkill),
              "the projected skill bytes must not change on relay-present reuse",
            ).toEqual(firstSkill);

            // 6) The already-active matching release is reused as ready: no
            //    pending fallback despite the live relay. This is the exact kind
            //    trace; the aggregate exit code stays nonzero because of the
            //    independent Engram prerequisite, so only this diagnostic is read.
            const secondLogs = loggedLines();
            expect(
              secondLogs.some((line) => /Browser Control: .*verificado y activo/.test(line)),
              `the relay-present second install must reuse the verified active (ready): ${secondLogs.join(" | ")}`,
            ).toBe(true);
            expect(
              secondLogs.some((line) => /Browser Control: .*No se proyecta MCP\/skill/.test(line)),
              "the relay-present second install must not fall back to pending",
            ).toBe(false);
          } finally {
            opencode.detect = originalDetect;
          }
        },
      );
    } finally {
      await closeRelayServer(relay);
      cleanupOwnedResourcesOrThrow();
    }
  });

  it("rolls back a promoted release that lacks the official skill and keeps the verified candidate", async () => {
    const fetched: string[] = [];

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-missing-skill-");

      await withIsolatedEnv({ ...process.env, ...owned.env }, async () => {
        const stateDir = path.join(owned.root, "state");
        // The operational state root exists; it starts with no active receipt.
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        // First root is NONE (no prior active) and the verified witness omits
        // `skills/browser-control/SKILL.md`: the bytes are SRI-verified but do
        // not form a functional package, so promoting it cannot be ready.
        const witness = writeWitnessTree(owned.root, RELEASE_A, { includeSkill: false });

        const actualStage = await import("../src/lib/browser-stage.js");
        const witnessStaged = {
          treePath: witness.treePath,
          nodeModulesPath: witness.nodeModulesPath,
          treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
          closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
        };
        mockStagedBrowserTree(async () => witnessStaged);
        // The injected fetch is the only allowed network source; a global fetch
        // would mean an unintended real acquisition.
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          throw new Error(`browser-control-runtime: unexpected global fetch ${String(input)}`);
        });

        const { prepareBrowserControlRuntime, browserControlCandidateDir } = await import(
          "../src/lib/browser-control-runtime.js"
        );
        const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

        const result = await prepareBrowserControlRuntime({
          stateDir,
          pnpmBin: path.join(owned.root, "bin", "pnpm"),
          fetchImpl: registryFetch(fetched),
          stageParent: owned.env.TMPDIR,
          // Known absence via the injected seam: no global loopback probe.
          probeRelay: async () => "absent",
        });

        // 1) Real acquisition: registry latest + root tarball SRI only.
        expect(fetched, "Browser Control acquisition must hit the registry latest + root tarball").toEqual([
          BC_METADATA_URL,
          BC_TARBALL_URL,
        ]);

        // 2) Actionable unavailable that names the missing official skill, never
        //    a false ready.
        expect(result.kind).toBe("unavailable");
        if (result.kind !== "unavailable") return;
        expect(result.reason).toMatch(/skill/i);
        expect(result.reason).toMatch(/oficial/i);

        // 3) The failed promotion is rolled back: no broken active pointer and
        //    no orphaned release left in the operational namespace.
        expect(
          loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE),
          "a promotion that cannot project the official skill must not leave an active receipt",
        ).toBeNull();
        expect(
          fs.existsSync(
            path.join(stateDir, ".browser-managed", BROWSER_CONTROL_SERVER, "active.v1.json"),
          ),
        ).toBe(false);

        // 4) The verified candidate survives intact: retained, re-verifiable and
        //    never deleted nor replaced with fabricated bytes.
        const candidateDir = browserControlCandidateDir(stateDir);
        const candidate = loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE);
        expect(candidate, "the verified candidate must be retained after rollback").not.toBeNull();
        expect(candidate).toMatchObject({
          schemaVersion: 1,
          packageName: BC_PACKAGE,
          version: BC_VERSION,
          integrity: BC_ROOT_INTEGRITY,
        });
        expect(
          fs.existsSync(
            path.join(
              candidate!.treePath,
              "@opencode-ai",
              "browser-control",
              "skills",
              BROWSER_CONTROL_SERVER,
              "SKILL.md",
            ),
          ),
          "the retained candidate must still lack the skill by fixture construction",
        ).toBe(false);
      });
    } finally {
      cleanupOwnedResourcesOrThrow();
    }
  });

  /**
   * T12/T13 controller RED (spec 12/13): revalidación tras esperas asíncronas.
   * Con active A real ya publicado y latest B verificado distinto, el sondeo del
   * puerto efectivo observa ausencia ANTES del stage; durante el stage asíncrono
   * de B un relay ordinario propio aparece en ESE MISMO puerto. La decisión de
   * publicación debe re-sondear el endpoint efectivo DESPUÉS del stage y quedar
   * pendiente (A+B, candidato B retenido, active A intacto). Hoy `prepare`
   * captura el sondeo antes de `await retain` y reutiliza el resultado cacheado
   * para promover, así que B se publica sobre un relay ya presente.
   *
   * Seam: `prepareBrowserControlRuntime` real (FS/SRI/managed) con
   * `relayPort` efectivo explícito y sonda HTTP acotada real; el único doble es
   * `stageVerifiedBrowserTree` (testigo en disco), que además enciende el relay
   * propio en la frontera asíncrona.
   */
  it("re-sondea el puerto efectivo tras el stage y no promueve si el relay aparece durante la espera", async () => {
    // Cleanup de raíces/servidor armado ANTES del primer root o listener.
    const fetched: string[] = [];
    const relayRequests: string[] = [];
    let relay: Server | undefined;
    let currentRelease = RELEASE_A;

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-late-relay-");
      // Puerto efectivo propio: libre antes del stage, ocupado por el relay que
      // aparece durante el stage de B. Nunca 19989.
      const effectivePort = await reserveClosedRelayPort();

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(effectivePort) },
        async () => {
          const stateDir = path.join(owned.root, "state");
          fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          const witnessA = writeWitnessTree(owned.root, RELEASE_A);
          const witnessB = writeWitnessTree(owned.root, RELEASE_B);

          const actualStage = await import("../src/lib/browser-stage.js");
          const stagedByVersion = new Map<string, StageVerifiedBrowserTreeResult>([
            [RELEASE_A.version, stagedWitness(witnessA, RELEASE_A, actualStage.browserTreeSha256)],
            [RELEASE_B.version, stagedWitness(witnessB, RELEASE_B, actualStage.browserTreeSha256)],
          ]);
          mockStagedBrowserTree(async (options: { release: { version: string } }) => {
            const staged = stagedByVersion.get(options.release.version);
            if (staged === undefined) {
              throw new Error(
                `browser-control-runtime: unexpected stage version ${options.release.version}`,
              );
            }
            if (options.release.version === RELEASE_B.version && relay === undefined) {
              // El relay ordinario aparece en la frontera asíncrona del
              // stage, en el MISMO puerto efectivo ya resuelto.
              const started = await startRelayVersionServer(relayRequests, effectivePort);
              relay = started.server;
            }
            return staged;
          });
          vi.stubGlobal("fetch", registryFetch(fetched, () => currentRelease));

          const { prepareBrowserControlRuntime, browserControlCandidateDir } = await import(
            "../src/lib/browser-control-runtime.js"
          );
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");

          const summarize = (result: BrowserControlRuntimeResult): string =>
            result.kind === "ready"
              ? `ready:${result.version}`
              : result.kind === "pending"
                ? `pending:${result.candidateVersion}`
                : `unavailable:${result.reason}`;

          // 1) Primer prepare real: ausencia en el puerto efectivo => promueve A.
          const readyA = await prepareBrowserControlRuntime({
            stateDir,
            pnpmBin: path.join(owned.root, "bin", "pnpm"),
            fetchImpl: registryFetch(fetched, () => currentRelease),
            stageParent: owned.env.TMPDIR,
            relayPort: effectivePort,
          });
          expect(readyA.kind, `el primer prepare debe promover A: ${summarize(readyA)}`).toBe("ready");
          const activeA = loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE);
          expect(activeA, "el primer prepare debe publicar el active A").not.toBeNull();
          if (activeA === null) return;
          expect(activeA.version).toBe(RELEASE_A.version);
          const activePointer = path.join(
            stateDir,
            ".browser-managed",
            BROWSER_CONTROL_SERVER,
            "active.v1.json",
          );
          const pointerBytesA = fs.readFileSync(activePointer);
          // Control: el relay no existía durante el primer prepare.
          expect(
            relayRequests,
            "el primer prepare no debe alcanzar un relay inexistente",
          ).toEqual([]);

          // 2) Segundo prepare con latest B: ausencia ANTES del stage, relay
          //    presente DURANTE el stage asíncrono.
          currentRelease = RELEASE_B;
          const second = await prepareBrowserControlRuntime({
            stateDir,
            pnpmBin: path.join(owned.root, "bin", "pnpm"),
            fetchImpl: registryFetch(fetched, () => currentRelease),
            stageParent: owned.env.TMPDIR,
            relayPort: effectivePort,
          });

          // Contrato: pending con A+B, sin promover.
          expect(
            second.kind,
            `el segundo prepare debe quedar pending (no promover B sobre un relay ya presente): ${summarize(second)}`,
          ).toBe("pending");
          if (second.kind !== "pending") return;
          expect(second.candidateVersion).toBe(RELEASE_B.version);
          expect(second.activeVersion).toBe(RELEASE_A.version);
          expect(
            relayRequests,
            "el re-sondeo posterior al stage debe alcanzar el relay que apareció en el puerto efectivo",
          ).toContain("GET /version");

          // Active A intacto (pointer bytes) y candidato B retenido.
          const activeAfter = loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE);
          expect(activeAfter?.version, "el active A no debe ser sustituido por B").toBe(RELEASE_A.version);
          expect(fs.readFileSync(activePointer), "el pointer del active A no debe reescribirse").toEqual(
            pointerBytesA,
          );
          const candidate = loadVerifiedManagedBrowserReceipt(
            browserControlCandidateDir(stateDir),
            BC_PACKAGE,
          );
          expect(candidate, "el candidato B debe quedar retenido").not.toBeNull();
          expect(candidate?.version).toBe(RELEASE_B.version);
        },
      );
    } finally {
      // Cerrar el listener propio ANTES de retirar las raíces.
      await closeRelayServer(relay);
      cleanupOwnedResourcesOrThrow();
    }
  });

  it("advances a verified active A to B on a legitimate update, preserving user config and the prior root", async () => {
    const fetched: string[] = [];
    let currentRelease = RELEASE_A;

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-update-");
      // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989/59999.
      const closedPort = await reserveClosedRelayPort();

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(closedPort) },
        async () => {
          const witnessA = writeWitnessTree(owned.root, RELEASE_A);
          const witnessB = writeWitnessTree(owned.root, RELEASE_B);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
          const configPath = path.join(configDir, "opencode.json");
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

          const actualStage = await import("../src/lib/browser-stage.js");
          const stagedByVersion = new Map<string, StageVerifiedBrowserTreeResult>([
            [RELEASE_A.version, stagedWitness(witnessA, RELEASE_A, actualStage.browserTreeSha256)],
            [RELEASE_B.version, stagedWitness(witnessB, RELEASE_B, actualStage.browserTreeSha256)],
          ]);
          mockStagedBrowserTree(async (options: { release: { version: string } }) => {
            const staged = stagedByVersion.get(options.release.version);
            if (staged === undefined) {
              throw new Error(`browser-control-runtime: unexpected stage version ${options.release.version}`);
            }
            return staged;
          });
          // The stub serves whichever release is current, so the same test can
          // install A and then publish B without re-mocking the module graph.
          vi.stubGlobal("fetch", registryFetch(fetched, () => currentRelease));

          const install = await import("../src/install.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt, planManagedBrowserInvocation } =
            await import("../src/lib/browser-managed.js");
          const { listBackups } = await import("../src/lib/backup.js");

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          opencode.detect = () => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });

          const runInstall = () =>
            install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });

          try {
            // 1) First install publishes verified active A end to end.
            await runInstall();
            const activeA = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(activeA, "the first install must publish verified active A").not.toBeNull();
            if (activeA === null) return;
            expect(activeA.version).toBe(RELEASE_A.version);
            const rootA = activeA.rootPath;
            expect(fs.existsSync(rootA)).toBe(true);

            const configA = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
            };
            const plannerA = planManagedBrowserInvocation(dataDir(), BC_PACKAGE, ["mcp"]);
            expect(configA.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.command).toEqual([
              plannerA.command,
              ...plannerA.args,
            ]);
            expect(fs.readFileSync(projectedSkill)).toEqual(RELEASE_A.skillBytes);

            // The user owns part of this config: an unknown field on the managed
            // entry, an unrelated server and a top-level key must survive.
            const userConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
              [key: string]: unknown;
            };
            userConfig.mcp!.servers![BROWSER_CONTROL_SERVER]!["x-user-note"] = "keep-me";
            userConfig.mcp!.servers!["user-custom"] = { type: "local", command: ["/usr/bin/true"] };
            userConfig["user-top-level"] = { keep: true };
            fs.writeFileSync(configPath, `${JSON.stringify(userConfig, null, 2)}\n`);

            // 2) A newer verified latest B is published while the relay is absent.
            vi.clearAllMocks();
            currentRelease = RELEASE_B;
            let updateError: unknown;
            try {
              await runInstall();
            } catch (error) {
              updateError = error;
            }
            const updateFailure = updateError === undefined ? "" : ` (update threw: ${String(updateError)})`;

            // 3) The update re-resolves latest B and verifies its tarball SRI.
            expect(fetched.slice(2), "the update must re-resolve latest B and verify its tarball SRI").toEqual([
              BC_METADATA_URL,
              RELEASE_B.tarballUrl,
            ]);

            // 4) The active receipt advances to B in the operational namespace.
            const activeB = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(activeB, `the update must advance the active release to B${updateFailure}`).not.toBeNull();
            if (activeB === null) return;
            expect(activeB.version).toBe(RELEASE_B.version);
            expect(activeB.integrity).toBe(RELEASE_B.integrity);
            expect(activeB.rootPath).not.toBe(rootA);
            expect(
              path.resolve(activeB.rootPath).startsWith(
                path.resolve(dataDir(), ".browser-managed", BROWSER_CONTROL_SERVER),
              ),
            ).toBe(true);

            // 5) The caller MCP is re-projected to B's verified active guard.
            const plannerB = planManagedBrowserInvocation(dataDir(), BC_PACKAGE, ["mcp"]);
            const configB = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
              [key: string]: unknown;
            };
            expect(
              configB.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.command,
              `the managed MCP must be re-projected to B's active guard${updateFailure}`,
            ).toEqual([plannerB.command, ...plannerB.args]);

            // 6) The official skill advances byte-identical to B.
            expect(
              fs.readFileSync(projectedSkill),
              `the projected skill must advance to B${updateFailure}`,
            ).toEqual(RELEASE_B.skillBytes);

            // 7) User config survives the managed update.
            expect(configB.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["x-user-note"]).toBe("keep-me");
            expect(configB.mcp?.servers?.["user-custom"]).toEqual({ type: "local", command: ["/usr/bin/true"] });
            expect(configB["user-top-level"]).toEqual({ keep: true });

            // 8) The prior active root is retained for rollback, not deleted.
            expect(fs.existsSync(rootA), "the prior active root must be retained after the update").toBe(true);

            // 9) The replaced config is backed up before it is overwritten.
            const backedUp = listBackups().some((info) =>
              info.files.some((file) => path.resolve(file.original) === path.resolve(configPath)),
            );
            expect(
              backedUp,
              `the update must back up the replaced config before writing${updateFailure}`,
            ).toBe(true);

            // The transition must complete, not fail closed on its own prior
            // managed entry. This is not the aggregate exit code: the independent
            // Engram prerequisite can make the run nonzero without touching
            // Browser Control.
            expect(updateError, `the legitimate update must not fail closed${updateFailure}`).toBeUndefined();
          } finally {
            opencode.detect = originalDetect;
          }
        },
      );
    } finally {
      cleanupOwnedResourcesOrThrow();
    }
  });

  /**
   * T12/T13 caller RED (spec 12/13 causal additions): el puerto EFECTIVO del MCP
   * gestionado preservado manda sobre el shell. Con active A ya publicado y un
   * MCP `browser-control` cuyo `environment.BROWSER_CONTROL_PORT` apunta a un
   * relay propio VIVO, mientras el shell `BROWSER_CONTROL_PORT` apunta a otro
   * puerto propio reservado-y-cerrado, un segundo install con latest B debe
   * sondear el puerto efectivo, verlo presente y quedar pendiente: A sigue
   * activo, B queda retenido como candidato, config/claim/skill de A no cambian
   * y el caller diagnostica AMBAS versiones. Hoy el controlador solo lee el
   * shell, ve ausencia, promueve B y pierde A.
   *
   * Criterios etiquetados (primer fallo = A):
   * - A (puerto/promoción): active A + pointer/config/claim/skill intactos, B
   *   retenido y el relay efectivo realmente sondeado (`GET /version`).
   * - B (salida): el diagnóstico del caller nombra el candidato B y el active A
   *   con su rol, sin depender de doctor ni de snapshots de prosa.
   */
  it("sondea el puerto efectivo del MCP preservado y diagnostica active A + candidato B sin promover", async () => {
    // Cleanup de raíces/servidor armado ANTES del primer root o listener.
    const fetched: string[] = [];
    const relayRequests: string[] = [];
    let relay: Server | undefined;
    let currentRelease = RELEASE_A;

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-effective-port-");
      // Shell: puerto propio reservado-y-cerrado (ECONNREFUSED genuino), nunca 19989.
      const shellPort = await reserveClosedRelayPort();

      await withIsolatedEnv(
        { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(shellPort) },
        async () => {
          const witnessA = writeWitnessTree(owned.root, RELEASE_A);
          const witnessB = writeWitnessTree(owned.root, RELEASE_B);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
          const configPath = path.join(configDir, "opencode.json");
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

          const actualStage = await import("../src/lib/browser-stage.js");
          const stagedByVersion = new Map<string, StageVerifiedBrowserTreeResult>([
            [RELEASE_A.version, stagedWitness(witnessA, RELEASE_A, actualStage.browserTreeSha256)],
            [RELEASE_B.version, stagedWitness(witnessB, RELEASE_B, actualStage.browserTreeSha256)],
          ]);
          mockStagedBrowserTree(async (options: { release: { version: string } }) => {
            const staged = stagedByVersion.get(options.release.version);
            if (staged === undefined) {
              throw new Error(
                `browser-control-runtime: unexpected stage version ${options.release.version}`,
              );
            }
            return staged;
          });
          vi.stubGlobal("fetch", registryFetch(fetched, () => currentRelease));

          const install = await import("../src/install.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");
          const { devtoolsMcpPreferenceFile, loadDevtoolsMcpOwnership } = await import(
            "../src/lib/tool-preferences.js"
          );

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          const detection = (): RuntimeDetection => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });
          opencode.detect = detection;

          const runInstall = () =>
            install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });

          try {
            // 1) Primer install real (relay ausente en el shell): promueve A y
            //    proyecta el MCP guard A + la skill A.
            await runInstall();
            const activeA = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(activeA, "el primer install debe publicar el active A").not.toBeNull();
            if (activeA === null) return;
            expect(activeA.version).toBe(RELEASE_A.version);
            const activePointer = path.join(
              dataDir(),
              ".browser-managed",
              BROWSER_CONTROL_SERVER,
              "active.v1.json",
            );
            const pointerBytesA = fs.readFileSync(activePointer);
            const skillA = fs.readFileSync(projectedSkill);
            expect(skillA).toEqual(RELEASE_A.skillBytes);

            // 2) El MCP gestionado preserva el puerto EFECTIVO: un relay propio
            //    VIVO en ese puerto. El shell se mueve a OTRO puerto propio
            //    reservado-y-cerrado, así que shell y MCP discrepan.
            const startedRelay = await startRelayVersionServer(relayRequests);
            relay = startedRelay.server;
            const effectivePort = startedRelay.port;
            expect(relay.listening, "el relay del puerto efectivo debe estar vivo").toBe(true);
            expect(effectivePort).not.toBe(shellPort);
            // Control no vacuo: el shell apunta a un puerto genuinamente cerrado
            // (ausencia real), distinto del efectivo, que sí tiene el relay vivo.
            // El sondeo de control no toca el puerto efectivo para no contaminar
            // la señal de `relayRequests` que debe producir el código bajo prueba.
            const { probeBrowserControlRelay } = await import("../src/lib/browser-control-runtime.js");
            expect(
              await probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(shellPort) }),
              "el puerto shell debe estar cerrado (ausencia real)",
            ).toBe("absent");
            const installedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
              [key: string]: unknown;
            };
            const managedEntry = installedConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER];
            expect(managedEntry, "el primer install debe proyectar el MCP gestionado").toBeDefined();
            installedConfig.mcp!.servers![BROWSER_CONTROL_SERVER]!["environment"] = {
              BROWSER_CONTROL_PORT: String(effectivePort),
            };
            fs.writeFileSync(configPath, `${JSON.stringify(installedConfig, null, 2)}\n`);
            const managedEntryBefore = installedConfig.mcp!.servers![BROWSER_CONTROL_SERVER];
            process.env.BROWSER_CONTROL_PORT = String(await reserveClosedRelayPort());

            // 3) Segundo install real con latest B: el puerto efectivo está vivo,
            //    así que B no puede promoverse.
            vi.clearAllMocks();
            currentRelease = RELEASE_B;
            await runInstall();

            // Criterio A — puerto efectivo / no promoción.
            const activeAfter = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(activeAfter, "el active A debe seguir publicado").not.toBeNull();
            expect(
              activeAfter?.version,
              "el active no debe avanzar a B mientras el relay del puerto EFECTIVO está presente",
            ).toBe(RELEASE_A.version);
            expect(
              fs.readFileSync(activePointer),
              "el pointer del active A debe conservar sus bytes",
            ).toEqual(pointerBytesA);
            expect(
              relayRequests,
              "el gate debe sondear /version en el puerto EFECTIVO del MCP (señal de relay vivo)",
            ).toContain("GET /version");

            const candidateDir = path.join(dataDir(), BC_CANDIDATE_DIRNAME);
            const candidate = loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE);
            expect(candidate, "el candidato B debe quedar retenido").not.toBeNull();
            expect(candidate?.version, "el candidato retenido debe ser B").toBe(RELEASE_B.version);
            expect(candidate?.integrity, "el candidato B debe conservar su SRI").toBe(RELEASE_B.integrity);

            const afterConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
            };
            expect(
              afterConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER],
              "la proyección gestionada A (comando + puerto efectivo) no debe cambiar",
            ).toEqual(managedEntryBefore);
            expect(
              fs.readFileSync(projectedSkill),
              "la skill del active A no debe cambiar",
            ).toEqual(skillA);
            expect(
              loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
              "el claim del MCP gestionado debe conservarse",
            ).toBe(true);

            // Criterio B — diagnóstico conjunto active A + candidato B en el caller.
            const secondLogs = loggedLines();
            const pendingLine = secondLogs.find(
              (line) => line.includes(RELEASE_B.version) && /candidat/i.test(line),
            );
            expect(
              pendingLine,
              `el caller debe diagnosticar el candidato B pendiente: ${secondLogs.join(" | ")}`,
            ).toBeDefined();
            expect(
              pendingLine ?? "",
              "el diagnóstico conjunto debe nombrar el active A",
            ).toContain(RELEASE_A.version);
            expect(
              pendingLine ?? "",
              "el diagnóstico conjunto debe marcar A como active",
            ).toMatch(/active|activo/i);
          } finally {
            opencode.detect = originalDetect;
          }
        },
      );
    } finally {
      await closeRelayServer(relay);
      cleanupOwnedResourcesOrThrow();
    }
  });

  /**
   * T12/T13 late-authentication RED (spec 12/13 §validation): the skill target
   * is absent and unowned before the confirm, a foreign writer creates it during
   * the real prompt, and the post-confirmation authentication must decide. An
   * unowned file identical to the active is a no-op without claim and without
   * replacing its inode; an unowned file with different bytes blocks and is
   * preserved byte a byte, still without claim. Today the final authentication
   * only re-checks the four static resources, so the skill created late is
   * falsely claimed (identical) or overwritten (different).
   */
  const lateAuthCases = [
    { label: "identical current bytes", foreignBytes: BC_SKILL_BYTES, blocked: false },
    {
      label: "different user bytes",
      foreignBytes: Buffer.from(
        "---\nname: browser-control\ndescription: user-authored drift\n---\n\n# user-authored skill\n",
        "utf8",
      ),
      blocked: true,
    },
  ];

  it.each(lateAuthCases)(
    "does not claim or clobber a Browser Control skill created by a foreign writer during the confirm window ($label)",
    async ({ foreignBytes, blocked }) => {
      const observables = await runBrowserSkillConfirmWindow(foreignBytes);

      // The window was actually represented: the foreign file existed with its
      // own bytes and inode before the confirmation resolved.
      expect(observables.confirmOpened, "the apply-changes confirmation must open the window").toBe(true);
      expect(
        observables.bytesAtCreation.equals(foreignBytes),
        "the foreign writer bytes must exist at creation",
      ).toBe(true);
      expect(observables.inoAtCreation).toBeGreaterThan(0);

      // No mutation may adopt or overwrite the foreign file: its bytes and its
      // physical inode must survive the run.
      expect(observables.bytesAfter.equals(foreignBytes), "the foreign skill bytes must be preserved").toBe(true);
      expect(observables.inoAfter, "the foreign skill inode must not be replaced").toBe(observables.inoAtCreation);

      // Coincidencia manual no crea propiedad: the manifest must not claim it.
      expect(observables.ownedIncludesSkill, "the manifest must not claim the foreign skill").toBe(false);

      if (blocked) {
        expect(
          observables.errors.some(
            (line) => line.includes("SKILL.md") && /conserva|preserva|reemplazar|reclamar/i.test(line),
          ),
          `a foreign drift must block with an actionable diagnostic: ${observables.errors.join(" | ")}`,
        ).toBe(true);
      }
    },
  );

  /**
   * T12 vertical de desinstalación (spec 12/13): una instalación real de
   * OpenCode v2 con Browser Control gestionado (MCP + skill owned) se desinstala
   * con la API pública `runUninstall`. El uninstall debe retirar SOLO lo
   * gestionado y ceder su autoridad, conservando la configuración ajena y los
   * datos de navegador.
   *
   * - (a) Entrada gestionada intacta (exactamente `type` + `command`): se
   *   elimina y el ledger libera el claim; la skill owned se retira con backup.
   * - (b) El usuario añade un campo desconocido: el objeto personalizado
   *   completo se conserva (sin perder extras) y solo se libera la autoridad de
   *   ownership; nunca se borra un servidor ajeno ni los datos del navegador.
   *
   * El fetch queda envenenado tras el install para probar que el uninstall es
   * offline: no resuelve `latest` ni sondea el relay (puerto centinela inválido,
   * sin servidor global). Crypto, browser-managed y el ledger corren reales.
   */
  const uninstallCases = [
    { label: "entrada gestionada intacta", personalized: false },
    { label: "entrada personalizada con campo desconocido", personalized: true },
  ];

  it.each(uninstallCases)(
    "retira el MCP y la skill gestionados de Browser Control al desinstalar y conserva lo ajeno ($label)",
    async ({ personalized }) => {
      const fetched: string[] = [];

      try {
        const owned = createOwnedRuntimeHome(".jorgex-browser-control-uninstall-");
        // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989.
        const closedPort = await reserveClosedRelayPort();
        // Layout realista: el configDir de OpenCode vive dentro de HOME. El
        // uninstall ancla el borrado whole-file a HOME, así que un XDG_CONFIG_HOME
        // hermano de HOME dejaría la skill fuera de la frontera y no probaría
        // el contrato de retirada.
        const isolatedXdgConfig = path.join(owned.env.HOME!, ".config");

        await withIsolatedEnv(
          {
            ...process.env,
            ...owned.env,
            XDG_CONFIG_HOME: isolatedXdgConfig,
            BROWSER_CONTROL_PORT: String(closedPort),
          },
          async () => {
            const witness = writeWitnessTree(owned.root);
            const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
              output: "opencode v2.0.20",
            });
            const configDir = path.join(isolatedXdgConfig, "opencode");
            const configPath = path.join(configDir, "opencode.json");
            const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

            const actualStage = await import("../src/lib/browser-stage.js");
            const witnessStaged = {
              treePath: witness.treePath,
              nodeModulesPath: witness.nodeModulesPath,
              treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
              closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
            };
            mockStagedBrowserTree(async () => witnessStaged);
            vi.stubGlobal("fetch", registryFetch(fetched));

            const install = await import("../src/install.js");
            const uninstall = await import("../src/uninstall.js");
            const { dataDir } = await import("../src/lib/paths.js");
            const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");
            const { devtoolsMcpPreferenceFile, loadDevtoolsMcpOwnership } = await import(
              "../src/lib/tool-preferences.js"
            );
            const { readManifest } = await import("../src/lib/manifest.js");
            const { listBackups } = await import("../src/lib/backup.js");

            const opencode = install.ADAPTERS.opencode!;
            const originalDetect = opencode.detect;
            const detection = (): RuntimeDetection => ({
              id: "opencode",
              name: "OpenCode",
              installed: true,
              binPath: opencodeBin,
              configDir,
            });
            opencode.detect = detection;

            try {
              // 1) Instalación real: promueve el active y proyecta MCP + skill.
              await install.runInstall({
                runtimes: ["opencode"],
                command: "install",
                dryRun: false,
                yes: true,
                mode: { mode: "human", subagentConcurrency: "serial" },
                engramBin: null,
              });

              const active = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
              expect(active, "el install debe publicar el active gestionado").not.toBeNull();
              if (active === null) return;

              const installedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
                mcp?: { servers?: Record<string, Record<string, unknown>> };
                [key: string]: unknown;
              };
              const managedEntry = installedConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER];
              expect(managedEntry, "el MCP gestionado debe existir").toBeDefined();
              // Independiente del algoritmo: el entry gestionado sin tocar tiene
              // exactamente los dos campos canónicos.
              expect(Object.keys(managedEntry ?? {}).sort()).toEqual(["command", "type"]);
              expect(
                loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
                "el install debe reclamar la autoridad del MCP",
              ).toBe(true);
              expect(fs.readFileSync(projectedSkill)).toEqual(BC_SKILL_BYTES);
              expect(
                (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file)),
                "el manifest debe declarar owned la skill proyectada",
              ).toContain(path.resolve(projectedSkill));

              // Config ajena del usuario + Engram por defecto (nunca se retira).
              installedConfig.mcp!.servers!["user-custom"] = { type: "local", command: ["/usr/bin/true"] };
              installedConfig.mcp!.servers!["engram"] = { type: "local", command: ["/usr/bin/engram", "mcp"] };
              installedConfig["user-top-level"] = { keep: true };
              if (personalized) {
                installedConfig.mcp!.servers![BROWSER_CONTROL_SERVER]!["x-user-note"] = "keep-me";
              }
              fs.writeFileSync(configPath, `${JSON.stringify(installedConfig, null, 2)}\n`);

              // 2) Offline forzado: cualquier fetch durante el uninstall es un
              //    fallo; el puerto centinela inválido no puede contactar relay.
              const uninstallFetch = vi.fn(async (input: RequestInfo | URL) => {
                throw new Error(`unexpectedNetwork: el uninstall no debe tocar la red (${String(input)})`);
              });
              vi.stubGlobal("fetch", uninstallFetch);
              process.env.BROWSER_CONTROL_PORT = "not-a-port";

              const exit = await uninstall.runUninstall({
                runtimes: ["opencode"],
                dryRun: false,
                yes: true,
                removeEngram: false,
                removePlaywright: false,
              });

              expect(
                uninstallFetch,
                "el uninstall debe ser offline: sin resolución de latest ni sondeo",
              ).not.toHaveBeenCalled();
              expect(exit, `el uninstall debe completar sin errores: ${loggedLines().join(" | ")}`).toBe(0);

              const afterConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
                mcp?: { servers?: Record<string, Record<string, unknown>> };
                [key: string]: unknown;
              };

              // La skill owned se retira con backup previo.
              expect(fs.existsSync(projectedSkill), "la skill gestionada debe retirarse").toBe(false);
              expect(
                listBackups().some((info) =>
                  info.files.some((file) => path.resolve(file.original) === path.resolve(projectedSkill)),
                ),
                "la skill retirada debe quedar respaldada",
              ).toBe(true);

              // Config ajena y Engram por defecto intactos.
              expect(afterConfig.mcp?.servers?.["user-custom"]).toEqual({
                type: "local",
                command: ["/usr/bin/true"],
              });
              expect(afterConfig.mcp?.servers?.["engram"]).toEqual({
                type: "local",
                command: ["/usr/bin/engram", "mcp"],
              });
              expect(afterConfig["user-top-level"]).toEqual({ keep: true });

              // Política: el árbol gestionado y el candidato son datos de
              // navegador; el uninstall no los borra.
              expect(fs.existsSync(active.rootPath), "el árbol gestionado no debe borrarse").toBe(true);
              expect(
                fs.existsSync(path.join(dataDir(), BC_CANDIDATE_DIRNAME)),
                "el candidato retenido no debe borrarse",
              ).toBe(true);

              // El MCP gestionado: caso intacto se retira; caso personalizado
              // sobrevive completo. En ambos, la autoridad de ownership se libera.
              const entryAfter = afterConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER];
              if (personalized) {
                expect(entryAfter, "el objeto personalizado debe conservarse completo").toEqual({
                  ...managedEntry,
                  "x-user-note": "keep-me",
                });
              } else {
                expect(entryAfter, "el entry gestionado intacto debe retirarse").toBeUndefined();
              }
              expect(
                loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
                "la autoridad de ownership debe liberarse",
              ).toBe(false);
            } finally {
              opencode.detect = originalDetect;
            }
          },
        );
      } finally {
        cleanupOwnedResourcesOrThrow();
      }
    },
  );

  /**
   * T12/T13 uninstall fail-closed (spec 12/13, SC-03): la skill Browser Control
   * está owned y proyectada byte-identical al active, pero el usuario modifica
   * sus bytes tras el install. El uninstall no puede borrar ni reemplazar un
   * recurso owned modificado: debe preservarlo byte a byte e identidad, no
   * declarar en el manifest una limpieza que no ocurrió y bloquear con
   * diagnóstico accionable (exit != 0, nunca "Hecho.").
   *
   * Solo cambia la copia proyectada; el árbol gestionado y su SRI/tree siguen
   * válidos, así que la autenticación offline del launcher no se degrada y un
   * setup inválido no puede enmascarar el RED. El fetch queda envenenado tras el
   * install y el puerto centinela es inválido: el uninstall sigue siendo offline.
   */
  it("preserva una skill Browser Control owned modificada y bloquea el uninstall en vez de borrarla", async () => {
    const fetched: string[] = [];

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-uninstall-modified-");
      // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989.
      const closedPort = await reserveClosedRelayPort();
      const isolatedXdgConfig = path.join(owned.env.HOME!, ".config");

      await withIsolatedEnv(
        {
          ...process.env,
          ...owned.env,
          XDG_CONFIG_HOME: isolatedXdgConfig,
          BROWSER_CONTROL_PORT: String(closedPort),
        },
        async () => {
          const witness = writeWitnessTree(owned.root);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(isolatedXdgConfig, "opencode");
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

          const actualStage = await import("../src/lib/browser-stage.js");
          const witnessStaged = {
            treePath: witness.treePath,
            nodeModulesPath: witness.nodeModulesPath,
            treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
            closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
          };
          mockStagedBrowserTree(async () => witnessStaged);
          vi.stubGlobal("fetch", registryFetch(fetched));

          const install = await import("../src/install.js");
          const uninstall = await import("../src/uninstall.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");
          const { readManifest } = await import("../src/lib/manifest.js");

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          const detection = (): RuntimeDetection => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });
          opencode.detect = detection;

          try {
            // 1) Instalación real: active verificado + skill owned proyectada.
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });

            const active = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(active, "el install debe publicar el active gestionado").not.toBeNull();
            if (active === null) return;
            expect(fs.readFileSync(projectedSkill)).toEqual(BC_SKILL_BYTES);
            expect(
              (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file)),
              "el manifest debe declarar owned la skill proyectada",
            ).toContain(path.resolve(projectedSkill));

            // 2) El usuario modifica la copia proyectada. Solo cambia la
            //    proyección: el árbol gestionado y su SRI/tree siguen válidos.
            const userDrift = Buffer.from(
              "---\nname: browser-control\ndescription: user-authored drift\n---\n\n# user-authored skill\n",
              "utf8",
            );
            fs.writeFileSync(projectedSkill, userDrift);
            const inoAfterModify = fs.statSync(projectedSkill).ino;

            // 3) Offline forzado: cualquier fetch durante el uninstall es un
            //    fallo; el puerto centinela inválido no puede contactar relay.
            const uninstallFetch = vi.fn(async (input: RequestInfo | URL) => {
              throw new Error(`unexpectedNetwork: el uninstall no debe tocar la red (${String(input)})`);
            });
            vi.stubGlobal("fetch", uninstallFetch);
            process.env.BROWSER_CONTROL_PORT = "not-a-port";

            const exit = await uninstall.runUninstall({
              runtimes: ["opencode"],
              dryRun: false,
              yes: true,
              removeEngram: false,
              removePlaywright: false,
            });

            // 4) No puede destruir bytes owned modificados: se preservan byte a
            //    byte y sin reescritura (mismo inodo físico).
            expect(fs.existsSync(projectedSkill), "la skill owned modificada no debe borrarse").toBe(true);
            expect(
              fs.readFileSync(projectedSkill),
              "la skill owned modificada debe preservarse byte a byte",
            ).toEqual(userDrift);
            expect(
              fs.statSync(projectedSkill).ino,
              "la skill owned modificada no debe reescribirse",
            ).toBe(inoAfterModify);

            // 5) Sin claim falso de limpieza: el manifest conserva el ownership.
            expect(
              (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file)),
              "el manifest no debe declarar limpiada una skill que se conserva",
            ).toContain(path.resolve(projectedSkill));

            // 6) Resultado honesto: bloqueado, nonzero y nunca "Hecho.".
            expect(exit, `el uninstall debe fallar cerrado: ${loggedLines().join(" | ")}`).not.toBe(0);
            expect(
              prompts.outro.mock.calls.map((call) => String(call[0])).some((line) => line.startsWith("Hecho.")),
              "un uninstall bloqueado no debe anunciar 'Hecho.'",
            ).toBe(false);
            const diagnostics = loggedLines().join("\n");
            expect(diagnostics).toMatch(/SKILL\.md/);
            expect(diagnostics).toMatch(/conserv|preserv|modificad|reclamar/i);
            expect(
              uninstallFetch,
              "el uninstall debe ser offline: sin resolución de latest ni sondeo",
            ).not.toHaveBeenCalled();
          } finally {
            opencode.detect = originalDetect;
          }
        },
      );
    } finally {
      cleanupOwnedResourcesOrThrow();
    }
  });

  /**
   * T12/T13 uninstall con cache ausente (spec 12/13, SC-06/SC-08): una
   * instalación real publica el active gestionado y proyecta MCP + skill owned.
   * Después se mueve TODO el namespace del active owned
   * (`<stateDir>/.browser-managed/browser-control`) a una ruta propia de backup,
   * sin borrar ni forjar/editar ningún receipt: el candidato verificado sigue
   * retenido en su namespace. Con el active ausente, `runUninstall` no puede
   * autenticar la proyección offline y debe bloquear (exit != 0) conservando
   * byte a byte la skill proyectada (mismo inodo), el MCP, el claim, el manifest
   * y los datos ajenos. La autoridad es la lectura cacheada del active: el
   * candidato NUNCA es fallback, no se resuelve `latest` ni se sondea el relay
   * (fetch envenenado y puerto centinela inválido tras el install).
   */
  it("bloquea el uninstall y conserva la proyección cuando el active gestionado está ausente aunque el candidato siga retenido", async () => {
    const fetched: string[] = [];

    try {
      const owned = createOwnedRuntimeHome(".jorgex-browser-control-uninstall-missing-cache-");
      // Own reserved-and-closed port: genuine ECONNREFUSED, never 19989/59999.
      const closedPort = await reserveClosedRelayPort();
      const isolatedXdgConfig = path.join(owned.env.HOME!, ".config");
      // Ruta propia (dentro del root owned) donde se aparca el namespace activo:
      // un rename completo, nunca un borrado ni un receipt forjado/editado.
      const movedActiveNamespace = path.join(owned.root, "moved-active-namespace");

      await withIsolatedEnv(
        {
          ...process.env,
          ...owned.env,
          XDG_CONFIG_HOME: isolatedXdgConfig,
          BROWSER_CONTROL_PORT: String(closedPort),
        },
        async () => {
          const witness = writeWitnessTree(owned.root);
          const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
            output: "opencode v2.0.20",
          });
          const configDir = path.join(isolatedXdgConfig, "opencode");
          const configPath = path.join(configDir, "opencode.json");
          const projectedSkill = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");

          const actualStage = await import("../src/lib/browser-stage.js");
          const witnessStaged = {
            treePath: witness.treePath,
            nodeModulesPath: witness.nodeModulesPath,
            treeSha256: actualStage.browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
            closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity: BC_ROOT_INTEGRITY }],
          };
          mockStagedBrowserTree(async () => witnessStaged);
          vi.stubGlobal("fetch", registryFetch(fetched));

          const install = await import("../src/install.js");
          const uninstall = await import("../src/uninstall.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");
          const { devtoolsMcpPreferenceFile, loadDevtoolsMcpOwnership } = await import(
            "../src/lib/tool-preferences.js"
          );
          const { readManifest } = await import("../src/lib/manifest.js");
          const { listBackups } = await import("../src/lib/backup.js");

          const opencode = install.ADAPTERS.opencode!;
          const originalDetect = opencode.detect;
          const detection = (): RuntimeDetection => ({
            id: "opencode",
            name: "OpenCode",
            installed: true,
            binPath: opencodeBin,
            configDir,
          });
          opencode.detect = detection;

          const activeNamespace = path.join(dataDir(), ".browser-managed", BROWSER_CONTROL_SERVER);
          const candidateDir = path.join(dataDir(), BC_CANDIDATE_DIRNAME);

          try {
            // 1) Instalación real: active publicado, MCP + skill owned, claim y
            //    manifest declarados.
            await install.runInstall({
              runtimes: ["opencode"],
              command: "install",
              dryRun: false,
              yes: true,
              mode: { mode: "human", subagentConcurrency: "serial" },
              engramBin: null,
            });

            const active = loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE);
            expect(active, "el install debe publicar el active gestionado").not.toBeNull();
            if (active === null) return;
            expect(fs.readFileSync(projectedSkill)).toEqual(BC_SKILL_BYTES);
            expect(
              loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
              "el install debe reclamar la autoridad del MCP",
            ).toBe(true);
            expect(
              (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file)),
              "el manifest debe declarar owned la skill proyectada",
            ).toContain(path.resolve(projectedSkill));

            // 2) El candidato verificado queda retenido y es re-verificable: es
            //    el único estado de Browser Control que sobrevive al rename.
            const candidate = loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE);
            expect(candidate, "el candidato verificado debe estar retenido").not.toBeNull();
            if (candidate === null) return;
            expect(candidate.version).toBe(BC_VERSION);

            // Datos ajenos que deben sobrevivir a cualquier intento de uninstall.
            const installedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
              [key: string]: unknown;
            };
            installedConfig.mcp!.servers!["user-custom"] = { type: "local", command: ["/usr/bin/true"] };
            installedConfig.mcp!.servers!["engram"] = { type: "local", command: ["/usr/bin/engram", "mcp"] };
            installedConfig["user-top-level"] = { keep: true };
            fs.writeFileSync(configPath, `${JSON.stringify(installedConfig, null, 2)}\n`);
            const managedEntry = installedConfig.mcp!.servers![BROWSER_CONTROL_SERVER];

            const skillBytesBefore = fs.readFileSync(projectedSkill);
            const skillInoBefore = fs.statSync(projectedSkill).ino;

            // 3) Active ausente por rename completo del namespace owned a una
            //    ruta propia: no se borra nada ni se forja/edita el receipt. El
            //    candidato permanece intacto.
            expect(fs.existsSync(activeNamespace), "el namespace activo debe existir tras el install").toBe(true);
            fs.renameSync(activeNamespace, movedActiveNamespace);
            expect(
              loadVerifiedManagedBrowserReceipt(dataDir(), BC_PACKAGE),
              "el rename debe dejar el active canónico genuinamente ausente",
            ).toBeNull();
            expect(
              fs.existsSync(path.join(movedActiveNamespace, "active.v1.json")),
              "el namespace activo debe conservarse completo en su ruta propia",
            ).toBe(true);
            expect(
              loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE),
              "el candidato debe seguir retenido tras mover el active",
            ).not.toBeNull();

            // 4) Offline forzado tras el install: cualquier fetch es un fallo y
            //    el puerto centinela inválido no puede sondear relay.
            const uninstallFetch = vi.fn(async (input: RequestInfo | URL) => {
              throw new Error(`unexpectedNetwork: el uninstall no debe tocar la red (${String(input)})`);
            });
            vi.stubGlobal("fetch", uninstallFetch);
            process.env.BROWSER_CONTROL_PORT = "not-a-port";

            const exit = await uninstall.runUninstall({
              runtimes: ["opencode"],
              dryRun: false,
              yes: true,
              removeEngram: false,
              removePlaywright: false,
            });

            // 5) Resultado honesto: bloqueado, nonzero, nunca "Hecho." y con la
            //    causa real (active gestionado ausente), no una capacidad falsa.
            expect(exit, `el uninstall debe fallar cerrado: ${loggedLines().join(" | ")}`).not.toBe(0);
            expect(
              prompts.outro.mock.calls.map((call) => String(call[0])).some((line) => line.startsWith("Hecho.")),
              "un uninstall bloqueado no debe anunciar 'Hecho.'",
            ).toBe(false);
            const diagnostics = loggedLines().join("\n");
            expect(diagnostics).toMatch(/browser.?control/i);
            expect(diagnostics).toMatch(/no hay un active gestionado verificado/i);
            expect(diagnostics).toMatch(/conserv|preserv/i);

            // 6) Nada mutado: la skill proyectada conserva bytes e inodo; el MCP,
            //    el claim, el manifest y los datos ajenos quedan intactos.
            expect(fs.existsSync(projectedSkill), "la skill no debe borrarse sin active que la acredite").toBe(true);
            expect(fs.readFileSync(projectedSkill), "la skill debe conservar sus bytes").toEqual(skillBytesBefore);
            expect(fs.statSync(projectedSkill).ino, "la skill no debe reescribirse").toBe(skillInoBefore);
            expect(
              listBackups().some((info) =>
                info.files.some((file) => path.resolve(file.original) === path.resolve(projectedSkill)),
              ),
              "un uninstall bloqueado no debe respaldar ni borrar la skill",
            ).toBe(false);

            const afterConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
              mcp?: { servers?: Record<string, Record<string, unknown>> };
              [key: string]: unknown;
            };
            expect(
              afterConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER],
              "el MCP gestionado no debe retirarse sin active autenticado",
            ).toEqual(managedEntry);
            expect(
              loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
              "el claim de ownership no debe liberarse",
            ).toBe(true);
            expect(
              (readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file)),
              "el manifest no debe declarar limpiada la skill conservada",
            ).toContain(path.resolve(projectedSkill));
            expect(afterConfig.mcp?.servers?.["user-custom"]).toEqual({
              type: "local",
              command: ["/usr/bin/true"],
            });
            expect(afterConfig.mcp?.servers?.["engram"]).toEqual({
              type: "local",
              command: ["/usr/bin/engram", "mcp"],
            });
            expect(afterConfig["user-top-level"]).toEqual({ keep: true });

            // 7) Sin fallback al candidato ni red: el candidato sigue retenido y
            //    el fetch envenenado nunca se invocó.
            expect(
              loadVerifiedManagedBrowserReceipt(candidateDir, BC_PACKAGE),
              "el candidato retenido no debe usarse como fallback ni borrarse",
            ).not.toBeNull();
            expect(
              uninstallFetch,
              "el uninstall debe ser offline: sin resolución de latest ni sondeo",
            ).not.toHaveBeenCalled();
          } finally {
            // Restaurar el namespace movido antes de la limpieza de roots para
            // que una cancelación no deje el fixture a medias.
            if (!fs.existsSync(activeNamespace) && fs.existsSync(movedActiveNamespace)) {
              try {
                fs.renameSync(movedActiveNamespace, activeNamespace);
              } catch {
                // La limpieza del root owned elimina el fixture completo.
              }
            }
            opencode.detect = originalDetect;
          }
        },
      );
    } finally {
      cleanupOwnedResourcesOrThrow();
    }
  });
});
