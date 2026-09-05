# Standard workflow

Read this reference only after the orchestrator routes work to **standard**. The standard route uses a formal SDD PRD and plan, with PRE before approval and POST before SHIP; it preserves change-first and the shared guards in SKILL.md.

## Phases

```text
INIT → EXPLORE → SPEC → PLAN → EXECUTE → VERIFY → SHIP → CLOSE
```

### Autonomy

The human drives the flow UP TO the plan: the idea, the PRD review and the plan review are interactive. Once the plan is approved, EXECUTE → VERIFY → SHIP run **autonomously** — no confirmation pauses: plan approval authorizes commits, pushes to the work branch, draft PR creation, final review, and the draft-to-ready transition after verification. Task-critical uncertainty from a subagent is an operational blocker, not a pause in autonomy: answer from existing context first; only if the decision genuinely cannot be made from available context may you ask the user, then relaunch with explicit guidance. Control returns to the user at CLOSE. Merging the PR is NEVER yours: it always requires an explicit user order. For multi-PR work, each merge is a checkpoint; keep `work/{name}/PRD.md` and `plan.md` alive until the roadmap is finished. Dependent PRs are sequential: after a checkpoint merge, update the production branch and create the next worktree/branch from that updated base.

## 1. INIT

- Load previous context from Engram memory: for non-trivial reads, delegate to the `engram` subagent (`mem_context` / `mem_search` filtered to the task).
- Identify the project's constraints.
- Detect whether there is documentation, issues or artifacts already created.

## 2. EXPLORE

Launch analysts according to scope:

- `backend-analyst` if it affects backend, DB, APIs or server functions
- `frontend-analyst` if it affects UI, hooks, state or rendering
- `security-auditor` if the area is sensitive

## 3. SPEC

- Synthesize findings.
- Propose a simple approach.
- Clarify only the real ambiguities.
- Apply the `lean-code` skill as a scope gate for any code-bearing task: ask whether the code is needed at all, whether stdlib/native/project helpers already solve it, and whether the smallest obvious change is enough.
- Backlog items phrased as "consider/evaluate X" are questions, not requirements: answer them HERE — who consumes it, what real case needs it — before they enter the PRD as committed scope. A contract nobody consumes is born dead; drop it or defer it explicitly instead of inheriting it as a fact.
- Create the PRD before moving to PLAN (see PRD rules).

### PRD rules

The PRD is **mandatory by default** when you work as orchestrator. If you were invoked, the work is non-trivial (several layers, several files or coordination) and deserves a spec before executing. The PRD captures decisions before implementing and leaves traceability towards the tasks.

Use the `to-prd` skill to turn the current context into the PRD (`work/{name}/PRD.md`) before planning execution.


When presenting the PRD for review, offer a disposable HTML view (rules in the `work-lifecycle` skill).

If the work is large enough to benefit from explicit vertical slices, use the `to-issues` skill after the PRD to split it into independently executable slices before detailed planning.

## 4. PLAN

- Use the PRD as the base input for planning.
- If a slice breakdown exists from `to-issues`, use it as the structure for planning and task sequencing.
- Divide the work into clear tasks.
- One task = one agent = one scope.
- For tasks that add or grow code, record the lean-code outcome in the task spec/acceptance criteria so implementer and simplifier apply the same ladder.
- The PRD does not replace the plan or task breakdown: the PRD captures decisions; the plan and tasks turn those decisions into executable work.
- **Change-first**: for intentional material contract changes discovered in EXECUTE or VERIFY—not bugfixes that restore the approved contract—return to SPEC before further implementation. Update the PRD first, then propagate it to the plan, task specs, `SC-*` success criteria and testing decisions; rerun PRE until `clean`, obtain human approval of the delta, then resume EXECUTE and repeat VERIFY.
- Materialize the plan per the Work state rules: `work/{name}/plan.md` with the task table and one declared recoverable spec source per formal task — an Engram observation or canonical Markdown (templates in the `work-lifecycle` skill). Record the exact source in `Spec`; never create two active copies.
- Load and run the `work-audit` skill in **PRE** mode after the plan and task specs exist and before presenting the final plan. Pass the exact active `work/{name}` path and the exact PR/checkpoint scope; never infer either from the branch or scan other work folders. PRE is read-only: during audit remediation you are the only writer of active work artifacts. Route every finding to its owner artifact, correct it, and rerun PRE until it reports `clean`.
- An unresolved `[NEEDS CLARIFICATION: ...]` marker blocks PRE. Return to SPEC and resolve the ambiguity with the user only when existing context cannot answer it; never approve or execute a plan while PRE is not clean.
- When presenting the plan for human review, offer a disposable HTML view (rules in the `work-lifecycle` skill). If human review changes the PRD, plan or task specs, rerun PRE and require `clean` again before approval or EXECUTE. Requested changes go to plan.md; delete the HTML once its artifact is approved, before EXECUTE.


## 5. EXECUTE

### Worktree

Follow the project Git/worktree rules before the first task. Standard work uses the canonical git worktree unless those rules explicitly permit a trivial direct-main exception; short never creates its own exception.

Canonical location is mandatory: resolve the project root with `git rev-parse --show-toplevel`, ensure `worktrees/` is ignored in the repo-local `.git/info/exclude`, create `worktrees/` inside that root if needed, and create the worktree at `<project-root>/worktrees/<canonical-name>` for single-PR work or `<project-root>/worktrees/<canonical-name>-prNN` for multi-PR checkpoints (branch = worktree name). Do not create worktrees next to the repo, in the repo root, under `work/`, or in any external temp/shared folder.

Every delegation prompt must state the worktree path as the ONLY allowed write root. After each writer subagent finishes, verify the user's main checkout is still clean (`git status` there); if the subagent wrote outside the worktree, STOP, move those changes into the worktree (patch/apply) and restore the main checkout before continuing. Subagent obedience is not a safety boundary — this check is.

### Commit cadence

Commit after each task or bounded group of tasks, with a message that reflects that task — the branch history must map to the plan. Never accumulate the whole work into one giant commit at the end.

### Draft PR cadence

- After the first coherent commit, push the branch and create the PR against its real base with `gh pr create --draft`. Do not wait until SHIP to open it.
- Keep every code change, commit and push inside the draft phase. The PR remains draft until the code, applicable version bump, local tests, project quality command (`pnpm qa:quality` when defined), Vercel preview when applicable, final diff, and full review are complete.
- Never push to a ready PR. If a ready PR needs changes, first run `gh pr ready --undo <number>`, then modify and push while draft and repeat VERIFY and the final review before readying it again.

### Handoff rule

The analyst's **Recommendation** is the implementer's input. Sequence: analyst (map + design) → you turn it into tasks → `implementer`/`tester` execute. Don't launch `implementer` on an area no analyst has mapped unless the design is already clear from existing context.

### Testing decision

Every implementation task needs a testing decision, not automatically a new test. Establish:

- the meaningful regression risk introduced by the change
- the existing test that already protects it, if any
- the new or changed behavior that needs protection
- the strongest seam closest to that risk
- the action: TDD/new test, update, reuse existing coverage, or no new test with a concrete trivial/mechanical/already-covered reason

Prefer one authoritative test per behavior. Another layer is justified only when it protects a distinct contract. The task spec carries this decision so `tester` and `implementer` do not invent different strategies.

### TDD path

Use for business rules, bugs/regressions, public contracts, invariants, security/data boundaries, or other behavior whose risk warrants new protection.

```text
tester (RED) → implementer (GREEN/REFACTOR)
```

### Direct path

Use for styling, wiring, generated code, mechanical refactors, trivial code, or changes already covered by an authoritative test. Direct mode still runs the cheapest sufficient verification and records why no new test was needed.

```text
implementer (direct change)
```

### Special delegations

- `translator` for translations or multilingual visible text
- `docs-maintainer` for documentation
- `security-auditor` for sensitive review

### Verification cadence

Deterministic checks are the routine feedback loop while implementation is in progress: run the relevant tests, lint and typecheck/build checks at the cheapest seam that can catch the section's regressions. Verify by bounded, coherent sections (e.g. when a wave completes), not after every small change — and don't defer everything to a single big-bang check at the end either.

Each writer verifies its own bounded area (e.g. its test file). The orchestrator runs shared checks such as the global typecheck once when the wave closes, never concurrently or repeatedly through several writers. Reserve the full suite for VERIFY unless a wave changed broad cross-cutting behavior and an earlier run has a concrete benefit.

### CI and workflow scope

CI guidance belongs here only when the task explicitly affects workflows, gates, path filters, execution frequency, or CI cost. Inspect the actual provider, workflows, triggers, jobs, commands, required checks, refs, and publication/recovery semantics; do not invent a universal CI recipe. For performance claims, compare like-for-like samples and label wall time, summed job time, queue time, and billing/usage separately.

- Use explicit base/head (or equivalent) refs for diff and path decisions; validate command errors and shared configuration. If paths or configuration cannot be classified confidently, run the relevant lane or fail closed—never skip optimistically.
- Draft/candidate validation may cancel obsolete validation runs when project semantics allow it, but never cancel a mutable publish/release job or leave publication halfway. Preserve required gates and recovery; do not change settings or fabricate checks without permission.

### Early-review budget

An early review during EXECUTE is an **exception**, not a default phase. Use it only when there is a concrete risk that deterministic checks cannot cover and the feedback can materially change the remaining implementation. Typical candidates are a sensitive authorization boundary, a destructive migration, subtle concurrency/state consistency, or a broad public contract change.

- State the exact risk and the bounded diff section to inspect before launching anyone.
- Use the single most relevant specialist. Do not load the `xreview` skill or run a generic multi-agent panel during EXECUTE.
- Run at most one early review per bounded critical section, after that section is coherent rather than after each task inside it.
- Do not launch `code-reviewer`, `code-simplifier`, `test-analyzer` or `silent-failure-hunter` merely because a writer finished, a test task completed, several files changed or a commit is due.
- File count, writer completion, commit, push, or draft PR creation are not early-review triggers. The review boundary is the final candidate SHA while the PR is still draft, immediately before `gh pr ready` in SHIP.

## 6. VERIFY

- Run the minimum verification that is sufficient.
- Reserve heavy suites for cases where they provide real value or the project requires them.
- If POST identifies an intentional material contract change, follow the PLAN's change-first procedure before further implementation.
- Load and run the `work-audit` skill in **POST** mode after deterministic checks. Pass the exact active `work/{name}` path and the exact current checkpoint scope. POST is read-only and must report `converged`; when it reports `gaps`, during audit remediation you are the only writer of active work artifacts: add normal plan tasks and persist their one declared spec source when needed, return to the phase that owns each gap, and rerun POST after the fixes.
- Only after POST reports `converged`, validate against the plan's **Success criteria** and mark the success criteria complete. Tests passing is NOT enough: a criterion left unmet means the work is not done, even with a green suite.
- Before SHIP, ensure all applicable preflight work is complete: code, version bump, local tests, the project's quality command (`pnpm qa:quality` when defined), and Vercel preview review when the project uses Vercel. React Doctor is manual/local, never assumed to be a GitHub Actions gate.
- If something fails, go back to EXECUTE with fix tasks.
- Apply the shared **Bounded retries** guard in `SKILL.md`.

## 7. SHIP (automatic)

When the plan is fully applied and VERIFY passes:

1. Confirm the draft PR exists, the worktree is clean, and the draft head matches the local HEAD. Inspect the final diff against the PR's real base.
2. Apply **Final review and PR lifecycle** in the entry [SKILL.md](../SKILL.md) and the project's review requirements. Reuse valid prior review evidence; choosing standard does not require another panel. Process the review findings by their three levels:
   - **Critical Issues (must fix)**: apply ALL of them — the PR must not reach merge with these open.
   - **Important Improvements (should fix)**: apply the ones worth doing now, at your judgment.
   - **Suggestions (nice to have)**: apply only if trivial and safe.
3. Every finding you decide NOT to apply now goes to the project's `work/backlog` single topic_key — one line each: what + why deferred. Apply the safe serialized backlog protocol above; subagents only return candidate lines.
4. For what you DO apply: add the new tasks to plan.md and persist one declared recoverable spec source per formal task, execute them as in EXECUTE, re-verify, and push the fixes while the PR remains draft. Re-run the `xreview` skill only if the fixes materially changed the reviewed diff or introduced a materially different risk; ordinary finding fixes need deterministic re-verification, not another panel.
5. Once code, verification, preview, final diff, and review are complete, record the candidate SHA and mark the PR ready exactly once with `gh pr ready <number>`.
6. Determine whether the project has PR checks configured by inspecting project configuration such as workflows, rulesets or integrations. If the project has PR checks configured, wait for the complete Quality Gates, run `gh pr checks <number>`, and verify they pass for the recorded candidate SHA. If no PR checks are configured, confirm and record their absence; it does not block the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. In either case, do not push while the PR is ready. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA.
7. If any fix is needed, run `gh pr ready --undo <number>` before editing, return to EXECUTE, and repeat the full verification, review, ready, and — when configured — gate cycle. Never treat checks from an older SHA as merge evidence.

## 8. CLOSE

- STOP here and hand control back to the user only after configured Quality Gates pass for the latest commit, or after confirming that the project has no PR checks configured: report the candidate SHA, check result or confirmed absence, review findings applied vs deferred to `work/backlog`, and whether manual testing is advisable (recommend it for big or user-facing changes; small well-tested changes may not need it).
- NEVER merge the PR yourself — merge only on an explicit user order. After each intermediate merge: persist the checkpoint to `work/{name}/pr/{NN}`, update `plan.md`, and keep `work/{name}/` alive. After the final merge: persist the final outcome to memory, clean up `work/{name}/` and remove the worktree (see Work state).
- If the repo has its own skill for the closing steps (release, deploy, git, cleanup), that skill takes precedence over the default behavior.

## Task rule

A task must correspond to a single agent and a single scope. Don't mix production, tests, docs and translations in the same task.

## Operational rules

- The coordinator must not mix scopes in a single task.
- Read-only agents can run in parallel.
- Write agents only run in parallel if they don't touch the same files.

## Closing rule

Don't declare the task finished if you have only analyzed or planned. There must be real execution by the subagents or a concrete blocker.