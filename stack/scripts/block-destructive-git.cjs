#!/usr/bin/env node
// PreToolUse guard (Claude Code): blocks destructive git commands in the
// subagents that declare it, leaving the main agent unrestricted. Claude Code
// has no per-subagent command denylist, so this is the documented mechanism
// (sub-agents docs → "Conditional rules with hooks"). Reads the PreToolUse
// payload from stdin, and exits 2 to block if the bash/powershell command would
// discard work or rewrite history. Fail-open: any read/parse problem exits 0 so
// the guard can never wedge legitimate commands.

const DESTRUCTIVE = [
  // git reset (all forms — --hard discards the worktree, moving HEAD loses commits)
  /\bgit\s+reset\b/i,
  // git clean (only useful with -f/-d, which delete untracked files)
  /\bgit\s+clean\b/i,
  // git checkout -- <path> / git checkout -- . (discards working changes).
  // The "--" must be a standalone separator, so "git checkout --quiet <branch>"
  // and "git checkout -b <branch>" are NOT blocked.
  /\bgit\s+checkout\s+--(\s|$)/i,
  // git restore (discards working/staged changes back to a source)
  /\bgit\s+restore\b/i,
];

function isDestructive(command) {
  if (DESTRUCTIVE.some((re) => re.test(command))) return true;
  // git push --force / --force-with-lease / -f (overwrites remote history)
  if (/\bgit\s+push\b/i.test(command) && /(\s--force\b|--force-with-lease\b|\s-f\b)/i.test(command)) {
    return true;
  }
  return false;
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let command = "";
  try {
    const payload = JSON.parse(input || "{}");
    const toolInput = payload && payload.tool_input;
    command = (toolInput && (toolInput.command || toolInput.script)) || "";
  } catch {
    process.exit(0);
  }
  if (typeof command !== "string" || command.trim() === "") process.exit(0);

  if (isDestructive(command)) {
    process.stderr.write(
      "Blocked: destructive git is not allowed in this subagent " +
        "(reset / clean / checkout -- / restore / push --force). " +
        "Don't discard or rewrite repo state — commit forward, or stop and ask the user.\n",
    );
    process.exit(2);
  }
  process.exit(0);
});

// stdin may stay open with no data on some shells; don't hang the tool call.
process.stdin.resume();
