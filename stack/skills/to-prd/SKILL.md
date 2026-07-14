---
name: to-prd
description: Turn the current conversation context into a PRD at work/{name}/PRD.md (work-lifecycle flow). Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Prefer an existing seam when it is strong enough, and choose the closest seam that can fail for the concrete regression risk. Introduce a new seam only when existing ones cannot provide reliable evidence.

Do not choose from a fixed test pyramid or a requirement to add tests. Prefer one authoritative test at the strongest seam closest to the risk; another layer is justified only for a distinct contract. Record existing coverage and valid no-new-test decisions for trivial, mechanical, generated, styling, or wiring changes.

Check with the user that these seams match their expectations.

3. Write the PRD using the template below to `work/{name}/PRD.md`, where `{name}` is the work's canonical kebab-case name (see the `work-lifecycle` skill) — the human reviews it there. Exception: if the project manages its work through an issue tracker and the user wants the PRD there, publish it to the tracker instead and apply the `ready-for-agent` triage label — no need for additional triage.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Delivery / PR Roadmap

This section captures the intended PR split only. Live status, checkpoints, and task progress belong in `plan.md`.

1. PR 01 — [scope / outcome]
2. PR 02 — [scope / outcome]
3. PR 03 — [scope / outcome]

Keep this static: describe the planned delivery slices, not the current state.

## Testing Decisions

A list of testing decisions that were made. Include:

- The meaningful regression risk introduced by each behavior change
- Which existing tests already protect it
- Which new behavior requires protection
- The chosen seam and why it is closest to the risk
- Why another layer would protect a distinct contract rather than duplicate the same behavior
- Why no new test is needed for trivial, mechanical, generated, styling, wiring, or already-covered changes
- Prior art for the selected tests (i.e. similar valuable tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
