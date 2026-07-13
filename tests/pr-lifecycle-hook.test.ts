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
    timeout: 1_000,
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
    ["shell", "gh --repo owner/repo pr ready 48"],
    ["shell", "gh -R owner/repo pr create --draft"],
    ["PowerShell", '& "gh" pr ready 48'],
    ["PowerShell", '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr ready 48'],
    ["PowerShell", '"gh.exe" pr create --draft'],
    ["shell", "echo prep\ngh pr ready 48"],
    ["PowerShell", "Write-Output prep\r\ngh pr create --draft"],
    ["shell", "gh pr -R owner/repo ready 48"],
    ["shell", "gh pr --repo owner/repo create --draft"],
    ["shell", ["gh", "pr", "--repo=owner/repo", "ready", "48"]],
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
    expect(context).toContain("If the project has PR checks configured");
    expect(context).toContain("If no PR checks are configured");
    expect(context).toContain("does not block the merge");
    expect(context).toContain("An empty `gh pr checks` result immediately after ready is not evidence");
    expect(context).toContain("Immediately before reporting or merging");
    expect(context).toContain("gh pr view --json headRefOid");
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

  it.each([
    "gh pr view 123",
    'echo "x; gh pr ready 48"',
    "Write-Output 'x; gh pr create --draft'",
    "gh --help pr ready 48",
    `gh ${Array.from({ length: 20 }, () => "--flag").join(" ")} pr view`,
  ])("ignores unrelated command without stalling: %s", (command) => {
    const result = runHook(shellPayload("shell", command));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
