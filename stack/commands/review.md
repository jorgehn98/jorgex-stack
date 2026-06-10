---
description: Run a conditional multi-agent review in parallel (subagents run based on what the diff touches)
---

Run a comprehensive review. Your job as orchestrator: resolve the branches, decide which subagents to run, and pass each one the exact branches so it fetches its own diff.

## 1. Resolve BASE and HEAD

HEAD is the current branch / worktree being worked on (`git rev-parse --abbrev-ref HEAD`).

BASE is the branch the PR targets. Do NOT default to `main` — work is often done in sub-branches whose PR targets another branch, not the main one. Resolve BASE in this order:

1. If the user passes an input branch name to `/review`, use that as BASE.
2. If the current branch has an open GitHub PR, use its PR base branch (`gh pr view --json baseRefName --jq .baseRefName`).
3. Otherwise, inspect local and `origin/*` branches and choose the branch directly underneath the current branch: the candidate whose merge-base with HEAD is newest/closest to HEAD, excluding the current branch itself and its remote tracking ref.
4. Only fall back to `main` when no better parent/base branch can be detected.

Print the chosen BASE and HEAD and why BASE was selected.

## 2. Decide routing (lightweight)

List only the changed file NAMES to decide routing — do NOT load the full diff into your own context:
`git diff <BASE>...HEAD --name-only` (substitute the real branch names).

## 3. Launch the relevant subagents in PARALLEL

All subagents are CONDITIONAL: launch one only when the changed files indicate it applies. Run them in PARALLEL via the Task tool. Each subagent fetches its OWN diff; all are read-only except `comment-fixer`, which edits comments directly (comments only, never code). Pass every one EXACTLY:

- BASE branch and HEAD branch (verbatim)
- the instruction: review only `git diff <BASE>...HEAD` — never assume `main`, use the BASE/HEAD given

Subagents and their triggers:

1. Task(subagent_type='comment-fixer') — only if the diff adds or changes comments/docstrings; it fixes them in place and reports what changed
2. Task(subagent_type='test-analyzer') — only if the diff touches tests or code that should be tested
3. Task(subagent_type='silent-failure-hunter') — only if the diff includes error handling, try/catch, fallbacks, or async flows
4. Task(subagent_type='type-design-analyzer') — only if the diff changes types, interfaces, schemas, or public contracts
5. Task(subagent_type='code-reviewer') — for general code quality whenever non-trivial source code changed
6. Task(subagent_type='code-simplifier') — only if the diff introduces complexity worth simplifying
7. Task(subagent_type='security-auditor') — only if the diff touches auth, authorization, permissions, secrets/credentials, sensitive data, input validation, webhooks, or other security-critical flows

If none of a subagent's triggers are present, skip it and note that it was skipped. Always state which subagents ran and which were skipped and why.

## 4. Synthesize

After the relevant subagents complete, synthesize their findings into a unified report:

- BASE and HEAD used
- Subagents run vs skipped (with reason)
- Critical Issues (must fix)
- Important Improvements (should fix)
- Suggestions (nice to have)
- Changes already applied (e.g. comment fixes left uncommitted in the working tree)
- Positive Findings
