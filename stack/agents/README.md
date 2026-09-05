# Agentes canónicos

Una sola fuente por agente. El instalador los traduce al formato de cada runtime (PRD §6): Markdown+frontmatter para Claude Code y OpenCode, TOML para Codex. El workflow completo del orchestrator vive únicamente en `skills/orchestrator/SKILL.md`; el agente primary es un wrapper corto que obliga a cargar esa skill.

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
| `readonly: true` | `tools: Read, Grep, Glob` (+Bash si aplica) | `sandbox_mode = "read-only"` | `permission: { edit: deny }` |
| `bash: git-read` | `Bash` completo en tools — la restricción a git read es solo de prompt (el frontmatter de Claude Code no tiene esa granularidad) | con `readonly: true` el sandbox read-only impide escrituras; con `readonly: false` la restricción es solo de prompt | `permission.bash: { "git diff*": allow, "git log*": allow }` (única aplicación real) |
| `bash: none` | sin `Bash` en tools | sandbox read-only | `permission: { bash: deny }` |
| `spawn: false` | sin tool `Agent`/`Task` | n/a | `permission: { task: deny }` |

> Ojo: solo OpenCode aplica `git-read` de verdad. En Claude Code y Codex la combinación `readonly: false` + `bash: git-read` (p.ej. `docs-maintainer`) se degrada a shell completo guiado por prompt.

## Convenciones de contenido

- Todo subagente termina con el **Result contract** (Status / Delegations / Risks) — el orchestrator lo procesa.
- **Incertidumbre crítica no se improvisa**: si una decisión puede hacer la tarea incorrecta, el subagente devuelve `Status: blocked`/`partial` con **una pregunta concreta** al main agent/orchestrator dentro del Result contract; el trabajo de otro especialista sigue yendo como delegación normal. La regla completa está en la skill `agent-delegation`.
- Las delegaciones usan el formato `→ [agent]: [work] — [paths] — [inputs]` (skill `agent-delegation`).
- El flujo de trabajo lo define la skill `work-lifecycle`: `work/{nombre}/plan.md` es el tablero de estado y se mantiene entre merges intermedios; cada tarea formal declara en su columna `Spec` una única fuente recuperable: una observación Engram (proyecto + topic_key `work/{nombre}/task/{NN}`; ID local opcional, vinculado a esa identidad en el almacén actual) o Markdown canónico (`work/{nombre}/tasks/{NN}.md`). Los resultados de fase (`work/{nombre}/{fase}`), los checkpoints de PR (`work/{nombre}/pr/{NN}`) y el cierre final (`work/{nombre}/done`) viven en Engram. Los subagentes reciben el título y la referencia `Spec` exacta como solo lectura; guardan el resultado en el destino separado asignado o lo devuelven al coordinador. El get directo requiere un ID ya vinculado en el almacén actual; en otro caso, se resuelve por proyecto/topic antes del get o se bloquea, y se vuelve a comprobar la identidad al recuperar la spec; un mensaje directo o inline solo es un microencargo auxiliar de su tarea padre y, si crece o se independiza, debe persistirse antes de continuar.
