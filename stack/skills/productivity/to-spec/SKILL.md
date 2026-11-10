---
name: to-spec
description: Turn an agreed objective into a concise PRD, delivery plan and Markdown task specifications, for code or any other kind of work. Use before substantial implementation or when an approved scope changes materially.
---

# To Spec

Turn an agreed objective into `work/{name}/` with a PRD, a plan and task specifications. The core is the same for any kind of work; the section *When the work changes code* keeps everything a code change needs. It applies task by task: a task that changes code carries it, one that does not omits it instead of inventing its content. Templates: [references/templates.md](references/templates.md).

## Before writing

- Synthesize the conversation and the findings that matter to the work —code findings, market or operational facts, prior decisions—; do not repeat an interview that already closed the decisions.
- Investigate unresolved unknowns yourself. Ask only for material product decisions that remain.
- "Consider X" or "evaluate X" is a question, not a requirement: find who consumes it before specifying it.
- `{name}` is one canonical kebab-case name shared by the work directory and, when the work changes code, by the branch and worktree.

## Artifacts

- `PRD.md`: problem, desired result, scope, settled decisions and non-goals.
- `plan.md`: verifiable success criteria (`SC-NN`), delivery order and, when the work changes code, the PR bases and merge order; and the task table with owner, dependencies, criteria covered and status.
- `tasks/{NN}.md`: the outcome, affected files (or areas, in a task that changes no code), decisive context, boundaries and sufficient verification for that task.

## Rules

- When the orchestrator asks to pause after the PRD, write only `PRD.md`; plan and tasks follow on resume, and the checks below cover the full set.
- One home per fact: scope in the PRD; criteria, coverage and status only in the plan; the specification only in its task file.
- Do not store tasks in Engram, generate another tracker or copy the PRD into every task.
- A task is an integrated, independently verifiable result, not a microphase such as a RED, test or GREEN step, a docs-only step, a single draft or a single asset.
- Criteria are verifiable and specific: "the type includes X" or "the welcome email goes out within a minute of signup", not "the type is correct" or "the campaign works".
- In a task, separate verified facts from assumptions, cite the source of what you copy and include only what is pertinent.
- Prefer the smallest existing or simplest solution. State what disappears as well as what is added.
- Separate dependencies on other work from external prerequisites; do not assume an unpublished artifact or an unconfirmed commitment exists.
- Mark an unresolved material decision as `[NEEDS CLARIFICATION: …]`. It stays visible and blocks approval of the affected work.

## When the work changes code

These rules apply, exactly as written, to every task that changes code, including those inside mixed work. A task that changes no code omits them rather than inventing their content.

- Plan the delivery of code changes in pull requests, each with its branch, worktree and base@SHA, and keep the bases and merge order compatible with the task dependencies.
- Testing decision per behavior change: risk, existing protection, new behavior to protect, chosen seam and action (add, update, reuse or no new test) with its reason.
- A task with user-facing behavior lists under Verification and escalation the flows to walk in the browser; this complements the testing decision and never replaces it.
- Name the exact files to write and the engineering role owner (for example `implementer`) in the task.
- Do not invent legacy states, require one approval per test seam or add fixtures to fill a template.

## Check before presenting

- Every requested outcome maps to a criterion, and every criterion to at least one task.
- Every task has an owner, scope, files (areas, if it changes no code) and dependencies; when it changes code, also a complete testing decision and the browser flows of any user-facing behavior.
- When tasks change code, PR bases and merge order are compatible with task dependencies.
- Tasks and plans without code leave out the code-specific tables and headings instead of leaving them empty or filling them with invented content.
- References resolve, and PRD, plan and tasks do not contradict each other.
- No blank section was filled with a fabricated requirement.

## Limits

- Present the plan for user approval.
- Planning does not implement, publish, merge or authorize changes to a live system or installation.
- Execution, tracking and cleanup belong to whoever executes the work; in code work, the orchestrator.
