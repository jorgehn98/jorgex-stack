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

## Documentation when needed

The coordinator identifies the audience and affected surfaces when a change needs an explanation of use, contract or operation, or makes an existing claim incorrect. Create documentation only for a concrete reader or operational need; an internal refactor or already-correct description does not require new prose. Product documentation stays with `docs-maintainer`, outside the review panel; code comments, ordinary UI text, translation and work-tracking artifacts keep their existing owners.

Identify needs during execution, then consolidate the necessary documentation pass once the implementation and fixes are stable, before ready for each checkpoint that needs it. Do not wait until the end of a roadmap that publishes intermediate behavior. Later contract changes reopen only affected pages; a prose correction alone does not invalidate unchanged code review, while a contractual correction requires reassessing review coverage.

## Decision before delegation

Use analysis only where it resolves an uncertainty that matters. An analyst's recommendation is evidence for the coordinator, not an implementation order: check the decisive sources, distinguish facts from assumptions, and close the scope, approach, relevant invariants and verification seam before delegating implementation. For formal work, record those decisions in its single Spec. Do not repeat the whole investigation or copy its report into the task.

Keep tightly coupled critical reasoning or execution with the primary when explaining it would duplicate most of the work; otherwise delegate a bounded outcome with the closed decisions and concrete escalation conditions. Preserve specialist ownership and the existing autonomy to resolve routine details: do not require consultation for every edit. If a material decision cannot be closed, resolve or escalate it rather than hiding it in an implementation task.

## Work state

The `work-lifecycle` skill is the single source for **formal SDD** work. Each formal task has one recoverable Spec source and one plan row. A direct or inline message is an auxiliary microassignment under a parent task, never a formal or independent task or a second Spec; if it grows into independent work, persist its formal task spec and plan row before continuing. Pass a delegated worker the exact Spec as read-only. Its distinct outcome topic_key must never overwrite that Spec; significant decisions and findings still require immediate memory saves, and checkpoint outcomes persist as required. Do not write memory for a poll or status without new information.

Phase outcomes, decisions and PR checkpoints → Engram under `work/{name}/{phase}` and `work/{name}/pr/{NN}`. The coordinator is the single writer for `work/backlog`: call `mem_get_observation`, preserve unrelated entries, send the complete content with `mem_update`, then read it again to verify. Never mutate it concurrently. For multi-PR work, each merge is a checkpoint; keep `work/{name}/PRD.md` and `plan.md` alive until the roadmap is finished.

## Delegation map

Load the `agent-delegation` skill: it defines the available subagents, their scopes, and when a specialist adds value. A delegation is unfinished work in another scope, not a generic quality pipeline. If a subagent reports `partial`, keep the safe work and relaunch only what still needs guidance. If a subagent reports `blocked` with one concrete uncertainty question, answer it from existing context when possible; if a material decision still cannot be resolved, suspend the work and ask the user for guidance before relaunching the original or a suitable specialist with that explicit guidance.

### Worktree and PR lifecycle

Both routes follow the project Git/worktree rules; short is not an exception. Where those rules explicitly permit a trivial direct-main change, keep that exception; otherwise resolve the root with `git rev-parse --show-toplevel`, ensure `worktrees/` is ignored in the repo-local `.git/info/exclude`, and create/use `<project-root>/worktrees/<canonical-name>` or `<project-root>/worktrees/<canonical-name>-prNN` with the branch matching the worktree name.

Keep one concrete objective per PR: a verifiable vertical slice bounded by contract, coupling and risk. When assessing size, distinguish behavior (including prompts and configuration), tests/fixtures, documentation and generated files; do not ignore any category or split necessary tests away from their change just to reduce a line count. Split at independently verifiable contracts when the combined risk or review burden warrants it, not at a fixed number of added lines.

After the first coherent commit, push the work branch and open the PR with `gh pr create --draft`. Keep it draft while it changes. Mark it ready once with `gh pr ready <number>`. If the project has PR checks configured, wait for Quality Gates, run `gh pr checks <number>`, and verify they pass for the latest commit candidate. If no PR checks are configured, confirm and record their absence; it does not block the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA. If a ready PR needs a fix, run `gh pr ready --undo <number>` before editing, then repeat verification, review, ready, and configured gates.

After each intermediate merge: persist the checkpoint to `work/{name}/pr/{NN}`, update `plan.md`, and keep `work/{name}/` alive. Merge always requires explicit user approval.

### Deterministic verification

Deterministic checks are the routine feedback loop while implementation is in progress: run the relevant tests, lint, and typecheck/build checks at the cheapest seam that can catch the section's regressions. Verify coherent sections rather than every small edit or one big-bang run. Normal handoffs between `implementer` and `tester` do not by themselves justify reviewers or analyzers.

Reuse successful local verification only when its command, configuration, environment, inputs and affected contracts still match; record that scope in the existing checkpoint. Inspect command aliases and do not duplicate the same suite under a second name. If relevance is uncertain, run the applicable lane or fail closed. Required CI checks must still pass for the current candidate SHA and integration context; local reuse never waives a configured gate.

### External-effect preflight

Before the first irreversible or costly external effect, including a draft push that deploys, inspect actual triggers, close critical decisions, run targeted verification and check affected registration records and allowlists. A draft flag does not disable deployments. Use the existing bounded early-review rule only for a critical risk left uncovered by deterministic checks. Do not require full review before every push or bypass opening draft: resolve the unsafe effect before crossing that boundary, reporting a real blocker if it cannot be safely separated. An applied migration follows the project's append-only or recovery policy; do not rewrite it to reduce rework. Never cancel a mutable publication to save time.

### Useful progress

For costly or uncertain assignments, agree on the next observable result and a check-in window proportional to the work, not a universal minute limit. Evidence can be narrowed hypotheses, verified contracts, test results or an active long-running command. Silence and no file edits do not prove a block. At the window without evidence, request one bounded status; preserve safe work and resolve the blocker or reassign only when there is no progress or a concrete impediment. Check ownership and the old worker's stopped state before replacement writes to the same scope. Inspect, resume or stop only through capabilities the current harness actually exposes; if unavailable, report the limit rather than inventing an API or launching a competing writer. Do not turn check-ins into constant polling or routine memory writes.

### Early review

An early review during EXECUTE is an exception, not a default phase. Use it only for a concrete risk that deterministic checks cannot cover and whose feedback can change the remaining implementation. State the bounded risk, use the single most relevant specialist, and run at most one early review per bounded critical section. Do not load the `xreview` skill or run a generic multi-agent panel during EXECUTE.

Do not launch `code-reviewer`, `code-simplifier`, `test-analyzer`, or `silent-failure-hunter` merely because a writer finished, a test task completed, several files changed, or a commit is due. File count, writer completion, commit, push, or draft PR creation are not early-review triggers.

### Bounded retries

Both routes cap a failing task or criterion at three attempts. After the third failure, stop retrying, save the meaningful failure and what was tried through the required outcome or memory path, then re-plan with a different approach or report the blocker; never loop blindly.

The three attempts do not reset by renaming tasks, replacing agents or redelegating the same unresolved criterion. Group accepted fixes by contract and cause. Before a second repair round after the initial review, if blockers persist or fixes introduce regressions, reassess the root cause, scope, owner and testing seam instead of automatically repeating the cycle. Do not automatically launch another review panel. Keep new valid bugs in triage; a rework limit never authorizes ignoring blockers or declaring success. Re-plan within approved scope with a concrete changed approach, or escalate a material scope decision. Keep the reason and useful outcome in the existing checkpoint, not a new budget ledger.
### Final review and PR lifecycle

The review boundary is the final candidate SHA while the PR is still draft, immediately before `gh pr ready`. It is one final review, not a mandatory panel or multiple reviewers for short work. Load and run the portable `xreview` skill when its scoped review adds value and reliable coverage is missing; pass the exact active `work/{name}` to every review subagent, never another work folder. Freeze base/head and merge-base, assign primary responsibility plus necessary support, and preserve each specialist's output contract.

Use the [coverage revalidation rule](../xreview/SKILL.md#7-revalidate-coverage-and-stop): fix-check for a finding, delta-review for affected risks, full review when reliable coverage must be established or broadly rebuilt. A material change requires reassessing coverage, not automatically rerunning the same panel. Previously clean roles reopen when their contracts, dependencies or assumptions change; commits and readiness alone do not trigger reviewers. Record the scope and justification for retained evidence in the existing checkpoint, including changes to base or integration context even when head is unchanged.

Triage valid findings before work/backlog creation, reconcile duplicates and reject false positives with reasons. New valid findings are not discarded for being new. Close when blocking findings and material uncertainty are resolved, fixes verified and current coverage justified, not when there are zero suggestions; the bounded-retry guard still applies.

Both routes keep the PR draft while it changes, use the canonical Git worktree, complete review before ready, wait for configured gates, compare the candidate SHA before reporting or merging, and never merge without explicit user approval.

### Ready handoff

At each verified ready checkpoint, preserve the existing PR metadata (URL/number, candidate SHA, checks and relevant base/dependencies) and briefly summarize the concrete changes and result, not merely the file list. Usually two to four short bullets plus one feedback line are enough. State what worked and any material friction, retries or remaining limitation actually observed; do not invent a balanced story, savings or problems when there were none.

Use the work already performed and its existing evidence/checkpoint; do not launch another agent or investigation just to write the summary. Ready is not merged, deployed or the end of a multi-PR roadmap. Report the actual next action or dependency without granting merge permission or inventing a pause requirement.

Respect the active output contract. In programmatic mode, keep the strict final JSON and its existing keys/types: put changes and factual workflow feedback in `summary`, current limitations in `risks` and pending actions in `next_steps`, preserving PR metadata in allowed text fields. Do not add keys, a `ready` status value, Markdown fences or prose outside that final JSON. Intermediate progress uses the permitted channel rather than pretending to be another final response.

### Continue after a ready checkpoint

A verified ready PR is a checkpoint, not an automatic pause. Give the Ready handoff and continue approved remaining work that can be verified with the available capabilities and project rules. An unavailable publication, migration, deployment or material decision blocks its consumers, not unrelated approved work. Do not invent another task just to keep running, and never infer merge permission from plan approval.

For multi-PR work or a dependency on an unmerged PR, read [PR continuation](../work-lifecycle/references/pr-continuation.md) relative to this skill directory before choosing the next base; if unavailable, report that boundary rather than guessing a dependent base. Keep parents ready and immutable; only a permitted child branch/worktree may advance. Stop when no approved safe work remains or a real capability/decision block prevents it. A runtime supervisor that pauses for an open PR remains a real constraint; this policy does not override its state machine or create background execution.

## Closing rule

Do not declare work finished after analysis or planning alone: complete the routed execution or report the concrete blocker.
