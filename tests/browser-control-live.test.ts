import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
  runBoundedProcess,
  stopOwnProcessTree,
  type BoundedProcessResult,
} from "./helpers/bounded-process.js";
import {
  createOwnedVerificationHome,
  readPnpmPackageMetadata,
  removeTemporaryRoots,
  resolveVerificationDiskBase,
} from "./helpers/pnpm-tooling.js";
import { prepareVerifiedBrowserRelease } from "../src/lib/browser-provider.js";
import {
  stageVerifiedBrowserTree,
  type StageVerifiedBrowserTreeResult,
} from "../src/lib/browser-stage.js";
import {
  activateManagedBrowserTree,
  planManagedBrowserInvocation,
  resolveStagedBrowserEntry,
  type ManagedBrowserInvocationPlan,
  type ManagedBrowserReceipt,
} from "../src/lib/browser-managed.js";
import {
  BROWSER_CONTROL_PACKAGE,
  browserControlSkillPath,
} from "../src/lib/browser-control-runtime.js";

/**
 * T12/T13: protocolo REAL del complemento publicado `@opencode-ai/browser-control`.
 *
 * Este lane es la única evidencia que ejecuta los bytes OFICIALES: resuelve el
 * `latest` observado del registro, verifica el SRI del tarball raíz y todo el
 * cierre transitivo con `prepareVerifiedBrowserRelease` + `stageVerifiedBrowserTree`,
 * activa el árbol en un stateDir privado y ejecuta el guard gestionado. No usa
 * el doble sintético `tests/helpers/browser-control-ready.ts` (que sólo acredita
 * el contrato de Stack) ni un packument/sandbox fabricado.
 *
 * Gating `JORGEX_BROWSER_CONTROL_LIVE=1`: en la suite ordinaria no hay red,
 * adquisición ni procesos; se salta entero. Windows queda fuera (el runner
 * acotado exige cancelación interceptable); es un riesgo conocido, no una
 * verificación.
 *
 * Límites: sólo `--help` y `skill` del CLI y `initialize` + `tools/list` del MCP.
 * Nunca se invoca una herramienta operativa (`execute`, `status`, sesiones,
 * red, grabación, Chrome, extensión, tabs ni auth). El puerto del relay se
 * reserva con un servidor HTTP propio en loopback (nunca 19989/59999) para
 * contar peticiones: init/tools-list/skill no deben contactar ni arrancar el
 * relay. Todo vive bajo un root privado en disco con teardown registrado antes
 * de crear archivos o procesos.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ENV = "JORGEX_BROWSER_CONTROL_LIVE";
const LIVE = process.env[LIVE_ENV] === "1";
const REQUIRED_PNPM_VERSION = "11.1.1";
const CLI_TIMEOUT_MS = 60_000;
const MCP_TIMEOUT_MS = 60_000;
const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const USER_RELAY_PORTS = new Set([19_989, 59_999]);
const EXPECTED_MCP_TOOLS = ["execute", "skill", "session_list", "session_new", "status"];

interface McpDiscovery {
  readonly initializeResult: Record<string, unknown>;
  readonly tools: ReadonlyArray<Record<string, unknown>>;
  readonly stdout: string;
  readonly stderr: string;
}

interface LiveEvidence {
  readonly release: { version: string; tarballUrl: string; integrity: string };
  readonly observedLatest: string;
  readonly staged: StageVerifiedBrowserTreeResult;
  readonly receipt: ManagedBrowserReceipt;
  readonly help: BoundedProcessResult;
  readonly skillRun: BoundedProcessResult;
  readonly mcp: McpDiscovery;
  readonly skillBytes: Buffer;
}

let evidence: LiveEvidence | undefined;
const versionRequests: string[] = [];
const ownedRoots: string[] = [];
let relayPort = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}

/** Comprueba `engines.node` con la única forma que usa el proveedor (`>=x.y.z`). */
function nodeSatisfiesEngines(nodeVersion: string, range: string): boolean {
  const actual = /^(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
  const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (actual === null || minimum === null) return false;
  const a = [Number(actual[1]), Number(actual[2]), Number(actual[3])];
  const m = [Number(minimum[1]), Number(minimum[2]), Number(minimum[3])];
  for (let index = 0; index < 3; index += 1) {
    const left = a[index]!;
    const right = m[index]!;
    if (left !== right) return left > right;
  }
  return true;
}

/** Base de disco privada fuera del workspace; prefiere `/var/tmp` (disco, no RAM). */
function resolveLiveDiskBase(): string {
  const override = process.env.JORGEX_VERIFICATION_DISK_ROOT?.trim();
  if (override !== undefined && override !== "") {
    return resolveVerificationDiskBase({ repoRoot: REPO_ROOT, env: process.env });
  }
  if (fs.existsSync("/var/tmp") && fs.statSync("/var/tmp").isDirectory()) {
    return resolveVerificationDiskBase({
      repoRoot: REPO_ROOT,
      env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
    });
  }
  return resolveVerificationDiskBase({ repoRoot: REPO_ROOT, env: process.env });
}

/**
 * Resuelve el pnpm 11 exacto del repo desde un entrypoint preparado; valida la
 * metadata real antes de usarlo. Nunca instala, no usa Corepack y no cambia de
 * versión: si no hay un 11.1.1 verificable, falla cerrado.
 */
function resolvePreparedPnpmBin(): string {
  const candidates: string[] = [];
  for (const key of ["JORGEX_PNPM_ENTRYPOINT", "npm_execpath"] as const) {
    const value = process.env[key]?.trim();
    if (value !== undefined && value !== "") candidates.push(value);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory !== "") candidates.push(path.join(directory, "pnpm"));
  }
  for (const candidate of candidates) {
    let metadata: ReturnType<typeof readPnpmPackageMetadata>;
    try {
      metadata = readPnpmPackageMetadata(candidate);
    } catch {
      continue;
    }
    if (metadata === undefined || metadata.version !== REQUIRED_PNPM_VERSION) continue;
    if (fs.existsSync(metadata.binPath) && fs.statSync(metadata.binPath).isFile()) return metadata.binPath;
  }
  throw new Error(
    `No hay un pnpm@${REQUIRED_PNPM_VERSION} preparado y verificable (JORGEX_PNPM_ENTRYPOINT, npm_execpath o PATH); no se instala ni se cambia de versión automáticamente.`,
  );
}

/** Resuelve el `dist-tags.latest` observado de forma independiente al stage. */
async function fetchObservedLatest(): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${BROWSER_CONTROL_PACKAGE}/latest`, {
    redirect: "error",
  });
  if (!response.ok) throw new Error(`registry latest respondió ${response.status}`);
  const body = asRecord(await response.json());
  const version = body?.["version"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("registry latest no declara una versión estable exacta");
  }
  return version;
}

function jsonRpcResponse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Cliente MCP stdio mínimo y acotado: sólo `initialize` + `tools/list`, sin
 * llamadas operativas. El proceso es un grupo propio registrado para teardown;
 * el cierre cierra stdin y, si no termina en la gracia, mata su grupo.
 */
async function discoverMcpTools(
  plan: ManagedBrowserInvocationPlan,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
): Promise<McpDiscovery> {
  const child = spawn(plan.command, [...plan.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  const releasePid = pid === undefined
    ? () => {}
    : registerOwnedResourceCleanup(`browser-control-live-mcp-${pid}`, () => {
        const outcome = stopOwnProcessTree(pid);
        if (!outcome.ok) throw new Error(`no se pudo detener el MCP propio (pid ${pid}): ${outcome.cause}`);
      });

  let stdout = "";
  let stderr = "";
  let closed = false;
  let lineBuffer = "";
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();

  const exitPromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
    child.once("error", () => {
      closed = true;
      resolve();
    });
  });

  const append = (current: string, chunk: string): string =>
    Buffer.byteLength(current, "utf8") >= options.maxBytes ? current : current + chunk;

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = append(stdout, chunk);
    lineBuffer += chunk;
    for (;;) {
      const index = lineBuffer.indexOf("\n");
      if (index < 0) break;
      const line = lineBuffer.slice(0, index);
      lineBuffer = lineBuffer.slice(index + 1);
      const message = jsonRpcResponse(line);
      const id = message?.["id"];
      if (message === null || typeof id !== "number") continue;
      const waiter = waiters.get(id);
      if (waiter !== undefined) {
        waiters.delete(id);
        waiter(message);
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = append(stderr, chunk);
  });
  child.stdin?.on("error", () => {
    // EPIPE durante el cierre acotado es esperado y no altera el resultado.
  });

  const send = (message: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const awaitResponse = (id: number, label: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timeout: sin respuesta a ${label} (id ${id}) en ${options.timeoutMs} ms`));
      }, options.timeoutMs);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

  const killOwned = (): void => {
    if (pid !== undefined && !closed) stopOwnProcessTree(pid);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "jorgex-stack-verification", version: "1.0.0" },
      },
    });
    const initialized = await awaitResponse(1, "initialize");
    if (initialized["error"] !== undefined) {
      throw new Error(`initialize devolvió error: ${JSON.stringify(initialized["error"])}`);
    }
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await awaitResponse(2, "tools/list");
    if (listed["error"] !== undefined) {
      throw new Error(`tools/list devolvió error: ${JSON.stringify(listed["error"])}`);
    }

    const initializeResult = asRecord(initialized["result"]);
    if (initializeResult === null) throw new Error("initialize no devolvió un result objeto");
    const rawTools = asRecord(listed["result"])?.["tools"];
    if (!Array.isArray(rawTools)) throw new Error("tools/list no devolvió un array tools");
    const tools = rawTools
      .map((tool) => asRecord(tool))
      .filter((tool): tool is Record<string, unknown> => tool !== null);

    // Cierre inmediato: el transporte stdio termina al cerrar stdin.
    child.stdin?.end();
    const boundedExit = await Promise.race([
      exitPromise.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    if (boundedExit === "timeout") killOwned();
    await exitPromise;

    return { initializeResult, tools, stdout, stderr };
  } finally {
    if (!closed) {
      killOwned();
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    releasePid();
  }
}

function liveEvidence(): LiveEvidence {
  if (evidence === undefined) throw new Error("la evidencia live no se preparó");
  return evidence;
}

describe.skipIf(!LIVE || process.platform === "win32")(
  "[T12/T13 live] published Browser Control protocol through the verified guard",
  () => {
    let releaseRootCleanup: (() => void) | undefined;
    let relayCleanup: (() => void) | undefined;
    let relayServer: http.Server | undefined;

    beforeAll(async () => {
      // El owner del root se registra ANTES de crear archivos o procesos.
      releaseRootCleanup = registerOwnedResourceCleanup("browser-control-live-root", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const home = createOwnedVerificationHome({
        base: resolveLiveDiskBase(),
        prefix: "jx-browser-control-live-",
        register: (root) => {
          ownedRoots.push(root);
        },
      });
      const stateDir = path.join(home.root, "state");
      const stageParent = path.join(home.root, "stage");
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(stageParent, { recursive: true, mode: 0o700 });

      // Puerto del relay reservado por el test en loopback (nunca 19989/59999).
      relayServer = http.createServer((request, response) => {
        versionRequests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ version: "jorgex-held-port" })}\n`);
      });
      await new Promise<void>((resolve, reject) => {
        relayServer!.once("error", reject);
        relayServer!.listen(0, "127.0.0.1", () => resolve());
      });
      relayCleanup = registerOwnedResourceCleanup("browser-control-live-relay", () => {
        try {
          relayServer?.close();
        } catch {
          // El cierre best-effort no oculta el fallo primario.
        }
      });
      const address = relayServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("no se pudo reservar el puerto de relay propio");
      }
      relayPort = address.port;
      if (USER_RELAY_PORTS.has(relayPort)) {
        throw new Error(`el puerto propio colisionó con un puerto de usuario: ${relayPort}`);
      }

      const pnpmBin = resolvePreparedPnpmBin();
      const observedLatest = await fetchObservedLatest();
      const guardEnv: NodeJS.ProcessEnv = {
        ...home.env,
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        CI: "true",
        NO_UPDATE_NOTIFIER: "1",
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(relayPort),
      };

      let stagedTree: StageVerifiedBrowserTreeResult | undefined;
      let receipt: ManagedBrowserReceipt | undefined;
      let help: BoundedProcessResult | undefined;
      let skillRun: BoundedProcessResult | undefined;
      let mcp: McpDiscovery | undefined;

      const release = await prepareVerifiedBrowserRelease(BROWSER_CONTROL_PACKAGE, {
        fetchImpl: fetch,
        stageParent,
        withVerifiedArtifact: async (context) => {
          const stageDir = fs.mkdtempSync(path.join(context.stageDir, "live-"));
          const staged = await stageVerifiedBrowserTree({
            artifactPath: context.artifactPath,
            packageName: BROWSER_CONTROL_PACKAGE,
            release: context.release,
            stageDir,
            pnpmBin,
            fetchImpl: fetch,
          });
          const entryPath = resolveStagedBrowserEntry(staged, BROWSER_CONTROL_PACKAGE);
          const activated = await activateManagedBrowserTree({
            stateDir,
            packageName: BROWSER_CONTROL_PACKAGE,
            release: context.release,
            staged,
            entryPath,
          });
          stagedTree = staged;
          receipt = activated;

          const runPlan = (runtimeArgs: readonly string[]): Promise<BoundedProcessResult> => {
            const plan = planManagedBrowserInvocation(stateDir, BROWSER_CONTROL_PACKAGE, runtimeArgs);
            return runBoundedProcess(
              { command: plan.command, args: [...plan.args] },
              { cwd: home.root, env: guardEnv, timeoutMs: CLI_TIMEOUT_MS },
            );
          };
          help = await runPlan(["--help"]);
          skillRun = await runPlan(["skill"]);
          mcp = await discoverMcpTools(
            planManagedBrowserInvocation(stateDir, BROWSER_CONTROL_PACKAGE, ["mcp"]),
            { cwd: home.root, env: guardEnv, timeoutMs: MCP_TIMEOUT_MS, maxBytes: MAX_CAPTURED_BYTES },
          );
        },
      });

      if (
        stagedTree === undefined ||
        receipt === undefined ||
        help === undefined ||
        skillRun === undefined ||
        mcp === undefined
      ) {
        throw new Error("la verificación live no produjo evidencia completa");
      }
      evidence = {
        release,
        observedLatest,
        staged: stagedTree,
        receipt,
        help,
        skillRun,
        mcp,
        skillBytes: fs.readFileSync(browserControlSkillPath(receipt)),
      };
    }, 1_200_000);

    afterAll(() => {
      cleanupOwnedResourcesOrThrow();
      relayCleanup?.();
      releaseRootCleanup?.();
    });

    it("resolves the observed registry latest, certifies SRI and the official skill/manifest", () => {
      const live = liveEvidence();
      expect(live.release.version).toBe(live.observedLatest);
      expect(live.release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(live.release.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(live.release.tarballUrl).toBe(
        `https://registry.npmjs.org/${BROWSER_CONTROL_PACKAGE}/-/browser-control-${live.release.version}.tgz`,
      );

      expect(live.receipt.packageName).toBe(BROWSER_CONTROL_PACKAGE);
      expect(live.receipt.version).toBe(live.release.version);
      expect(live.receipt.integrity).toBe(live.release.integrity);
      expect(live.receipt.treeSha256).toBe(live.staged.treeSha256);
      expect(live.receipt.launcherSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(live.receipt.entryPath.startsWith(`${live.receipt.treePath}${path.sep}`)).toBe(true);
      expect(live.staged.closure.some((entry) => entry.name === BROWSER_CONTROL_PACKAGE)).toBe(true);

      // Skill oficial: bytes estrictos UTF-8 dentro del árbol verificado.
      expect(live.skillBytes.length).toBeGreaterThan(0);
      const skillText = live.skillBytes.toString("utf8");
      expect(Buffer.from(skillText, "utf8").equals(live.skillBytes)).toBe(true);
      expect(normalizeText(skillText).length).toBeGreaterThan(200);

      // El stage de adquisición ya se limpió; la copia gestionada es la que
      // persiste y la que el guard ejecuta.
      const managedPackageRoot = path.join(live.receipt.treePath, ...BROWSER_CONTROL_PACKAGE.split("/"));
      const manifest = asRecord(
        JSON.parse(fs.readFileSync(path.join(managedPackageRoot, "package.json"), "utf8")),
      );
      expect(manifest?.["name"]).toBe(BROWSER_CONTROL_PACKAGE);
      expect(manifest?.["version"]).toBe(live.release.version);
      const bin = asRecord(manifest?.["bin"]);
      const cliBin = bin?.["browser-control"];
      const mcpBin = bin?.["browser-control-mcp"];
      expect(typeof cliBin).toBe("string");
      expect(typeof mcpBin).toBe("string");
      expect(path.isAbsolute(cliBin as string)).toBe(false);
      expect(path.isAbsolute(mcpBin as string)).toBe(false);
      const engines = asRecord(manifest?.["engines"]);
      const nodeRange = engines?.["node"];
      expect(typeof nodeRange).toBe("string");
      expect(nodeSatisfiesEngines(process.versions.node, nodeRange as string)).toBe(true);
    });

    it("runs only --help/skill through the guard and discovers MCP tools without relay contact", () => {
      const live = liveEvidence();

      expect(live.help.error, live.help.stderr).toBeUndefined();
      expect(live.help.timedOut).toBe(false);
      expect(live.help.status, live.help.stderr).toBe(0);
      expect(live.help.stdout.length).toBeGreaterThan(0);
      expect(live.help.stdout).toContain("execute");

      expect(live.skillRun.error, live.skillRun.stderr).toBeUndefined();
      expect(live.skillRun.timedOut).toBe(false);
      expect(live.skillRun.status, live.skillRun.stderr).toBe(0);
      expect(normalizeText(live.skillRun.stdout)).toBe(normalizeText(live.skillBytes.toString("utf8")));

      const serverInfo = asRecord(live.mcp.initializeResult["serverInfo"]);
      expect(serverInfo?.["name"]).toBe("browser-control");
      expect(typeof live.mcp.initializeResult["protocolVersion"]).toBe("string");

      const toolNames = live.mcp.tools
        .map((tool) => tool["name"])
        .filter((name): name is string => typeof name === "string");
      expect(toolNames).toEqual(expect.arrayContaining(EXPECTED_MCP_TOOLS));
      expect(toolNames.length).toBeGreaterThanOrEqual(10);
      const skillTool = live.mcp.tools.find((tool) => tool["name"] === "skill");
      expect(skillTool).toBeDefined();
      expect(typeof skillTool?.["description"]).toBe("string");
      expect((skillTool?.["description"] as string | undefined)?.length ?? 0).toBeGreaterThan(0);

      // Documentación oficial: initialize/tools-list/skill no contactan ni
      // arrancan el relay; el puerto reservado no debe recibir peticiones.
      expect(versionRequests).toEqual([]);
    });
  },
);
