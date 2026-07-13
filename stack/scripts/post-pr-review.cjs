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

function shellCommandSegments(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let quote = null;
  let started = false;

  const pushToken = () => {
    if (!started) return;
    tokens.push(token);
    token = "";
    started = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === "\r" || character === "\n") {
      pushSegment();
    } else if (/\s/.test(character)) {
      pushToken();
    } else if (character === ";" || character === "&" || character === "|") {
      pushSegment();
    } else {
      token += character;
      started = true;
    }
  }
  pushSegment();
  return segments;
}

function skipRepoOptions(tokens, start) {
  let index = start;
  while (index < tokens.length) {
    const option = tokens[index];
    if (option === "-R" || option === "--repo") {
      if (tokens[index + 1] === undefined) return false;
      index += 2;
    } else if (/^(?:-R|--repo=).+/i.test(option)) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

function isLifecycleSegment(tokens) {
  if (!/(?:^|[\\/])gh(?:\.exe)?$/i.test(tokens[0] ?? "")) return false;

  let index = skipRepoOptions(tokens, 1);
  if (tokens[index]?.toLowerCase() !== "pr") return false;
  index = skipRepoOptions(tokens, index + 1);

  const action = tokens[index]?.toLowerCase();
  return action === "create" || action === "ready";
}

function isPrLifecycleCommand(command) {
  const segments = Array.isArray(command)
    ? [command.map(String)]
    : shellCommandSegments(String(command));
  return segments.some(isLifecycleSegment);
}

const message = `<pr-lifecycle-state-required>
A \`gh pr create\` or \`gh pr ready\` command was attempted. Do not infer success or PR state from the command text. Resolve the current PR and run \`gh pr view --json number,isDraft,headRefOid\` before the next action.

- If the PR should still be under development, it must be draft. If it is ready, run \`gh pr ready --undo <number>\` before any change or push.
- While draft, finish code, the applicable version bump, local tests, \`pnpm qa:quality\` when defined, Vercel preview review when applicable, final diff inspection, and the full review on the candidate SHA.
- If the PR is actually ready, do not push. If the project has PR checks configured, wait for the complete Quality Gates, run \`gh pr checks <number>\`, and verify the checked headRefOid is the candidate SHA.
- If no PR checks are configured, confirm that from project configuration such as workflows, rulesets or integrations, and record it; their absence does not block the merge. An empty \`gh pr checks\` result immediately after ready is not evidence that no checks are configured.
- Immediately before reporting or merging, compare \`gh pr view --json headRefOid\` with the recorded candidate SHA. Merge still requires explicit user approval.
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
  if (!shellTools.includes(toolName) || !isPrLifecycleCommand(commandValue)) {
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
