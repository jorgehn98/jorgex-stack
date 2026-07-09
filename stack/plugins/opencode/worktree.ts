import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";

interface WorktreePluginConfig {
  setupScript?: string;
  docsReminderScript?: string;
  pathContains?: string;
  reminderLines?: string[];
}

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  script: string;
  scriptPath: string;
}

const isAbsolutePath = (value: string) =>
  /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/");

const isWindowsPath = (value: string) => /^[a-zA-Z]:[\\/]/.test(value);

const toSlashes = (value: string) => value.replace(/\\/g, "/");

const joinProjectPath = (directory: string, target: string) => {
  const normalizedDirectory = toSlashes(directory).replace(/[\\/]+$/, "");
  const normalizedTarget = toSlashes(target).replace(/^[\\/]+/, "");
  return `${normalizedDirectory}/${normalizedTarget}`;
};

const resolvePath = (base: string, target: string) => {
  const api = isWindowsPath(base) || isWindowsPath(target) ? path.win32 : path.posix;
  const resolved = api.resolve(base, target);
  return toSlashes(resolved);
};

const resolveProjectPath = (directory: string, target?: string) => {
  if (!target) return undefined;
  return isAbsolutePath(target) ? target : joinProjectPath(directory, target);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

  // Windows-only: rutas de Git-for-Windows y ";" como separador de PATH.
  if (scriptPath.endsWith(".sh") && process.platform === "win32") {
    const gitUsrBin = "C:/Program Files/Git/usr/bin";
    const gitBin = "C:/Program Files/Git/bin";
    const currentPath = process.env.PATH || "";
    env.PATH = `${gitUsrBin};${gitBin};${currentPath}`;
  }

  return env;
};

interface RunScriptOptions {
  payload?: unknown;
  commandArgs?: string[];
  activeWorktreePath?: string;
}

const runScript = async (
  client: any,
  directory: string,
  script: string,
  options?: RunScriptOptions,
): Promise<ScriptResult> => {
  const payload = options?.payload;
  const scriptPath = isAbsolutePath(script)
    ? script
    : joinProjectPath(directory, script);
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
      ...(options?.commandArgs || []),
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
        message: "Unsupported worktree hook script extension",
        extra: { script, scriptPath },
      },
    });
    return { exitCode: 0, stdout: "", stderr: "", script, scriptPath };
  }

  try {
    const activeWorktreePath =
      options?.activeWorktreePath || getPayloadWorktreePath(payload);
    const spawnEnv = buildScriptEnv(scriptPath, activeWorktreePath);

    const proc = (globalThis as any).Bun.spawn(command, {
      stdin: stdinSource,
      stdout: "pipe",
      stderr: "pipe",
      cwd: directory,
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
          message: "Worktree hook script execution failed",
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
        message: "Worktree hook script execution failed",
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
  if (!output || messages.length === 0) return;
  const section = messages.join("\n\n");
  // Built-in tools (bash, edit, read, write) use output.output (string)
  // MCP tools (github_*, supabase_*) use output.content (array of content blocks)
  if ("output" in output && typeof output.output === "string") {
    output.output = output.output ? `${output.output}\n\n${section}` : section;
  } else if ("content" in output && Array.isArray(output.content)) {
    output.content.push({ type: "text", text: `\n\n${section}` });
  } else if ("content" in output && typeof output.content === "string") {
    output.content = output.content
      ? `${output.content}\n\n${section}`
      : section;
  } else {
    output.output = section;
    output.content = section;
  }
};

const truncateMessage = (value: string, maxLength = 1200) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...`;
};

const parseWorktreePath = (command: string) => {
  const match = command.match(
    /git\s+worktree\s+add\s+(?:-[^\s]+\s+)*(?:-b\s+[^\s]+\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i,
  );
  return match?.[1] || match?.[2] || match?.[3] || null;
};

const getWorktreeName = (worktreePath: string) => {
  const segments = toSlashes(worktreePath).split("/").filter(Boolean);
  return segments[segments.length - 1] || null;
};

const normalizePath = (value: string) =>
  toSlashes(value).replace(/\/+$/, "");

const samePath = (left: string, right: string) => {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (isWindowsPath(normalizedLeft) || isWindowsPath(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
};

const getCommandCwd = (args: Record<string, unknown>, directory: string) => {
  const cwd = args.workdir || args.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return directory;
  return isAbsolutePath(cwd) ? cwd : resolvePath(directory, cwd);
};

const replaceToken = (value: string, token: string, replacement: string) =>
  value.split(token).join(replacement);

export const WorktreePlugin: Plugin = async ({ $, client, directory }) => {
  let config: WorktreePluginConfig = {
    setupScript: "scripts/setup-worktree.ps1",
    pathContains: "worktrees/",
    reminderLines: [],
  };

  try {
    const configPath = `${directory}/.opencode/worktree.json`;
    const content = await (globalThis as any).Bun.file(configPath).text();
    config = {
      ...config,
      ...JSON.parse(content),
    };
  } catch {
    // Optional project config
  }

  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const tool = (input.tool || "").toLowerCase();
        const payload = {
          event: "tool.execute.after",
          directory,
          tool: input.tool,
          args: input.args || {},
        };

        if (tool === "enterworktree") {
          const docsReminderScript = resolveProjectPath(
            directory,
            config.docsReminderScript,
          );
          if (docsReminderScript) {
            const result = await runScript(
              client,
              directory,
              docsReminderScript,
              { payload },
            );
            const messages = [
              extractScriptMessage(result.stdout),
              extractScriptMessage(result.stderr),
            ].filter(Boolean);
            appendToolOutput(output, messages);
          }
          return;
        }

        if (tool !== "bash") return;

        const args = input.args || {};
        const command = args.command || "";
        const commandLower = command.toLowerCase();
        const pathContains = toSlashes(
          config.pathContains || "worktrees/",
        ).toLowerCase();

        if (!commandLower.includes("git worktree add")) {
          return;
        }

        const parsedWorktreePath = parseWorktreePath(command);
        if (!parsedWorktreePath) return;

        const worktreeName = getWorktreeName(parsedWorktreePath);
        if (!worktreeName) return;

        const branchName = worktreeName;

        // .quiet() suppresses stderr to prevent noisy TUI logs from git calls
        const gitRoot = await $`git rev-parse --show-toplevel`.quiet().text();
        const projectRoot = String(gitRoot).trim().replace(/\\/g, "/");
        const commandCwd = getCommandCwd(args, directory);
        const absoluteWorktreePath = resolvePath(commandCwd, parsedWorktreePath);
        const expectedWorktreePath = joinProjectPath(
          projectRoot,
          `worktrees/${worktreeName}`,
        );

        if (!samePath(absoluteWorktreePath, expectedWorktreePath)) {
          appendToolOutput(output, [
            `Worktree path is not canonical: ${absoluteWorktreePath}`,
            `Use the project-local path instead: ${expectedWorktreePath}`,
            "Canonical rule: <project-root>/worktrees/<canonical-name> or <project-root>/worktrees/<canonical-name>-prNN.",
          ]);
          return;
        }

        if (!normalizePath(absoluteWorktreePath).toLowerCase().includes(pathContains)) {
          return;
        }

        const setupScript = resolveProjectPath(directory, config.setupScript);
        if (setupScript) {
          const setupResult = await runScript(client, directory, setupScript, {
            payload: {
              ...payload,
              worktreePath: absoluteWorktreePath,
              worktreeName,
              branchName,
            },
            commandArgs: ["-WorktreePath", absoluteWorktreePath],
            activeWorktreePath: absoluteWorktreePath,
          });

          if (setupResult.exitCode !== 0) {
            const setupErrorMessage = truncateMessage(
              [setupResult.stderr.trim(), setupResult.stdout.trim()]
                .filter(Boolean)
                .join("\n\n"),
            );
            appendToolOutput(output, [
              `Worktree setup failed for ${worktreeName}.`,
              setupErrorMessage || "No additional details from setup script.",
            ]);
          } else {
            appendToolOutput(output, [
              `Worktree setup complete: ${worktreeName}`,
            ]);
          }
        }

        const reminderLines = (config.reminderLines || []).map((line) =>
          replaceToken(
            replaceToken(
              replaceToken(line, "{worktreeName}", worktreeName),
              "{worktreePath}",
              absoluteWorktreePath,
            ),
            "{branchName}",
            branchName,
          ),
        );

        if (reminderLines.length > 0) {
          const banner = [
            "--------------------------------------------------",
            ...reminderLines,
            "--------------------------------------------------",
          ].join("\n");
          appendToolOutput(output, [banner]);
        }
      } catch (error) {
        await client.app.log({
          body: {
            service: "hooks",
            level: "error",
            message: "Worktree plugin execution failed",
            extra: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    },
  };
};
