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

/**
 * T12 RED — integración raíz de Browser Control pendiente (Spec T12/T13).
 *
 * Contrato observable a través de la API `runInstall` existente, sin importar
 * módulos inexistentes: una instalación real de OpenCode v2 adquiere el paquete
 * obligatorio `@opencode-ai/browser-control` desde el registro (metadata latest
 * + tarball SRI), lo retiene como candidato verificado en
 * `<stateDir>/.browser-control-candidate` y NO lo publica como active cuando el
 * relay está presente en `BROWSER_CONTROL_PORT`. La capacidad no se declara:
 * no hay MCP `browser-control` ni skill que apunten al candidato, el namespace
 * operativo queda vacío y el comando no reporta éxito.
 *
 * Frontera del doble (deliberadamente estrecha): solo se sustituye
 * `stageVerifiedBrowserTree` por un testigo real en disco; `node:crypto`,
 * `browserTreeSha256`, `activateManagedBrowserTree` y
 * `loadVerifiedManagedBrowserReceipt` corren reales. El fetch externo se
 * stubea (packument + tarball del root) y el relay es un servidor HTTP propio
 * en un puerto aleatorio. Cualquier otro fetch falla cerrado.
 *
 * RED de primera ejecución: hoy `runInstall` no consulta el registro de
 * Browser Control (`fetch` no recibe la URL de metadata), así que la primera
 * aserción falla por comportamiento ausente, no por setup inválido.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BC_PACKAGE = "@opencode-ai/browser-control";
const BC_VERSION = "9.9.30";
const BC_METADATA_URL = `https://registry.npmjs.org/${BC_PACKAGE}`;
const BC_TARBALL_URL = `https://registry.npmjs.org/${BC_PACKAGE}/-/${BC_PACKAGE.slice(BC_PACKAGE.lastIndexOf("/") + 1)}-${BC_VERSION}.tgz`;
const BC_ROOT_BYTES = Buffer.from("official-browser-control-root-9.9.30\n");
const BC_ROOT_INTEGRITY = `sha512-${createHash("sha512").update(BC_ROOT_BYTES).digest("base64")}`;

const BROWSER_CONTROL_SERVER = "browser-control";

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

function writeWitnessTree(root: string): Witness {
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
        version: BC_VERSION,
        bin: { [BROWSER_CONTROL_SERVER]: "dist/cli.js" },
        engines: { node: ">=22.19.0" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, BC_ROOT_BYTES);
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

/** Generic provider fixture: only the Browser Control metadata and its root tarball. */
function registryFetch(seen: string[]): typeof fetch {
  const packument = {
    name: BC_PACKAGE,
    "dist-tags": { latest: BC_VERSION },
    versions: {
      [BC_VERSION]: {
        name: BC_PACKAGE,
        version: BC_VERSION,
        dist: { tarball: BC_TARBALL_URL, integrity: BC_ROOT_INTEGRITY },
      },
    },
  };
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    if (url === BC_METADATA_URL) {
      const response = new Response(JSON.stringify(packument), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url === BC_TARBALL_URL) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BC_ROOT_BYTES.slice());
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

async function startRelayVersionServer(requests: string[]): Promise<{ server: Server; port: number }> {
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
    server.listen(0, "127.0.0.1", () => resolve());
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

describe.skipIf(process.platform !== "linux")("[T12-RED] Browser Control pending integration", () => {
  it("retains a verified Browser Control candidate without activating it while the relay is present", async () => {
    const ownedRoots: string[] = [];
    // Owned-resource owner armed before the first root or server exists.
    const releaseRoots = registerOwnedResourceCleanup("browser-control-runtime-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    let relay: Server | undefined;
    const fetched: string[] = [];
    const relayRequests: string[] = [];

    try {
      const base = resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
      });
      const owned = createOwnedVerificationHome({
        base,
        prefix: ".jorgex-browser-control-runtime-",
        register: (root) => ownedRoots.push(root),
      });
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
          vi.doMock("../src/lib/browser-stage.js", async () => {
            const actual =
              await vi.importActual<typeof import("../src/lib/browser-stage.js")>(
                "../src/lib/browser-stage.js",
              );
            return { ...actual, stageVerifiedBrowserTree: async () => witnessStaged };
          });
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
      releaseRoots();
    }
  });

  it("acquires the verified candidate and reports honest pending when the relay is absent", async () => {
    const ownedRoots: string[] = [];
    const releaseRoots = registerOwnedResourceCleanup("browser-control-absent-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
    const fetched: string[] = [];
    const runtimeStatuses: [string, string][] = [];

    try {
      const base = resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
      });
      const owned = createOwnedVerificationHome({
        base,
        prefix: ".jorgex-browser-control-absent-",
        register: (root) => ownedRoots.push(root),
      });
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
          vi.doMock("../src/lib/browser-stage.js", async () => {
            const actual =
              await vi.importActual<typeof import("../src/lib/browser-stage.js")>(
                "../src/lib/browser-stage.js",
              );
            return { ...actual, stageVerifiedBrowserTree: async () => witnessStaged };
          });
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
              onRuntimeStatus: (name, status) => runtimeStatuses.push([name, status]),
            });
          } finally {
            opencode.detect = originalDetect;
          }

          // 1) Mandatory acquisition is not skipped just because the relay is
          //    absent: registry latest + root tarball SRI only.
          expect(fetched, "Browser Control acquisition must run even when the relay is absent").toEqual([
            BC_METADATA_URL,
            BC_TARBALL_URL,
          ]);

          // 2) Verified candidate retained under the fixed candidate namespace.
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

          // 4) The runtime status is a real failure, not a silent complete.
          expect(runtimeStatuses).toContainEqual(["OpenCode", "failed"]);

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
      cleanupOwnedResourcesOrThrow();
      releaseRoots();
    }
  });
});
