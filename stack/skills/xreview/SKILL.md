---
name: xreview
description: Conditional multi-agent code review — determines what to review (asking if unclear), resolves the exact diff, and launches only the relevant subagents in parallel
---

Run a comprehensive multi-agent review. Your job as the main agent: determine WHAT to review, resolve the exact diff, decide which subagents apply, and launch them in parallel.

## 0. Determine the review target

Review target (may be empty): use the invocation context or the explicit target supplied by the caller.

- If the input names a branch → review `git diff <that-branch>...HEAD`.
- If the input references a PR (number or URL) → use that PR's base branch as BASE.
- If the input names files/paths/areas → review the changes touching those paths.
- If the input is empty or ambiguous: do a quick, cheap situation scan first — uncommitted changes (`git status --short`), current branch, open PR for it (`gh pr view --json baseRefName --jq .baseRefName`) — and ASK the user what to review before launching anything, offering only the options that actually apply:
  1. Uncommitted work (`git diff` + `git diff --staged`)
  2. The current branch against its base (say which base you detected and how)
  3. Against a specific branch they name
  4. An existing PR
  5. Specific files or areas

Do NOT guess silently: a review against the wrong target wastes every subagent and buries the user in irrelevant findings.

## 1. Resolve BASE and HEAD (branch/PR reviews)

HEAD is the current branch / worktree being worked on (`git rev-parse --abbrev-ref HEAD`).

BASE is the branch the work will merge into. Do NOT default to `main` — work is often done in sub-branches whose PR targets another branch. Resolve BASE in this order:

1. The branch the user chose in step 0, if any.
2. If the current branch has an open GitHub PR, its base branch (`gh pr view --json baseRefName --jq .baseRefName`).
3. Otherwise, inspect local and `origin/*` branches and choose the branch directly underneath the current branch: the candidate whose merge-base with HEAD is newest/closest to HEAD, excluding the current branch itself and its remote tracking ref.
4. If still unsure, ask the user — never silently fall back to `main`.

Print the chosen BASE and HEAD and why BASE was selected. (For working-tree reviews there is no BASE: the scope is `git diff` + `git diff --staged`.)

## 2. Decide routing (lightweight)

List only the changed file NAMES to decide routing — do NOT load the full diff into your own context:
`git diff <BASE>...HEAD --name-only` (or `git diff --name-only` + `git diff --staged --name-only` for working-tree reviews).

Sanity check: if that list is far larger than the work being reviewed (hundreds of files, unrelated areas), BASE is almost certainly wrong — STOP, re-resolve it (step 1), and only continue when the diff matches the actual work. Reviewing against the wrong BASE makes every finding worthless.

## 3. Preserve the work context

When running inside the orchestrator's SHIP phase, the main agent already owns the exact active `work/{name}`. Preserve it as the review context and pass it verbatim to every review subagent. Do not infer a work name from the branch or search `work/*`; several pieces of work may be active at once.

For a manual xreview without an explicit work context, continue without PRD/plan context and state that it was unavailable. Never choose a work folder silently.

## 4. Comment pass FIRST (conditional)

If the diff adds or changes comments/docstrings, run `comment-fixer` ALONE before the analysts — it edits comments in place (comments only, never code), so the analysts then review a diff already clean of comment noise instead of re-reporting it or mistaking its edits for contamination.

- Pass it the same scope (BASE/HEAD or working diff) as everyone else.
- When the orchestrator supplied one, pass it the same exact work context path as every other review subagent.
- If it changed anything and the scope is a committed diff (branch/PR): comment-fixer itself never commits — YOU commit its fixes to the reviewed branch before launching the analysts, staging ONLY the files it touched (never `-a`/`-A`: don't sweep unrelated working-tree changes into the commit). If the commit can't be made (branch checked out elsewhere, hook rejection), leave the edits uncommitted and say so in the report.
- For working-tree reviews: leave its edits uncommitted (they join the user's pending work) and say so in the report.
- If the diff touches no comments, skip it and move on.

## 5. Launch the remaining subagents in PARALLEL

All subagents are CONDITIONAL: launch one only when the changed files indicate it applies. Run them in PARALLEL via the delegation mechanism available in the current runtime. Each subagent fetches its OWN diff; all are read-only. Pass every one EXACTLY:

- the review scope: BASE and HEAD branches (verbatim), or "working diff" for uncommitted work
- the instruction: review only that scope — never assume `main`, use the scope given
- when the orchestrator supplied one, the exact work context path verbatim — never a guessed or discovered alternative

Subagents and their triggers:

1. `test-analyzer` — only if the diff touches tests or code that should be tested
2. `silent-failure-hunter` — only if the diff includes error handling, try/catch, fallbacks, or async flows
3. `type-design-analyzer` — only if the diff changes types, interfaces, schemas, or public contracts
4. `code-reviewer` — for general code quality whenever non-trivial source code changed
5. `code-simplifier` — only if the diff introduces complexity worth simplifying; this is the lean/anti-bloat pass for diffs and PRs
6. `security-auditor` — only if the diff touches auth, authorization, permissions, secrets/credentials, sensitive data, input validation, webhooks, or other security-critical flows

If none of a subagent's triggers are present, skip it and note that it was skipped. Always state which subagents ran and which were skipped and why.

`/lean-audit` is a separate manual repo/path command, not post-PR automation. Do not route it from here.

## 6. Synthesize

After the relevant subagents complete, synthesize their findings into a unified report. Use 4R internally (Reliability / Resilience / Readability / Risk) as a checklist while synthesizing; do not add a separate 4R section or taxonomy to the final report.

- Review scope used (BASE/HEAD or working diff) and how it was chosen
- Subagents run vs skipped (with reason)
- Critical Issues (must fix)
- Important Improvements (should fix)
- Suggestions (nice to have)
- Changes already applied (comment fixes: committed to the branch, or left uncommitted for working-tree reviews)
- Positive Findings
