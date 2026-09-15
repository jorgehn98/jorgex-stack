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

const logToOpenCode = async (
  client: unknown,
  level: "warn" | "error",
  message: string,
  extra?: unknown,
) => {
  if (typeof client !== "object" || client === null) return;
  const app = (client as { app?: unknown }).app;
  if (typeof app !== "object" || app === null) return;
  const log = (app as { log?: unknown }).log;
  if (typeof log !== "function") return;

  const safeExtra =
    extra instanceof Error
      ? { message: extra.message, stack: extra.stack }
      : extra;

  try {
    await log.call(app, {
      body: { service: "hooks", level, message, extra: safeExtra },
    });
  } catch {
    // Logging must not break the OpenCode TUI hook.
  }
};

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

const validateConfig = (config: Record<string, unknown>) => {
  for (const field of ["setupScript", "docsReminderScript", "pathContains"]) {
    if (field in config && typeof config[field] !== "string") {
      return `Worktree config field "${field}" must be a string.`;
    }
  }

  if (
    "reminderLines" in config &&
    (!Array.isArray(config.reminderLines) ||
      !config.reminderLines.every((line) => typeof line === "string"))
  ) {
    return 'Worktree config field "reminderLines" must be an array of strings.';
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
    const stderr = `Unsupported worktree hook script extension for ${scriptPath}.`;
    await logToOpenCode(
      client,
      "warn",
      "Unsupported worktree hook script extension",
      { script, scriptPath },
    );
    return { exitCode: 1, stdout: "", stderr, script, scriptPath };
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
      await logToOpenCode(
        client,
        "error",
        "Worktree hook script execution failed",
        {
          script,
          scriptPath,
          exitCode,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
        },
      );
    }

    return { exitCode, stdout, stderr, script, scriptPath };
  } catch (error) {
    await logToOpenCode(client, "error", "Worktree hook script execution failed", {
      script,
      scriptPath,
      error: error instanceof Error ? error.message : String(error),
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

const isMissingFileError = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return (
    code === "ENOENT" ||
    (error instanceof Error && /not found|no such file/i.test(error.message))
  );
};

// Pre/post validation against real Git state. The Bash command is only a
// cheap candidate filter; path, branch and detached state come from `git
// worktree list --porcelain -z` (NUL-separated fields, NUL-terminated
// records). Repository identity comes from `git rev-parse
// --path-format=absolute --git-common-dir`, which is shared by every worktree
// of one repository: it is the sufficient authority, so sibling linked
// worktrees are admitted and foreign repositories are rejected.
const isWorktreeAddCommand = (command: string) =>
  /\bgit\b.*\bworktree\s+add\b/i.test(command);

interface PorcelainWorktree {
  path: string;
  branch?: string;
  detached: boolean;
}

const NUL = String.fromCharCode(0);

const parsePorcelain = (raw: string): PorcelainWorktree[] => {
  const text = String(raw);
  if (!text) throw new Error("Empty porcelain inventory.");
  if (!text.endsWith(NUL + NUL)) {
    throw new Error("Truncated porcelain inventory: missing record terminator.");
  }
  const chunks = text.split(NUL + NUL);
  chunks.pop();
  const entries: PorcelainWorktree[] = [];
  const seenBranches = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk) throw new Error("Malformed porcelain inventory: empty record.");
    const fields = chunk.split(NUL);
    const first = fields[0];
    if (typeof first !== "string" || !first.startsWith("worktree ")) {
      throw new Error("Malformed porcelain inventory: record without worktree path.");
    }
    const worktreePath = first.slice("worktree ".length);
    if (!worktreePath) {
      throw new Error("Malformed porcelain inventory: empty worktree path.");
    }
    let head: string | undefined;
    let branch: string | undefined;
    let detached = false;
    for (const field of fields.slice(1)) {
      if (field.startsWith("worktree ")) {
        throw new Error("Malformed porcelain inventory: nested worktree record.");
      } else if (field.startsWith("HEAD ")) {
        if (head !== undefined) {
          throw new Error("Malformed porcelain inventory: duplicate HEAD.");
        }
        head = field;
      } else if (field.startsWith("branch ")) {
        if (branch !== undefined) {
          throw new Error("Malformed porcelain inventory: duplicate branch.");
        }
        const ref = field.slice("branch ".length).trim();
        const prefix = "refs/heads/";
        if (ref.startsWith(prefix)) branch = ref.slice(prefix.length);
      } else if (field === "detached") {
        if (detached) {
          throw new Error("Malformed porcelain inventory: duplicate detached.");
        }
        detached = true;
      }
      // Any other legitimate optional Git field (bare, locked, prunable, ...)
      // is accepted as-is.
    }
    if (head === undefined) {
      throw new Error("Malformed porcelain inventory: record without HEAD.");
    }
    if (branch !== undefined && detached) {
      throw new Error("Malformed porcelain inventory: branch with detached HEAD.");
    }
    if (branch !== undefined) {
      if (seenBranches.has(branch)) {
        throw new Error(`Malformed porcelain inventory: duplicate branch ${branch}.`);
      }
      seenBranches.add(branch);
    }
    entries.push({ path: toSlashes(worktreePath), branch, detached });
  }
  return entries;
};

const diffNewWorktrees = (
  pre: PorcelainWorktree[],
  post: PorcelainWorktree[],
) => post.filter((postEntry) => !pre.some((preEntry) => samePath(preEntry.path, postEntry.path)));

const getCallID = (input: any, output: any) => {
  const value =
    input?.callID ?? input?.callId ?? output?.callID ?? output?.callId;
  return typeof value === "string" && value ? value : undefined;
};

const getToolArgs = (input: any, output: any): Record<string, unknown> => {
  const args = input?.args ?? output?.args;
  return isPlainObject(args) ? args : {};
};

interface PendingCapturing {
  status: "capturing";
  cwd: string;
  ambiguous: boolean;
}

interface PendingReadyCapture {
  status: "ready";
  pre: string;
  repo: string;
  cwd: string;
  ambiguous: boolean;
}

interface PendingFailedCapture {
  status: "failed";
  cwd: string;
  error: string;
}

type PendingCapture = PendingCapturing | PendingReadyCapture | PendingFailedCapture;

export const WorktreePlugin: Plugin = async ({ $, client, directory }) => {
  let config: WorktreePluginConfig = {
    pathContains: "worktrees/",
    reminderLines: [],
  };
  let configError: string | undefined;

  try {
    const configPath = `${directory}/.opencode/worktree.json`;
    const configFile = (globalThis as any).Bun.file(configPath);
    if (
      typeof configFile.exists === "function" &&
      !(await configFile.exists())
    ) {
      // Optional project config.
    } else {
      const parsed = JSON.parse(await configFile.text()) as unknown;
      if (!isPlainObject(parsed)) {
        configError = "Worktree config must be a JSON object.";
      } else {
        configError = validateConfig(parsed);
        if (!configError) {
          config = { ...config, ...(parsed as WorktreePluginConfig) };
        }
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      const couldNotParse = error instanceof SyntaxError;
      configError = couldNotParse
        ? "Worktree config could not be parsed as JSON."
        : "Worktree config could not be read.";
      await logToOpenCode(
        client,
        "warn",
        couldNotParse
          ? "Worktree config could not be parsed"
          : "Worktree config could not be read",
        error,
      );
    }
  }

  const pending = new Map<string, PendingCapture>();

  const readCommonDir = async (cwd: string) =>
    toSlashes(
      String(
        await $`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.quiet().text(),
      ).trim(),
    );

  const failCapture = async (callID: string, cwd: string, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    pending.set(callID, { status: "failed", cwd, error: truncateMessage(message) });
    await logToOpenCode(client, "error", "Worktree pre-inventory failed", {
      error: message,
    });
  };

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        const tool = String(input?.tool || "").toLowerCase();
        if (tool !== "bash") return;
        const args = getToolArgs(input, output);
        const command = args.command;
        if (typeof command !== "string" || !isWorktreeAddCommand(command)) return;
        const callID = getCallID(input, output);
        if (!callID) return;
        const commandCwd = getCommandCwd(args, directory);
        const provisional: PendingCapturing = { status: "capturing", cwd: commandCwd, ambiguous: false };
        for (const [id, cap] of pending) {
          if (id !== callID) {
            if (cap.status === "capturing" || cap.status === "ready") cap.ambiguous = true;
            provisional.ambiguous = true;
          }
        }
        pending.set(callID, provisional);
        let preRaw: string;
        try {
          preRaw = String(
            await $`git -C ${commandCwd} worktree list --porcelain -z`.quiet().text(),
          );
        } catch (error) {
          await failCapture(callID, commandCwd, error);
          return;
        }
        let repo: string;
        try {
          repo = await readCommonDir(commandCwd);
          if (!isAbsolutePath(repo)) {
            throw new Error(`empty repository identity (common-dir) for ${commandCwd}`);
          }
        } catch (error) {
          await failCapture(callID, commandCwd, error);
          return;
        }
        pending.set(callID, { status: "ready", pre: preRaw, repo, cwd: commandCwd, ambiguous: provisional.ambiguous });
      } catch (error) {
        await logToOpenCode(client, "error", "Worktree plugin execution failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const tool = ((input.tool || "") as string).toLowerCase();
        const args = getToolArgs(input, output);
        const command =
          typeof args.command === "string" ? (args.command as string) : "";

        const payload = {
          event: "tool.execute.after",
          directory,
          tool: input.tool,
          args: input.args || {},
        };

        if (tool === "enterworktree") {
          if (configError) {
            appendToolOutput(output, [configError]);
            return;
          }

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

        if (!isWorktreeAddCommand(command)) {
          const stale = getCallID(input, output);
          if (stale) pending.delete(stale);
          return;
        }

        const callID = getCallID(input, output);
        const capture = callID ? pending.get(callID) : undefined;
        if (!callID || !capture) {
          if (callID) pending.delete(callID);
          appendToolOutput(output, [
            "Worktree creation is ambiguous: missing pre-execution inventory. Skipping setup.",
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }
        pending.delete(callID);

        if (capture.status === "failed") {
          appendToolOutput(output, [
            `Worktree pre-inventory capture failed for ${capture.cwd}; skipping worktree setup.`,
            "Run `git worktree list --porcelain -z` from the project root and retry.",
            "Run `git rev-parse --show-toplevel` from the project root and retry.",
            ...(capture.error ? [`Details: ${capture.error}`] : []),
          ]);
          return;
        }

        if (capture.status === "capturing") {
          appendToolOutput(output, [
            "Worktree creation is ambiguous: overlapping candidate commands in the same repository cannot be attributed to a single call. Skipping setup.",
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }

        let preList: PorcelainWorktree[];
        try {
          preList = parsePorcelain(capture.pre);
        } catch (error) {
          appendToolOutput(output, [
            "Worktree inventory is unreadable; skipping worktree setup.",
            "Run `git worktree list --porcelain` from the project root and retry.",
          ]);
          await logToOpenCode(client, "error", "Worktree inventory parse failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const exit = output?.metadata?.exit;
        if (typeof exit !== "number" || exit !== 0) {
          const ambiguous =
            exit === undefined || exit === null
              ? "Worktree command result is ambiguous (missing exit code); skipping worktree setup."
              : `Worktree command did not succeed (exit ${String(exit)}); skipping worktree setup.`;
          appendToolOutput(output, [ambiguous]);
          return;
        }

        if (capture.ambiguous) {
          appendToolOutput(output, [
            "Worktree creation is ambiguous: overlapping candidate commands in the same repository cannot be attributed to a single call. Skipping setup.",
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }

        const commandCwd = getCommandCwd(args, directory);
        let postRaw: string;
        let gitRoot: string;
        let commonCwd: string;
        let commonDir: string;
        try {
          postRaw = String(
            await $`git -C ${commandCwd} worktree list --porcelain -z`.quiet().text(),
          );
          gitRoot = String(
            await $`git -C ${commandCwd} rev-parse --show-toplevel`.quiet().text(),
          )
            .trim()
            .replace(/\\/g, "/");
          commonCwd = await readCommonDir(commandCwd);
          commonDir = await readCommonDir(directory);
        } catch (error) {
          const details = truncateMessage(
            error instanceof Error ? error.message : String(error),
          );
          appendToolOutput(output, [
            "Worktree plugin could not process this worktree command.",
            "Run `git rev-parse --show-toplevel` from the project root and retry.",
            ...(details ? [`Details: ${details}`] : []),
          ]);
          await logToOpenCode(client, "error", "Worktree plugin execution failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        if (!samePath(commonCwd, capture.repo)) {
          appendToolOutput(output, [
            "Worktree creation is ambiguous: repository identity changed between pre- and post-execution inventory. Skipping setup.",
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }

        const toplevel = toSlashes(gitRoot).replace(/\/+$/, "");
        if (!samePath(commonCwd, commonDir)) {
          appendToolOutput(output, [
            `Worktree command targets a foreign repository: ${toplevel}. Skipping setup.`,
            `The plugin directory belongs to a different repository (${normalizePath(directory)}). Run the command inside the project repository.`,
          ]);
          return;
        }

        let postList: PorcelainWorktree[];
        try {
          postList = parsePorcelain(postRaw);
        } catch (error) {
          appendToolOutput(output, [
            "Worktree inventory is unreadable; skipping worktree setup.",
            "Run `git worktree list --porcelain` from the project root and retry.",
          ]);
          await logToOpenCode(client, "error", "Worktree inventory parse failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const added = diffNewWorktrees(preList, postList);
        if (added.length !== 1) {
          appendToolOutput(output, [
            `Worktree creation is ambiguous: expected 1 new worktree, found ${added.length}. Skipping setup.`,
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }

        const created = added[0] as PorcelainWorktree;
        const branchName = created.detached ? undefined : created.branch;
        if (!branchName) {
          appendToolOutput(output, [
            created.detached
              ? "Worktree is detached; skipping setup. Use a branch worktree under <project-root>/worktrees/<branch>."
              : "Worktree branch could not be determined from Git; skipping setup.",
            "Run `git worktree list --porcelain` to inspect the current inventory.",
          ]);
          return;
        }

        const absoluteWorktreePath = toSlashes(created.path);
        const projectRoot = toplevel;
        const expectedWorktreePath = resolvePath(
          projectRoot,
          `worktrees/${branchName}`,
        );
        const pathContains = toSlashes(
          config.pathContains || "worktrees/",
        ).toLowerCase();

        const isCanonicalPath = samePath(
          absoluteWorktreePath,
          expectedWorktreePath,
        );
        if (!isCanonicalPath) {
          appendToolOutput(output, [
            `Worktree path is not canonical: ${absoluteWorktreePath}`,
            `Use the project-local path instead: ${expectedWorktreePath}`,
            "Canonical rule: <project-root>/worktrees/<canonical-name> or <project-root>/worktrees/<canonical-name>-prNN.",
          ]);
        }

        if (configError) {
          appendToolOutput(output, [configError]);
          return;
        }

        if (!isCanonicalPath) {
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
              worktreeName: branchName,
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
              `Worktree setup failed for ${branchName}.`,
              setupErrorMessage || "No additional details from setup script.",
            ]);
          } else {
            appendToolOutput(output, [
              `Worktree setup complete: ${branchName}`,
            ]);
          }
        }

        const reminderLines = (config.reminderLines || []).map((line) =>
          replaceToken(
            replaceToken(
              replaceToken(line, "{worktreeName}", branchName),
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
        return;
      } catch (error) {
        const callID = getCallID(input, output);
        if (callID) pending.delete(callID);
        const details = truncateMessage(
          error instanceof Error ? error.message : String(error),
        );
        appendToolOutput(output, [
          "Worktree plugin could not process this worktree command.",
          "Run `git rev-parse --show-toplevel` from the project root and retry.",
          ...(details ? [`Details: ${details}`] : []),
        ]);
        await logToOpenCode(client, "error", "Worktree plugin execution failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
