# Project Architect — dossier de investigación

Material de trabajo con el que se construyó la skill **Project Architect**, cuya fuente vive en [`stack/skills/project-architect/`](../../../stack/skills/project-architect/SKILL.md). Sirve para modificar la skill con el contexto de por qué es como es; no es una dependencia de la skill instalada ni un conjunto de instrucciones activas, y no se incluye en el paquete npm.

La skill no se ha probado todavía con evaluaciones (casos de prueba ni optimización de la descripción). Este dossier no contiene resultados de evaluación.

## Cómo leerlo

- **Fechas.** Todos los datos volátiles (versiones, planes, precios, límites, ventanas de soporte) eran los vigentes el 2026-10-12. Compruébalos en su fuente oficial antes de usarlos o de llevarlos a la skill.
- **Fotografías fechadas.** [arq-verif-supabase.md](informes/arq-verif-supabase.md) y [arq-verif-vercel.md](informes/arq-verif-vercel.md) son una instantánea de planes, límites y funciones de esos dos proveedores el 2026-10-12. Los ejemplos de la skill que citan Supabase o Vercel salen de ahí y caducan; hay que releerlos en la documentación oficial, no darlos por vigentes.
- **Revisión periódica.** Los datos de Supabase y Vercel son ejemplos que caducan: revisar [arq-verif-supabase.md](informes/arq-verif-supabase.md) y [arq-verif-vercel.md](informes/arq-verif-vercel.md), y los ejemplos de la skill que salen de ellos, antes de 2027-01-12 o antes de reutilizarlos, lo que ocurra primero.
- **Estado de la verificación.** Los informes marcan cada afirmación como verificada (`[V]`, `VERIFICADO`, `LEÍDA`) o no verificada (`[NV]`, `NO VERIFICADO`), y lo que es inferencia propia como `[inferencia]`. Las páginas se leyeron con una herramienta que devuelve un resumen, no el texto íntegro; varios informes avisan de que las citas textuales deben recotejarse en la URL, y algunas fuentes dieron error o redirección. Lo no verificado no debe citarse sin releer la fuente. Los informes describen lo que dice la documentación; no son asesoramiento legal.
- **Contenido ajeno a la tarea.** Algunas páginas oficiales incluyen bloques dirigidos a asistentes de IA (instalar paquetes, `llms.txt`). Se trataron como datos y se ignoraron; los informes lo anotan.
- **Atribuciones.** La plantilla del registro de decisiones deriva de MADR (`MIT OR CC0-1.0`) y de la estructura de Nygard (2011); la skill lo declara en su `NOTICE.md`. Los informes contienen citas cortas y datos de documentación oficial, siempre con su URL. No se añaden aquí binarios, transcripciones ni rutas personales.

## Cómo se derivó la skill

1. No había una skill equivalente de la que partir. Los criterios estables se escribieron como investigación propia, y lo que cambia (versiones, planes, límites) se enlaza a la fuente oficial con su fecha.
2. Para cada fase se investigó con documentación oficial y fuentes primarias (informes en [`informes/`](informes/)).
3. De cada investigación salió un extracto en español (capítulos 01–08) con lo que se queda, lo que se descarta y por qué. Con ellos se redactó la skill final, en inglés, tras una revisión independiente.

## Decisiones tomadas

- La skill es genérica e independiente de landing-launch. Empieza preguntando de qué trata el proyecto y deriva el resto de preguntas de la respuesta; no hay cuestionario fijo.
- Recomienda siempre con motivo y alternativas; criterio por defecto: lo más simple que cumple el objetivo.
- Dos modos: decidir (proyecto nuevo, en orden y con puertas) y revisar (proyecto existente, completo o por área). Las fases ligeras se marcan como tales y las innecesarias se saltan con su motivo.
- Entregable: registro de decisiones en `docs/decisions/`. Visual Director y landing-launch lo leen, si existe, en vez de volver a preguntar el stack.
- El esqueleto mínimo del proyecto es un paso opcional al final y no usa `orchestrator`. `grilling` y `to-spec` se mencionan solo como opciones condicionales.
- Lo legal queda fuera: la fase de datos solo deja un mapa de datos (datos personales, almacén, retención, región) que lee la fase legal de landing-launch.
- La tienda online es un caso ocasional con dos caminos (plataforma existente o a medida), sin entrar en carrito ni pagos; móvil se trata brevemente.
- La skill final es en inglés, como landing-launch.
- Añadido posterior (2026-10-14), a partir de una revisión de la fase 10 de landing-launch: la fase 01 recoge como restricción el dispositivo y la red del público y ese dato alimenta la fase 03, cuyo criterio numérico de rendimiento incluye ya el peso de JS en cliente; la fase 06 decide el pipeline de imágenes y fuentes y deja el handler del formulario en la región de los datos.

## Qué se descartó y por qué

| Descartado | Motivo |
| --- | --- |
| Desarrollo interno de la aplicación | Fuera de las skills: esta decide la base técnica, no implementa funcionalidades. |
| Análisis legal y normativo | Decisión del titular: se registran los hechos (mapa de datos) y se marca `[NEED: legal review]`. |
| Normativa de protección de datos en la fase de datos | No se verificó en fuente oficial ni pasa a la fase; [arq-datos-auxiliares.md](informes/arq-datos-auxiliares.md) queda como apoyo para la fase legal de landing-launch, donde hay que contrastarla con fuentes oficiales. |
| Cuestionario fijo de entrada | Se sustituyó por una pregunta inicial y preguntas derivadas de las respuestas. |
| Recomendar un framework como "el mejor" | Los criterios son por caso de uso; ninguna recomendación sale sin motivo y alternativas. |
| Mencionar `orchestrator` | El esqueleto y el plan se derivan, de forma condicional, a `grilling` y `to-spec`. |

## Capítulos

| Fase de la skill | Extracto | Informes que lo sustentan |
| --- | --- | --- |
| 01 Brief | [01-brief.md](01-brief.md) | — |
| 02 Tipo de proyecto y arquitectura | [02-tipo-y-arquitectura.md](02-tipo-y-arquitectura.md) | [renderizado](informes/arq-renderizado.md), [estilos de sistema](informes/arq-estilos-sistema.md), [tipos de proyecto](informes/arq-tipos-proyecto.md) |
| 03 Lenguaje y framework | [03-lenguaje-y-framework.md](03-lenguaje-y-framework.md) | [lenguajes](informes/arq-lenguajes.md), [frameworks](informes/arq-frameworks.md) |
| 04 Datos | [04-datos.md](04-datos.md) | [tipos](informes/arq-datos-tipos.md), [operación](informes/arq-datos-operacion.md), [auxiliares](informes/arq-datos-auxiliares.md) |
| 05 Identidad y servicios | [05-identidad-y-servicios.md](05-identidad-y-servicios.md) | [identidad](informes/arq-identidad.md), [pagos y correo](informes/arq-pagos-correo.md), [servicios de IA y tiempo real](informes/arq-servicios-ia-realtime.md) |
| 06 Despliegue e infraestructura | [06-despliegue-e-infraestructura.md](06-despliegue-e-infraestructura.md) | [despliegue](informes/arq-despliegue.md), [observabilidad](informes/arq-observabilidad.md), [verificación Supabase](informes/arq-verif-supabase.md), [verificación Vercel](informes/arq-verif-vercel.md) |
| 07 Seguridad, privacidad y coste | [07-seguridad-privacidad-y-coste.md](07-seguridad-privacidad-y-coste.md) | [seguridad transversal](informes/arq-seguridad-transversal.md) |
| 08 Registro de decisiones y esqueleto | [08-registro-y-esqueleto.md](08-registro-y-esqueleto.md) | [registro y esqueleto](informes/arq-registro-y-esqueleto.md) |

Los extractos son borradores de extracción en español, marcados como pendientes de revisión; la skill final (en inglés) los resume y prevalece sobre ellos. Si difieren, manda la skill.
