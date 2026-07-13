#!/usr/bin/env node
/**
 * Global PostToolUse guardrail for the PR draft → ready lifecycle.
 *
 * The historical filename is intentionally preserved so sync can update the
 * existing hook entry instead of leaving an orphan in user configuration.
 * The definitive multi-agent review now runs explicitly on the final draft SHA
 * before `gh pr ready`; creating the draft is no longer a review boundary.
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

function commandKind(command) {
  const create = /\bgh(?:\.exe)?\s+pr\s+create\b/i.test(command);
  const ready = /\bgh(?:\.exe)?\s+pr\s+ready\b/i.test(command);

  if (create) {
    return /(?:^|\s)--draft(?:\s|$)/i.test(command)
      ? "create-draft"
      : "create-ready";
  }

  if (ready) {
    return /(?:^|\s)--undo(?:\s|$)/i.test(command)
      ? "ready-undo"
      : "ready";
  }

  return null;
}

function prArgument(command) {
  const tail = command.match(/\bgh(?:\.exe)?\s+pr\s+ready\b([\s\S]*)/i)?.[1] ?? "";
  return tail.match(/\b\d+\b/)?.[0] ?? "<number>";
}

function lifecycleMessage(kind, command) {
  const number = prArgument(command);

  switch (kind) {
    case "create-draft":
      return `<pr-draft-created>
The PR was created correctly as draft. Keep the PR in draft while its code can still change. Do not mark it ready yet.

Continue commits and pushes only while draft. Before ready, finish the code, applicable version bump, local tests, \`pnpm qa:quality\` when defined, Vercel preview review when applicable, final diff inspection, and the full PR review on the final draft SHA.
</pr-draft-created>`;

    case "create-ready":
      return `<pr-created-ready-violation>
The PR was created without \`--draft\`, which violates the required lifecycle. Run \`gh pr ready --undo ${number}\` immediately and keep all further changes and pushes in draft.

Only mark it ready again after local verification, preview, final diff, and review are complete for the candidate SHA.
</pr-created-ready-violation>`;

    case "ready-undo":
      return `<pr-returned-to-draft>
The PR is draft again. Make changes and pushes only in this state. Repeat the local verification and final review for the new candidate SHA before running \`gh pr ready ${number}\` again.
</pr-returned-to-draft>`;

    case "ready":
      return `<pr-ready-gates-required>
The PR is now ready. Do not push while the PR is ready. Wait for the complete Quality Gates, then run \`gh pr checks ${number}\` and verify the passing checks belong to the latest commit.

If any change is needed, first run \`gh pr ready --undo ${number}\`, modify and push while draft, repeat local verification and final review, then mark ready and wait for a fresh complete gate.
</pr-ready-gates-required>`;

    default:
      return null;
  }
}

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

  if (!shellTools.includes(toolName)) {
    process.exit(0);
  }

  const kind = commandKind(command);
  const message = kind === null ? null : lifecycleMessage(kind, command);
  if (message === null) {
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
