import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePlugin } from "../stack/plugins/opencode/worktree.js";

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
  appLog = vi.fn(),
  gitRoot: string | Error = root,
  resolveCommonDir?: (cwd: string) => string | Error | Promise<string | Error>,
  deferPorcelain?: { index: number; gate: Promise<unknown> },
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
  const $ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = Array.isArray(strings) ? strings.join("") : String(strings);
    const isPorcelainQuery = raw.includes("worktree list");
    const isCommonDirQuery = raw.includes("--git-common-dir");
    const isRevParseQuery = raw.includes("rev-parse");
    if (isPorcelainQuery) {
      if (!raw.includes("--porcelain -z")) {
        throw new Error(`expected --porcelain -z query, got: ${raw}`);
      }
      const r: any = {
        text: async () => {
          porcelainCalls += 1;
          if (deferPorcelain && porcelainCalls === deferPorcelain.index) {
            await deferPorcelain.gate;
          }
          if (currentPorcelain instanceof Error) throw currentPorcelain;
          return currentPorcelain;
        },
      };
      r.quiet = () => r;
      return r;
    }
    if (isCommonDirQuery) {
      const cwd =
        typeof values[0] === "string" && values[0] ? toSlashes(String(values[0])) : toSlashes(root);
      const r: any = {
        text: async () => {
          const resolved = await resolveCommon(cwd);
          if (resolved instanceof Error) throw resolved;
          return `${resolved}\n`;
        },
      };
      r.quiet = () => r;
      return r;
    }
    if (isRevParseQuery) {
      const r: any = {
        text: async () => {
          if (gitRoot instanceof Error) throw gitRoot;
          return `${gitRoot}\n`;
        },
      };
      r.quiet = () => r;
      return r;
    }
    throw new Error(`unexpected git query: ${raw}`);
  }) as any;
  const client = { app: { log: appLog } };
  const plugin = await WorktreePlugin({ $, client, directory: root } as any);
  return { plugin, spawn, appLog, setPorcelain };
};

const runLifecycle = async (
  plugin: any,
  setPorcelain: (value: string) => void,
  opts: {
    command: string;
    workdir: string;
    callID: string;
    pre: string;
    post: string;
    exit?: number;
  },
) => {
  const inputBase = {
    tool: "bash",
    sessionID: SESSION_ID,
    callID: opts.callID,
    args: { command: opts.command, workdir: opts.workdir },
  };
  setPorcelain(opts.pre);
  if (typeof plugin["tool.execute.before"] === "function") {
    await plugin["tool.execute.before"]({ ...inputBase }, {});
  }
  setPorcelain(opts.post);
  const output: any = {
    title: "git worktree add",
    output: "",
    metadata: {
      output: "",
      truncated: false,
      description: "git worktree add",
    },
  };
  if (opts.exit !== undefined) {
    output.metadata.exit = opts.exit;
  }
  await plugin["tool.execute.after"]({ ...inputBase }, output);
  return output;
};

const runAfterOnly = async (
  plugin: any,
  opts: { command: string; workdir: string; callID: string; exit: number },
) => {
  const input = {
    tool: "bash",
    sessionID: SESSION_ID,
    callID: opts.callID,
    args: { command: opts.command, workdir: opts.workdir },
  };
  const output: any = {
    title: "git worktree add",
    output: "",
    metadata: {
      output: "",
      exit: opts.exit,
      truncated: false,
      description: "git worktree add",
    },
  };
  await plugin["tool.execute.after"](input, output);
  return output;
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

describe("WorktreePlugin", () => {
  it("does not run setup when project worktree config is absent", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, null);
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-absent-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toBe("");
  });

  it("still warns for a non-canonical worktree path when config is absent", async () => {
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, null);
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-absent-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toContain("Worktree path is not canonical");
    expect(String(output.output ?? "")).toContain(canonicalExpected(tmp, "outside-name"));
  });

  it("reports invalid worktree config without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, "{");
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-invalid-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toMatch(/could not be parsed as JSON/i);
  });

  it("reports invalid config and a non-canonical worktree path without spawning setup", async () => {
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, "{");
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-invalid-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toMatch(/could not be parsed as JSON/i);
    expect(String(output.output ?? "")).toContain("Worktree path is not canonical");
    expect(String(output.output ?? "")).toContain("Use the project-local path instead");
  });

  it("reports unreadable worktree config separately from malformed JSON", async () => {
    const configReadError = Object.assign(new Error("access denied"), {
      code: "EACCES",
    });
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, configReadError);
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: tmp,
      callID: "call-unreadable-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toMatch(/could not be read/i);
    expect(String(output.output ?? "")).not.toMatch(/parsed.*JSON/i);
  });

  it("keeps a git root failure actionable when OpenCode logging rejects", async () => {
    const appLog = vi.fn().mockRejectedValue(new Error("OpenCode log unavailable"));
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {},
      vi.fn(),
      undefined,
      appLog,
      new Error("git is unavailable"),
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add worktrees/canonical-name",
      workdir: tmp,
      callID: "call-gitroot-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(appLog).toHaveBeenCalledOnce();
    expect(String(output.output ?? "")).toMatch(/git rev-parse --show-toplevel/i);
  });

  it("reports a non-string setupScript without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, { setupScript: 42 });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-setupscript-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toMatch(/setupScript.*string/i);
  });

  it.each([
    ["an array config root", [], /config.*object/i],
    ['a non-string "docsReminderScript"', { docsReminderScript: true }, /docsReminderScript.*string/i],
    ['a non-string "pathContains"', { pathContains: 42 }, /pathContains.*string/i],
    ['a non-string "reminderLines" entry', { reminderLines: [42] }, /reminderLines.*string/i],
  ])("reports %s without spawning setup", async (_description, config, expectedError) => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, config);
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: `call-invalid-each-${String(_description).slice(0, 12)}`,
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toMatch(expectedError);
    expect(String(output.output ?? "")).not.toContain("Worktree setup complete");
  });

  it("keeps an unsupported setup failure visible when OpenCode logging rejects", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const appLog = vi.fn().mockRejectedValue(new Error("OpenCode log unavailable"));
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      { setupScript: "setup.txt" },
      vi.fn(),
      undefined,
      appLog,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-unsupported-log-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(appLog).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toContain("Worktree setup failed for canonical-name.");
    expect(String(output.output ?? "")).toMatch(/unsupported.*extension/i);
    expect(String(output.output ?? "")).not.toContain("Worktree setup complete");
  });

  it("runs explicitly configured setup for a canonical worktree path resolved from command cwd", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees\\",
    });
    const output = await runLifecycle(plugin, setPorcelain, {
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
    expect(String(output.output ?? "")).toContain("Worktree setup complete: canonical-name");
  });

  it("reports an explicitly configured setup failure without reporting success", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      { setupScript: "setup.ps1" },
      vi.fn(),
      {
        stdout: "",
        stderr: "setup exploded",
        exited: Promise.resolve(1),
      },
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-setup-fail-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).toHaveBeenCalledOnce();
    expect(String(output.output ?? "")).toContain("Worktree setup failed for canonical-name.");
    expect(String(output.output ?? "")).toContain("setup exploded");
    expect(String(output.output ?? "")).not.toContain("Worktree setup complete");
  });

  it("reports an unsupported explicit setup extension as a failure", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, { setupScript: "setup.txt" });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-unsupported-ext-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toContain("Worktree setup failed for canonical-name.");
    expect(String(output.output ?? "")).toMatch(/unsupported.*extension/i);
    expect(String(output.output ?? "")).not.toContain("Worktree setup complete");
  });

  it("ignores legacy branchPrefix config and keeps branchName equal to worktreeName", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output = await runLifecycle(plugin, setPorcelain, {
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
    expect(String(output.output ?? "")).toContain("Worktree setup complete: canonical-name");
  });

  it("passes feature-pr01 as branchName for a multi-PR worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp);
    const output = await runLifecycle(plugin, setPorcelain, {
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
    expect(String(output.output ?? "")).toContain("Worktree setup complete: feature-pr01");
  });

  it("ignores legacy branchPrefix config for multi-PR worktrees", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output = await runLifecycle(plugin, setPorcelain, {
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
    expect(String(output.output ?? "")).toContain("Worktree setup complete: feature-pr01");
  });

  it("warns and skips setup for non-canonical worktree paths", async () => {
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp);
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add "${path.join(tmp, "outside-name")}"`,
      workdir: tmp,
      callID: "call-noncanonical-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "outside-name", "outside-name"),
      exit: 0,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(String(output.output ?? "")).toContain("Worktree path is not canonical");
    expect(String(output.output ?? "")).toContain(canonicalExpected(tmp, "outside-name"));
  });

  it("keeps full branch identity for canonical -b without false warning", async () => {
    const branch = "codex/feature";
    const rel = "worktrees/codex/feature";
    const command = `git worktree add -b ${branch} ${rel}`;
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command,
      workdir: tmp,
      callID: "call-red-b-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, rel, branch),
      exit: 0,
    });
    const text = String(output.output ?? output.content ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command,
      workdir: srcDir,
      callID: "call-red-exit-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 1,
    });
    const text = String(output.output ?? output.content ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup/reminders/success without a single new worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const command = "git worktree add ../worktrees/canonical-name";
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command,
      workdir: srcDir,
      callID: "call-red-ambiguous-01",
      pre: porcelainMain(tmp),
      post: porcelainMain(tmp),
      exit: 0,
    });
    const text = String(output.output ?? output.content ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup when Bash metadata exit is missing", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add -- ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-missing-exit-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/missing exit code/i);
    expect(text).toMatch(/skipping worktree setup/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup when multiple worktrees appear between inventories", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git -C ${srcDir} worktree add ../worktrees/canonical-name`,
      workdir: srcDir,
      callID: "call-multiple-01",
      pre: porcelainMain(tmp),
      post: porcelainMultiple(tmp),
      exit: 0,
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/expected 1 new worktree, found 2/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("withholds setup for a detached worktree without fabricating a branch", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/detached-wt",
      workdir: srcDir,
      callID: "call-detached-01",
      pre: porcelainMain(tmp),
      post: porcelainDetached(tmp, "worktrees/detached-wt"),
      exit: 0,
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).toMatch(/detached/i);
    expect(text).toMatch(/skipping setup/i);
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
  });

  it("fails closed with missing pre-execution inventory when before did not capture", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runAfterOnly(plugin, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-missing-pre-01",
      exit: 0,
    });
    const text = String(output.output ?? "");
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

    const { plugin, spawn, setPorcelain } = await makePlugin(
      repo,
      { setupScript: "setup.ps1", pathContains: "worktrees/" },
      vi.fn(),
      undefined,
      vi.fn(),
      realRoot,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: repo,
      callID: "call-real-git-01",
      pre,
      post,
      exit: 0,
    });
    const text = String(output.output ?? "");

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
    const { plugin, spawn, setPorcelain } = await makePlugin(spaceRoot, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add "${rel}"`,
      workdir: spaceRoot,
      callID: "call-quoted-space-01",
      pre,
      post,
      exit: 0,
    });
    const text = String(output.output ?? "");

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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      repoA,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      vi.fn(),
      repoB,
      resolveForeignCommon,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: repoB,
      callID: "call-foreign-01",
      pre: porcelainMain(repoB),
      post: porcelainWith(repoB, rel, branch),
      exit: 0,
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/foreign|different repository|ajeno/i);
  });

  it("withholds all setup when two overlapping calls share the same pre-inventory", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const command = "git worktree add ../worktrees/canonical-name";
    const input1 = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-overlap-01",
      args: { command, workdir: srcDir },
    };
    const input2 = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-overlap-02",
      args: { command, workdir: srcDir },
    };
    setPorcelain(porcelainMain(tmp));
    await plugin["tool.execute.before"]({ ...input1 }, {});
    await plugin["tool.execute.before"]({ ...input2 }, {});
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const output1: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    const output2: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    await plugin["tool.execute.after"]({ ...input1 }, output1);
    await plugin["tool.execute.after"]({ ...input2 }, output2);
    const text1 = String(output1.output ?? "");
    const text2 = String(output2.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-malformed-pre-01",
      pre: malformedPre,
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/unreadable/i);
  });

  it("rejects a worktrees-evil prefix collision as non-canonical without setup", async () => {
    const branch = "canonical-name";
    const evilRel = "worktrees-evil/canonical-name";
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add "${path.join(tmp, evilRel)}"`,
      workdir: tmp,
      callID: "call-evil-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, evilRel, branch),
      exit: 0,
    });
    const text = String(output.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      sibling,
      { setupScript: "setup.ps1", pathContains: "worktrees/" },
      vi.fn(),
      undefined,
      vi.fn(),
      main,
      resolveSameCommon,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: `git worktree add ${rel}`,
      workdir: main,
      callID: "call-sibling-samerepo-01",
      pre,
      post,
      exit: 0,
    });
    const text = String(output.output ?? "");
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
    const appLog = vi.fn().mockRejectedValue(new Error("OpenCode log unavailable"));
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      appLog,
    );
    const command = "git worktree add ../worktrees/canonical-name";
    const input = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-prefail-01",
      args: { command, workdir: srcDir },
    };
    setPorcelain(new Error("git offline"));
    await plugin["tool.execute.before"]({ ...input }, {});
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const output: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    await plugin["tool.execute.after"]({ ...input }, output);
    const text = String(output.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      vi.fn(),
      tmp,
      resolveInterleaved,
    );
    const command = "git worktree add ../worktrees/canonical-name";
    const inputA = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-race-01",
      args: { command, workdir: srcDir },
    };
    const inputB = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-race-02",
      args: { command, workdir: srcDir },
    };
    setPorcelain(porcelainMain(tmp));
    const beforeA = plugin["tool.execute.before"]({ ...inputA }, {});
    const beforeB = plugin["tool.execute.before"]({ ...inputB }, {});
    gateA.release(commonMain);
    await beforeA;
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    const outputA: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    await plugin["tool.execute.after"]({ ...inputA }, outputA);
    gateB.release(commonMain);
    await beforeB;
    const outputB: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    await plugin["tool.execute.after"]({ ...inputB }, outputB);
    const textA = String(outputA.output ?? "");
    const textB = String(outputB.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      vi.fn(),
      tmp,
      resolveFlaky,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-priorcommon-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = String(output.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      vi.fn(),
      tmp,
      resolveEmpty,
    );
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: "call-emptycommon-01",
      pre: porcelainMain(tmp),
      post: porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"),
      exit: 0,
    });
    const text = String(output.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/canonical-name",
      workdir: srcDir,
      callID: String(callID),
      pre: (buildPre as () => string)(),
      post: (buildPost as () => string)(),
      exit: 0,
    });
    const text = String(output.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(
      tmp,
      {
        setupScript: "setup.ps1",
        pathContains: "worktrees/",
        reminderLines: ["remember {branchName}"],
      },
      vi.fn(),
      undefined,
      vi.fn(),
      tmp,
      undefined,
      { index: 2, gate: postGate },
    );
    const command = "git worktree add ../worktrees/canonical-name";
    const inputA = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-postrace-01",
      args: { command, workdir: srcDir },
    };
    const inputB = {
      tool: "bash",
      sessionID: SESSION_ID,
      callID: "call-postrace-02",
      args: { command, workdir: srcDir },
    };
    setPorcelain(porcelainMain(tmp));
    await plugin["tool.execute.before"]({ ...inputA }, {});
    const outputA: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    const afterA = plugin["tool.execute.after"]({ ...inputA }, outputA);
    await plugin["tool.execute.before"]({ ...inputB }, {});
    setPorcelain(porcelainWith(tmp, "worktrees/canonical-name", "canonical-name"));
    releasePost();
    await afterA;
    const outputB: any = {
      title: "git worktree add",
      output: "",
      metadata: { output: "", exit: 0, truncated: false, description: "git worktree add" },
    };
    await plugin["tool.execute.after"]({ ...inputB }, outputB);
    const textA = String(outputA.output ?? "");
    const textB = String(outputB.output ?? "");
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
    const { plugin, spawn, setPorcelain } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees/",
      reminderLines: ["remember {branchName}"],
    });
    const output = await runLifecycle(plugin, setPorcelain, {
      command: "git worktree add ../worktrees/task",
      workdir: srcDir,
      callID: String(callID),
      pre: porcelainMain(tmp),
      post: (buildPost as () => string)(),
      exit: 0,
    });
    const text = String(output.output ?? "");
    expect(spawn).not.toHaveBeenCalled();
    expect(text).not.toContain("Worktree setup complete");
    expect(text).not.toContain("remember");
    expect(text).toMatch(/unreadable/i);
  });
});
