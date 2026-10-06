# Templates

Use only the sections that apply; do not leave empty headings. Delimit paths and commands clearly, preserving spaces and flags.

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
[Settled choices about modules, interfaces and contracts, with the reason. No paths or snippets unless they encode a decision.]

## Out of scope
[What is deliberately excluded.]
```

## plan.md

```markdown
# [Readable name]

**Canonical name:** `[name]` · **Status:** [in progress | paused | closed]

## Goal
[Two to four lines.]

## Approach
[The approved design and why. Discarded alternatives in one line each.]

## PRs

| PR | Result | Branch / worktree | Base@SHA, prerequisite, merge order | Status / evidence |
|----|--------|-------------------|-------------------------------------|-------------------|
| 01 | [result] | `[name]-pr01` | `main@[sha]` | pending |

## Success criteria

- **SC-01:** [verifiable behavior]
- **SC-02:** [verifiable behavior]

## Tasks

| # | PR | Owner | Scope and result | Spec | SC | Status | Order | Deps |
|---|----|-------|------------------|------|----|--------|-------|------|
| 01 | 01 | implementer | [bounded result] | [tasks/01.md](tasks/01.md) | SC-01 | pending | 1 | — |
```

- Task status lives only in the task table; PR status and evidence only in the PR table.
- The `SC` column is the only place that maps tasks to criteria.

## tasks/NN.md

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

## Testing decision
- **Risk:** [regression this task can introduce]
- **Existing protection:** [specific test or evidence, or none]
- **New behavior:** [what needs protection, or none]
- **Seam:** [closest reliable seam and why]
- **Action:** [add | update | reuse | no new test] — [reason]
```
