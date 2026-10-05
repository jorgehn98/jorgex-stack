---
name: xreview
description: Review a PR, branch or local change with only the reviewers its risks need. Use on explicit request or when orchestrator needs independent review of a coherent candidate before delivery.
---

# Xreview

Identify the actual change, its base and the relevant work/task. Ask when the target is unclear; do not assume main or audit the whole repository. Give reviewers the pertinent diff/history and files, not the entire parent conversation. Record the candidate being reviewed so later changes do not inherit invalid evidence.

Choose useful coverage, not a fixed panel:
- reviewer: correctness, useful tests, types/invariants, errors and comments.
- security-auditor: concrete authorization, permission, sensitive-data or trust-boundary risks.
- simplifier: material complexity introduced or touched by the change.

Use zero to three reviewers as needed. Zero does not waive deterministic verification. Reviewers, including simplifier, are always read-only. The existing implementer applies approved fixes and simplifications. No automatic comment writer, tester or specialist chain.

Review a coherent candidate, normally while the PR is still draft. A writer finishing, a commit, a test run or marking Ready does not trigger another review.

Consolidate findings, validate premises and reject duplicates or impossible scenarios. Fix actual blockers within scope; ask before material scope expansion. Do not turn optional suggestions into compulsory refactors or pursue zero observations.

After fixes, verify the finding and affected behavior. Re-review the changed risk; repeat a full panel only when its prior coverage is no longer useful. If fixes keep failing, reconsider cause and approach instead of relaunching the same cycle.

Report the reviewed scope, concrete findings, verification and remaining limitations. Necessary CI must cover the current candidate. A clean review does not authorize merge or claim deployment.
