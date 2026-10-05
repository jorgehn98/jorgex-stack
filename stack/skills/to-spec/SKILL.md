---
name: to-spec
description: Turn an agreed objective and code findings into a concise PRD, execution plan and Markdown task specifications. Use before substantial implementation or when an approved scope changes materially.
---

# To Spec

Synthesize the conversation and relevant code findings; do not repeat an interview that already closed the decisions. Investigate technical unknowns and ask only for material product decisions that remain unresolved.

Use one work/{name}/ directory:
- PRD.md: problem, desired result, scope, settled decisions and non-goals.
- plan.md: verifiable success criteria, bounded tasks with owner/dependencies/status and links to their specifications. Include delivery order and bases when multiple PRs are needed.
- tasks/{NN}.md: the outcome, affected files, decisive context, boundaries and sufficient verification for that task.

Keep scope in the PRD and task state only in the plan. Do not store tasks in Engram, generate another tracker or copy the whole PRD into every task. A task is an integrated result, not a RED/test/GREEN/docs microphase.

For each change, identify the real regression risk, useful existing coverage, any missing behavior protection and the closest reliable test seam. Reuse coverage or state why no new test is needed. Do not invent legacy states, require one approval per test seam or add fixtures merely to fill a template.

Prefer the smallest native/existing solution. State what disappears as well as what is added. Separate Git dependencies from external prerequisites; do not assume an unpublished artifact exists.

Check that every requested outcome has task coverage, references resolve and dependencies are coherent. Unresolved material decisions stay visible and block approval of their affected work. Do not fabricate requirements to close a blank section.

Present the plan for user approval. Planning does not implement, publish, merge or authorize changes to a personal installation. The orchestrator owns execution, tracking and cleanup.
