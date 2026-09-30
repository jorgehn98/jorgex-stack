import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

interface RunScriptOptions {
  payload?: unknown;
  commandArgs?: string[];
  activeWorktreePath?: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// El host v2 llama `shell` a la herramienta de shell; `bash` se conserva como
// alias porque el nombre observado varía entre builds.
const SHELL_TOOLS = new Set(["shell", "bash"]);

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
  return toSlashes(api.resolve(base, target));
};

const resolveProjectPath = (directory: string, target?: string) => {
  if (!target) return undefined;
  return isAbsolutePath(target) ? target : joinProjectPath(directory, target);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandText = (command: unknown): string => {
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" ? command : "";
};

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

const runScript = async (
  directory: string,
  script: string,
  options?: RunScriptOptions,
): Promise<ScriptResult> => {
  const payload = options?.payload;
  const scriptPath = isAbsolutePath(script) ? script : joinProjectPath(directory, script);
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
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unsupported worktree hook script extension for ${scriptPath}.`,
      script,
      scriptPath,
    };
  }

  try {
    const spawnEnv = buildScriptEnv(
      scriptPath,
      options?.activeWorktreePath,
    );
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

const truncateMessage = (value: string, maxLength = 1200) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...`;
};

const normalizePath = (value: string) => toSlashes(value).replace(/\/+$/, "");

const samePath = (left: string, right: string) => {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (isWindowsPath(normalizedLeft) || isWindowsPath(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
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

// El cwd del servidor es compartido. La sesión aporta el directorio del
// proyecto; `input.workdir` (relativo o absoluto) afina el comando concreto.
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

const resolveDirectories = async (ctx: any, event: any) => {
  const base = await resolveSessionDirectory(ctx, event?.sessionID);
  const workdir = event?.input?.workdir;
  if (typeof workdir === "string" && workdir) {
    if (isAbsolutePath(workdir)) return { base, command: workdir };
    return { base, command: base ? resolvePath(base, workdir) : undefined };
  }
  return { base, command: base };
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
    let sawBranch = false;
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
        if (sawBranch) {
          throw new Error("Malformed porcelain inventory: duplicate branch.");
        }
        sawBranch = true;
        const ref = field.slice("branch ".length).trim();
        const prefix = "refs/heads/";
        if (!ref.startsWith(prefix) || ref.length === prefix.length) {
          throw new Error("Malformed porcelain inventory: malformed branch ref.");
        }
        branch = ref.slice(prefix.length);
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

const MAX_BUFFER = 32 * 1024 * 1024;

const runGit = (args: string[], cwd: string): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
  });

const gitText = async (args: string[], cwd: string): Promise<string> => {
  const { stdout, stderr, exitCode } = await runGit(args, cwd);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`,
    );
  }
  return stdout;
};

const readPorcelain = (cwd: string) =>
  gitText(["worktree", "list", "--porcelain", "-z"], cwd);

const readCommonDir = async (cwd: string) =>
  toSlashes(
    (await gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim(),
  );

const defaultConfig = (): WorktreePluginConfig => ({
  pathContains: "worktrees/",
  reminderLines: [],
});

const readWorktreeConfig = async (
  directory: string,
): Promise<{ config: WorktreePluginConfig; error?: string }> => {
  try {
    const configFile = (globalThis as any).Bun.file(`${directory}/.opencode/worktree.json`);
    if (typeof configFile.exists === "function" && !(await configFile.exists())) {
      return { config: defaultConfig() };
    }
    const parsed = JSON.parse(await configFile.text()) as unknown;
    if (!isPlainObject(parsed)) {
      return { config: defaultConfig(), error: "Worktree config must be a JSON object." };
    }
    const error = validateConfig(parsed);
    if (error) return { config: defaultConfig(), error };
    return { config: { ...defaultConfig(), ...(parsed as WorktreePluginConfig) } };
  } catch (error) {
    if (isMissingFileError(error)) return { config: defaultConfig() };
    const couldNotParse = error instanceof SyntaxError;
    return {
      config: defaultConfig(),
      error: couldNotParse
        ? "Worktree config could not be parsed as JSON."
        : "Worktree config could not be read.",
    };
  }
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

const AMBIGUOUS_MESSAGES = (reason: string) => [
  reason,
  "Run `git worktree list --porcelain` to inspect the current inventory.",
];

export default {
  id: "stack-worktree",

  async setup(ctx: any) {
    const pending = new Map<string, PendingCapture>();

    const failCapture = (id: string, cwd: string, cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      pending.set(id, { status: "failed", cwd, error: truncateMessage(message) });
    };

    const handleBefore = async (event: any) => {
      try {
        if (!SHELL_TOOLS.has(String(event?.tool ?? "").toLowerCase())) return;
        if (!isWorktreeAddCommand(commandText(event?.input?.command))) return;
        const id = typeof event?.id === "string" ? event.id : "";
        if (!id) return;
        const { command: commandCwd } = await resolveDirectories(ctx, event);
        if (!commandCwd) return;

        const provisional: PendingCapturing = {
          status: "capturing",
          cwd: commandCwd,
          ambiguous: false,
        };
        for (const [otherId, cap] of pending) {
          if (otherId !== id) {
            if (cap.status === "capturing" || cap.status === "ready") cap.ambiguous = true;
            provisional.ambiguous = true;
          }
        }
        pending.set(id, provisional);

        let preRaw: string;
        try {
          preRaw = await readPorcelain(commandCwd);
        } catch (error) {
          failCapture(id, commandCwd, error);
          return;
        }

        let repo: string;
        try {
          repo = await readCommonDir(commandCwd);
          if (!isAbsolutePath(repo)) {
            throw new Error(`empty repository identity (common-dir) for ${commandCwd}`);
          }
        } catch (error) {
          failCapture(id, commandCwd, error);
          return;
        }

        pending.set(id, {
          status: "ready",
          pre: preRaw,
          repo,
          cwd: commandCwd,
          ambiguous: provisional.ambiguous,
        });
      } catch {
        // fail-open: un fallo del guardia no bloquea la herramienta.
      }
    };

    const handleAfter = async (event: any) => {
      try {
        if (!SHELL_TOOLS.has(String(event?.tool ?? "").toLowerCase())) return;
        const command = commandText(event?.input?.command);
        const id = typeof event?.id === "string" ? event.id : "";

        if (!isWorktreeAddCommand(command)) {
          if (id) pending.delete(id);
          return;
        }

        // Sin un result terminal no hay éxito que validar: `running`/`background`
        // (o un error sin result) nunca fabrican setup.
        if (event?.status !== "completed" || !isPlainObject(event.result)) return;

        const { base, command: commandCwd } = await resolveDirectories(ctx, event);
        const projectDir = base ?? commandCwd;
        const { config, error: configError } = projectDir
          ? await readWorktreeConfig(projectDir)
          : { config: defaultConfig(), error: undefined };

        const capture = id ? pending.get(id) : undefined;
        if (!capture) {
          appendToResult(
            event,
            AMBIGUOUS_MESSAGES(
              "Worktree creation is ambiguous: missing pre-execution inventory. Skipping setup.",
            ),
          );
          return;
        }

        try {
          if (capture.status === "failed") {
            appendToResult(event, [
              `Worktree pre-inventory capture failed for ${capture.cwd}; skipping worktree setup.`,
              "Run `git worktree list --porcelain -z` from the project root and retry.",
              "Run `git rev-parse --show-toplevel` from the project root and retry.",
              ...(capture.error ? [`Details: ${capture.error}`] : []),
            ]);
            return;
          }

          if (capture.status === "capturing") {
            appendToResult(
              event,
              AMBIGUOUS_MESSAGES(
                "Worktree creation is ambiguous: overlapping candidate commands in the same repository cannot be attributed to a single call. Skipping setup.",
              ),
            );
            return;
          }

          let preList: PorcelainWorktree[];
          try {
            preList = parsePorcelain(capture.pre);
          } catch {
            appendToResult(event, [
              "Worktree inventory is unreadable; skipping worktree setup.",
              "Run `git worktree list --porcelain` from the project root and retry.",
            ]);
            return;
          }

          const exit = event.result?.metadata?.exit;
          if (typeof exit !== "number" || exit !== 0) {
            appendToResult(event, [
              exit === undefined || exit === null
                ? "Worktree command result is ambiguous (missing exit code); skipping worktree setup."
                : `Worktree command did not succeed (exit ${String(exit)}); skipping worktree setup.`,
            ]);
            return;
          }

          if (capture.ambiguous) {
            appendToResult(
              event,
              AMBIGUOUS_MESSAGES(
                "Worktree creation is ambiguous: overlapping candidate commands in the same repository cannot be attributed to a single call. Skipping setup.",
              ),
            );
            return;
          }

          if (!commandCwd) return;

          let postRaw: string;
          let gitRoot: string;
          let commonCwd: string;
          let commonDir: string;
          try {
            postRaw = await readPorcelain(commandCwd);
            gitRoot = toSlashes(
              (await gitText(["rev-parse", "--show-toplevel"], commandCwd)).trim(),
            );
            commonCwd = await readCommonDir(commandCwd);
            commonDir = await readCommonDir(projectDir ?? commandCwd);
          } catch (error) {
            const details = truncateMessage(
              error instanceof Error ? error.message : String(error),
            );
            appendToResult(event, [
              "Worktree plugin could not process this worktree command.",
              "Run `git rev-parse --show-toplevel` from the project root and retry.",
              ...(details ? [`Details: ${details}`] : []),
            ]);
            return;
          }

          // A concurrent candidate may have started while the post reads above
          // were in flight and flagged this capture: re-check after every await
          // and right before attributing effects.
          if (capture.ambiguous) {
            appendToResult(
              event,
              AMBIGUOUS_MESSAGES(
                "Worktree creation is ambiguous: overlapping candidate commands in the same repository cannot be attributed to a single call. Skipping setup.",
              ),
            );
            return;
          }

          if (!samePath(commonCwd, capture.repo)) {
            appendToResult(
              event,
              AMBIGUOUS_MESSAGES(
                "Worktree creation is ambiguous: repository identity changed between pre- and post-execution inventory. Skipping setup.",
              ),
            );
            return;
          }

          const toplevel = toSlashes(gitRoot).replace(/\/+$/, "");
          if (!samePath(commonCwd, commonDir)) {
            appendToResult(event, [
              `Worktree command targets a foreign repository: ${toplevel}. Skipping setup.`,
              `The plugin directory belongs to a different repository (${normalizePath(projectDir ?? commandCwd)}). Run the command inside the project repository.`,
            ]);
            return;
          }

          let postList: PorcelainWorktree[];
          try {
            postList = parsePorcelain(postRaw);
          } catch {
            appendToResult(event, [
              "Worktree inventory is unreadable; skipping worktree setup.",
              "Run `git worktree list --porcelain` from the project root and retry.",
            ]);
            return;
          }

          const added = diffNewWorktrees(preList, postList);
          if (added.length !== 1) {
            appendToResult(event, [
              `Worktree creation is ambiguous: expected 1 new worktree, found ${added.length}. Skipping setup.`,
              "Run `git worktree list --porcelain` to inspect the current inventory.",
            ]);
            return;
          }

          const created = added[0] as PorcelainWorktree;
          const branchName = created.detached ? undefined : created.branch;
          if (!branchName) {
            appendToResult(event, [
              created.detached
                ? "Worktree is detached; skipping setup. Use a branch worktree under <project-root>/worktrees/<branch>."
                : "Worktree branch could not be determined from Git; skipping setup.",
              "Run `git worktree list --porcelain` to inspect the current inventory.",
            ]);
            return;
          }

          const absoluteWorktreePath = toSlashes(created.path);
          const projectRoot = toplevel;
          const expectedWorktreePath = resolvePath(projectRoot, `worktrees/${branchName}`);
          const pathContains = toSlashes(config.pathContains || "worktrees/").toLowerCase();

          const isCanonicalPath = samePath(absoluteWorktreePath, expectedWorktreePath);
          if (!isCanonicalPath) {
            appendToResult(event, [
              `Worktree path is not canonical: ${absoluteWorktreePath}`,
              `Use the project-local path instead: ${expectedWorktreePath}`,
              "Canonical rule: <project-root>/worktrees/<canonical-name> or <project-root>/worktrees/<canonical-name>-prNN.",
            ]);
          }

          if (configError) {
            appendToResult(event, [configError]);
            return;
          }

          if (!isCanonicalPath) return;

          if (!normalizePath(absoluteWorktreePath).toLowerCase().includes(pathContains)) {
            return;
          }

          const setupScript = resolveProjectPath(projectDir ?? commandCwd, config.setupScript);
          if (setupScript) {
            const setupResult = await runScript(projectDir ?? commandCwd, setupScript, {
              payload: {
                event: "tool.execute.after",
                directory: projectDir ?? commandCwd,
                tool: "bash",
                args: { command },
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
              appendToResult(event, [
                `Worktree setup failed for ${branchName}.`,
                setupErrorMessage || "No additional details from setup script.",
              ]);
            } else {
              appendToResult(event, [`Worktree setup complete: ${branchName}`]);
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
            appendToResult(event, [banner]);
          }
          return;
        } finally {
          if (pending.get(id) === capture) pending.delete(id);
        }
      } catch (error) {
        const details = truncateMessage(
          error instanceof Error ? error.message : String(error),
        );
        appendToResult(event, [
          "Worktree plugin could not process this worktree command.",
          "Run `git rev-parse --show-toplevel` from the project root and retry.",
          ...(details ? [`Details: ${details}`] : []),
        ]);
      }
    };

    await ctx.tool.hook("execute.before", handleBefore);
    await ctx.tool.hook("execute.after", handleAfter);
  },
};
