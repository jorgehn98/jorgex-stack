# 10-rendimiento-y-accesibilidad — extractos

Fuentes: web.dev (Web Vitals, Optimize LCP, Optimize INP, Optimize CLS, Third-party JavaScript, Performance budgets, HTTP cache, Lab and field data), búsqueda web sobre WCAG 2.2; lo básico que ya estaba en 05 se mantiene allí como umbrales y esta fase añade método. Estado: borrador completo. Cifras de web.dev: verificadas hoy en la propia página (Web Vitals actualizada oct-2024); los umbrales de "necesita mejorar/malo" no los daba esa página, salvo INP > 500 ms = malo.

## Posición en el orden
Va **después** de analítica, legal y captación (08, 09, 07) y **antes** de la QA final (11): el banner de consentimiento, la analítica, el formulario y los terceros ya existen y son lo que más pesa; medir antes daría una línea base falsa. Los umbrales y reglas básicas viven en 05; aquí se mide, se presupuesta, se diagnostica y se vigila.

## Entrada
Página implementada con el diseño de Visual Director, scripts de terceros definidos (analítica, banner/CMP, chat, mapas, vídeo, píxeles) y el hosting/CDN elegido. Si el hosting o la plantilla son limitantes (ej. un constructor visual), saber qué se puede cambiar.

## Orden de trabajo
1. Línea base → 2. Presupuestos → 3. LCP → 4. CLS → 5. INP → 6. Terceros → 7. Entrega (servidor, caché, CDN) → 8. Accesibilidad → 9. Vigilancia → 10. Puerta.

## 1. Medir bien: laboratorio frente a campo
- **Campo** (usuarios reales; lo que cuenta): CrUX (28 días, solo Chrome), PageSpeed Insights (muestra campo + laboratorio), Search Console (informe de Core Web Vitals por grupos de URL), o un servicio de medición real propio (RUM). Se evalúa el **percentil 75** de las visitas, por separado móvil y escritorio, y se aprueba solo si **las tres** métricas cumplen: LCP ≤ 2,5 s, INP ≤ 200 ms (> 500 ms es malo), CLS ≤ 0,1.
- **Laboratorio** (reproducible; sirve para depurar y comparar antes de desplegar): Lighthouse en DevTools/PageSpeed y WebPageTest. No predice INP (sin interacción real; Lighthouse usa TBT como sustituto y puede dar buen TBT con INP malo) ni los desplazamientos de CLS durante el scroll o tras interacciones.
- **Una landing nueva no tiene datos de campo**: CrUX necesita tráfico suficiente y 28 días. Hasta entonces, laboratorio con perfil de móvil lento y red limitada, probar en un móvil Android de gama baja real, y activar medición RUM desde el primer día.
- Diferencias esperables: el laboratorio elige un solo elemento LCP y arranca con caché fría; en campo influyen dispositivo, red, caché, bfcache, A/B tests, fuentes y sesión iniciada.
- Procedimiento: medir 3-5 veces y usar la mediana; dejar constancia de la línea base (fecha, herramienta, perfil de dispositivo) para comparar.
- Aprovechar la herramienta de la que no hay que desconfiar: una puntuación de Lighthouse es un resumen, no el objetivo; el objetivo son las métricas de campo y la conversión.

## 2. Presupuestos de rendimiento
- Fijar **límites** y que un cambio que los supere obligue a optimizar, quitar o no añadir. Tres tipos: **cantidad** (peso de JS, peso de imágenes, número de fuentes y de scripts de terceros), **hitos de usuario** (LCP, TBT/INP, CLS) y **reglas** (puntuación de Lighthouse).
- Cifras de partida del artículo de web.dev (antiguas: red 3G y un Moto G4): menos de 170 KB de recursos de ruta crítica comprimidos y minificados, página de producto con menos de 170 KB de JS en móvil, página de inicio interactiva en menos de 5 s en 3G lenta. **Tomarlas como orden de magnitud, no como regla**; adaptar a la competencia y a lo que mide el campo. (TTI ya no se usa como métrica principal en las herramientas actuales; preferir LCP/TBT/CLS. Dato mío: verificar en la documentación de Lighthouse.)
- Valor práctico para una landing (hipótesis de la skill, ajustar tras medir): peso total de la página en torno a 1-1,5 MB sin vídeo; JS comprimido por debajo de ~150-200 KB salvo necesidad; una o dos familias tipográficas con pocos pesos; hero con una sola imagen principal.
- **Aplicar en cada despliegue**: Lighthouse CI o similar (también bundlesize, o las funciones de rendimiento del empaquetador) para que la regresión falle la compilación o avise. Si no hay CI, revisión manual en la lista de 11.

## 3. LCP (carga del elemento principal)
- LCP = tiempo hasta pintar la imagen o bloque de texto más grande en pantalla. Cuatro partes, con proporciones de guía: TTFB (~40 %), retraso de carga del recurso (< 10 %), duración de carga del recurso (~40 %), retraso de pintado (< 10 %). Los retrasos deben acercarse a cero; el tiempo debería ir a traer el HTML y el recurso. Las proporciones son orientativas, no milisegundos fijos.
- **Que el recurso se descubra pronto**: la imagen LCP con `src`/`srcset` en el HTML (no inyectada por JS, no escondida en `data-src`); si es fondo CSS o fuente, `<link rel="preload">`; `fetchpriority="high"` en la imagen probable de LCP (máximo una o dos imágenes; si todo es prioritario nada lo es); `fetchpriority="low"` en lo que está fuera de pantalla; recursos críticos del mismo origen para reutilizar la conexión.
- **Error clásico**: `loading="lazy"` en la imagen LCP perjudica siempre. El hero nunca se carga de forma diferida.
- **Pintar enseguida al llegar**: CSS crítico reducido o inline (que la hoja de estilos no tarde más que el recurso LCP); sin scripts síncronos en `<head>` (usar `defer` o inline si es muy pequeño); renderizado en servidor o prerrenderizado para no depender de JS cliente (también lo exige 05/06); partir tareas largas.
- **Entregar rápido**: imágenes del tamaño correcto (`srcset`/`sizes`), formatos modernos (AVIF/WebP), comprimidas; fuentes reducidas (subconjuntos) y `font-display` distinto de `auto`/`block`; CDN y caché larga; evitar redirecciones.
- **TTFB**: servir HTML desde el borde del CDN, minimizar redirecciones y parámetros únicos que anulen la caché.
- Lo que no hay que hacer: reducir el recurso sin tocar el retraso de pintado (el ahorro solo se desplaza a otra parte), medir solo en Lighthouse local.

## 4. CLS (estabilidad visual)
- Causas típicas: imágenes/vídeos sin `width`/`height`, anuncios/embebidos/iframes sin espacio reservado (también los inyectados), fuentes web que reflowean el texto, banners (el de cookies, sobre todo) o contenido que aparece sin interacción, animaciones que cambian propiedades de layout.
- Arreglos: `width`/`height` o `aspect-ratio` en toda imagen y vídeo; reservar `min-height`/`aspect-ratio` para embebidos con el menor tamaño esperado (y mantener el hueco si no carga); **banner de cookies superpuesto o en espacio reservado, nunca empujando el contenido**; contenido tardío más abajo o botón "cargar más"; fuentes con `font-display: optional` o fallback ajustado con `size-adjust`, `ascent-override`, `descent-override`, `line-gap-override`, y precarga de las críticas; animar con `transform`, no con `top`/`left`/`box-shadow`; mantener la elegibilidad de bfcache (comprobar qué la bloquea).
- En campo el CLS cuenta toda la vida de la página (los desplazamientos a 500 ms de una interacción se excluyen).

## 5. INP (respuesta a la interacción)
- Se mide la latencia de las interacciones durante la visita; el valor es la más larga (con filtro de atípicos). Tres fases: retraso de entrada, tiempo de proceso, retraso de presentación.
- En una landing las interacciones críticas son: abrir el menú, aceptar/rechazar cookies, escribir en el formulario, pulsar el CTA, abrir FAQ/acordeones, el selector de precios.
- Arreglos: reducir tareas largas durante la carga (análisis, compilación y ejecución de scripts), ceder el hilo con frecuencia (`setTimeout`, ayudas de `async/await`), hacer solo la actualización visual en el manejador y diferir el resto (guardado, analítica) a una tarea posterior, evitar la "layout thrashing" (escribir estilos y leer layout en la misma tarea), DOM pequeño y `content-visibility` para lo que está fuera de pantalla, no generar mucho HTML en el cliente.
- Diagnóstico: primero datos de campo (RUM o PageSpeed Insights) para ver qué interacción es lenta; reproducirla en laboratorio durante la carga (cuando el hilo está más ocupado); identificar el marco (iframe) y perfilar en DevTools buscando tareas largas. Iterativo: arreglar la peor, volver a medir.

## 6. Scripts de terceros (lo que más cuesta en una landing)
- Reglas de web.dev: elegir proveedores que envíen menos código; presupuesto para terceros; **no dos proveedores para la misma función** (dos gestores de etiquetas, dos analíticas); auditar y quitar redundantes; **nunca JS de terceros síncrono en la ruta crítica**; los scripts de A/B test son un riesgo de renderizado aunque sean asíncronos (retienen el contenido); limitar peticiones a varios servidores; evitar copias duplicadas de librerías por embebidos distintos; **probar el fallo del tercero** (si falla, puede bloquear el render hasta 10-80 s; WebPageTest permite simular).
- Criterio de la skill (técnicas habituales, a verificar en la documentación actual): cargar con `async`/`defer`, después del consentimiento y/o tras la primera interacción; **fachadas** para vídeo (imagen + clic), chat y mapas; autoalojar fuentes y librerías (menos conexiones y menos transferencia de IP: ver 09); `preconnect` solo a orígenes críticos; **analítica y píxeles tras la carga** y nunca bloqueando el CTA.
- Inventario: tabla `script | para qué | peso | cuándo carga | coste en TBT/INP | ¿se puede quitar?`. Todo lo que no tenga dueño y propósito, se quita.

## 7. Entrega: servidor, caché, CDN
- **Compresión** (Brotli/gzip) para HTML, CSS, JS y SVG; HTTP/2 o HTTP/3; TLS moderno; CDN delante del origen.
- **Caché** (web.dev): recursos con huella (nombre con hash) con `Cache-Control: max-age=31536000` (y `immutable`, que algunos navegadores ignoran); **HTML con `no-cache`** (revalida con ETag y recibe 304) para que un despliegue nuevo llegue enseguida; `no-store` solo para lo que nunca debe cachearse; `public`/`private` según si un CDN puede guardarlo. Errores comunes: omitir `Cache-Control` (el navegador adivina), vida larga en URLs sin versión (HTML/CSS obsoleto tras desplegar), URL duplicadas para el mismo contenido, mezclar código estable y cambiante en el mismo archivo.
- Imágenes: servir por CDN con formato negociado, tamaños responsivos y caché larga.
- Cabeceras de seguridad y `always` en errores: ver 11.

## 8. Accesibilidad (WCAG 2.2 AA)
Referencia: cumplir el nivel AA como objetivo razonable; es también un riesgo legal en EE. UU. (litigios) y una obligación para ciertos servicios en la UE (ver 09). Las pruebas automáticas detectan solo una parte (citada habitualmente como 30-40 %; una fuente dice ~57 %): combinar con revisión manual.
- **Teclado y foco**: todo se alcanza y se usa con Tab/Mayús+Tab, sin trampas; foco visible y con buen contraste; el foco no puede quedar oculto por cabeceras fijas, el banner de cookies o el chat (2.4.11, AA).
- **Contraste**: 4,5:1 texto normal y 3:1 grande, también en hover y foco; correcto con zoom al 200 % y reflujo a 320 px de ancho.
- **Tamaño de objetivos** (2.5.8, AA): al menos 24×24 px CSS o espaciado suficiente; aumentar el relleno, no el icono. Excepciones: en línea, equivalente en otro sitio, esencial.
- **Formularios**: etiqueta visible asociada a cada campo (faltan en muchas páginas), errores anunciados al lector de pantalla (`aria-live`/`aria-describedby`), foco al primer error, autocompletado y tipos de entrada correctos.
- **Estructura**: un H1, jerarquía de encabezados sin saltos, marcadores semánticos (`main`, `nav`, `header`, `footer`, `button`, `a`), `lang` correcto; `alt` en imágenes informativas (vacío en decorativas); no transmitir información solo con color.
- **Movimiento y medios**: respetar `prefers-reduced-motion`; vídeos con subtítulos; sin parpadeos; los carruseles y animaciones se pueden pausar.
- **ARIA**: usarla solo cuando el HTML nativo no basta; mal usada empeora.
- **Flujo de prueba**: análisis automático (axe, WAVE, Lighthouse) → solo teclado → lector de pantalla (NVDA en Windows, VoiceOver en Mac/iOS) en el flujo principal (llegar, entender, formulario, enviar) → zoom 200 % y 320 px → medir objetivos táctiles en DevTools. Los criterios nuevos de 2.2 son los que más se escapan al análisis automático (una prueba citada: 0 de 21 fallos de foco oculto y 6 de 32 de tamaño de objetivo detectados).
- Declaración de accesibilidad: solo si la ley aplicable la exige (ver 09).

## 9. Vigilancia continua
- RUM desde el primer día (o, como mínimo, informe de Search Console + CrUX cuando haya datos); revisar mensualmente LCP/INP/CLS de campo por móvil y escritorio.
- Alertas de regresión en el pipeline (presupuestos) y comprobación tras cada cambio de scripts de terceros, plantilla o proveedor.
- Revisión trimestral: inventario de terceros, peso total, imágenes nuevas, tipografías, estado de caché y compresión.
- Relacionar rendimiento con negocio: comparar tasa de conversión por tramos de velocidad (08) antes de invertir mucho en décimas de segundo.

## Entregable
Informe de línea base (herramienta, perfil, fecha), presupuestos acordados, inventario de terceros con decisión por cada uno, lista de cambios hechos y resultado antes/después (laboratorio y, cuando exista, campo), y resultado de la prueba de accesibilidad (automática y manual) con pendientes.

## Puerta
No se pasa a 11 sin: LCP/CLS/INP dentro de umbral en laboratorio con perfil móvil lento y sin regresión frente a la línea base; presupuestos definidos y comprobables; scripts de terceros inventariados y cargados fuera de la ruta crítica; caché y compresión verificadas; accesibilidad manual del flujo principal hecha sin bloqueos; RUM o alternativa activa.
