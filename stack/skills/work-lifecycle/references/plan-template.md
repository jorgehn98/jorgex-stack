# Plan & Task Templates

Templates for the two artifacts of a piece of work: `plan.md` (file — the status board) and the atomic tasks (Engram observations). `[name]` is the canonical kebab-case name shared by `work/[name]/`, the branch and every topic_key.

---

## `work/[name]/` contents

```
work/[name]/
├── PRD.md      # decisions and design (written by the to-prd skill)
└── plan.md     # master index + task status board
```

The full spec of each task is NOT a file: it lives in Engram, one observation per task with topic_key `work/[name]/task/[NN]` (the `[NN]` matches the `#` column of the plan table).

---

## plan.md — Template

```markdown
# [Readable Feature Name]

**Canonical name**: `[name]`
**Branch**: [branch name] | **Date**: YYYY-MM-DD | **Status**: In progress

## Goal

[What is being built and why — 2-4 lines]

## Chosen approach

[Summary of the approved design — why this approach was chosen]

### Discarded: [name]

[Why it wasn't chosen]

## Success criteria

- [ ] [Verifiable behavior 1]
- [ ] [Verifiable behavior 2]
- [ ] Task-specific verification passes, if applicable

## Tasks

> Full spec of task NN → Engram topic_key `work/[name]/task/NN`.
> Status lives ONLY in this table — update it with a surgical edit per task.

| # | Task | One-liner | Status | Wave | Deps |
|---|------|-----------|--------|------|------|
| 01 | [descriptive name] | [one-line description] | ⬜ | 1 | — |
| 02 | [descriptive name] | [one-line description] | ⬜ | 1 | — |
| 03 | [descriptive name] | [one-line description] | ⬜ | 2 | 01 |
| 04 | [descriptive name] | [one-line description] | ⬜ | 2 | 01, 02 |

**Statuses**: ⬜ Pending → 🔴 RED → 🟢 GREEN → 🔍 Review → ✅ Done
```

---

## Task observation — Template (`mem_save` per task)

Each task observation is self-contained: a subagent retrieves it by topic_key and has all the context needed to work without asking back. Don't write unnecessary information or full code blocks unless needed. In the context section, write only what the subagent needs to understand it perfectly.

`mem_save` fields:

- **title**: `[name]/task/[NN] — [descriptive task name]`
- **topic_key**: `work/[name]/task/[NN]`
- **type**: `architecture`
- **content**: the markdown below

Status, wave and dependencies live in the plan.md table (single home) — do NOT repeat them here.

```markdown
# T[NN]: [Descriptive task name]

## Intent

[EXPLICIT: why we're doing this task. The problem it solves or the need it covers.]

## Affected files

> Only include files the agent of THIS task can modify.
> If there are tests, translations or user docs, create a separate task for the right specialist.

| File | Action | Why |
|------|--------|-----|
| `path/to/file` | CREATE | [concrete reason] |
| `path/to/other` | MODIFY | [concrete reason] |

## Out of scope / Delegate

| Agent | Pending work | Required inputs |
|-------|--------------|-----------------|
| `[agent]` | [work that belongs to another scope] | [minimal inputs] |

## Constraints

[Technical constraints the subagent MUST respect. If none beyond project rules, say so explicitly.]

## Context

[Extracted from the analysts' output — only what's relevant for THIS task. Copy real code snippets, don't describe them. Indicate source file:line for each snippet.]

### Current relevant state

[Existing code being modified or extended — copy literally]

### Pattern to follow

[If there's an existing pattern in the codebase to replicate — copy literally with file:line]

## Specification

[What the code must do — exact behavior.]

### Expected behavior

- **Input**: [what it receives]
- **Output**: [what it returns/produces]
- **Side effects**: [queries, mutations, etc. if any]

### Edge cases

- [Edge case and how to handle it]

### Business rules

- [Rule]

## Acceptance criteria

[VERIFIABLE and SPECIFIC criteria — not generic. Each must be checkable manually or automatically.]

- [ ] [Verifiable criterion 1]
- [ ] [Verifiable criterion 2]
- [ ] Task-specific verification passes, if applicable

## Additional notes

[Anything the subagent should know that doesn't fit above.]
```

---

## Backlog entry — Template (`work/backlog`)

ONE observation per project holds every pending idea (topic_key `work/backlog`, upserted). Each item is just:

```markdown
- **[short title]** — [one-line description of the idea and its value]
```

When an item starts, remove it from this list and create its `work/[name]/`.

---

## Task creation rules

### Atomicity

- **Max ~5 implementation steps** per task. If more → split into two tasks.

### Structure

- **Natural order**: data layer → generated types → services/hooks → components/UI.
- **Numbering**: `01`, `02`, `03`... (two digits) — shared by the plan table row and the topic_key.

### Context

- Copy only the relevant info from the analysis, not the whole report.
- **Copy code literally**, don't describe it.
- Indicate source file and line for each copied snippet.

### Acceptance criteria

- **VERIFIABLE**: "the type includes X", not "the type is correct".
- **SPECIFIC**: no copy-paste of generic criteria.
- **COMPLETE**: cover happy path, edge cases and errors.

### Constraints

- Include the relevant project rules as constraints.
- If there are no special constraints, say so explicitly.
