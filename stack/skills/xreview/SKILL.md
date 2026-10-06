---
name: xreview
description: Review a PR, branch or local change with only the reviewers its risks need. Use on explicit request or when orchestrator needs independent review of a coherent candidate before delivery.
---

# Xreview

Review a coherent candidate with the reviewers its risks need. Not a fixed panel and not a repository audit.

## 1. Target

- A named branch, a PR, specific paths or the working tree.
- If it is ambiguous, run a cheap scan (`git status --short`, current branch, `gh pr view --json baseRefName`) and ask, offering only the options that apply.
- Do not guess: a review against the wrong target wastes every reviewer.

## 2. Base and evidence

Resolve the base in this order; never default to `main`:

1. The base the user chose.
2. The base branch of the open PR.
3. The branch directly underneath: the candidate whose merge-base with HEAD is closest to HEAD.
4. Ask.

- Record base SHA, head SHA and merge-base, and say why that base was selected. Review `git diff <base>...<head>`.
- Working tree: state which staged, unstaged and untracked changes are included. They are not evidence for a committed SHA; never stage files to manufacture evidence.
- Sanity check: start from `--name-only`. If the list is far larger than the work, the base is wrong: stop and resolve it again.
- Pass the exact `work/{name}` path when there is one. Do not infer it from the branch; if there is none, say so.

## 3. Reviewers

| Reviewer | Launch when the change |
|---|---|
| reviewer | touches non-trivial source, tests or code that should be tested, error handling or fallbacks, meaningful invariants, or comments |
| security-auditor | touches authentication, authorization, permissions, secrets, sensitive data, input validation, webhooks or other trust boundaries |
| simplifier | introduces or touches material complexity |

- Zero to three reviewers. Zero does not waive deterministic verification.
- Give each one its primary scope (paths or hunks and the risk it owns) and the support context it needs, not the whole parent conversation.
- All reviewers are read-only. The existing implementer applies approved fixes and simplifications. No comment writer, tester or specialist chain.
- A writer finishing, a commit, a test run or marking Ready does not trigger a review.

## 4. Consolidate

- Validate premises; reject duplicates and impossible scenarios.
- Distinguish a missed bug, a regression introduced by a fix and an optional suggestion.
- Fix real blockers within scope and ask before a material scope expansion.
- Do not turn optional suggestions into compulsory refactors or pursue zero observations.

## 5. After fixes

- **Fix-check**: verify the finding, its correction and the nearby regression risk, preferably with deterministic evidence.
- **Delta review**: review changed hunks and affected contracts when a fix invalidates coverage or adds risk; reopen only the relevant reviewer.
- **Full review**: only when the effective diff or integration context changed too broadly to keep the earlier coverage.
- After a base change or retarget, recompute diff and merge-base even if the head is unchanged.
- If fixes keep failing, reconsider cause and approach instead of relaunching the same cycle.
- Stop when no valid blocker remains, fixes are verified and coverage of the current candidate is justified.

## Report

- Scope reviewed: base, head and how the base was chosen.
- Reviewers run and skipped, with the reason.
- Blocking findings, then non-blocking suggestions.
- Verification run and remaining limits.

Required CI must cover the current candidate. A clean review does not authorize a merge or claim a deployment.
