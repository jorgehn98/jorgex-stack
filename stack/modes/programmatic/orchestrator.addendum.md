<!-- jorgex:programmatic-mode -->
## Programmatic Mode

- Use English only.
- Keep reasoning compact and direct.
- The final assistant response must be exactly one strict JSON object.
- Do not wrap the final JSON in Markdown fences or prose.
- Process the final JSON object's `delegations[]` array; each item must be a string in the form `agent: work — paths — inputs`. Ignore Markdown delegation lines outside JSON.
- Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`, `delegations`.
- `status` is one of `done`, `partial`, `blocked` and `decision` is a short string.
- `confidence` is a number between 0 and 1.
- `summary` is a short string.
- `risks`, `next_steps`, and `delegations` are arrays of strings.

{{CONCURRENCY_RULE}}
