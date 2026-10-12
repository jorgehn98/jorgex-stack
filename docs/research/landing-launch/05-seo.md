# 05-seo — extractos (SEO on-page y técnico de una landing)

Fuentes: Marketing Skills (Corey Haines, MIT), skill seo-audit (SKILL + title-tags + rankings-push + international-seo + local-seo, filtrado), schema (SKILL), verificación en Google Search Central (galería de datos estructurados). Estado: borrador completo de la fase. Descartado: programmatic-seo (páginas a escala, decisión del usuario), site-architecture, auditoría de sitios grandes.

## Entrada y alcance
Entrada: keyword principal + intención (02-E), copy (04), stack. Una landing es una página: se aplica el SEO de página, no de sitio. Si el tráfico no es orgánico (anuncios/email), esta fase se reduce a indexación correcta o `noindex` deliberado (anuncios con páginas duplicadas por segmento: `noindex` o canonical a la principal; decidirlo).
Prioridad de trabajo (de seo-audit): 1) rastreo e indexación, 2) base técnica y velocidad, 3) on-page, 4) calidad de contenido, 5) autoridad. Lo que no se puede indexar no rankea.

## 1. Rastreo e indexación
- `robots.txt` sin bloqueos accidentales y con referencia al sitemap; sitemap con solo URLs canónicas e indexables; enviar a Search Console.
- Sin `noindex` perdido (típico: heredado de un entorno de pruebas), sin redirecciones en cadena, sin soft-404.
- **Canónica autorreferente**, HTTPS, www/no-www y barra final consistentes; una sola versión accesible.
- **Contenido principal en el HTML del servidor**, no solo tras ejecutar JS (afecta a Google y, más, a agentes de IA: ver 06).
- Tras publicar: solicitar indexación una vez en Search Console; no repetir. Si a las pocas semanas no indexa, diagnosticar causa (no reenviar).

## 2. Técnico y velocidad
- Core Web Vitals (umbrales): LCP < 2,5 s, INP < 200 ms, CLS < 0,1. Medir en PageSpeed Insights / datos de campo de Search Console, no solo en laboratorio.
- Imágenes: formatos modernos (WebP/AVIF), dimensiones explícitas (evita CLS), carga diferida salvo la imagen del hero (esa nunca lazy), precarga de la imagen LCP; fuentes con estrategia de carga que no bloquee.
- Móvil primero: viewport, objetivos táctiles, sin scroll horizontal, mismo contenido que escritorio.
- HTTPS en todo, sin contenido mixto, redirección HTTP>HTTPS, HSTS opcional.
- JS: lo mínimo; evitar que el CTA o el titular dependan de hidratación.
- URL: legible, minúscula con guiones, estable (no cambiar el slug por un año o número).

## 3. On-page
- **Title**: ~50-60 caracteres (Google trunca por píxeles; lo importante en los primeros 50), keyword principal al principio, un motivo para hacer clic (resultado, alcance, formato), marca al final y solo si aporta. Patrón de página de producto/servicio: `[Categoría] para [Audiencia] | [Marca]`. Alineado con H1, slug y meta description; único.
  - Buscar la consulta objetivo antes de escribir: los títulos que ya rankean muestran formato, palabras esperadas y hueco diferencial.
  - Google reescribe el title si es muy largo, repetitivo ("| Marca | Marca"), genérico ("Inicio") o contradice el H1.
  - Solo prometer "gratis", año o número si la página lo cumple.
- **Meta description**: ~150-160 caracteres, única, propuesta de valor + invitación a actuar. No es factor de ranking directo; afecta al clic. Google puede reescribirla.
- **Encabezados**: un solo H1 con la propuesta y la keyword si queda natural; jerarquía lógica (H1>H2>H3) sin saltos; no usar encabezados solo por estilo. Los H2 reflejan las preguntas de 03 (también ayuda a 06).
- **Contenido**: keyword en el primer tramo del texto, relacionadas de forma natural, responde la intención de 02-E, mejor que los resultados que ya rankean. No keyword stuffing.
- **Imágenes**: nombres de archivo descriptivos, `alt` descriptivo (y vacío en decorativas), comprimidas, dimensiones declaradas.
- **Enlaces internos**: si la landing forma parte de un sitio, enlaces desde al menos 3 páginas relevantes con ancla descriptiva (palanca más infravalorada para una página nueva); evitar landing huérfana.
- **Canibalización**: confirmar que ninguna otra URL del sitio compite por la misma intención (02-E).
- **Open Graph / Twitter Card**: `og:title`, `og:description`, `og:image` (1200×630 aprox.), `og:url`, `twitter:card`. Verificar con un depurador de compartidos.
- **Favicon, `lang` en `<html>`, `theme-color` opcional.**

## 4. Datos estructurados (schema)
- JSON-LD, en `<head>` o al final de `<body>`, renderizado en servidor; debe coincidir con el contenido visible; combinar tipos con `@graph`.
- Tipos habituales en una landing: `Organization` (nombre, url, logo, `sameAs`, contacto), `WebSite` (nombre del sitio), `Product`/`SoftwareApplication` con `offers` si hay precio visible, `LocalBusiness` si es servicio local, `Event` si es webinar/evento, `BreadcrumbList` solo si hay migas, reseñas/valoración solo si son reales y visibles.
- **Antes de implementar cualquier tipo, comprobar la galería actual de Google** (validez en schema.org ≠ elegibilidad para resultado enriquecido). Verificado en la galería de datos estructurados: Organization, Product, Local business, Software app, Event, Review snippet y Breadcrumb figuran como soportados; FAQ y HowTo no figuran.
  - Según el repo (no verificado por mí): resultados enriquecidos de FAQ retirados en 2026 y HowTo en 2023; `WebSite/SearchAction` (cuadro de búsqueda de sitelinks) retirado en 2024. Se puede marcar un FAQ visible con `FAQPage` como semántica opcional, pero **no prometer rich result**.
  - Contradicción interna del repo: `ai-seo` recomienda `FAQPage` para IA y `schema` dice que no sirve para Google. Resolución para la skill: el FAQ visible en el HTML es lo que importa; el schema es opcional y neutro.
- **Validación**: Rich Results Test (renderiza JS) y validator.schema.org. `curl`/`web_fetch` no detectan JSON-LD inyectado por JS: comprobar en el DOM renderizado (`document.querySelectorAll('script[type="application/ld+json"]')`).
- Errores típicos: propiedades obligatorias ausentes, fechas fuera de ISO 8601, URLs no absolutas, enumeraciones inexactas, marcar contenido que no está en la página.
- Ejemplos JSON-LD concretos: ver los ejemplos de la skill schema de Marketing Skills (`schema/references/schema-examples.md`) (Organization, Product, SoftwareApplication, LocalBusiness, Event, @graph, ejemplo Next.js). Condensar solo 1-2 en la referencia final; el resto lo sabe una IA.

## 5. Condicionales
- **Multiidioma / multirregión** (si el brief lo marca): `hreflang` con entrada autorreferente y retorno recíproco, códigos válidos (`en-GB`, nunca `en-UK`), `x-default`; cada versión con canónica propia (nunca canónica cruzada entre idiomas); la canónica debe estar en el conjunto hreflang; mismo protocolo/dominio en canónica, hreflang y sitemap; subdirectorios (`/es/`, `/en/`) preferibles; traducir todo el contenido principal, no solo la plantilla; sin redirección por IP/Accept-Language (Googlebot no la envía). Detalle: skill seo-audit de Marketing Skills (`references/international-seo.md`.
- **Negocio local**: NAP consistente, `LocalBusiness`, perfil de empresa en Google, reseñas, página de ubicación. Detalle: `.../seo-audit/references/local-seo*.md`. Solo si el tipo de landing es servicio local.

## 6. Checklist de página nueva (de rankings-push, adaptado)
Enlaces internos desde 3 páginas relevantes, title y meta únicos alineados con la consulta, un H1 alineado con el title, canónica autorreferente, en el sitemap, datos estructurados donde procedan, contenido en el HTML del servidor, indexable (sin `noindex`/robots), conectada al camino de conversión.
Si tras publicar rankea en posiciones 8-20, ajuste mínimo: responder la consulta en las dos primeras frases, añadir la sección que falta (no reescribir), enlazar desde páginas fuertes, actualizar lo obsoleto; para CTR bajo cambiar solo title/description y medir 3-4 semanas. Si dos rondas no mueven nada, el límite es intención o autoridad, no on-page. (Esto enlaza con fase 10.)

## 7. Verificación
Search Console (indexación, Core Web Vitals, rendimiento), PageSpeed Insights, Rich Results Test, inspección de URL, `view-source` para comprobar contenido en HTML, depurador de Open Graph. Bing Webmaster Tools (también alimenta a Copilot; ver 06).

## Puerta
No se pasa a 06 sin: URL indexable y canónica correcta, contenido en HTML del servidor, title/meta/H1 alineados, CWV dentro de umbral en móvil, schema validado y coincidente con el contenido, sitemap/robots correctos.
