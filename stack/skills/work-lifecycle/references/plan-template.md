# Plan & Task Templates — in-progress folder

Use these structures when creating `work/2-inProgress/[name]/`.

`[name]` is the canonical name shared by the folder and the branch (kebab-case).

---

## Folder structure

```
work/2-inProgress/[name]/
├── PRD.md                      # decisions and design
├── plan.md                     # master index
└── tasks/
    ├── 01-[description].md      # atomic task
    ├── 02-[description].md
    └── ...
```

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

| # | Task | File | Status | Wave | Deps |
|---|------|------|--------|------|------|
| 01 | [descriptive name] | `tasks/01-xxx.md` | ⬜ | 1 | — |
| 02 | [descriptive name] | `tasks/02-xxx.md` | ⬜ | 1 | — |
| 03 | [descriptive name] | `tasks/03-xxx.md` | ⬜ | 2 | 01 |
| 04 | [descriptive name] | `tasks/04-xxx.md` | ⬜ | 2 | 01, 02 |

**Statuses**: ⬜ Pending → 🔴 RED → 🟢 GREEN → 🔍 Review → ✅ Done
```

---

## Task file — Template

Each task file is self-contained: a subagent reads it and has all the context needed to work without asking back. Don't write unnecessary information or full code blocks unless needed. In the chosen approach, write only what the subagent needs to understand it perfectly.

```markdown
# T[##]: [Descriptive task name]

**Status**: ⬜ Pending
**Wave**: [number]
**Dependencies**: [T## or —]

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

## Task creation rules

### Atomicity

- **Max ~5 implementation steps** per task. If more → split into two tasks.

### Structure

- **Natural order**: data layer → generated types → services/hooks → components/UI.
- **Numbering**: `01`, `02`, `03`... (two digits).
- **File name**: `[number]-[kebab-description].md` (e.g. `03-user-list-hook.md`).

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
```
