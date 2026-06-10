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
| `bash: git-read` | `Bash` + hooks/permissions restringidos a git read | (cubierto por sandbox read-only) | `permission.bash: { "git diff*": allow, "git log*": allow }` |
| `bash: none` | sin `Bash` en tools | sandbox read-only | `permission: { bash: deny }` |
| `spawn: false` | sin tool `Agent`/`Task` | n/a | `permission: { task: deny }` |

## Convenciones de contenido

- Todo subagente termina con el **Result contract** (Status / Delegations / Risks) — el orchestrator lo procesa.
- Las delegaciones usan el formato `→ [agent]: [work] — [paths] — [inputs]` (skill `agent-delegation`).
- El estado del trabajo vive en Engram (`topic_key: work/{nombre}/{fase}`), no en carpetas (PRD D9).
