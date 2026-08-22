---
name: tdd
description: Risk-based test-driven development with a red-green-refactor loop. Use for business rules, bugs/regressions, public contracts, invariants, or explicit test-first work; not automatically for styles, wiring, or mechanical changes.
---

# Test-Driven Development

## Core principle

Tests protect behavior and risk, not files, layers, or coverage percentages. A change needs a **testing decision**, not automatically a new test.

For every change, establish:

1. **Risk** — what meaningful failure could this change introduce?
2. **Existing protection** — which existing test already catches it, if any?
3. **New behavior** — what changed contract or regression needs new protection?
4. **Seam** — what is the strongest test closest to that risk?
5. **Decision** — add/update a test, reuse existing coverage, or add no test with a concrete reason.

One behavior should normally have one authoritative test. Test it again at another layer only when that layer protects a distinct contract.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for boundary-double guidance.

## When to use TDD

Use red-green-refactor when the change defines or repairs:

- Business rules, calculations, validation, dates, or time zones
- A real bug/regression
- Public API, event, schema, or protocol contracts
- Authentication, authorization, RLS, tenant separation, billing, privacy, or data integrity
- Destructive, concurrent, atomic, or idempotent behavior
- Important accessibility or user interactions

Do not impose TDD merely because a file changed. Styling, decorative DOM, wiring, aliases, wrappers, generated code, mechanical refactors, and trivial callbacks usually need existing verification or no new test unless they change meaningful behavior.

## Choose the seam from the risk

Use the cheapest seam that can fail for the real regression:

- Pure rule or calculation → focused unit/module test
- Component interaction or accessibility contract → component/browser test through stable semantics
- Persistence, SQL, RLS, migration, or data-transaction atomicity → real database/integration test
- Other concurrency or atomicity → execute at the implicated filesystem, queue, process, or shared-state boundary
- Public endpoint or privileged function → contract/integration test at that boundary
- Critical cross-system user journey → end-to-end test

“Integration-style” is not inherently stronger. A broad test full of mocks may be weaker than a focused rule test, while a regex over SQL text is weaker than executing the database behavior it claims to protect.

## Anti-pattern: tautological tests

Do not let an assertion recompute the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, or a constant asserted equal to itself). It passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, or the spec.

## Anti-pattern: horizontal slices

Do not write all tests first and then all implementation. This outruns what has been learned and encourages tests of imagined shapes.

Use vertical tracer bullets for each behavior that merits new protection:

```text
RED → one test fails for the intended behavioral reason
GREEN → minimal production change makes it pass
REFACTOR → improve structure while behavior stays green
```

Then repeat for the next distinct behavior. Do not create separate tests merely to split assertions that describe one coherent outcome.

## Workflow

### 1. Make the testing decision

Complete the five-part decision under **Core principle**. If no new protection is warranted, record the reason and run the cheapest sufficient verification; otherwise continue to RED.

### 2. RED, when new protection is warranted

Write one test that fails because the behavior is missing or broken—not because setup, mocks, or fixtures are wrong.

### 3. GREEN

Write only enough production code to satisfy the behavior. Do not anticipate speculative cases.

### 4. Refactor

Refactor only while green. Remove duplication in production and tests, and delete lower-value tests when a stronger test now protects the same behavior.

## Checklist

```text
[ ] When new protection is warranted, RED fails for the intended behavioral reason
[ ] The chosen seam observes behavior or the real boundary at risk
[ ] Another layer would protect a distinct contract, not duplicate this one
[ ] Mocks do not encode internal call choreography
[ ] No-test decisions have a concrete trivial/mechanical/already-covered reason
[ ] Production code is minimal and non-speculative
```
