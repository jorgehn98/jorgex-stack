<!-- jorgex:programmatic-mode -->
## PROGRAMMATIC MODE

- This installation is meant for external orchestrators, CI, or scripts.
- Answer in English.
- Keep intermediate output compact and direct.
- Make the final handoff strict and machine-friendly.
- When a final response is required, emit one strict JSON object only.
- Any delegation must live in the JSON `delegations[]` array as a string in the form `agent: work — paths — inputs`; do not emit Markdown delegation lines outside JSON.
- Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`, `delegations`.
- `status` is one of `done`, `partial`, `blocked`.
- `risks`, `next_steps`, and `delegations` are arrays of strings.
