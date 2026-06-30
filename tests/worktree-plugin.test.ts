import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePlugin } from "../stack/plugins/opencode/worktree.js";

let tmp: string;

const toSlashes = (value: string) => value.replace(/\\/g, "/");

const makePlugin = async (root: string, spawn = vi.fn()) => {
  vi.stubGlobal("Bun", {
    file: () => ({
      text: async () => JSON.stringify({
        setupScript: "setup.ps1",
        pathContains: "worktrees\\",
        branchPrefix: "",
      }),
    }),
    spawn: spawn.mockReturnValue({
      stdout: "setup ok",
      stderr: "",
      exited: Promise.resolve(0),
    }),
  });

  const dollar = (() => { const r: any = { text: async () => `${root}\n` }; r.quiet = () => r; return r; }) as any;
  const client = { app: { log: vi.fn() } };
  const plugin = await WorktreePlugin({ $, client, directory: root } as any);
  return { plugin, spawn };

  function $(strings: TemplateStringsArray) {
    return dollar(strings);
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-worktree-plugin-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("WorktreePlugin", () => {
  it("runs setup for a canonical worktree path resolved from command cwd", async () => {
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    const { plugin, spawn } = await makePlugin(tmp);
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
    expect(spawn.mock.calls[0]![1].env.OPENCODE_WORKTREE_PATH).toBe(expectedPath);
    expect(spawn.mock.calls[0]![0]).toContain(expectedPath);
    expect(output.output).toContain("Worktree setup complete: canonical-name");
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
