import http from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { FileAction } from "../src/adapters/types.js";
import { planPlugins } from "../src/components/plugins.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

/**
 * Verificación de los plugins Stack OpenCode v2 (`stack/plugins/opencode/hooks.ts`
 * y `worktree.ts`) contra el HOST REAL 2.0.21 con EVENTOS REALES de herramienta
 * (Spec T05/T06, SC-04). No se afirma el registro `/api/plugin` ni un mock de
 * `ctx.tool.hook`: se carga el plugin proyectado por el propio instalador y se
 * observa el `tool_use` nativo que el host emite tras ejecutar el shell.
 *
 * Recipe probada empíricamente contra `opencode v2.0.20`; versión reobservada en
 * la copia privada actual: `opencode v2.0.21` (copia privada del ejecutable,
 * sha256 origen vs copia, ejecutada por separado):
 *   - `opencode run --standalone --format json` arranca el motor con un provider
 *     LOCAL en proceso (`@opencode/ai/providers/openai-compatible` contra un
 *     stub HTTP efímero). Sin cuenta, credencial, modelo real ni configuración
 *     personal: todo vive en una raíz temporal y el stub solo devuelve una
 *     `tool_call` de `shell` determinista.
 *   - El host autocaraga `plugins/*.ts` de la raíz efectiva y ejecuta
 *     `tool.execute.after`; el resultado del plugin aparece en
 *     `part.state.metadata.content` del evento `tool_use` real.
 *   - La proyección se hace con el MISMO código del producto
 *     (`planMainConfig` + `planHooks` + `planPlugins`); solo se inyectan ajustes
 *     de fixture (provider stub, `update: disable`, MCP desactivado).
 *
 * Cobertura observada en eventos reales:
 *   1. hooks.ts anexa el contexto del script al resultado completed y resuelve
 *      el directorio desde la sesión + `input.workdir` (no el cwd crudo del
 *      proceso ni el dir del plugin/config), conservando el `output` original y
 *      el exit real del shell.
 *   2. hooks.ts ejecuta el script canónico `repair-worktree-config.cjs` y repara
 *      un `core.bare=true` real de un repo con worktree enlazado, anexando el
 *      diagnóstico sin perder la salida original.
 *   3. worktree.ts atribuye un `git worktree add` real (rama = nombre, path
 *      canónico) y ejecuta el `setupScript` configurado.
 *   4. control de no-éxito: un `git worktree add` con exit ≠ 0 NO ejecuta setup.
 *   5. hooks.ts dispara el script canónico `post-pr-review.cjs` (pedido de PR
 *      readiness) y anexa el aviso de ciclo de vida literal, sin inferir éxito;
 *      el comando corre contra un `gh` FALSO privado (PATH propio) que deja
 *      marcador y sale ≠ 0 — sin gh real, red ni operación de PR.
 *
 * Límite declarado: con `run --standalone` el cwd del servidor coincide con
 * `session.location.directory`, así que el caso 1 distingue la resolución basada
 * en evento (sesión + workdir relativo) frente al cwd crudo del proceso o el
 * directorio del plugin/config; no puede separar ambos directorios de sesión.
 *
 * - Solo se copian los BYTES del ejecutable (sha256 origen vs copia) y se
 *   ejecuta la COPIA. Skip por defecto: exige `JORGEX_OPENCODE_V2_BIN`.
 * - Todo vive en una raíz privada dentro de `node_modules`; el teardown se
 *   registra ANTES de crearla y solo detiene/elimina procesos y ficheros propios.
 * - La password efímera del servidor (si apareciera) nunca sale en diagnósticos.
 */
const hostBinary = process.env.JORGEX_OPENCODE_V2_BIN;
const repoRoot = path.resolve(stackRoot(), "..");
// Versión observada en la copia privada actual (sha256 origen vs copia); la
// captura original de la receta fue contra v2.0.20.
const EXPECTED_VERSION = "opencode v2.0.21";
const CASE_TIMEOUT_MS = 90_000;

interface ToolUseEvent {
  type?: string;
  part?: {
    tool?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
      metadata?: { metadata?: { exit?: unknown; status?: unknown }; content?: unknown };
    };
  };
}

interface Stub {
  port: number;
  close: () => Promise<void>;
}

interface HostRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** La password del servidor es una credencial local efímera: nunca debe salir. */
function sanitized(output: string): string {
  return output.replace(/server password \S+/g, "server password <redacted>");
}

/** Texto de contenido del resultado real (incluye lo anexado por el plugin). */
function contentText(event: ToolUseEvent | undefined): string {
  const content = event?.part?.state?.metadata?.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: unknown })?.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  if (parts.length === 0 && typeof event?.part?.state?.output === "string") {
    parts.push(event.part.state.output);
  }
  return parts.join("\n");
}

function exitCode(event: ToolUseEvent | undefined): unknown {
  return event?.part?.state?.metadata?.metadata?.exit;
}

function findShellEvent(stdout: string): ToolUseEvent | undefined {
  let found: ToolUseEvent | undefined;
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as ToolUseEvent;
      if (parsed.type === "tool_use" && parsed.part?.tool === "shell") found = parsed;
    } catch {
      // Ignora líneas no JSON (no debería haber con --format json).
    }
  }
  return found;
}

describe.skipIf(hostBinary === undefined)(
  "OpenCode v2 host plugins: carga y eventos reales de hooks/worktree (SC-04)",
  () => {
    let runRoot = "";
    let copy = "";
    let observedVersion = "";
    const activeChildren = new Set<ChildProcess>();

    function newCaseRoot(label: string): string {
      const root = fs.mkdtempSync(path.join(runRoot, `${label}-`));
      for (const dir of ["bin", "home", "config", "data", "cache", "state", "runtime", "tmp", "gh-config"]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
      }
      return root;
    }

    function hostEnv(root: string): NodeJS.ProcessEnv {
      // `bin` propio primero: permite fijar ejecutables fixture (p. ej. un `gh`
      // privado) sin tocar el PATH real ni resolver binarios del sistema. La
      // isla GH confina cualquier `gh` real que pudiera colarse a la raíz privada.
      return {
        PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
        GH_CONFIG_DIR: path.join(root, "gh-config"),
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_RUNTIME_DIR: path.join(root, "runtime"),
        TMPDIR: path.join(root, "tmp"),
        OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
        NO_COLOR: "1",
      };
    }

    /** Escribe el plan real del producto (config + hooks/scripts + plugins). */
    function projectFixture(configDir: string): void {
      fs.mkdirSync(configDir, { recursive: true });
      const ctx = {
        stackDir: stackRoot(),
        configDir,
        engramBin: null,
        models: DEFAULT_MODEL_MAP.opencode,
        warnings: [] as string[],
      };
      const actions: FileAction[] = [
        ...opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx),
        ...opencodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), ctx),
        ...planPlugins(opencodeAdapter, ctx),
      ];
      for (const action of actions) {
        fs.mkdirSync(path.dirname(action.target), { recursive: true });
        if (action.kind === "write") fs.writeFileSync(action.target, action.content);
        else fs.copyFileSync(action.source, action.target);
      }
    }

    /** Config efectiva del host en la raíz privada (json o jsonc). */
    function configFileOf(configDir: string): string {
      const candidates = ["opencode.json", "opencode.jsonc"].map((name) => path.join(configDir, name));
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      expect(found, `config proyectada en ${configDir}`).toBeDefined();
      return found!;
    }

    /** Ajustes SOLO del fixture: provider stub local, sin update ni MCP externo. */
    function injectFixtureProvider(configDir: string, port: number): void {
      const configFile = configFileOf(configDir);
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
      for (const entry of Object.values(
        (config["mcp"] as { servers?: Record<string, any> } | undefined)?.servers ?? {},
      )) {
        (entry as Record<string, unknown>)["disabled"] = true;
      }
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    }

    /** Stub OpenAI-compatible local: sin red externa ni credenciales. */
    async function startStub(command: string, workdir?: string): Promise<Stub> {
      const args: Record<string, unknown> = { command };
      if (workdir !== undefined) args["workdir"] = workdir;
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
        const done = body.messages?.some((message) => message.role === "tool") === true;
        const delta = done || isTitle
          ? { content: "fixture" }
          : {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "call", type: "function", function: { name: "shell", arguments: JSON.stringify(args) } },
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
            choices: [{ index: 0, delta: {}, finish_reason: done || isTitle ? "stop" : "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
      const port = await new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
      );
      return {
        port,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    async function runHost(root: string, cwd: string, args: string[]): Promise<HostRun> {
      const child = spawn(copy, args, {
        cwd,
        env: hostEnv(root),
        stdio: ["ignore", "pipe", "pipe"],
      });
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

    /**
     * Ejecuta una tool real contra el host. `setup` prepara el fixture y devuelve
     * el cwd del proceso host (directorio de sesión).
     */
    async function runShellCase(input: {
      label: string;
      command: string;
      workdir?: string;
      setup: (caseRoot: string) => string;
    }): Promise<{ caseRoot: string; configDir: string; cwd: string; event: ToolUseEvent }> {
      const caseRoot = newCaseRoot(input.label);
      const configDir = path.join(caseRoot, "config", "opencode");
      projectFixture(configDir);
      const cwd = input.setup(caseRoot);
      const stub = await startStub(input.command, input.workdir);
      try {
        injectFixtureProvider(configDir, stub.port);
        const args = [
          "run", "--standalone", "--format", "json", "--auto",
          "--model", "fixture/fixture", "--title", "plugin fixture",
          "Use the local fixture once.",
        ];
        const { code, stdout, stderr } = await runHost(caseRoot, cwd, args);
        expect(code, `run salió con ${code}. stderr: ${sanitized(stderr).slice(-500)}`).toBe(0);
        const event = findShellEvent(stdout);
        expect(event, `evento tool_use real. stdout: ${stdout.slice(-600)}`).toBeDefined();
        return { caseRoot, configDir, cwd, event: event! };
      } finally {
        await stub.close();
      }
    }

    /** Git hermético: nunca lee la config global/personal del HOME real. */
    function gitEnv(): NodeJS.ProcessEnv {
      return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    }

    function git(args: string[], cwd: string): string {
      return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
    }

    function initRepo(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "fixture@test.invalid"], dir);
      git(["config", "user.name", "Fixture"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
      git(["add", "-A"], dir);
      git(["commit", "-qm", "init"], dir);
    }

    function installWorktreeFixture(project: string): void {
      fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(project, "scripts", "setup-marker.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          "fs.writeFileSync(",
          '  path.join(process.cwd(), "worktree-setup-marker.json"),',
          '  JSON.stringify({ cwd: process.cwd(), worktreePath: process.env.OPENCODE_WORKTREE_PATH || null }),',
          ");",
          'process.stdout.write("setup ok");',
          "",
        ].join("\n"),
      );
      fs.mkdirSync(path.join(project, ".opencode"), { recursive: true });
      fs.writeFileSync(
        path.join(project, ".opencode", "worktree.json"),
        `${JSON.stringify({ setupScript: "scripts/setup-marker.cjs", pathContains: "worktrees/", reminderLines: ["REMINDER {worktreeName}"] }, null, 2)}\n`,
      );
    }

    beforeAll(async () => {
      expect(hostBinary, "JORGEX_OPENCODE_V2_BIN").toBeDefined();
      runRoot = fs.mkdtempSync(path.join(repoRoot, "node_modules", ".jx-opencode-v2-plugins-"));
      copy = path.join(runRoot, "opencode-copy");
      fs.copyFileSync(hostBinary!, copy);
      fs.chmodSync(copy, 0o500);
      expect(sha256(copy), "sha256 copia == original").toBe(sha256(hostBinary!));

      const versionRoot = newCaseRoot("version");
      const { code, stdout, stderr } = await runHost(versionRoot, versionRoot, ["--version"]);
      expect(code, sanitized(stderr)).toBe(0);
      observedVersion = stdout.trim();
      expect(observedVersion, `versión observada: ${observedVersion}`).toBe(EXPECTED_VERSION);
    }, CASE_TIMEOUT_MS);

    afterAll(async () => {
      // Sólo procesos propios; se confirma su salida ANTES de borrar la raíz.
      const stopped = await Promise.all(
        [...activeChildren].map(
          (child) =>
            new Promise<boolean>((resolve) => {
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
            }),
        ),
      );
      if (runRoot === "") return;
      if (stopped.some((value) => value === false)) {
        throw new Error(`cleanup incompleto: hay procesos propios vivos; raíz conservada en ${runRoot}`);
      }
      fs.rmSync(runRoot, { recursive: true, force: true });
      expect(fs.existsSync(runRoot), "raíz privada eliminada").toBe(false);
    }, CASE_TIMEOUT_MS);

    it("copia solo el ejecutable y observa el host real v2.0.21", () => {
      expect(sha256(copy)).toBe(sha256(hostBinary!));
      expect(observedVersion).toBe(EXPECTED_VERSION);
      expect(Number(/^opencode v(\d+)\./.exec(observedVersion)?.[1]), "major 2").toBe(2);
    });

    it("hooks: anexa contexto a un completed real y resuelve el cwd por sesión + workdir", async () => {
      const { configDir, cwd, event } = await runShellCase({
        label: "hooks-cwd",
        command: "echo hello; exit 3",
        workdir: "sub",
        setup: (root) => {
          const sessionDir = path.join(root, "cwd");
          const resolved = path.join(sessionDir, "sub");
          fs.mkdirSync(path.join(resolved, "scripts"), { recursive: true });
          fs.mkdirSync(path.join(resolved, ".opencode"), { recursive: true });
          fs.writeFileSync(
            path.join(resolved, "scripts", "marker.cjs"),
            [
              'let raw = "";',
              'process.stdin.on("data", (chunk) => (raw += chunk));',
              'process.stdin.on("end", () => {',
              "  let payload = {};",
              '  try { payload = JSON.parse(raw || "{}"); } catch {}',
              "  process.stdout.write(JSON.stringify({ additionalContext: `HOOK_CONTEXT directory=${payload.directory}` }));",
              "});",
              "",
            ].join("\n"),
          );
          fs.writeFileSync(
            path.join(resolved, ".opencode", "hooks.json"),
            JSON.stringify({ "tool.execute.after": { bash: { "*": ["scripts/marker.cjs"] } } }),
          );
          return sessionDir;
        },
      });

      const resolved = path.join(cwd, "sub");
      expect(event.part?.state?.status, contentText(event)).toBe("completed");
      expect(exitCode(event), "exit real del shell").toBe(3);
      expect(contentText(event), "salida original preservada").toContain("hello");
      expect(contentText(event), "contexto anexado al resultado real").toContain(
        `HOOK_CONTEXT directory=${resolved}`,
      );
      // La resolución no usa el cwd crudo del proceso (= cwd) ni la raíz de config.
      expect(resolved, "workdir aplicado").not.toBe(cwd);
      expect(resolved, "no es el dir del plugin/config").not.toBe(configDir);
    }, CASE_TIMEOUT_MS);

    it("hooks: ejecuta repair-worktree-config real y repara core.bare preservando la salida", async () => {
      let project = "";
      let worktree = "";
      const { event } = await runShellCase({
        label: "hooks-repair",
        command: "git status",
        setup: (root) => {
          project = path.join(root, "project");
          worktree = path.join(root, "wt");
          initRepo(project);
          git(["worktree", "add", "-q", worktree], project);
          git(["config", "core.bare", "true"], project);
          return worktree;
        },
      });

      const sharedConfig = path.join(project, ".git", "config");
      expect(
        execFileSync("git", ["config", "--file", sharedConfig, "--get", "core.bare"], {
          cwd: worktree,
          encoding: "utf8",
          env: gitEnv(),
        }).trim(),
        "core.bare reparado en el config compartido",
      ).toBe("false");
      expect(event.part?.state?.status, contentText(event)).toBe("completed");
      expect(String(event.part?.state?.output), "salida original de git status preservada").toContain(
        "On branch",
      );
      expect(contentText(event), "diagnóstico del script real anexado").toContain(
        "[repair-worktree-config] reparado:",
      );
      expect(contentText(event), "el diagnóstico nombra core.bare").toContain("core.bare");
    }, CASE_TIMEOUT_MS);

    it("worktree: setup real sobre un worktree canónico (rama = nombre)", async () => {
      let project = "";
      const { event } = await runShellCase({
        label: "worktree-setup",
        command: "git worktree add worktrees/can-01",
        setup: (root) => {
          project = path.join(root, "project");
          initRepo(project);
          installWorktreeFixture(project);
          return project;
        },
      });

      const canonical = path.join(project, "worktrees", "can-01");
      expect(contentText(event), "setup ejecutado").toContain("Worktree setup complete: can-01");
      expect(contentText(event), "recordatorio canónico anexado").toContain("REMINDER can-01");

      const marker = JSON.parse(
        fs.readFileSync(path.join(project, "worktree-setup-marker.json"), "utf8"),
      ) as { worktreePath?: string };
      expect(marker.worktreePath, "OPENCODE_WORKTREE_PATH = path canónico").toBe(canonical);

      const inventory = git(["worktree", "list", "--porcelain"], project);
      expect(inventory, "worktree enlazado en el path canónico").toContain(canonical);
      expect(inventory, "rama = nombre").toContain("branch refs/heads/can-01");
    }, CASE_TIMEOUT_MS);

    it("worktree: un comando con exit ≠ 0 no ejecuta setup (control)", async () => {
      let project = "";
      const { event } = await runShellCase({
        label: "worktree-control",
        command: "git worktree add",
        setup: (root) => {
          project = path.join(root, "project");
          initRepo(project);
          installWorktreeFixture(project);
          return project;
        },
      });

      expect(event.part?.state?.status, contentText(event)).toBe("completed");
      expect(typeof exitCode(event), "exit numérico no-cero").toBe("number");
      expect(exitCode(event)).not.toBe(0);
      expect(contentText(event), "control diagnosticado").toMatch(
        /Worktree command did not succeed \(exit \d+\); skipping worktree setup\./,
      );
      expect(fs.existsSync(path.join(project, "worktree-setup-marker.json")), "sin setup").toBe(false);
      expect(git(["worktree", "list", "--porcelain"], project), "sin worktree nuevo").not.toContain(
        path.join(project, "worktrees"),
      );
    }, CASE_TIMEOUT_MS);

    it("hooks: dispara el post-pr-review canónico con un gh privado y no infiere éxito", async () => {
      let fakeGhMarker = "";
      let fakeGhBin = "";
      const { event } = await runShellCase({
        label: "hooks-pr-ready",
        command: "gh pr ready 999",
        setup: (root) => {
          fakeGhMarker = path.join(root, "gh-invoked.json");
          fakeGhBin = path.join(root, "bin", "gh");
          // `gh` FALSO privado: deja marcador y sale ≠ 0. Nunca toca red,
          // credenciales ni un PR real.
          fs.writeFileSync(
            fakeGhBin,
            [
              "#!/usr/bin/env node",
              'const fs = require("node:fs");',
              `fs.writeFileSync(${JSON.stringify(fakeGhMarker)}, JSON.stringify(process.argv.slice(2)));`,
              'process.stdout.write("fake gh: attempted pr ready (offline fixture)\\n");',
              "process.exit(7);",
              "",
            ].join("\n"),
            { mode: 0o755 },
          );
          fs.chmodSync(fakeGhBin, 0o755);
          const projectDir = path.join(root, "project");
          fs.mkdirSync(projectDir, { recursive: true });
          return projectDir;
        },
      });

      // El comando corrió contra el gh falso privado, no contra el real.
      expect(fs.existsSync(fakeGhMarker), `gh falso invocado (bin=${fakeGhBin})`).toBe(true);
      expect(JSON.parse(fs.readFileSync(fakeGhMarker, "utf8")), "args del gh falso").toEqual([
        "pr",
        "ready",
        "999",
      ]);

      // El evento nativo conserva la salida y el exit originales del comando.
      expect(event.part?.state?.status, contentText(event)).toBe("completed");
      expect(exitCode(event), "exit del gh falso").toBe(7);
      expect(String(event.part?.state?.output), "salida original del gh falso preservada").toContain(
        "fake gh: attempted pr ready",
      );

      // El hook canónico (planHooks real) anexa el aviso literal de ciclo de
      // vida porque la transición se INTENTÓ; no certifica ni infiere éxito.
      const appended = contentText(event);
      expect(appended, "aviso canónico de PR readiness anexado").toContain(
        "<pr-lifecycle-state-required>",
      );
      expect(appended, "declara intento, no éxito").toContain(
        "A PR readiness transition was attempted",
      );
      expect(appended, "no inferir éxito/estado").toContain(
        "Do not infer success or PR state from the command text",
      );
    }, CASE_TIMEOUT_MS);
  },
);
