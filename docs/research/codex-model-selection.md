# Selección de modelos Codex

Fecha de consolidación: 2026-09-06.

## Decisión

Los defaults de Codex reservan `gpt-6-astra/max` para `strong`,
`gpt-5.6-sol/medium` para `standard` y `gpt-5.6-luna/medium` para `cheap`.
El tier `standard` incluye, entre otros, `backend-analyst` y
`frontend-analyst`. `code-reviewer` y `security-auditor` reciben Astra/max por
el tier `strong`, no como dos overrides nominales. Los tres overrides nominales son
`gpt-5.6-luna/max` para `implementer` y `tester`, y `gpt-5.6-sol/medium` para
`silent-failure-hunter`. La selección por roles es una inferencia de ingeniería
para este mapa; no es un resultado garantizado por los benchmarks.

En un mapa nuevo o cuando falta el mapa del runtime se siembran los tres
defaults y los tres overrides aprobados. En un mapa guardado, los tiers
existentes y sus overrides permanecen intactos; los tiers que falten siguen
heredando defaults, sin inyectar nuevas elecciones guardadas. El primary
heredado y las elecciones de OpenCode y Claude Code quedan fuera de esta
decisión. El código de Pi está inspeccionado: el contexto de
`pi-projection-lifecycle` contiene una entrada dummy de Codex en `models`, pero
los componentes usados no leen el model-map de Stack. Si se quiere
cambiar Codex de forma voluntaria, se usa el mecanismo existente por tier o
agente (`jorgex-stack models --agents codex`), sin asumir que `sync`
sobrescribe elecciones.

El picker de Codex pregunta primero el modelo y después el effort. El `max`
nuevo solo se ofrece para Astra y la familia 5.6; los modelos legacy,
`default` o `custom` no reciben ese effort nuevo sin soporte verificado. Un
`variant` existente que no esté listado se conserva solo si se mantiene el
mismo modelo; al cambiar de modelo no se arrastra. Los variants de OpenCode
permanecen intactos. Para una asignación fina, se elige **por subagente** en
lugar de por tier: solo las diferencias se guardan como overrides por nombre
de agente.

## Evidencia externa

La siguiente tabla usa la misma fila de **Coding Agents v1.4** para Codex. Los
valores son USD de API por tarea, minutos por tarea y tokens por tarea según
Artificial Analysis; no son coste por tarea resuelta ni cuota de suscripción.

| Modelo / effort | Coding Agent Index v1.4 | USD API/tarea | Min/tarea | Tokens/tarea |
|---|---:|---:|---:|---:|
| `gpt-5.6-terra` / `xhigh` | 56 | 1,36 | 6,7 | 6,6 M |
| `gpt-5.6-luna` / `max` | 57 | 0,29 | 8,0 | 16 M |
| `gpt-5.6-terra` / `max` | 60 | 1,93 | 8,2 | 9,6 M |
| `gpt-5.6-sol` / `medium` | 62 | 2,19 | 5,0 | 5,8 M |
| `gpt-5.6-sol` / `max` | 65 | 5,00 | 10,2 | 13,2 M |
| `gpt-6-astra` / `max` | 67 | 4,72 | 26,8 | 4 M |

La comparación no mide calidad del Stack por rol. El promedio incorpora
113 DeepSWE, 89 Terminal v2.1 y 124 Atlas, con tres intentos por tarea; la
metodología describe el arnés y las ponderaciones. Como lectura operativa,
Luna `max` usa más tokens y algo más de tiempo que Terra `xhigh`, aunque su
coste API por tarea es menor; Astra `max` usa menos tokens, pero sus 26,8
minutos no la hacen más rápida. No se mezclan índices de Intelligence ni
precios de julio.

Fuentes primarias y metodología:

- [Comparación Codex vs Muse Code de Artificial Analysis](https://artificialanalysis.ai/agents/coding-agents/comparisons/codex-vs-muse-code)
- [Metodología de benchmarks de coding agents](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)
- [Benchmark de GPT-6 Astra](https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra)
- [Referencia oficial de GPT-6 Astra en OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Precios oficiales de ChatGPT](https://learn.chatgpt.com/docs/pricing)

Los índices y costes anteriores son una señal comparativa para distribuir
roles, no una promesa de calidad, velocidad o precio exactos en cada cuenta.
