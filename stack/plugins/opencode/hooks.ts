import { existsSync } from "node:fs";
import path from "node:path";

interface HookConfig {
  [event: string]: unknown;
}

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  script: string;
  scriptPath: string;
}

const CONFIG_EVENTS = {
  before: "tool.execute.before",
  after: "tool.execute.after",
} as const;

type ConfigEvent = (typeof CONFIG_EVENTS)[keyof typeof CONFIG_EVENTS];

// El host v2 llama `shell` a la herramienta que en v1 se llamaba `bash`. El
// hooks.json del puente conserva las claves históricas, así que la traducción
// vive solo aquí.
const SHELL_TOOLS = new Set(["shell", "bash"]);

const isAbsolutePath = (value: string) =>
  /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/");

const joinProjectPath = (directory: string, script: string) => {
  const normalizedDirectory = directory.replace(/[\\/]+$/, "");
  const normalizedScript = script.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return `${normalizedDirectory}/${normalizedScript}`;
};

// Resolve the user-level OpenCode config directory (cross-platform).
const getGlobalConfigDir = (): string => {
  const explicit = process.env.OPENCODE_CONFIG_DIR;
  if (explicit) return explicit.replace(/[\\/]+$/, "");

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return `${xdg.replace(/[\\/]+$/, "")}/opencode`;

  const home =
    process.env.HOME ||
    process.env.USERPROFILE ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : "");

  if (!home) return "";
  return `${home.replace(/[\\/]+$/, "")}/.config/opencode`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const valueType = (value: unknown) => {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
};

const configToolName = (tool: unknown): string => {
  const value = String(tool ?? "").toLowerCase();
  return SHELL_TOOLS.has(value) ? "bash" : value;
};

const commandText = (command: unknown): string => {
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" ? command : "";
};

// El cwd del plugin/servidor es compartido y no representa la sesión. El
// directorio de trabajo sale del evento: `session.location.directory` más el
// `input.workdir` relativo (o absoluto).
const resolveSessionDirectory = async (
  ctx: any,
  sessionID: unknown,
): Promise<string | undefined> => {
  if (!ctx?.session || typeof ctx.session.get !== "function") return undefined;
  if (typeof sessionID !== "string" || !sessionID) return undefined;
  try {
    const session = await ctx.session.get({ sessionID });
    const directory = session?.location?.directory;
    return typeof directory === "string" && directory ? directory : undefined;
  } catch {
    return undefined;
  }
};

const resolveEventDirectory = async (
  ctx: any,
  event: any,
): Promise<string | undefined> => {
  const base = await resolveSessionDirectory(ctx, event?.sessionID);
  const workdir = event?.input?.workdir;
  if (typeof workdir === "string" && workdir) {
    if (isAbsolutePath(workdir)) return workdir;
    return base ? path.resolve(base, workdir) : undefined;
  }
  return base;
};

const buildScriptEnv = (scriptPath: string) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string",
    ),
  );

  // Ensure Git coreutils (cat, grep, head, dirname, etc.) are in PATH for .sh
  // scripts. Windows-only: rutas de Git-for-Windows y ";" es el separador de
  // PATH de Windows (en POSIX es ":" y esto corrompería el PATH).
  if (scriptPath.endsWith(".sh") && process.platform === "win32") {
    const gitUsrBin = "C:/Program Files/Git/usr/bin";
    const gitBin = "C:/Program Files/Git/bin";
    const currentPath = process.env.PATH || "";
    env.PATH = `${gitUsrBin};${gitBin};${currentPath}`;
  }

  return env;
};

const runScript = async (
  directory: string,
  script: string,
  payload?: unknown,
): Promise<ScriptResult> => {
  // Scripts may be tagged as `<baseDir>\u0000<script>` so each is resolved
  // against the config that declared it (global vs project). Untagged scripts
  // fall back to the runtime directory.
  let baseDir = directory;
  let rawScript = script;
  const sep = script.indexOf("\u0000");
  if (sep !== -1) {
    baseDir = script.slice(0, sep) || directory;
    rawScript = script.slice(sep + 1);
  }

  const scriptPath = isAbsolutePath(rawScript)
    ? rawScript
    : joinProjectPath(baseDir, rawScript);
  const cwd = baseDir;
  const stdin = payload ? JSON.stringify(payload) : "";
  const stdinSource = new Response(stdin);

  let command: string[] | null = null;

  // Resolve bash path: Bun's spawned process may not inherit Git Bash in PATH on Windows
  const resolveBash = (): string => {
    const candidates = [
      "C:/Program Files/Git/usr/bin/bash.exe",
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/usr/bin/bash.exe",
      process.env.BASH_PATH,
      "bash",
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* skip */
      }
    }
    return "bash"; // fallback
  };

  if (scriptPath.endsWith(".ps1")) {
    command = [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ];
  } else if (scriptPath.endsWith(".sh")) {
    command = [resolveBash(), scriptPath];
  } else if (
    scriptPath.endsWith(".cjs") ||
    scriptPath.endsWith(".js") ||
    scriptPath.endsWith(".mjs")
  ) {
    command = ["node", scriptPath];
  }

  if (!command) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unsupported hook script extension: ${scriptPath}`,
      script,
      scriptPath,
    };
  }

  try {
    const spawnEnv = buildScriptEnv(scriptPath);
    const proc = (globalThis as any).Bun.spawn(command, {
      stdin: stdinSource,
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: spawnEnv,
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr, script, scriptPath };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      script,
      scriptPath,
    };
  }
};

const extractScriptMessage = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.additionalContext === "string") {
      return parsed.additionalContext;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
};

// A failed script with no output would be a silent no-op. The diagnostic keeps
// it actionable without inventing a logger the v2 host does not expose.
const scriptDiagnostics = (result: ScriptResult): string[] => {
  const messages: string[] = [];
  const stdoutMessage = extractScriptMessage(result.stdout);
  const stderrMessage = extractScriptMessage(result.stderr);
  if (stdoutMessage) messages.push(stdoutMessage);
  if (stderrMessage) messages.push(stderrMessage);
  // Un exit no cero nunca es silencioso: la identidad y el código van siempre,
  // incluso cuando stdout/stderr traen salida parcial.
  if (result.exitCode !== 0) {
    messages.push(
      `Hook script failed: ${result.scriptPath} (exit code ${result.exitCode}).`,
    );
  }
  return messages;
};

// v2 entrega `result.content` como array readonly. Se reemplaza el objeto
// entero (nunca se muta el original) conservando output/metadata y anexando el
// aviso como bloque de texto.
const appendToResult = (event: any, messages: string[]) => {
  const result = event?.result;
  if (!result || typeof result !== "object" || messages.length === 0) return;
  const section = messages.join("\n\n");
  const current = result.content;
  const base = Array.isArray(current)
    ? current
    : typeof current === "string" && current
      ? [{ type: "text", text: current }]
      : [];
  event.result = {
    ...result,
    content: [...base, { type: "text", text: `\n\n${section}` }],
  };
};

const buildHookPayload = (
  directory: string,
  event: ConfigEvent,
  tool: unknown,
  input: unknown,
) => {
  const args: Record<string, unknown> = {};
  if (isPlainObject(input)) {
    if ("command" in input) args.command = input.command;
    if ("workdir" in input) args.workdir = input.workdir;
  }
  return { event, directory, tool: configToolName(tool), args };
};

type HookFileResult =
  | { status: "missing" }
  | { status: "loaded"; config: HookConfig }
  | { status: "invalid"; reason: string };

const isMissingFileError = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  // Ausencia solo con código ENOENT. El mensaje del sistema puede contener
  // "not found" en la propia ruta (p. ej. un EACCES sobre `.../not found/`),
  // así que el texto no es prueba de ausencia: sin código fiable se
  // diagnostica, nunca se silencia.
  return code === "ENOENT";
};

const errorCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && code ? code : "error";
};

// Un hooks.json ausente (ENOENT) es legítimo y no se diagnostica. Un fichero
// existente pero corrupto o ilegible (EACCES/EIO/EISDIR) sí: se distingue el
// fallo de lectura del de parseo y no se vuelca ni su contenido ni el mensaje
// crudo del sistema.
const readHookFile = async (configPath: string): Promise<HookFileResult> => {
  let content: string;
  try {
    content = await (globalThis as any).Bun.file(configPath).text();
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    return { status: "invalid", reason: `could not be read (${errorCode(error)})` };
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) {
      return { status: "invalid", reason: "must be a JSON object" };
    }
    return { status: "loaded", config: parsed };
  } catch {
    return { status: "invalid", reason: "could not be parsed as JSON" };
  }
};

// Merge two hook configs. Scripts from both are concatenated per event/tool/trigger.
// Global scripts are resolved against the global config dir; project scripts against the project.
const mergeHookConfigs = (base: HookConfig, incoming: HookConfig): HookConfig => {
  const result: HookConfig = { ...base };

  for (const [event, eventValue] of Object.entries(incoming)) {
    if (!isPlainObject(eventValue)) {
      if (result[event] === undefined) result[event] = eventValue;
      continue;
    }

    const baseEvent = isPlainObject(result[event])
      ? { ...(result[event] as Record<string, unknown>) }
      : {};

    for (const [tool, toolValue] of Object.entries(eventValue)) {
      const baseTool = baseEvent[tool];

      if (isStringArray(toolValue)) {
        baseEvent[tool] = isStringArray(baseTool)
          ? [...baseTool, ...toolValue]
          : [...toolValue];
        continue;
      }

      if (isPlainObject(toolValue)) {
        const mergedTriggers: Record<string, unknown> = isPlainObject(baseTool)
          ? { ...(baseTool as Record<string, unknown>) }
          : {};
        for (const [trigger, scripts] of Object.entries(toolValue)) {
          const existing = mergedTriggers[trigger];
          if (isStringArray(scripts)) {
            mergedTriggers[trigger] = isStringArray(existing)
              ? [...existing, ...scripts]
              : [...scripts];
          } else if (mergedTriggers[trigger] === undefined) {
            mergedTriggers[trigger] = scripts;
          }
        }
        baseEvent[tool] = mergedTriggers;
        continue;
      }

      if (baseEvent[tool] === undefined) baseEvent[tool] = toolValue;
    }

    result[event] = baseEvent;
  }

  return result;
};

// Tag every script path with the base directory it must be resolved against.
// Global scripts use the global config dir; project scripts use the project dir.
const tagScriptsWithBase = (config: HookConfig, baseDir: string): HookConfig => {
  const tagList = (scripts: string[]) => scripts.map((s) => `${baseDir}\u0000${s}`);

  const result: HookConfig = {};
  for (const [event, eventValue] of Object.entries(config)) {
    if (!isPlainObject(eventValue)) {
      result[event] = eventValue;
      continue;
    }
    const newEvent: Record<string, unknown> = {};
    for (const [tool, toolValue] of Object.entries(eventValue)) {
      if (isStringArray(toolValue)) {
        newEvent[tool] = tagList(toolValue);
      } else if (isPlainObject(toolValue)) {
        const newTriggers: Record<string, unknown> = {};
        for (const [trigger, scripts] of Object.entries(toolValue)) {
          newTriggers[trigger] = isStringArray(scripts)
            ? tagList(scripts)
            : scripts;
        }
        newEvent[tool] = newTriggers;
      } else {
        newEvent[tool] = toolValue;
      }
    }
    result[event] = newEvent;
  }
  return result;
};

const loadConfig = async (
  directory: string,
  globalConfigDir: string,
): Promise<{ config: HookConfig; diagnostics: string[] }> => {
  const diagnostics: string[] = [];

  // Project-level hooks: prefer the runtime directory, fall back to the plugin directory.
  let projectConfig: HookConfig = {};
  let projectBase = directory;

  const projectResult = await readHookFile(`${directory}/.opencode/hooks.json`);
  if (projectResult.status === "loaded") {
    projectConfig = projectResult.config;
    projectBase = directory;
  } else if (projectResult.status === "invalid") {
    diagnostics.push(`Project hooks config ignored: ${projectResult.reason}.`);
  }
  projectConfig = tagScriptsWithBase(projectConfig, projectBase);

  // Global user-level hooks (~/.config/opencode/hooks.json).
  let globalConfig: HookConfig = {};
  if (globalConfigDir) {
    const globalResult = await readHookFile(`${globalConfigDir}/hooks.json`);
    if (globalResult.status === "loaded") {
      globalConfig = tagScriptsWithBase(globalResult.config, globalConfigDir);
    } else if (globalResult.status === "invalid") {
      diagnostics.push(`Global hooks config ignored: ${globalResult.reason}.`);
    }
  }

  // Global first, then project (the project can add more scripts on top).
  return {
    config: mergeHookConfigs(globalConfig, projectConfig),
    diagnostics,
  };
};

const getEventConfig = (
  config: HookConfig,
  event: ConfigEvent,
  warnings: string[],
): Record<string, unknown> => {
  const eventConfig = config[event];
  if (eventConfig === undefined) return {};
  if (isPlainObject(eventConfig)) return eventConfig;

  warnings.push(
    `Invalid hook config ignored: ${event} must be an object (got ${valueType(eventConfig)}).`,
  );
  return {};
};

const getToolScripts = (
  config: HookConfig,
  event: ConfigEvent,
  tool: string,
  warnings: string[],
): string[] => {
  const eventConfig = getEventConfig(config, event, warnings);
  const value = eventConfig[tool];
  if (value === undefined) return [];

  if (isStringArray(value)) return value;

  if (tool === "bash" && isPlainObject(value)) {
    return [];
  }

  warnings.push(
    `Invalid hook config ignored: ${event}.${tool} must be an array of script paths (got ${valueType(value)}).`,
  );
  return [];
};

const getBashTriggerScripts = (
  config: HookConfig,
  event: ConfigEvent,
  command: string,
  warnings: string[],
): string[] => {
  const eventConfig = getEventConfig(config, event, warnings);
  const value = eventConfig["bash"];
  if (value === undefined || isStringArray(value)) return [];

  const normalizedCommand = (command || "").toLowerCase();

  if (!isPlainObject(value)) {
    warnings.push(
      `Invalid hook config ignored: ${event}.bash must be an array or trigger map (got ${valueType(value)}).`,
    );
    return [];
  }

  const scripts: string[] = [];
  for (const [trigger, triggerScripts] of Object.entries(value)) {
    if (!isStringArray(triggerScripts)) {
      warnings.push(
        `Invalid hook config ignored: ${event}.bash.${trigger} must be an array of script paths (got ${valueType(triggerScripts)}).`,
      );
      continue;
    }

    const normalizedTrigger = trigger.toLowerCase();
    if (trigger === "*" || normalizedCommand.includes(normalizedTrigger)) {
      scripts.push(...triggerScripts);
    }
  }

  return scripts;
};

const runScriptsForMessages = async (
  directory: string,
  scripts: string[],
  payload: unknown,
): Promise<string[]> => {
  const messages: string[] = [];
  for (const script of scripts) {
    const result = await runScript(directory, script, payload);
    messages.push(...scriptDiagnostics(result));
  }
  return messages;
};

const runScriptsForFailures = async (
  directory: string,
  scripts: string[],
  payload: unknown,
): Promise<string[]> => {
  const failures: string[] = [];
  for (const script of scripts) {
    const result = await runScript(directory, script, payload);
    if (result.exitCode !== 0) failures.push(...scriptDiagnostics(result));
  }
  return failures;
};

const resolveScripts = (
  config: HookConfig,
  event: ConfigEvent,
  tool: string,
  command: string,
  warnings: string[],
): string[] => [
  ...getToolScripts(config, event, tool, warnings),
  ...(tool === "bash" ? getBashTriggerScripts(config, event, command, warnings) : []),
  ...getToolScripts(config, event, "*", warnings),
];

export default {
  id: "stack-hooks",

  async setup(ctx: any) {
    const globalConfigDir = getGlobalConfigDir();
    // Un hook `before` que falla no puede bloquear la herramienta, pero tampoco
    // desaparecer: se guarda por llamada y se diagnostica en el `after`.
    const pendingFailures = new Map<string, string[]>();

    const handleBefore = async (event: any) => {
      try {
        const directory = await resolveEventDirectory(ctx, event);
        if (!directory) return;
        const { config, diagnostics } = await loadConfig(directory, globalConfigDir);
        const warnings: string[] = [...diagnostics];
        const tool = configToolName(event?.tool);
        const payload = buildHookPayload(
          directory,
          CONFIG_EVENTS.before,
          event?.tool,
          event?.input,
        );
        const scripts = resolveScripts(
          config,
          CONFIG_EVENTS.before,
          tool,
          commandText(event?.input?.command),
          warnings,
        );
        const failures = await runScriptsForFailures(directory, scripts, payload);
        if (warnings.length > 0) failures.push(...warnings);
        const id = typeof event?.id === "string" ? event.id : "";
        if (id && failures.length > 0) pendingFailures.set(id, failures);
      } catch {
        // fail-open: un guardarraíl nunca bloquea la herramienta que vigila.
      }
    };

    const handleAfter = async (event: any) => {
      try {
        const id = typeof event?.id === "string" ? event.id : "";
        const pending = id ? pendingFailures.get(id) : undefined;
        if (id) pendingFailures.delete(id);

        const directory = await resolveEventDirectory(ctx, event);
        if (!directory) {
          if (pending) appendToResult(event, pending);
          return;
        }

        const { config, diagnostics } = await loadConfig(directory, globalConfigDir);
        const warnings: string[] = [...diagnostics];
        const tool = configToolName(event?.tool);
        const payload = buildHookPayload(
          directory,
          CONFIG_EVENTS.after,
          event?.tool,
          event?.input,
        );
        const scripts = resolveScripts(
          config,
          CONFIG_EVENTS.after,
          tool,
          commandText(event?.input?.command),
          warnings,
        );
        const messages = await runScriptsForMessages(directory, scripts, payload);

        appendToResult(event, [...(pending ?? []), ...warnings, ...messages]);
      } catch {
        // fail-open: sin log en v2, el propio resultado de la herramienta es el
        // único canal; un fallo aquí no puede romper ni bloquear el shell.
      }
    };

    await ctx.tool.hook("execute.before", handleBefore);
    await ctx.tool.hook("execute.after", handleAfter);
  },
};
