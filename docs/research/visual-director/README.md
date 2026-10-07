# Visual Director — dossier de investigación

Investigación que sustenta la skill **Visual Director**, cuya fuente vive en [`stack/skills/visual-director/`](../../../stack/skills/visual-director/README.md). Sirve para decidir mejoras de la skill con evidencia; no es una dependencia de la skill instalada ni un conjunto de instrucciones activas.

La versión, el estado y los resultados de evaluación de la skill viven en su propio README, no aquí.

## Cómo leerlo

- **Fechas.** La investigación se hizo el 2026-10-02 y la arquitectura se cerró el 2026-10-03. Los capítulos describen lo que se sabía entonces; lo que un capítulo llama "propuesta" hay que contrastarlo con la skill actual antes de darlo por pendiente.
- **Método.** Todo procede de leer fuentes públicas. No se instaló ni ejecutó ninguna herramienta y no hubo grabaciones de muestra, así que capacidades, precios y licencias son datos fechados que conviene volver a comprobar antes de usarlos.
- **Fuentes.** Cada afirmación externa cita un código (V01, W03, AS02…) registrado en [fuentes.md](fuentes.md) con su enlace, fecha, SHA cuando aplica, y qué evidencia aporta y cuál no.
- **Material fuente.** El material de terceros analizado y el de las rondas de evaluación no forman parte de este repositorio. No se añade aquí material de terceros, binarios, transcripciones ni rutas personales.

## De la skill al dossier

Para mejorar una referencia de la skill, empieza por los capítulos que la sustentan. La correspondencia es orientativa.

| Referencia de la skill | Capítulos |
| --- | --- |
| `SKILL.md` (fases, rutas, fronteras) | [00](00-encargo-y-arquitectura.md), [04](04-conversacion-autonomia-y-revision.md) |
| `discovery.md`, `visual-direction.md` | [04](04-conversacion-autonomia-y-revision.md), [10](10-criterio-artistico-y-taste.md), [19](19-direccion-creativa-prototipos-y-critica.md) |
| `design-system.md`, `design-record.md` | [09](09-brand-kit-evolutivo.md), [15](15-marca-portable-y-grafica-fija.md) |
| `frontend-routing.md` | [03](03-web-narrativa-cro-y-motion.md), [17](17-casos-web-narrativos-y-cro.md), [21](21-web-interfaces-estados-y-experiencia.md) |
| `video-routing.md` | [01](01-video-metodos-y-pipelines.md), [02](02-video-herramientas-y-evidencia.md), [08](08-edicion-y-transcripcion.md), [13](13-edicion-multimodal-y-flujos-reales.md), [16](16-acabado-audiovisual-y-entrega-editable.md) |
| `graphic-routing.md` | [15](15-marca-portable-y-grafica-fija.md), [22](22-grafica-composicion-y-assets.md) |
| `motion-graphics.md` | [01](01-video-metodos-y-pipelines.md), [03](03-web-narrativa-cro-y-motion.md), [14](14-remotion-hyperframes-transcripcion-y-limites.md) |
| `3d-shaders.md` | [01](01-video-metodos-y-pipelines.md), [06](06-clodyssey-aprendizajes.md), [20](20-generacion-controlada-y-referencias.md) |
| `generative-media.md` | [02](02-video-herramientas-y-evidencia.md), [20](20-generacion-controlada-y-referencias.md) |
| `audio.md` | [08](08-edicion-y-transcripcion.md), [12](12-transcripcion-precision-y-silencios.md), [16](16-acabado-audiovisual-y-entrega-editable.md) |
| `opendesign.md`, `official-docs.md` | [05](05-herramientas-y-conectores.md), [11](11-skills-externas-aportes-y-limites.md) |
| `quality-bar.md`, `evals/` | [07](07-validacion-y-decisiones-pendientes.md), [10](10-criterio-artistico-y-taste.md), [19](19-direccion-creativa-prototipos-y-critica.md) |

## Capítulos

### Arquitectura y validación

- [00 — Encargo y arquitectura mínima](00-encargo-y-arquitectura.md): una skill raíz, tres rutas (web, audiovisual, gráfica fija), fases 0–6, brief, métodos compartidos, referencias con dueño y fronteras. Si otro capítulo la contradice, manda este.
- [07 — Validación y pendientes](07-validacion-y-decisiones-pendientes.md): casos de prueba propuestos, cómo evaluarlos, evidencia que falta por requisito y brechas abiertas.
- [Mapa de la skill original](visual-director-mapa.md): análisis del 2026-10-02 de la skill anterior y primera propuesta. Punto de partida histórico, superado por 00.

### Núcleo común

- [04 — Conversación, autonomía y revisión](04-conversacion-autonomia-y-revision.md): descubrimiento proporcional, dueños de cada registro, autonomía dentro del alcance y bucle de revisión.
- [10 — Criterio artístico](10-criterio-artistico-y-taste.md): ocho principios comunes atribuidos, sin prohibiciones ni cuotas; evaluación artística y funcional.
- [19 — Dirección creativa, prototipos y crítica](19-direccion-creativa-prototipos-y-critica.md): método de dirección, prototipo como pregunta y crítica por lentes separadas.
- [09 — Brand kit evolutivo](09-brand-kit-evolutivo.md): un dueño por dato, provisional frente a canónico, versionado y reutilización.
- [05 — Herramientas y conectores](05-herramientas-y-conectores.md): cómo se introduce una herramienta externa, revisión local previa y qué no autoriza instalar o conectar.
- [11 — Skills externas](11-skills-externas-aportes-y-limites.md): cuatro repositorios y cuatro fuentes profesionales, con qué adoptar, adaptar y rechazar.

### Web e interfaces

- [03 — Narrativa, CRO y motion](03-web-narrativa-cro-y-motion.md): mensaje, dos velocidades de lectura, CRO como hipótesis, patrones de motion, WCAG 2.2 y Core Web Vitals.
- [17 — Casos web narrativos y de CRO](17-casos-web-narrativos-y-cro.md): Scrollama, The Pudding, GOV.UK y Home Office; ficha creativa propuesta.
- [21 — Interfaces, estados y experiencia](21-web-interfaces-estados-y-experiencia.md): estados, foco, error, anchura 320 y contraste.

### Audiovisual

- [01 — Métodos y pipelines de vídeo](01-video-metodos-y-pipelines.md): control explícito frente a condicionamiento generativo y cinco pipelines canónicos.
- [02 — Herramientas de vídeo y evidencia](02-video-herramientas-y-evidencia.md): nueve herramientas representativas con función, disponibilidad, restricciones y licencia.
- [20 — Generación controlada y referencias](20-generacion-controlada-y-referencias.md): VACE, ATI y Wan2.2-Fun-Camera; condición frente a entrada y límites reportados.
- [06 — Aprendizajes de CLODYSSEY](06-clodyssey-aprendizajes.md): síntesis transferible de un making-of analizado; el vídeo y el audio finales no se inspeccionaron.
- [08 — Edición y transcripción](08-edicion-y-transcripcion.md): vista general del flujo para grabaciones del usuario. El detalle está en 12, 13 y 14.
- [12 — Transcripción, precisión y silencios](12-transcripcion-precision-y-silencios.md): motores ASR, `silencedetect` y pipeline propuesta.
- [13 — Edición multimodal](13-edicion-multimodal-y-flujos-reales.md): editores de plataforma y de código abierto, y contrato propuesto.
- [14 — Remotion y HyperFrames](14-remotion-hyperframes-transcripcion-y-limites.md): métodos de transcripción en runtime y sus límites.
- [16 — Acabado y entrega editable](16-acabado-audiovisual-y-entrega-editable.md): OTIO, MLT, FFmpeg, EBU R128, subtítulos y paquete entregable.

### Gráfica fija

- [15 — Marca portable y gráfica fija](15-marca-portable-y-grafica-fija.md): sistemas de tokens (DTCG, Style Dictionary, Tokens Studio) y entregable de gráfica fija.
- [22 — Composición y assets](22-grafica-composicion-y-assets.md): composición para póster, miniatura, diapositiva e ilustración, con tres pipelines por tipo de pieza.

### Registro

- [Fuentes](fuentes.md): todas las fuentes citadas, por código.
