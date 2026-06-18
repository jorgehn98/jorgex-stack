#!/usr/bin/env node
// PreToolUse guard (Claude Code): blocks destructive git commands in the
// subagents that declare it, leaving the main agent unrestricted. Claude Code
// has no per-subagent command denylist, so this is the documented mechanism
// (sub-agents docs -> "Conditional rules with hooks"). Reads the PreToolUse
// payload from stdin and exits 2 to block if any segment of the command would
// discard work or rewrite history. Best-effort guardrail, not an adversarial
// sandbox. Fail-open: any read/parse problem allows the command (exit 0) so the
// guard can never wedge legitimate work — but it logs why, so a silent no-op is
// diagnosable.

// git global options that sit BETWEEN `git` and the subcommand. Without skipping
// them, `git -C /repo reset --hard` would slip past a naive `git reset` match.
const GLOBAL_OPT_WITH_ARG = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env",
]);

const isForceFlag = (token) =>
  token === "--force" || token === "--force-with-lease" || /^-[a-z]*f[a-z]*$/i.test(token);

/** True if a single command segment is a destructive git invocation. */
function isDestructiveSegment(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const gitIdx = tokens.indexOf("git");
  if (gitIdx === -1) return false;

  // Skip leading git global options to reach the real subcommand.
  let i = gitIdx + 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") break;
    if (/^(--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)=/.test(token)) { i++; continue; }
    if (GLOBAL_OPT_WITH_ARG.has(token)) { i += 2; continue; } // option + its value
    if (token.startsWith("-")) { i++; continue; } // any other global flag
    break;
  }

  const sub = tokens[i];
  const rest = tokens.slice(i + 1);
  if (!sub) return false;

  // Always destructive: discard worktree/index, delete untracked files.
  if (sub === "reset" || sub === "clean" || sub === "restore") return true;
  // git switch --discard-changes drops local modifications.
  if (sub === "switch") return rest.includes("--discard-changes");
  // git checkout: a branch switch is safe; the discard forms carry "--", a
  // force flag, or a "." pathspec (git checkout . / git checkout HEAD -- .).
  if (sub === "checkout") {
    return rest.includes("--") || rest.includes(".") || rest.some(isForceFlag);
  }
  // git push --force / --force-with-lease / -f (incl. bundled like -fq) or a
  // leading "+" refspec all force-overwrite remote history.
  if (sub === "push") {
    return rest.some((t) => isForceFlag(t) || /^\+/.test(t));
  }
  return false;
}

function isDestructive(command) {
  // Evaluate each command segment independently so a destructive op anywhere in
  // a compound command is caught (cd x && git reset), without a quoted token in
  // one command (git commit -m "git reset") leaking into another's match.
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => isDestructiveSegment(segment));
}

function extractCommand(payload) {
  const toolInput = payload && payload.tool_input;
  const raw = toolInput && (toolInput.command != null ? toolInput.command : toolInput.script);
  // Codex-style hooks pass argv as an array; normalize like post-pr-review.cjs.
  if (Array.isArray(raw)) return raw.join(" ");
  return typeof raw === "string" ? raw : "";
}

function allow(reason) {
  if (reason) process.stderr.write(`block-destructive-git: ${reason} (fail-open, allowing)\n`);
  process.exit(0);
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("error", () => allow("stdin error"));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = extractCommand(JSON.parse(input || "{}"));
  } catch {
    allow("unreadable payload");
    return;
  }
  if (command.trim() === "") process.exit(0);

  if (isDestructive(command)) {
    process.stderr.write(
      "Blocked: destructive git is not allowed in this subagent " +
        "(reset / clean / checkout discard / restore / switch --discard-changes / push --force). " +
        "Don't discard or rewrite repo state — commit forward, or stop and ask the user.\n",
    );
    process.exit(2);
  }
  process.exit(0);
});

// Safety nets so the guard can never hang the tool call: resume the stream (some
// shells need it to emit EOF) and bail out fail-open if stdin never ends.
process.stdin.resume();
setTimeout(() => allow("stdin timeout"), 2000).unref();
