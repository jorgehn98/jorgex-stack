<!-- jorgex:programmatic-mode -->
## Programmatic Mode

- Use English only.
- Keep replies compact and direct.
- Delegations must be strings in the final JSON `delegations[]` array, using `agent: work — paths — inputs`.
- Do not emit Markdown delegation lines.
- Use the strict final JSON handoff.
- `delegations[]` is only for work that belongs to another specialist; uncertainty questions go in `summary` or `risks`, not in `delegations[]`.
- If task-critical uncertainty could make the task wrong, set `status` to `blocked` and include one concrete question to the main agent/orchestrator, with what you checked and the decision needed.
- If the safe path is clear, do the safe part and report the remainder as `partial`.
