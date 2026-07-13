import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../stack/scripts/post-pr-review.cjs", import.meta.url),
);

const runHook = (payload: unknown) =>
  spawnSync(process.execPath, [script], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });

const shellPayload = (toolName: string, command: string | string[]) => ({
  tool_name: toolName,
  tool_input: { command },
  cwd: process.cwd(),
});

const parseContext = (stdout: string) => {
  const parsed = JSON.parse(stdout);
  expect(parsed.hookSpecificOutput).toEqual({
    hookEventName: "PostToolUse",
    additionalContext: parsed.additionalContext,
  });
  return parsed.additionalContext as string;
};

describe("PR lifecycle hook", () => {
  it.each([
    ["Bash", "gh pr create --draft --title test"],
    ["PowerShell", 'gh pr create --title "Why --draft matters"'],
    ["shell", ["gh", "pr", "create", "--title", "test"]],
    ["local_shell", "gh pr ready --undo 123"],
    ["shell", "gh pr create --draft && gh pr ready 123"],
    ["PowerShell", "gh.exe pr ready https://github.com/foo2/repo/pull/48"],
  ])("requires checking actual PR state for %s: %j", (toolName, command) => {
    const result = runHook(shellPayload(toolName as string, command as string | string[]));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const context = parseContext(result.stdout);
    expect(context).toContain("<pr-lifecycle-state-required>");
    expect(context).toContain("command was attempted");
    expect(context).toContain("gh pr view --json number,isDraft,headRefOid");
    expect(context).toContain("gh pr ready --undo <number>");
    expect(context).toContain("gh pr checks <number>");
    expect(context).not.toContain("was created correctly");
    expect(context).not.toContain("is now ready");
  });

  it("uses stderr for the OpenCode bridge", () => {
    const result = runHook({
      tool: "bash",
      args: { command: "gh.exe pr ready 123" },
      directory: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("<pr-lifecycle-state-required>");
  });

  it("ignores unrelated commands", () => {
    const result = runHook(shellPayload("shell", "gh pr view 123"));

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
