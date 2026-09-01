import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePlugin } from "../stack/plugins/opencode/worktree.js";

let tmp: string;

const toSlashes = (value: string) => value.replace(/\\/g, "/");

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
) => {
  vi.stubGlobal("Bun", {
    file: () => ({
      text: async () => {
        if (config === null) throw new Error("Config not found");
        if (typeof config === "string") return config;
        if (Array.isArray(config)) return JSON.stringify(config);
        return JSON.stringify({
          setupScript: "setup.ps1",
          pathContains: "worktrees\\",
          ...(config as Record<string, unknown>),
        });
      },
    }),
    spawn: spawn.mockReturnValue(spawnResult),
  });

  const dollar = (() => {
    const r: any = { text: async () => `${root}\n` };
    r.quiet = () => r;
    return r;
  }) as any;
  const $ = ((strings: TemplateStringsArray) => dollar(strings)) as any;
  const client = { app: { log: appLog } };
  const plugin = await WorktreePlugin({ $, client, directory: root } as any);
  return { plugin, spawn, appLog };
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
    const { plugin, spawn } = await makePlugin(tmp, null);
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output).toEqual({});
  });

  it("still warns for a non-canonical worktree path when config is absent", async () => {
    const { plugin, spawn } = await makePlugin(tmp, null);
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: `git worktree add "${path.join(tmp, "outside-name")}"`,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toContain("Worktree path is not canonical");
    expect(output.output).toContain(`${toSlashes(tmp).replace(/\/+$/, "")}/worktrees/outside-name`);
  });

  it("reports invalid worktree config without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, "{");
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toEqual(expect.stringMatching(/config/i));
  });

  it("reports a non-string setupScript without spawning setup", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, { setupScript: 42 });
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toEqual(expect.stringMatching(/setupScript.*string/i));
  });

  it.each([
    ["an array config root", [], /config.*object/i],
    ['a non-string "docsReminderScript"', { docsReminderScript: true }, /docsReminderScript.*string/i],
    ['a non-string "pathContains"', { pathContains: 42 }, /pathContains.*string/i],
    ['a non-string "reminderLines" entry', { reminderLines: [42] }, /reminderLines.*string/i],
  ])("reports %s without spawning setup", async (_description, config, expectedError) => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, config);
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toEqual(expect.stringMatching(expectedError));
    expect(output.output).not.toContain("Worktree setup complete");
  });

  it("keeps an unsupported setup failure visible when OpenCode logging rejects", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const appLog = vi.fn().mockRejectedValue(new Error("OpenCode log unavailable"));
    const { plugin, spawn } = await makePlugin(
      tmp,
      { setupScript: "setup.txt" },
      vi.fn(),
      undefined,
      appLog,
    );
    const output: Record<string, string> = {};

    await expect(
      plugin["tool.execute.after"](
        {
          tool: "bash",
          args: {
            command: "git worktree add ../worktrees/canonical-name",
            workdir: srcDir,
          },
        },
        output,
      ),
    ).resolves.toBeUndefined();

    expect(appLog).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toContain("Worktree setup failed for canonical-name.");
    expect(output.output).toMatch(/unsupported.*extension/i);
    expect(output.output).not.toContain("Worktree setup complete");
  });

  it("runs explicitly configured setup for a canonical worktree path resolved from command cwd", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, {
      setupScript: "setup.ps1",
      pathContains: "worktrees\\",
    });
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    const expectedPath = `${toSlashes(tmp).replace(/\/+$/, "")}/worktrees/canonical-name`;
    expect(spawn).toHaveBeenCalledOnce();
    const [, options] = spawn.mock.calls[0]!;
    const payload = JSON.parse(await (options as { stdin: Response }).stdin.text()) as Record<string, string>;

    expect((options as { env: Record<string, string> }).env.OPENCODE_WORKTREE_PATH).toBe(expectedPath);
    expect(payload.worktreeName).toBe("canonical-name");
    expect(payload.branchName).toBe("canonical-name");
    expect(spawn.mock.calls[0]![0]).toContain(expectedPath);
    expect(output.output).toContain("Worktree setup complete: canonical-name");
  });

  it("reports an explicitly configured setup failure without reporting success", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(
      tmp,
      { setupScript: "setup.ps1" },
      vi.fn(),
      {
        stdout: "",
        stderr: "setup exploded",
        exited: Promise.resolve(1),
      },
    );
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).toHaveBeenCalledOnce();
    expect(output.output).toContain("Worktree setup failed for canonical-name.");
    expect(output.output).toContain("setup exploded");
    expect(output.output).not.toContain("Worktree setup complete");
  });

  it("reports an unsupported explicit setup extension as a failure", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, { setupScript: "setup.txt" });
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toContain("Worktree setup failed for canonical-name.");
    expect(output.output).toMatch(/unsupported.*extension/i);
    expect(output.output).not.toContain("Worktree setup complete");
  });

  it("ignores legacy branchPrefix config and keeps branchName equal to worktreeName", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/canonical-name",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).toHaveBeenCalledOnce();
    const [, options] = spawn.mock.calls[0]!;
    const payload = JSON.parse(await (options as { stdin: Response }).stdin.text()) as Record<string, string>;

    expect((options as { env: Record<string, string> }).env.OPENCODE_WORKTREE_PATH).toBe(
      `${toSlashes(tmp).replace(/\/+$/, "")}/worktrees/canonical-name`,
    );
    expect(payload.worktreeName).toBe("canonical-name");
    expect(payload.branchName).toBe("canonical-name");
    expect(output.output).toContain("Worktree setup complete: canonical-name");
  });

  it("passes feature-pr01 as branchName for a multi-PR worktree", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp);
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/feature-pr01",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).toHaveBeenCalledOnce();
    const [, options] = spawn.mock.calls[0]!;
    const payload = JSON.parse(await (options as { stdin: Response }).stdin.text()) as Record<string, string>;

    expect((options as { env: Record<string, string> }).env.OPENCODE_WORKTREE_PATH).toBe(
      `${toSlashes(tmp).replace(/\/+$/, "")}/worktrees/feature-pr01`,
    );
    expect(payload.worktreeName).toBe("feature-pr01");
    expect(payload.branchName).toBe("feature-pr01");
    expect(output.output).toContain("Worktree setup complete: feature-pr01");
  });

  it("ignores legacy branchPrefix config for multi-PR worktrees", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp, { branchPrefix: "feature/" });
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: "git worktree add ../worktrees/feature-pr01",
          workdir: srcDir,
        },
      },
      output,
    );

    expect(spawn).toHaveBeenCalledOnce();
    const [, options] = spawn.mock.calls[0]!;
    const payload = JSON.parse(await (options as { stdin: Response }).stdin.text()) as Record<string, string>;

    expect(payload.worktreeName).toBe("feature-pr01");
    expect(payload.branchName).toBe("feature-pr01");
    expect(output.output).toContain("Worktree setup complete: feature-pr01");
  });

  it("warns and skips setup for non-canonical worktree paths", async () => {
    const { plugin, spawn } = await makePlugin(tmp);
    const output: Record<string, string> = {};

    await plugin["tool.execute.after"](
      {
        tool: "bash",
        args: {
          command: `git worktree add "${path.join(tmp, "outside-name")}"`,
        },
      },
      output,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(output.output).toContain("Worktree path is not canonical");
    expect(output.output).toContain(`${toSlashes(tmp).replace(/\/+$/, "")}/worktrees/outside-name`);
  });
});
