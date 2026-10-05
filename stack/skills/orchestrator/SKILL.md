---
name: orchestrator
description: Coordinate a development objective from clarification through implementation, verification and cleanup. Use for work that benefits from planning or coordination; handle small understood changes directly.
---

# Orchestrator

Own the result, not a procession of agents.

## Clarify and size the work

Combine questions with targeted code inspection. Use grilling when product decisions are unclear; investigate facts yourself. Inspect callers, constraints and existing coverage before choosing a solution, using lean-code for code-bearing work. Stop clarifying once the remaining choices do not materially change the result or risk.

A small understood change needs an agreement and proportionate verification, not formal documents. For substantial work, use to-spec to prepare work/{name}/PRD.md, plan.md and tasks/*.md. Present the plan for approval before implementation. A material scope change needs approval of that change, not a restarted interview.

## Execute coherent units

Work directly when a handoff adds little value; otherwise assign a bounded outcome to implementer, analyst or generalist. Each writer owns implementation and its tests. Reviewers do not run after every edit, test or commit. Keep one writer per worktree, following project Git rules and using native worktrees or Git without custom setup hooks.

Give workers the relevant files, closed decisions, verification and exact task path. Reuse a worker for the same problem; use fresh context for an independent objective. Do not restart an active writer or copy the entire conversation by habit. Workers do not subdelegate.

For costly work, seek an early observable result and ask for one concrete status if it is missing. Fix scope, tooling or the hypothesis rather than repeating failing calls. Use native completion notifications instead of polling when available. Do not reload a skill already in context.

For direct simplification, assign implementer with lean-code; no preliminary simplifier pass is required. Simplifier remains read-only when its analysis is useful.

Use diagnose for failures. Reuse existing tests; add protection only for a real uncovered risk, with RED/GREEN/refactor owned by the implementer. Do not invent unreachable states or legacy data. If fixtures or repair rounds keep growing, simplify the approach before continuing.

## Verify and deliver

Consolidate documentation when behavior is stable. Use xreview for the useful review scope, before declaring the work ready. Validate findings against real premises; fix blockers, not every optional suggestion. Recheck affected behavior after fixes instead of restarting the panel.

Commit coherent groups and open the PR in draft after the first push when the project uses PRs. Ready means implementation, necessary review and fixes are finished. Check the actual candidate and required CI before merge; a SHA identifies evidence, not another workflow phase. An exceptional new defect reopens only affected work. Never merge without explicit user authorization.

Approved independent work may continue while another PR awaits merge. Git dependencies need an isolated coherent base and safe integration order; external prerequisites block their consumers, not everything. Never modify a Ready parent to advance a child or invent work to stay busy.

## Track once and clean up

PRD holds scope, plan holds ownership/dependencies/status, and tasks hold their Markdown specifications. Engram holds useful decisions, discoveries and history, not task specifications or another board. To resume, read the existing work path and relevant memory; do not create a parallel handoff document or reconstruct missing specifications.

Arrange teardown before temporary resources are created. At operation end, stop only owned processes, remove owned temporaries and verify cleanup. Before delivery, report any remaining resources and why they cannot be removed safely.

After authorized merge or cancellation, remove owned branches/worktrees only when no work remains there. Keep work/{name}/ across intermediate merges. At final close, preserve useful history and durable documentation, then remove the work directory without losing pending information. A failed memory write is not permission to erase its only remaining source. Ready alone is not closure.
