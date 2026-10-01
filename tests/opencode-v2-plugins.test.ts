import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hooksModule from "../stack/plugins/opencode/hooks.js";
import * as worktreeModule from "../stack/plugins/opencode/worktree.js";
import { stackRoot } from "../src/lib/paths.js";

/**
 * RED focal de la API de plugins OpenCode v2 (tag 2.0.20, contrato T05/T06):
 *
 * - `export default { id, setup }` sin SDK runtime v1.
 * - La carga registra hooks con `ctx.tool.hook("execute.before" | "execute.after", cb)`
 *   y recibe un evento `{ id, tool, sessionID, input, status, result|error }`.
 * - `after` completed trae `result` y `after` error trae `error` (sin result).
 * - Reemplazar `event.result` conservando output/metadata y anexando texto a
 *   `content` (campos readonly); el callback no devuelve el result.
 * - El cwd sale de `ctx.session.get({ sessionID }).location.directory` +
 *   `input.workdir` relativo, nunca del cwd del proceso/servidor.
 * - Sin logger v1 (`client.app.log`/`app.log`), sin `console.*`, sin
 *   `@opencode-ai/plugin`, sin `enterworktree` ni `server.connected`.
 *
 * Este archivo NO re-prueba la matriz de reglas de negocio worktree: eso vive
 * en `worktree-plugin.test.ts` (atribución pre/post, path canónico, exit shell)
 * y `repair-worktree-config.test.ts` (cableado de scripts). Aquí se fija el
 * borde de carga/registro/resultado del host v2, que es lo que v1 no ofrece.
 */

type HookHandler = (event: Record<string, unknown>) => unknown;

interface PluginShape {
  id: string;
  setup: (ctx: unknown) => unknown;
}

const pluginOf = (module: unknown): PluginShape | undefined =>
  (module as { default?: PluginShape }).default;

interface V2Host {
  ctx: unknown;
  registered: Map<string, HookHandler>;
  sessionID: string;
}

const createV2Host = (sessionDirectory: string, sessionID = "ses_v2_fixture"): V2Host => {
  const registered = new Map<string, HookHandler>();
  const ctx = {
    tool: {
      hook: (name: string, handler: HookHandler) => {
        registered.set(name, handler);
      },
    },
    session: {
      get: async ({ sessionID: requested }: { sessionID: string }) => ({
        id: requested,
        location: { directory: sessionDirectory },
      }),
    },
  };
  return { ctx, registered, sessionID };
};

interface SpawnStubResult {
  stdout: string;
  stderr: string;
  exited: Promise<number>;
}

const stubHostBun = (spawnImpl: () => SpawnStubResult) => {
  const spawn = vi.fn((_command: string[], _options: unknown) => spawnImpl());
  vi.stubGlobal("Bun", {
    file: (filePath: string) => ({
      exists: async () => fs.existsSync(filePath),
      text: async () => fs.readFileSync(filePath, "utf8"),
    }),
    spawn,
  });
  return spawn;
};

// Igual que `stubHostBun`, pero fuerza el fallo de lectura de un único fichero
// (p. ej. EACCES/EIO) mientras el resto sigue leyendo del filesystem real. Sirve
// para distinguir un hooks.json ilegible de uno ausente sin tocar el HOME real.
const stubHostBunWithFileFailure = (failPath: string, error: unknown) => {
  const resolved = path.resolve(failPath);
  const spawn = vi.fn();
  vi.stubGlobal("Bun", {
    file: (filePath: string) => ({
      exists: async () => fs.existsSync(filePath),
      text: async () => {
        if (path.resolve(filePath) === resolved) throw error;
        return fs.readFileSync(filePath, "utf8");
      },
    }),
    spawn,
  });
  return spawn;
};

const writeHooks = (projectDir: string, hooks: unknown) => {
  fs.mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".opencode", "hooks.json"), JSON.stringify(hooks));
};

// La raíz global usa `<root>/hooks.json` (no `.opencode/`), que es donde
// `loadConfig` busca la configuración de usuario.
const writeGlobalHooks = (root: string, hooks: unknown) => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "hooks.json"), JSON.stringify(hooks));
};

const writeScript = (projectDir: string, name: string, body = "process.exit(0);\n") => {
  fs.mkdirSync(path.join(projectDir, "scripts"), { recursive: true });
  const target = path.join(projectDir, "scripts", name);
  fs.writeFileSync(target, body);
  return target;
};

const outputHookConfig = (script: string) => ({
  "tool.execute.after": { bash: { "*": [`scripts/${script}`] } },
});

const completedEvent = (opts: {
  id: string;
  sessionID: string;
  command: string;
  workdir: string;
}) => ({
  id: opts.id,
  tool: "shell",
  sessionID: opts.sessionID,
  input: { command: opts.command, workdir: opts.workdir },
  status: "completed",
  result: {
    title: "shell",
    output: "original output",
    metadata: { exit: 0, truncated: false, description: "shell" },
    content: [{ type: "text", text: "original content" }],
  },
});

const contentText = (result: unknown): string => {
  const value = result as { output?: unknown; content?: unknown } | undefined;
  const parts: string[] = [];
  if (typeof value?.output === "string") parts.push(value.output);
  if (typeof value?.content === "string") parts.push(value.content);
  if (Array.isArray(value?.content)) {
    for (const block of value.content) {
      if (typeof (block as { text?: unknown })?.text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.join("\n");
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-opencode-v2-plugins-"));
  // Aísla el hooks.json global: sin esto, el HOME real podría aportar scripts.
  vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(tmp, "global-config"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("OpenCode v2 plugins: carga y contrato de eventos", () => {
  it("hooks: default export { id, setup } registra execute.before/after sin logger v1", async () => {
    const host = createV2Host(tmp);
    const plugin = pluginOf(hooksModule);

    expect(plugin, "hooks.ts debe exportar default { id, setup }").toBeDefined();
    expect(typeof plugin!.id).toBe("string");
    expect(plugin!.id.length).toBeGreaterThan(0);
    expect(typeof plugin!.setup).toBe("function");

    // El ctx v2 solo ofrece tool.hook y session.get: si `setup` exigiera un
    // logger/cliente v1, esto fallaría.
    await plugin!.setup(host.ctx);

    expect(typeof host.registered.get("execute.before"), "execute.before registrado").toBe("function");
    expect(typeof host.registered.get("execute.after"), "execute.after registrado").toBe("function");
  });

  it("worktree: default export { id, setup } registra execute.after sin recrear el motor nativo", async () => {
    const host = createV2Host(tmp);
    const plugin = pluginOf(worktreeModule);
    stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(0) }));

    expect(plugin, "worktree.ts debe exportar default { id, setup }").toBeDefined();
    expect(typeof plugin!.id).toBe("string");
    expect(plugin!.id.length).toBeGreaterThan(0);
    expect(typeof plugin!.setup).toBe("function");

    await plugin!.setup(host.ctx);

    expect(typeof host.registered.get("execute.after"), "execute.after registrado").toBe("function");
  });

  it("hooks: resuelve cwd desde la sesión + workdir relativo, nunca el cwd del proceso", async () => {
    const sessionDir = path.join(tmp, "session");
    const nested = path.join(sessionDir, "sub");
    fs.mkdirSync(nested, { recursive: true });
    writeHooks(nested, outputHookConfig("echo.cjs"));
    const script = writeScript(nested, "echo.cjs");

    const spawn = stubHostBun(() => ({
      stdout: JSON.stringify({ additionalContext: "FROM_SESSION" }),
      stderr: "",
      exited: Promise.resolve(0),
    }));

    const host = createV2Host(sessionDir);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: "call-cwd",
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: "sub",
    });
    await handler(event);

    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0]! as [string[], { cwd?: string }];
    expect(command[1], "script resuelto bajo la sesión").toBe(script);
    expect(options.cwd, "cwd = session.location.directory + input.workdir").toBe(nested);
    expect(command[1]!.startsWith(sessionDir), "no usa el cwd del proceso").toBe(true);
    expect(contentText(event.result)).toContain("FROM_SESSION");
  });

  it("hooks: reemplaza event.result conservando output/metadata, anexa a content y no muta el original", async () => {
    const sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeHooks(sessionDir, outputHookConfig("echo.cjs"));
    writeScript(sessionDir, "echo.cjs");

    stubHostBun(() => ({
      stdout: JSON.stringify({ additionalContext: "HOOK_MSG" }),
      stderr: "",
      exited: Promise.resolve(0),
    }));

    const host = createV2Host(sessionDir);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: "call-result",
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: ".",
    }) as Record<string, unknown> & { result: { output: string; metadata: unknown; content: unknown[] } };
    const original = event.result;

    const returned = await handler(event);

    expect(returned, "callback void").toBeUndefined();
    expect(event.result, "result reemplazado, no mutado").not.toBe(original);
    expect(String(event.result.output), "output preservado").toContain("original output");
    expect(event.result.metadata, "metadata preservado").toEqual(original.metadata);
    expect(contentText(event.result), "aviso anexado a content").toContain("HOOK_MSG");

    // Campos readonly: el objeto original no se toca.
    expect(original.output).toBe("original output");
    expect(original.content).toHaveLength(1);
    expect(JSON.stringify(original.content)).not.toContain("HOOK_MSG");
  });

  it("hooks: conserva el error original sin fabricar un result completed", async () => {
    const sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeHooks(sessionDir, outputHookConfig("echo.cjs"));
    writeScript(sessionDir, "echo.cjs");

    stubHostBun(() => ({
      stdout: JSON.stringify({ additionalContext: "SHOULD_NOT_APPEAR" }),
      stderr: "",
      exited: Promise.resolve(0),
    }));

    const host = createV2Host(sessionDir);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const error = { message: "shell exploded", code: 7 };
    const event: Record<string, unknown> = {
      id: "call-error",
      tool: "shell",
      sessionID: host.sessionID,
      input: { command: "exit 7", workdir: "." },
      status: "error",
      error,
    };

    const returned = await handler(event);

    expect(returned, "callback void").toBeUndefined();
    expect(event.result, "no se fabrica un result completed").toBeUndefined();
    expect(event.error, "error original preservado").toEqual(error);
    expect(event.status, "no se convierte en completed").toBe("error");
  });

  it("hooks: un hook con exit 3 y salida vacía queda diagnosticado y preserva el output original", async () => {
    const sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeHooks(sessionDir, outputHookConfig("failing.cjs"));
    writeScript(sessionDir, "failing.cjs", "process.exit(3);\n");

    const spawn = stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(3) }));

    const host = createV2Host(sessionDir);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: "call-exit3",
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: ".",
    }) as Record<string, unknown> & { result: { output: string; content: unknown[] } };

    await handler(event);

    expect(spawn).toHaveBeenCalledOnce();
    const text = contentText(event.result);
    expect(text, "fallo diagnóstico visible").toContain("failing.cjs");
    expect(text, "exit 3 diagnosticado").toMatch(/(exit|code|código)[^\d]{0,8}3/i);
    expect(String(event.result.output), "output original preservado").toContain("original output");
    expect(event.result.content.length, "aviso anexado").toBeGreaterThan(1);
  });

  it.each(["running", "background"])(
    "worktree: un status '%s' (no terminal) no se trata como completed",
    async (status) => {
      const host = createV2Host(tmp);
      const plugin = pluginOf(worktreeModule)!;
      stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(0) }));
      await plugin.setup(host.ctx);

      const handler = host.registered.get("execute.after")!;
      const event: Record<string, unknown> = {
        id: `call-${status}`,
        tool: "shell",
        sessionID: host.sessionID,
        input: { command: "git worktree add ../worktrees/canonical-name", workdir: "." },
        status,
      };

      const returned = await handler(event);

      expect(returned, "callback void").toBeUndefined();
      expect(event.result, "sin result terminal no se fabrica éxito").toBeUndefined();
    },
  );

  it("control GREEN: el arnés observa un plugin v2 con la forma nativa", async () => {
    const host = createV2Host(tmp);
    const synthetic: PluginShape = {
      id: "control-v2",
      setup: (ctx: unknown) => {
        (ctx as V2Host["ctx"] & { tool: { hook: (n: string, h: HookHandler) => void } }).tool.hook(
          "execute.after",
          (event: Record<string, unknown>) => {
            const value = event.result as { content?: unknown[] } | undefined;
            event.result = {
              ...(value as object),
              content: [...(value?.content ?? []), { type: "text", text: "CONTROL" }],
            };
          },
        );
      },
    };

    const plugin = pluginOf({ default: synthetic });
    expect(plugin).toBeDefined();
    await plugin!.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: "call-control",
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: ".",
    });
    const returned = await handler(event);

    expect(returned).toBeUndefined();
    expect(contentText(event.result)).toContain("CONTROL");
  });

  it("plugins v2: sin console, sin SDK v1, sin enterworktree/server.connected ni app.log", () => {
    const files = ["hooks.ts", "worktree.ts"].map((name) =>
      path.join(stackRoot(), "plugins", "opencode", name),
    );
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, `${file}: console.*`).not.toMatch(/console\./);
      expect(source, `${file}: SDK v1`).not.toContain("@opencode-ai/plugin");
      expect(source, `${file}: app.log v1`).not.toMatch(/\bapp\.log\b/);
      expect(source, `${file}: enterworktree ficticio`).not.toContain("enterworktree");
      expect(source, `${file}: server.connected no soportado`).not.toContain("server.connected");
    }
  });
});

/**
 * RED de paridad de la RAÍZ EFECTIVA (SC-02 / T04): el adapter instala en la
 * raíz nativa del host —`OPENCODE_CONFIG_DIR` > `$XDG_CONFIG_HOME/opencode` >
 * `~/.config/opencode`, ver `resolveOpenCodeConfigDir`— pero `getGlobalConfigDir`
 * de hooks.ts solo mira `OPENCODE_CONFIG_DIR` y `HOME`, ignorando
 * `XDG_CONFIG_HOME`. Con XDG activo y sin raíz explícita, los hooks globales
 * deben cargarse/ejecutarse desde `$XDG_CONFIG_HOME/opencode`, no desde el
 * default de HOME.
 *
 * Se ejecuta el handler `execute.after` real (arnés v2 + stub de Bun) sobre
 * scripts y hooks.json reales en cada raíz candidata, sembrada con un marcador
 * distinto. Así el fallo revela de qué raíz se cargó y no solo un escalar.
 */
describe("OpenCode v2 plugins: raíz global efectiva (OPENCODE_CONFIG_DIR > XDG > HOME)", () => {
  type RootKind = "explicit" | "xdg" | "home";

  const rows: Array<{ label: string; explicit: boolean; expectedKind: RootKind }> = [
    {
      label: "sin OPENCODE_CONFIG_DIR carga hooks.json/scripts de $XDG_CONFIG_HOME/opencode, no del default de HOME",
      explicit: false,
      expectedKind: "xdg",
    },
    {
      label: "con OPENCODE_CONFIG_DIR presente la raíz explícita manda sobre XDG y HOME",
      explicit: true,
      expectedKind: "explicit",
    },
  ];

  it.each(rows)("$label", async ({ explicit, expectedKind }) => {
    const homeDir = path.join(tmp, "home");
    const xdgConfigHome = path.join(tmp, "xdg-config");
    const explicitRoot = path.join(tmp, "explicit-config");

    const roots: Record<RootKind, string> = {
      explicit: explicitRoot,
      xdg: path.join(xdgConfigHome, "opencode"),
      home: path.join(homeDir, ".config", "opencode"),
    };
    const expected = roots[expectedKind];

    // Cada raíz candidata tiene hooks propios: si el plugin resuelve la raíz
    // equivocada, el script ejecutado (y su cwd) delatan la procedencia.
    for (const kind of Object.keys(roots) as RootKind[]) {
      const root = roots[kind];
      writeScript(root, `${kind}-marker.cjs`);
      writeGlobalHooks(root, outputHookConfig(`${kind}-marker.cjs`));
    }

    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
    vi.stubEnv("OPENCODE_CONFIG_DIR", explicit ? explicitRoot : undefined);

    const spawn = stubHostBun(() => ({
      stdout: JSON.stringify({ additionalContext: `${expectedKind}-marker` }),
      stderr: "",
      exited: Promise.resolve(0),
    }));

    const host = createV2Host(tmp);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: `call-root-${expectedKind}`,
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: ".",
    });
    await handler(event);

    expect(spawn, "el hook global debe ejecutarse").toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0]! as [string[], { cwd?: string }];
    expect(command[1], `script resuelto bajo la raíz ${expectedKind}`).toBe(
      path.join(expected, "scripts", `${expectedKind}-marker.cjs`),
    );
    expect(options.cwd, `cwd = raíz global efectiva (${expectedKind})`).toBe(expected);
    expect(contentText(event.result)).toContain(`${expectedKind}-marker`);
  });
});

/**
 * RED de los dos fallos silenciosos de hooks.ts confirmados en el review de
 * ff7a54f:
 *
 * 1. `readHookFile` convierte en `null` cualquier fallo, incluido un hooks.json
 *    existente pero corrupto (`{`) o ilegible (EACCES/EIO/EISDIR), así que el
 *    host lo trata como "sin config" y el fallo desaparece. ENOENT sí es
 *    legítimo y no debe advertir.
 * 2. `scriptDiagnostics` solo añade la identidad/exit del script cuando
 *    stdout y stderr están vacíos; un script con exit ≠ 0 y salida parcial
 *    pierde la identidad del fallo.
 *
 * Se ejecuta el handler `execute.after` real (arnés v2 + stub de Bun) contra
 * hooks.json/scripts reales: el diagnóstico debe verse en el `content` del
 * result completed, sin volcar el contenido crudo del fichero.
 */
describe("OpenCode v2 plugins: config corrupta y script fallido no son silenciosos", () => {
  const CANARY = "HOOKS_JSON_SECRET_CANARY";

  const setupAfterHandler = async (): Promise<HookHandler> => {
    const host = createV2Host(tmp);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);
    return host.registered.get("execute.after")!;
  };

  const runCompleted = async (handler: HookHandler) => {
    const event = completedEvent({
      id: "call-hook-config",
      sessionID: "ses_v2_fixture",
      command: "echo hi",
      workdir: ".",
    }) as Record<string, unknown> & { result: { output: string; content: unknown[] } };
    const original = event.result;
    await handler(event);
    return { event, original };
  };

  it("un hooks.json global malformado se diagnostica sin volcar su contenido", async () => {
    const globalRoot = path.join(tmp, "global-config");
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.writeFileSync(
      path.join(globalRoot, "hooks.json"),
      `{"additionalContext":"${CANARY}"`,
    );
    stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(0) }));

    const text = contentText((await runCompleted(await setupAfterHandler())).event.result);

    expect(text, "el hooks.json corrupto no puede ser silencioso").toMatch(
      /parse|json|invalid|corrupt/i,
    );
    expect(text, "no vuelca el contenido crudo del fichero").not.toContain(CANARY);
  });

  it.each([
    ["EACCES", () => Object.assign(new Error("access denied"), { code: "EACCES" })],
    ["EIO", () => Object.assign(new Error("i/o error"), { code: "EIO" })],
  ])("un hooks.json global ilegible (%s) se diagnostica sin volcar contenido", async (_label, makeError) => {
    const globalRoot = path.join(tmp, "global-config");
    fs.mkdirSync(globalRoot, { recursive: true });
    const hooksPath = path.join(globalRoot, "hooks.json");
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ "tool.execute.after": { shell: { "*": [`scripts/${CANARY}.cjs`] } } }),
    );
    stubHostBunWithFileFailure(hooksPath, makeError());

    const text = contentText((await runCompleted(await setupAfterHandler())).event.result);

    expect(text, "el fallo de lectura no puede ser silencioso").toMatch(
      /read|access|permission|denied|unreadable|i\/o|erro?r/i,
    );
    expect(text, "no vuelca el contenido del fichero").not.toContain(CANARY);
  });

  it("un hooks.json global ilegible por ser directorio (EISDIR) se diagnostica", async () => {
    const globalRoot = path.join(tmp, "global-config");
    fs.mkdirSync(path.join(globalRoot, "hooks.json"), { recursive: true });
    stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(0) }));

    const text = contentText((await runCompleted(await setupAfterHandler())).event.result);

    expect(text, "el EISDIR no puede ser silencioso").toMatch(
      /read|access|unreadable|directory|eisdir|erro?r/i,
    );
  });

  it("un hooks.json global ausente (ENOENT) es legítimo y no añade diagnóstico", async () => {
    stubHostBun(() => ({ stdout: "", stderr: "", exited: Promise.resolve(0) }));
    const { event, original } = await runCompleted(await setupAfterHandler());

    expect(event.result, "sin diagnóstico no se reemplaza el resultado").toBe(original);
  });

  it("hooks: un script con exit no cero lleva identidad/exit aunque stdout y stderr no estén vacíos", async () => {
    const sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeHooks(sessionDir, outputHookConfig("partial-fail.cjs"));
    writeScript(sessionDir, "partial-fail.cjs", "process.exit(3);\n");

    const spawn = stubHostBun(() => ({
      stdout: JSON.stringify({ additionalContext: "PARTIAL_STDOUT" }),
      stderr: "partial stderr",
      exited: Promise.resolve(3),
    }));

    const host = createV2Host(sessionDir);
    const plugin = pluginOf(hooksModule)!;
    await plugin.setup(host.ctx);

    const handler = host.registered.get("execute.after")!;
    const event = completedEvent({
      id: "call-partial-exit3",
      sessionID: host.sessionID,
      command: "echo hi",
      workdir: ".",
    }) as Record<string, unknown> & { result: { output: string; content: unknown[] } };

    await handler(event);

    expect(spawn).toHaveBeenCalledOnce();
    const text = contentText(event.result);
    expect(text, "stdout parcial preservado").toContain("PARTIAL_STDOUT");
    expect(text, "stderr parcial preservado").toContain("partial stderr");
    expect(text, "identidad del script siempre presente").toContain("partial-fail.cjs");
    expect(text, "exit explícito siempre presente").toMatch(/(exit|code|código)[^\d]{0,12}3/i);
    expect(String(event.result.output), "output original preservado").toContain("original output");
  });
});
