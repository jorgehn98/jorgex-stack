import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { BROWSER_CONTROL_PACKAGE } from "../src/lib/browser-control-runtime.js";
import { activateVerifiedBrowserArtifact, prepareVerifiedBrowserRelease } from "../src/lib/browser-provider.js";
import { planManagedBrowserInvocation, type ManagedBrowserReceipt } from "../src/lib/browser-managed.js";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
  runBoundedProcess,
  type BoundedProcessResult,
} from "./helpers/bounded-process.js";
import {
  createOwnedVerificationHome,
  readPnpmPackageMetadata,
  removeTemporaryRoots,
  resolveVerificationDiskBase,
} from "./helpers/pnpm-tooling.js";
import { parseOpenCodeHostVersion } from "./helpers/opencode-host-version.js";

/**
 * T12: el HOST REAL OpenCode v2 consume, por Code Mode, el MCP nativo
 * `browser-control` que Stack proyecta desde un launcher gestionado verificado.
 *
 * Este es el único lane que une las dos piezas ya probadas por separado:
 *   - `tests/opencode-v2-host-plugins.test.ts` arranca el host real con
 *     `run --standalone` y un provider HTTP local (sin cuenta, clave ni modelo
 *     real) que devuelve una `tool_call` determinista.
 *   - `tests/browser-control-live.test.ts` adquiere/activa los bytes OFICIALES
 *     de `@opencode-ai/browser-control` (latest/SRI/cierre) y ejecuta el guard.
 *
 * Contrato observado: con el MCP nativo proyectado por el adapter
 * (`browserControlInvocation` = `planManagedBrowserInvocation(..., ["mcp"])`),
 * el host expone sus herramientas bajo el namespace `browser-control` y el
 * `search` síncrono de Code Mode devuelve, para ese namespace, los `path`
 * bracket exactos (`tools["browser-control"].<tool>`) con `description` y
 * `signature` no vacías. La verificación del namespace cubre `skill`, `execute`
 * y `status` — los tres existen en la release publicada.
 *
 * El host arranca los MCP en paralelo al bucle del agente y el inventario de
 * Code Mode se captura por paso: el primer `execute` del fixture es trivial y el
 * catálogo se pide en el paso siguiente, cuando el MCP ya está registrado.
 *
 * Límites declarados: sólo se llama `search` (descubrimiento del catálogo). No
 * se invoca ninguna herramienta operativa del complemento (navegación, relay,
 * sesiones, extensión, Chrome, tabs, auth ni captura de cuerpos). El puerto del
 * relay se reserva con un servidor HTTP propio en loopback (nunca 19989/59999)
 * y debe recibir CERO peticiones: `initialize`/`tools/list`/`search` no
 * contactan ni arrancan el relay. Todo vive bajo un root privado en disco con
 * teardown registrado antes de crear archivos o procesos.
 *
 * Host: sólo se copian los BYTES del ejecutable indicado por
 * `JORGEX_OPENCODE_V2_BIN` (nunca se ejecuta el binario original en su sitio) y
 * se ejecuta la COPIA, con sha256 revalidado antes y después. El gate exige el
 * contrato API v2: versión semver parseable con major 2, la última instalada
 * observada — NO un pin exacto de release. Versión y sha256 se registran como
 * evidencia de lo ejecutado, nunca como selector. Una versión no parseable o
 * major ≠ 2 falla cerrado en `beforeAll` antes de cualquier `run`/modelo.
 *
 * Gating: `JORGEX_OPENCODE_V2_BIN` + `JORGEX_BROWSER_CONTROL_LIVE=1`. En la
 * suite ordinaria se salta entero (sin red, adquisición ni procesos). Windows
 * queda fuera (el runner acotado exige cancelación interceptable).
 *
 * Las aserciones de forma del evento nativo provienen del código oficial v2
 * (`packages/core/src/codemode/*`, `packages/codemode/src/tool-runtime.ts`) y
 * de la receta ya probada en `opencode-v2-host-plugins.test.ts`.
 */

const hostBinary = process.env.JORGEX_OPENCODE_V2_BIN;
const LIVE = process.env.JORGEX_BROWSER_CONTROL_LIVE === "1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_PNPM_VERSION = "11.1.1";
const HOST_TIMEOUT_MS = 180_000;
/** Margen para que el host conecte el MCP en paralelo antes del primer `execute`. */
const MCP_READY_DELAY_MS = 12_000;
const ACQUISITION_TIMEOUT_MS = 1_800_000;
const USER_RELAY_PORTS = new Set([19_989, 59_999]);
const BROWSER_CONTROL_SERVER = "browser-control";
/** `toolExpression` del namespace con guion: bracket, nunca `browser_control_*`. */
const EXPECTED_CATALOG_PATHS = [
  'tools["browser-control"].execute',
  'tools["browser-control"].skill',
  'tools["browser-control"].status',
] as const;
/** Programa determinista del stub: sólo descubrimiento, ninguna llamada operativa. */
const DISCOVERY_CODE = 'return search({namespace:"browser-control",limit:100});';

interface ToolUseEvent {
  type?: string;
  part?: {
    tool?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      metadata?: { metadata?: unknown; content?: unknown; output?: unknown };
    };
  };
}

interface CatalogItem {
  path: string;
  description: string;
  signature: string;
}

interface Stub {
  port: number;
  close: () => Promise<void>;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** La password del servidor (si apareciera) es una credencial local efímera. */
function sanitized(output: string): string {
  return output.replace(/server password \S+/g, "server password <redacted>");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}

/** Recoge todo texto string contenido en el estado del evento (bounded). */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

function findCatalog(value: unknown, depth = 0): { items: CatalogItem[] } | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCatalog(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record["items"])) {
    const items = record["items"].filter(
      (item): item is CatalogItem =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>)["path"] === "string" &&
        typeof (item as Record<string, unknown>)["description"] === "string" &&
        typeof (item as Record<string, unknown>)["signature"] === "string",
    );
    if (items.length === record["items"].length && items.length > 0) return { items };
  }
  for (const item of Object.values(record)) {
    const found = findCatalog(item, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Extrae el resultado `{items, remaining, next}` del `search` desde el evento. */
function catalogFromEvent(event: ToolUseEvent): { items: CatalogItem[] } | undefined {
  const strings: string[] = [];
  collectStrings(event.part?.state?.output, strings);
  collectStrings(event.part?.state?.metadata?.content, strings);
  collectStrings(event.part?.state?.metadata?.output, strings);
  for (const candidate of strings) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const found = findCatalog(parsed);
    if (found !== undefined) return found;
  }
  return undefined;
}

function eventText(event: ToolUseEvent): string {
  const strings: string[] = [];
  collectStrings(event.part?.state?.output, strings);
  collectStrings(event.part?.state?.metadata?.content, strings);
  collectStrings(event.part?.state?.metadata?.output, strings);
  return strings.join("\n");
}

function findToolEvents(stdout: string, tool: string): ToolUseEvent[] {
  const events: ToolUseEvent[] = [];
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as ToolUseEvent;
      if (parsed.type === "tool_use" && parsed.part?.tool === tool) events.push(parsed);
    } catch {
      // Ignora líneas no JSON (no debería haber con --format json).
    }
  }
  return events;
}

function recordedToolCalls(event: ToolUseEvent): Array<{ tool?: string; status?: string }> {
  const metadata = event.part?.state?.metadata?.metadata as
    | { toolCalls?: unknown; error?: unknown }
    | undefined;
  if (metadata === undefined || !Array.isArray(metadata.toolCalls)) return [];
  return metadata.toolCalls.filter(
    (call): call is { tool?: string; status?: string } => call !== null && typeof call === "object",
  );
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

/** Resuelve el pnpm 11 exacto preparado; nunca instala ni cambia de versión. */
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

describe.skipIf(hostBinary === undefined || !LIVE || process.platform === "win32")(
  "[T12] host real OpenCode v2 consume el MCP nativo browser-control por Code Mode",
  () => {
    let runRoot = "";
    let copy = "";
    let observedVersion = "";
    let configDir = "";
    let cwd = "";
    let stateDir = "";
    let stageParent = "";
    let ghConfigDir = "";
    let binDir = "";
    let receipt: ManagedBrowserReceipt | undefined;
    let hostResult: BoundedProcessResult | undefined;
    let executeEvents: ToolUseEvent[] = [];
    let stub: Stub | undefined;
    let relayServer: http.Server | undefined;
    let relayCleanup: (() => void) | undefined;
    let releaseRootCleanup: (() => void) | undefined;
    const ownedRoots: string[] = [];
    const relayRequests: string[] = [];
    let relayPort = 0;

    function hostEnv(): NodeJS.ProcessEnv {
      // PATH propio primero (gh falso privado, nunca el real). HOME/XDG/TMP
      // privados: la copia no ve config, auth, caches ni perfil del usuario.
      return {
        PATH: `${binDir}:/usr/bin:/bin`,
        GH_CONFIG_DIR: ghConfigDir,
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        HOME: path.join(runRoot, "home"),
        XDG_CONFIG_HOME: path.join(runRoot, "config"),
        XDG_DATA_HOME: path.join(runRoot, "data"),
        XDG_CACHE_HOME: path.join(runRoot, "cache"),
        XDG_STATE_HOME: path.join(runRoot, "state"),
        XDG_RUNTIME_DIR: path.join(runRoot, "runtime"),
        TMPDIR: path.join(runRoot, "tmp"),
        OPENCODE_CONFIG_DIR: configDir,
        NO_COLOR: "1",
      };
    }

    /** Config real del producto (sólo `planMainConfig`): el MCP nativo verificado. */
    function projectConfig(invocation: { command: string; args: readonly string[] }): void {
      fs.mkdirSync(configDir, { recursive: true });
      const ctx = {
        stackDir: stackRoot(),
        configDir,
        engramBin: null,
        models: DEFAULT_MODEL_MAP.opencode,
        warnings: [] as string[],
        browserControlInvocation: invocation,
      };
      for (const action of opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx)) {
        fs.mkdirSync(path.dirname(action.target), { recursive: true });
        if (action.kind === "write") fs.writeFileSync(action.target, action.content);
        else fs.copyFileSync(action.source, action.target);
      }
    }

    function configFileOf(): string {
      const found = ["opencode.json", "opencode.jsonc"]
        .map((name) => path.join(configDir, name))
        .find((candidate) => fs.existsSync(candidate));
      expect(found, `config proyectada en ${configDir}`).toBeDefined();
      return found!;
    }

    /**
     * Ajustes SOLO de fixture: provider stub local, update desactivado, todos
     * los MCP ajenos desactivados y el entorno del relay señuelo propio en el
     * MCP `browser-control`. El comando gestionado no se toca.
     */
    function injectFixtureProvider(port: number): void {
      const configFile = configFileOf();
      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, any>;
      config["update"] = "disable";
      config["model"] = "fixture/fixture";
      config["small_model"] = "fixture/fixture";
      config["providers"] = {
        fixture: {
          name: "Local fixture",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${port}/v1` },
          models: { fixture: { name: "fixture", limit: { context: 100_000, output: 10_000 } } },
        },
      };
      const servers = (config["mcp"] as { servers?: Record<string, any> } | undefined)?.servers ?? {};
      for (const [name, entry] of Object.entries(servers)) {
        if (name === BROWSER_CONTROL_SERVER) continue;
        (entry as Record<string, unknown>)["disabled"] = true;
      }
      const browserControl = servers[BROWSER_CONTROL_SERVER] as Record<string, unknown> | undefined;
      expect(browserControl, "el adapter proyecta mcp.servers['browser-control']").toBeDefined();
      browserControl!["environment"] = {
        BROWSER_CONTROL_AUTOSTART: "false",
        BROWSER_CONTROL_PORT: String(relayPort),
      };
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    }

    /** Stub OpenAI-compatible local: sin red externa, credenciales ni modelo real. */
    function startStub(code: string): Promise<Stub> {
      const server = http.createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        let body: { messages?: Array<{ role?: string; content?: unknown }> };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          response.writeHead(404);
          response.end();
          return;
        }
        const first = body.messages?.[0];
        const firstSystem = typeof first?.content === "string" ? first.content : "";
        const isTitle = /title generator|Generate a brief title/i.test(firstSystem);
        const toolResults = (body.messages ?? []).filter((message) => message.role === "tool").length;
        // El host arranca los MCP en paralelo al bucle del agente. El primer turno
        // espera a que el guard/MCP conecte y ejecuta un `execute` trivial; el
        // segundo turno (paso nuevo) pide el catálogo, ya con el MCP registrado.
        if (!isTitle && toolResults === 0) {
          await new Promise((resolve) => setTimeout(resolve, MCP_READY_DELAY_MS));
        }
        const finished = isTitle || toolResults >= 2;
        const turnCode = toolResults === 0 ? "return 1;" : code;
        const delta =
          finished
            ? { content: "fixture" }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${toolResults}`,
                    type: "function",
                    function: { name: "execute", arguments: JSON.stringify({ code: turnCode }) },
                  },
                ],
              };
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
      return new Promise<Stub>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("no se pudo reservar el puerto del stub"));
            return;
          }
          resolve({
            port: address.port,
            close: async () => {
              server.closeAllConnections?.();
              await new Promise<void>((done) => server.close(() => done()));
            },
          });
        });
      });
    }

    beforeAll(async () => {
      expect(hostBinary, "JORGEX_OPENCODE_V2_BIN").toBeDefined();

      // El owner del root se registra ANTES de crear archivos o procesos.
      releaseRootCleanup = registerOwnedResourceCleanup("browser-control-host-root", () =>
        removeTemporaryRoots(ownedRoots),
      );
      const home = createOwnedVerificationHome({
        base: resolveLiveDiskBase(),
        prefix: "jx-browser-control-host-",
        register: (root) => {
          ownedRoots.push(root);
        },
      });
      runRoot = home.root;
      configDir = path.join(runRoot, "config", "opencode");
      cwd = path.join(runRoot, "cwd");
      binDir = path.join(runRoot, "bin");
      ghConfigDir = path.join(runRoot, "gh-config");
      stateDir = path.join(runRoot, "browser-control-state");
      stageParent = path.join(runRoot, "stage");
      for (const directory of [configDir, cwd, binDir, ghConfigDir, stateDir, stageParent, path.join(runRoot, "data"), path.join(runRoot, "cache"), path.join(runRoot, "state"), path.join(runRoot, "runtime"), path.join(runRoot, "tmp")]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }

      // `gh` FALSO privado: si algo lo invocara, deja marcador y sale ≠ 0; nunca
      // toca red, credenciales ni un PR real. El complemento no usa gh, así que
      // el marcador no debe existir al final.
      fs.writeFileSync(
        path.join(binDir, "gh"),
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          `fs.writeFileSync(${JSON.stringify(path.join(runRoot, "gh-invoked.json"))}, JSON.stringify(process.argv.slice(2)));`,
          'process.stdout.write("fake gh: offline fixture\\n");',
          "process.exit(7);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.chmodSync(path.join(binDir, "gh"), 0o755);

      // Copia privada del ejecutable autorizado; se ejecuta la COPIA, nunca el
      // original en su sitio. SHA origen vs copia antes de cualquier exec.
      copy = path.join(runRoot, "opencode-copy");
      fs.copyFileSync(hostBinary!, copy);
      fs.chmodSync(copy, 0o500);
      expect(sha256(copy), "sha256 copia == original").toBe(sha256(hostBinary!));

      const versionRun = await runBoundedProcess(
        { command: copy, args: ["--version"] },
        { cwd: runRoot, env: hostEnv(), timeoutMs: 60_000 },
      );
      expect(versionRun.error, sanitized(versionRun.stderr)).toBeUndefined();
      expect(versionRun.status, sanitized(versionRun.stderr)).toBe(0);
      observedVersion = versionRun.stdout.trim();
      // Contrato API v2: semver parseable con major 2 (última instalada
      // observada). Versión/SHA son evidencia, no selector de release.
      const parsedVersion = parseOpenCodeHostVersion(observedVersion);
      expect(parsedVersion, `versión observada semver parseable: ${observedVersion}`).toBeDefined();
      expect(parsedVersion!.major, `major 2 en ${observedVersion}`).toBe(2);
      expect(sha256(copy), "sha256 copia intacta tras --version").toBe(sha256(hostBinary!));

      // Puerto del relay señuelo reservado por el test en loopback.
      relayServer = http.createServer((request, response) => {
        relayRequests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ version: "jorgex-held-port" })}\n`);
      });
      await new Promise<void>((resolve, reject) => {
        relayServer!.once("error", reject);
        relayServer!.listen(0, "127.0.0.1", () => resolve());
      });
      relayCleanup = registerOwnedResourceCleanup("browser-control-host-relay", () => {
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

      // Adquisición/activación OFICIAL en un stateDir privado, reutilizando el
      // pipeline verificado (latest/SRI/cierre). El guard se planifica después.
      const pnpmBin = resolvePreparedPnpmBin();
      let activated: ManagedBrowserReceipt | undefined;
      await prepareVerifiedBrowserRelease(BROWSER_CONTROL_PACKAGE, {
        fetchImpl: fetch,
        stageParent,
        withVerifiedArtifact: async (context) => {
          activated = await activateVerifiedBrowserArtifact(context, {
            stateDir,
            pnpmBin,
            fetchImpl: fetch,
          });
        },
      });
      if (activated === undefined) throw new Error("la adquisición no activó el complemento Browser Control");
      receipt = activated;
      const invocation = planManagedBrowserInvocation(stateDir, BROWSER_CONTROL_PACKAGE, ["mcp"]);

      projectConfig(invocation);

      stub = await startStub(DISCOVERY_CODE);
      injectFixtureProvider(stub.port);

      hostResult = await runBoundedProcess(
        {
          command: copy,
          args: [
            "run",
            "--standalone",
            "--print-logs",
            "--log-level",
            "warn",
            "--format",
            "json",
            "--auto",
            "--model",
            "fixture/fixture",
            "--title",
            "browser control fixture",
            "Use the local fixture once.",
          ],
        },
        { cwd, env: hostEnv(), timeoutMs: HOST_TIMEOUT_MS },
      );
      executeEvents = findToolEvents(hostResult.stdout, "execute");
    }, ACQUISITION_TIMEOUT_MS);

    afterAll(async () => {
      await stub?.close();
      // El owner detiene primero los grupos propios y sólo después ejecuta los
      // callbacks de root; un grupo sin verificar conserva los roots.
      cleanupOwnedResourcesOrThrow();
      relayCleanup?.();
      releaseRootCleanup?.();
    }, 120_000);

    it("copia solo el ejecutable autorizado y observa el host real major 2", () => {
      expect(sha256(copy)).toBe(sha256(hostBinary!));
      const parsedVersion = parseOpenCodeHostVersion(observedVersion);
      expect(parsedVersion, `versión observada semver parseable: ${observedVersion}`).toBeDefined();
      expect(parsedVersion!.major, `major 2 en ${observedVersion}`).toBe(2);
      expect(receipt?.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("expone el catálogo nativo browser-control por Code Mode sin llamada operativa", () => {
      expect(hostResult, "el host corrió").toBeDefined();
      const result = hostResult!;
      expect(result.error, sanitized(result.stderr).slice(-600)).toBeUndefined();
      expect(result.timedOut).toBe(false);
      expect(result.status, `run salió con ${result.status}. stderr: ${sanitized(result.stderr).slice(-800)}`).toBe(0);

      const event = executeEvents.at(-1);
      expect(event, `evento tool_use 'execute'. stdout: ${sanitized(result.stdout).slice(-800)}`).toBeDefined();
      expect(event!.part?.state?.status, eventText(event!)).toBe("completed");

      const metadata = event!.part?.state?.metadata?.metadata as
        | { toolCalls?: unknown; error?: unknown }
        | undefined;
      expect(metadata?.error, "Code Mode no devolvió error").toBeUndefined();

      // Ninguna llamada operativa del complemento: el único tool call es el
      // builtin `search` del catálogo, nunca `browser-control.*`.
      const calls = recordedToolCalls(event!);
      expect(calls.map((call) => call.tool), "sin llamada operativa browser-control").not.toContain(
        expect.stringMatching(/^browser-control/),
      );
      expect(calls.every((call) => call.status === "completed"), JSON.stringify(calls)).toBe(true);

      // Catálogo exacto del namespace con guion: bracket, no underscore.
      const catalog = catalogFromEvent(event!);
      expect(
        catalog,
        `catálogo browser-control en el evento: ${eventText(event!).slice(0, 800)}\nstderr: ${sanitized(result.stderr).slice(-2500)}\nstdout tail: ${sanitized(result.stdout).slice(-1500)}`,
      ).toBeDefined();
      const paths = catalog!.items.map((item) => item.path);
      for (const expected of EXPECTED_CATALOG_PATHS) {
        const item = catalog!.items.find((entry) => entry.path === expected);
        expect(
          item,
          `path ${expected} en ${paths.join(", ")}\nstderr: ${sanitized(result.stderr).slice(-2500)}`,
        ).toBeDefined();
        expect(normalizeText(item!.description).length, `descripción de ${expected}`).toBeGreaterThan(0);
        expect(normalizeText(item!.signature).length, `firma de ${expected}`).toBeGreaterThan(0);
        expect(item!.signature, `firma bracket de ${expected}`).toContain("Promise<");
      }

      // `initialize`/`tools/list`/`search` no contactan ni arrancan el relay.
      expect(relayRequests, "el relay señuelo propio no recibe peticiones").toEqual([]);
      // El `gh` falso no se invoca: el complemento no usa credenciales ni PR.
      expect(fs.existsSync(path.join(runRoot, "gh-invoked.json")), "sin gh").toBe(false);
    });
  },
);
