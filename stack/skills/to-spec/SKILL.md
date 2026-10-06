---
name: to-spec
description: Turn an agreed objective and code findings into a concise PRD, execution plan and Markdown task specifications. Use before substantial implementation or when an approved scope changes materially.
---

# To Spec

Turn an agreed objective into `work/{name}/` with a PRD, a plan and task specifications. Templates: [references/templates.md](references/templates.md).

## Before writing

- Synthesize the conversation and the relevant code findings; do not repeat an interview that already closed the decisions.
- Investigate technical unknowns yourself. Ask only for material product decisions that remain unresolved.
- "Consider X" or "evaluate X" is a question, not a requirement: find who consumes it before specifying it.
- `{name}` is one canonical kebab-case name shared by the work directory, branch and worktree.

## Artifacts

- `PRD.md`: problem, desired result, scope, settled decisions and non-goals.
- `plan.md`: verifiable success criteria (`SC-NN`), delivery order and bases when several PRs are needed, and the task table with owner, dependencies, criteria covered and status.
- `tasks/{NN}.md`: the outcome, affected files, decisive context, boundaries and sufficient verification for that task.

## Rules

- One home per fact: scope in the PRD; criteria, coverage and status only in the plan; the specification only in its task file.
- Do not store tasks in Engram, generate another tracker or copy the PRD into every task.
- A task is an integrated, independently verifiable result, not a RED, test, GREEN or docs microphase.
- Criteria are verifiable and specific: "the type includes X", not "the type is correct".
- In a task, separate verified facts from assumptions, cite the source of what you copy and include only what is pertinent.
- Testing decision per behavior change: risk, existing protection, new behavior to protect, chosen seam and action (add, update, reuse or no new test) with its reason.
- Do not invent legacy states, require one approval per test seam or add fixtures to fill a template.
- Prefer the smallest native or existing solution. State what disappears as well as what is added.
- Separate Git dependencies from external prerequisites; do not assume an unpublished artifact exists.
- Mark an unresolved material decision as `[NEEDS CLARIFICATION: …]`. It stays visible and blocks approval of the affected work.

## Check before presenting

- Every requested outcome maps to a criterion, and every criterion to at least one task.
- Every task has an owner, scope, files, dependencies and a complete testing decision when it changes behavior.
- PR bases and merge order are compatible with task dependencies.
- References resolve, and PRD, plan and tasks do not contradict each other.
- No blank section was filled with a fabricated requirement.

## Limits

- Present the plan for user approval.
- Planning does not implement, publish, merge or authorize changes to a personal installation.
- The orchestrator owns execution, tracking and cleanup.
