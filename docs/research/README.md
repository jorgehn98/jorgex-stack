# Investigación: calidad y agentes de IA

Estado: investigación abierta. Esta carpeta recoge prácticas observadas en Uncle Bob, literatura técnica y seguridad de agentes que podrían mejorar JorgeX Stack. No es todavía un contrato de producto ni autoriza cambios de código.

Fecha de esta primera consolidación: 2026-08-24.

## Cómo usar esta carpeta

- Aquí van hallazgos, hipótesis, fuentes y candidatos.
- Una propuesta solo pasa a implementación cuando tenga consumidor, alcance y criterio de verificación claros.
- Las decisiones aprobadas deben ir después al flujo normal de JorgeX Stack: PRD, plan, tarea en Engram y worktree.
- Si una idea no aporta un control o una señal accionable, se descarta aunque sea técnicamente interesante.
- No se añaden dependencias ni herramientas globales por el mero hecho de mencionarlas.

## Documentos

- [Selección de modelos Codex](./codex-model-selection.md): defaults por tier, overrides acotados y evidencia externa contrastada.
- [Calidad agéntica al estilo de Uncle Bob](./uncle-bob-agentic-quality.md): source-first, especificación, roles, handoffs, arquitectura, QA y hardening.
- [Métricas y testing](./testing-metrics.md): coverage, CRAP, mutation testing, property testing y perfiles de calidad.
- [Contención de agentes](./agent-containment.md): cómo hacer que los límites humanos sean una frontera técnica y no solo una instrucción del prompt.

## Candidatos priorizados

| Prioridad | Candidato | Valor | Coste/riesgo | Estado |
|---|---|---|---|---|
| P0 | Política de contención externa y complete mediation | Evita que un agente pueda saltarse límites por prompt, herramienta o dato malicioso | Alto; afecta adapters, permisos y ejecución | Investigar antes de implementar |
| P1 | Especificación de comportamiento + procedimiento de QA opcional | Mantiene la intención humana por encima del código generado | Bajo/medio; se puede empezar en PRD y plan | Recomendado |
| P1 | Handoff con evidencia estructurada | Hace verificable qué cambió, qué se ejecutó y qué queda pendiente | Bajo | Recomendado |
| P1 | Perfiles de calidad según riesgo | Evita tanto el laissez-faire como ejecutar mutation/QA caro en todo | Medio | Recomendado |
| P1 | Suite de abuso y regresión para las políticas del agente | Protege permisos, sandbox, prompt injection, memoria y límites | Medio/alto | Recomendado |
| P2 | Property testing para invariantes e idempotencia | Encuentra clases de fallos que ejemplos concretos no cubren | Medio; depende del lenguaje/proyecto | Selectivo |
| P2 | CRAP sobre código cambiado | Prioriza complejidad mal cubierta sin convertir coverage en objetivo ciego | Medio; requiere parser y coverage compatible | Selectivo |
| P2 | Mutation testing diferencial | Mide si los tests detectan fallos plausibles, no solo si ejecutan líneas | Alto en tiempo y toolchain | Selectivo |
| P3 | Pipeline Gherkin/IR/generación completo | Contrato de aceptación portable y mutación de ejemplos | Alto; puede convertirse en burocracia | Solo para productos con vida larga y UI/flows complejos |
| Rechazado por defecto | Seis agentes para cada tarea | Aumenta coste, latencia y superficie de coordinación | Alto | No adoptar globalmente |
| Rechazado por defecto | Umbral universal de 100% coverage o CRAP <= 6 | Incentiva gaming y penaliza legacy o código de bajo riesgo | Alto | No adoptar |

## Estado actual de JorgeX Stack

JorgeX Stack ya tiene varias piezas que cubren una parte importante de estas ideas:

- PRD y plan separados del código.
- Worktrees obligatorios y ramas aisladas.
- Work lifecycle memory-first con tareas, handoffs y checkpoints.
- TDD basado en riesgo; una decisión de testing por cambio.
- Agents especializados para implementación, testing, análisis, revisión y seguridad.
- Success criteria y evidencia en el lifecycle normal de trabajo.
- Review final sobre el SHA candidato, no reviewers por reflejo.
- Permisos por runtime y defaults read-anywhere con denies sensibles.
- Playwright y Chrome DevTools como capacidades opt-in.
- Tests de idempotencia, preservación, lifecycle y seguridad del instalador.

La oportunidad no es copiar SwarmForge. Es añadir controles y artefactos donde todavía hay hueco: especificación de comportamiento, hardening medible, pruebas adversariales y una frontera de ejecución que el modelo no pueda reescribir.

## Regla de decisión

Para aceptar una idea en el backlog de implementación debe responderse:

1. ¿Qué fallo real evita?
2. ¿Quién consume la salida: humano, orchestrator, tester, CI o runtime?
3. ¿Qué evidencia demuestra que funciona?
4. ¿Qué coste añade a una tarea normal?
5. ¿Qué modo degradado existe para legacy, proyectos pequeños o herramientas ausentes?
