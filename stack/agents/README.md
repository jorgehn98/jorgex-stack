# Agentes canónicos

Una sola fuente por agente. El instalador los traduce al formato de cada runtime (PRD §6): Markdown+frontmatter para Claude Code y OpenCode, TOML para Codex.

## Frontmatter canónico

| Campo | Valores | Significado |
|---|---|---|
| `name` | kebab-case | Identificador (= nombre de archivo) |
| `description` | texto | Cuándo usarlo — los runtimes lo usan para la auto-delegación |
| `mode` | `primary` \| `subagent` | Agente principal o subagente delegable |
| `tier` | `strong` \| `standard` \| `cheap` | Se resuelve a un modelo concreto por runtime vía model-map (PRD §6.1) |
| `readonly` | `true` \| `false` | `true` → sin edición ni escritura de archivos |
| `bash` | `none` \| `git-read` \| `full` | `none`: sin shell · `git-read`: solo `git diff*`/`git log*` · `full`: shell completo |
| `spawn` | `false` (opcional) | `false` → no puede lanzar subagentes (default: puede) |

## Traducción por adapter (en install)

| Canónico | Claude Code | Codex | OpenCode |
|---|---|---|---|
| `tier` | alias `fable`/`opus`/`sonnet`/`haiku` según model-map | `model` + `model_reasoning_effort` | `provider/model` del model-map |
| `readonly: true` | `tools: Read, Grep, Glob` (+Bash si aplica) | `sandbox_mode = "read-only"` | `tools: { write: false }`, `permission: { edit: deny }` |
| `bash: git-read` | `Bash` completo en tools — la restricción a git read es solo de prompt (el frontmatter de Claude Code no tiene esa granularidad) | con `readonly: true` el sandbox read-only impide escrituras; con `readonly: false` la restricción es solo de prompt | `permission.bash: { "git diff*": allow, "git log*": allow }` (única aplicación real) |
| `bash: none` | sin `Bash` en tools | sandbox read-only | `permission: { bash: deny }` |
| `spawn: false` | sin tool `Agent`/`Task` | n/a | `permission: { task: deny }` |

> Ojo: solo OpenCode aplica `git-read` de verdad. En Claude Code y Codex la combinación `readonly: false` + `bash: git-read` (p.ej. `docs-maintainer`) se degrada a shell completo guiado por prompt.

## Convenciones de contenido

- Todo subagente termina con el **Result contract** (Status / Delegations / Risks) — el orchestrator lo procesa.
- Las delegaciones usan el formato `→ [agent]: [work] — [paths] — [inputs]` (skill `agent-delegation`).
- El flujo de trabajo lo define la skill `work-lifecycle` (PRD D9): `work/{nombre}/plan.md` es el tablero de estado; las specs de tareas (`work/{nombre}/task/{NN}`), los resultados de fase (`work/{nombre}/{fase}`) y el backlog (`work/backlog`) viven en Engram. Los subagentes reciben topic_key + título, nunca la tarea inline.
