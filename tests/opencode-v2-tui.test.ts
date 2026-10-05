import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { FileAction } from "../src/adapters/types.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { TEST_MODEL_MAP as DEFAULT_MODEL_MAP } from "./fixtures/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedProcessGroup,
  registerOwnedResourceCleanup,
  runBoundedProcess,
  stopOwnProcessTree,
  type ProcessInvocation,
} from "./helpers/bounded-process.js";
import { parseOpenCodeHostVersion } from "./helpers/opencode-host-version.js";

/**
 * Protección del panel TUI v2 (Spec T18/SC-11). Dos contratos distintos:
 *
 * 1. `stack/assets/opencode/tui/subagents/state.mjs` es matemática pura
 *    (clasificación running/done/blocked, elapsed finito, tokens y modelo). Se
 *    importa por URL dinámica, sin depender del host, y corre SIEMPRE.
 * 2. El ABI real del plugin contra el host OpenCode v2 (`Plugin.define`,
 *    `context.ui.slot`, `context.keymap.layer` dentro del slot app montado,
 *    `context.data.session.*`). Solo se verifica con el binario real, gated por
 *    `JORGEX_OPENCODE_V2_BIN` (misma convención que
 *    `opencode-v2-host-plugins.test.ts`): copia privada SHA-idéntica, servidor
 *    propio y un stub OpenAI-compatible local (sin auth, sin egress, sin modelo
 *    real) para producir una ejecución foreground controlada running→done. El
 *    único fixture nuevo es `tests/fixtures/tui-pty.py`, un driver PTY mínimo
 *    reutilizable.
 *
 * El aislamiento de HOME/XDG/OPENCODE_CONFIG_DIR es defensa adicional, no la
 * barrera: la lectura de código oficial mostró discovery y consumidores de
 * `os.homedir()` fuera de esa abstracción. Las tres invocaciones de la copia
 * (`--version`, servidor y TUI) pasan por `sandboxInvocation`, que reusa el
 * `bwrap` del sistema con namespace de usuario/pid y un filesystem vacío: solo
 * runtime del sistema de solo lectura, `/proc`/`/dev` propios y la raíz temporal
 * propia en escritura. No se enlazan `/`, `/home`, `/root`, `/run` ni el repo.
 * Antes de copiar/ejecutar el host, un probe `/bin/sh` certifica la ausencia de
 * las rutas reales del perfil y la disponibilidad de la raíz propia. Es barrera
 * de filesystem, no promesa de namespace de red (el stub/servidor propios
 * conservan loopback). El ejecutable original solo se lee para copiarlo; nunca se
 * ejecuta.
 */
const hostBinary = process.env.JORGEX_OPENCODE_V2_BIN;
const python = process.env.JORGEX_PYTHON ?? "python3";
const repoRoot = path.resolve(stackRoot(), "..");
const ptyFixture = path.join(repoRoot, "tests", "fixtures", "tui-pty.py");
const CASE_TIMEOUT_MS = 150_000;
const BWRAP = "/usr/bin/bwrap";

const state = await import(
  pathToFileURL(path.join(stackRoot(), "assets", "opencode", "tui", "subagents", "state.mjs")).href
);

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Único punto que construye la barrera de filesystem del host. Devuelve bwrap
 * con un allowlist fijo, la raíz sandbox propia (que contiene la copia y los
 * casos) enlazada en su misma ruta absoluta, y el cwd indicado. No enlaza `/`,
 * `/home`, `/root`, `/run`, el repo ni ningún ancestro del perfil.
 */
function sandboxInvocation(sandboxRoot: string, cwd: string, command: string[]): ProcessInvocation {
  return {
    command: BWRAP,
    args: [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--dir", "/home",
      "--dir", "/root",
      "--dir", "/run",
      "--tmpfs", "/var/tmp",
      "--bind", sandboxRoot, sandboxRoot,
      "--chdir", cwd,
      ...command,
    ],
  };
}

/** Perfil real derivado de passwd y directorio real del binario fuente. */
function realProfilePaths(): { home: string; opencodeHome: string; sourceParent: string } {
  const home = os.userInfo().homedir;
  return {
    home,
    opencodeHome: path.join(home, ".opencode"),
    sourceParent: path.dirname(hostBinary ?? ""),
  };
}

/** La raíz propia debe quedar fuera del home real y del repo. */
function assertOwnRootOutsideProfiles(root: string): void {
  const real = fs.realpathSync(root);
  const forbidden = [
    ["home real", fs.realpathSync(os.userInfo().homedir)],
    ["repo", fs.realpathSync(repoRoot)],
  ] as const;
  for (const [label, ancestor] of forbidden) {
    if (real === ancestor || real.startsWith(`${ancestor}${path.sep}`)) {
      throw new Error(`la raíz propia queda dentro de ${label}: ${real}`);
    }
  }
}

/**
 * Probe del MISMO wrapper antes de copiar/ejecutar el host: certifica que las
 * rutas reales del perfil están ausentes y que la raíz propia es accesible.
 * Los paths viajan como argv posicional, nunca interpolados en el shell.
 */
async function probeSandbox(root: string): Promise<void> {
  const marker = path.join(root, "sandbox-probe-marker");
  fs.writeFileSync(marker, "own-root-accessible\n");
  const { home, opencodeHome, sourceParent } = realProfilePaths();
  const script = 'set -eu\ntest ! -e "$1"\ntest ! -e "$2"\ntest ! -e "$3"\ntest -e "$4"\n';
  const result = await runBoundedProcess(
    sandboxInvocation(root, path.join(root, "cwd"), ["/bin/sh", "-c", script, "probe", home, opencodeHome, sourceParent, marker]),
    { cwd: path.join(root, "cwd"), env: hostEnv(root), timeoutMs: 15_000 },
  );
  if (result.timedOut) throw new Error("el probe de sandbox no terminó a tiempo");
  if (result.treeCleanupError !== undefined) {
    throw new Error(`probe de sandbox sin limpieza verificada: ${result.treeCleanupError.cause}`);
  }
  if (result.error !== undefined) throw new Error(`probe de sandbox falló: ${redact(result.error.message)}`);
  if (result.status !== 0) {
    throw new Error(
      `el probe de sandbox no certificó el aislamiento (status ${String(result.status)}): ${redact(result.stderr).trim().slice(0, 200)}`,
    );
  }
}

function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout esperando ${label}`));
      }
    }, 100);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nunca persistir ni volcar credenciales del servidor propio efímero. */
function redact(text: string): string {
  return text
    .replace(/server password \S+/g, "server password <redacted>")
    .replace(/opencode:[A-Za-z0-9_-]+/g, "opencode:<redacted>")
    .replace(/authorization: Basic \S+/gi, "authorization: Basic <redacted>");
}

/** Detiene un grupo propio y confirma su desaparición antes de tocar ficheros. */
async function stopGroupAndConfirm(pid: number, label: string): Promise<string | undefined> {
  const outcome = stopOwnProcessTree(pid);
  if (!outcome.ok) return `${label} pid ${pid}: ${outcome.cause}`;
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return undefined;
      return `${label} pid ${pid}: ${describeError(error)}`;
    }
    if (Date.now() > deadline) return `${label} pid ${pid}: sigue vivo tras SIGKILL`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Cierra un arranque fallido del servidor propio. Devuelve `true` solo cuando el
 * stop quedó confirmado (el llamador libera el registro del owner); si no,
 * registra la causa en el estado del caso antes de que el arranque falle, de modo
 * que el guard de raíz existente preserve la raíz. `stopGroup` es el seam
 * determinista que consume este control.
 */
async function settleFailedStart(
  pid: number,
  unconfirmed: string[],
  stopGroup: (pid: number, label: string) => Promise<string | undefined> = stopGroupAndConfirm,
): Promise<boolean> {
  const stopFailure = await stopGroup(pid, "servidor propio");
  if (stopFailure === undefined) return true;
  unconfirmed.push(stopFailure);
  return false;
}

/** Confirma el grupo del TUI capturado por el llamador (pty.fork lo hace líder de sesión). */
async function stopTuiGroupAndConfirm(pid: number | undefined): Promise<string | undefined> {
  if (pid === undefined) return undefined; // el fixture no registró grupo: no hay TUI vivo
  return stopGroupAndConfirm(pid, "TUI pty");
}

/** Espera acotada al registro `<out>.tui.pid`; el fixture lo retira tras reapear el TUI. */
async function waitForTuiPid(out: string, timeoutMs: number): Promise<number | undefined> {
  const pidFile = `${out}.tui.pid`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Solo el stop propio identificado (AbortError del controller propio) y los
 * códigos de desconexión conocidos del cliente son esperados; un TypeError u
 * otro fallo del handler queda observable aunque la conexión esté destruida.
 * `ERR_STREAM_WRITE_AFTER_END` no es una causa de desconexión.
 */
function isExpectedStubStop(error: unknown, controller: AbortController): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (controller.signal.aborted && (name === "AbortError" || code === "ABORT_ERR")) return true;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

describe("state.mjs: matemática pura del panel (Spec T18)", () => {
  it("clasifica running/done/blocked/stopped/idle con blocked por precedencia", () => {
    expect(state.subagentState("running", undefined)).toBe("running");
    expect(state.subagentState(undefined, "succeeded")).toBe("done");
    expect(state.subagentState(undefined, "failed")).toBe("failed");
    expect(state.subagentState(undefined, "interrupted")).toBe("stopped");
    expect(state.subagentState(undefined, undefined)).toBe("idle");
    expect(state.subagentState("running", "succeeded", true)).toBe("blocked");
  });

  it("solo running/blocked cuentan como activos", () => {
    expect(state.isActiveSubagent("running")).toBe(true);
    expect(state.isActiveSubagent("blocked")).toBe(true);
    expect(state.isActiveSubagent("done")).toBe(false);
    expect(state.isActiveSubagent("idle")).toBe(false);
  });

  it("elapsed solo para activos con inicio finito, en mm:ss y hh:mm:ss", () => {
    expect(state.activeElapsed("done", 0, 65_000)).toBeUndefined();
    expect(state.activeElapsed("running", Number.NaN, 65_000)).toBeUndefined();
    expect(state.activeElapsed("running", 0, 65_000)).toBe("01:05");
    expect(state.activeElapsed("blocked", 0, 3_661_000)).toBe("01:01:01");
  });

  it("tokens finitos y no negativos, con buckets k/m", () => {
    const cache = { read: 0, write: 0 };
    // Suma de buckets que desborda a Infinity: se omite, no se rotula "∞".
    expect(
      state.formatTokens({
        input: Number.MAX_VALUE,
        output: Number.MAX_VALUE,
        reasoning: 0,
        cache,
      }),
    ).toBeUndefined();
    expect(state.formatTokens(undefined)).toBeUndefined();
    expect(state.formatTokens({ input: 1, output: 2, reasoning: 3, cache })).toBe("6 tok");
    expect(state.formatTokens({ input: 1500, output: 0, reasoning: 0, cache })).toBe("1.5k tok");
    expect(state.formatTokens({ input: 2_000_000, output: 0, reasoning: 0, cache })).toBe("2.0m tok");
    expect(state.formatTokens({ input: Number.POSITIVE_INFINITY, output: 0, reasoning: 0, cache })).toBeUndefined();
    expect(state.formatTokens({ input: -1, output: 0, reasoning: 0, cache })).toBeUndefined();
  });

  it("modelo solo con provider e id, con variante opcional", () => {
    expect(state.formatModel(undefined)).toBeUndefined();
    expect(state.formatModel({ id: "m" })).toBeUndefined();
    expect(state.formatModel({ providerID: "p", id: "m" })).toBe("p/m");
    expect(state.formatModel({ providerID: "p", id: "m", variant: "high" })).toBe("p/m#high");
  });

  it("no atribuye un TypeError del handler a la desconexión solo por estado destruido", () => {
    const controller = new AbortController();
    expect(isExpectedStubStop(new TypeError("body json null"), controller)).toBe(false);
    // ERR_STREAM_WRITE_AFTER_END no es causa de desconexión: queda observable.
    expect(isExpectedStubStop({ code: "ERR_STREAM_WRITE_AFTER_END" }, controller)).toBe(false);
    // Control: una desconexión real del cliente sí es esperada.
    expect(isExpectedStubStop({ code: "ECONNRESET" }, controller)).toBe(true);
  });
});

describe("cierre de arranque fallido del servidor propio", () => {
  it("un stop no confirmado se registra en el estado del caso y activa el guard de raíz", async () => {
    const unconfirmed: string[] = [];
    const stopFailure = "servidor propio pid 4242: sigue vivo tras SIGKILL";

    // Control determinista: el stop inyectado no se confirma, así que el arranque
    // fallido debe registrar la causa en el mismo estado que lee el guard de raíz.
    const confirmed = await settleFailedStart(4242, unconfirmed, async () => stopFailure);

    expect(confirmed).toBe(false);
    expect(unconfirmed).toEqual([stopFailure]);
    // Guard de raíz existente (withTuiCase): preserva cuando el estado no está vacío.
    expect(unconfirmed.length).toBeGreaterThan(0);

    // Un stop confirmado no registra causa ni pide preservar la raíz.
    expect(await settleFailedStart(4242, unconfirmed, async () => undefined)).toBe(true);
    expect(unconfirmed).toEqual([stopFailure]);
  });
});

interface Stub {
  port: number;
  close: () => Promise<void>;
  /** Primer fallo inesperado del handler; el llamador lo observa tras fn/cierre. */
  failure: () => unknown;
}

interface Server {
  url: string;
  password: string;
  child: ChildProcess;
  /** Libera el grupo del servidor del owner tras un stop confirmado. */
  release: () => void;
}

interface TuiCase {
  root: string;
  server: Server;
  parentID: string;
  childID: string;
  /** Fallos de limpieza propios que impiden borrar la raíz sin confirmación. */
  unconfirmed: string[];
}

function hostEnv(root: string, password?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    TMPDIR: path.join(root, "tmp"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
    BROWSER_CONTROL_PORT: "19998",
  };
  if (password !== undefined) env.OPENCODE_PASSWORD = password;
  return env;
}

describe.skipIf(hostBinary === undefined)(
  "OpenCode v2 TUI: montaje real del panel jorgex.subagents (Spec T18/SC-11)",
  () => {
    let runRoot = "";
    let copy = "";
    let observedVersion = "";
    let unregisterRoot: (() => void) | undefined;
    // Raíces de casos ACTIVAS (añadidas justo tras mkdtemp, antes de cualquier
    // efecto): el callback de raíz de suite no borra el ancestro mientras existan.
    const activeCaseRoots = new Set<string>();

    /** Único límite de limpieza de la raíz de suite; corre tras confirmar grupos. */
    function cleanupRunRoot(): string | undefined {
      if (runRoot === "" || !fs.existsSync(runRoot)) return undefined;
      if (activeCaseRoots.size > 0) {
        return `raíz de suite conservada; casos activos/sin confirmar: ${[...activeCaseRoots].join(", ")}`;
      }
      fs.rmSync(runRoot, { recursive: true, force: true });
      return fs.existsSync(runRoot) ? `raíz de suite no eliminada: ${runRoot}` : undefined;
    }

    beforeAll(async () => {
      expect(hostBinary, "JORGEX_OPENCODE_V2_BIN").toBeDefined();
      // El gate real exige la barrera bwrap; en otra plataforma o sin bwrap falla
      // explícitamente, nunca ejecuta el host sin sandbox ni auto-instala nada.
      if (process.platform !== "linux") {
        throw new Error(
          `la barrera bwrap solo está implementada para Linux (plataforma ${process.platform}); el gate real falla sin fallback inseguro`,
        );
      }
      if (!fs.existsSync(BWRAP)) {
        throw new Error(`bwrap no disponible en ${BWRAP}; el gate real falla sin fallback inseguro (no se auto-instala)`);
      }
      // Fuera del repo: el loader TSX del host no debe heredar un `node_modules`
      // ancestro que haga resolver un runtime JSX ajeno (p. ej. react) en lugar
      // del Solid que provee el host. Disco, no tmpfs, por la copia de 200MB.
      const tempBase = fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
      runRoot = fs.mkdtempSync(path.join(tempBase, "jx-opencode-v2-tui-"));
      assertOwnRootOutsideProfiles(runRoot);
      // Limpieza propia registrada antes de escribir el marcador o copiar el host.
      unregisterRoot = registerOwnedResourceCleanup("tui-run-root", () => {
        const failure = cleanupRunRoot();
        if (failure !== undefined) throw new Error(failure);
      });
      for (const dir of ["home", "config", "data", "cache", "state", "runtime", "tmp", "cwd"]) {
        fs.mkdirSync(path.join(runRoot, dir), { recursive: true });
      }
      // Probe del MISMO wrapper antes de copiar/ejecutar OpenCode.
      await probeSandbox(runRoot);
      copy = path.join(runRoot, "opencode-copy");
      fs.copyFileSync(hostBinary!, copy);
      fs.chmodSync(copy, 0o500);
      expect(sha256(copy), "sha256 copia == original").toBe(sha256(hostBinary!));
      observedVersion = await runVersion(runRoot);
      const parsed = parseOpenCodeHostVersion(observedVersion);
      expect(parsed, `versión observada: ${observedVersion}`).toBeDefined();
      expect(parsed!.major, `major 2 en ${observedVersion}`).toBe(2);
    }, CASE_TIMEOUT_MS);

    afterAll(() => {
      // El owner compartido detiene y verifica los grupos propios ANTES de correr
      // el callback de raíz; no se borra el ancestro por una vía directa. Si algo
      // no se confirma, el callback queda armado para el reporte de salida.
      cleanupOwnedResourcesOrThrow();
      unregisterRoot?.();
    });

    async function runVersion(root: string): Promise<string> {
      // Helper de proceso acotado del proyecto: grupo propio + timeout + limpieza
      // verificada; la invocación real va dentro de la barrera bwrap.
      const result = await runBoundedProcess(
        sandboxInvocation(root, path.join(root, "cwd"), [copy, "--version"]),
        { cwd: path.join(root, "cwd"), env: hostEnv(root), timeoutMs: 30_000 },
      );
      if (result.timedOut) throw new Error("opencode --version no terminó a tiempo");
      if (result.treeCleanupError !== undefined) {
        throw new Error(`grupo de --version sin limpieza verificada: ${result.treeCleanupError.cause}`);
      }
      if (result.error !== undefined) {
        throw new Error(`opencode --version falló: ${redact(result.error.message)}`);
      }
      if (result.status !== 0) {
        throw new Error(
          `opencode --version salió con ${String(result.status)}: ${redact(result.stderr).trim().slice(0, 200)}`,
        );
      }
      return result.stdout.trim();
    }

    function projectFixture(configDir: string): void {
      const ctx = {
        stackDir: stackRoot(),
        configDir,
        engramBin: null,
        models: DEFAULT_MODEL_MAP.opencode,
        warnings: [] as string[],
      };
      const actions: FileAction[] = [
        ...opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx),
        ...(opencodeAdapter.planAdditionalResources?.(ctx) ?? []),
      ];
      for (const action of actions) {
        fs.mkdirSync(path.dirname(action.target), { recursive: true });
        if (action.kind === "write") fs.writeFileSync(action.target, action.content);
        else fs.copyFileSync(action.source, action.target);
      }
    }

    /** Solo ajustes del fixture: provider local, update off, sin MCP externo ni aviso/audio. */
    function configureFixture(configDir: string, stubPort: number): void {
      const configFile = ["opencode.json", "opencode.jsonc"]
        .map((name) => path.join(configDir, name))
        .find((candidate) => fs.existsSync(candidate));
      expect(configFile, `config proyectada en ${configDir}`).toBeDefined();
      const config = JSON.parse(fs.readFileSync(configFile!, "utf8")) as Record<string, any>;
      config["update"] = "disable";
      config["model"] = "fixture/fixture";
      config["small_model"] = "fixture/fixture";
      config["providers"] = {
        fixture: {
          name: "Local fixture",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${stubPort}/v1` },
          models: { fixture: { name: "fixture", limit: { context: 100_000, output: 10_000 } } },
        },
      };
      for (const entry of Object.values((config["mcp"] as { servers?: Record<string, any> } | undefined)?.servers ?? {})) {
        (entry as Record<string, unknown>)["disabled"] = true;
      }
      fs.writeFileSync(configFile!, `${JSON.stringify(config, null, 2)}\n`);

      const cliFile = path.join(configDir, "cli.json");
      const cli = JSON.parse(fs.readFileSync(cliFile, "utf8")) as Record<string, any>;
      cli["attention"] = { ...(cli["attention"] as Record<string, unknown>), notifications: false, sound: false, volume: 0 };
      fs.writeFileSync(cliFile, `${JSON.stringify(cli, null, 2)}\n`);
    }

    function startStub(delayMs: number): Promise<Stub> {
      const controller = new AbortController();
      let handlerFailure: unknown;
      const delay = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          if (controller.signal.aborted) {
            resolve();
            return;
          }
          const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      const server = http.createServer(async (request, response) => {
        try {
          if (!request.url?.includes("/chat/completions")) {
            response.writeHead(404);
            response.end();
            return;
          }
          let raw = "";
          for await (const chunk of request) raw += chunk;
          let body: { messages?: Array<{ role?: string; content?: unknown }> };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            response.writeHead(400);
            response.end();
            return;
          }
          const first = body.messages?.[0];
          const system = typeof first?.content === "string" ? first.content : "";
          const isTitle = /title generator|Generate a brief title/i.test(system);
          if (!isTitle && delayMs > 0) await delay(delayMs);
          if (controller.signal.aborted) return;
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: { role: "assistant", content: "fixture done" }, finish_reason: null }],
          };
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          response.write(
            `data: ${JSON.stringify({
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        } catch (error) {
          // Solo la cancelación propia y desconexiones conocidas se ignoran; el
          // resto queda observable. La respuesta fallida se destruye siempre que
          // no esté ya cerrada, para no dejar el socket abierto.
          if (!isExpectedStubStop(error, controller)) {
            handlerFailure ??= error;
          }
          if (!response.writableEnded && !response.destroyed) response.destroy();
        }
      });
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          const port = (server.address() as { port: number }).port;
          resolve({
            port,
            failure: () => handlerFailure,
            close: async () => {
              controller.abort();
              server.closeAllConnections?.();
              await new Promise<void>((done, fail) => {
                const timer = setTimeout(
                  () => fail(new Error("el listener HTTP del stub no cerró a tiempo")),
                  5_000,
                );
                server.close((error) => {
                  clearTimeout(timer);
                  if (error) fail(error);
                  else done();
                });
              });
            },
          });
        });
      });
    }

    async function startServer(root: string, unconfirmed: string[]): Promise<Server> {
      const invocation = sandboxInvocation(runRoot, path.join(root, "cwd"), [
        copy,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--log-level",
        "info",
      ]);
      const child = spawn(invocation.command, invocation.args, {
        cwd: path.join(root, "cwd"),
        env: hostEnv(root),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      // El servidor no pasa por runBoundedProcess: registrarlo en el mismo owner
      // para que un stop lo detenga y verifique antes de los callbacks de raíz.
      const release = child.pid === undefined ? () => {} : registerOwnedProcessGroup(child.pid);
      let out = "";
      child.stdout?.on("data", (chunk) => (out += chunk));
      child.stderr?.on("data", (chunk) => (out += chunk));
      try {
        await waitFor(
          () => /server listening on http/.test(out) && /server password /.test(out),
          20_000,
          "arranque del servidor propio",
        );
      } catch (error) {
        if (child.pid !== undefined) {
          if (await settleFailedStart(child.pid, unconfirmed)) {
            release();
          } else {
            // Stop no verificado: se conserva el registro del owner y se registra la
            // causa en el estado del caso antes de fallar, para que la limpieza
            // preserve la raíz. El diagnóstico usa solo el label propio, sin stdout.
            throw new Error(
              `${describeError(error)}; el servidor propio no confirmó su stop: ${unconfirmed[unconfirmed.length - 1]}`,
            );
          }
        }
        throw error;
      }
      const url = /server listening on (http:\/\/\S+)/.exec(out)![1]!;
      const password = /server password (\S+)/.exec(out)![1]!;
      return { url, password, child, release };
    }

    function auth(server: Server): Record<string, string> {
      return {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
      };
    }

    async function api(server: Server, method: string, endpoint: string, body?: unknown): Promise<any> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch(`${server.url}${endpoint}`, {
          method,
          headers: auth(server),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        throw new Error(`request ${method} ${endpoint} falló: ${describeError(error)}`);
      }
      try {
        if (!response.ok) throw new Error(`request ${method} ${endpoint} devolvió HTTP ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    }

    interface PromptRun {
      readonly settled: Promise<void>;
      readonly abort: () => void;
      failure: () => unknown;
    }

    /** Arranca el drain foreground sin esperar su final; el fallo se observa, no se traga. */
    function firePrompt(server: Server, sessionID: string): PromptRun {
      const controller = new AbortController();
      let failure: unknown;
      const settled = fetch(`${server.url}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: auth(server),
        body: JSON.stringify({ text: "run fixture" }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`prompt HTTP ${response.status}`);
          await response.body?.cancel();
        })
        .catch((error) => {
          // Solo el abort propio identificado se ignora; HTTP/TypeError/body-cancel
          // tras running quedan observables aunque el controller esté abortado.
          const ownAbort =
            controller.signal.aborted &&
            (error as { name?: string } | undefined)?.name === "AbortError";
          if (!ownAbort) failure = error;
        });
      return { settled, abort: () => controller.abort(), failure: () => failure };
    }

    /**
     * Cancela un prompt propio y confirma su asentamiento acotado. No traga
     * fallos: devuelve el fallo observado (o undefined) y registra el timeout
     * como limpieza no confirmada. Compartido por el prompt principal y el segundo.
     */
    async function settleOwnedPrompt(
      prompt: PromptRun,
      label: string,
      unconfirmed: string[],
    ): Promise<unknown> {
      prompt.abort();
      const settledInTime = await Promise.race([
        prompt.settled.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      if (!settledInTime) unconfirmed.push(`${label}: no confirmó su cancelación en 3s`);
      return prompt.failure();
    }

    async function withTuiCase(
      label: string,
      stubDelayMs: number,
      fn: (testCase: TuiCase) => Promise<void>,
    ): Promise<void> {
      // La raíz se crea primero y todo recurso posterior queda bajo limpieza propia
      // en orden fijo: prompt → grupo servidor → listener stub → ficheros.
      const root = fs.mkdtempSync(path.join(runRoot, `${label}-`));
      // Activa antes de cualquier efecto (projection/stub/spawn): un SIGTERM a
      // mitad de caso ya impide que el callback de raíz borre el ancestro.
      activeCaseRoots.add(root);
      const unconfirmed: string[] = [];
      let stub: Stub | undefined;
      let server: Server | undefined;
      let prompt: PromptRun | undefined;
      let failure: unknown;
      let reportedPromptFailure: unknown;
      try {
        for (const dir of ["home", "config", "data", "cache", "state", "runtime", "tmp", "cwd"]) {
          fs.mkdirSync(path.join(root, dir), { recursive: true });
        }
        const configDir = path.join(root, "config", "opencode");
        projectFixture(configDir);
        stub = await startStub(stubDelayMs);
        configureFixture(configDir, stub.port);
        server = await startServer(root, unconfirmed);
        const parent = (await api(server, "POST", "/api/session", { title: "T18 parent root" })).data;
        // El hijo lleva el modelo propio del fixture para que la fila exponga
        // contexto real de `context.data.session.get` (modelo/tokens), no solo estado.
        const child = (
          await api(server, "POST", "/api/session", {
            parentID: parent.id,
            title: "T18 child zzz",
            model: { providerID: "fixture", id: "fixture" },
          })
        ).data;
        if (!isSessionID(parent?.id) || !isSessionID(child?.id)) {
          throw new Error("la API no devolvió IDs de sesión válidos");
        }
        prompt = firePrompt(server, child.id);
        await waitForRunning(server, child.id, prompt);
        await fn({ root, server, parentID: parent.id, childID: child.id, unconfirmed });
        // Un fallo del foreground tras running no puede quedar silenciado.
        reportedPromptFailure = prompt.failure();
        if (reportedPromptFailure !== undefined) {
          throw new Error(`la ejecución foreground falló durante las interacciones: ${describeError(reportedPromptFailure)}`);
        }
        const stubFailure = stub.failure();
        if (stubFailure !== undefined) {
          throw new Error(`el stub falló durante las interacciones: ${describeError(stubFailure)}`);
        }
      } catch (error) {
        failure = error;
      }
      if (prompt !== undefined) {
        // Mismo helper de asentamiento que el segundo prompt: aborta, confirma
        // acotado y expone cualquier fallo (incluso tras el abort propio).
        const settledFailure = await settleOwnedPrompt(prompt, "prompt foreground", unconfirmed);
        if (settledFailure !== undefined && settledFailure !== reportedPromptFailure) {
          const settledError = new Error(
            `la ejecución foreground falló tras running: ${describeError(settledFailure)}`,
          );
          failure = failure === undefined ? settledError : new Error(`${describeError(failure)}; ${describeError(settledError)}`);
        }
      }
      if (server !== undefined && server.child.pid !== undefined) {
        const serverFailure = await stopGroupAndConfirm(server.child.pid, "servidor propio");
        if (serverFailure === undefined) server.release();
        else unconfirmed.push(serverFailure);
      }
      if (stub !== undefined) {
        try {
          await stub.close();
        } catch (error) {
          unconfirmed.push(`stub HTTP: ${describeError(error)}`);
        }
        const lateStubFailure = stub.failure();
        if (lateStubFailure !== undefined) {
          const lateError = new Error(`el stub falló tarde: ${describeError(lateStubFailure)}`);
          failure = failure === undefined ? lateError : new Error(`${describeError(failure)}; ${describeError(lateError)}`);
        }
      }
      if (unconfirmed.length === 0) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch (error) {
          unconfirmed.push(`raíz: ${describeError(error)}`);
        }
        if (fs.existsSync(root)) unconfirmed.push(`raíz no eliminada: ${root}`);
      }
      if (unconfirmed.length === 0) {
        activeCaseRoots.delete(root);
      } else {
        // La raíz de suite que contiene este caso también debe sobrevivir.
        unconfirmed.push(`raíz conservada para recuperación: ${root}`);
      }
      const cleanupMessage =
        unconfirmed.length > 0 ? `limpieza propia incompleta: ${unconfirmed.join("; ")}` : undefined;
      if (failure !== undefined && cleanupMessage !== undefined) {
        throw new Error(`${describeError(failure)}; ${cleanupMessage}`);
      }
      if (failure !== undefined) throw failure;
      if (cleanupMessage !== undefined) throw new Error(cleanupMessage);
    }

    function isSessionID(value: unknown): value is string {
      return typeof value === "string" && value.startsWith("ses");
    }

    async function waitForRunning(server: Server, childID: string, prompt: PromptRun): Promise<void> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const promptFailure = prompt.failure();
        if (promptFailure !== undefined) throw new Error(`arranque foreground falló: ${describeError(promptFailure)}`);
        const active = (await api(server, "GET", "/api/session/active")).data as Record<string, { type?: string }>;
        if (active[childID]?.type === "running") return;
        if (Date.now() > deadline) throw new Error("la ejecución foreground no llegó a running");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    async function runTui(
      testCase: TuiCase,
      schedule: unknown,
      out: string,
      timeoutSeconds: number,
    ): Promise<Record<string, string>> {
      const scheduleFile = path.join(testCase.root, `schedule-${path.basename(out)}.json`);
      fs.writeFileSync(scheduleFile, JSON.stringify(schedule));
      // El PTY y el fixture corren fuera de bwrap; el hijo del fork executa bwrap,
      // que aísla el filesystem del host y hereda los descriptores PTY.
      const invocation = sandboxInvocation(runRoot, path.join(testCase.root, "cwd"), [
        copy,
        "--server", testCase.server.url,
        "--log-level", "info",
        "-s", testCase.parentID,
      ]);
      // detached: true hace del python un líder de grupo propio; el TUI, que pty.fork
      // convierte en líder de sesión, se registra aparte en `<out>.tui.pid`.
      const child = spawn(
        python,
        [
          "-B",
          ptyFixture,
          "--out", out,
          "--schedule", scheduleFile,
          "--cols", "120",
          "--rows", "40",
          "--timeout", String(timeoutSeconds),
          "--cwd", path.join(testCase.root, "cwd"),
          "--",
          invocation.command,
          ...invocation.args,
        ],
        {
          cwd: testCase.root,
          env: hostEnv(testCase.root, testCase.server.password),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      // El fixture y su bwrap no pasan por runBoundedProcess: registrarlos en el
      // mismo owner para que un stop los detenga antes de los callbacks de raíz.
      const releasePython = child.pid === undefined ? () => {} : registerOwnedProcessGroup(child.pid);
      let spawnError: unknown;
      const done = new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
        child.once("error", (error) => {
          spawnError = error;
          resolve(null);
        });
      });
      // El pid del grupo del TUI (bwrap, líder de sesión) se registra en cuanto
      // el fixture lo publica; sin él no hay TUI que detener.
      const tuiPid = await waitForTuiPid(out, 3_000);
      const releaseTui = tuiPid === undefined ? undefined : registerOwnedProcessGroup(tuiPid);
      // Red de seguridad si el fixture se cuelga por debajo de su propio timeout.
      const hardTimer = setTimeout(() => {
        if (child.pid !== undefined) stopOwnProcessTree(child.pid);
      }, (timeoutSeconds + 15) * 1000);
      let failure: unknown;
      let screens: Record<string, string> | undefined;
      try {
        const code = await done;
        if (code !== 0) {
          throw new Error(
            spawnError !== undefined
              ? `PTY no arrancó: ${redact(describeError(spawnError))}`
              : `PTY salió con ${String(code)}; stderr: ${redact(stderr).slice(-400)}`,
          );
        }
        screens = JSON.parse(fs.readFileSync(`${out}.screens.json`, "utf8")) as Record<string, string>;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(hardTimer);
        if (child.pid !== undefined) {
          const pythonFailure = await stopGroupAndConfirm(child.pid, "PTY python");
          if (pythonFailure === undefined) releasePython();
          else testCase.unconfirmed.push(pythonFailure);
        }
        const tuiFailure = await stopTuiGroupAndConfirm(tuiPid);
        if (tuiFailure === undefined) releaseTui?.();
        else testCase.unconfirmed.push(tuiFailure);
      }
      if (failure !== undefined) throw failure;
      return screens!;
    }

    it("monta la app, registra el comando keymap, abre sidebar, navega al hijo, pliega al cambiar de sesión y no-op con click derecho", async () => {
      await withTuiCase("interactions", 60_000, async (testCase) => {
        // Segundo hijo cuya ejecución arranca DESPUÉS del boot del TUI: el evento
        // observado `session.execution.started` fija el inicio y la fila rotula duración.
        const second = (
          await api(testCase.server, "POST", "/api/session", {
            parentID: testCase.parentID,
            title: "T18 second run",
            model: { providerID: "fixture", id: "fixture" },
          })
        ).data;
        let secondPrompt: PromptRun | undefined;
        const inject = setTimeout(() => {
          secondPrompt = firePrompt(testCase.server, second.id);
        }, 8_500);
        let screens: Record<string, string> = {};
        try {
          screens = await runTui(
            testCase,
            [
              { at: 4.0, waitFor: "ctrl+p commands", send: "\u0010", label: "palette-open", timeout: 25 },
              { at: 4.5, waitFor: "Search", send: "subagent", label: "palette-search", timeout: 25 },
              { at: 5.0, waitFor: "Toggle subagent panel", send: "", label: "palette", timeout: 30 },
              { at: 5.5, send: "\u001b", label: "palette-close" },
              { at: 6.0, waitFor: "ctrl+p commands", send: "\u0018", label: "leader", timeout: 25 },
              { at: 6.5, send: "b", label: "sidebar" },
              { at: 7.0, waitFor: "Subagents", click: { text: "Subagents", button: 0 }, label: "expand", timeout: 25 },
              { at: 7.5, waitFor: "T18 child zzz", click: { text: "T18 child zzz", button: 0 }, label: "navigate-child", timeout: 25 },
              { at: 8.0, waitFor: "Subagent: T18 child zzz", send: "\u001b", label: "return", timeout: 25 },
              { at: 8.5, waitFor: "ctrl+p commands", send: "\u0018", label: "leader2", timeout: 25 },
              { at: 9.0, send: "b", label: "sidebar2" },
              { at: 9.5, waitFor: "Subagents", send: "", label: "fold", timeout: 25 },
              { at: 10.0, waitFor: "Subagents", click: { text: "Subagents", button: 0 }, label: "expand2", timeout: 25 },
              { at: 10.5, waitFor: "▼ Subagents", click: { text: "Subagents", button: 2 }, label: "rightclick", timeout: 25 },
              { at: 11.0, send: "", label: "after-rightclick" },
            ],
            path.join(testCase.root, "interactions.raw"),
            45,
          );
        } finally {
          clearTimeout(inject);
          if (secondPrompt !== undefined) {
            // Mismo helper compartido: confirma el asentamiento acotado y no traga
            // un fallo tardío, incluso si runTui lanzó.
            const secondFailure = await settleOwnedPrompt(secondPrompt, "segundo prompt", testCase.unconfirmed);
            if (secondFailure !== undefined) {
              testCase.unconfirmed.push(`segundo prompt falló: ${describeError(secondFailure)}`);
            }
          }
        }

        // Comando keymap registrado: el palette real lo lista.
        expect(screens["before:palette"]).toContain("Toggle subagent panel");
        expect(screens["before:palette"]).toContain("Subagents");
        // Sidebar append colapsado con conteo real del hijo corriendo.
        expect(screens["before:expand"]).toContain("▶ Subagents");
        expect(screens["before:expand"]).toContain("1 running");
        // Click izquierdo real sobre el header: despliega y muestra la fila activa.
        expect(screens["before:navigate-child"]).toContain("▼ Subagents");
        expect(screens["before:navigate-child"]).toContain("T18 child zzz");
        // Datos reales de context.data.session.get: modelo propio del fixture y
        // tokens acumulados visibles en la fila activa.
        expect(screens["before:navigate-child"]).toContain("fixture/fixture");
        expect(screens["before:navigate-child"]).toContain("0 tok");
        // Duración omitida: el inicio observado es anterior al boot del TUI, así que
        // no hay start conocido y no se rotula tiempo.
        expect(screens["before:navigate-child"]).not.toMatch(/\d{2}:\d{2} · 0 tok/);
        // Click en la fila: navegó al contexto de la sesión hija.
        expect(screens["before:return"]).toContain("Subagent: T18 child zzz");
        expect(screens["before:return"]).toContain("Running");
        // Cambiar de sesión y volver: el panel vuelve plegado.
        expect(screens["before:fold"]).toContain("▶ Subagents");
        // Click derecho: no-op (no pliega un panel desplegado).
        expect(screens["before:rightclick"]).toContain("▼ Subagents");
        expect(screens["before:after-rightclick"]).toContain("▼ Subagents");
        // Inicio observado con el TUI adjunto: la fila del segundo hijo sí rotula
        // duración, junto a sus tokens reales.
        expect(screens["before:rightclick"]).toMatch(/T18 second run\n\s*\d{2}:\d{2} · 0 tok/);
      });
    }, CASE_TIMEOUT_MS);

    it("transiciona running→done en la fila activa y limpia la fila al terminar", async () => {
      await withTuiCase("running-done", 18_000, async (testCase) => {
        const screens = await runTui(
          testCase,
          [
            { at: 4.0, waitFor: "ctrl+p commands", send: "\u0018", label: "leader", timeout: 25 },
            { at: 4.5, send: "b", label: "sidebar" },
            { at: 5.0, waitFor: "Subagents", click: { text: "Subagents", button: 0 }, label: "expand", timeout: 25 },
            { at: 5.5, waitFor: "T18 child zzz", send: "", label: "running", timeout: 30 },
            { at: 6.0, waitFor: "✓ 1 done", send: "", label: "done", timeout: 40 },
          ],
          path.join(testCase.root, "running-done.raw"),
          35,
        );

        expect(screens["before:running"]).toContain("1 running");
        expect(screens["before:running"]).toContain("T18 child zzz");
        expect(screens["before:running"]).toContain("✓ 0 done");
        expect(screens["before:done"]).toContain("0 running");
        expect(screens["before:done"]).toContain("✓ 1 done");
        expect(screens["before:done"]).not.toMatch(/•\s*T18 child zzz/);
      });
    }, CASE_TIMEOUT_MS);

    it("muestra la fila bloqueada y el contador needs input con un formulario pendiente real", async () => {
      // Stub breve: la ejecución propia completa y acumula usage antes del formulario.
      await withTuiCase("form-blocked", 1_000, async (testCase) => {
        // La fila bloqueada debe mostrar el total positivo acumulado, no un cero fijo:
        // esperar a que Session.Info exponga el usage conocido del stub (3 input + 2 output).
        let tokens:
          | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
          | undefined;
        const deadline = Date.now() + 20_000;
        for (;;) {
          tokens = (await api(testCase.server, "GET", `/api/session/${testCase.childID}`)).data?.tokens;
          const total =
            (tokens?.input ?? 0) +
            (tokens?.output ?? 0) +
            (tokens?.reasoning ?? 0) +
            (tokens?.cache?.read ?? 0) +
            (tokens?.cache?.write ?? 0);
          if (Number.isFinite(total) && total > 0) break;
          if (Date.now() > deadline) throw new Error("la ejecución propia no acumuló tokens del stub");
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        // Mapeo confirmado del usage del stub: 3 input + 2 output, sin reason/cache.
        expect(tokens?.input, "input del stub en Session.Info").toBe(3);
        expect(tokens?.output, "output del stub en Session.Info").toBe(2);
        const expectedTotal =
          (tokens?.input ?? 0) +
          (tokens?.output ?? 0) +
          (tokens?.reasoning ?? 0) +
          (tokens?.cache?.read ?? 0) +
          (tokens?.cache?.write ?? 0);
        expect(expectedTotal, "total positivo del stub").toBe(5);

        // Formulario pendiente real sobre la sesión hija (schema público Form.CreatePayload).
        const created = await api(testCase.server, "POST", `/api/session/${testCase.childID}/form`, {
          title: "T18 live form",
          fields: [{ key: "note", type: "string", title: "Note" }],
        });
        expect(created?.data?.id, "id de formulario creado").toMatch(/^frm_/);
        const screens = await runTui(
          testCase,
          [
            { at: 4.0, waitFor: "ctrl+p commands", send: "\u0018", label: "leader", timeout: 25 },
            { at: 4.5, send: "b", label: "sidebar" },
            { at: 5.0, waitFor: "Subagents", click: { text: "Subagents", button: 0 }, label: "expand", timeout: 25 },
            { at: 5.5, waitFor: "Needs input", send: "", label: "blocked", timeout: 30 },
          ],
          path.join(testCase.root, "form-blocked.raw"),
          35,
        );

        // El estado bloqueado precede a running: contador y fila reales del terminal,
        // con el total positivo que prueba que la fila no queda clavada en cero.
        expect(screens["before:blocked"]).toContain("1 needs input");
        expect(screens["before:blocked"]).toContain("Needs input");
        expect(screens["before:blocked"]).toContain("T18 child zzz");
        expect(screens["before:blocked"]).toContain(`${expectedTotal} tok`);
      });
    }, CASE_TIMEOUT_MS);
  },
);
