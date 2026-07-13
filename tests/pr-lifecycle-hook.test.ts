import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../stack/scripts/post-pr-review.cjs", import.meta.url),
);

const runHook = (command: string | string[], openCode = false) =>
  spawnSync(process.execPath, [script], {
    encoding: "utf8",
    input: JSON.stringify(
      openCode
        ? { tool: "bash", args: { command }, directory: process.cwd() }
        : { tool_name: "shell", tool_input: { command }, cwd: process.cwd() },
    ),
  });

describe("PR lifecycle hook", () => {
  it("keeps a newly created draft open for further development", () => {
    const result = runHook("gh pr create --draft --title test");
    const output = result.stdout;

    expect(result.status).toBe(0);
    expect(output).toContain("<pr-draft-created>");
    expect(output).toContain("Keep the PR in draft");
    expect(output).toContain("Do not mark it ready yet");
    expect(output).not.toContain("post-pr-review-required");
  });

  it("flags a PR created without --draft and tells the agent to undo ready", () => {
    const output = runHook(["gh", "pr", "create", "--title", "test"]).stdout;

    expect(output).toContain("<pr-created-ready-violation>");
    expect(output).toContain("gh pr ready --undo");
  });

  it("allows changes again after returning a ready PR to draft", () => {
    const output = runHook("gh pr ready --undo 123").stdout;

    expect(output).toContain("<pr-returned-to-draft>");
    expect(output).toContain("Repeat the local verification and final review");
  });

  it("requires gates for the final SHA after marking the PR ready", () => {
    const output = runHook("gh pr ready 123").stdout;

    expect(output).toContain("<pr-ready-gates-required>");
    expect(output).toContain("gh pr checks 123");
    expect(output).toContain("latest commit");
    expect(output).toContain("Do not push while the PR is ready");
  });

  it("uses stderr for the OpenCode bridge", () => {
    const result = runHook("gh pr ready 123", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("<pr-ready-gates-required>");
  });

  it("ignores unrelated commands", () => {
    const result = runHook("gh pr view 123");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
