import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as worktreeModule from "../stack/plugins/opencode/worktree.js";

/**
 * Plugin OpenCode v2 nativo: `export default { id, setup }` registra
 * `execute.before`/`execute.after` con `ctx.tool.hook(...)`. Los eventos son
 * objetos `{ id, tool, sessionID, input, status, result|error }` y el setter
 * de resultado reemplaza `event.result` (content readonly).
 *
 * El plugin consulta Git real con `execFile` de node:child_process (stdlib,
 * argv/cwd explícitos y stdout/stderr capturados). Este arnés intercepta solo
 * `execFile`; `execFileSync` sigue real para preparar repos de fixture.
 */
const childProcessMock = vi.hoisted(() => ({
  execFile: null as null | ((...args: any[]) => void),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => childProcessMock.execFile!(...args),
  };
});

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
}

const createV2Host = (sessionDirectory: string, sessionID = "sess-t03-01"): V2Host => {
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
  return { ctx, registered };
};

let tmp: string;

const SESSION_ID = "sess-t03-01";

const NUL = "\0";

const toSlashes = (value: string) => value.replace(/\\/g, "/");

const canonicalExpected = (root: string, branch: string) =>
  `${toSlashes(root).replace(/\/+$/, "")}/worktrees/${branch}`;

const porcelainMain = (root: string) =>
  `worktree ${toSlashes(root)}${NUL}HEAD abc123${NUL}branch refs/heads/main${NUL}${NUL}`;

const porcelainWith = (root: string, relPath: string, branch: string) =>
  `${porcelainMain(root)}worktree ${toSlashes(root).replace(/\/+$/, "")}/${relPath}${NUL}HEAD def456${NUL}branch refs/heads/${branch}${NUL}${NUL}`;

const porcelainDetached = (root: string, relPath: string) =>
  `${porcelainMain(root)}worktree ${toSlashes(root).replace(/\/+$/, "")}/${relPath}${NUL}HEAD def456${NUL}detached${NUL}${NUL}`;

const porcelainMultiple = (root: string) => {
  const base = toSlashes(root).replace(/\/+$/, "");
  return (
    `${porcelainMain(root)}` +
    `worktree ${base}/worktrees/branch-a${NUL}HEAD aaa111${NUL}branch refs/heads/branch-a${NUL}${NUL}` +
    `worktree ${base}/worktrees/branch-b${NUL}HEAD bbb222${NUL}branch refs/heads/branch-b${NUL}${NUL}`
  );
};

const makePlugin = async (
  root: string,
  config: unknown = {},
  spawn = vi.fn(),
  spawnResult = {
    stdout: "setup ok",
    stderr: "",
    exited: Promise.resolve(0),
  },
  gitRoot: string | Error = root,
  resolveCommonDir?: (cwd: string) => string | Error | Promise<string | Error>,
  deferPorcelain?: { index: number; gate: Promise<unknown>; onDeferred?: () => void },
) => {
  let currentPorcelain: string | Error = porcelainMain(root);
  const setPorcelain = (value: string | Error) => {
    currentPorcelain = value;
  };
  vi.stubGlobal("Bun", {
    file: () => ({
      text: async () => {
        if (config === null) throw new Error("Config not found");
        if (config instanceof Error) throw config;
        if (typeof config === "string") return config;
        if (Array.isArray(config)) return JSON.stringify(config);
        return JSON.stringify({
          setupScript: "setup.ps1",
          pathContains: "worktrees/",
          ...(config as Record<string, unknown>),
        });
      },
    }),
    spawn: spawn.mockReturnValue(spawnResult),
  });
  const defaultCommonDir = (): string | Error => {
    if (gitRoot instanceof Error) return gitRoot;
    return `${toSlashes(gitRoot).replace(/\/+$/, "")}/.git`;
  };
  const resolveCommon = resolveCommonDir ?? defaultCommonDir;
  let porcelainCalls = 0;
  childProcessMock.execFile = (file, args, options, callback) => {
    const cwd = toSlashes(String(options?.cwd ?? root));
    const asError = (value: unknown) =>
      value instanceof Error ? value : new Error(String(value));
    callback = callback ?? (() => {});
    try {
      if (file !== "git") {
        callback(asError(`unexpected command: ${file}`), "", "");
        return;
      }
      if (args[0] === "worktree" && args[1] === "list") {
        if (!args.includes("--porcelain") || !args.includes("-z")) {
          callback(`expected --porcelain -z query, got: ${args.join(" ")}` as unknown as Error, "", "");
          return;
        }
        porcelainCalls += 1;
        const deliver = () => {
          if (currentPorcelain instanceof Error) {
            callback(currentPorcelain, "", currentPorcelain.message);
          } else {
            callback(null, String(currentPorcelain), "");
          }
        };
        if (deferPorcelain && porcelainCalls === deferPorcelain.index) {
          deferPorcelain.onDeferred?.();
          deferPorcelain.gate.then(deliver, (error) =>
            callback(asError(error), "", ""),
          );
        } else {
          deliver();
        }
        return;
      }
      if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
        const resolved = resolveCommon(cwd);
        Promise.resolve(resolved).then(
          (value) => {
            if (value instanceof Error) callback(value, "", value.message);
            else callback(null, `${value}\n`, "");
          },
          (error) => callback(asError(error), "", ""),
        );
        return;
      }
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        if (gitRoot instanceof Error) callback(gitRoot, "", gitRoot.message);
        else callback(null, `${gitRoot}\n`, "");
        return;
      }
      callback(asError(`unexpected git query: ${args.join(" ")}`), "", "");
    } catch (error) {
      callback(asError(error), "", "");
    }
  };

  const host = createV2Host(root);
  const plugin = pluginOf(worktreeModule);
  if (!plugin) throw new Error("worktree.ts debe exportar default { id, setup }");
  await plugin.setup(host.ctx);

  return {
    hooks: {
      before: host.registered.get("execute.before")!,
      after: host.registered.get("execute.after")!,
    },
    ctx: host.ctx,
    spawn,
    setPorcelain,
  };
};

interface HarnessHooks {
  before: (event: Record<string, unknown>) => unknown;
  after: (event: Record<string, unknown>) => unknown;
}

const makeResult = (exit?: number | null) => {
  const metadata: Record<string, unknown> = {
    output: "",
    truncated: false,
    description: "git worktree add",
  };
  if (exit !== undefined) metadata.exit = exit;
  return { title: "git worktree add", output: "", metadata };
};

const shellEvent = (
  callID: string,
  command: string,
  workdir: string,
): Record<string, unknown> => ({
  id: callID,
  tool: "shell",
  sessionID: SESSION_ID,
  input: { command, workdir },
});

// El plugin anexa el aviso a `result.content` (array readonly) conservando
// `output`/`metadata`; el texto visible es la unión de ambos canales.
const resultText = (event: Record<string, unknown>): string => {
  const result = event?.result as
    | { output?: unknown; content?: unknown }
    | undefined;
  if (!result) return "";
  const parts: string[] = [];
  if (typeof result.output === "string") parts.push(result.output);
  if (typeof result.content === "string") {
    parts.push(result.content);
  } else if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const textBlock = block as { text?: unknown };
      if (typeof textBlock?.text === "string") parts.push(textBlock.text);
    }
  }
  return parts.join("\n");
};

const runLifecycle = async (
  hooks: HarnessHooks,
  setPorcelain: (value: string | Error) => void,
  opts: {
    command: string;
    workdir: string;
    callID: string;
    pre: string;
    post: string;
    exit?: number | null;
  },
) => {
  setPorcelain(opts.pre);
  await hooks.before(shellEvent(opts.callID, opts.command, opts.workdir));
  setPorcelain(opts.post);
  const after: Record<string, unknown> = {
    ...shellEvent(opts.callID, opts.command, opts.workdir),
    status: "completed",
    result: makeResult(opts.exit),
  };
  await hooks.after(after);
  return after;
};

const runAfterOnly = async (
  hooks: HarnessHooks,
  opts: { command: string; workdir: string; callID: string; exit: number },
) => {
  const after: Record<string, unknown> = {
    ...shellEvent(opts.callID, opts.command, opts.workdir),
    status: "completed",
    result: makeResult(opts.exit),
  };
  await hooks.after(after);
  return after;
};

const readPayload = async (spawn: any) => {
  const [, options] = spawn.mock.calls[0]!;
  return {
    options: options as { env: Record<string, string>; stdin: Response },
    payload: JSON.parse(
      await (options as { stdin: Response }).stdin.text(),
    ) as Record<string, string>,
  };
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-worktree-plugin-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("OpenCode v2 worktree plugin", () => {
  it("does not run setup when project worktree config is absent", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, null);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-absent-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toBe("");
  });

  it("still warns for a non-canonical worktree path when config is absent", async () => {
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, null);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-absent-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toContain("Worktree path is not canonical");
    expect(resultText(output)).toContain(canonicalExpected(tmp, "outside-name"));
  });

  it("reports invalid worktree config without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, "{");
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-invalid-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toMatch(/could not be parsed as JSON/i);
  });

  it("reports invalid config and a non-canonical worktree path without spawning setup", async () => {
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, "{");
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-invalid-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toMatch(/could not be parsed as JSON/i);
    expect(resultText(output)).toContain("Worktree path is not canonical");
    expect(resultText(output)).toContain("Use the project-local path instead");
  });

  it("reports unreadable worktree config separately from malformed JSON", async () => {
    const configReadError = Object.assign(new Error("access denied"), {
      code: "EACCES",
    });
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, configReadError);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: tmp,
      callID: "call-unreadable-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toMatch(/could not be read/i);
    expect(resultText(output)).not.toMatch(/parsed.*JSON/i);
  });

  it("keeps a git root failure actionable as a diagnostic on the result", async () => {
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {},
      vi.fn(),
      undefined,
      new Error("git is unavailable"),
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add worktrees/canonical-name",
      workdir: tmp,
      callID: "call-gitroot-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    // Sin logger v1, el diagnóstico vive en el resultado: el fallo queda
    // accionable en vez de silencioso.
    expect(resultText(output)).toMatch(/git rev-parse --show-toplevel/i);
    expect(resultText(output)).toContain(toSlashes(tmp));
    // El aviso se anexa sin perder output/metadata originales.
    const result = output.result as { output: unknown; metadata: unknown };
    expect(result.output).toBe("");
    expect(result.metadata).toEqual({
      output: "",
      truncated: false,
      description: "git worktree add",
      exit: 0,
    });
  });

  it("reports a non-string setupScript without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, { setupScript: 42 });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-setupscript-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toMatch(/setupScript.*string/i);
  });

  it.each([
    ["an array config root", [], /config.*object/i],
    ['a non-string "docsReminderScript"', { docsReminderScript: true }, /docsReminderScript.*string/i],
    ['a non-string "pathContains"', { pathContains: 42 }, /pathContains.*string/i],
    ['a non-string "reminderLines" entry', { reminderLines: [42] }, /reminderLines.*string/i],
  ])("reports %s without spawning setup", async (_description, config, expectedError) => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, config);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: `call-invalid-each-${String(_description).slice(0, 12)}`,
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toMatch(expectedError);
    expect(resultText(output)).not.toContain("Worktree setup complete");
  });

  it("keeps an unsupported setup failure visible as a result diagnostic", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      { setupScript: "setup.txt" },
      vi.fn(),
      undefined,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-unsupported-log-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toContain("Worktree setup failed for canonical-name.");
    expect(resultText(output)).toMatch(/unsupported.*extension/i);
    expect(resultText(output)).not.toContain("Worktree setup complete");
    const result = output.result as { output: unknown; metadata: unknown };
    expect(result.output).toBe("");
    expect(result.metadata).toEqual({
      output: "",
      truncated: false,
      description: "git worktree add",
      exit: 0,
    });
  });

  it("runs explicitly configured setup for a canonical worktree path resolved from command cwd", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees\\",
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-canonical-cwd-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    const expectedPath = canonicalExpected(tmp, "canonical-name");
    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);

    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(expectedPath);
    expect(payload.worktreeName).toBe("canonical-name");
    expect(payload.branchName).toBe("canonical-name");
    expect(spawn.mock.calls[0]![0]).toContain(expectedPath);
    expect(resultText(output)).toContain("Worktree setup complete: canonical-name");
  });

  it("reports an explicitly configured setup failure without reporting success", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      { setupScript: "setup.ps1" },
      vi.fn(),
      {
        stdout: "",
        stderr: "setup exploded",
        exited: Promise.resolve(1),
      },
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-setup-fail-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).toHaveBeenCalledOnce();
    expect(resultText(output)).toContain("Worktree setup failed for canonical-name.");
    expect(resultText(output)).toContain("setup exploded");
    expect(resultText(output)).not.toContain("Worktree setup complete");
  });

  it("reports an unsupported explicit setup extension as a failure", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, { setupScript: "setup.txt" });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-unsupported-ext-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toContain("Worktree setup failed for canonical-name.");
    expect(resultText(output)).toMatch(/unsupported.*extension/i);
    expect(resultText(output)).not.toContain("Worktree setup complete");
  });

  it("ignores legacy branchPrefix config and keeps branchName equal to worktreeName", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-prefix-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);

    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(canonicalExpected(tmp, "canonical-name"));
    expect(payload.worktreeName).toBe("canonical-name");
    expect(payload.branchName).toBe("canonical-name");
    expect(resultText(output)).toContain("Worktree setup complete: canonical-name");
  });

  it("passes feature-pr01 as branchName for a multi-PR worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/feature-pr01",
      workdir: srcDir,
      callID: "call-multipr-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/feature-pr01", "feature-pr01"),
      exit: 0,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);

    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(canonicalExpected(tmp, "feature-pr01"));
    expect(payload.worktreeName).toBe("feature-pr01");
    expect(payload.branchName).toBe("feature-pr01");
    expect(resultText(output)).toContain("Worktree setup complete: feature-pr01");
  });

  it("ignores legacy branchPrefix config for multi-PR worktrees", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/feature-pr01",
      workdir: srcDir,
      callID: "call-prefix-multipr-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/feature-pr01", "feature-pr01"),
      exit: 0,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const { payload } = await readPayload(spawn);

    expect(payload.worktreeName).toBe("feature-pr01");
    expect(payload.branchName).toBe("feature-pr01");
    expect(resultText(output)).toContain("Worktree setup complete: feature-pr01");
  });

  it("warns and skips setup for non-canonical worktree paths", async () => {
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp);
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(resultText(output)).toContain("Worktree path is not canonical");
    expect(resultText(output)).toContain(canonicalExpected(tmp, "outside-name"));
  });

  it("keeps full branch identity for canonical -b without false warning", async () => {
    const branch = "codex/feature";
    const rel = "worktrees/codex/feature";
    const command = `git worktree add -b ${branch} ${rel}`;
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command,
      workdir: tmp,
      callID: "call-red-b-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, rel, branch),
      exit: 0,
    });
    const text = resultText(output);
    expect(text).not.toContain("Worktree path is not canonical");
    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);
    expect(payload.branchName).toBe(branch);
    expect(payload.worktreePath).toBe(`${toSlashes(tmp).replace(/\/+$/, "")}/${rel}`);
    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(
      `${toSlashes(tmp).replace(/\/+$/, "")}/${rel}`,
    );
    expect(text).toContain("Worktree setup complete");
  });

  it("withholds setup/reminders/success when Bash exit is non-zero", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const command = "git worktree add ../worktrees/canonical-name";
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command,
      workdir: srcDir,
      callID: "call-red-exit-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 1,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup/reminders/success without a single new worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const command = "git worktree add ../worktrees/canonical-name";
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command,
      workdir: srcDir,
      callID: "call-red-ambiguous-01",
      pre: porcelainMain(tmp),
      post: porcelainMain(tmp),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup when Bash metadata exit is missing", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add -- ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-missing-exit-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/missing exit code/i);
    expect(text).toMatch(/skipping worktree setup/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup when Bash times out with a null exit despite an apparent new worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-timeout-null-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: null,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/missing exit code|ambiguous|did not succeed/i);
    expect(text).toMatch(/skipping worktree setup/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup when multiple worktrees appear between inventories", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git -C ${srcDir} worktree add ../worktrees/canonical-name`,
      workdir: srcDir,
      callID: "call-multiple-01",
      pre: porcelainMain(tmp),
      post: porcelainMultiple(tmp),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/expected 1 new worktree, found 2/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup for a detached worktree without fabricating a branch", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/detached-wt",
      workdir: srcDir,
      callID: "call-detached-01",
      pre: porcelainMain(tmp),
      post: porcelainDetached(tmp, "worktrees/detached-wt"),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/detached/i);
    expect(text).toMatch(/skipping setup/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("fails closed with missing pre-execution inventory when before did not capture", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runAfterOnly(hooks, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-missing-pre-01",
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/missing pre-execution inventory/i);
    expect(text).not.toContain("Worktree setup complete");
  });

  it("matches real Git porcelain -z, root, cwd, branch and path in an isolated repo", async () => {
    const repo = path.join(tmp, "real-repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, { cwd, encoding: "utf8" });

    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Tester"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "init"], repo);

    const realRoot = git(["rev-parse", "--show-toplevel"], repo).trim();
    const pre = git(["worktree", "list", "--porcelain", "-z"], repo);
    const branch = "canonical-real";
    const rel = `worktrees/${branch}`;
    git(["worktree", "add", rel], repo);
    const post = git(["worktree", "list", "--porcelain", "-z"], repo);

    expect(toSlashes(realRoot)).toBe(toSlashes(repo));
    expect(post).toContain(`worktree ${toSlashes(repo)}/${rel}`);
    expect(post).toContain(`branch refs/heads/${branch}`);

    const { hooks, spawn, setPorcelain } = await makePlugin(
      repo,
      { setupScript: "setup.ps1", pathContains: "worktrees/" },
      vi.fn(),
      undefined,
      realRoot,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: repo,
      callID: "call-real-git-01",
      pre,
      post,
      exit: 0,
    });
    const text = resultText(output);

    expect(text).not.toContain("Worktree path is not canonical");
    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);
    expect(payload.branchName).toBe(branch);
    expect(payload.worktreePath).toBe(`${toSlashes(repo)}/${rel}`);
    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(`${toSlashes(repo)}/${rel}`);
    expect(text).toContain(`Worktree setup complete: ${branch}`);
  });

  it("keeps a canonical path with spaces from NUL porcelain without false warning", async () => {
    const spaceRoot = path.join(tmp, "with space");
    fs.mkdirSync(spaceRoot, { recursive: true });
    const branch = "canonical-name";
    const rel = `worktrees/${branch}`;
    const base = toSlashes(spaceRoot).replace(/\/+$/, "");
    const pre = `worktree ${base}${NUL}HEAD abc123${NUL}branch refs/heads/main${NUL}${NUL}`;
    const post = `${pre}worktree ${base}/${rel}${NUL}HEAD def456${NUL}branch refs/heads/${branch}${NUL}${NUL}`;
    const { hooks, spawn, setPorcelain } = await makePlugin(spaceRoot, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add "${rel}"`,
      workdir: spaceRoot,
      callID: "call-quoted-space-01",
      pre,
      post,
      exit: 0,
    });
    const text = resultText(output);

    expect(text).not.toContain("Worktree path is not canonical");
    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);
    expect(payload.branchName).toBe(branch);
    expect(payload.worktreePath).toBe(`${base}/${rel}`);
    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(`${base}/${rel}`);
    expect(text).toContain(`Worktree setup complete: ${branch}`);
  });

  it("diagnoses a foreign repository without setup or reminders when workdir points outside the plugin directory", async () => {
    const repoA = path.join(tmp, "repo-a");
    const repoB = path.join(tmp, "repo-b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const branch = "foreign-branch";
    const rel = `worktrees/${branch}`;
    const baseA = toSlashes(repoA).replace(/\/+$/, "");
    const baseB = toSlashes(repoB).replace(/\/+$/, "");
    const resolveForeignCommon = (cwd: string) =>
      toSlashes(cwd).replace(/\/+$/, "").startsWith(baseB) ? `${baseB}/.git` : `${baseA}/.git`;
    const { hooks, spawn, setPorcelain } = await makePlugin(
      repoA,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      repoB,
      resolveForeignCommon,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: repoB,
      callID: "call-foreign-01",
      pre: porcelainMain(repoB),
      post: porcelainWith(repoB, rel, branch),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/foreign|different repository|ajeno/i);
  });

  it("withholds all setup when two overlapping calls share the same pre-inventory", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const command = "git worktree add ../worktrees/canonical-name";
    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent("call-overlap-01", command, srcDir));
    await hooks.before(shellEvent("call-overlap-02", command, srcDir));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const output1: Record<string, unknown> = {
      ...shellEvent("call-overlap-01", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    const output2: Record<string, unknown> = {
      ...shellEvent("call-overlap-02", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(output1);
    await hooks.after(output2);
    const text1 = resultText(output1);
    const text2 = resultText(output2);
    expect(spawn).not.toHaveBeenCalled();
    expect(text1).not.toContain("Worktree setup complete");
    expect(text2).not.toContain("Worktree setup complete");
    expect(`${text1}\n${text2}`).toMatch(/ambiguous|cannot be attributed|overlapping/i);
  });

  it("diagnoses unreadable pre-inventory without setup when pre porcelain is truncated", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const base = toSlashes(tmp).replace(/\/+$/, "");
    const malformedPre = `worktree ${base}${NUL}HEAD abc123`;
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-malformed-pre-01",
      pre: malformedPre,
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/unreadable/i);
  });

  it("rejects a worktrees-evil prefix collision as non-canonical without setup", async () => {
    const branch = "canonical-name";
    const evilRel = "worktrees-evil/canonical-name";
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add "${path.join(tmp, evilRel)}"`,
      workdir: tmp,
      callID: "call-evil-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, evilRel, branch),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toContain("Worktree path is not canonical");
    expect(text).toContain(canonicalExpected(tmp, branch));
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("allows setup from the main checkout when the plugin directory is a sibling linked worktree of the same repository", async () => {
    const main = path.join(tmp, "main");
    const sibling = path.join(tmp, "sibling");
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const baseMain = toSlashes(main).replace(/\/+$/, "");
    const baseSibling = toSlashes(sibling).replace(/\/+$/, "");
    const commonMain = `${baseMain}/.git`;
    const branch = "shared-branch";
    const rel = `worktrees/${branch}`;
    const pre =
      `worktree ${baseMain}${NUL}HEAD aaa111${NUL}branch refs/heads/main${NUL}${NUL}` +
      `worktree ${baseSibling}${NUL}HEAD bbb222${NUL}branch refs/heads/sibling${NUL}${NUL}`;
    const post =
      `${pre}worktree ${baseMain}/${rel}${NUL}HEAD ccc333${NUL}branch refs/heads/${branch}${NUL}${NUL}`;
    const resolveSameCommon = () => commonMain;
    const { hooks, spawn, setPorcelain } = await makePlugin(
      sibling,
      { setupScript: "setup.ps1", pathContains: "worktrees/" },
      vi.fn(),
      undefined,
      main,
      resolveSameCommon,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: main,
      callID: "call-sibling-samerepo-01",
      pre,
      post,
      exit: 0,
    });
    const text = resultText(output);
    expect(text).not.toMatch(/foreign|different repository|ajeno/i);
    expect(spawn).toHaveBeenCalledOnce();
    const { options, payload } = await readPayload(spawn);
    expect(payload.branchName).toBe(branch);
    expect(payload.worktreePath).toBe(`${baseMain}/${rel}`);
    expect(options.env.OPENCODE_WORKTREE_PATH).toBe(`${baseMain}/${rel}`);
    expect(text).toContain(`Worktree setup complete: ${branch}`);
  });

  it("distinguishes a failed pre-inventory capture instead of reducing it to missing pre-execution inventory", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
    );
    const command = "git worktree add ../worktrees/canonical-name";
    setPorcelain(new Error("git offline"));
    await hooks.before(shellEvent("call-prefail-01", command, srcDir));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const output: Record<string, unknown> = {
      ...shellEvent("call-prefail-01", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(output);
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).not.toMatch(/missing pre-execution inventory/i);
    expect(text).toMatch(/pre-(inventory|execution inventory)[\s\S]{0,80}(fail|could not|error)/i);
    expect(text).toContain(toSlashes(srcDir));
    expect(text).toMatch(/porcelain/i);
  });

  it("withholds all setup when a second call starts while the first still captures its repository identity", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const base = toSlashes(tmp).replace(/\/+$/, "");
    const commonMain = `${base}/.git`;
    const makeGate = () => {
      let release!: (value: string) => void;
      const promise = new Promise<string>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const gateA = makeGate();
    const gateB = makeGate();
    let commonCalls = 0;
    const resolveInterleaved = () => {
      commonCalls += 1;
      if (commonCalls === 1) return gateA.promise;
      if (commonCalls === 2) return gateB.promise;
      return commonMain;
    };
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      tmp,
      resolveInterleaved,
    );
    const command = "git worktree add ../worktrees/canonical-name";
    setPorcelain(porcelainMain(tmp));
    const beforeA = hooks.before(shellEvent("call-race-01", command, srcDir));
    const beforeB = hooks.before(shellEvent("call-race-02", command, srcDir));
    gateA.release(commonMain);
    await beforeA;
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const outputA: Record<string, unknown> = {
      ...shellEvent("call-race-01", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(outputA);
    gateB.release(commonMain);
    await beforeB;
    const outputB: Record<string, unknown> = {
      ...shellEvent("call-race-02", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(outputB);
    const textA = resultText(outputA);
    const textB = resultText(outputB);
    expect(spawn).not.toHaveBeenCalled();
    expect(textA).not.toContain("Worktree setup complete");
    expect(textB).not.toContain("Worktree setup complete");
    expect(textA).not.toContain("remember");
    expect(textB).not.toContain("remember");
    expect(`${textA}\n${textB}`).toMatch(/ambiguous|cannot be attributed|overlapping/i);
  });

  it("surfaces a failed prior repository capture with cwd instead of succeeding when later identity reads work", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const base = toSlashes(tmp).replace(/\/+$/, "");
    const commonMain = `${base}/.git`;
    let commonCalls = 0;
    const resolveFlaky = (): string => {
      commonCalls += 1;
      if (commonCalls === 1) throw new Error("common-dir offline");
      return commonMain;
    };
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      tmp,
      resolveFlaky,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-priorcommon-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/common-dir|identity/i);
    expect(text).toContain(toSlashes(srcDir));
    expect(text).toMatch(/porcelain/i);
  });

  it("treats an empty common-dir as a prior capture failure instead of a valid repository", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const resolveEmpty = () => "";
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      tmp,
      resolveEmpty,
    );
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-emptycommon-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/common-dir|identity/i);
    expect(text).toContain(toSlashes(srcDir));
    expect(text).toMatch(/porcelain/i);
  });

  it.each([
    [
      "a lost record separator",
      "call-badsep-01",
      () => porcelainMain(tmp),
      () =>
        porcelainWith(tmp, "worktrees/canonical-name", "canonical-name").replace(
          `branch refs/heads/main${NUL}${NUL}worktree`,
          `branch refs/heads/main${NUL}worktree`,
        ),
    ],
    [
      "a duplicate branch",
      "call-dupbranch-01",
      () => {
        const base = toSlashes(tmp).replace(/\/+$/, "");
        return (
          `${porcelainMain(tmp)}` +
          `worktree ${base}/stale-dup${NUL}HEAD sss111${NUL}branch refs/heads/dup-branch${NUL}${NUL}`
        );
      },
      () => {
        const base = toSlashes(tmp).replace(/\/+$/, "");
        return (
          `${porcelainMain(tmp)}` +
          `worktree ${base}/stale-dup${NUL}HEAD sss111${NUL}branch refs/heads/dup-branch${NUL}${NUL}` +
          `worktree ${base}/worktrees/dup-branch${NUL}HEAD ttt222${NUL}branch refs/heads/dup-branch${NUL}${NUL}`
        );
      },
    ],
  ])("treats porcelain with %s as unreadable without setup", async (_label, callID, buildPre, buildPost) => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: String(callID),
      pre: (buildPre as () => string)(),
      post: (buildPost as () => string)(),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/unreadable/i);
  });

  it("withholds all setup when a second call starts while the first still reads its post inventory", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    // Permite arrancar la segunda llamada solo cuando la primera ya está
    // suspendida en su lectura de inventario post (defer determinista).
    let noteDeferred!: () => void;
    const deferredReached = new Promise<void>((resolve) => {
      noteDeferred = resolve;
    });
    const { hooks, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      tmp,
      undefined,
      { index: 2, gate: postGate, onDeferred: noteDeferred },
    );
    const command = "git worktree add ../worktrees/canonical-name";
    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent("call-postrace-01", command, srcDir));
    const outputA: Record<string, unknown> = {
      ...shellEvent("call-postrace-01", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    const afterA = hooks.after(outputA);
    await deferredReached;
    await hooks.before(shellEvent("call-postrace-02", command, srcDir));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    releasePost();
    await afterA;
    const outputB: Record<string, unknown> = {
      ...shellEvent("call-postrace-02", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(outputB);
    const textA = resultText(outputA);
    const textB = resultText(outputB);
    expect(spawn).not.toHaveBeenCalled();
    expect(textA).not.toContain("Worktree setup complete");
    expect(textB).not.toContain("Worktree setup complete");
    expect(textA).not.toContain("remember");
    expect(textB).not.toContain("remember");
    expect(`${textA}\n${textB}`).toMatch(/ambiguous|cannot be attributed|overlapping/i);
  });

  it.each([
    [
      "a non-heads branch field",
      "call-badbranch-01",
      () => {
        const base = toSlashes(tmp).replace(/\/+$/, "");
        return (
          `${porcelainMain(tmp)}` +
          `worktree ${base}/worktrees/task${NUL}HEAD ttt222${NUL}branch refs/tags/v1${NUL}branch refs/heads/task${NUL}${NUL}`
        );
      },
    ],
    [
      "an empty branch",
      "call-emptybranch-01",
      () => {
        const base = toSlashes(tmp).replace(/\/+$/, "");
        return (
          `${porcelainMain(tmp)}` +
          `worktree ${base}/worktrees/task${NUL}HEAD ttt222${NUL}branch refs/heads/${NUL}${NUL}`
        );
      },
    ],
  ])("treats post porcelain with %s as unreadable without setup", async (_label, callID, buildPost) => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(hooks, setPorcelain, {
      command: "git worktree add ../worktrees/task",
      workdir: srcDir,
      callID: String(callID),
      pre: porcelainMain(tmp),
      post: (buildPost as () => string)(),
      exit: 0,
    });
    const text = resultText(output);
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/unreadable/i);
  });
});

/**
 * RED de los dos fallos silenciosos de worktree.ts confirmados en el review de
 * ff7a54f:
 *
 * 1. Un `after` con `status: "error"` retorna antes de retirar la captura
 *    `pending` de ese ID. La captura queda "ready" para siempre y cualquier
 *    comando `git worktree add` posterior se marca como solapamiento aunque no
 *    lo sea. El error debe ser terminal: se limpia la captura, no se fabrica
 *    result ni se toca el error original, y running/background se conservan.
 * 2. Si `ctx.session.get` falla en un `after` completed con captura `ready`, el
 *    plugin retorna en silencio al no poder resolver el cwd, sin explicar el
 *    setup omitido ni usar jamás el cwd del servidor como fallback.
 */
describe("OpenCode v2 worktree plugin: errores terminales y resolución de cwd", () => {
  it("un after status error es terminal: limpia la captura y un comando posterior sigue recibiendo setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const command = "git worktree add ../worktrees/canonical-name";
    const failedID = "call-status-error-01";

    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent(failedID, command, srcDir));

    const error = { message: "shell exploded", code: 7 };
    const errored: Record<string, unknown> = {
      ...shellEvent(failedID, command, srcDir),
      status: "error",
      error,
    };
    await hooks.after(errored);

    expect(errored.result, "no se fabrica un result en error").toBeUndefined();
    expect(errored.error, "error original preservado").toEqual(error);
    expect(errored.status, "el status sigue siendo error").toBe("error");

    // Segundo comando independiente: no debe heredar la captura del error
    // terminal como solapamiento permanente.
    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent("call-status-error-02", command, srcDir));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const output: Record<string, unknown> = {
      ...shellEvent("call-status-error-02", command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(output);
    const text = resultText(output);

    expect(text, "sin falso solapamiento").not.toMatch(
      /ambiguo|ambiguous|cannot be attributed|overlapping/i,
    );
    expect(spawn, "el setup del segundo comando sí corre").toHaveBeenCalledOnce();
    expect(text).toContain("Worktree setup complete: canonical-name");
  });

  it("un running/background no terminal conserva la captura para el completed del mismo ID", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { hooks, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const command = "git worktree add ../worktrees/canonical-name";
    const callID = "call-running-retained-01";

    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent(callID, command, srcDir));

    const running: Record<string, unknown> = {
      ...shellEvent(callID, command, srcDir),
      status: "running",
    };
    await hooks.after(running);
    expect(running.result, "running no fabrica un completed").toBeUndefined();

    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const completed: Record<string, unknown> = {
      ...shellEvent(callID, command, srcDir),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(completed);
    const text = resultText(completed);

    expect(text, "la captura del mismo ID sigue disponible").not.toMatch(
      /missing pre-execution inventory|ambiguous/i,
    );
    expect(spawn, "setup atribuido tras el completed real").toHaveBeenCalledOnce();
    expect(text).toContain("Worktree setup complete: canonical-name");
  });

  it("un fallo de session.get en after completed con captura válida explica el setup omitido sin cwd del servidor", async () => {
    // workdir relativo: sin sesión no hay cwd y no debe caer al cwd del servidor.
    const { hooks, ctx, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });

    const session = (ctx as { session: { get: (args: { sessionID: string }) => Promise<unknown> } })
      .session;
    const originalGet = session.get.bind(session);
    let lookups = 0;
    session.get = async (args: { sessionID: string }) => {
      lookups += 1;
      // Solo el after de la primera llamada falla; before y la llamada de
      // control posterior vuelven a resolver la sesión real.
      if (lookups === 2) throw new Error("session lookup failed");
      return originalGet(args);
    };

    const command = "git worktree add ../worktrees/canonical-name";
    const callID = "call-session-fail-01";
    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent(callID, command, "."));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));

    const output: Record<string, unknown> = {
      ...shellEvent(callID, command, "."),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(output);
    const text = resultText(output);

    expect(spawn, "sin cwd resoluble no hay fallback al cwd del servidor").not.toHaveBeenCalled();
    expect(text, "el setup omitido es visible").toMatch(/setup[\s\S]{0,80}(omit|skip|omitido)/i);
    expect(text, "explica la causa de sesión/directorio").toMatch(/session|directory|cwd|workdir/i);
    expect(text).not.toContain("Worktree setup complete");

    // La captura fallida se limpia: un comando posterior no queda solapado.
    setPorcelain(porcelainMain(tmp));
    await hooks.before(shellEvent("call-session-fail-02", command, "."));
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const next: Record<string, unknown> = {
      ...shellEvent("call-session-fail-02", command, "."),
      status: "completed",
      result: makeResult(0),
    };
    await hooks.after(next);
    const nextText = resultText(next);
    expect(nextText, "sin falso solapamiento tras limpiar la captura").not.toMatch(
      /ambiguous|cannot be attributed|overlapping/i,
    );
    expect(nextText).toContain("Worktree setup complete: canonical-name");
  });
});
