# Plan & Task Templates

Templates for the two artifacts of a piece of work: `plan.md` (file — the status board) and each formal task's one recoverable spec source (an Engram observation or canonical Markdown). `[name]` is the canonical kebab-case name shared by `work/[name]/`, task references and Engram topic_keys. PR branches/worktrees derive from it: `[name]` for single-PR work, `[name]-prNN` for multi-PR checkpoints.

---

## `work/[name]/` contents

```
work/[name]/
├── PRD.md      # decisions and design (written by the to-prd skill)
├── plan.md     # master index + task status board
└── tasks/      # only when Markdown is the declared task-spec source
    └── [NN].md # canonical Markdown spec for task [NN]
```

Every formal task has exactly one recoverable `Spec` reference in the plan table: an Engram observation with project `[project]` and topic_key `work/[name]/task/[NN]` (the `[NN]` matches `#`) or canonical Markdown at `work/[name]/tasks/[NN].md`. Do not create a second editable copy. Existing Engram task specs remain valid; no mass migration is required.

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
> Every evidence entry cites the relevant `SC-*` criteria it proves and records the command/setup, scope, result and limits.
> PR status advances: ⬜ Pending → 📝 Draft → 🔍 Reviewed → ⏳ Ready / gates when configured → ✅ Merged.
> If a ready PR changes, return it to Draft with `gh pr ready --undo`, clear stale gate evidence, and repeat review plus configured gates for the new SHA. If no PR checks are configured, confirm that from project configuration and record their absence instead of blocking the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA.

| PR | Scope | Branch | Worktree | Base | Status | Merge evidence |
|----|-------|--------|----------|------|--------|----------------|
| 01 | [scope] | [branch] | [worktree] | [base] | ⬜ | [evidence] |
| 02 | [scope] | [branch] | [worktree] | [base] | ⬜ | [evidence] |

> Intermediate PRs do not delete `work/[name]/`; only the final close does.

## Success criteria

- [ ] **SC-01**: [Verifiable behavior 1]
- [ ] **SC-02**: [Verifiable behavior 2]

## Tasks

> Every formal task has exactly one recoverable `Spec` reference: Engram project `[project]` + topic_key `work/[name]/task/NN`, or `work/[name]/tasks/NN.md`. An optional local ID must already be bound to that identity in the current store via `mem_save` or validated scoped lookup. Follow the lifecycle handoff before full retrieval; verify identity and access before execution and never leave two active specs.
> A direct message is only an auxiliary, self-contained microassignment of a parent task. It has no independent `SC` or row; if it grows into independent work, persist its spec and add the formal task first.
> Task status lives ONLY in this table — update it with a surgical edit per task.
> PR status/evidence lives in the PR Roadmap above.
> Map each task to the PR that carries it; intermediate PRs keep `work/[name]/` alive.
> The `SC` column is the single home of task-to-criterion coverage. Do not duplicate that mapping in the task spec source.

| # | PR | Agent | Scope | Spec | Task | One-liner | SC | Status | Wave | Deps |
|---|----|-------|-------|------|------|-----------|----|--------|------|------|
| 01 | 01 | [agent] | [bounded scope] | Engram project: [project], topic_key: `work/[name]/task/01`, local ID: [id only if bound in current store; otherwise omit] | [descriptive name] | [one-line description] | SC-01 | ⬜ | 1 | — |
| 02 | 01 | [agent] | [bounded scope] | `work/[name]/tasks/02.md` | [descriptive name] | [one-line description] | SC-02 | ⬜ | 1 | — |
| 03 | 02 | [agent] | [bounded scope] | [one declared source] | [descriptive name] | [one-line description] | SC-01 | ⬜ | 2 | 01 |
| 04 | 02 | [agent] | [bounded scope] | [one declared source] | [descriptive name] | [one-line description] | SC-02 | ⬜ | 2 | 01, 02 |

**Statuses**: ⬜ Pending → 🔴 RED → 🟢 GREEN → 🔍 Review → ✅ Done
```

---

## Task observation / Markdown task specification — Template

Use this adaptable content in the one source declared by the plan's `Spec` column. For Engram, save it in project `[project]` as the task observation under topic_key `work/[name]/task/[NN]`; for Markdown, use `work/[name]/tasks/[NN].md`. The source must be self-contained enough for its assigned worker, but include only what is pertinent.

```markdown
# T[NN]: [Descriptive task name]

## result and scope

- **result**: [the completed outcome]
- **scope**: read [paths/context] and write [bounded paths], if applicable.

## decisive context

[Only the decisions, verified facts and precise references the worker needs. Include a fragment only when it clarifies the contract.]

## contract and invariants

[Relevant behavior, boundaries and edge cases. Omit categories that do not apply.]

## validation and escalation

[Verification that demonstrates completion. Escalate a material uncertainty, missing source access or identity mismatch instead of reconstructing the spec from the PRD.]

## Testing decision

- **Risk**: [meaningful regression this task can introduce]
- **Existing protection**: [specific existing test/evidence, or none]
- **New behavior**: [behavior needing new protection, or none]
- **Chosen seam**: [closest authoritative seam and why]
- **Action**: [add | update | reuse | no new test] — [concrete reason]
```

Use only the headings and fields that are pertinent, except retain the complete testing decision when the task changes behavior. Do not require literal code, input/output blocks or empty heading, section or field. Existing Engram task observations remain compatible; adapt this template only for newly created or materially revised specs.
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
- Reference the original source precisely; include a literal code fragment only when it clarifies the contract.
- Indicate source file and line for each included snippet.

### Acceptance criteria

- **VERIFIABLE**: "the type includes X", not "the type is correct".
- **SPECIFIC**: no copy-paste of generic criteria.
- **COMPLETE**: cover happy path, edge cases and errors.

### Constraints

- Include the relevant project rules as constraints.
- If there are no special constraints, say so explicitly.
