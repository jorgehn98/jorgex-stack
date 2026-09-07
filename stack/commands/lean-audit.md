---
description: Manual read-only lean audit — resolves repo/path scope, runs a cheap scope/routing scan, launches code-simplifier always and the relevant analysts conditionally, then reports ranked lean findings.
---

Run a manual lean audit. Your job as the main agent: determine WHAT to audit, resolve the exact repo/path scope, decide which subagents apply, and launch them in parallel.

## 0. Determine the audit target

User input (may be empty): {{input}}

- If the input names a repo or a path → audit that repo/subtree.
- If the input is empty or ambiguous: do a quick, cheap situation scan first — current repo root (`git rev-parse --show-toplevel`), current branch (`git rev-parse --abbrev-ref HEAD`), and the most likely changed area from the user's prompt — then ASK the user what to audit before launching anything, offering only the options that actually apply.
- If the input points to a PR or a diff → stop: `/lean-audit` is not a PR review command; use `/xreview` for diffs and PRs.

## 1. Resolve scope

- Print the chosen repo/path scope and why it was selected.
- If the input is a path, audit that subtree.
- If the input is a repo root, audit the repo from that root downward.
- If you are inside a worktree, use that worktree as the scope unless the user named a different path.

## 2. Cheap scope/routing scan

Before launching subagents, do a quick scan for obvious routing signals in the scope:

- changed file names and top-level directories
- obvious code/test/docs boundaries
- areas that likely need code-simplifier vs analyst passes
- anything that changes which subagents should run

Use the scan to route work, not to judge bloat or rewrite anything. Code-simplifier owns the lean/anti-bloat findings.

## 3. Launch the remaining subagents in PARALLEL

All subagents are CONDITIONAL and read-only. Launch one only when the scope indicates it applies. Pass every one EXACTLY:

- the audit scope: repo root / path root, verbatim
- the instruction: audit only that scope — never broaden it, and never apply fixes

Subagents and their triggers:

1. Task(subagent_type='code-simplifier') — always; this is the lean/anti-bloat pass
2. Task(subagent_type='codebase-analyst') — only when a concrete question about modules, consumers, UI or data flows needs evidence within the audit scope; pass that question and the relevant paths, not a full-stack checklist
3. Task(subagent_type='type-design-analyzer') — only when the audit scope presents a concrete invariant question or risk (states, field relationships, mutation or boundary validation); the mere presence of types or interfaces is not a trigger, and this repo/path audit does not require a diff

Use separate `codebase-analyst` instances only for independent questions with distinct scopes, not merely because both frontend and backend exist.

If none of a subagent's triggers are present, skip it and note that it was skipped. Always state which subagents ran and which were skipped and why.

## 4. Synthesize

After the relevant subagents complete, synthesize their findings into a unified report:

- Scope used and how it was chosen
- Subagents run vs skipped (with reason)
- Ranked findings: delete, stdlib, native/platform, reuse, yagni, shrink
- What should be deferred because it is out of scope or too risky for this audit
- Positive findings

Do not apply fixes. This command only audits and reports.
