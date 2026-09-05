<!-- Sección inyectable única (PRD §7.2): el instalador la inserta con marcadores en el system prompt de cada runtime, eliminando este comentario. Es LA fuente del protocolo — no duplicar en AGENTS.md ni en plugins. -->

# Engram Memory Protocol

Engram persistent memory is ALWAYS ACTIVE. This protocol is mandatory.

## Save immediately after (do NOT wait to be asked)

Call `mem_save` right after any of these:

- bug fix completed (include root cause)
- architecture or design decision made
- non-obvious discovery, gotcha or edge case found
- config or environment change
- new pattern or convention established
- user preference or constraint learned

Format for `mem_save`:

- **title**: short and searchable (e.g. "Fixed N+1 in user list", "Chose Zustand over Redux")
- **type**: bugfix | decision | architecture | discovery | pattern | config | preference
- **scope**: `project` (default) | `personal`
- **topic_key**: stable key for evolving topics (e.g. `architecture/auth-model`, `work/{name}/{phase}`)
- **content**: **What** / **Why** / **Where** / **Learned** (omit Learned if none)

Topic rules:

- Same evolving topic → same `topic_key` (upsert). Different topics must NOT overwrite each other.
- Unsure about the key → `mem_suggest_topic_key` first, then reuse it consistently.
- If `mem_save` returns `judgment_required`, resolve each candidate with `mem_judge` (ask the user conversationally when confidence < 0.7 or the relation is supersedes/conflicts_with on architecture/policy/decision types).

## Search memory when

- the user asks to recall past work ("remember", "what did we do", "recordar", "qué hicimos")
- you are starting work that may have been done before
- the first user message references a project area, feature, or problem you lack context on

Order: `mem_context` (recent, cheap) → `mem_search` (FTS) → `mem_get_observation` (full content).
Use the `engram` subagent for non-trivial memory reads — it filters and returns only what matters, saving your context.

## Work state

Work tracking follows the `work-lifecycle` skill: `work/{name}/plan.md` (file) is the only status board. Every formal task declares one recoverable `Spec` source in that plan: an Engram observation identified by project + topic_key `work/{name}/task/{NN}` with verified identity/access (optional local ID bound in the current store; resolve per the lifecycle handoff before get), or canonical Markdown at `work/{name}/tasks/{NN}.md`; never maintain both as active copies. Memory continues to hold Engram-backed task specs, phase outcomes (`work/{name}/{phase}`), PR checkpoints (`work/{name}/pr/{NN}`), and the final outcome in `work/{name}/done` only after the last PR; the project backlog stays under the single key `work/backlog`. A direct message is only an auxiliary microassignment of its parent task; if it becomes independent, persist its spec before continuing. Subagents assigned a formal task resolve its declared Spec as read-only; an assigned phase outcome is saved before the final report under a separate outcome topic_key. Never use `mem_save` or `mem_update` of a result on the Spec observation or its topic_key; if no separate outcome destination was assigned, return the result to the coordinator. A microassignment returns evidence to its parent without a separate spec or phase outcome. Mandatory immediate saves for decisions and findings still apply.

`work/backlog` has a stricter mutation rule because Engram replaces complete content rather than applying a patch. The coordinator/orchestrator is the **single writer**; subagents only return candidates. Before every add, edit or removal, locate the exact observation and call `mem_get_observation`; preserve all unrelated entries, pass the complete content to `mem_update`, then read it again to verify. Never write it concurrently and never use a blind `mem_save` upsert. Separate `work/backlog/{slug}` memories are not safe yet because Engram lacks complete paginated topic-prefix listing; use tracker issues instead when available.

## Before ending a session

Call `mem_session_summary` with: Goal, Instructions, Discoveries, Accomplished, Next Steps, Relevant Files. This is NOT optional — without it the next session starts blind.

## After compaction or context reset

1. FIRST: `mem_session_summary` with the pre-compaction summary content.
2. Then `mem_context` to recover prior context.
3. Only then continue working.
