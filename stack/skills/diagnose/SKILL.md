---
name: diagnose
description: Diagnose bugs, failing tests, unexpected behavior or performance regressions from concrete evidence. Use before proposing a fix, choosing the smallest useful reproduction.
---

# Diagnose

Find the cause from evidence before proposing a fix.

## Symptom and evidence

- Start with the observed symptom and the decisive logs and code.
- Redact secrets before showing any evidence; keep credentials in the environment, not in commands or output.
- Inspect the actual call path, invariants, runner and existing tests before inventing inputs or building a harness.
- A clear error and call path need not become a list of theories.

## Reproducible signal

Choose the cheapest option that fails on this bug:

1. An existing or new failing test at the seam that reaches it.
2. An HTTP request or CLI invocation with a fixture input.
3. A browser script when the failure is in the UI.
4. A replay of a captured request, payload or event log.
5. A differential run: old version against new, or two configurations.
6. `git bisect run` when the failure appeared between two known states.

- Confirm it reproduces the failure the user described, not a nearby one.
- Minimise by removing one element at a time.
- Make it deterministic where it matters: time, seed, filesystem, network.
- Non-deterministic bugs: raise the reproduction rate (repeat, parallelise, narrow timing) rather than waiting for a clean repro.
- Performance: measure a comparable baseline and bisect. Separate model, tool and human waiting. Logs do not find a regression in timing.

## Cause

- State the likely cause and the observation that would disprove it: "if X is the cause, changing Y makes the failure disappear".
- Test the uncertain assumption, not every possible edge. Change one variable at a time.
- Prefer a debugger or a targeted probe at a boundary over scattered logs.
- Tag temporary logs with a unique prefix so they can be found and removed with one search.
- If evidence is insufficient, seek the smallest authorized probe. No production logging, dependencies or another supervisor by default.

## Fix and regression

- Fix the cause at the narrowest useful seam.
- Add a regression test only when existing coverage does not catch the real failure. If no correct seam exists, that is a finding to report.
- Expected outcomes must not be copied from the implementation.
- Do not repeat a flaky test until green, widen timeouts blindly or fake data that contradicts enforced invariants.

## Close

- Re-run the original reproduction and check meaningful nearby risks.
- Remove instrumentation and temporary probes; stop only owned processes and verify cleanup on success or failure.
- Keep only the regression evidence and the necessary test, not a disposable diagnostic framework.
- Record the confirmed cause in the commit or PR.
- If the same approach keeps failing, simplify it or report the concrete blocker.
- If it cannot be reproduced, list what was tried and ask for one of: access to the environment that reproduces it, a redacted captured artifact, or permission for temporary instrumentation.

Report the cause, the fix, the verification and any unresolved limitation.
