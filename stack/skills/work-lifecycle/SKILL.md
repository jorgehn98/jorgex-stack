---
name: work-lifecycle
description: Single source for how a piece of work is tracked and advances — PRD and plan in work/{name}/ while in progress, each formal task's one recoverable spec source (Engram or canonical Markdown), and phase outcomes, PR checkpoints and history in Engram. Use when starting, tracking, resuming or closing a piece of work, or when deciding where a PRD, plan, task or backlog item should live.
---

# Work Lifecycle

One rule kills duplication: **every piece of information has exactly ONE home**. Files hold human-reviewed artifacts and task specs deliberately chosen as Markdown; memory holds Engram-backed task specs and history. Nothing is ever stored in two places.

## Identity

Every piece of work gets a **canonical kebab-case name** when it starts (e.g. `checkout-refactor`), shared with the single-PR branch/worktree name and the base name for multi-PR checkpoints. The name stays the same across its whole life — it is the key to everything else.

## Where everything lives

| Piece | Single home | Why there |
|---|---|---|
| PRD | `work/{name}/PRD.md` | Written once, reviewed by the human |
| Plan (goal, approach, task board) | `work/{name}/plan.md` | The status board: humans glance at it; statuses flip with surgical edits |
| Full spec of each formal task | One recoverable source: Engram project + topic_key `work/{name}/task/{NN}` **or** `work/{name}/tasks/{NN}.md` | Choose for durable access; record the exact reference in the plan |
| PR checkpoint outcome | Engram `work/{name}/pr/{NN}` | Intermediate PR merge record |
| Phase outcomes, decisions, findings | Engram `work/{name}/{phase}` | History — must survive the folder and compactions |
| Final outcome | Engram `work/{name}/done` | Permanent record of what shipped after the last PR |
| Pending / backlog items | Engram `work/backlog` — ONE key per project | All pending ideas in one serialized list |

`work/` is **scaffolding, not product**: add it to the project's `.gitignore`. It contains ONLY work in progress — an empty `work/` means nothing is half-done. No `1-TODOs/`, no `3-finalized/`, no phase subfolders.

## Starting

1. Pick the canonical name and create `work/{name}/`. If the item came from the backlog, remove it from `work/backlog` in the same step.
2. Produce the PRD with the `to-prd` skill → `work/{name}/PRD.md`. The human reviews it there.
3. Write `work/{name}/plan.md` (structure in `references/plan-template.md`): goal, chosen approach, `SC-*` success criteria, PR roadmap, and the task table — number, PR, agent, scope, **Spec**, title, one-line description, SC coverage, status, wave, deps.
4. Persist the full spec of every formal task in exactly one recoverable source, then record its exact reference in `Spec`: an Engram observation (project + topic_key `work/{name}/task/{NN}`, with an optional local ID bound as described in the handoff below) or canonical Markdown at `work/{name}/tasks/{NN}.md`. Keep compatible existing Engram task specs; do not migrate them just to change medium.
5. Run the `work-audit` skill in PRE mode. The audit is read-only; the orchestrator is the single writer and corrects each owner artifact until PRE reports `clean` before the final plan review.

## Executing

- Execution happens inside a git worktree created for the work; the user's main checkout stays untouched until merge.
- Worktree path is fixed: first resolve the project root with `git rev-parse --show-toplevel`, ensure `worktrees/` is ignored in the repo-local `.git/info/exclude`, then create/use `<project-root>/worktrees/<canonical-name>` for single-PR work or `<project-root>/worktrees/<canonical-name>-prNN` for multi-PR checkpoints, with the branch matching the worktree name. Never place worktrees in the repo root, next to the repo, under `work/`, or outside the project.
- Delegation handoff: the subagent receives the task title and its exact `Spec` reference, read-only for the worker. An Engram reference includes its project, topic_key and optional local observation ID; never invent a missing ID. Direct get is allowed only with a known ID already bound to the expected project and topic_key in the current store through `mem_save` or a validated scoped lookup. IDs are not global: for an unknown or unbound ID, or another host/store, search by project and topic_key before any full get by ID; block if resolution is unsafe or unavailable. Recheck the returned identity after retrieval; stop on mismatch. A known current-store binding needs no new search per handoff. For Markdown, locate `tasks/{NN}.md` inside the already-resolved active `work/{name}/` directory, then hand off an absolute path the worker can access; do not concatenate `work/{name}` twice or resolve from the execution CWD, and never assume a gitignored `work/` folder exists in another checkout. A direct or inline message is an auxiliary microassignment under a parent task, not a formal task or independent acceptance criterion. If it grows or becomes independent, persist its formal task spec and add its plan row before continuing.
- The coordinator is the single writer of a formal task's active spec source and communicates material changes to any in-flight worker; never change that source silently.
- Only a formal task with an assigned phase outcome saves it BEFORE its final report; its outcome topic_key must be distinct from the `Spec` reference. Never use `mem_save` or `mem_update` to write a result over the Spec observation or its topic_key, or overwrite a Markdown Spec with an outcome. If no separate outcome destination was assigned, return the result to the coordinator for routing. An inline microassignment returns its evidence to the parent and has no separate spec or phase outcome. This does not waive mandatory immediate saves for decisions or findings.
- Task status lives ONLY in the task table: flip it (⬜ → ✅) with a surgical edit when the task closes. PR status/evidence lives ONLY in the PR roadmap table. Do not mirror task progress into memory, and do not re-read the whole plan after every task — it is already in context; re-read it on resume.
- Success criteria live ONLY in the plan's `SC-*` list. Task-to-criterion coverage lives ONLY in the task table's `SC` column. Verification/merge evidence lives ONLY in the PR roadmap or checkpoint that observed it; cite the relevant SC IDs there instead of copying the criteria into the task spec source.
- For multi-PR work, resume from the first PR/task not done in the roadmap/table. For single-PR work, the canonical name worktree/branch is enough and the roadmap collapses to one checkpoint.

## Pull request lifecycle

1. Start from the updated production branch in the canonical worktree/branch. Keep one concrete objective per PR.
2. Implement one coherent first slice, commit it, push the work branch, and open the PR immediately as draft with `gh pr create --draft`.
3. Continue implementation, commits and pushes only while the PR is draft. Draft means the code can still change; ready means the current SHA is the candidate to merge.
4. Before ready, complete every applicable preflight item: code, version bump, local tests, project quality command (`pnpm qa:quality` when defined), Vercel preview review when the project uses Vercel, final diff inspection, and full PR review.
5. Mark ready once with `gh pr ready <number>`. If the project has PR checks configured, wait for Quality Gates, run `gh pr checks <number>`, and verify the checks belong to the latest commit. If no PR checks are configured, confirm that from project configuration such as workflows, rulesets or integrations, and record it; their absence does not block the merge. An empty `gh pr checks` result immediately after ready is not evidence that no checks are configured. Immediately before reporting or merging, compare `gh pr view --json headRefOid` with the recorded candidate SHA.
6. Never push to a ready PR. If it needs changes, first run `gh pr ready --undo <number>`, then modify and push while draft, repeat preflight and review, mark ready again, and wait for a fresh complete gate when checks are configured.
7. Merge only after explicit user approval. When PR checks are configured, their passing result must match the current candidate SHA.

Dependent PRs are sequential: merge one checkpoint, update the production branch, then create the next worktree/branch from that updated base. Do not stack a dependent PR from an unmerged work branch unless the human explicitly chooses a stacked-PR strategy.

## HTML review view (on demand)

When presenting the PRD or the plan for human review on non-trivial work, OFFER a disposable HTML view (e.g. side-by-side approach comparison for the PRD, task table + dependency graph for the plan). Rules:

- Only generate it if the human says yes — never by default.
- The markdown is the ONLY source of truth: requested changes are applied to `PRD.md`/`plan.md`, and the HTML is regenerated from the updated markdown if another review round is needed. The HTML is never edited as a document and never read by subagents.
- It lives in `work/{name}/` (e.g. `plan.review.html`, `PRD.review.html`) and is DELETED as soon as its artifact is approved — before execution starts.

## Pending work (backlog)

All pending or future work of a project lives under the SINGLE topic_key `work/backlog`: one list, each item a short title + one-liner. Never one topic_key per idea, never a TODOs folder. When an item starts, it graduates: remove it from the backlog and create its `work/{name}/`. Review findings deliberately NOT applied also land here, one line each (what + why deferred).

### Safe backlog mutation

Engram replaces an observation's complete content on both `mem_update` and a `mem_save` topic-key upsert. Until Engram offers complete, paginated listing by topic-key prefix, use this serialized protocol for every backlog add, edit or removal:

1. The active coordinator/orchestrator is the **single writer**. Subagents return candidate backlog lines; they never mutate `work/backlog` themselves. Never run backlog writes concurrently.
2. Find the exact `work/backlog` observation, then call `mem_get_observation` to read its full, untruncated content. If it does not exist, create it once with `mem_save`.
3. Change only the intended lines while preserving every unrelated entry, then call `mem_update` on that exact observation ID with the **complete content**. Never send only the delta and never use a blind `mem_save` upsert for an existing backlog.
4. Call `mem_get_observation` again and **verify** both the intended change and the preserved entries.

Engram has no atomic append or compare-and-swap, so concurrent writers can still lose data even if both read first. Do not split items into `work/backlog/{slug}` yet: `mem_search` is capped and has no paginated topic-prefix listing, so older active items could become invisible. Once that capability exists, one observation per item is the preferred migration. If the project has an issue tracker, use issues instead now and do not keep an Engram backlog too.

If the project manages work through an issue tracker, issues (`to-issues`) take this role instead — don't keep both.

## Resuming

1. Read `work/{name}/plan.md` — the board says what's done and what's pending, and its `Spec` column names each formal task's only source.
2. Resolve the declared Spec following the Delegation handoff rule in Executing, including its binding-before-get and scoped lookup requirements. For Markdown, read the canonical absolute path established there; use `mem_context` for recent phase outcomes.
3. Continue from the first task without ✅.

## Closing

There are two close levels:

### PR checkpoint

When an intermediate PR is merged:

1. `mem_save` under `work/{name}/pr/{NN}`: what merged, what remains, and any blockers.
2. Update the PR roadmap and task statuses in `work/{name}/plan.md`.
3. Delete that PR's worktree if appropriate.
4. Keep `work/{name}/` alive for the remaining PRs.

### Final work close

When all PRs are merged, cancelled, or deferred:

1. `mem_save` under `work/{name}/done`: outcome, what shipped, anything left pending.
2. If the PRD has lasting documentation value, move it to where the project keeps docs (e.g. `docs/`); otherwise its key decisions already live in `done`.
3. **Delete `work/{name}/`** and remove the remaining worktree(s). Nothing to archive — git has the code, memory has the story.
4. `mem_session_summary` covers the session as usual.

For single-PR work, the PR checkpoint and final work close happen together: one merge, one `work/{name}/done`, then cleanup.

## Rules

- One piece of work = one canonical name, stable across its whole life.
- Don't mix several distinct pieces of work under the same name/topic_key.
- Same evolving phase → same topic_key (upsert). Different phases and different tasks must not overwrite each other.
- Every formal task has one active recoverable spec source. Never duplicate it as file + memory copies or leave two active task spec sources after changing support.
- Treat `work/backlog` as the exceptional serialized list described above; ordinary topic-key upserts are not a safe substitute for its read-modify-write protocol.

## Legacy `work/` folders

If a repo still has the old `work/1-TODOs / 2-inProgress / 3-finalized` structure: respect what exists, don't extend it. When you touch a piece of work living there, migrate it to this flow: pending ideas → one entry each in `work/backlog`; an in-progress folder → `work/{name}/` with PRD.md, plan.md and any explicitly chosen canonical Markdown task specs, while existing task observations remain valid Engram sources; finalized folders → one `mem_save` per piece worth keeping, then delete them with the user's OK.
