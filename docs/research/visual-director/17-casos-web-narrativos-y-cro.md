# 17 — Casos web narrativos y CRO

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó. Casos observados sin browser, sin render y sin runtime: se citan desde el código fuente y el HTML del artículo, leídos en solo lectura; WC01–WC04 son repos OSS observados por subagente y WC05–WC06, blog posts institucionales. Fuentes: [fuentes.md](fuentes.md) (WC01–WC06).

## 1. WC01 — Scrollama (russellsamora/scrollama)

- **SHA pinned 2026-10-02**: `afab8ab2509a7e0112bee4bd7c131eafc50ffc3a`.
- **Path**: [`docs/mobile-pattern/index.html`](https://github.com/russellsamora/scrollama/blob/afab8ab2509a7e0112bee4bd7c131eafc50ffc3a/docs/mobile-pattern/index.html) y demo [`russellsamora.github.io/scrollama/mobile-pattern/`](https://russellsamora.github.io/scrollama/mobile-pattern/).
- **Licencia**: **MIT** declarado en metadatos del repo; el archivo LICENSE no se leyó — el grant sobre el código se declara como **metadato del repo**, no como prueba leída del archivo LICENSE. No se afirma grant de derechos sobre assets o materiales externos al código.
- **Patrón**: 4 pasos HTML semántico (`main` → `intro` → `h1` → `article` → `paragraph`); callbacks `toggle` con `is-active`; sin wheel ni `program` scroll en el file.
- **Adoptar**: el `threshold` inicial se expresa en píxeles de viewport para evitar saltos por la UI del navegador móvil.
- **Rechazar**: padding aleatorio, color de contenido inventado, **33%** de ancho mobile ciegamente. No se prueba CTA, **comprensión** o CRO con este patrón.

## 2. WC02 — Pockets (the-pudding/pockets, artículo Aug 2018)

- **SHA pinned 2026-10-02**: `afc0a8d4ae50f2ea22dd5796141d80866821ae63`.
- **Path**: [`src/html/partials/story/fit.hbs`](https://github.com/the-pudding/pockets/blob/afc0a8d4ae50f2ea22dd5796141d80866821ae63/src/html/partials/story/fit.hbs) y artículo [`pudding.cool/2018/08/pockets/`](https://pudding.cool/2018/08/pockets/).
- **Licencia**: **MIT** (LICENSE leído en el repo, no inferido de metadatos).
- **Contenido del artículo**: 80 medidas de pantalones → medias → comparación → qué cabe en cada objeto; filtros por `style`, `brand`, `price`, `no results`, `show all`.
- **Transferencia**: el caso aterriza una **pregunta tangible del usuario** — "¿sirve para mi caso?" — con **evidencia interactiva** sobre **assets de productos reales**, no inventados. La muestra es **acotada** (no cubre todo el mercado). Las **curvas se generan** y no se fotografían como ground truth. La **voz** de los objetos tiene personalidad; no se reduce a presets de paleta.
- **Rechazar**: inferencia de paleta o tipografía como regla universal; el caso es un ejemplo, no una receta.

## 3. WC03 — Pockets (scroll.js + scroll-pockets.hbs)

- **Path**: [`src/js/scroll.js`](https://github.com/the-pudding/pockets/blob/afc0a8d4ae50f2ea22dd5796141d80866821ae63/src/js/scroll.js) y [`src/html/partials/story/scroll-pockets.hbs`](https://github.com/the-pudding/pockets/blob/afc0a8d4ae50f2ea22dd5796141d80866821ae63/src/html/partials/story/scroll-pockets.hbs).
- **Mecánica**: `jumpahead` skip toggle (2 = skip); texto, párrafo y HTML separado de los gráficos; conclusión y CTA visibles **sin** coreografía completa.
- **Lo que el caso ofrece y lo que no**: el **skip manual** ofrece al usuario un salto al estado final mediante un botón (toggle con valor 2). Que exista ese botón **no acredita detección ni adaptación automática a `prefers-reduced-motion`**: el salto es una decisión del usuario, no una respuesta del código a la media query. Tampoco certifica que el caso tenga **teclado completo** ni un **fallback de accesibilidad** auditado. La separación entre párrafo, HTML y gráfico permite reorganizar el flujo sin reescribir el contenido.
- **Adoptar**: la separación entre contenido y coreografía; cada paso con altura de 1 viewport; distancia hard; lectura no necesariamente ajustada al viewport. El skip manual como patrón, no como acreditación de a11y.
- **Rechazar**: claim de "keyboard fully supported" o "fallback a11y completo" sin auditoría. No se fuerzan reglas uniformes de scroll en píxeles. La presencia del skip no se cita como prueba de `prefers-reduced-motion`.

## 4. WC04 — Essential Words (the-pudding/essential-words)

- **SHA pinned 2026-10-02**: `69e828e0b0c36f35dea53a10aafdc613ea36e86a`.
- **Paths**: [`src/components/Index.svelte`](https://github.com/the-pudding/essential-words/blob/69e828e0b0c36f35dea53a10aafdc613ea36e86a/src/components/Index.svelte), [`src/components/IntroSequence.svelte`](https://github.com/the-pudding/essential-words/blob/69e828e0b0c36f35dea53a10aafdc613ea36e86a/src/components/IntroSequence.svelte), [`src/components/Explorer.svelte`](https://github.com/the-pudding/essential-words/blob/69e828e0b0c36f35dea53a10aafdc613ea36e86a/src/components/Explorer.svelte). Demo [`the-pudding.github.io/essential-words/`](https://the-pudding.github.io/essential-words/).
- **Licencia**: **MIT copyright The Pudding 2022** declarada en el repo; el LICENSE no se leyó, se cita como **metadato del repositorio**, no como grant verificado. No se otorga garantía de derechos de assets.
- **Estructura**: Index (intro, title, prose, graphic block, headings, text alternative, art title); Explorer (buttons opcionales con `aria-expanded`, listas, Escape, focus return); mobile intro reorganizado para `prefers-reduced-motion`, controles + / − no solo color.
- **Narrativa**: vocabulario 1953 vs 2023 → readings → method notes → support + subscribe CTA.
- **Reduced motion**: scroll sticky **phased**, no static fallback completo. Inyección de HTML/source; placeholders de grafo no conectado. **Reuso** del source: se revisa, no se asume que sea a11y certificado.
- **Rechazar**: forzar Svelte como framework. Source **preparado para render**; el demo HTTP no se comparó con el source code al deployment (snapshot sin confirmación de coincidencia exacta con SHA pinned).

## 5. WC05 — GOVUK A/B (blog 14 nov 2017)

- **URL**: [`insidegovuk.blog.gov.uk/2017/11/14/using-ab-testing-to-measurably-improve-common-user-journeys/`](https://insidegovuk.blog.gov.uk/2017/11/14/using-ab-testing-to-measurably-improve-common-user-journeys/).
- **Hallazgo reportado**: el CTA "Start now" se malinterpretó; al reemplazarlo por "Find Contact Details" se reportó **+30% de clicks en mobile, +14% en desktop**. Quitar un enlace de distracción a otra tarea: **+6%** de clicks en el botón principal.
- **Limitaciones declaradas**: el A/B no garantiza ventas ni completion de tarea; el A/B no prueba que la animación impulse. **Las stats (30% / 14% / 6%) son las reportadas por el blog, no auditadas con tamaño muestral, intervalo de confianza ni duración**: no se aporta raw data, ni cálculo de CI, ni auditoría independiente. El porcentaje se cita como **contexto opcional**, no como forecast propio ni como promesa de CRO para otras piezas.
- **Transferencia**: el CTA debe llevar a la **siguiente pantalla real** o a la **tarea real**; no se quitan todos los enlaces por defecto. La métrica principal es la tarea completada, no el click.

## 6. WC06 — HomeOffice (blog 5 mar 2021)

- **URL**: [`services.blog.gov.uk/2021/03/05/showing-the-rewards-of-user-centred-service-design-at-scale/`](https://services.blog.gov.uk/2021/03/05/showing-the-rewards-of-user-centred-service-design-at-scale/).
- **Hallazgo reportado**: el sistema reemplazó uno existente con > 500 sesiones; iteraciones de borrador **4.8 → 2.5**; procesamiento de person licenses **−50%** de tiempo; satisfacción **47% → 78%**; encuestas 65/51 de muestra; transiciones inicialmente más lentas.
- **Limitaciones declaradas**: la **comparación antes/después se reporta sobre un cambio de sistema y de proceso**, no es un **experimento aleatorizado** ni una **prueba causal** que aísle el efecto del diseño visual concreto sobre esas cifras. Las stats no se atribuyen solo al cambio visual de la página. El caso reporta métricas del proceso; no es un A/B aleatorizado ni permite aislar el efecto del diseño visual.
- **Transferencia**: la métrica de tarea se centra en el **proceso** (calidad, efecto), no en scroll. No se afirma benchmark de cambio de paleta. El caso WC06 se cita como **contexto** del cambio de sistema, no como evidencia del diseño visual concreto.

## 7. Ficha creativa propuesta

Flujo propuesto de pieza **narrativa** y de **CRO**, documentado para que un caso real lo valide:

```text
pregunta del visitante
   ↓
mensaje verificado (no fabricado)
   ↓
asset + procedencia (derecho, fuente, fecha)
   ↓
jerarquía + estado inicial
   ↓
cambio de información / conclusión
   ↓
controles (resultados, errores, siguiente pantalla real)
   ↓
alternativa semántica (móvil, teclado, prefers-reduced-motion)
   ↓
CTA + métrica post-tarea
```

- **Sin assets reales / pantallas reales / estado verificado** → no se fabrican stats, testimoniales ni UI. La pieza queda en estado **pendiente**; no se afirma resultado.
- **Argumento principal legible + profundidad opcional**: skip coreografía, sí claridad.
- **3 tests propuestos**:
  1. **CTA real vs genérico** — métrica principal: tarea completada, leads cualificados, clicks como diagnóstico.
  2. **Lineal vs opcional progresivo** — medir comprensión correcta, tiempo, límites, con ruta no animada.
  3. **Prueba interactiva con datos reales** vs estática — efecto en decisión correcta, queries cualificadas, errores. No se pretende causalidad sin tráfico.

**Lo que no es CRO**: awards, estrellas, profundidad de scroll, número de interacciones estéticas. Estos no se promueven a métrica principal.

- La **variante de campaña** ([09-brand-kit-evolutivo.md](09-brand-kit-evolutivo.md) §5) se prueba con la mecánica de esta ficha; no redefine el brand kit sin aprobación explícita.
- En el caso "Web con vídeo / motion y fallback" de [07-validacion-y-decisiones-pendientes.md](07-validacion-y-decisiones-pendientes.md), la accesibilidad y el fallback se verifican con los patrones de WC01/WC03 (movilidad, skip, reduced motion) y WC05/WC06 (métrica de tarea, no de scroll).

## 8. Pendientes

- Validar la **ficha creativa** con un caso real que tenga assets, derechos y métrica post-tarea.

## 9. Método de investigación de los casos (alcance de lo que se cita)

- **Sin browser, sin render, sin runtime**: los casos WC01–WC06 se citan desde el **source code** (pinned por SHA) y desde el **artículo / blog** correspondiente. No se comparó el demo HTTP con el source al deployment; no se certificó la accesibilidad real (teclado, screen reader, fallback completo) ni la experiencia interactiva. Las observaciones sobre mecánica y patrones vienen de la lectura del código y del HTML del artículo, no de la ejecución del demo.
- **Las licencias de WC01 (Scrollama) y WC04 (Essential Words)** se declaran como **metadatos del repositorio**, no como LICENSE leído. No se afirma grant sobre el código ni sobre assets externos al código hasta que se verifique el archivo LICENSE del repo.
- **Los claims reportados en WC05 y WC06** se citan como aparecen en los blogs; no se recalculan, no se auditan, no se reinterpretan como causalidad experimental aislada.
- **El "skip manual" de WC03** se cita como patrón de UX, no como prueba de detección ni adaptación a `prefers-reduced-motion`.
- **El "fallback phased" de WC04** se cita como patrón del repo, no como certificación de a11y.
