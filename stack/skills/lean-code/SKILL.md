---
name: lean-code
description: Lean / anti-overengineering skill. Use when deciding whether code should exist, when to prefer stdlib or native APIs, and when to simplify recently changed code without changing behavior.
---

# Lean Code

Use the smallest change that genuinely solves the problem.

## Understand first

Before choosing a rung, read the affected code and understand the touched flow and caller impact. Trace the actual path through inputs, outputs, callers and shared seams; a small diff at the wrong seam is not lean.

## The ladder

Work top-down. Stop as soon as a step solves it:

1. **Do nothing / delete it** if the need is speculative or nothing depends on the code.
2. **Reuse existing project code** if a helper, component, command or module already solves the same need.
3. **Use stdlib first** before adding a package or custom helper.
4. **Use native/platform APIs** before wrapping them in new abstractions.
5. **Use an already-installed dependency** when it safely covers the case.
6. **Write the smallest obvious code** only when the previous steps do not fit.

## Questions to ask

- Does this need new code at all?
- Is there already a project helper or pattern that does it?
- Can stdlib or the platform do it directly?
- Can an existing dependency already cover this safely without adding a new one?
- Can the same result be expressed with one clear step instead of a new layer?

## Guardrails

Lean code does **not** mean weaker code.

For bug fixes, distinguish the reported symptom from root cause. Prefer one fix at the shared seam when appropriate instead of repeating caller-side patches or leaving sibling paths exposed.

Reject line-count-only code golf: reduce complexity and change surface, not merely line count. Shorter code that weakens clarity/correctness, hides intent or is fragile is not lean.

When accepting a deliberate limit, record its ceiling, revisit trigger and exactly one existing tracking home: the current task, an issue or the project's backlog. Do not create a parallel marker or ledger.

Keep explicit code when the change touches:

- security or permissions
- validation or sanitisation
- accessibility
- data-loss or persistence boundaries
- public contracts, types, schemas, or APIs
- tests or regression seams

If simplification weakens any of those, stop.

Do not add a new dependency unless the task explicitly requires it or the project already has approval for that dependency.

## Diagnostic tooling and evidence

Reuse the existing harness, test helpers and platform tools before writing a custom profiler, wrapper or diagnostic runner.

New diagnostic tooling is temporary by default. Keep it as maintained code only for a concrete recurring need and an identified consumer within the approved scope; proving one change is not enough. If maintaining it expands the scope, seek approval before keeping it. Moving it into a `debug/` directory does not justify retention.

For a one-off diagnosis or performance comparison, preserve the relevant regressions and compact reproducible evidence in the existing work record: command, setup, refs/inputs, result and limits. Do not commit repeated raw captures or build a second tool and its own suite merely to preserve that evidence. Existing recurring benchmarks and tools remain valid when they serve a real ongoing need.

Remove owned temporary instrumentation after capturing the necessary evidence. Do not remove permission, concurrency, deletion or other meaningful regression protection just to shrink the diff.

## How to use it

### Implementation

Before adding a new helper, wrapper, abstraction, or dependency, run the ladder again.
Prefer the narrowest change that solves the real need.

### Review / simplification

Use it as a bloat filter: delete, stdlib, native/platform, reuse, or shrink.
If the code is already minimal and clear, leave it alone.

### Audit

Rank findings as:

- delete
- stdlib
- native/platform
- reuse
- yagni
- shrink

Do not propose rewrites that only move complexity around.
