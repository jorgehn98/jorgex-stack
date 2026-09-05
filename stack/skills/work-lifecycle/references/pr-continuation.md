# Continue approved work across PRs

Read this reference for multi-PR work or dependencies on an unmerged PR. It uses the existing roadmap, worktrees and review evidence; it does not create another queue, registry or permission to merge.

## Choose the next runnable checkpoint

- **Independent work:** use updated production as the base when no unmerged diff is needed.
- **Git dependency:** use a separate child branch/worktree from a verified stable parent candidate when project rules and available tools permit it. Target the child PR at that parent branch so its review shows its own change. Do not modify a ready parent to advance its child.
- **External prerequisite:** verify the actual artifact, migrated database, deployment or decision the next contract needs. A missing prerequisite blocks that consumer, not another approved independent checkpoint. Do not classify all frontend work as independent or all database work as blocked.

Record the selected branch/base SHA, parent PR or external prerequisite, merge order and any real blocker in the existing roadmap columns. Keep readiness and integration separate: a child may be ready for review against its parent without being ready to merge to production. Do not invent new work, dependencies or an arbitrary chain length just to keep going.

## Preserve the chain and its evidence

Keep ready parents immutable. If a parent changes, a base advances, or a PR is retargeted, inspect the actual base/head/merge-base and effective diff. The same head SHA does not prove that previous review or checks still cover the integration context.

Before deliberately changing or retargeting a ready child, return it to draft. Use the project's authorized Git strategy, preserve unrelated edits, and revalidate the affected coverage under `xreview`, plus the applicable local checks and fresh gates. Do not rewrite parents, discard work or force shared history merely for convenience; ask before a history-changing operation that is not already authorized.

After a parent merges, inspect the child's real target. Retarget it to the appropriate integration base when needed before any merge; never accidentally merge into an open parent or an abandoned branch. Hosting-provider auto-retarget behavior is conditional, not a guarantee: do not delete branches to force it. A retarget event alone is not evidence that CI reran; verify the configured triggers and complete the proper draft/ready gate cycle.

## Approval and stopping conditions

Merge only on an explicit user order identifying the PR or intended batch, in a dependency-safe order. Plan approval, a ready child, passing checks or permission to continue development never authorizes future merges. Recheck candidate and base context immediately before the merge.

After reporting a ready checkpoint, continue only approved work that is safe and verifiable. Stop when that scope is exhausted, a material decision is missing, or available capabilities cannot execute the next safe work. Keep the work artifacts and report what is ready, what is blocked and why; do not call the overall roadmap complete merely because one PR is ready.

**Current capability limit:** the bundled OpenCode Goal Mode records `waiting_for_merge` for an open PR, and its store/supervisor pause automatic continuation. This policy does not change that state machine. Do not bypass it or promise stacked automatic continuation in that mode; report the limitation and use only already-approved capabilities. Other runtimes also require their actual available Git/PR tools and permissions, not an assumed API.
