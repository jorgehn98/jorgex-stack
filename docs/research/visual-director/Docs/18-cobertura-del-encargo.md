# 18 — Cobertura del encargo

> Investigación y propuesta. 2026-10-02. **Single home coverage assessment**: matriz requisito→doc→cubierto/parcial→qué falta (evidencia o prueba). Refleja la evidencia revisada en esta pasada, **no** introduce nuevas exigencias ni tareas. No es un task status board ni un backlog. El dossier no es un draft de SKILL. La lista vigente y el conteo exacto de capítulos viven en el [README](README.md). **Comentario 1**: la **nueva versión** conforme a la arquitectura cerrada en [`00`](00-encargo-y-arquitectura.md) (2026-10-03) **aún no está implementada**; la skill original `visual-director/` **existe y sigue siendo invocable** por el usuario. El dossier es investigación y propuesta, no implementación. **Comentario 2**: el estado de cada requisito es **documental** (cubierto/parcial) **o pendiente de validación** (runtime no ejecutado).

## 1. Cómo leer esta matriz

Cada fila es un **requisito** del encargo (lo que el usuario pidió o se infiere del scope del dossier). Las columnas son:

- **Doc**: el capítulo del dossier donde el requisito se cubre.
- **Cobertura documental**: `cubierto documental` (el doc lo aborda con explicación coherente y fuentes consultadas; puede ser propuesta, no exige implementación) o `parcial documental` (faltan elementos relevantes de la explicación o hay contradicciones documentales sin resolver). No se usa `ausente`: las filas que no entran al scope se omiten.
- **Validación runtime**: estado de la prueba runtime; en esta pasada es siempre `no ejecutada`.
- **Qué falta**: la prueba, evidencia o acción que el dossier **no** aporta hoy y que queda como pendiente real (no como nueva tarea).
- **Fuente**: la entrada de `[fuentes.md](fuentes.md)` que sostiene la cobertura, cuando aplica.

`cubierto documental` significa que **el dossier lo documenta con la fuente citada**; **no** significa que esté probado en runtime. La prueba runtime queda en el plan de pruebas autorizado del usuario, no en este dossier. La matriz **no** es un task status board ni un backlog.

## 2. Matriz de cobertura (16 requisitos)

| # | Requisito | Doc | Cobertura documental | Validación runtime | Qué falta | Fuente |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Activación manual y trabajos sustanciales | [00](00-encargo-y-arquitectura.md) §3.1 + [00](00-encargo-y-arquitectura.md) §12 | cubierto documental | no ejecutada | un encargo real con skill manual activada; `DESIGN.md` real con un proyecto | (núcleo dossier) |
| 2 | Núcleo común y continuación por fase | [00](00-encargo-y-arquitectura.md) §3.1 + [00](00-encargo-y-arquitectura.md) §4 + [04](04-conversacion-autonomia-y-revision.md) §1 + [19](19-direccion-creativa-prototipos-y-critica.md) §4 | cubierto documental | no ejecutada | un proyecto que reingrese por dos fases sin reinicio; brief y dirección reusados | (núcleo dossier) |
| 3 | Tres rutas de entrega v1 (web / audiovisual / gráfica fija) con límites | [00](00-encargo-y-arquitectura.md) §3.2 + [15](15-marca-portable-y-grafica-fija.md) §6 + [22](22-grafica-composicion-y-assets.md) §4 | cubierto documental | no ejecutada | un encargo real de cada ruta; **gráfica fija** es **ruta definida para v1**; su referencia (`graphic-routing.md`) **aún sin materializar** y **sin prueba real** | (núcleo dossier) |
| 4 | Métodos combinables entre medios | [00](00-encargo-y-arquitectura.md) §6 + [01](01-video-metodos-y-pipelines.md) + [02](02-video-herramientas-y-evidencia.md) | cubierto documental | no ejecutada | un caso real que combine 3D previz y generativo con el mismo plano | V01–V15 |
| 5 | Blender previz/cámara y apariencia para generación, sin promesa exacta | [00](00-encargo-y-arquitectura.md) §6 + [01](01-video-metodos-y-pipelines.md) §3.A + [20](20-generacion-controlada-y-referencias.md) §2.3 | cubierto documental | no ejecutada | un caso real con previz Blender usado como referencia de generación, sin exigir fidelidad exacta al modelo 3D | V01, V02 |
| 6 | JavaScript, Remotion/HyperFrames y mezcla generativa/audio | [00](00-encargo-y-arquitectura.md) §6 + [00](00-encargo-y-arquitectura.md) §8 + [01](01-video-metodos-y-pipelines.md) + [02](02-video-herramientas-y-evidencia.md) + [14](14-remotion-hyperframes-transcripcion-y-limites.md) + [20](20-generacion-controlada-y-referencias.md) §3 | cubierto documental | no ejecutada | una pieza real que combine código JS, Remotion o HyperFrames y capa generativa/audio en un mismo master | V03, V04, V05, V06, V14, RT01–RT08, GN01–GN10 |
| 7 | Web con personalidad, viaje/CRO, lectura rápida y accesibilidad sin motion | [03](03-web-narrativa-cro-y-motion.md) + [17](17-casos-web-narrativos-y-cro.md) + [21](21-web-interfaces-estados-y-experiencia.md) §3 | cubierto documental | no ejecutada | A/B test real con tráfico suficiente; entrevista de usuarios; **métricas reales** post-tarea; auditoría WCAG 2.2 sobre una pieza real; field data de CWV | W01–W14, WC01–WC06, UX01–UX06 |
| 8 | OpenDesign guía opcional, no ejecutor ni estilo impuesto, sin estado local en futura skill | [00](00-encargo-y-arquitectura.md) §8 + [05](05-herramientas-y-conectores.md) §5 | cubierto documental | no ejecutada | instalación local y prueba del binario `od`; doc histórico intacto (00 §1) | T07, T08 |
| 9 | Herramientas breves e inventario local/MCP, plataforma preguntada, permiso instalación y neutralidad | [05](05-herramientas-y-conectores.md) §1–§6 | cubierto documental | no ejecutada | un inventario local real de MCP y conectores; un caso con plataforma generativa conectada por el usuario | T01–T08 |
| 10 | Conversación profunda/proactiva/proporcional, idea definida o abierta, sin ronda única rígida | [04](04-conversacion-autonomia-y-revision.md) §1 + [10](10-criterio-artistico-y-taste.md) §4–§5 + [19](19-direccion-creativa-prototipos-y-critica.md) §4 | cubierto documental | no ejecutada | varias rondas reales con un usuario; casos en los que la idea cambia entre rondas | E01, E04, CR01–CR05 |
| 11 | Registro duradero: alcance, dueño por dato, hechos/propuestas/aprobaciones, protección secretos | [04](04-conversacion-autonomia-y-revision.md) §2 + [09](09-brand-kit-evolutivo.md) §2 | cubierto documental | no ejecutada | un proyecto con los tres registros activos y durables; secretos y tokens no replicados en el registro | (núcleo dossier) |
| 12 | Autonomía con revisión real, límites presupuesto/reintentos y feedback localizado | [04](04-conversacion-autonomia-y-revision.md) §4–§5 + [05](05-herramientas-y-conectores.md) §6 | cubierto documental | no ejecutada | un lote real donde la autonomía opere sin re-preguntar y se detenga en el cambio material | (núcleo dossier) |
| 13 | Edición grabada: semántica, silencios, transcript word times/alignment/map, frames/motion/audio, modalidades reales | [08](08-edicion-y-transcripcion.md) + [12](12-transcripcion-precision-y-silencios.md) + [13](13-edicion-multimodal-y-flujos-reales.md) + [14](14-remotion-hyperframes-transcripcion-y-limites.md) + [16](16-acabado-audiovisual-y-entrega-editable.md) + [20](20-generacion-controlada-y-referencias.md) §4 | cubierto documental | no ejecutada | una grabación real en español; pipeline end-to-end con cortes/reorden/rate; verificación de modalidad del modelo concreto; re-transcripción condicional aplicada cuando aporta; QA con escucha real | AS01–AS07, ED01–ED07, RT01–RT09, FN01–FN05, GN01–GN10 |
| 14 | Brand kit del resultado aceptado, vivo, versionado, reutilizable | [09](09-brand-kit-evolutivo.md) + [15](15-marca-portable-y-grafica-fija.md) | cubierto documental | no ejecutada | un master version aceptado y un `DESIGN.md` real con tokens, assets y derechos; un caso de variante de campaña; una actualización explícita de marca; licencia de assets individuales; una promoción explícita de master a canónico | BK01–BK03, M05, TS01, LP01, LP02 |
| 15 | Taste transversal sin prohibiciones/cuotas | [10](10-criterio-artistico-y-taste.md) + [19](19-direccion-creativa-prototipos-y-critica.md) §2 | cubierto documental | no ejecutada | una rúbrica operativa por medio; muestras donde los principios se aplican a un caso | E01–E04, TS01, CR01–CR05 |
| 16 | Investigación externa solicitada y análisis de Clodyssey con límites (absent videoaudio) | [11](11-skills-externas-aportes-y-limites.md) + [06](06-clodyssey-aprendizajes.md) | cubierto documental | no ejecutada | el vídeo final y el audio de Clodyssey siguen sin inspeccionarse; las cifras de Clodyssey son de la documentación del paquete, no de runtime | M01–M06, R01–R05, H01–H09, TS01, E01–E04, C01 |

**Notas de la matriz**

- **Cobertura documental** usa exclusivamente los valores `cubierto documental` o `parcial documental`; ambos describen lo que el dossier documenta con la fuente citada, no lo que se ha probado en runtime.
- **Validación runtime** declara `no ejecutada` para todas las filas de esta pasada: la prueba runtime queda en el plan de pruebas autorizado del usuario, no en este dossier.
- **Qué falta** describe **evidencia que el dossier no aporta**, no tareas de producción; la matriz no es un task status board ni un backlog.

## 3. Comentarios explícitos

- **Comentario 1 — la nueva versión conforme a la arquitectura 2026-10-03 aún no está implementada**; la skill original `visual-director/` **existe y permanece intacta**, y el usuario puede seguir invocándola. El dossier es **investigación y propuesta**. No se ha editado `SKILL.md`, no se ha actualizado `evals/evals.json`, no se han añadido archivos a `visual-director/references/`, no se ha modificado `visual-director/assets/`. **Esto no es una deficiencia**; es el alcance autorizado para esta pasada. Cuando la materialización de la nueva versión se autorice, partirá de los capítulos del dossier como referencia, no de los capítulos como SKILL borrador.
- **Comentario 2 — `cubierto` significa cubierto por la documentación**. La prueba runtime (métricas, field data, A/B, end-to-end con audio real, licencias de assets, deployment verificado de demos) **no** se aporta en esta fase. Se declara en la columna "Qué falta" como pendiente real, no como tarea de backlog.
- **Comentario 3 — los namespaces de fuentes siguen siendo disjuntos**: V, W, T, SK, C, MAPA, M, R, H, TS, E, AS, ED, RT, BK, FN, LP, WC, CR, GN, UX, GF. Las entradas de cada namespace se declaran en `fuentes.md` con su SHA pinned o su URL de help/docs.
- **Comentario 4 — 3 brechas abiertas del auditor** (no son tareas del dossier): (a) edición full src + cutlist + final export de un OSS reciente terminado **no** está disponible; (b) medición independiente de word-boundary en español **no** se encontró ni se testó; (c) migración explícita de versión de brand con outputs testados **no** se encontró en fuentes públicas de tokens (BK01–BK03 son snapshot de mecanismos, no outputs verificados). Estas brechas se documentan como **evidencia que el dossier no aporta**; el dossier **no** las convierte en tareas ni en promesas.
- **Comentario 5 — cobertura y ejecución son independientes**: `cubierto documental` significa que el requisito está explicado de forma coherente en el dossier; `parcial documental` señala elementos de explicación aún ausentes o contradictorios. La falta de ejecución se registra exclusivamente en la columna **Validación runtime** y no determina la cobertura documental.

## 4. Pendientes reales (consolidación de §4 de 07)

1. Ejecutar las pruebas de los casos en [07](07-validacion-y-decisiones-pendientes.md) cuando la skill esté implementada con autorización y entorno. No se ejecutan ahora.
2. Inspeccionar el **vídeo final y el audio** de Clodyssey cuando estén disponibles, según el método descrito en [06](06-clodyssey-aprendizajes.md) y [12](12-transcripcion-precision-y-silencios.md) §5.
3. **Aprobar un master version real** y un `DESIGN.md` con tokens, assets y derechos para validar el flujo del brand kit ([15](15-marca-portable-y-grafica-fija.md) §6).
4. **Aprobar los permisos de copia sustancial** de los repos externos (LP01 Taste MIT copyright 2026 + notice preservados, no se asume permiso sobre assets referenciados; LP02 Remotion skills absence de LICENSE en el tree 2026-10-02 — `permiso para copiar sustancialmente pendiente`); la copia sustancial queda condicionada a esa verificación.
5. **Cerrar la arquitectura definitiva** de la skill — **cerrado para el primer borrador** en [`00-encargo-y-arquitectura.md`](00-encargo-y-arquitectura.md) (2026-10-03) §3 (decisiones cerradas) + §7 (grafo de referencias con dueño) + §9 (propiedad y fronteras). Activation manual resuelta en la pasada del 2 de octubre; presupuesto se acuerda por encargo, no en este dossier. La **materialización** de la skill (editar `SKILL.md`, fusionar prácticas de `04`–`09` que no contradigan 00, **materializar las tres referencias planeadas del primer borrador en la futura pasada autorizada**) sigue pendiente y se hace solo en una pasada posterior autorizada, no en esta.
6. **3 brechas del auditor** (no son tareas del dossier): (a) edición full src + cutlist + final export de un OSS reciente terminado **no** está disponible; (b) medición independiente de word-boundary en español **no** se encontró ni se testó; (c) migración explícita de versión de brand con outputs testados **no** se encontró en fuentes públicas de tokens (BK01–BK03 son snapshot de mecanismos, no outputs verificados). Se documentan como **evidencia que el dossier no aporta**; el dossier **no** las convierte en tareas.

## 5. Lo que este capítulo evita

- **No** introduce nuevas tareas de producción (renders, publicaciones, gastos).
- **No** convierte el dossier en un task status board ni en un backlog. La columna "Qué falta" describe **evidencia que el dossier no aporta**, no tareas a ejecutar por el equipo.
- **No** fuerza un número de capítulos. El conteo y la lista vigente viven en el [README](README.md); este capítulo **no** los replica como cifra global.
- **No** afirma cobertura exhaustiva. La matriz refleja la evidencia revisada en esta pasada; nuevos temas pueden requerir nuevas pasadas.

## 6. Cómo se relaciona con los demás capítulos

- [00](00-encargo-y-arquitectura.md) — el encargo original.
- [07](07-validacion-y-decisiones-pendientes.md) — los casos de prueba pendientes (lista en 07; este capítulo no replica el conteo).
- [15](15-marca-portable-y-grafica-fija.md) — el detalle del brand kit por fuente de dato.
- [16](16-acabado-audiovisual-y-entrega-editable.md) — el detalle del acabado y la entrega editable.
- [17](17-casos-web-narrativos-y-cro.md) — los casos web observados y la ficha creativa propuesta.
- [19](19-direccion-creativa-prototipos-y-critica.md) — el método de dirección, prototipo como pregunta y crítica por lentes separadas.
- [20](20-generacion-controlada-y-referencias.md) — las 3 rutas de generación controlada y los límites reportados.
- [21](21-web-interfaces-estados-y-experiencia.md) — estados, foco, error y role/contraste/anchura 320 en interfaces web.
- [22](22-grafica-composicion-y-assets.md) — composición y pipelines por tipo de pieza para gráfica fija.
- [fuentes.md](fuentes.md) — el registro de los namespaces de fuentes citados en la matriz (lista en `fuentes.md`; este capítulo no replica el conteo).
