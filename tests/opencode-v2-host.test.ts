import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { planAgents } from "../src/components/agents.js";
import { loadCanonicalAgents, loadCanonicalMcp } from "../src/lib/canonical.js";
import { TEST_MODEL_MAP as DEFAULT_MODEL_MAP } from "./fixtures/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

/**
 * Verificación del host real OpenCode v2 (Spec T04) sobre una COPIA privada del
 * ejecutable, exigiendo el REGISTRO REAL de agentes (no el eco de config).
 *
 * Recipe probada empíricamente contra `opencode v2.0.20`:
 *   1. `serve --port 0` persistente (imprime `server listening on <url>` y
 *      `server password <pw>`); la API exige HTTP Basic con esa credencial
 *      local efímera — sin cuentas, sin claves, sin datos del usuario.
 *   2. `GET /api/agent` arranca la location (builtins resueltos).
 *   3. `POST /api/location/reload` → 204 aplica los transforms de los plugins
 *      internos y los agentes Markdown de `<config>/opencode/agents/**` entran
 *      en el registro con su modelo y sus reglas resueltas.
 * Con `api --standalone` (servidor stdio por llamada) la location no se
 * arranca y `/api/agent` responde `data: []`: no es prueba semántica.
 *
 * - Solo se copian los BYTES del ejecutable (sha256 origen vs copia) y se
 *   ejecuta la COPIA. Skip por defecto: exige `JORGEX_OPENCODE_V2_BIN`.
 * - El major observado debe ser exactamente 2.
 * - Todo vive en una raíz privada dentro de node_modules; el teardown se
 *   registra ANTES de crearla, para SOLO los PIDs/proceso propio y elimina sus
 *   ficheros después de pararlos (éxito, fallo o cancelación).
 *
 * Excluido a propósito (declarado, no falso pase): TUI/PTY (seam distinto),
 * smoke de plugins (T06 fuera de T04) y cuota real de modelos.
 */
const hostBinary = process.env.JORGEX_OPENCODE_V2_BIN;
const repoRoot = path.resolve(stackRoot(), "..");
const BOOT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(hostBinary === undefined)("OpenCode v2 host: el registro real resuelve los agentes proyectados", () => {
  let runRoot = "";
  let configDir = "";
  let cwd = "";
  let copy = "";
  let server: ChildProcess | null = null;
  let serverOutput = "";
  let baseUrl = "";
  let password = "";
  let observedVersion = "";
  let spawnError: Error | undefined;

  /**
   * La password del servidor es una credencial local efímera: nunca debe salir
   * en un diagnóstico, error o log de este test.
   */
  function sanitized(output: string): string {
    const withoutSecret = password === "" ? output : output.split(password).join("<redacted>");
    return withoutSecret.replace(/server password \S+/g, "server password <redacted>");
  }

  /** Solo el grupo de procesos propio: vivo si queda algún miembro del grupo. */
  function ownGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitOwnGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!ownGroupAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !ownGroupAlive(pid);
  }

  function hostEnv(): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin",
      HOME: path.join(runRoot, "home"),
      XDG_CONFIG_HOME: path.join(runRoot, "config"),
      XDG_DATA_HOME: path.join(runRoot, "data"),
      XDG_CACHE_HOME: path.join(runRoot, "cache"),
      XDG_STATE_HOME: path.join(runRoot, "state"),
      XDG_RUNTIME_DIR: path.join(runRoot, "runtime"),
      TMPDIR: path.join(runRoot, "tmp"),
    };
  }

  function runCopy(args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
    const result = spawnSync(copy, args, {
      cwd,
      env: hostEnv(),
      encoding: "utf8",
      timeout: BOOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  }

  function hashOf(file: string): string {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  }

  async function api(method: string, route: string): Promise<{ status: number; body: string }> {
    const response = await fetch(new URL(route, baseUrl), {
      method,
      headers: authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.text() };
  }

  async function apiJson<T>(route: string): Promise<T> {
    const { status, body } = await api("GET", route);
    expect(status, `GET ${route}: ${body.slice(0, 300)}`).toBe(200);
    return JSON.parse(body) as T;
  }

  interface RegistryAgent {
    id: string;
    mode?: string;
    model?: { providerID?: string; id?: string; model?: string; variant?: string };
    permissions?: Array<{ action?: string; resource?: string; effect?: string }>;
  }

  async function waitForBoot(): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError !== undefined) {
        throw new Error(
          `no se pudo lanzar el servidor: ${spawnError.message}. Salida: ${sanitized(serverOutput).slice(-600)}`,
        );
      }
      const url = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverOutput);
      const pw = /server password (\S+)/.exec(serverOutput);
      if (url !== null && pw !== null) {
        baseUrl = `${url[1]!}/`;
        password = pw[1]!;
        return;
      }
      if (server !== null && server.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `el servidor no arrancó (exit=${server?.exitCode ?? "sin proceso"}). Salida: ${sanitized(serverOutput).slice(-600)}`,
    );
  }

  beforeAll(async () => {
    runRoot = fs.mkdtempSync(path.join(repoRoot, "node_modules", ".jx-opencode-v2-host-"));
    configDir = path.join(runRoot, "config", "opencode");
    cwd = path.join(runRoot, "cwd");
    copy = path.join(runRoot, "bin", "opencode-copy");
    for (const dir of ["home", "config/opencode", "data", "cache", "state", "runtime", "tmp", "cwd", "bin"]) {
      fs.mkdirSync(path.join(runRoot, dir), { recursive: true });
    }

    expect(hostBinary, "JORGEX_OPENCODE_V2_BIN").toBeDefined();
    fs.copyFileSync(hostBinary!, copy);
    fs.chmodSync(copy, 0o500);

    const version = runCopy(["--version"]);
    expect(version.error, version.error?.message ?? "").toBeUndefined();
    expect(version.status, version.stderr).toBe(0);
    observedVersion = version.stdout.trim();
    const match = /^opencode v(\d+)\.(\d+)\.(\d+)$/.exec(observedVersion);
    expect(match, `versión observada: ${observedVersion}`).not.toBeNull();
    expect(Number(match![1]), `major observado en ${observedVersion}`).toBe(2);

    // Servidor v2 persistente en su PROPIO grupo de procesos (solo se parará él).
    server = spawn(copy, ["serve", "--port", "0", "--print-logs", "--log-level", "info"], {
      cwd,
      env: hostEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.on("error", (error) => {
      spawnError = error;
    });
    const append = (chunk: Buffer): void => {
      serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384);
    };
    server.stdout?.on("data", append);
    server.stderr?.on("data", append);
    await waitForBoot();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    // Guarda: si beforeAll falló antes de crear la raíz, no hay nada que limpiar.
    if (runRoot === "") return;

    // Solo el grupo de procesos propio; nunca procesos ajenos. Se confirma su
    // desaparición ANTES de borrar ficheros.
    let stopped = true;
    const pid = server?.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Ya terminó.
      }
      stopped = await waitOwnGroupGone(pid, 5_000);
      if (!stopped) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Ya no existe.
        }
        stopped = await waitOwnGroupGone(pid, 5_000);
      }
    }

    if (!stopped) {
      // Limpieza fallida explícita: se conserva la evidencia y la ruta.
      throw new Error(
        `cleanup incompleto: el grupo del servidor propio (pid ${pid}) sigue vivo; raíz conservada en ${runRoot}`,
      );
    }

    fs.rmSync(runRoot, { recursive: true, force: true });
    expect(fs.existsSync(runRoot), "raíz privada eliminada").toBe(false);
  }, TEST_TIMEOUT_MS);

  it("copia solo el ejecutable y observa el host real", () => {
    expect(hashOf(copy), "sha256 copia == original").toBe(hashOf(hostBinary!));
    fs.writeFileSync(path.join(runRoot, "observed-version.txt"), `${observedVersion}\n`);
  });

  it("el registro real resuelve todos los agentes proyectados con modelo y reglas", async () => {
    const ctx = {
      stackDir: stackRoot(),
      configDir,
      engramBin: null,
      models: DEFAULT_MODEL_MAP.opencode,
      warnings: [] as string[],
    };
    const actions = [
      ...opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx),
      ...planAgents(opencodeAdapter, ctx),
    ];
    for (const action of actions) {
      if (action.kind !== "write") continue;
      fs.mkdirSync(path.dirname(action.target), { recursive: true });
      fs.writeFileSync(action.target, action.content);
    }

    const targets = actions.flatMap((action) => (action.kind === "write" ? [action.target] : []));
    const configTarget = targets.find(
      (target) => path.dirname(target) === configDir && /^opencode\.jsonc?$/.test(path.basename(target)),
    );
    expect(configTarget, `proyectado: ${targets.join(", ")}`).toBeDefined();

    // Ajustes SOLO del fixture (raíz privada): sin auto-update, sin MCP externo
    // y sin plugins propios: la prueba cubre config/agentes, no T06.
    for (const name of ["plugin", "plugins"]) fs.rmSync(path.join(configDir, name), { recursive: true, force: true });
    const fixture = parseJsonc(fs.readFileSync(configTarget!, "utf8")) as Record<string, any>;
    fixture["update"] = "disable";
    for (const entry of Object.values((fixture["mcp"] as { servers?: Record<string, any> } | undefined)?.servers ?? {})) {
      entry["disabled"] = true;
    }
    fs.writeFileSync(configTarget!, `${JSON.stringify(fixture, null, 2)}\n`);

    // Contrato esperado DERIVADO de los ficheros proyectados (sin inyectar JSON).
    const canonical = loadCanonicalAgents(path.join(stackRoot(), "agents"));
    const expected = canonical.map((agent) => {
      const source = fs.readFileSync(path.join(configDir, "agents", `${agent.name}.md`), "utf8");
      const frontmatter = source.slice(source.indexOf("---") + 3, source.indexOf("\n---", 3));
      const field = (name: string): string | undefined =>
        frontmatter.split("\n").find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
      const modelText = field("model");
      return { id: agent.name, mode: agent.mode, modelText: modelText === undefined ? undefined : (JSON.parse(modelText) as string) };
    });
    expect(expected.length, "roster canónico proyectado").toBeGreaterThanOrEqual(13);
    const withModel = expected.filter((entry) => entry.modelText !== undefined);
    expect(withModel.length, "subagentes con modelo").toBeGreaterThan(0);

    // Arranque de la location + activación del registro.
    const info = await apiJson<{ version: string }>("/api/info");
    expect(info.version, `--version dijo ${observedVersion}`).toBe(observedVersion.replace(/^opencode v/, ""));
    const boot = await apiJson<{ data: RegistryAgent[] }>("/api/agent");
    expect(Array.isArray(boot.data)).toBe(true);

    const reload = await api("POST", "/api/location/reload");
    expect(reload.status, `POST /api/location/reload: ${reload.body.slice(0, 200)}`).toBe(204);

    // El descubrimiento de ficheros del plugin de config es asíncrono tras el
    // reload: se sondea el registro (acotado) hasta que aparezcan todos los
    // agentes proyectados; el sondeo no relaja la aserción, solo espera.
    const expectedIds = expected.map((entry) => entry.id);
    let data: RegistryAgent[] = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      data = (await apiJson<{ data: RegistryAgent[] }>("/api/agent")).data;
      if (expectedIds.every((id) => data.some((agent) => agent.id === id))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const byId = new Map(data.map((agent) => [agent.id, agent]));

    // El registro REAL contiene a todos los agentes proyectados desde fichero.
    for (const entry of expected) {
      const agent = byId.get(entry.id);
      expect(agent, `agente ausente del registro: ${entry.id} (registro: ${[...byId.keys()].join(", ")})`).toBeDefined();
      if (entry.mode !== undefined) expect(agent!.mode).toBe(entry.mode);
      if (entry.modelText !== undefined) {
        const [providerID, rest] = entry.modelText.split("/");
        const [modelID, variant] = (rest ?? "").split("#");
        expect(agent!.model?.providerID, `${entry.id} provider`).toBe(providerID);
        expect(agent!.model?.id ?? agent!.model?.model, `${entry.id} modelo`).toBe(modelID);
        if (variant !== undefined && variant !== "") expect(agent!.model?.variant, `${entry.id} variant`).toBe(variant);
      }
    }

    // Reglas resueltas por el host para un rol proyectado con `permissions`.
    const rules = byId.get("code-reviewer")?.permissions ?? [];
    expect(rules.length, `rules de code-reviewer: ${JSON.stringify(rules).slice(0, 200)}`).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.action, JSON.stringify(rule)).toBeDefined();
      expect(rule.resource, JSON.stringify(rule)).toBeDefined();
      expect(["allow", "ask", "deny"]).toContain(rule.effect);
    }
    expect(rules.some((rule) => rule.action === "edit" && rule.resource === "*" && rule.effect === "deny")).toBe(true);

    // Ningún plugin ajeno cargado: el host lista sus plugins builtin, y el
    // fixture no proyecta plugins desde el config privado (T06 fuera de T04).
    const plugins = await apiJson<{ data: Array<{ id?: string; source?: { type?: string; path?: string } }> }>("/api/plugin");
    const foreign = plugins.data.filter(
      (entry) => entry.source?.type !== "builtin" || (entry.source?.path ?? "").includes(configDir),
    );
    expect(foreign, `plugins ajenos: ${JSON.stringify(foreign).slice(0, 300)}`).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
