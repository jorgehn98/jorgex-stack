# Calidad agéntica: qué extraer de Uncle Bob

> **Aviso:** Investigación abierta; este documento no constituye una política vinculante ni autoriza ninguna implementación.

## Alcance y fuentes

La fuente más útil no es un skill genérico aislado, sino la combinación de la serie oficial Clean AI: Agentic Discipline y el código de SwarmForge.

Fuentes principales:

- [Episode 1: Agentic Discipline](https://cleancoders.com/episode/agentic-discipline-1): disciplina de testing y refactoring; incluye código nuevo y legacy.
- [Episode 2: definición de source](https://cleancoders.com/episode/agentic-discipline-2): la fuente humana deja de ser el código y pasa a ser un documento desde el que se puede reconstruir el sistema.
- [Episode 3: plan y coordinación](https://cleancoders.com/episode/agentic-discipline-3): varios agentes, plan explícito y monitorización.
- [Episode 4: testing, BDD, coverage y mutation testing](https://cleancoders.com/episode/agentic-discipline-4).
- [Episode 5: Architect, Integrator y Coder](https://cleancoders.com/episode/agentic-discipline-5).
- [Episode 6: demostración de SwarmForge](https://cleancoders.com/episode/agentic-discipline-6).
- [Roles de SwarmForge](https://github.com/unclebob/swarm-forge/tree/six-pack/swarmforge/roles).
- [Acceptance Pipeline Specification](https://github.com/unclebob/Acceptance-Pipeline-Specification).
- [Hunt the Wumpus construido con SwarmForge](https://github.com/unclebob/experiment-htw-clj-swarm).

Esto describe prácticas públicas de sus repositorios y vídeos. No debe interpretarse como que Uncle Bob use exactamente este flujo en todos sus proyectos ni como una receta universal.

## El modelo source-first

Idea central: el código pasa a ser un artefacto derivado que el agente puede regenerar. El humano debe controlar una fuente más estable:

- intención y límites,
- comportamiento observable,
- criterios de aceptación,
- invariantes,
- decisiones arquitectónicas,
- procedimiento de QA,
- restricciones operativas.

### Adaptación a JorgeX Stack

JorgeX ya separa PRD, plan, tareas y código. El cambio útil no es inventar otro documento, sino hacer explícita la jerarquía:

1. PRD: problema, alcance, decisiones y comportamiento esperado.
2. Plan: cortes ejecutables y criterios de éxito.
3. Tarea: contexto mínimo, seam de testing, restricciones y aceptación.
4. Código: implementación reemplazable.
5. Evidencia: comandos, resultados, diff y riesgos residuales.

La especificación debe describir qué observa el usuario o el sistema, no prescribir clases y funciones salvo que una frontera técnica sea parte del contrato.

## Roles observados y equivalente JorgeX

| SwarmForge | Responsabilidad | Equivalente actual | Hueco o adaptación |
|---|---|---|---|
| Specifier | Convierte intención en comportamiento preciso, ejemplos y QA de extremo a extremo | to-prd, plan-template, acceptance criteria | Añadir un bloque opcional de Behaviour contract y Manual QA procedure |
| Coder | Implementa y escribe unit tests; el acceptance test no sustituye al unit test | implementer + tdd + tester | Ya cubierto; reforzar que la aceptación no reemplaza la unidad |
| Cleaner | Refactor estructural sin cambiar comportamiento; DRY y CRAP | code-simplifier y verificación del implementer | Falta un perfil medible y una decisión explícita de cuándo ejecutar hardening |
| Architect | Dependencias hacia dentro, límites de módulos, property tests | analysts, type-design-analyzer, lean-code | Falta un gate pre/post para cambios arquitectónicos amplios |
| Hardener | Mutation testing del lenguaje y de la especificación | no existe como fase explícita | Añadir una skill selectiva, preferentemente diferencial |
| QA | Verificación independiente desde la interfaz de usuario | Playwright, verification y browser skill | Añadir procedimiento QA a la especificación; no crear un agente permanente por defecto |
| Handoff | Commit y traspaso estructurado entre roles | topic_key, worktree, result contract | Añadir commit/evidence/verification como campos obligatorios de handoff |

## Prácticas que sí conviene adaptar

### 1. Contrato de comportamiento antes del código

Para features con comportamiento visible o riesgo alto:

- escenarios nominales,
- errores y límites,
- estado observable,
- datos que deben permanecer inmutables,
- procedimiento manual o UI-only,
- criterio de salida.

No hace falta imponer Gherkin. El formato canónico puede seguir siendo Markdown, porque JorgeX ya tiene PRD y plan. Gherkin solo se justifica si necesitamos generación, ejecución en varios lenguajes o mutación de ejemplos.

### 2. Separación estricta de responsabilidades

Mantener lanes explícitas:

- specifier: define comportamiento;
- implementer: escribe producción;
- tester: decide o escribe la protección;
- cleaner: simplifica sin cambiar comportamiento;
- architect: revisa límites y dependencias;
- hardener: busca mutantes o entradas adversariales;
- QA: comprueba la superficie real;
- orchestrator: coordina y decide el cierre.

La separación no implica ejecutar todos los roles. El orchestrator debe activar solo los que el riesgo justifique.

### 3. Acceptance y unit tests tienen contratos distintos

- Unit/module tests: reglas, invariantes y seams internos estables.
- Acceptance/contract tests: comportamiento del sistema desde una frontera.
- QA/UI: comportamiento visible sin entrar por una API privada.

Un acceptance test verde no demuestra que la unidad esté bien diseñada; un coverage alto de unidades tampoco demuestra que el flujo de usuario funcione.

### 4. Property tests para invariantes

El Architect de SwarmForge busca propiedades como:

- idempotencia,
- round-trip parse/serialize,
- conservación,
- orden,
- límites,
- estabilidad de normalización,
- dependencia hacia dentro.

En JorgeX son especialmente relevantes para filemerge, manifests, adapters, upserts, reparación de marcadores y operaciones install/sync/uninstall.

### 5. Handoffs como evidencia, no como conversación

El patrón de handoff debe transferir:

- tarea y alcance,
- commit o estado del worktree,
- archivos/artifacts producidos,
- comandos ejecutados y resultado,
- criterios satisfechos,
- riesgos y delegaciones pendientes.

El mensaje del agente no debe ser el único lugar donde exista la evidencia. El orchestrator debe poder reanudar la tarea con memoria + git + plan.

## Qué no copiar literalmente

### Gherkin para todo

El pipeline de Acceptance Pipeline Specification es interesante, pero añadir parser, IR, generador, runtime y mutator a cada proyecto introduce otra plataforma. Para JorgeX sería mejor:

- Markdown como fuente por defecto.
- Gherkin opcional para proyectos que necesiten aceptación portable.
- No generar tests si el comportamiento es trivial o ya está cubierto por un seam más fuerte.

### Seis agentes en cada cambio

SwarmForge está diseñado para experimentar con una cadena de calidad intensa. En JorgeX, activar Specifier, Coder, Cleaner, Architect, Hardener y QA para una corrección de texto sería mala ingeniería. El perfil de riesgo debe decidir la profundidad.

### CRAP <= 6 como ley universal

En el prompt de Cleaner aparece una disciplina concreta para ese flujo. No debe convertirse en una regla global del stack:

- legacy puede empezar por encima;
- adapters y glue code pueden tener complejidad distinta;
- el número no mide seguridad, comportamiento ni calidad de asserts;
- una función simple con tests inútiles puede tener buen CRAP.

### Coverage como objetivo de gestión

Coverage sirve para encontrar código que no se ejecuta y para alimentar otras señales. No es una calificación de calidad ni debe optimizarse de forma aislada.

## Resultado propuesto

La adaptación de mayor retorno es una quality ladder:

1. siempre: testing decision, tests relevantes y verificación determinista;
2. riesgo medio: contrato de comportamiento y revisión de límites;
3. riesgo alto: property tests, cobertura de cambios y análisis CRAP;
4. riesgo muy alto o release: mutation diferencial, QA black-box y suite adversarial;
5. siempre que haya herramientas: límites externos de ejecución, auditoría y circuit breaker.

El resultado no debe ser un swarm obligatorio, sino un orchestrator que pueda demostrar por qué activó o no activó cada control.
