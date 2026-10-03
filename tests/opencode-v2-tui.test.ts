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
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import {
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

/** El grupo del TUI (pty.fork lo hace líder de sesión) queda registrado por el fixture. */
async function stopTuiGroupAndConfirm(out: string): Promise<string | undefined> {
  const pidFile = `${out}.tui.pid`;
  // El fixture retira el registro solo tras reapear al TUI; ausente = no hay TUI vivo.
  if (!fs.existsSync(pidFile)) return undefined;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return `${pidFile}: pid inválido`;
  return stopGroupAndConfirm(pid, "TUI pty");
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
});

interface Stub {
  port: number;
  close: () => Promise<void>;
}

interface Server {
  url: string;
  password: string;
  child: ChildProcess;
}

interface TuiCase {
  root: string;
  configDir: string;
  server: Server;
  stub: Stub;
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
        if (runRoot !== "" && fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
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
      if (runRoot !== "" && fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
      expect(runRoot === "" || fs.existsSync(runRoot), "raíz privada eliminada").toBe(false);
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
        } catch {
          // close() aborta y destruye conexiones a mitad del handler.
          if (!response.headersSent) response.destroy();
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

    async function startServer(root: string): Promise<Server> {
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
        if (child.pid !== undefined) stopOwnProcessTree(child.pid);
        throw error;
      }
      const url = /server listening on (http:\/\/\S+)/.exec(out)![1]!;
      const password = /server password (\S+)/.exec(out)![1]!;
      return { url, password, child };
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
          // Solo la cancelación propia se ignora; otro fallo queda observable.
          if (!controller.signal.aborted) failure = error;
        });
      return { settled, abort: () => controller.abort(), failure: () => failure };
    }

    async function withTuiCase(
      label: string,
      stubDelayMs: number,
      fn: (testCase: TuiCase) => Promise<void>,
    ): Promise<void> {
      // La raíz se crea primero y todo recurso posterior queda bajo limpieza propia
      // en orden fijo: prompt → grupo servidor → listener stub → ficheros.
      const root = fs.mkdtempSync(path.join(runRoot, `${label}-`));
      const unconfirmed: string[] = [];
      let stub: Stub | undefined;
      let server: Server | undefined;
      let prompt: PromptRun | undefined;
      let failure: unknown;
      try {
        for (const dir of ["home", "config", "data", "cache", "state", "runtime", "tmp", "cwd"]) {
          fs.mkdirSync(path.join(root, dir), { recursive: true });
        }
        const configDir = path.join(root, "config", "opencode");
        projectFixture(configDir);
        stub = await startStub(stubDelayMs);
        configureFixture(configDir, stub.port);
        server = await startServer(root);
        const parent = (await api(server, "POST", "/api/session", { title: "T18 parent root" })).data;
        const child = (await api(server, "POST", "/api/session", { parentID: parent.id, title: "T18 child zzz" })).data;
        if (!isSessionID(parent?.id) || !isSessionID(child?.id)) {
          throw new Error("la API no devolvió IDs de sesión válidos");
        }
        prompt = firePrompt(server, child.id);
        await waitForRunning(server, child.id, prompt);
        await fn({ root, configDir, server, stub, parentID: parent.id, childID: child.id, unconfirmed });
      } catch (error) {
        failure = error;
      }
      if (prompt !== undefined) {
        prompt.abort();
        // La cancelación propia resuelve rápido; no bloquear la limpieza si no lo hace.
        await Promise.race([prompt.settled, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
      }
      if (server !== undefined && server.child.pid !== undefined) {
        const serverFailure = await stopGroupAndConfirm(server.child.pid, "servidor propio");
        if (serverFailure !== undefined) unconfirmed.push(serverFailure);
      }
      if (stub !== undefined) {
        try {
          await stub.close();
        } catch (error) {
          unconfirmed.push(`stub HTTP: ${describeError(error)}`);
        }
      }
      if (unconfirmed.length === 0) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch (error) {
          unconfirmed.push(`raíz: ${describeError(error)}`);
        }
        if (fs.existsSync(root)) unconfirmed.push(`raíz no eliminada: ${root}`);
      } else {
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
      const done = new Promise<number | null>((resolve, reject) => {
        child.once("close", (code) => resolve(code));
        child.once("error", reject);
      });
      // Red de seguridad si el fixture se cuelga por debajo de su propio timeout.
      const hardTimer = setTimeout(() => {
        if (child.pid !== undefined) stopOwnProcessTree(child.pid);
      }, (timeoutSeconds + 15) * 1000);
      let failure: unknown;
      let screens: Record<string, string> | undefined;
      try {
        const code = await done;
        if (code !== 0) throw new Error(`PTY salió con ${String(code)}; stderr: ${redact(stderr).slice(-400)}`);
        screens = JSON.parse(fs.readFileSync(`${out}.screens.json`, "utf8")) as Record<string, string>;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(hardTimer);
        if (child.pid !== undefined) {
          const pythonFailure = await stopGroupAndConfirm(child.pid, "PTY python");
          if (pythonFailure !== undefined) testCase.unconfirmed.push(pythonFailure);
        }
        const tuiFailure = await stopTuiGroupAndConfirm(out);
        if (tuiFailure !== undefined) testCase.unconfirmed.push(tuiFailure);
      }
      if (failure !== undefined) throw failure;
      return screens!;
    }

    it("monta la app, registra el comando keymap, abre sidebar, navega al hijo, pliega al cambiar de sesión y no-op con click derecho", async () => {
      await withTuiCase("interactions", 60_000, async (testCase) => {
        const screens = await runTui(
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

        // Comando keymap registrado: el palette real lo lista.
        expect(screens["before:palette"]).toContain("Toggle subagent panel");
        expect(screens["before:palette"]).toContain("Subagents");
        // Sidebar append colapsado con conteo real del hijo corriendo.
        expect(screens["before:expand"]).toContain("▶ Subagents");
        expect(screens["before:expand"]).toContain("1 running");
        // Click izquierdo real sobre el header: despliega y muestra la fila activa.
        expect(screens["before:navigate-child"]).toContain("▼ Subagents");
        expect(screens["before:navigate-child"]).toContain("T18 child zzz");
        // Click en la fila: navegó al contexto de la sesión hija.
        expect(screens["before:return"]).toContain("Subagent: T18 child zzz");
        expect(screens["before:return"]).toContain("Running");
        // Cambiar de sesión y volver: el panel vuelve plegado.
        expect(screens["before:fold"]).toContain("▶ Subagents");
        // Click derecho: no-op (no pliega un panel desplegado).
        expect(screens["before:rightclick"]).toContain("▼ Subagents");
        expect(screens["before:after-rightclick"]).toContain("▼ Subagents");
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
  },
);
