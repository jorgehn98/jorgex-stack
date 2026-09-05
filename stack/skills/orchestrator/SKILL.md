---
name: orchestrator
description: Main coordinator for non-trivial tasks. Routes work through a short or standard path, then coordinates the appropriate work. Use it when work spans several layers, several files, or requires coordination.
---

# Orchestrator

Route the work before starting a workflow. `short` and `standard` are routes, not new human/programmatic modes: their existing output contracts stay intact.

## Routing

Choose **short** only when the objective is clear, the affected contract is understood, the scope is bounded, and the change has sufficient verification. Choose **standard** when scope, uncertainty, risk, or verification needs the formal workflow. A small change is not automatically safe: assess configuration, publication, security, and other affected contracts before routing.

Short work has one primary responsible person; involve a specialist only when it adds value. It has no mandatory analyst, PRE, or POST chain. A short standalone change does not create a PRD, plan, formal task spec, PRE, or POST merely for ceremony.

If short work expands in scope, risk, uncertainty, verification needs, or requires a material decision, promote it to standard **before** continuing. Do not use file counts, elapsed time, or delegation mechanics as routing rules.

An existing or active formal SDD work keeps its approved scope, Spec, plan row, ownership, and lifecycle even when a bounded implementation step is handled short. Do not create child formal tasks for phases or polls; if the work grows into an independent or persistent item, formalize it through `work-lifecycle` before continuing.

The primary may implement or execute when a handoff or delegation adds no value. Otherwise, use the `agent-delegation` skill for the specialist's defined scope. Every subagent keeps that assigned scope and does not spawn subagents.

Apply the `lean-code` skill as a scope gate for code-bearing work: ask whether the code is needed at all, whether project or platform capabilities already solve it, and whether the smallest obvious change is enough.

For the **standard** route, explicitly read and follow [references/standard-workflow.md](references/standard-workflow.md). Resolve that reference relative to this skill directory, never the repository CWD; if it cannot be read, report a blocker rather than silently falling back to short. It contains the formal PRD, plan, PRE, POST, change-first, and delivery workflow. Do not load it for short work unless the work is promoted.

## Shared guards

Both routes preserve mandatory memory/Engram saves, testing/TDD by risk, Git/worktree discipline, final-draft review, configured gates, and explicit user approval for merge. Security, permissions, ownership, backups, dependency consent, and the existing human/programmatic output contracts are never relaxed by routing. Product documentation remains with `docs-maintainer` when it is needed; short routing does not absorb that owner's scope.

## Work state

The `work-lifecycle` skill is the single source for **formal SDD** work. Each formal task has one recoverable Spec source and one plan row. A direct or inline message is an auxiliary microassignment under a parent task, never a formal or independent task or a second Spec; if it grows into independent work, persist its formal task spec and plan row before continuing. Pass a delegated worker the exact Spec as read-only. Its distinct outcome topic_key must never overwrite that Spec; significant decisions and findings still require immediate memory saves, and checkpoint outcomes persist as required. Do not write memory for a poll or status without new information.

Phase outcomes, decisions and PR checkpoints → Engram under `work/{name}/{phase}` and `work/{name}/pr/{NN}`. The coordinator is the single writer for `work/backlog`: call `mem_get_observation`, preserve unrelated entries, send the complete content with `mem_update`, then read it again to verify. Never mutate it concurrently. For multi-PR work, each merge is a checkpoint; keep `work/{name}/PRD.md` and `plan.md` alive until the roadmap is finished.

## Delegation map

Load the `agent-delegation` skill: it defines the available subagents, their scopes, and when a specialist adds value. A delegation is unfinished work in another scope, not a generic quality pipeline. If a subagent reports `partial`, keep the safe work and relaunch only what still needs guidance. If a subagent reports `blocked` with one concrete uncertainty question, answer it from existing context when possible; if a material decision still cannot be resolved, suspend the work and ask the user for guidance before relaunching the original or a suitable specialist with that explicit guidance.

### Worktree and PR lifecycle

Both routes follow the project Git/worktree rules; short is not an exception. Where those rules explicitly permit a trivial direct-main change, keep that exception; otherwise resolve the root with `git rev-parse --show-toplevel`, ensure `worktrees/` is ignored in the repo-local `.git/info/exclude`, and create/use `<project-root>/worktrees/<canonical-name>` or `<project-root>/worktrees/<canonical-name>-prNN` with the branch matching the worktree name.

After the first coherent commit, push the work branch and open the PR with `gh pr create --draft`. Keep it draft while it changes. Mark it ready once with `gh pr ready <number>`. If the project has PR checks configured, wait for Quality Gates, run `gh pr checks <number>`, and verify they pass for the latest commit candidate. If no PR checks are configured, confirm and record their absence; it does not block the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA. If a ready PR needs a fix, run `gh pr ready --undo <number>` before editing, then repeat verification, review, ready, and configured gates.

After each intermediate merge: persist the checkpoint to `work/{name}/pr/{NN}`, update `plan.md`, and keep `work/{name}/` alive. Merge always requires explicit user approval.

### Deterministic verification

Deterministic checks are the routine feedback loop while implementation is in progress: run the relevant tests, lint, and typecheck/build checks at the cheapest seam that can catch the section's regressions. Verify coherent sections rather than every small edit or one big-bang run. Normal handoffs between `implementer` and `tester` do not by themselves justify reviewers or analyzers.

### Early review

An early review during EXECUTE is an exception, not a default phase. Use it only for a concrete risk that deterministic checks cannot cover and whose feedback can change the remaining implementation. State the bounded risk, use the single most relevant specialist, and run at most one early review per bounded critical section. Do not load the `xreview` skill or run a generic multi-agent panel during EXECUTE.

Do not launch `code-reviewer`, `code-simplifier`, `test-analyzer`, or `silent-failure-hunter` merely because a writer finished, a test task completed, several files changed, or a commit is due. File count, writer completion, commit, push, or draft PR creation are not early-review triggers.

### Bounded retries

Both routes cap a failing task or criterion at three attempts. After the third failure, stop retrying, save the meaningful failure and what was tried through the required outcome or memory path, then re-plan with a different approach or report the blocker; never loop blindly.
### Final review and PR lifecycle

The review boundary is the final candidate SHA while the PR is still draft, immediately before `gh pr ready`. It is one final review, not a mandatory panel or multiple reviewers for short work. Load and run the portable `xreview` skill only when a full review has not already covered that final draft and its multi-agent review adds value; in that case, pass the exact active `work/{name}` to every review subagent prompt and do not infer it from another `work/*` folder. Re-run it only if fixes materially change the diff or introduce a materially different risk; otherwise retain the prior review evidence and run deterministic verification.

Both routes keep the PR draft while it changes, use the canonical Git worktree, complete review before ready, wait for configured gates, compare the candidate SHA before reporting or merging, and never merge without explicit user approval.

## Closing rule

Do not declare work finished after analysis or planning alone: complete the routed execution or report the concrete blocker.