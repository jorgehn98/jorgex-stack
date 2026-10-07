# Investigación: calidad y agentes de IA

Estado: investigación abierta. Esta carpeta recoge prácticas observadas en Uncle Bob, literatura técnica y seguridad de agentes que podrían mejorar JorgeX Stack. No es todavía un contrato de producto ni autoriza cambios de código.

Fecha de esta primera consolidación: 2026-08-24.

## Cómo usar esta carpeta

Este índice y el dossier son investigación/evidencia histórica, no contratos operativos. Los documentos conservan vocabulario y referencias de su época; no usar tiers, receipts, workflows o herramientas retiradas como instrucciones actuales. El [README del producto](../../README.md) y el [workflow canónico](../../stack/skills/orchestrator/SKILL.md) describen el uso vigente. Una propuesta requiere alcance/consumidor/autorización antes de implementarse; no instala herramientas por mencionarlas.

## Documentos

- [Visual Director](./visual-director/README.md): dossier de investigación y mapa para mejorar la skill.
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

## Contexto histórico

Las propuestas siguientes no son decisiones aprobadas del producto actual. El dossier Visual Director conserva la investigación propia y su mapa; el material fuente analizado y la evidencia de evaluación no forman parte de este repositorio. El dossier no es dependencia de runtime ni prueba de derechos sobre material externo.

## Regla de decisión

Para aceptar una idea en el backlog de implementación debe responderse:

1. ¿Qué fallo real evita?
2. ¿Quién consume la salida: humano, orchestrator, tester, CI o runtime?
3. ¿Qué evidencia demuestra que funciona?
4. ¿Qué coste añade a una tarea normal?
5. ¿Qué modo degradado existe para legacy, proyectos pequeños o herramientas ausentes?
