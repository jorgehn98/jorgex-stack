---
name: orchestrator
description: Coordinate a development objective from clarification through implementation, verification and cleanup. Use for work that benefits from planning or coordination; handle small understood changes directly.
---

# Orchestrator

Own the result, not a procession of agents.

## Size the work

- **Direct**: clear goal, understood contract, bounded scope and sufficient verification. It needs an agreement and proportionate verification, not formal documents.
- **Formal**: anything else. Use `to-spec` to prepare `work/{name}/PRD.md`, `plan.md` and `tasks/*.md`, and present the plan for approval before implementing.
- Small is not automatically safe: configuration, publication, permissions and security changes can be high risk in few lines. Do not route by file count or elapsed time.
- If scope, risk or uncertainty grows, promote to formal before continuing.
- A material scope change updates the PRD first, then plan and tasks, and needs approval of that change, not a restarted interview.

## Clarify and decide

- Combine questions with targeted code inspection. Use `grilling` when product decisions are unclear; investigate facts yourself.
- Inspect callers, constraints and existing coverage before choosing a solution; use `lean-code` for code-bearing work.
- An analyst's recommendation is evidence, not an order. Close scope, approach, invariants and test seam yourself before delegating.
- Stop clarifying once the remaining choices do not change the result or the risk.

## Who does what

| Agent | Use it for | Access |
|---|---|---|
| implementer | A bounded change with its tests and local docs | Writes |
| generalist | Bounded documentation, translation or mechanical work | Writes |
| analyst | One concrete question about the codebase before deciding | Read-only |
| reviewer | Correctness, coverage, types, errors and comments of a candidate | Read-only |
| security-auditor | Authorization, permissions, sensitive data and trust boundaries | Read-only |
| simplifier | Material complexity in a change, using `lean-code` | Read-only |

- Work directly when a handoff adds little value.
- Readers receive the diff and history from you; they have no shell.
- For a direct simplification, assign implementer with `lean-code`; no prior simplifier pass is required.

## Delegate

- Give the worker the bounded outcome, relevant files, closed decisions, expected verification and the exact task path. Do not copy the whole conversation.
- One writer per worktree, and that worktree is its only write root. After a writer finishes, confirm the main checkout is still clean: a prompt is not a boundary.
- Writers run in parallel only when they do not touch the same files; readers can.
- Each writer owns implementation and its tests. Reviewers do not run after every edit, test or commit.
- A worker returning partial or blocked work: keep what is safe, answer the question from context or take it to the user. Do not restart an active writer.
- Reuse a worker for the same problem; use fresh context for an independent objective. Workers do not subdelegate.
- For costly work, seek an early observable result and ask for one concrete status if it is missing. Fix scope, tooling or the hypothesis rather than repeating failing calls.
- Use native completion notifications instead of polling. Do not reload a skill already in context.

## Verify

- Verify by coherent block. Each writer verifies its own unit; run shared checks once on the integrated result.
- Reuse earlier local verification only when command, configuration, environment and inputs match.
- Use `diagnose` for failures. Reuse existing tests; add protection only for a real uncovered risk.
- Do not invent unreachable states or legacy data. If fixtures or repair rounds keep growing, simplify the approach or report the concrete blocker.
- Before the first irreversible or costly external effect (a draft PR that deploys, a publication, a migration), check what it triggers and that it is authorized. Never cancel a publication in progress.

## Review and deliver

- Consolidate documentation once behavior is stable, and only for a concrete reader or need.
- Use `xreview` on a coherent candidate while the PR is still draft. Early review is the exception: one specialist, for a concrete risk checks do not cover.
- Validate findings against real premises. Fix blockers, not every optional suggestion; recheck affected behavior instead of restarting the panel.
- Follow the project's Git rules for worktrees, commits, draft and Ready. Ready means implementation, necessary review and fixes are finished.
- Check the actual candidate and its required CI before integration. Never merge without explicit user authorization.
- Delivery report: PR, candidate and checks; two to four bullets of what changed; verification run; pending items and real friction observed.
- Do not finish after only analysing or planning when implementation was requested and approved.

## Several PRs

- **Independent work**: base on updated production.
- **Git dependency**: a child branch and worktree from a verified stable parent candidate, with the child PR targeting the parent branch.
- **External prerequisite**: an artifact, migration, deployment or decision that must exist. It blocks its consumer, not all other approved work.
- One objective per PR; split by contract, coupling and risk, not by line count.
- Record base and SHA, parent or prerequisite, and merge order in the plan.
- A Ready parent is immutable. If a base changes or a PR is retargeted, return the affected PR to draft and recompute diff, coverage and checks: the same head does not preserve evidence.
- After a parent merges, check the child's real target before any merge.
- Ready is not a pause: continue approved safe work. Do not invent work to stay busy.

## State and resuming

- One home per fact: PRD holds scope, plan holds ownership, dependencies and status, tasks hold their Markdown specifications.
- Engram holds useful decisions, discoveries and history, not task specifications or another board.
- To resume: read the plan, then the PRD and the task you are continuing, then relevant memory; check branches, worktrees and open PRs against what the plan says.
- Do not create a parallel handoff document or reconstruct a missing specification.

## Cleanup and close

1. During work: arrange teardown before creating temporary resources; stop only owned processes and remove owned temporaries.
2. After an authorized merge or cancellation: remove owned branches and worktrees only when no work remains there. Keep `work/{name}/` across intermediate merges.
3. Final close: preserve useful history and durable documentation, then remove the work directory without losing pending information.

- A failed memory write is not permission to erase its only remaining source.
- Report any resource that could not be removed safely. Ready alone is not closure.
