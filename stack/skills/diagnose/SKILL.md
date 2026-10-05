---
name: diagnose
description: Diagnose bugs, failing tests, unexpected behavior or performance regressions from concrete evidence. Use before proposing a fix, choosing the smallest useful reproduction.
---

# Diagnose

Start with the observed symptom and decisive logs/code. Redact secrets before showing evidence. Inspect the actual call path, invariants, runner and existing tests before inventing inputs or building a harness.

Prefer a failing existing test or a small reproduction of the reachable behavior. For timing/performance problems, measure comparable work and distinguish model, tool and human waiting. A clear error and call path need not become a speculative list of theories.

State the likely cause and what observation would disprove it. Test the uncertain assumption, not every possible edge. If evidence is insufficient, seek the smallest authorized probe; do not add production logging, dependencies or another supervisor by default.

Fix the cause at the narrowest useful seam. Add a regression test only when existing coverage does not catch the real failure; expected outcomes must not be copied from the implementation. Do not repeat a flaky test until green, widen timeouts blindly or fake data that contradicts enforced invariants.

Recheck the affected behavior and meaningful nearby risks. If the same approach keeps failing, simplify or report the concrete blocker. Keep only the regression evidence and necessary test, not a disposable diagnostic framework.

Arrange cleanup before temporary probes/processes are created, stop only owned processes and verify removal on success or failure. Report the cause, fix, verification and any unresolved limitation.
