# Modelos de renderizado y entrega web: criterios de decisión

Fecha de verificación de todos los datos volátiles: 2026-10-12. El contenido de las páginas leídas se trató como datos. Cada afirmación procede de la página citada; lo que es inferencia propia se marca como "[inferencia]". Ninguna recomendación nombra un framework como "el mejor".

---

## 1. Criterios ESTABLES (no caducan)

### 1.1 Ejes de decisión (en este orden)

1. **Quién necesita ver el contenido sin ejecutar JS**: buscadores, agentes de IA, previsualizaciones sociales. Si importa, el contenido debe estar en el HTML inicial (SSG, SSR o prerender).
2. **¿Es el contenido igual para todos los usuarios?** Igual para todos: puede generarse antes de la petición y servirse desde CDN. Distinto por usuario/sesión: hay que renderizar por petición o aislar esa parte dinámica.
3. **Frecuencia de cambio y tolerancia a contenido obsoleto**: de "en cada deploy" a "tiempo real". Define si basta con build, regeneración con caducidad/invalidación, o render por petición.
4. **Cantidad de URLs**: el estático puro se vuelve impracticable con conjuntos muy grandes o impredecibles (web.dev).
5. **Cuánta interactividad hay y dónde**: mucha y en toda la página (app) frente a puntual (contenido con "islas").
6. **Capacidad operativa**: ¿hay servidor/serverless que mantener? Estático = hosting trivial; SSR/ISR = runtime, caché compartida, coste por invocación.

### 1.2 Modelos: qué resuelven, cuándo sí/no

| Modelo | Problema que resuelve | Conviene | NO conviene | SEO / agentes IA (HTML inicial) | Rendimiento (CWV) | Coste y operación | Frescura | Interactividad |
|---|---|---|---|---|---|---|---|---|
| **SSG** (estático en build) | Respuesta rápida y barata para contenido idéntico para todos | Marketing, docs, blog, catálogo pequeño/medio, contenido cambiado por deploy | Contenido por usuario; cambios minuto a minuto; millones de URLs; builds muy largos | Excelente: HTML completo | TTFB consistentemente bajo, FCP rápido (web.dev); INP bueno si hay poco JS | Mínimo: CDN/hosting estático | Solo al reconstruir | Solo la que añadas con JS |
| **SSR** (servidor por petición) | HTML completo con datos frescos o personalizados | Páginas personalizadas, datos que cambian constantemente, permisos por petición | Contenido idéntico y estable (pagas cómputo para nada); sin presupuesto de servidor | Excelente: HTML completo | TTFB puede subir por trabajo en servidor; FCP rápido; la rehidratación puede dañar INP/TBT | Runtime siempre activo o serverless; escalado y caché a cargo del equipo | Máxima | Alta tras hidratar |
| **SPA / CSR** | Experiencia de app sin recargas, hosting estático | Zonas tras login (dashboards, paneles, herramientas) donde SEO público no importa | Contenido público que debe indexarse/citarse; primera carga crítica | Débil: el HTML inicial es una carcasa; Google puede renderizar JS pero otros bots no (ver 1.3) | FCP/LCP más lentos; JS crece con la app y presiona INP | Barato de alojar; coste en el cliente | Datos frescos por API | Máxima |
| **ISR / regeneración** (híbrido estático+invalidación) | Estático con contenido que cambia sin rebuild global | Catálogos, blogs/CMS grandes, contenido que cambia por horas o por evento (webhook) | Datos en tiempo real; entornos sin runtime de servidor/caché persistente; export estático | Excelente: HTML completo servido desde caché | Como estático en acierto de caché; primera petición a URL no generada es más lenta | Necesita runtime y caché; en multi-instancia exige caché compartida; la regeneración en segundo plano consume cómputo | Configurable (tiempo o bajo demanda); sirve datos obsoletos mientras regenera | Igual que estático/SSR |
| **Islas / hidratación parcial** | Evitar hidratar toda la página; enviar JS solo donde hace falta | Sitios de contenido con widgets puntuales (buscador, carrito, comentarios) | Apps con estado compartido denso entre muchas partes de la página | Excelente: HTML completo | Menos JS, mejor INP/TBT; web.dev señala que la hidratación parcial "ha resultado difícil de implementar" en general | Bajo; depende del framework | Como el modo base (estático o SSR) | Local a cada isla; comunicación entre islas más trabajosa [inferencia] |
| **Render en el borde** (edge) | Reducir latencia ejecutando cerca del usuario | Lógica ligera por petición (redirecciones, personalización superficial, A/B), contenido cacheable con lógica | Dependencias Node pesadas, acceso a BD centralizada con muchas consultas (la latencia al origen anula la ganancia) [inferencia] | Igual que SSR | Menor latencia de red si los datos también están cerca | Depende del proveedor; restricciones de runtime | Como SSR/ISR | Igual |
| **Contenido gestionado por CMS (headless)** | Editores no técnicos publican sin deploy de código | Casi cualquier sitio de contenido | CMS sin preview ni webhooks cuando se necesita publicación inmediata | Depende del modelo de render elegido, no del CMS | Idem | Añade un servicio y un flujo (webhook → regeneración/rebuild, preview) | Se decide por el flujo de invalidación | Idem |

### 1.3 SEO y legibilidad por agentes de IA

- **Principio estable**: lo que está en el HTML de la primera respuesta lo ve cualquier cliente. Lo que depende de JS solo lo ven los clientes que ejecutan JS.
- **Google** procesa JS en tres fases (rastreo, renderizado en cola con Chromium headless, indexación) y sigue recomendando SSR o prerender: acelera a usuarios y rastreadores y "no todos los bots pueden ejecutar JavaScript" (Google JS SEO basics).
- **Dynamic rendering** (servir HTML prerenderizado solo a bots): Google lo describe como un workaround, no una solución recomendada; "crea complejidades y requisitos de recursos adicionales". Alternativas recomendadas: SSR, render estático o hidratación (Google, dynamic rendering).
- **Reglas HTML-primero estables según Google**: códigos de estado correctos (404 real, no soft 404); `noindex` no debe estar en el HTML inicial si luego se quiere quitar con JS (Google puede saltarse el render); canonical en HTML o idéntico si lo pone JS, y uno solo; enlaces como `<a href>` (no fragmentos de URL ni clicks sin href).
- **AI Overviews / AI Mode de Google**: sin requisitos técnicos adicionales; la página debe estar indexada y ser elegible con snippet; no hace falta markup ni archivos especiales (Google, AI features).
- **Otros agentes de IA (GPTBot, ClaudeBot, PerplexityBot)**: el estudio de Vercel/MERJ (dic. 2024) midió que ninguno renderizaba JS; Googlebot y Applebot sí. Es evidencia de un tercero, de hace casi dos años y no documentación de los proveedores: tratar como indicio fuerte, no como garantía vigente. Recomendación de diseño que no depende del dato: poner el contenido esencial en el HTML inicial. Verificar con `curl` o con JS desactivado.
- **Streaming/metadata**: con streaming, el contenido tras un límite de Suspense llega después del shell. Next.js, por ejemplo, detecta ciertos bots por user agent y les sirve render dinámico completo para que reciban los metadatos en `<head>` (Next.js caching, sección Bots and crawlers). Cualquier framework con streaming exige comprobar qué ve un cliente sin JS.

### 1.4 Core Web Vitals (umbrales vigentes, ver 2.1)

- LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1, evaluados al percentil 75 de cargas, segmentado móvil/escritorio.
- Relación con el modelo [inferencia apoyada en web.dev]: estático/ISR favorece LCP y TTFB estables; SSR añade TTFB; CSR y rehidratación completa suelen pesar en INP; islas reducen el JS que compite por el hilo principal.

### 1.5 Reglas de decisión prácticas

- Partir de lo más simple que cumpla: **estático** > **ISR/caché con invalidación** > **SSR** > **SPA** (SPA solo donde SEO no aplique).
- Los modelos se **mezclan por ruta**; casi todos los frameworks lo permiten. Decidir por página/zona, no por proyecto.
- Aislar lo dinámico: shell estático + zona dinámica (streaming, islas de servidor) antes que convertir toda la ruta en SSR.
- Edge es una decisión de **despliegue**, no un modelo de contenido. Comprobar siempre restricciones del runtime y localización de los datos.
- Con CMS: definir desde el inicio (a) cómo se dispara la actualización (webhook, tiempo), (b) cómo previsualizan los editores borradores, (c) qué pasa si el CMS cae durante el build/regeneración.
- Medir antes de optimizar (web.dev: "mide tus cuellos de botella"; estático o SSR suelen bastar).

---

## 2. Datos VOLÁTILES (versión, nombres, límites)

Todos verificados el 2026-10-12 salvo indicación.

### 2.1 Plataforma web

| Dato | Valor | URL | Fecha de la página |
|---|---|---|---|
| Umbrales CWV | LCP ≤ 2,5 s; INP ≤ 200 ms; CLS ≤ 0,1; p75 | https://web.dev/articles/vitals | actualizada 2024-10-31 |
| Guía de rendering de web.dev | Opciones SSR/CSR/estático/prerender/híbrido/rehidratación/streaming/parcial; no cubre islas ni edge | https://web.dev/articles/rendering-on-the-web | actualizada 2026-01-05 |
| Google JS SEO basics | Renderizado en cola con Chromium; SSR/prerender recomendado | https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics | 2026-03-04 |
| Google dynamic rendering | Workaround, no recomendado a largo plazo | https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering | 2025-12-10 |
| Google AI features | Sin requisitos técnicos extra | https://developers.google.com/search/docs/appearance/ai-features | 2025-12-10 |
| Estudio rastreadores IA y JS | Ninguno de los probados renderiza JS (fuente de tercero, dic. 2024) | https://vercel.com/blog/the-rise-of-the-ai-crawler | 2024-12-17 |

### 2.2 Next.js (docs vistas: versión 16.4.0)

| Dato | Valor | URL |
|---|---|---|
| Versión de la doc | 16.4.0 | https://nextjs.org/docs/app/getting-started/caching (lastUpdated 2026-10-06) |
| Partial Prerendering = comportamiento por defecto con Cache Components (`cacheComponents: true` en config); sustituye a `experimental.ppr` y `experimental_ppr`, ya eliminados | idem; Context7 `/vercel/next.js` v16.2.9 |
| `partialPrefetching: true` recomendado explícito; la doc dice que ambas opciones se activarán siempre en la próxima versión mayor y se eliminarán (por confirmar al migrar) | https://nextjs.org/docs/app/getting-started/caching |
| Directivas/funciones: `'use cache'`, `'use cache: private'`, `'use cache: remote'`, `cacheLife`, `cacheTag`, `connection()`, `<Suspense>` | idem |
| Cache por defecto de `use cache` en tiempo de ejecución: en memoria por instancia (efímera en serverless); `remote` exige cache handler compartido | idem |
| ISR sin Cache Components: `export const revalidate`, `generateStaticParams`, `dynamicParams`, `revalidatePath`, `revalidateTag(tag, 'max')`, cabecera `x-nextjs-cache` | https://nextjs.org/docs/app/guides/incremental-static-regeneration (lastUpdated 2026-06-23) |
| ISR con Cache Components: guía aparte (enlazada, no leída) | https://nextjs.org/docs/app/guides/incremental-static-regeneration-cache-components — NO VERIFICADO (contenido no abierto) |
| Límites de ISR: solo runtime Node.js; no con export estático; caché por instancia (multi-instancia requiere handler compartido); la regeneración en segundo plano cuenta como cómputo extra en plataformas con facturación por petición | https://nextjs.org/docs/app/guides/incremental-static-regeneration |
| Export estático: `output: 'export'`; no soporta Server Actions, cookies, rewrites/redirects/headers, Proxy, ISR, Draft Mode, imágenes con loader por defecto, rutas dinámicas sin `generateStaticParams` | https://nextjs.org/docs/app/guides/static-exports (lastUpdated 2026-08-09) |
| Edge Runtime (`export const runtime = 'edge'`): DEPRECADO; Node.js es el valor por defecto y no hay reemplazo | https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/runtime (2026-04-30); https://nextjs.org/docs/messages/edge-runtime-deprecated |
| Draft Mode (preview de CMS): cookie `__prerender_bypass`, `draftMode()`; incompatible con export estático | https://nextjs.org/docs/app/guides/draft-mode (2026-06-02) |

### 2.3 Astro

| Dato | Valor | URL |
|---|---|---|
| Modo por defecto: estático; `output: 'server'` para render bajo demanda; `export const prerender = false/true` por ruta; requiere adaptador (oficiales: Node, Netlify, Vercel, Cloudflare) | https://docs.astro.build/en/guides/on-demand-rendering/ |
| Islas de cliente: directivas `client:*` (p. ej. `client:idle`, `client:visible`); componentes sin JS por defecto | https://docs.astro.build/en/concepts/islands/ |
| Server islands: directiva `server:defer`; requiere adaptador | https://docs.astro.build/en/concepts/islands/ ; https://docs.astro.build/en/guides/on-demand-rendering/ |
| Live content collections: `getLiveCollection()`, `getLiveEntry()` (datos en cada petición; requiere SSR o `prerender = false`). Estado estable/experimental: la página consultada no lo indica | https://docs.astro.build/en/guides/content-collections/ ; Context7 `/withastro/docs` — estado NO VERIFICADO |
| Versión de Astro: Context7 lista `astro_6.3.1`, pero la doc de content collections menciona una nota "Added in astro@7.0.0" para caché de datos live; versión actual NO VERIFICADA | https://docs.astro.build/en/guides/content-collections/ |
| Route caching (guía): URL probada devolvió 404 | https://docs.astro.build/en/guides/route-caching/ — NO VERIFICADO |
| Guía CMS: no detalla estrategia de rebuild/webhooks | https://docs.astro.build/en/guides/cms/ |

### 2.4 SvelteKit

| Dato | Valor | URL |
|---|---|---|
| Opciones de página: `prerender` (`true`/`false`/`'auto'`), `ssr`, `csr`, `entries`, `trailingSlash` | https://svelte.dev/docs/kit/page-options |
| `ssr = false` en layout raíz = SPA; `csr = false` = sin JS en cliente; no pueden ser ambos `false` | idem |
| `prerender = 'auto'`: prerender + sigue disponible para SSR (cola larga) | idem; Context7 `/sveltejs/kit` |
| Páginas prerenderizadas deben dar el mismo contenido a todos; `url.searchParams` prohibido durante prerender | idem |
| Adaptadores oficiales: `adapter-cloudflare`, `adapter-netlify`, `adapter-node`, `adapter-static`, `adapter-vercel`, `adapter-bun`. La página no define ISR ni "edge" como concepto propio; no se verificó ISR en SvelteKit | https://svelte.dev/docs/kit/adapters |

### 2.5 Nuxt (doc 4.x; la página no muestra versión ni fecha)

| Dato | Valor | URL |
|---|---|---|
| Modos: universal (SSR + hidratación, por defecto), cliente (`ssr: false`), híbrido por `routeRules` | https://nuxt.com/docs/4.x/guide/concepts/rendering |
| `routeRules`: `prerender`, `swr`, `isr`, `ssr: false`, `redirect`, `headers`, `noScripts`, etc. `isr` usa caché de CDN solo en Netlify/Vercel | idem; Context7 `/websites/nuxt_4_x` |
| `nuxt generate` no soporta reglas híbridas ni endpoints de servidor | idem |
| Edge-side rendering: presets Nitro (Cloudflare Pages, `vercel-edge`, `netlify-edge`) según la doc; por la deprecación en Next, comprobar vigencia de los presets antes de recomendar | idem — vigencia de presets NO VERIFICADA |
| URL sin `/4.x/` (`/docs/guide/concepts/rendering`) devolvió 404 | — |

### 2.6 React Router / Remix (doc 8.4.0 "latest")

| Dato | Valor | URL |
|---|---|---|
| Estrategias en modo framework: SPA (`ssr: false`), SSR (`ssr: true`, por defecto), prerender estático (`prerender`) en `react-router.config.ts` | https://reactrouter.com/start/framework/rendering |
| `prerender`: `true`, array de rutas o función con `getStaticPaths` (p. ej. slugs desde un CMS); salida `.html` + `.data` | https://reactrouter.com/how-to/pre-rendering |
| `ssr: false` + `prerender`: sin servidor; `action`/`headers` son error de build; fallback SPA (`index.html` o `__spa-fallback.html`) | idem |
| No documenta ISR/revalidación de páginas prerenderizadas: estático = build-time; frescura exige rebuild o SSR | idem |
| Remix como producto independiente: no se verificó su documentación; la vía actual de la misma base es React Router modo framework | NO VERIFICADO |

---

## 3. Tabla de decisión (necesidad → modelo → motivo → contraindicación)

| Necesidad | Modelo recomendado | Motivo | Contraindicación |
|---|---|---|---|
| Web corporativa/landing/docs, contenido cambia por deploy | SSG | HTML completo, TTFB estable, hosting mínimo | Más de decenas de miles de URLs con builds inaceptables; contenido personalizado |
| Blog/catálogo con CMS, cambios por horas o por publicación | ISR o SSG + rebuild por webhook | Estático rápido con frescura configurable, sin rebuild global | Sin runtime/caché compartida (multi-instancia sin handler); export estático; necesidad de tiempo real |
| Catálogo grande (miles a millones de URLs) con cola larga | ISR / prerender de las populares + generación bajo demanda del resto | Evita builds enormes | Frameworks sin generación bajo demanda (p. ej. React Router solo prerender, según su doc) |
| Contenido personalizado por usuario o permisos por petición, con SEO | SSR, o shell estático + zona dinámica con streaming/server islands | Contenido correcto en HTML inicial sin perder el shell cacheado | Streaming sin verificar qué ve un cliente sin JS; coste de servidor |
| Datos en tiempo real/cambian por segundo | SSR (o SPA con API si no requiere SEO) | Frescura máxima | ISR con revalidación de segundos (la doc de Next recomienda revalidar con intervalos altos) |
| Panel/app tras login, sin SEO | SPA (CSR) | Máxima interactividad, hosting barato | Cualquier contenido público que deba indexarse o ser citado por IA |
| Sitio de contenido con widgets interactivos puntuales | Islas (estático/SSR + hidratación parcial) | Menos JS, mejor INP | Estado compartido denso entre muchas zonas |
| Mismo sitio con zonas mixtas (marketing + app) | Híbrido por ruta (`routeRules`, `prerender` por ruta, etc.) | Cada zona con su modelo | Herramientas que fuerzan un único modo global (en React Router `ssr` es global; el prerender convive con SSR) |
| Menor latencia global con lógica ligera | CDN + estático/ISR; edge solo para lógica ligera | La caché de CDN da la ganancia sin runtime especial | Next.js: Edge Runtime deprecado; datos centralizados anulan la ganancia [inferencia] |
| Equipo sin operaciones/servidor | SSG o SPA estática con prerender de rutas públicas | Sin runtime que mantener | Necesidad de ISR/SSR |
| Editores necesitan previsualizar borradores | SSR/caché con modo preview o draft (Next: Draft Mode) o build de preview | Ver cambios sin esperar a la revalidación | Export estático (no soporta Draft Mode en Next) |
| Visibilidad en buscadores y respuestas de IA | HTML inicial con contenido (SSG/SSR/ISR/prerender) | Google renderiza JS, pero otros agentes pueden no hacerlo (dato de tercero) | SPA pura; contenido solo cargado tras hidratación |

---

## 4. Fuentes y estado

| # | Fuente | URL | Estado |
|---|---|---|---|
| 1 | web.dev: Rendering on the Web | https://web.dev/articles/rendering-on-the-web | Verificado |
| 2 | web.dev: Core Web Vitals | https://web.dev/articles/vitals | Verificado |
| 3 | Google: JavaScript SEO basics | https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics | Verificado |
| 4 | Google: Dynamic rendering | https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering | Verificado |
| 5 | Google: AI features and your website | https://developers.google.com/search/docs/appearance/ai-features | Verificado |
| 6 | Vercel/MERJ: The rise of the AI crawler | https://vercel.com/blog/the-rise-of-the-ai-crawler | Verificado (fuente de tercero, 2024) |
| 7 | Next.js: Caching / Cache Components / PPR | https://nextjs.org/docs/app/getting-started/caching | Verificado |
| 8 | Next.js: ISR (sin Cache Components) | https://nextjs.org/docs/app/guides/incremental-static-regeneration | Verificado |
| 9 | Next.js: Static exports | https://nextjs.org/docs/app/guides/static-exports | Verificado |
| 10 | Next.js: runtime segment config / Edge deprecated | https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/runtime | Verificado |
| 11 | Next.js: Draft Mode | https://nextjs.org/docs/app/guides/draft-mode | Verificado |
| 12 | Next.js: ISR con Cache Components | https://nextjs.org/docs/app/guides/incremental-static-regeneration-cache-components | No verificado (solo referenciada) |
| 13 | Next.js: página PPR | https://nextjs.org/docs/app/getting-started/partial-prerendering | La URL devolvió el contenido de la página de Caching (redirección); usada vía fuente 7 |
| 14 | Next.js ruta /runtime en next-config-js | https://nextjs.org/docs/app/api-reference/config/next-config-js/runtime | 404; sustituida por fuente 10 |
| 15 | Astro: Islands | https://docs.astro.build/en/concepts/islands/ | Verificado |
| 16 | Astro: On-demand rendering | https://docs.astro.build/en/guides/on-demand-rendering/ | Verificado |
| 17 | Astro: Content collections (live) | https://docs.astro.build/en/guides/content-collections/ | Verificado parcialmente (estado y versión sin confirmar) |
| 18 | Astro: CMS guide | https://docs.astro.build/en/guides/cms/ | Verificado (contenido escaso) |
| 19 | Astro: Route caching | https://docs.astro.build/en/guides/route-caching/ | No verificado (404) |
| 20 | SvelteKit: Page options | https://svelte.dev/docs/kit/page-options | Verificado |
| 21 | SvelteKit: Adapters | https://svelte.dev/docs/kit/adapters | Verificado |
| 22 | Nuxt 4.x: Rendering modes | https://nuxt.com/docs/4.x/guide/concepts/rendering | Verificado (sin versión/fecha en la página) |
| 23 | Nuxt (ruta sin 4.x) | https://nuxt.com/docs/guide/concepts/rendering | 404 |
| 24 | React Router: Rendering strategies | https://reactrouter.com/start/framework/rendering | Verificado |
| 25 | React Router: Pre-rendering | https://reactrouter.com/how-to/pre-rendering | Verificado |
| 26 | Context7 (`/vercel/next.js`, `/withastro/docs`, `/sveltejs/kit`, `/websites/nuxt_4_x`, `/websites/reactrouter`) | — | Consultado; usado como confirmación |
| 27 | Remix (docs propias) | — | No verificado |
| 28 | Google: gen AI content guidance | https://developers.google.com/search/docs/fundamentals/using-gen-ai-content | Abierta, sin información útil para este tema |

---

## 5. Resumen final: qué cambiaría la recomendación de la skill

1. Si el contenido público debe verse sin JS (SEO e IA), descartar SPA pura; no depender de que todos los bots rendericen JS (dato de tercero de 2024, reverificar).
2. Preguntar siempre: ¿contenido idéntico para todos? ¿cada cuánto cambia? ¿cuántas URLs? Esas tres respuestas deciden SSG, ISR o SSR.
3. ISR depende del framework y del hosting: en Next.js exige runtime Node y caché compartida en multi-instancia, y no existe con export estático; en React Router solo hay prerender de build.
4. Edge no es un modelo: en Next.js el Edge Runtime está deprecado (doc 16.4.0); en Nuxt/SvelteKit se logra por preset/adaptador. Confirmar vigencia antes de proponerlo.
5. Partial Prerendering de Next.js ya es el comportamiento por defecto con `cacheComponents`; la skill debe usar el nombre actual y no `experimental.ppr`. Las opciones se unificarán en la próxima versión mayor.
6. Con CMS, la skill debe exigir definir tres cosas: disparo de actualización (webhook/tiempo), preview de borradores y tolerancia a caída del CMS.
7. Islas/server islands (Astro) y shell estático + streaming (Next) son la vía para mezclar estático y dinámico; el streaming exige verificar qué ve un cliente sin JS.
8. Datos sin confirmar: estado y versión de live collections de Astro, vigencia de presets edge de Nuxt, ISR con Cache Components, docs propias de Remix. Revalidar antes de citarlos.
9. Las páginas de Next.js (16.4.0) cambian cada pocas semanas: toda cifra o nombre de API de este informe caduca; reconfirmar en la URL oficial.
