#!/usr/bin/env node
/**
 * Global PostToolUse guardrail for the PR draft → ready lifecycle.
 *
 * The historical filename is intentionally preserved so sync can migrate the
 * existing hook entry instead of leaving an orphan in user configuration.
 * The hook never infers success or PR state from command text: PostToolUse
 * payloads are not consistent enough across runtimes to prove either.
 *
 * Payload compatibility (stdin JSON):
 * - Claude Code hooks: { tool_name: "Bash", tool_input: { command: "..." }, cwd }
 * - Codex hooks:       { tool_name: "shell", tool_input: { command: [...] }, cwd }
 * - OpenCode bridge:   { tool: "bash", args: { command: "..." }, directory }
 *
 * Output uses one channel per runtime and the script always exits 0.
 */

function writeWarning(message) {
  process.stderr.write(`post-pr-review: warning: ${message}\n`);
}

const shellValue = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)`;
const ghExecutable = String.raw`(?:"(?:[^"\r\n]*[\\/])?gh(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?gh(?:\.exe)?'|(?:[^\s"';&|]*[\\/])?gh(?:\.exe)?)`;
const globalOption = String.raw`-{1,2}[\w-]+(?:=${shellValue})?(?:\s+${shellValue})?`;
const prLifecycleCommand = new RegExp(
  String.raw`(?:^|(?:&&|\|\||[;&|])\s*)${ghExecutable}(?:\s+${globalOption})*\s+pr\s+(?:create|ready)\b`,
  "i",
);

function isPrLifecycleCommand(command) {
  return prLifecycleCommand.test(command);
}

const message = `<pr-lifecycle-state-required>
A \`gh pr create\` or \`gh pr ready\` command was attempted. Do not infer success or PR state from the command text. Resolve the current PR and run \`gh pr view --json number,isDraft,headRefOid\` before the next action.

- If the PR should still be under development, it must be draft. If it is ready, run \`gh pr ready --undo <number>\` before any change or push.
- While draft, finish code, the applicable version bump, local tests, \`pnpm qa:quality\` when defined, Vercel preview review when applicable, final diff inspection, and the full review on the candidate SHA.
- If the PR is actually ready, do not push. Wait for the complete Quality Gates, run \`gh pr checks <number>\`, and verify the checked headRefOid is the candidate SHA.
- Merge only with explicit user approval and passing checks for that same SHA.
</pr-lifecycle-state-required>`;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    writeWarning("invalid JSON payload; skipping PR lifecycle hook.");
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.tool || "").toLowerCase();
  const shellTools = ["bash", "shell", "local_shell", "powershell"];
  const commandValue = data?.tool_input?.command ?? data?.args?.command ?? "";
  const command = Array.isArray(commandValue)
    ? commandValue.join(" ")
    : String(commandValue);

  if (!shellTools.includes(toolName) || !isPrLifecycleCommand(command)) {
    process.exit(0);
  }

  const isOpenCodeBridge = data.tool !== undefined && data.tool_name === undefined;
  if (isOpenCodeBridge) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        additionalContext: message,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: message,
        },
      })}\n`,
    );
  }
  process.exit(0);
});
