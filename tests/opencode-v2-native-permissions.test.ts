import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { parseOpenCodeHostVersion } from "./helpers/opencode-host-version.js";

/**
 * Verificación de la semántica de permisos NATIVOS v2 contra el motor real del
 * host OpenCode v2 (major 2) (Spec T04:56: `deny` de secretos incluso con autoaccept,
 * `*.env.example` re-permitido después de los denies, y `edit` denegado por rol).
 *
 * Recipe probada empíricamente contra `opencode v2.0.20` y reobservada contra la
 * última versión instalada major 2 (copia privada del ejecutable, sha256 origen
 * vs copia, ejecutada por separado):
 *   1. `opencode run --standalone --format json` arranca el motor con un
 *      provider LOCAL en proceso (`@opencode/ai/providers/openai-compatible`
 *      apuntando a un stub HTTP efímero). No hay cuenta, credencial, modelo
 *      real, configuración de usuario ni fichero real: todo vive en una raíz
 *      temporal y el stub sólo devuelve una `tool_call` determinista.
 *   2. La decisión del motor se lee del evento `tool_use` real: `completed` =
 *      allow; `error` "Permission denied: <accion>" = deny; "currently
 *      available" = edit denegado por lo que la herramienta no se expone;
 *      "cannot ask the user for permission" = ask no resoluble en no interactivo.
 *
 * NO existe un endpoint/pura export del host que evalúe permisos sin invocar un
 * provider: `debug` sólo lista agents/config/paths y `api` opera sobre rutas ya
 * existentes (`/api/agent`, `/api/permission/request` es listado de peticiones
 * pendientes, no un evaluador). Por eso este seam usa un provider stub offline
 * (sin modelo/credenciales reales) en vez de afirmar un seam de modelo libre.
 *
 * Skip por defecto: exige `JORGEX_OPENCODE_V2_BIN` (ruta de un binario major 2).
 * A diferencia del contrato 1.18.30, este fichero NO reutiliza su runner: v2 usa
 * `providers`/`settings`/`package`, `permissions` array y el input `path`.
 */
const hostBinary = process.env.JORGEX_OPENCODE_V2_BIN;
const repoRoot = path.resolve(stackRoot(), "..");
const CASE_TIMEOUT_MS = 90_000;

type Outcome = "allow" | "deny" | "ask" | "unavailable" | "unknown";

interface ToolEvent {
  type?: string;
  part?: { tool?: string; state?: { status?: string; error?: string; input?: Record<string, unknown> } };
}

interface Stub {
  port: number;
  close: () => Promise<void>;
}

describe.skipIf(hostBinary === undefined)("OpenCode v2 (major 2): el motor real aplica deny/allow nativos", () => {
  let runRoot = "";
  let copy = "";
  let observedVersion = "";
  const activeChildren = new Set<ChildProcess>();

  function sha256(file: string): string {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }

  /** La password del servidor (si `--standalone` la emitiera) nunca debe salir. */
  function sanitized(output: string): string {
    return output.replace(/server password \S+/g, "server password <redacted>");
  }

  function newCaseRoot(label: string): string {
    const root = fs.mkdtempSync(path.join(runRoot, `${label}-`));
    for (const dir of ["home", "config/opencode", "data", "cache", "state", "runtime", "tmp", "cwd", "bin"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    return root;
  }

  function hostEnv(root: string, configDir: string): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin",
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      TMPDIR: path.join(root, "tmp"),
      OPENCODE_CONFIG_DIR: configDir,
      NO_COLOR: "1",
    };
  }

  /** Stub OpenAI-compatible local: sin red externa, sin credenciales. */
  async function startStub(tool: string, args: () => Record<string, unknown>): Promise<Stub> {
    const server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      let body: { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }
      const firstMessage = body.messages?.[0];
      const firstSystem = typeof firstMessage?.content === "string" ? firstMessage.content : "";
      const isTitle = /title generator|Generate a brief title/i.test(firstSystem);
      const done = body.messages?.some((message) => message.role === "tool") === true;
      const delta = done || isTitle
        ? { content: "fixture" }
        : {
            role: "assistant",
            tool_calls: [{ index: 0, id: "call", type: "function", function: { name: tool, arguments: JSON.stringify(args()) } }],
          };
      const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: done || isTitle ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
    return {
      port,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  function classify(event: ToolEvent | undefined): { outcome: Outcome; error: string } {
    const state = event?.part?.state;
    const error = state?.error ?? "";
    if (state?.status === "completed") return { outcome: "allow", error };
    if (error.includes("Permission denied")) return { outcome: "deny", error };
    if (error.includes("currently available")) return { outcome: "unavailable", error };
    if (error.includes("cannot ask the user for permission") || error.includes("rejected permission")) return { outcome: "ask", error };
    return { outcome: "unknown", error };
  }

  async function runHost(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(copy, args, { cwd: path.join(root, "cwd"), env: hostEnv(root, path.join(root, "config", "opencode")), stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const killTimer = setTimeout(() => child.kill("SIGTERM"), CASE_TIMEOUT_MS - 5_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("exit", resolve);
        child.on("error", reject);
      });
      return { code, stdout, stderr };
    } finally {
      clearTimeout(killTimer);
      activeChildren.delete(child);
    }
  }

  /** Escribe la config del adapter + provider stub y ejecuta una llamada a herramienta. */
  async function probeTool(input: {
    label: string;
    tool: "read" | "write" | "edit" | "shell";
    file?: string;
    omitPermissions?: boolean;
    agentContent?: string;
    auto: boolean;
  }): Promise<{ outcome: Outcome; error: string; code: number | null }> {
    const root = newCaseRoot(input.label);
    const configDir = path.join(root, "config", "opencode");
    const cwd = path.join(root, "cwd");
    const filePath = path.join(cwd, input.file ?? "ordinary.txt");
    fs.writeFileSync(filePath, "Synthetic fixture data.\n");

    // Se proyecta con el adapter real (misma fuente que el producto) y sólo se
    // inyectan ajustes de fixture: provider stub, modelo stub y sin MCP/update.
    const ctx = { stackDir: stackRoot(), configDir, engramBin: null, models: DEFAULT_MODEL_MAP.opencode, warnings: [] as string[] };
    for (const action of opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx)) {
      if (action.kind !== "write") continue;
      fs.mkdirSync(path.dirname(action.target), { recursive: true });
      fs.writeFileSync(action.target, action.content);
    }
    const configFile = path.join(configDir, "opencode.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    if (input.omitPermissions !== true) expect(config.permissions, "el adapter debe emitir el bloque nativo").toBeDefined();
    if (input.omitPermissions === true) delete config.permissions;

    const stub = await startStub(input.tool, () => {
      if (input.tool === "shell") return { command: "printf fixture" };
      if (input.tool === "write") return { path: filePath, content: "updated\n" };
      if (input.tool === "edit") return { path: filePath, oldString: "Synthetic", newString: "Changed" };
      return { path: filePath };
    });
    try {
      config["update"] = "disable";
      config["model"] = "fixture/fixture";
      config["small_model"] = "fixture/fixture";
      config["providers"] = {
        fixture: {
          name: "Local fixture",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${stub.port}/v1` },
          models: { fixture: { name: "fixture", limit: { context: 100_000, output: 10_000 } } },
        },
      };
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

      const args = ["run", "--standalone", "--format", "json", "--model", "fixture/fixture", "--title", "permission fixture"];
      if (input.auto) args.push("--auto");
      if (input.agentContent !== undefined) {
        fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
        fs.writeFileSync(path.join(configDir, "agents", "probe.md"), input.agentContent);
        args.push("--agent", "probe");
      }
      args.push("Use the local fixture once.");

      const { code, stdout, stderr } = await runHost(root, args);
      expect(code, `run salió con ${code}. stderr: ${sanitized(stderr).slice(-500)}`).toBe(0);
      let event: ToolEvent | undefined;
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        try {
          const parsed = JSON.parse(line) as ToolEvent;
          if (parsed.type === "tool_use") event = parsed;
        } catch {
          // Ignora líneas no JSON (no debería haber con --format json).
        }
      }
      return { ...classify(event), code };
    } finally {
      await stub.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  beforeAll(async () => {
    expect(hostBinary, "JORGEX_OPENCODE_V2_BIN").toBeDefined();
    runRoot = fs.mkdtempSync(path.join(repoRoot, "node_modules", ".jx-t03-v2-perm-"));
    copy = path.join(runRoot, "opencode-copy");
    fs.copyFileSync(hostBinary!, copy);
    fs.chmodSync(copy, 0o500);
    expect(sha256(copy), "sha256 copia == original").toBe(sha256(hostBinary!));

    const root = newCaseRoot("version");
    try {
      const { code, stdout, stderr } = await runHost(root, ["--version"]);
      expect(code, sanitized(stderr)).toBe(0);
      observedVersion = stdout.trim();
      const parsedVersion = parseOpenCodeHostVersion(observedVersion);
      expect(parsedVersion, `versión observada semver parseable: ${observedVersion}`).toBeDefined();
      expect(parsedVersion!.major, `major 2 en ${observedVersion}`).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    // Sólo procesos propios; se confirma su salida ANTES de borrar la raíz.
    const stopped = await Promise.all([...activeChildren].map((child) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      child.once("exit", () => resolve(true));
      try {
        child.kill("SIGTERM");
      } catch {
        resolve(true);
        return;
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ya terminó.
        }
      }, 3_000);
      setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), 8_000);
    })));
    if (runRoot === "") return;
    if (stopped.some((value) => value === false)) {
      throw new Error(`cleanup incompleto: hay procesos propios vivos; raíz conservada en ${runRoot}`);
    }
    fs.rmSync(runRoot, { recursive: true, force: true });
    expect(fs.existsSync(runRoot), "raíz privada eliminada").toBe(false);
  }, CASE_TIMEOUT_MS);

  it("read de un secreto sigue DENEGADO aunque el autoaccept esté activo", async () => {
    const result = await probeTool({ label: "read-secret", tool: "read", file: ".env", auto: true });
    expect(result.outcome, result.error).toBe("deny");
  }, CASE_TIMEOUT_MS);

  it("write/edit de un secreto sigue DENEGADO aunque el autoaccept esté activo", async () => {
    const result = await probeTool({ label: "write-secret", tool: "write", file: ".env", auto: true });
    expect(result.outcome, result.error).toBe("deny");
  }, CASE_TIMEOUT_MS);

  it("*.env.example queda PERMITIDO por ganar la última coincidencia", async () => {
    const result = await probeTool({ label: "read-example", tool: "read", file: ".env.example", auto: true });
    expect(result.outcome, result.error).toBe("allow");
  }, CASE_TIMEOUT_MS);

  it("control: sin el bloque del adapter el host deja .env en ask y --auto lo auto-aprueba", async () => {
    // El default del host es `ask` para *.env; con `--auto` se convierte en allow.
    // Esto acredita a la vez que el deny del caso 1 lo aporta el bloque del adapter
    // y que el autoaccept está realmente activo en estos casos.
    const result = await probeTool({ label: "read-default-auto", tool: "read", file: ".env", omitPermissions: true, auto: true });
    expect(result.outcome, result.error).toBe("allow");
  }, CASE_TIMEOUT_MS);

  it("control: sin el bloque y sin --auto el mismo .env queda en ask (no en allow)", async () => {
    const result = await probeTool({ label: "read-default-prompt", tool: "read", file: ".env", omitPermissions: true, auto: false });
    expect(result.outcome, result.error).toBe("ask");
  }, CASE_TIMEOUT_MS);

  it("un rol readonly no puede editar aunque el autoaccept global esté activo", async () => {
    const models = { strong: { model: "fixture/fixture" }, standard: { model: "fixture/fixture" }, cheap: { model: "fixture/fixture" } };
    const [agent] = opencodeAdapter.renderAgent(
      { name: "probe", description: "Permission fixture", mode: "subagent", tier: "standard", readonly: true, bash: "git-read", spawn: false, body: "Use the local fixture." },
      models,
    );
    const content = agent!.content.replace("mode: subagent", "mode: primary");
    // Fichero ordinario: aísla el deny de `edit` del rol (el deny global de
    // secretos no interviene), de modo que quitar la regla del agente convierta
    // la decisión en allow y el test falle.
    const result = await probeTool({ label: "readonly-edit", tool: "write", file: "ordinary.txt", agentContent: content, auto: true });
    expect(["unavailable", "deny"], result.error).toContain(result.outcome);
  }, CASE_TIMEOUT_MS);
});
