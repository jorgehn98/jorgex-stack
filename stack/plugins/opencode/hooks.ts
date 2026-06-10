import type { Plugin } from "@opencode-ai/plugin";

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

type EventName =
  | "session.created"
  | "server.connected"
  | "tool.execute.before"
  | "tool.execute.after";

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

  const home =
    process.env.HOME ||
    process.env.USERPROFILE ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : "");

  if (!home) return "";
  return `${home.replace(/[\\/]+$/, "")}/.config/opencode`;
};

const runScript = async (
  client: any,
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
    const fs = require("fs");
    const candidates = [
      "C:/Program Files/Git/usr/bin/bash.exe",
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/usr/bin/bash.exe",
      process.env.BASH_PATH,
      "bash",
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
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
    await client.app.log({
      body: {
        service: "hooks",
        level: "warn",
        message: "Unsupported hook script extension",
        extra: { script, scriptPath },
      },
    });
    return { exitCode: 0, stdout: "", stderr: "", script, scriptPath };
  }

  try {
    const activeWorktreePath = getPayloadWorktreePath(payload);
    const spawnEnv = buildScriptEnv(scriptPath, activeWorktreePath);

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

    if (exitCode !== 0) {
      await client.app.log({
        body: {
          service: "hooks",
          level: "error",
          message: "Hook script execution failed",
          extra: {
            script,
            scriptPath,
            exitCode,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
          },
        },
      });
    }

    return { exitCode, stdout, stderr, script, scriptPath };
  } catch (error) {
    await client.app.log({
      body: {
        service: "hooks",
        level: "error",
        message: "Hook script execution failed",
        extra: {
          script,
          scriptPath,
          error: error instanceof Error ? error.message : String(error),
        },
      },
    });
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

const appendToolOutput = (output: any, messages: string[]) => {
  if (messages.length === 0) return;
  const section = messages.join("\n\n");
  // Built-in tools (bash, edit, read, write) use output.output (string)
  // MCP tools (github_*, supabase_*) use output.content (array of content blocks)
  if ("output" in output && typeof output.output === "string") {
    output.output = output.output ? `${output.output}\n\n${section}` : section;
  } else if ("content" in output && Array.isArray(output.content)) {
    // MCP content blocks: [{type: "text", text: "..."}]
    output.content.push({ type: "text", text: `\n\n${section}` });
  } else if ("content" in output && typeof output.content === "string") {
    output.content = output.content
      ? `${output.content}\n\n${section}`
      : section;
  } else {
    // Fallback: set output as string
    output.output = section;
  }
};

const buildHookPayload = (
  directory: string,
  event: EventName,
  input?: any,
  activeWorktreePath?: string,
) => {
  const args = input?.args || {};
  const worktreePath = args.activeWorktreePath || args.worktreePath || activeWorktreePath;

  return {
    event,
    directory,
    activeWorktreePath: worktreePath,
    worktreePath,
    tool: input?.tool,
    args: worktreePath
      ? {
          ...args,
          activeWorktreePath: worktreePath,
          worktreePath,
        }
      : args,
  };
};

const getRuntimeContext = async (
  client: any,
  fallbackDirectory: string,
  fallbackWorktreePath?: string,
) => {
  try {
    const pathInfo = await client.path.get();
    const runtimeWorktreePath =
      typeof pathInfo?.worktree === "string" && pathInfo.worktree
        ? pathInfo.worktree
        : fallbackWorktreePath;
    const runtimeDirectory =
      runtimeWorktreePath ||
      (typeof pathInfo?.directory === "string" && pathInfo.directory
        ? pathInfo.directory
        : fallbackDirectory);

    return {
      directory: runtimeDirectory,
      activeWorktreePath: runtimeWorktreePath,
    };
  } catch {
    return {
      directory: fallbackDirectory,
      activeWorktreePath: fallbackWorktreePath,
    };
  }
};

const getPayloadWorktreePath = (payload: unknown) => {
  if (!isPlainObject(payload)) return undefined;

  const topLevel = payload.activeWorktreePath || payload.worktreePath;
  if (typeof topLevel === "string" && topLevel) return topLevel;

  const args = payload.args;
  if (!isPlainObject(args)) return undefined;

  const argPath = args.activeWorktreePath || args.worktreePath;
  return typeof argPath === "string" && argPath ? argPath : undefined;
};

const buildScriptEnv = (scriptPath: string, activeWorktreePath?: string) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string",
    ),
  );

  if (activeWorktreePath) {
    env.OPENCODE_WORKTREE_PATH = activeWorktreePath;
  } else {
    delete env.OPENCODE_WORKTREE_PATH;
  }

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

const normalizeWorktreePath = (worktree: unknown) => {
  if (typeof worktree === "string" && worktree) return worktree;

  if (!isPlainObject(worktree)) return undefined;

  const candidate = worktree.path || worktree.root || worktree.directory;
  return typeof candidate === "string" && candidate ? candidate : undefined;
};

const valueType = (value: unknown) => {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const logInvalidHookConfig = async (
  client: any,
  details: {
    event: EventName;
    tool?: string;
    trigger?: string;
    value: unknown;
    reason: string;
  },
) => {
  await client.app.log({
    body: {
      service: "hooks",
      level: "warn",
      message: "Invalid hook config ignored",
      extra: {
        event: details.event,
        tool: details.tool,
        trigger: details.trigger,
        reason: details.reason,
        valueType: valueType(details.value),
      },
    },
  });
};

const getEventConfig = async (
  client: any,
  config: HookConfig,
  event: EventName,
): Promise<Record<string, unknown>> => {
  const eventConfig = config[event];
  if (eventConfig === undefined) return {};
  if (isPlainObject(eventConfig)) return eventConfig;

  await logInvalidHookConfig(client, {
    event,
    value: eventConfig,
    reason: "event config must be an object",
  });
  return {};
};

const getToolScripts = async (
  client: any,
  config: HookConfig,
  event: EventName,
  tool: string,
): Promise<string[]> => {
  const eventConfig = await getEventConfig(client, config, event);
  const value = eventConfig[tool];
  if (value === undefined) return [];

  if (isStringArray(value)) return value;

  if (tool === "bash" && isPlainObject(value)) {
    return [];
  }

  await logInvalidHookConfig(client, {
    event,
    tool,
    value,
    reason: "tool entry must be an array of script paths",
  });
  return [];
};

const getBashTriggerScripts = async (
  client: any,
  config: HookConfig,
  event: EventName,
  command: string,
): Promise<string[]> => {
  const eventConfig = await getEventConfig(client, config, event);
  const value = eventConfig["bash"];
  if (value === undefined || isStringArray(value)) return [];

  const normalizedCommand = (command || "").toLowerCase();

  if (!isPlainObject(value)) {
    await logInvalidHookConfig(client, {
      event,
      tool: "bash",
      value,
      reason: "bash entry must be an array or trigger map",
    });
    return [];
  }

  const scripts: string[] = [];
  for (const [trigger, triggerScripts] of Object.entries(value)) {
    if (!isStringArray(triggerScripts)) {
      await logInvalidHookConfig(client, {
        event,
        tool: "bash",
        trigger,
        value: triggerScripts,
        reason: "bash trigger entry must be an array of script paths",
      });
      continue;
    }

    const normalizedTrigger = trigger.toLowerCase();
    if (trigger === "*" || normalizedCommand.includes(normalizedTrigger)) {
      scripts.push(...triggerScripts);
    }
  }

  return scripts;
};

const runScriptsAndCollectMessages = async (
  client: any,
  directory: string,
  scripts: string[],
  payload: unknown,
): Promise<string[]> => {
  const messages: string[] = [];
  for (const script of scripts) {
    const result = await runScript(client, directory, script, payload);
    const stdoutMessage = extractScriptMessage(result.stdout);
    const stderrMessage = extractScriptMessage(result.stderr);
    if (stdoutMessage) messages.push(stdoutMessage);
    if (stderrMessage) messages.push(stderrMessage);
  }
  return messages;
};

const runScripts = async (
  client: any,
  directory: string,
  scripts: string[],
  payload: unknown,
) => {
  for (const script of scripts) {
    await runScript(client, directory, script, payload);
  }
};

export const HooksPlugin: Plugin = async ({ client, directory, worktree }) => {
  const initialWorktreePath = normalizeWorktreePath(worktree);

  const globalConfigDir = getGlobalConfigDir();

  const readHookFile = async (configPath: string): Promise<HookConfig | null> => {
    try {
      const content = await (globalThis as any).Bun.file(configPath).text();
      return JSON.parse(content);
    } catch (error) {
      // Los errores de fs exponen code, no name: sin esto, cada proyecto sin
      // hooks.json loguearía un warning espurio.
      const code = (error as { code?: string })?.code;
      if (error instanceof Error && error.name !== "ENOENT" && code !== "ENOENT") {
        await client.app.log({
          body: {
            service: "hooks",
            level: "warn",
            message: "Failed to load hooks config",
            extra: { configPath, error: error.message },
          },
        });
      }
      return null;
    }
  };

  // Merge two hook configs. Scripts from both are concatenated per event/tool/trigger.
  // Global scripts are resolved against the global config dir; project scripts against the project.
  const mergeHookConfigs = (
    base: HookConfig,
    incoming: HookConfig,
  ): HookConfig => {
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
    const tagList = (scripts: string[]) =>
      scripts.map((s) => `${baseDir}\u0000${s}`);

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

  const loadConfig = async (configDirectory = directory): Promise<HookConfig> => {
    // Project-level hooks: prefer the runtime directory, fall back to the plugin directory.
    let projectConfig: HookConfig = {};
    let projectBase = configDirectory;

    const runtimeConfig = await readHookFile(
      `${configDirectory}/.opencode/hooks.json`,
    );
    if (runtimeConfig) {
      projectConfig = runtimeConfig;
      projectBase = configDirectory;
    } else if (configDirectory !== directory) {
      const fallbackConfig = await readHookFile(
        `${directory}/.opencode/hooks.json`,
      );
      if (fallbackConfig) {
        projectConfig = fallbackConfig;
        projectBase = directory;
      }
    }
    projectConfig = tagScriptsWithBase(projectConfig, projectBase);

    // Global user-level hooks (~/.config/opencode/hooks.json).
    let globalConfig: HookConfig = {};
    if (globalConfigDir) {
      const raw = await readHookFile(`${globalConfigDir}/hooks.json`);
      if (raw) globalConfig = tagScriptsWithBase(raw, globalConfigDir);
    }

    // Global first, then project (the project can add more scripts on top).
    return mergeHookConfigs(globalConfig, projectConfig);
  };

  return {
    "session.created": async () => {
      const config = await loadConfig();
      const scripts = await getToolScripts(
        client,
        config,
        "session.created",
        "*",
      );
      await runScripts(client, directory, scripts, {
        event: "session.created",
        directory,
        activeWorktreePath: initialWorktreePath,
        worktreePath: initialWorktreePath,
      });
    },

    "server.connected": async () => {
      const config = await loadConfig();
      const scripts = await getToolScripts(
        client,
        config,
        "server.connected",
        "*",
      );
      const fallbackScripts =
        scripts.length === 0
          ? await getToolScripts(client, config, "session.created", "*")
          : [];
      await runScripts(client, directory, scripts, {
        event: "server.connected",
        directory,
        activeWorktreePath: initialWorktreePath,
        worktreePath: initialWorktreePath,
      });
      await runScripts(client, directory, fallbackScripts, {
        event: "server.connected",
        directory,
        activeWorktreePath: initialWorktreePath,
        worktreePath: initialWorktreePath,
      });
    },

    "tool.execute.after": async (input: any, output: any) => {
      const runtime = await getRuntimeContext(client, directory, initialWorktreePath);
      const config = await loadConfig(runtime.directory);
      const tool = (input.tool || "").toLowerCase();
      const args = input.args || {};
      const command = args.command || "";
      const payload = buildHookPayload(
        runtime.directory,
        "tool.execute.after",
        input,
        runtime.activeWorktreePath,
      );
      const messages: string[] = [];

      const toolScripts = await getToolScripts(
        client,
        config,
        "tool.execute.after",
        tool,
      );
      messages.push(
        ...(await runScriptsAndCollectMessages(
          client,
          runtime.directory,
          toolScripts,
          payload,
        )),
      );

      if (tool === "bash") {
        const bashTriggerScripts = await getBashTriggerScripts(
          client,
          config,
          "tool.execute.after",
          command,
        );
        messages.push(
          ...(await runScriptsAndCollectMessages(
            client,
            runtime.directory,
            bashTriggerScripts,
            payload,
          )),
        );
      }

      const wildcardScripts = await getToolScripts(
        client,
        config,
        "tool.execute.after",
        "*",
      );
      messages.push(
        ...(await runScriptsAndCollectMessages(
          client,
          runtime.directory,
          wildcardScripts,
          payload,
        )),
      );

      appendToolOutput(output, messages);
    },

    "tool.execute.before": async (input: any) => {
      const runtime = await getRuntimeContext(client, directory, initialWorktreePath);
      const config = await loadConfig(runtime.directory);
      const tool = (input.tool || "").toLowerCase();
      const args = input.args || {};
      const command = args.command || "";
      const payload = buildHookPayload(
        runtime.directory,
        "tool.execute.before",
        input,
        runtime.activeWorktreePath,
      );

      const toolScripts = await getToolScripts(
        client,
        config,
        "tool.execute.before",
        tool,
      );
      await runScripts(client, runtime.directory, toolScripts, payload);

      if (tool === "bash") {
        const bashTriggerScripts = await getBashTriggerScripts(
          client,
          config,
          "tool.execute.before",
          command,
        );
        await runScripts(client, runtime.directory, bashTriggerScripts, payload);
      }

      const wildcardScripts = await getToolScripts(
        client,
        config,
        "tool.execute.before",
        "*",
      );
      await runScripts(client, runtime.directory, wildcardScripts, payload);
    },
  };
};
