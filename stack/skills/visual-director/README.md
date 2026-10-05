---
name: visual-director
version: 2.0.2-draft
status: borrador — no publicado
---

# Visual Director

Skill de dirección visual manual. La fuente editable vive en `stack/skills/visual-director/` de JorgeX Stack; las copias instaladas no son otra fuente de mantenimiento. El dossier está en `docs/research/visual-director/`, relativo a la raíz del repo, y **no es una dependencia de runtime**: esta carpeta es autosuficiente y portable.

## Estado y alcance

- **Versión:** `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`; tanto `SKILL.md` como este `README.md` declaran `2.0.2-draft`). Sin etiqueta de release.
- **Carga:** manual. Solo se activa cuando el usuario la pide por nombre (`visual-director` o "Visual Director"); no se activa automáticamente para estilado, maquetado o arreglos rutinarios.
- **Idioma del manifiesto:** los archivos del paquete están en inglés; el `README.md` está en español. El agente responde en el idioma del usuario sin perder el método.
- **Familia:** una raíz única, no un árbol por herramienta. Brief, sistema visual, método, prototipo y memoria de estilo se comparten entre web, audiovisual y gráfico fijo.
- **Instalación:** Stack distribuye una copia común en `~/.agents/skills/visual-director/`; Pi, Codex y OpenCode la descubren allí, y Claude usa el enlace desde su carpeta nativa. No instala herramientas, MCPs ni modelos; cualquier incorporación necesita la autorización correspondiente.
- **Cambios 2.0.0 → 2.0.1-draft (post-evaluación, ronda 3):** tres referencias operativas actualizadas y solo esas — `references/video-routing.md` añade criterios music-led (significado/acción/emoción/texto-focal/motivos recurrentes/handoffs de escena) e identidad de caché por código, FPS, assets, fuentes y fuente; `references/audio.md` preserva el máster y aclara la mezcla idéntica frente a contenido adicional (si se permiten SFX), con ventanas karaoke como aproximación de frase y carácter (no alineación fonética, palabra o lipsync); `references/generative-media.md` exige puente explícito desde el RGB al gráfico autoral (pose, máscara, *depth track* o estilización raster y mapa de tiempo, no magia de rig ni vector), con prototipo antes del lote dentro del alcance aprobado. **Aprobación artística ≠ QA.** No se añaden proveedores, dependencias de toolstack, renderers ni géneros prefijados. Los *snapshots* previos a la ronda 3 permanecen congelados.
- **Cambios 2.0.1 → 2.0.2-draft (post-evaluación, ronda 4 — controles derivados de BLISS):** **cuatro** archivos cambiaron — `SKILL.md` (metadatos, autoinvoke, estado del borrador) y **ampliaciones** en las tres referencias operativas `audio.md`, `video-routing.md` y `generative-media.md`, **sin** reescritura de las secciones anteriores. Los otros 13 archivos operativos del paquete se conservan idénticos. `references/audio.md` nombra la **correlación / *spectrogram* match** entre audio maestro y audio del *clip* como **candidato de *offset***, no como prueba de *lip sync*; el denominador del porcentaje es la **duración aceptada dentro de las ventanas evaluadas**, no la del máster; la **mezcla final con SFX** se distingue del *WAV* entregado. `references/video-routing.md` añade un **contrato fuente-a-timeline por *clip* usado** (fuente de audio y *cues*, *trim*, *rate*, *offset*, intervalo visual útil calculado sobre la media disponible — **no** medido si el archivo no se ha visto —, reemplazos locales por *cues*, solapes entre palabras sin umbral fijo), con el máster intacto y la cola del *clip* en otro *clip* o audio disponible antes que el último fotograma congelado por defecto. `references/generative-media.md` añade **roles por *asset* y estados por *job* / *take* / *candidato*** — solicitado / recibido / validado son obligatorios; seleccionado / diferido son opcionales; **IDs** del proveedor se registran cuando los devuelve, no se imponen — y la **preparación por consumidor** (recorte, *alpha* / *spill* / transparencia prevista, colocación, **muestreo temporal** — no sólo *stills*). No se añaden *SDKs*, *renderers* ni normas de estilo; `Midjourney v8.2`, `Suno v6`, `Seedance 2.5` e `Higgsfield` son elecciones del **proyecto BLISS**, no clasificación universal; la pieza real del proyecto BLISS **no** se ha visionado ni escuchado en esta pasada.

## Cómo se carga (entrada para un agente con acceso a archivos)

> Usa @visual-director para [encargo].

La descripción y el cuerpo exigen invocación explícita. Se conserva el metadato original `metadata.opencode/autoinvoke: false`, sin prometer que tenga el mismo efecto técnico en todos los runtimes. Si una sesión no detecta la skill, usa su recarga nativa o una sesión nueva; también puede leerse `~/.agents/skills/visual-director/SKILL.md` directamente.

El dossier, el original y los resultados están agrupados en `docs/research/visual-director/`; su `README.md` es el índice. Las rutas absolutas anteriores dentro de transcripciones y manifiestos se conservan como evidencia histórica, no como ubicaciones actuales. La ronda 3 vive en `docs/research/visual-director/visual-director-v2-workspace/iteration-3/`; su `README.md` y `benchmark.md` declaran método, riesgos y *seam* entre los tres casos. La ronda 4 vive en `iteration-4/`; su `README.md` y `benchmark.md` declaran método, riesgos y resultado de los tres controles derivados del paquete `bliss-making-of/`. La revisión estática del paquete vive en `docs/research/visual-director/Docs/25-bliss-making-of-y-composicion-hibrida.md`; los casos ficticios 13–15 de la ronda 4 también están disponibles en `evals/bliss.json` del paquete instalado.

## Estructura del paquete

| Carpeta / archivo | Rol |
| --- | --- |
| [`SKILL.md`](SKILL.md) | Manifiesto del skill: alcance, fases, límites. |
| [`assets/CREATIVE_BRIEF.template.md`](assets/CREATIVE_BRIEF.template.md) | Plantilla opcional de brief creativo. |
| [`assets/VISUAL_PLAN.template.md`](assets/VISUAL_PLAN.template.md) | Plantilla opcional de plan visual. |
| [`evals/evals.json`](evals/evals.json) | 4 casos de evaluación del V2 (español). |
| [`evals/audiovisual.json`](evals/audiovisual.json) | 3 casos de propuesta (`audio-correlacion-sin-video`, `clip-desfase-rango-util`, `assets-roles-y-estados`) derivados de BLISS; no se carga por defecto. |
| [`evals/bliss.json`](evals/bliss.json) | *Fixture* con los 3 casos de la ronda 4 congelados antes del *run*; referenciado desde `iteration-4/inputs.json`. |
| [`references/`](references) | 14 referencias operativas por decisión. |

El manifiesto raíz es `SKILL.md`. Las guías bajo [`references/`](references) se abren solo cuando la decisión lo pide (ver tabla en `SKILL.md`); los casos viven en [`evals/evals.json`](evals/evals.json) (4 casos V2), [`evals/audiovisual.json`](evals/audiovisual.json) (3 casos ronda 4) y [`evals/bliss.json`](evals/bliss.json) (*fixture* congelado), y las plantillas en [`assets/`](assets). No se publica un conteo global de archivos porque puede quedarse obsoleto.

## Flujo operativo (resumen)

1. Clasificar (`NEW` / `REDESIGN` / `CONTINUATION` / `EDIT`) y abrir solo las referencias necesarias.
2. Completar el brief a partir del contexto existente; preguntar solo lo que cambia una decisión material (permisos, presupuesto, plataforma).
3. Proponer 2–3 direcciones propias del tema o continuar la aprobada, con recomendación y *tradeoff* concreto.
4. Definir **un** sistema visual reutilizable, respetando tokens previos.
5. Elegir el método mínimo suficiente: una pila primaria y un motor de render por propiedad; los métodos se suman por escena o asset, no por cuotas de motor.
6. Prototipar la parte más característica y de mayor riesgo, declarar qué debe demostrar y qué cambiaría la dirección si falla.
7. Producir dentro del alcance aprobado, **inspeccionar el resultado real** en todas las modalidades disponibles y evaluar contra el brief (eje creativo) y la viabilidad técnica (eje técnico). Cerrar con un *checkpoint*.

## Reglas del borrador

- **Intención manual:** conocida o desconocida; el skill no se adelanta.
- **Rutas de entrega:** 3 ejes independientes y combinables — web/interface, audiovisual (programático, grabado/editado, 3D, generativo o mix) y gráfico fijo — definidos en `SKILL.md`. La fase de la idea (conocida / abierta / edición dentro de dirección aprobada) se gestiona por separado.
- **Métodos compartidos entre medios:** brief, dirección, sistema, prototipo y memoria de estilo son únicos; los medios se enrutan por separado pero reutilizan el mismo contexto.
- **Referencias cruzadas:** se cargan por necesidad, sin leer el dossier entero de una vez y sin máximo fijo por decisión.
- **Permisos MCP / presupuesto / origen / derechos reales:** se declaran antes de gastar, subir o usar.
- **Estilo base vs. golden output:** el estilo se promueve a norma solo con autorización explícita; una pieza aprobada es un ejemplo, no un patrón.

## Evaluaciones de contratos

Cuatro pasadas de evaluación de propuesta registradas en el *workspace* acompañante. Son resultados contractuales — **no son puntuación de calidad artística**.

### Ronda 1 — `iteration-1/` (4 casos en español, frente a la skill baseline V1)

| Caso | V2 | Skill baseline V1 |
| --- | ---: | ---: |
| `eval-1-reel-marketing-feature-fotografos` | 5/5 | 5/5 |
| `eval-2-web-museo-taller-hero-generativo` | 5/5 | 4/5 |
| `eval-3-campana-jazz-cartel-miniatura` | 5/5 | 5/5 |
| `eval-4-edicion-video-grabado-espanol` | 5/5 | 2/5 |
| **Total de controles contractuales** | **20/20** | **16/20** |

Cobertura real: el prompt del caso 2 permite imagen estática generada como hero. **No verificados en esa ronda:** ruta de asset de vídeo explícito, *shader* / 3D cinematográfico, continuación sobre dirección aprobada, disparo automático, manejo de ediciones rutinarias y llamadas reales a recursos de OpenDesign.

### Ronda 2 — `iteration-2/` (4 casos en español, frente a la versión original)

| Caso | V2 | Original |
| --- | ---: | ---: |
| `eval-5-continuacion-y-memoria` | 5/5 | 5/5 |
| `eval-6-web-clip-proxy-generativo` | 5/5 | 5/5 |
| `eval-7-metadatos-y-edicion-rutinaria` | 5/5 | 5/5 |
| `eval-8-opendesign-recursos-adversariales` | 5/5 | 5/5 |
| **Total de controles contractuales** | **20/20** | **20/20** |

Comparación ciega A/B de dos conversaciones: original preferida por registrar tiempos acordados como valores del ajuste aprobado (caso 5); empate de utilidad en el plan de vídeo (caso 6). Las puntuaciones 20/20 y 20/20 **no se agregan** como un *score* global: cada ronda evalúa controles contractuales distintos, no la misma magnitud.

Cobertura real de la ronda 2: el caso 7 expone solo el descriptor del registro en el primer turno y fuerza el cuerpo en el segundo; la carga es autodeclarada, no auditoría independiente del catálogo instalado. **No verificados en esta ronda:** *render* real, audio, exportación, licencia, accesibilidad ni aislamiento absoluto de memoria del *host*. La *bookkeeping* Engram aparece autodeclarada en algunos *transcripts*; no se certifica aislamiento ni se establece fuga.

### Ronda 3 — `iteration-3/` (3 casos en español, frente al draft `2.0.0`)

| Caso | `2.0.1-draft` | `2.0.0-draft` |
| --- | ---: | ---: |
| `pieza-audiovisual-master-inmutable` | 5/5 | 5/5 |
| `plan-dibujo-js-clip-generado` | 5/5 | 4/5 |
| `revision-export-cache-fps` | 5/5 | 5/5 |
| **Total de controles contractuales** | **15/15** | **14/15** |

Diagnóstico: la diferencia (caso 11) es la prueba explícita de identidad y mapa de tiempo en el prototipo de puente RGB→JS, **no** una mejora de calidad artística. Música y máster, y la revisión de export y caché, pasan igual en ambas versiones dentro de esta muestra. Cobertura real: tres *prompts* congelados, una respuesta por versión y caso, sin réplicas ni causal benchmark. **No** se midió consumo, latencia ni atributos artísticos: los JSON registran `null` explícito. La rúbrica revisada (rev 2) corrigió una exigencia de audio no pedida en el caso 12 y se aplicó simétricamente a las respuestas inalteradas; los *prompts* y los *snapshots* previos no cambiaron.

Los casos están en `docs/research/visual-director/visual-director-v2-workspace/iteration-3/inputs.json`; el reporte en `benchmark.md`, el visor estático en `review.html`. **Revisión humana pendiente.** El resultado 15/15 vs 14/15 **no** certifica calidad visual ni acredita un vídeo producido: la prueba es del texto de propuesta.

### Ronda 4 — `iteration-4/` (3 casos en español, frente al draft `2.0.1`)

| Caso | `2.0.2-draft` | `2.0.1-draft` |
| --- | ---: | ---: |
| `audio-correlacion-sin-video` | 4/4 | 4/4 |
| `clip-desfase-rango-util` | 4/4 | 4/4 |
| `assets-roles-y-estados` | 4/4 | 4/4 |
| **Total de controles contractuales** | **12/12** | **12/12** |

Diagnóstico: 12/12 en ambas versiones. La diferencia entre versiones es de **claridad contractual** — qué contar como evidencia acústica vs visual, qué intervalo visual declarar, qué rol y qué estados asignar a cada *asset* — **no** de resultado. `2.0.1-draft` ya cubría los escenarios planteados; `2.0.2-draft` los hace explícitos. **No** se demuestra nuevo valor de skill ni mejora artística. Cobertura real: tres *prompts* congelados, una respuesta por versión y caso, sin réplicas. **No** se midió consumo, latencia ni atributos artísticos: los JSON registran `null` explícito. Los casos de esta ronda son **ficticios**: el audio maestro del caso 13, el *clip* de 5 s del caso 14 y los 32 *assets* del caso 15 **no** existen en disco. El paquete BLISS del que deriva esta ronda (327 archivos, 360.413.558 bytes) se inspeccionó de forma estática en `Docs/25-bliss-making-of-y-composicion-hibrida.md`; **no** se visiona, **no** se escucha, **no** se mide.

Los casos están en `docs/research/visual-director/visual-director-v2-workspace/iteration-4/inputs.json`; el reporte en `benchmark.md`, el visor estático en `review.html`. **Revisión humana pendiente.** El resultado 12/12 vs 12/12 **no** certifica calidad visual: la prueba es del texto de propuesta.

### Metodología común

Una corrida por configuración y caso en las cuatro rondas; sin réplicas independientes ni CI. No se midieron tokens ni duraciones (el *harness* no los aportó) y **no se infirieron desde caracteres** ni se pusieron a cero; los JSON registran `null` explícitamente. Las voces y los modelos generativos no se ejecutaron: la prueba es del texto de propuesta, no de un render real. La rúbrica revisada (rev 2, ronda 1) corrigió tres exigencias no pedidas en el *prompt* y se aplicó simétricamente a las respuestas inalteradas; el código candidato y los *prompts* no cambiaron. Los *prompts* de la ronda 3 también se mantuvieron inalterados durante la calificación; la corrección de la rúbrica rev 2 fue semántica y no forzó puntuaciones. Los *prompts* de la ronda 4 son los del archivo `iteration-4/inputs.json`; la calificación se aplicó con los mismos criterios que en rondas previas.

**Revisión humana del usuario pendiente en las cuatro rondas y en el *replay*.** Los casos viven en [`evals/evals.json`](evals/evals.json) y [`evals/dialogues.json`](evals/dialogues.json). Los reportes y visores están en `docs/research/visual-director/visual-director-v2-workspace/iteration-1/`, `iteration-2/`, `iteration-3/` e `iteration-4/`. La segunda ronda incluye `approval-replay/result.json` (3/3 ambas versiones); no es una mejora de instrucciones, solo un test de no recurrencia.

## Comparación con la skill baseline V1

La línea base original se conserva como *snapshot* congelado en `docs/research/visual-director/visual-director-v2-workspace/skill-snapshot/visual-director/`. La carpeta operativa original se eliminó por petición del usuario; su documentación y el mapa permanecen en la raíz del dossier. Las etiquetas V1/V2 de los resultados describen las versiones probadas entonces, no el nombre actual de la skill. Los *snapshots* previos a la ronda 3 (`skill-snapshot/`, `iteration-1/candidate-snapshot/`, `iteration-2/candidate-snapshot/`, `iteration-1/old-skill-snapshot/`, `iteration-2/old-skill-snapshot/`, `iteration-3/old-skill-snapshot/`) **permanecen congelados y sin cambios tras los nuevos pasos**; los *snapshots* vivos de la versión actual viven en `iteration-4/candidate-snapshot/visual-director/` e `iteration-4/old-skill-snapshot/visual-director/` para comparación *fresh* — los rúbricas del cuaderno y los *prompts* del evaluador son los anteriores, no se mezclan. Los *snapshots* de la ronda 3 (`iteration-3/candidate-snapshot/visual-director/`, `iteration-3/old-skill-snapshot/visual-director/`) **se conservan** como referencia histórica de la versión `2.0.1-draft`.

Diferencias contractuales observadas en la primera evaluación (no artísticas): V2 cubre mejor el *fallback* previsto en web (caso 2) y los resguardos del flujo de edición grabada (caso 4); marketing (caso 1) y gráfico fijo (caso 3) empatan. Ningún caso afirma render, audio, exportación, licencia o accesibilidad real verificada. En la ronda 3, el cambio 2.0.0 → 2.0.1-draft añadió los criterios music-led, la identidad de caché y el puente RGB→JS explícito con prototipo antes del lote. En la ronda 4, el cambio 2.0.1 → 2.0.2-draft añadió la distinción **correlación acústica vs articulación visible** (audio), el **contrato fuente-a-timeline por *clip* usado** (video-routing) y los **roles / estados / *muestreo* temporal por *asset*** (generative-media). **No** se añaden *SDKs* ni *renderers*.

El dossier V1 y las capturas de evaluación se conservan intactos en la carpeta documental. Al instalar se añadió únicamente `metadata.opencode/autoinvoke: false` al manifiesto para aplicar la carga explícita; el cuerpo de `SKILL.md`, las 14 referencias y las dos plantillas **no cambiaron como paquete**: solo tres refs operativas (`video-routing`, `audio`, `generative-media`) reciben **un párrafo adicional** cada una entre `2.0.1-draft` y `2.0.2-draft`, **sin** modificar los 13 archivos operativos ya activos. Los *hashes* históricos previos (`a5707a…5ddc` para V1, `556feaf…0ed5` para V2 evaluado) **se conservan**; el árbol vivo posterior a la ronda 3 vive en `iteration-3/candidate-snapshot/visual-director/`, y el árbol vivo posterior a la ronda 4 vive en `iteration-4/candidate-snapshot/visual-director/`. El `README.md` se actualizó con las nuevas ubicaciones; los casos de evaluación viven en `evals/` dentro del paquete instalado.

## Notas y avisos

- **Documentación externa:** Context7 no respondió por cuota; las instrucciones de *setup* se contrastaron con documentación oficial directa y se volverán a verificar al seleccionar cada herramienta concreta. El paquete no asume ninguna herramienta instalada ni preferencia de proveedor.
- **Permisos:** la skill puede ejecutar dentro del encargo autorizado; la limitación a propuestas sin *render* fue de estas pruebas, no una restricción universal del paquete. Las instalaciones, conexiones, subidas, gastos y publicaciones requieren autorización si no están ya cubiertos por el alcance y los límites aprobados. No se pide permiso otra vez por cada acción ya autorizada.
- **Borrador:** esta raíz es un **draft**, no un *release*. La investigación, el mapa y los snapshots se conservan en el dossier. El nombre actual es Visual Director; la versión interna es `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`). La etiqueta `2.0.2-draft → 2.0.2` solo aplica con revisión humana explícita y sin *claim* empírico de calidad certificada. Las pruebas futuras en las modalidades audiovisual y gráfico fijo (vídeo, *motion*, audio, *render* 3D) requieren permiso explícito del usuario; no se ejecutan automáticamente.

## Próximos pasos

1. Revisión humana del usuario sobre las cuatro rondas y el *replay*: abrir los visores desde el índice de `docs/research/visual-director/visual-director-v2-workspace/iteration-1/review.html`, `iteration-2/review.html`, `iteration-3/review.html` e `iteration-4/review.html`.
2. Si el *feedback* reabre el paquete, iterar sobre el `2.0.2-draft`; si no, mantener el *draft* tal cual. Cualquier decisión de "continuar pruebas para mejorar" se reporta sobre evidencia aprobada y preserva los registros existentes.
3. La etiqueta `2.0.2-draft → 2.0.2` solo aplica con revisión humana explícita y sin *claim* empírico de calidad certificada. Las pruebas futuras en las modalidades audiovisual y gráfico fijo (vídeo, *motion*, audio, *render* 3D) requieren permiso explícito del usuario; no se ejecutan automáticamente. La autorización del usuario sobre vídeos futuros del usuario se mantiene como ya estaba — no se vuelve a preguntar por cada llamada ya autorizada.
