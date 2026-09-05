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
    ["Bash", "gh pr create --title test"],
    ["PowerShell", 'gh pr create --title "Why --draft matters"'],
    ["shell", ["gh", "pr", "create", "--title", "test"]],
    ["local_shell", "gh pr ready 123"],
    ["shell", "gh pr create --draft && gh pr ready 123"],
    ["PowerShell", "gh.exe pr ready https://github.com/foo2/repo/pull/48"],
    ["shell", "gh --repo owner/repo pr ready 48"],
    ["shell", "gh -R owner/repo pr create --draft=false"],
    ["PowerShell", '& "gh" pr ready 48'],
    ["PowerShell", '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr ready 48'],
    ["PowerShell", '"gh.exe" pr create --title test'],
    ["shell", "echo prep\ngh pr ready 48"],
    ["PowerShell", "Write-Output prep\r\ngh pr create --title test"],
    ["shell", "gh pr -R owner/repo ready 48"],
    ["shell", "gh pr --repo owner/repo create --title test"],
    ["shell", ["gh", "pr", "--repo=owner/repo", "ready", "48"]],
    ["shell", "gh pr ready --undo=false 48"],
    ["shell", "gh pr create -d=false --title test"],
    ["shell", 'gh pr create --title "--draft"'],
    ["shell", 'gh pr create --body "--draft=1" --title test'],
    ["shell", "gh pr create --draft --draft=false --title test"],
    ["shell", "gh pr ready --undo --undo=false 48"],
    ["shell", "gh pr new --title test"],
  ])("guards a PR readiness transition for %s: %j", (toolName, command) => {
    const result = runHook(shellPayload(toolName as string, command as string | string[]));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const context = parseContext(result.stdout);
    expect(context).toContain("<pr-lifecycle-state-required>");
    expect(context).toContain("readiness transition was attempted");
    expect(context).toContain("gh pr view --json number,isDraft,headRefOid");
    expect(context).toMatch(/reliable review coverage is missing.+portable `xreview` skill.+exact diff/is);
    expect(context).toMatch(/fix-check.+delta-review.+full review/is);
    expect(context).toMatch(/previously clean role reopens.+dependencies or risks change/is);
    expect(context).toContain("gh pr ready --undo <number>");
    expect(context).toContain("gh pr checks <number>");
    expect(context).toContain("If the project has PR checks configured");
    expect(context).toContain("If no PR checks are configured");
    expect(context).toContain("does not block the merge");
    expect(context).toContain("An empty `gh pr checks` result immediately after ready is not evidence");
    expect(context).toContain("Immediately before reporting or merging");
    expect(context).toContain("gh pr view --json headRefOid");
    expect(context).toContain("same head alone does not preserve review coverage");
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
    "gh pr create --draft --title test",
    "gh pr create -d --title test",
    "gh pr create --draft=true --title test",
    "gh pr create --draft=t --title test",
    "gh pr create --draft=1 --title test",
    "gh pr create -d=true --title test",
    "gh pr create -d=t --title test",
    "gh pr create -d=1 --title test",
    "gh pr ready --undo 48",
    "gh pr ready --undo=true 48",
    "gh pr ready --undo=t 48",
    "gh pr ready --undo=1 48",
    "gh pr create --draft=false --draft --title test",
    "gh pr ready --undo=false --undo 48",
    "gh pr new --draft --title test",
    "gh -R owner/repo pr create --draft",
    "gh pr --repo owner/repo create --draft",
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
