# 22 — Gráfica fija: composición y assets

> Investigación y propuesta. 2026-10-02. Sintetiza el método de composición para gráfica fija (cartel, miniatura, banner, ilustración, diapositiva) a partir de fuentes profesionales y de librerías con código y SHA pinned. **No** ejecuta, **no** instala, **no** lee repos remotos en esta pasada. Las fuentes viven en [fuentes.md](fuentes.md) (GF01–GF06).

## 1. Lo que se transfiere y lo que no

- **GF01 Butterick — Typography in ten minutes** — cuatro determinantes (font size, leading, line length, font) para el cuerpo; valores de partida, **no** umbrales universales; no prescribe font bans ni preferencias comerciales; el font por defecto del editor **no** implica licencia libre.
- **GF02 BBC GEL — How to design infographics** — clarity, accuracy, accessibility, composed vertical/horizontal/wider, detail reduction para contextos pequeños; **no** se copian los términos de la librería (redistribution, services, charged restriction); los principios se leen, los assets **no**.
- **GF03 SVG.js — README + `Text.js` + LICENSE** — `Text` usa estilos computados para leading; **no** resuelve layout editorial automático ni preview de fuentes.
- **GF04 Rough.js — README + `svg.ts` + LICENSE** — paths y formas dibujados con feel; uso opcional como tratamiento de marca, **no** para texto, layout ni semántica accesible; el copyright del software se preserva al copiar sustancialmente; los assets **no** heredan licencia.
- **GF05 W3C WAI — Images decision tree** — función `decorative / informative / functional` decide `alt`; el SVG **no** es accesible automáticamente; el texto real se prefiere donde encaja.
- **GF06 W3C WAI — Complex images** — short identify + descripción completa para relaciones/data/trends, **no** sólo color; en social/slides/vídeo se aplica al destino, no como regla universal WCAG para poster o broadcast.

Cada fuente se cita con su URL exacta; lo verificado por lectura se distingue de lo declarado por metadatos (ver [fuentes.md](fuentes.md)). **No** se leyeron repos remotos en esta pasada; los datos se integran desde el informe READ-ONLY recibido.

## 2. Seis insights procedimentales (no estéticos)

- **Jerarquía por mensaje**: el sujeto entra primero; el tamaño del bloque responde al contenido real, no a una cuota.
- **Márgenes, columnas y alineación**: por importancia y por relación, no por escala uniforme; la campaña invariante aprobada se recompone, **no** se reescala.
- **Simplificar el detalle, no las conexiones**: el dato, el reconocimiento pequeño y el crop con contexto se preservan; **no** se simplifica al grado de distorsionar o desinformar.
- **Textos/labels/medidas exactos**: se autoran con la fuente; la geometría del diagrama se separa de la ilustración; la generación **no** promete precisión de prompt. Para texto o geometría que deban ser exactos, preferir autoría controlada; la generación puede utilizarse si está explícitamente autorizada y se valida el resultado real. Ese permiso no garantiza legibilidad ni fidelidad factual y no autoriza afirmaciones engañosas.
- **`alt` por función y significado**: no se describe la forma si no aporta al usuario.
- **Evaluación humana primero**: qué entendió una persona real con la pieza; evidencia, no "se ve bien"; el test/memory flow **no** se aplica como verdad de fuente.

## 3. Lo que el capítulo **no** introduce

- **No** crea un nuevo sistema de tokens; los tokens existentes viven en [15](15-marca-portable-y-grafica-fija.md).
- **No** declara un estilo aceptado final; el estilo final se registra por owner del proyecto y por excepciones del caso.
- **No** impone un comando de setup; las referencias principales se consultan cuando se elige una dependencia real (no se instalan por defecto).

## 4. Tres pipelines por tipo de pieza (propuesta)

### 4.1 Póster / miniatura social

- **Entrada**: copy + sujeto + hechos verificados.
- **Composición**: variantes de crop compositivo; **no** un upscale uniforme.
- **Tamaño/uso**: preview por tamaño de uso real.
- **Feedback**: del usuario sobre el preview, no sobre el source.
- **Recomposición**: sobre los targets aprobados, no sobre el original a ciegas.
- **Aceptado**: source export con copy exacta (cada carácter), foto, contraste y matching factual; miniatura corta **≠** póster cerrado.

### 4.2 Diapositiva informativa

- **Entrada**: claim con dato real.
- **Diagrama**: tipo de gráfico apropiado al dato y a la jerarquía.
- **Composición**: variantes de grid y jerarquía, no un layout único.
- **Revisión**: en la pantalla destino, con comprensión del usuario real, no en abstracto.
- **Aceptado**: fijo o interactivo con contrato explícito:
  - **Fijo export**: lo esencial visible sin pérdida de contenido; lectura temporal **no** obligatoria.
  - **Interactivo**: navegación y tiempo de lectura explícitos; nada se pierde en el export estático.

### 4.3 Asset de ilustración web/vídeo

- **Entrada**: función de fidelidad (qué debe reconocer/entender el usuario).
- **Referencia geométrica**: real, no inventada; tratamiento con variantes.
- **Render**: en background/destino con tamaño, alpha y contraste local; en light y dark si aplica; crop del producto real, **no** UI/medidas fabricadas.
- **Integración**: requisitos de integración del asset explícitos (dimensiones, formato, color, fuentes renderizadas, transparencia, licencia).
- **Animación**: si la pieza se mueve, se trata aparte; **no** se fuerza a animar.

## 5. Tipografía, color, layout, motion

- **Tipografía**: tamaño de cuerpo legible, leading coherente, line length acotado; no font bans; el font por defecto del editor **no** implica licencia libre.
- **Color**: por jerarquía y por función, **no** por moda; los tokens viven en [15](15-marca-portable-y-grafica-fija.md).
- **Layout**: por relación e importancia, **no** por simetría cosmética; el reflow cubre la mayoría, **no** toda excepción.
- **Motion**: motivación editorial; `prefers-reduced-motion` por pieza, no global.

## 6. SVG, Rough, generative — qué pueden y qué no

- **SVG.js**: texto programable con estilos computados; **no** layout editorial automático.
- **Rough.js**: paths con feel; opcional como tratamiento de marca; **no** texto/semántica/accesible.
- **Generative / 3D**: apariencia condicionada, **no** copia exacta; continuidad desconocida; no identidad multiángulo por generación; el `alt` se elige por función, no por descripción de forma.

## 7. Prepress, accesibilidad, licencias

- **Prepress avanzado**: **no** se introduce sin pedido explícito.
- **Accesibilidad**: `alt` por función; descripción corta + completa para imágenes complejas; en social/slides/vídeo se aplica al destino, **no** se asume WCAG universal para poster/broadcast.
- **Licencias**: las del software (SVG.js MIT, Rough.js MIT) **no** se transfieren a assets copiados; copyright del software se preserva al copiar sustancialmente; los assets propios requieren su propia verificación.

## 8. Lo que el capítulo no promete

- **No** promete un resultado de póster/miniatura/diapositiva sin un caso real; los pipelines son propuesta, no resultado.
- **No** afirma que Rough.js o SVG.js resuelvan accesibilidad o layout editorial; cada uno cumple su rol acotado.
- **No** introduce SKILL.md ni modificaciones a la skill existente.

## 9. Conexión con los demás capítulos

- [15-marca-portable-y-grafica-fija.md](15-marca-portable-y-grafica-fija.md) — los tokens y el brand kit aprobado son la frontera de la composición.
- [19-direccion-creativa-prototipos-y-critica.md](19-direccion-creativa-prototipos-y-critica.md) — la crítica por lente y el focus genericity test verifican estas propuestas.
- [20-generacion-controlada-y-referencias.md](20-generacion-controlada-y-referencias.md) — appearance condicionada, no copia exacta; recursividad de referencias aprobadas.
- [07-validacion-y-decisiones-pendientes.md](07-validacion-y-decisiones-pendientes.md) — el caso "recomposition readability / crop semantic" verifica este capítulo.
