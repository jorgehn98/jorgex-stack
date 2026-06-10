---
name: work-lifecycle
description: Single source for how a piece of work is tracked and advances — memory-first via Engram. Use when starting, tracking, resuming or closing a piece of work, or when deciding where a PRD/plan should live.
---

# Work Lifecycle (memory-first)

Work state, pending items and history live in **Engram memory** — not in folders. There is no `work/` directory, no TODOs folder, no archive folder. History is memory + git.

## Identity

Every piece of work gets a **canonical kebab-case name** when it starts (e.g. `checkout-refactor`), shared with the branch if applicable. The name stays the same across its whole life — it is the key to everything else.

## State

Track state with `mem_save` under a stable topic_key per phase:

```
work/{name}/spec      → decisions captured before implementing (PRD reference, approach)
work/{name}/plan      → task breakdown, sequencing, statuses
work/{name}/{phase}   → outcome of each execution phase (one topic per phase, upserted as it evolves)
work/{name}/done      → final outcome when the work closes
```

- Same evolving phase → same topic_key (upsert). Different phases must not overwrite each other.
- When the orchestrator delegates, it passes the subagent the topic_key to use; the subagent saves BEFORE its final report.

## Artifacts (files only when a human reads them)

- **PRD**: produced with the `to-prd` skill, which publishes it to the project's issue tracker. Write it as a FILE only when a human will review it or it accompanies a PR — and then it goes where the project keeps docs (e.g. `docs/`), following repo conventions. Save its reference (issue URL or path) under `work/{name}/spec`.
- **Plan / tasks**: live in memory or as issues (`to-issues`). Use `references/plan-template.md` for the content structure wherever it lives (memory, issue or file). A plan file is the exception, not the rule.

## Pending work

Pending or upcoming work = issues in the tracker (`to-issues`) or a memory entry under `work/{name}/spec` with its status noted. Never a TODOs folder.

## Resuming

To pick up a piece of work (same or another session):

1. `mem_search("work/{name}")` — or `mem_context` if recent.
2. Read the latest phase saves; continue from the first phase without a saved outcome.

## Closing

When the work is finalized (e.g. PR created and merged into its target branch):

1. `mem_save` under `work/{name}/done`: outcome, what shipped, anything left pending.
2. `mem_session_summary` covers the session as usual.
3. Nothing to move or archive — git has the code, memory has the story.

## Rules

- One piece of work = one canonical name, stable across its whole life.
- Don't mix several distinct pieces of work under the same name/topic_key.
- A piece of work has exactly one current state in memory; advancing it means saving the next phase, not duplicating the previous one.

## Legacy `work/` folders

If a repo still has the old `work/1-TODOs / 2-inProgress / 3-finalized` structure: respect what exists, don't extend it. When you touch a piece of work living there, migrate its state to memory (one `mem_save` per artifact worth keeping) and continue memory-first.
