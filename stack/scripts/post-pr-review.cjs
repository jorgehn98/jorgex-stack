#!/usr/bin/env node
/**
 * Global PostToolUse hook: gh pr create
 *
 * Injects a conditional multi-agent review request after a PR is created.
 * Generic and project-agnostic: no version bump, no React Doctor, no project paths.
 *
 * The review subagents are CONDITIONAL — only the ones relevant to the diff run.
 * Mirrors the `/xreview` command logic so both stay aligned: comment-fixer first
 * (committed before the analysts), then the read-only analysts in parallel.
 *
 * Payload compatibility (stdin JSON), so the same script works on every runtime:
 * - Claude Code hooks: { tool_name: "Bash", tool_input: { command: "..." }, cwd }
 * - Codex hooks:       { tool_name: "shell", tool_input: { command: [...] }, cwd }
 * - OpenCode bridge:   { tool: "bash", args: { command: "..." }, directory }
 *
 * Output (single channel per runtime, so the bridge never duplicates it):
 * - OpenCode bridge payload → plain message on stderr.
 * - Claude Code / Codex payload → JSON additionalContext on stdout.
 * Exit 0 always.
 */

const { execSync } = require('child_process');
const path = require('path');

const DEFAULT_BASE_BRANCH = 'main';
const BASE_BRANCH_SOURCE = Object.freeze({
  GH: 'gh',
  ORIGIN_HEAD: 'origin-head',
  DEFAULT: 'default',
});

function writeWarning(message) {
  process.stderr.write(`post-pr-review: warning: ${message}\n`);
}

function formatGitRef(value) {
  const ref = String(value);
  return /^[A-Za-z0-9._/-]+$/.test(ref) ? ref : `'${ref.replace(/'/g, "'\\''")}'`;
}

function resolveBaseBranch(cwd) {
  try {
    const base = execSync('gh pr view --json baseRefName --jq .baseRefName', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8_000,
    }).trim();
    if (base) return { branch: base, source: BASE_BRANCH_SOURCE.GH };
  } catch {
    // PR not yet discoverable; fall back below.
  }

  try {
    const originHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    if (originHead) {
      return {
        branch: originHead.replace(/^refs\/remotes\/origin\//, ''),
        source: BASE_BRANCH_SOURCE.ORIGIN_HEAD,
      };
    }
  } catch {
    // ignore
  }

  return { branch: DEFAULT_BASE_BRANCH, source: BASE_BRANCH_SOURCE.DEFAULT };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    writeWarning('invalid JSON payload; skipping review hook.');
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.tool || '').toLowerCase();
  const SHELL_TOOLS = ['bash', 'shell', 'local_shell', 'powershell'];
  const commandValue = data?.tool_input?.command ?? data?.args?.command ?? '';
  // Codex passes the shell command as an argv array; the rest as a string.
  const rawToolCommand = Array.isArray(commandValue) ? commandValue.join(' ') : String(commandValue);
  const toolCommand = rawToolCommand.toLowerCase();

  if (!SHELL_TOOLS.includes(toolName) || !toolCommand.includes('gh pr create')) {
    process.exit(0);
  }

  const scriptDir = __dirname;
  const projectDir = data.cwd || data.directory || path.resolve(scriptDir, '..');
  const resolution = resolveBaseBranch(projectDir);
  const baseBranch = resolution.branch;
  const baseRef = formatGitRef(baseBranch);
  const diffScope = `git diff ${baseRef}...HEAD`;
  const isConfirmed = resolution.source === BASE_BRANCH_SOURCE.GH;
  const baseSummary = isConfirmed
    ? `BASE (PR target, confirmed via gh pr view): ${baseBranch}`
    : `BASE (PR target, NOT confirmed — fallback guess): ${baseBranch}. Before anything else, re-resolve it yourself: run \`gh pr view --json baseRefName --jq .baseRefName\` (the PR exists now; this hook may have raced its creation) and use THAT as BASE. Keep ${baseBranch} only if it still fails. Work is often done in sub-branches whose PR does NOT target the default branch — reviewing against the wrong BASE produces a huge, useless diff.`;

  const message = `<post-pr-review-required>
A PR was just created. Run a conditional multi-agent review BEFORE reporting back to the user.

${baseSummary}
HEAD: the current branch / worktree (resolve with \`git rev-parse --abbrev-ref HEAD\`).

1. Routing only (lightweight): list changed file NAMES with \`${diffScope} --name-only\` to decide which subagents apply. Do NOT load the full diff into your own context.

   Sanity check: if that list is far larger than the work just done (hundreds of files, unrelated areas), BASE is almost certainly wrong — STOP, re-resolve the PR base with \`gh pr view\`, and only continue when the diff matches the actual work.

2. Comment pass FIRST (conditional): if the diff adds or changes comments/docstrings, run comment-fixer ALONE before the analysts — it edits comments in place (comments only, never code). If it changed anything, commit its fixes to the PR branch BEFORE launching the analysts, so the diff they fetch is already clean of comment noise (push them together with whatever the review produces, or on their own if nothing else needs fixing). If the diff touches no comments, skip it.

3. The remaining subagents are CONDITIONAL, read-only, and each fetches its OWN diff. Launch in PARALLEL (with your runtime's delegation mechanism) ONLY the relevant ones, passing each EXACTLY the BASE and HEAD branches and the instruction: review only \`${diffScope}\` — never assume \`main\`, use the BASE/HEAD given.
   - test-analyzer — only if the diff touches tests or code that should be tested
   - silent-failure-hunter — only if the diff includes error handling, try/catch, fallbacks, or async flows
   - type-design-analyzer — only if the diff changes types, interfaces, schemas, or public contracts
   - code-reviewer — for general code quality whenever non-trivial source code changed
   - code-simplifier — only if the diff introduces complexity worth simplifying
   - security-auditor — only if the diff touches auth, authorization, permissions, secrets/credentials, sensitive data, input validation, webhooks, or other security-critical flows

   If none of a subagent's triggers are present, skip it. Always state which subagents ran and which were skipped and why.

4. After the relevant subagents complete, synthesize a unified report:
   - BASE and HEAD used
   - Subagents run vs skipped (with reason)
   - Critical Issues (must fix)
   - Important Improvements (should fix)
   - Suggestions (nice to have)
   - Changes already applied (comment fixes: committed to the PR branch, or left uncommitted for working-tree reviews)
   - Positive Findings
</post-pr-review-required>`;

  // Un solo canal por runtime: el bridge de OpenCode recoge stdout Y stderr,
  // así que emitir por ambos duplicaría el mensaje.
  const isOpenCodeBridge = data.tool !== undefined && data.tool_name === undefined;
  if (isOpenCodeBridge) {
    process.stderr.write(message + '\n');
  } else {
    // Claude Code / Codex PostToolUse leen additionalContext del stdout JSON.
    process.stdout.write(
      JSON.stringify({
        additionalContext: message,
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
      }) + '\n',
    );
  }
  process.exit(0);
});
