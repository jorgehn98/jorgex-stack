# 06-seo-ia — extractos (visibilidad en buscadores y agentes de IA)

Fuentes: Marketing Skills (Corey Haines, MIT), skill ai-seo (SKILL + agent-readiness + platform-ranking-factors + content-patterns, filtrado), pricing (teardown), verificación en la guía de Google sobre funciones de IA. Estado: borrador completo de la fase. Descartado para una landing: LinkedIn, YouTube, OKF, volatilidad de formatos, citas vs recomendaciones, contenido de listados/comparativas (son programas de contenido, no una landing).

## Postura (verificada en Google Search Central)
- Google dice que las prácticas de SEO siguen valiendo para AI Overviews/AI Mode: **no hacen falta marcado especial, archivos de texto para IA, Markdown, ni trocear el contenido, ni escribir contenido aparte para IA** (crear muchas páginas por variantes de consulta para manipular puede violar su política de contenido a escala). `llms.txt` es inofensivo pero Google Search lo ignora. Desconfiar de herramientas "AEO/GEO" que prometen posicionamiento.
- Los demás motores (ChatGPT, Claude, Perplexity, Copilot) y los agentes que compran/compararn sí premian estructura extraíble y páginas legibles por máquina.
- Regla para la skill: **escribir para personas, organizar con claridad**. Esta fase añade capas baratas para los motores no-Google, sin contradecir a 05.
- Es una capa sobre el SEO, no un sustituto: buen posicionamiento orgánico sigue siendo el mejor predictor de visibilidad en IA.
- Las cifras de "+30-40% de visibilidad" (estudio GEO, 2023) y citas de cuota por plataforma son datos fechados y de muestra concreta: no usarlas como promesa.

## Esta fase = dos preguntas
### A. ¿Puede un agente llegar y leer la página? (acceso, descubrimiento, parseabilidad)
- **Acceso**: el contenido real (titular, precio, CTA, FAQ) está en el HTML inicial; la mayoría de agentes no ejecutan JS. Códigos HTTP reales, sin soft-404, canónicas estables. Ningún reto de bot/WAF/CDN bloquea por defecto a rastreadores legítimos de IA (muchos sitios los bloquean sin haberlo decidido: comprobar la regla del CDN, no solo `robots.txt`).
- **Política de rastreadores por propósito** (no copiar una lista permisiva en bloque):
  - Descubrimiento/búsqueda (permitir si se quiere salir en respuestas): `Googlebot`, `Bingbot`, `OAI-SearchBot`, `PerplexityBot`, `Claude-SearchBot`.
  - Recuperación a petición del usuario: `ChatGPT-User`, `Claude-User`, `Perplexity-User` (el comportamiento respecto a `robots.txt` varía por proveedor; para gestionar ChatGPT Search usar `OAI-SearchBot`, no `ChatGPT-User`).
  - Entrenamiento de modelos (decisión del editor): `GPTBot`, `ClaudeBot`. Bloquear entrenamiento **no** implica bloquear citas.
  - `Google-Extended` controla ciertos usos de Gemini (entrenamiento y grounding); no afecta a inclusión ni ranking en Google Search.
  - **Verificar nombres y consecuencias en la documentación vigente de cada proveedor** (OpenAI, Anthropic, Perplexity, Google) antes de escribir el `robots.txt`; cambian. Preguntar al usuario su postura sobre entrenamiento.
- **Descubrimiento**: sitemap que carga y parsea; `llms.txt` opcional (barato; no ayuda a Google; ayuda a algunos agentes). `llms-full.txt` emergente, opcional.
- **Parseabilidad**: JSON-LD válido (05), un H1, encabezados que respondan sub-preguntas, bloques de respuesta extraíbles (B). Marcado semántico (`main`, `nav`, `article`, `button`), accesibilidad (etiquetas, `alt`): los agentes leen el árbol de accesibilidad como un lector de pantalla.
- Emergente, no prometer: representación Markdown por negociación de contenido (`Accept: text/markdown`) o cabecera `Link`; WebMCP (acciones de formulario/CTA como herramientas). Útil hoy: que el CTA principal y el formulario funcionen sin flujos solo-JS, con campos etiquetados y confirmación legible por máquina.
- Medición rápida: herramientas gratuitas de "agent readiness" (p. ej. `npx is-agentic dominio`, comprobador de Frase): son de proveedores; valen los checks, no el pitch.

### B. ¿Puede un modelo extraer y citar el contenido de la landing?
- **Cada afirmación clave se entiende sola** (los modelos extraen pasajes, no páginas). Definir qué es el producto en la primera frase del hero o justo debajo, con las palabras de la categoría ("estantería" de 02-A).
- Bloques extraíbles: definición ("qué es"), pasos (cómo funciona), tabla comparativa solo si procede y es honesta, pros/contras, FAQ con preguntas en lenguaje natural, bloque de cifras con fuente y fecha. Respuestas cortas (~40-60 palabras) al principio de cada sección.
- Credibilidad citable: cifras con fuente nombrada y fecha, citas con nombre y cargo, autor/empresa identificable con datos de contacto, fecha de última actualización visible y real. Keyword stuffing empeora la visibilidad.
- **Frescura**: revisar la página a intervalos y reflejar la fecha real; no cambiar la fecha sin cambiar el contenido.
- **Precio legible** (de 02-G): números en texto HTML, límites por tramo en palabras, FAQ de cancelación/prueba/límites, `Offer` en schema, sin "Contactar" en todos los tramos. **Prueba "paste test"**: preguntar a una IA con navegación "¿qué planes y precios tiene [URL]?"; si falla, los agentes también. Opcional: `/pricing.md` con precios en formato simple (coherente con la página, mantenido al día; si queda desfasado es peor que no tenerlo).
- **Consenso y entidad** (fuera de la página, pero decisivo): perfiles de terceros (reseñas, directorios, redes, Crunchbase/LinkedIn, Google Business Profile si aplica) describen al negocio con el mismo segmento y posicionamiento que la página; los modelos buscan coherencia. Si la IA describe mal el producto, la página que debería decirlo no lo dice con claridad: corregirla primero.
- Bing: registrar el sitio en Bing Webmaster Tools (alimenta a Copilot; en ChatGPT search se apoya en un índice tipo Bing según el repo, no verificado) y considerar IndexNow para indexación rápida.

## Auditoría de visibilidad (post-lanzamiento, ligera)
Lista de 10-20 consultas que cambian ingresos (no glosario), redactadas como las teclea una persona: de problema, de solución/categoría ("mejor X para Y"), de producto ("[marca] vs [competidor]", "¿[marca] sirve para…?") y de decisión ("[marca] precio", integraciones). Probar en Google (AI Overview), ChatGPT con búsqueda y Perplexity; anotar si salimos citados, qué dicen de nosotros (¿es correcto?) y qué fuentes citan. Repetir cada consulta varias veces; los resultados varían. Si decimos algo mal o falta, arreglar la página que debería explicarlo; si faltamos, las fuentes que citan son la lista de objetivos de presencia. Search Console tiene informe de rendimiento de IA generativa (según la guía de Google): usar métricas estándar.

## Puerta
No se pasa a 07 sin: contenido clave en HTML servido, política de rastreadores decidida y reflejada en `robots.txt` y WAF/CDN, sitemap OK, bloques extraíbles y FAQ visible, precio (si hay) legible en texto, paste test superado o limitación declarada.
