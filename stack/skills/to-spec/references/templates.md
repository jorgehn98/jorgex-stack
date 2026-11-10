# Templates

Use only the sections that apply; do not leave empty headings. Parts marked **code only** belong to tasks that change code: omit them everywhere else instead of filling them with invented content. Delimit paths and commands clearly, preserving spaces and flags.

## PRD.md

```markdown
# [Readable name]

## Problem
[What hurts today and for whom.]

## Desired result
[What will be true when this is done.]

## Scope
[What is included.]

## Decisions
[Settled choices that constrain the work, with the reason (in code work: module, interface and contract choices). No paths or snippets unless they encode a decision.]

## Out of scope
[What is deliberately excluded.]
```

## plan.md

**Code only:** the `PRs` section and the `PR` column of the task table. Delete them when no task changes code; delivery order and prerequisites stay in the task table's `Order` and `Deps` columns.

```markdown
# [Readable name]

**Canonical name:** `[name]` · **Status:** [in progress | paused | closed]

## Goal
[Two to four lines.]

## Approach
[The approved approach and why. Discarded alternatives in one line each.]

## PRs (code only)

| PR | Result | Branch / worktree | Base@SHA, prerequisite, merge order | Status / evidence |
|----|--------|-------------------|-------------------------------------|-------------------|
| 01 | [result] | `[name]-pr01` | `main@[sha]` | pending |

## Success criteria

- **SC-01:** [verifiable behavior]
- **SC-02:** [verifiable behavior]

## Tasks

| # | PR (code only) | Owner | Scope and result | Spec | SC | Status | Order | Deps |
|---|----|-------|------------------|------|----|--------|-------|------|
| 01 | 01 | [owner] | [bounded result] | [tasks/01.md](tasks/01.md) | SC-01 | pending | 1 | — |
```

- Task status lives only in the task table; PR status and evidence only in the PR table.
- The `SC` column is the only place that maps tasks to criteria.
- `Owner` is whoever delivers the task; code work names its engineering role skill (for example `implementer`).

## tasks/NN.md

**Code only:** the testing decision, and exact file paths in `Scope`. In a task that changes no code, `Scope` names the areas or artifacts it reads and produces, `Contract and invariants` may be omitted, and `Verification and escalation` states what proves completion without a test seam.

```markdown
# T[NN] — [Task name]

## Result and scope
- **Result:** [the completed outcome]
- **Scope:** read [paths]; write [bounded paths]

## Decisive context
[Closed decisions, verified facts and precise references. Mark assumptions and open questions that could change the task.]

## Contract and invariants
[Behavior, boundaries and edge cases that apply.]

## Verification and escalation
[What demonstrates completion, and the concrete conditions that require asking.]

## Testing decision (code only)
- **Risk:** [regression this task can introduce]
- **Existing protection:** [specific test or evidence, or none]
- **New behavior:** [what needs protection, or none]
- **Seam:** [closest reliable seam and why]
- **Action:** [add | update | reuse | no new test] — [reason]
```
