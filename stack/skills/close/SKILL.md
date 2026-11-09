---
name: close
description: Close a working session when the user invokes close or says, in their own words, to close the session ("cerramos sesión", "cierra la sesión", "let's close the session"). Report what is pending, clean only what the session owns, write one memory summary and hand off. Never starts by itself after a finished task.
---

# Close

Run only on explicit request: `/close`, or the user saying in their own words to close the session. Finishing a task, merging a PR or "that's all for now" is not a close, and the agent never starts this on its own initiative.

## 1. Pending

Read the plan or board (`work/`, open issues and PRs, this session's branches and worktrees) and say what remains, even if it is "nothing". Include anything promised earlier in the conversation, with its status. Never close with an unreported open item.

## 2. Cleanup

List what the session owns, act, then verify each item.

- Processes and servers: only those this session started, by recorded PID or task. Never `pkill -f`.
- Browser tabs and sessions the task opened.
- Temporary files and scratch directories the session created.
- Worktree and branches: only if merged or cancelled and no work remains there. Move the shell to the repository root before removing a worktree; a shell left inside a removed directory loses every later command. Before deleting a remote branch, check the ref exists (`git ls-remote --heads`); a missing ref is not an error. Never delete an unmerged branch, a branch with a PR awaiting merge, or one that is not the session's.
- Test data in remote environments (production, staging, third-party services): do not delete it. List it and ask.
- Prefer native removal (`git worktree remove`, `git branch -d`, stopping the task) over `rm`. If the harness denies a removal, do not work around it: report it under "Not cleaned" with the exact command for the user to run.

Rules for the work directory and intermediate merges live in the orchestrator's "Cleanup and close"; do not restate them. Keep `work/{name}/` while work remains.

## 3. Documentation

If behavior, usage or operation changed, update the docs or list them as pending.

## 4. Memory

Write one session summary, once, after cleanup so it includes what could not be cleaned: goal, what was done, decisions, pending, next step. Do not repeat what `mem_save` already stored.

Call `mem_session_summary`. If it is rejected for any reason, save it once with the CLI (`engram save "<title>" "<content>" --type session_summary --project <project>`) and do not retry through MCP. If both fail, say so and include the summary text in the report. Never erase a source because a memory write failed.

## 5. Report

Short, three parts: done, pending, not cleaned (with the reason). No closing praise.

## 6. Handoff prompt

Only if work remains or the user asks. Deliver it in the reply, not as a file. It must stand alone: objective, current state (branch, PR, worktree, plan path), the exact next step and the traps already found. No secrets.
