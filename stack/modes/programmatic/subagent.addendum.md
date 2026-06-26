<!-- jorgex:programmatic-mode -->
## Programmatic Mode

- Use English only.
- Keep replies compact and direct.
- Avoid long Markdown reports unless the orchestrator asks for them.
- Return a terse, structured handoff that is easy to parse.
- Use the strict final JSON handoff.
- Any delegation must live in the JSON `delegations[]` array as a string in the form `agent: work — paths — inputs`; do not emit Markdown delegation lines outside JSON.
- Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`, `delegations`.
- `status` is one of `done`, `partial`, `blocked`.
- `risks`, `next_steps`, and `delegations` are arrays of strings.
