<!-- jorgex:programmatic-mode -->
## Programmatic Mode

- Use English only.
- Keep reasoning compact and direct.
- The final assistant response must be exactly one strict JSON object.
- Do not wrap the final JSON in Markdown fences or prose.
- Process the final JSON object's `delegations[]` array; each item must be a string in the form `agent: work — paths — inputs`. Ignore Markdown delegation lines outside JSON.
- If a subagent reports `partial`, keep the safe work and relaunch only what still needs guidance.
- If a subagent reports `blocked` and includes one concrete question in `summary` or `risks`, answer it from existing context when possible; if it still cannot be resolved from context, ask the user only if genuinely necessary, then relaunch the original or a suitable specialist with explicit guidance.
- Required keys: `status`, `decision`, `confidence`, `summary`, `risks`, `next_steps`, `delegations`.
- `status` is one of `done`, `partial`, `blocked` and `decision` is a short string.
- `confidence` is a number between 0 and 1.
- `summary` is a short string.
- For a PR-ready handoff, use the existing text fields for its metadata, concise changes and observed workflow feedback; keep current limitations in `risks` and pending actions in `next_steps`. Do not add JSON keys or a new `ready` status. A ready PR does not mean the whole assigned work is done when later checkpoints remain.
- `risks`, `next_steps`, and `delegations` are arrays of strings.

{{CONCURRENCY_RULE}}
