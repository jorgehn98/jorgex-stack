---
name: xreview
description: Conditional multi-agent code review — determines what to review (asking if unclear), resolves the exact diff, and launches only the relevant subagents in parallel
---

Determine what needs review, freeze the evidence, and assign only the relevant specialist scopes. Reuse justified coverage after fixes; an explicitly requested fresh or full review still takes precedence over reuse.

## 0. Determine the review target

Review target (may be empty): use the invocation context or the explicit target supplied by the caller.

- If the input names a branch → select it as BASE and resolve immutable refs before reviewing.
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

HEAD identifies the current branch/worktree; branch names are labels, not immutable review evidence.

BASE is the branch the work will merge into. Do NOT default to `main` — work is often done in sub-branches whose PR targets another branch. Resolve BASE in this order:

1. The branch the user chose in step 0, if any.
2. If the current branch has an open GitHub PR, its base branch (`gh pr view --json baseRefName --jq .baseRefName`).
3. Otherwise, inspect local and `origin/*` branches and choose the branch directly underneath the current branch: the candidate whose merge-base with HEAD is newest/closest to HEAD, excluding the current branch itself and its remote tracking ref.
4. If still unsure, ask the user — never silently fall back to `main`.

Resolve the selected refs to full commit SHAs, record `BASE_SHA`, `HEAD_SHA` and their merge-base, and review `git diff <BASE_SHA>...<HEAD_SHA>`. Print the refs, SHAs and why BASE was selected; do not leave reviewers to resolve a moving `HEAD` independently. If the base or merge-base is ambiguous, resolve the scope before launching them.

For working-tree reviews, state the staged, unstaged and relevant untracked changes actually included. They are not evidence for a committed SHA. If the working state changes during review, revalidate the affected coverage rather than attributing it to the old snapshot; never stage files merely to manufacture review evidence.

## 2. Decide routing (lightweight)

Start with changed file NAMES: `git diff <BASE_SHA>...<HEAD_SHA> --name-only` (or the working-tree inventory). Read only the decisive hunks when names are insufficient to classify a contract or risk; do not preload the entire diff by habit.

Sanity check: if that list is far larger than the work being reviewed (hundreds of files, unrelated areas), BASE is almost certainly wrong — STOP, re-resolve it (step 1), and only continue when the diff matches the actual work. Reviewing against the wrong BASE makes every finding worthless.

Account for every changed group, including tests, docs, configuration and generated files, and explain deliberate exclusions. Assign each reviewer a **primary scope** (paths/hunks and the contract or risk it owns) and **support context** (directed dependencies, consumers, tests or docs needed to understand it, including unchanged files). Primary is responsibility, not exclusive file ownership or an access-permission boundary. Do not hand every reviewer the entire diff by default or forbid a test reviewer from reading the production contract.

## 3. Preserve the work context

When running inside the orchestrator's SHIP phase, the main agent already owns the exact active `work/{name}`. Preserve it as the review context and pass it verbatim to every review subagent. Do not infer a work name from the branch or search `work/*`; several pieces of work may be active at once.

Use only the goal, constraints, criteria and plan sections relevant to the assigned review. Passing the exact work path is not a request to reload every historical checkpoint or the whole conversation.

For a manual xreview without an explicit work context, continue without PRD/plan context and state that it was unavailable. Never choose a work folder silently.

## 4. Comment pass FIRST (conditional)

If the diff adds or changes comments/docstrings, run `comment-fixer` ALONE before the analysts — it edits comments in place (comments only, never code), so the analysts then review a diff already clean of comment noise instead of re-reporting it or mistaking its edits for contamination.

- Pass the frozen refs or working-state identity and the relevant comment/docstring scope.
- When the orchestrator supplied one, pass it the same exact work context path as every other review subagent.
- If it changed anything and the scope is a committed diff (branch/PR): comment-fixer itself never commits — YOU commit its fixes before launching reviewers, staging ONLY its files (never `-a`/`-A`). Then freeze the new candidate SHA and refresh scopes. If a commit cannot be made, report the uncommitted state; it cannot certify the committed candidate.
- For working-tree reviews: leave its edits uncommitted (they join the user's pending work) and say so in the report.
- If the diff touches no comments, skip it and move on.

## 5. Launch the remaining subagents in PARALLEL

All subagents are CONDITIONAL: launch one only when its contract or risk applies. Run independent scopes in PARALLEL through the available delegation mechanism. Each reviewer reads its assigned primary diff and the support it needs; all are read-only. Pass each assignment in the existing handoff, without inventing a universal output schema:

- the immutable base/head SHAs and merge-base, or the stated working-state scope
- primary paths/hunks plus the contract/risk to evaluate, and directed support references
- the instruction: use this explicit assignment, not a default whole-diff review; never assume `main`, and report material missing context instead of silently widening the audit
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

Reconcile duplicates and verify disputed premises before creating work. Distinguish a missed bug, a regression introduced by a fix and an optional suggestion. A new valid finding still needs triage; being new is not a reason to discard it. Record justified rejection of false positives, not backlog entries for them. Only valid work deliberately deferred belongs in the existing backlog, using its single-writer protocol.

- Review scope used (BASE/HEAD or working diff) and how it was chosen
- Subagents run vs skipped (with reason)
- Critical Issues (must fix)
- Important Improvements (should fix)
- Suggestions (nice to have)
- Changes already applied (comment fixes: committed to the branch, or left uncommitted for working-tree reviews)
- Positive Findings

## 7. Revalidate coverage and stop

Use the existing checkpoint/history for frozen refs, scopes actually reviewed, finding dispositions, verification and the reason prior coverage remains valid. No separate registry, duplicated task board or universal JSON fields are required.

- **Fix-check**: verify the original finding, its correction and the nearby regression risk. Prefer deterministic evidence; ask the relevant reviewer only when judgment is still needed.
- **Delta-review**: review changed hunks and affected contracts/dependencies when a fix invalidates coverage or introduces risk. Reopen only the relevant roles, including a previously clean role when its assumptions or dependencies changed.
- **Full review**: establish initial coverage or rebuild it when the effective diff/integration context has changed too broadly to retain reliable coverage. Select specialists conditionally; a material change calls for reassessment, not automatically the same full panel.

A role is neither exempt forever because it was clean nor mandatory forever because it found a bug. Prefer a bounded follow-up to an earlier reviewer when its context remains useful; fresh review can be appropriate when the required independence or coverage changes. Commits, readiness attempts and non-contractual typos do not by themselves trigger another panel.

After a base/parent change or retarget, recompute the effective diff and merge-base and reconsider integration assumptions; an unchanged head SHA alone does not preserve coverage. Before delivery, bind retained and new evidence to the current candidate and run the applicable checks. If code must change while ready, return to draft first.

Stop when no valid blocking findings remain, fixes are verified, coverage of the candidate is justified and no material uncertainty remains. Do not search indefinitely for zero suggestions. The existing task/criterion retry limit still applies: exhaustion requires replanning or a genuine blocker, never claiming success. Merge always requires explicit user approval.
