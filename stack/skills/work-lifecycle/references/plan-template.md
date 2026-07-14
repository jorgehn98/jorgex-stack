# Plan & Task Templates

Templates for the two artifacts of a piece of work: `plan.md` (file — the status board) and the atomic tasks (Engram observations). `[name]` is the canonical kebab-case name shared by `work/[name]/` and every topic_key. PR branches/worktrees derive from it: `[name]` for single-PR work, `[name]-prNN` for multi-PR checkpoints.

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

## PR Roadmap

> This is the live PR-level board: scope, PR status, and merge evidence live here.
> Task-level status stays in the task table below.
> Full checkpoint history lives in Engram under `work/[name]/pr/[NN]`.
> PR status advances: ⬜ Pending → 📝 Draft → 🔍 Reviewed → ⏳ Ready / gates when configured → ✅ Merged.
> If a ready PR changes, return it to Draft with `gh pr ready --undo`, clear stale gate evidence, and repeat review plus configured gates for the new SHA. If no PR checks are configured, confirm that from project configuration and record their absence instead of blocking the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA.

| PR | Scope | Branch | Worktree | Base | Status | Merge evidence |
|----|-------|--------|----------|------|--------|----------------|
| 01 | [scope] | [branch] | [worktree] | [base] | ⬜ | [evidence] |
| 02 | [scope] | [branch] | [worktree] | [base] | ⬜ | [evidence] |

> Intermediate PRs do not delete `work/[name]/`; only the final close does.

## Success criteria

- [ ] [Verifiable behavior 1]
- [ ] [Verifiable behavior 2]
- [ ] Task-specific verification passes, if applicable

## Tasks

> Full spec of task NN → Engram topic_key `work/[name]/task/NN`.
> Task status lives ONLY in this table — update it with a surgical edit per task.
> PR status/evidence lives in the PR Roadmap above.
> Map each task to the PR that carries it; intermediate PRs keep `work/[name]/` alive.

| # | PR | Task | One-liner | Status | Wave | Deps |
|---|----|------|-----------|--------|------|------|
| 01 | 01 | [descriptive name] | [one-line description] | ⬜ | 1 | — |
| 02 | 01 | [descriptive name] | [one-line description] | ⬜ | 1 | — |
| 03 | 02 | [descriptive name] | [one-line description] | ⬜ | 2 | 01 |
| 04 | 02 | [descriptive name] | [one-line description] | ⬜ | 2 | 01, 02 |

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

## Testing decision

- **Risk**: [meaningful regression this task can introduce]
- **Existing protection**: [specific existing test/evidence, or none]
- **New behavior**: [behavior needing new protection, or none]
- **Chosen seam**: [unit/component/database/integration/contract/e2e and why it is closest to the risk]
- **Action**: [add | update | reuse | no new test] — [concrete reason]

Prefer one authoritative test per behavior. Another layer is justified only when it protects a distinct contract. Styling, wiring, generated code, mechanical refactors, and trivial changes may use `no new test`; business rules, bugs/regressions, public contracts, and invariants should normally use TDD.

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

ONE observation per project holds every pending idea (topic_key `work/backlog`). Each item is just:

```markdown
- **[short title]** — [one-line description of the idea and its value]
```

When an item starts, remove it from this list and create its `work/[name]/`.

Mutation is serialized: the coordinator is the single writer, reads the exact observation with `mem_get_observation`, preserves all unrelated lines, sends the complete content through `mem_update`, then reads it again to verify. Never send a delta or use a blind topic-key upsert. See **Safe backlog mutation** in the parent skill for the full protocol and the current reason not to use one observation per item.

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
