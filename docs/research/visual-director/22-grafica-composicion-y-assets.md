# 22 — Gráfica fija: composición y assets

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó. Método de composición para gráfica fija (cartel, miniatura, banner, ilustración, diapositiva) sintetizado a partir de fuentes profesionales y de librerías con código y SHA pinned. Fuentes: [fuentes.md](fuentes.md) (GF01–GF06).

## 1. Lo que se transfiere y lo que no

- **GF01 Butterick — Typography in ten minutes** — cuatro determinantes (font size, leading, line length, font) para el cuerpo; valores de partida, no umbrales universales; no prescribe font bans ni preferencias comerciales; el font por defecto del editor no implica licencia libre.
- **GF02 BBC GEL — How to design infographics** — clarity, accuracy, accessibility, composed vertical/horizontal/wider, detail reduction para contextos pequeños; no se copian los términos de la librería (redistribution, services, charged restriction); los principios se leen, los assets no.
- **GF03 SVG.js — README + `Text.js` + LICENSE** — `Text` usa estilos computados para leading; no resuelve layout editorial automático ni preview de fuentes.
- **GF04 Rough.js — README + `svg.ts` + LICENSE** — paths y formas dibujados con feel; uso opcional como tratamiento de marca, no para texto, layout ni semántica accesible; el copyright del software se preserva al copiar sustancialmente; los assets no heredan licencia.
- **GF05 W3C WAI — Images decision tree** — función `decorative / informative / functional` decide `alt`; el SVG no es accesible automáticamente; el texto real se prefiere donde encaja.
- **GF06 W3C WAI — Complex images** — short identify + descripción completa para relaciones/data/trends, no sólo color; en social/slides/vídeo se aplica al destino, no como regla universal WCAG para poster o broadcast.

Cada fuente se cita con su URL exacta; lo verificado por lectura se distingue de lo declarado por metadatos (ver [fuentes.md](fuentes.md)). Los repos remotos no se leyeron directamente; los datos se integran desde el informe READ-ONLY recibido.

## 2. Seis insights procedimentales (no estéticos)

- **Jerarquía por mensaje**: el sujeto entra primero; el tamaño del bloque responde al contenido real, no a una cuota.
- **Márgenes, columnas y alineación**: por importancia y por relación, no por escala uniforme; la campaña invariante aprobada se recompone, no se reescala.
- **Simplificar el detalle, no las conexiones**: el dato, el reconocimiento pequeño y el crop con contexto se preservan; no se simplifica al grado de distorsionar o desinformar.
- **Textos/labels/medidas exactos**: se autoran con la fuente; la geometría del diagrama se separa de la ilustración; la generación no promete precisión de prompt. Para texto o geometría que deban ser exactos, preferir autoría controlada; la generación puede utilizarse si está explícitamente autorizada y se valida el resultado real. Ese permiso no garantiza legibilidad ni fidelidad factual y no autoriza afirmaciones engañosas.
- **`alt` por función y significado**: no se describe la forma si no aporta al usuario.
- **Evaluación humana primero**: qué entendió una persona real con la pieza; evidencia, no "se ve bien"; el test/memory flow no se aplica como verdad de fuente.

## 3. Tres pipelines por tipo de pieza (propuesta)

Los pipelines son propuesta, no resultado: sin un caso real no hay resultado de póster, miniatura ni diapositiva.

### 3.1 Póster / miniatura social

- **Entrada**: copy + sujeto + hechos verificados.
- **Composición**: variantes de crop compositivo; no un upscale uniforme.
- **Tamaño/uso**: preview por tamaño de uso real.
- **Feedback**: del usuario sobre el preview, no sobre el source.
- **Recomposición**: sobre los targets aprobados, no sobre el original a ciegas.
- **Aceptado**: source export con copy exacta (cada carácter), foto, contraste y matching factual; miniatura corta **≠** póster cerrado.

### 3.2 Diapositiva informativa

- **Entrada**: claim con dato real.
- **Diagrama**: tipo de gráfico apropiado al dato y a la jerarquía.
- **Composición**: variantes de grid y jerarquía, no un layout único.
- **Revisión**: en la pantalla destino, con comprensión del usuario real, no en abstracto.
- **Aceptado**: fijo o interactivo con contrato explícito:
  - **Fijo export**: lo esencial visible sin pérdida de contenido; lectura temporal no obligatoria.
  - **Interactivo**: navegación y tiempo de lectura explícitos; nada se pierde en el export estático.

### 3.3 Asset de ilustración web/vídeo

- **Entrada**: función de fidelidad (qué debe reconocer/entender el usuario).
- **Referencia geométrica**: real, no inventada; tratamiento con variantes.
- **Render**: en background/destino con tamaño, alpha y contraste local; en light y dark si aplica; crop del producto real, no UI/medidas fabricadas.
- **Integración**: requisitos de integración del asset explícitos (dimensiones, formato, color, fuentes renderizadas, transparencia, licencia).
- **Animación**: si la pieza se mueve, se trata aparte; no se fuerza a animar.

## 4. Tipografía, color, layout, motion

- **Tipografía**: tamaño de cuerpo legible, leading coherente, line length acotado; no font bans; el font por defecto del editor no implica licencia libre.
- **Color**: por jerarquía y por función, no por moda; los tokens viven en [15](15-marca-portable-y-grafica-fija.md); los tokens y el brand kit aprobado son la frontera de la composición.
- **Layout**: por relación e importancia, no por simetría cosmética; el reflow cubre la mayoría, no toda excepción.
- **Motion**: motivación editorial; `prefers-reduced-motion` por pieza, no global.
- **Estilo final**: el estilo aceptado final no se declara aquí; se registra por owner del proyecto y por excepciones del caso.

## 5. SVG, Rough, generative — qué pueden y qué no

- **SVG.js**: texto programable con estilos computados; no layout editorial automático.
- **Rough.js**: paths con feel; opcional como tratamiento de marca; no texto/semántica/accesible.
- **Generative / 3D**: apariencia condicionada, no copia exacta; continuidad desconocida; no identidad multiángulo por generación; el `alt` se elige por función, no por descripción de forma.
- **Dependencias**: no se impone un comando de setup; las referencias principales se consultan cuando se elige una dependencia real (no se instalan por defecto).

## 6. Prepress, accesibilidad, licencias

- **Prepress avanzado**: no se introduce sin pedido explícito.
- **Accesibilidad**: `alt` por función; descripción corta + completa para imágenes complejas; en social/slides/vídeo se aplica al destino, no se asume WCAG universal para poster/broadcast.
- **Licencias**: las del software (SVG.js MIT, Rough.js MIT) no se transfieren a assets copiados; copyright del software se preserva al copiar sustancialmente; los assets propios requieren su propia verificación.
