#!/usr/bin/env node
/**
 * Global PostToolUse hook: gh pr create
 *
 * Injects a conditional multi-agent review request after a PR is created.
 * Generic and project-agnostic: no version bump, no React Doctor, no project paths.
 *
 * The review subagents are CONDITIONAL — only the ones relevant to the diff run.
 * Mirrors the `/review` command logic so both stay aligned.
 *
 * Payload compatibility (stdin JSON), so the same script works on every runtime:
 * - Claude Code / Codex hooks: { tool_name, tool_input: { command }, cwd }
 * - OpenCode hooks bridge:     { tool, args: { command }, directory }
 *
 * Output: plain message on stderr (OpenCode bridge) + JSON additionalContext on
 * stdout (Claude Code / Codex PostToolUse). Exit 0 always.
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
  const rawToolCommand = String(data?.tool_input?.command || data?.args?.command || '');
  const toolCommand = rawToolCommand.toLowerCase();

  if (toolName !== 'bash' || !toolCommand.includes('gh pr create')) {
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
    : `BASE (PR target, inferred — NOT confirmed): ${baseBranch} — verify the real PR base before trusting the diff. Work is often in sub-branches whose PR does not target main.`;

  const message = `<post-pr-review-required>
A PR was just created. Run a conditional multi-agent review BEFORE reporting back to the user.

${baseSummary}
HEAD: the current branch / worktree (resolve with \`git rev-parse --abbrev-ref HEAD\`).

1. Routing only (lightweight): list changed file NAMES with \`${diffScope} --name-only\` to decide which subagents apply. Do NOT load the full diff into your own context.

2. All subagents are CONDITIONAL and read-only, and each fetches its OWN diff. Launch in PARALLEL (via Task) ONLY the relevant ones, passing each EXACTLY the BASE and HEAD branches and the instruction: review only \`${diffScope}\` — never assume \`main\`, use the BASE/HEAD given.
   - Task(subagent_type='comment-analyzer') — only if the diff adds or changes comments/docstrings
   - Task(subagent_type='test-analyzer') — only if the diff touches tests or code that should be tested
   - Task(subagent_type='silent-failure-hunter') — only if the diff includes error handling, try/catch, fallbacks, or async flows
   - Task(subagent_type='type-design-analyzer') — only if the diff changes types, interfaces, schemas, or public contracts
   - Task(subagent_type='code-reviewer') — for general code quality whenever non-trivial source code changed
   - Task(subagent_type='code-simplifier') — only if the diff introduces complexity worth simplifying
   - Task(subagent_type='security-auditor') — only if the diff touches auth, authorization, permissions, secrets/credentials, sensitive data, input validation, webhooks, or other security-critical flows

   If none of a subagent's triggers are present, skip it. Always state which subagents ran and which were skipped and why.

3. After the relevant subagents complete, synthesize a unified report:
   - BASE and HEAD used
   - Subagents run vs skipped (with reason)
   - Critical Issues (must fix)
   - Important Improvements (should fix)
   - Suggestions (nice to have)
   - Positive Findings
</post-pr-review-required>`;

  // OpenCode bridge reads stderr/plain output.
  process.stderr.write(message + '\n');
  // Claude Code / Codex PostToolUse read additionalContext from stdout JSON.
  process.stdout.write(
    JSON.stringify({
      additionalContext: message,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }) + '\n',
  );
  process.exit(0);
});
