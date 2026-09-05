#!/usr/bin/env node
/**
 * Global PostToolUse guardrail for PR readiness transitions.
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

function isReadinessTransitionSegment(tokens) {
  if (!/(?:^|[\\/])gh(?:\.exe)?$/i.test(tokens[0] ?? "")) return false;

  let index = skipRepoOptions(tokens, 1);
  if (tokens[index]?.toLowerCase() !== "pr") return false;
  index = skipRepoOptions(tokens, index + 1);

  const action = tokens[index]?.toLowerCase();
  const args = tokens.slice(index + 1).map((token) => token.toLowerCase());
  const readBooleanFlag = (names, valueFlags = []) => {
    let value;
    for (let offset = 0; offset < args.length; offset += 1) {
      const arg = args[offset];
      if (arg === "--") break;
      if (valueFlags.includes(arg)) {
        offset += 1;
        continue;
      }
      if (valueFlags.some((name) => arg.startsWith(`${name}=`))) continue;
      if (names.some((name) => arg === name)) {
        value = true;
        continue;
      }
      for (const name of names) {
        if (!arg.startsWith(`${name}=`)) continue;
        const flagValue = arg.slice(name.length + 1);
        if (["true", "t", "1"].includes(flagValue)) value = true;
        if (["false", "f", "0"].includes(flagValue)) value = false;
      }
    }
    return value;
  };

  if (action === "ready") return readBooleanFlag(["--undo"], ["-R", "--repo"]) !== true;
  if (action !== "create" && action !== "new") return false;

  const createValueFlags = [
    "-R", "--repo", "-a", "--assignee", "-B", "--base", "-b", "--body",
    "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone",
    "-p", "--project", "--recover", "-r", "--reviewer", "-T", "--template", "-t", "--title",
  ];
  const createsDraft = readBooleanFlag(["--draft", "-d"], createValueFlags) === true;
  return !createsDraft;
}

function isPrReadinessCommand(command) {
  const segments = Array.isArray(command)
    ? [command.map(String)]
    : shellCommandSegments(String(command));
  return segments.some(isReadinessTransitionSegment);
}

const message = `<pr-lifecycle-state-required>
A PR readiness transition was attempted through \`gh pr create\` without \`--draft\` or through \`gh pr ready\`. Do not infer success or PR state from the command text. Resolve the current PR and run \`gh pr view --json number,isDraft,headRefOid\` before the next action.

- The review boundary is the final draft diff. If reliable review coverage is missing for the current candidate, ensure the PR is draft (run \`gh pr ready --undo <number>\` if necessary), finish code, the applicable version bump, local tests, \`pnpm qa:quality\` when defined, Vercel preview review when applicable, and final diff inspection, then load and run the portable \`xreview\` skill for the missing coverage on that exact diff. When an orchestrator owns an active work context, it must pass the exact \`work/{name}\` to every reviewer. Retain still-valid review evidence and do not open another panel merely because readiness was attempted.
- After fixing findings, revalidate coverage: fix-check for the finding, delta-review for affected contracts or risks, and full review only when reliable coverage must be established or broadly rebuilt. A material change requires reassessment, not automatically the same full panel. Retain prior evidence only where its assumptions remain valid; a previously clean role reopens when its dependencies or risks change.
- If the PR is actually ready, do not push. If the project has PR checks configured, wait for the complete Quality Gates, run \`gh pr checks <number>\`, and verify the checked headRefOid is the candidate SHA.
- If no PR checks are configured, confirm that from project configuration such as workflows, rulesets or integrations, and record it; their absence does not block the merge. An empty \`gh pr checks\` result immediately after ready is not evidence that no checks are configured.
- Immediately before reporting or merging, compare \`gh pr view --json headRefOid\` with the recorded candidate SHA and recheck the effective base and integration context; the same head alone does not preserve review coverage. Merge still requires explicit user approval.
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
  if (!shellTools.includes(toolName) || !isPrReadinessCommand(commandValue)) {
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
