# Auditoría SDD portable

JorgeX Stack usa una única cadena de artefactos para el trabajo no trivial:

1. `work/{name}/PRD.md` conserva intención y decisiones revisadas por la persona.
2. `work/{name}/plan.md` es el único tablero de criterios, PRs y tareas.
3. Engram conserva las specs completas de tareas y el historial de fases/checkpoints.
4. El código y la evidencia deben converger con esos artefactos antes de SHIP.

La skill propia `work-audit` añade dos gates a esa cadena. No introduce `.specify/`, otro task board, un agente nuevo ni un motor de workflows.

## PRE: consistencia antes de aprobar el plan

El orchestrator ejecuta PRE después de crear el plan y las specs de tareas, antes de presentar el plan final.

PRE comprueba:

- que no quede ningún marcador `[NEEDS CLARIFICATION: ...]`;
- que los criterios de éxito usen IDs únicos `SC-NN` y sean verificables;
- que cada criterio tenga cobertura en la tabla de tareas;
- que cada tarea tenga un agente, scope, archivos, dependencias y wave coherentes;
- que cada cambio de comportamiento tenga una testing decision completa;
- que PRD, plan y tareas no se contradigan ni dupliquen estado/evidencia.

El resultado es `clean` o `gaps`. Un plan con gaps no puede aprobarse. La skill no corrige nada: el orchestrator modifica el artefacto propietario y repite PRE.

## POST: convergencia durante VERIFY

El orchestrator ejecuta POST después de las comprobaciones deterministas y antes de marcar los criterios como completos.

POST comprueba:

- estado y outcome de las tareas del checkpoint;
- evidencia concreta para cada `SC` aplicable;
- correspondencia entre diff/comportamiento y scope aprobado;
- comandos, setup, alcance, resultados y límites de la verificación;
- requisitos, edge cases, docs o contratos cross-repo todavía pendientes.

El resultado es `converged` o `gaps`. `Converged` no sustituye tests, revisión humana, Quality Gates configurados ni validación manual cuando aplique. Con gaps, el orchestrator crea tareas normales y vuelve a EXECUTE; POST se repite después.

## Trazabilidad sin duplicación

Cada dato tiene una sola casa:

| Dato | Casa única |
|---|---|
| Texto y estado de `SC-NN` | Success criteria de `plan.md` |
| Mapping tarea → SC | Columna `SC` de la task table |
| Estado de la tarea | Task table |
| Spec completa de la tarea | Engram `work/{name}/task/{NN}` |
| Evidencia observada | PR roadmap o checkpoint correspondiente |

No se crean IDs `US-*`/`REQ-*` ni una matriz paralela. La evidencia del checkpoint cita los SC demostrados y registra comando/setup, scope, resultado y límites.

## Límite read-only

`work-audit` no escribe, edita ni modifica PRD, plan, Engram, código, tests, checkboxes o estado del PR; tampoco crea tareas. El orchestrator es el único escritor.

Este límite es procedimental. No convierte al orchestrator en un proceso con sandbox read-only ni reduce sus permisos efectivos.

## Relación con Pi

Stack es la fuente canónica. JorgeX Pi recibe la skill y los templates mediante su snapshot byte-exacta, fijada a un commit concreto de Stack. Activar una nueva skill en Pi exige actualizar su allowlist/runtime contract y publicar una versión Pi nueva antes de que Stack pueda adoptar ese tarball exacto.
