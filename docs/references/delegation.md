# Delegación por niveles

Los seis roles de trabajo (`implementer`, `generalist`, `analyst`, `reviewer`, `security-auditor`, `simplifier`) son skills, no agentes. El principal de cada runtime carga `orchestrator` y, cuando delega, lanza el subagente general del runtime y le dice qué skill de rol cargar.

## Subagente general por runtime

| Runtime | Agente |
| --- | --- |
| Claude Code | `general-purpose` |
| Codex | `worker` |
| OpenCode v2 | `general` |
| Pi | `worker` |

No se usan los agentes de exploración de solo lectura: el `explore` de OpenCode deniega la tool `skill` con un comodín y no vería la skill del rol.

## Niveles

El orchestrator declara un nivel por rol y, cuando hace falta, un esfuerzo:

| Nivel | Semántica | Rol |
| --- | --- | --- |
| N1 | mecánico y barato | `generalist` |
| N2 | estándar | `analyst`, `simplifier` |
| N3 | alto | `implementer`, `reviewer` |
| N4 | máximo | `security-auditor` |

El nivel no codifica un modelo: eso depende del runtime y de lo que tengas contratado.

## Escalera

La correspondencia `nivel → modelo` (y, si aplica, esfuerzo) vive en tus instrucciones globales de cada runtime, no en Stack. El formato es libre mientras nombres los cuatro niveles; el orchestrator aplica la tabla tal como la hayas escrito. Ejemplo:

```text
## Delegación
N1 = haiku
N2 = sonnet
N3 = opus / effort high
N4 = fable / effort medium
```

En OpenCode el modelo y la variante van en un solo campo (`provider/model#variante`); en Codex son `model` y `model_reasoning_effort`; en Pi, `model` y `thinking`; en Claude Code la tool de agente acepta `model` y `effort` por invocación.

- Si la escalera no está definida, el hijo hereda el modelo del principal y el orchestrator lo dice una vez. No inventa IDs ni prueba acceso.
- Stack no descubre catálogos, no guarda modelos por agente y no impone un modelo al principal.

## Límites

- La solo lectura de `analyst`, `reviewer`, `security-auditor` y `simplifier` es una instrucción de la skill. Después de un lector, el orchestrator comprueba `git status`.
- Los hijos no subdelegan.
- La skill se carga por su ID exacto. En OpenCode el hijo ve el catálogo; en Pi depende del override de abajo.

## Pi

Los subagentes built-in de `pi-subagents` arrancan con `inheritSkills: false`, así que no ven el catálogo. Stack escribe una sola hoja en `~/.pi/agent/settings.json` cuando falta:

```json
{ "subagents": { "agentOverrides": { "delegate": { "inheritSkills": true } } } }
```

Un valor existente distinto de `true` no se toca: se conserva y doctor avisa. Al desinstalar se retira solo si sigue igual. El detalle de propiedad y backup es el mismo que el del resto de la configuración gestionada.
