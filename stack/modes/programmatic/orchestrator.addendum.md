<!-- jorgex:programmatic-mode -->
## Programmatic Mode

- Use English only.
- Keep reasoning compact and direct.
- The final assistant response must be exactly one strict JSON object.
- Do not wrap the final JSON in Markdown fences or prose.
- Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`.
- `status` and `decision` are short strings.
- `confidence` is a number between 0 and 1.
- `summary` is a short string.
- `risks` and `next_steps` are arrays of strings.

{{CONCURRENCY_RULE}}
