# Arquitectura: elegir framework de frontend y backend (Tema B, fase "lenguaje y framework")

Fecha de verificación: 2026-10-12. Todo lo marcado VOLÁTIL debe re-verificarse en la URL oficial antes de usarlo.
Método: Context7 (resolve-library-id y query-docs) para existencia y alcance declarado; WebFetch sobre páginas oficiales para política de soporte. El contenido de las páginas se trató como dato. No se instaló nada. WebFetch resume cada página con un modelo pequeño, así que las cifras y fechas son "lo que la página dice según el resumen"; la skill debe re-abrir la URL antes de citarlas como definitivas.

Convención de estado: VERIFICADO (visto en fuente oficial hoy), PARCIAL (visto en parte o solo vía tercero), NO VERIFICADO (no se pudo abrir o no aparece; no se completó de memoria).

---

## 1. Categorías (criterios estables)

Estas categorías cambian poco; los ejemplos sí cambian. La skill debe decidir por categoría y solo después por ejemplo.

### Frontend

| Categoría | Qué problema resuelve | Cuándo conviene | Cuándo no |
|---|---|---|---|
| A. Framework de contenido / islas | Páginas mayormente de contenido con HTML estático por defecto y JS solo donde hay interactividad | Landings, webs corporativas, blogs, documentación, catálogos con poca interactividad | Aplicación con estado de cliente denso y compartido entre vistas (paneles, editores); el modelo de islas complica ese estado |
| B. Framework full-stack con renderizado en servidor (meta-framework sobre una librería de UI) | Routing, carga de datos, SSR/SSG/híbrido y endpoints de servidor en un solo proyecto | Producto web con SEO y partes dinámicas; equipo pequeño que quiere un solo repositorio frontend+servidor ligero | Cuando ya existe un backend maduro y solo se necesita UI estática; cuando se quiere evitar acoplar el despliegue a un runtime de servidor concreto |
| C. Librería de UI para SPA | Componentes y estado en el navegador; el resto (router, build, datos) lo eliges tú | Aplicación detrás de login donde el SEO no importa; equipo con criterio para ensamblar piezas | Sitios públicos que viven de SEO y primera carga rápida sin añadir SSR; equipos que no quieren decidir la pila |
| D. Framework opinado para aplicaciones grandes | Estructura, inyección de dependencias, CLI, formularios, pruebas y convenciones cerradas | Muchos equipos o desarrolladores rotando sobre una base de código grande y longeva | Prototipos, landings, equipos de 1-2 personas; el coste de aprendizaje y la ceremonia superan el beneficio |
| E. Generador estático | Producir HTML en el build y servirlo desde cualquier hosting | Documentación, blogs, sitios cuyo contenido cambia con despliegues | Contenido por usuario o en tiempo real sin una capa dinámica adicional |
| F. Sin framework (HTML/CSS/JS, o JS mínimo sin build) | Cero dependencias y cero migraciones | Landing de una o pocas páginas, prototipos, widgets embebidos | Más de unas pocas páginas con componentes repetidos o estado; acaba reinventando un framework |

Nota de límites: las categorías se solapan por diseño. Varios frameworks cubren más de una (p. ej. Vue y React Router declaran SPA, SSR y estático según el modo). La skill debe elegir por el modo de renderizado que necesita el proyecto, no por la etiqueta del framework.

### Backend

| Categoría | Qué problema resuelve | Cuándo conviene | Cuándo no |
|---|---|---|---|
| G. Framework minimalista | Enrutado y middleware; el resto lo decides tú | API pequeña, servicio acotado, equipo que sabe qué piezas quiere | Proyecto grande sin convenciones internas: cada equipo reinventa auth, validación, migraciones |
| H. Framework "con baterías" (MVC) | ORM, migraciones, auth, formularios, admin, colas, correo integrados y con convenciones | SaaS o aplicación con base de datos relacional, CRUD abundante, plazo corto, equipo pequeño | Servicio mínimo de una sola función; casos donde el ORM o el ciclo de petición del framework estorban |
| I. Framework de API de alto rendimiento / orientado a esquemas | API tipada con validación y documentación OpenAPI derivadas del código | API pura consumida por SPA, móvil o terceros; servicios de datos/ML | Aplicaciones con vistas HTML, admin y flujos de usuario donde faltan piezas integradas |
| J. Backend como servicio (BaaS) | Auth, base de datos, almacenamiento y funciones gestionados por un proveedor | MVP, equipo sin backend dedicado, CRUD con reglas de acceso simples | Lógica de negocio compleja, requisitos de residencia de datos o salida (portabilidad) estrictos; riesgo de dependencia del proveedor (ver sección 3) |

Nota: en esta investigación no se verificaron BaaS concretos (no estaban en la lista del encargo). La categoría J queda definida por criterio, sin ejemplos ni política de soporte: NO VERIFICADO. Para evaluar uno hay que aplicar las mismas señales de la sección 3 más portabilidad de datos y SLA/precio del proveedor.

---

## 2. Ejemplos por categoría con documentación oficial

Los ejemplos ilustran la categoría; no son recomendaciones ni ranking. "Context7" indica el ID resuelto (confirma que la documentación está indexada); "Soporte" es la política que publica el proyecto. Los números de versión son VOLÁTILES.

### Frontend

| Ejemplo | Categoría | Docs oficiales (VERIFICADO salvo nota) | Context7 | Alcance declarado | Soporte / versionado publicado |
|---|---|---|---|---|---|
| Astro | A (y E) | https://docs.astro.build | /withastro/docs (también /websites/astro_build_en) | "Content-focused websites", islas; salida estática por defecto y render bajo demanda opcional con adaptador; server islands | Semver "intentado"; seguridad-only para una mayor anterior; cambios experimentales pueden romper en minor/patch. Última mayor mostrada en la página oficial: 7.x (7.3.8). Nota: Context7 lista la versión astro_6.3.1, es decir, va por detrás de la web oficial |
| Next.js | B | https://nextjs.org/docs | /vercel/next.js (también /websites/nextjs) | "Full-stack web applications" con React; permite exportación estática (`output: 'export'`) sin funciones de servidor | https://nextjs.org/support-policy: 16.x Active LTS (21 oct 2025), 15.x Maintenance LTS (21 oct 2024); mantenimiento = 2 años tras el lanzamiento inicial (inferencia: 15.x termina hacia oct 2026); en Maintenance LTS las actualizaciones llegan como minor aunque rompan |
| Nuxt | B (Vue) | https://nuxt.com/docs | /websites/nuxt_4_x | Full-stack con Vue; modos universal, solo cliente, híbrido por ruta (`routeRules`), borde | Página de política de lanzamientos: NO VERIFICADO (las URLs probadas devolvieron 404). Comprobar en nuxt.com y en el repositorio |
| SvelteKit | B (Svelte) | https://svelte.dev/docs/kit | /websites/svelte_dev_kit | Página "project types": SSG, SPA, SSR, contenedor Node, serverless, etc. según adaptador | Guías de migración a v2 y v3 enlazadas en la documentación; política de soporte explícita: NO VERIFICADO |
| React Router (modo framework) | B; en modos data/declarative es C | https://reactrouter.com | /remix-run/react-router | Tres modos aditivos: declarative, data, framework; framework = SPA, SSR o estático | Página de modos lista versiones 8.4.0, 7.18.4, 6.30.6; guía "upgrading" a v7 existe. Política de soporte: NO VERIFICADO |
| Angular | D | https://angular.dev | /websites/angular_dev | Framework completo "para aplicaciones escalables"; CLI y schematics de migración | https://angular.dev/reference/releases: mayor cada 12 meses (desde v22; antes 6); cada mayor ~24 meses (12 activo + 12 LTS). Tabla: 22 Active (2026-06-03), 21 LTS, 20 LTS hasta 2026-11-28. `ng update` de una mayor cada vez |
| Vue | C (progresivo; con SSR/SSG según uso) | https://vuejs.org | /websites/vuejs | Declara usos: script suelto, componentes web, SPA, full-stack SSR, SSG | https://vuejs.org/about/releases: sin ciclo fijo, minor cada 3-6 meses, semver con excepciones (tipos TS pueden romper en minor); no define ventanas de soporte. Vue 2: el sitio v2 muestra "reached EOL" (fecha exacta en esa página: no mostrada) |
| React (librería) | C | https://react.dev | No se resolvió con Context7 en esta investigación | NO VERIFICADO (no se abrió la documentación ni su política) | NO VERIFICADO |

### Backend

| Ejemplo | Categoría | Docs oficiales | Context7 | Alcance declarado | Soporte / versionado publicado |
|---|---|---|---|---|---|
| Express | G | https://expressjs.com | /websites/expressjs, /expressjs/express | "Fast, unopinionated, minimalist" (Node) | https://expressjs.com/en/support/: solo la última versión de cada línea mayor; v5 y v4 listadas como vigentes; EOL "puede" recibir parches críticos sin garantía; sin LTS formal; guía de migración a v5 con codemods |
| Fastify | G/I | https://fastify.dev | /fastify/fastify | Framework Node de bajo overhead, plugins, esquemas | https://fastify.dev/docs/latest/Reference/LTS/: soporte mínimo 6 meses desde el lanzamiento y seguridad 6 meses tras la siguiente mayor; v5 (2024-09-17) fin de LTS "TBD"; guía de migración v4 a v5 |
| NestJS | D (backend) | https://docs.nestjs.com | /websites/nestjs | Arquitectura "out-of-the-box" inspirada en Angular; usa Express o Fastify debajo | No se encontró política de soporte (NO VERIFICADO). La guía de migración vigente cubre v11 a v12 y trae `nest upgrade` |
| Hono | G | https://hono.dev | /websites/hono_dev | "Small, simple, ultrafast", Web Standards; Workers, Deno, Bun, Node vía adaptador | Sin afirmaciones de estabilidad ni semver en la página inspeccionada: NO VERIFICADO |
| Django | H | https://docs.djangoproject.com | /websites/djangoproject_en_6_1 | Framework Python "con baterías" (ORM, admin, auth) | https://www.djangoproject.com/download/: 5.2 LTS (extendido hasta abril 2028), 6.0 y 6.1 vigentes; 6.2 LTS prevista abril 2027; desde 2028 cada versión recibe 3 años y salen anualmente en enero; política de deprecación: 2 versiones de aviso (docs de release process). Licencia BSD (según la página) |
| FastAPI | I | https://fastapi.tiangolo.com | /websites/fastapi_tiangolo | API Python basada en type hints, OpenAPI y JSON Schema | https://fastapi.tiangolo.com/deployment/versions/: versión 0.x; "cualquier versión por debajo de 1.0.0 podría romper"; recomiendan fijar la versión. Importante para la skill: es un riesgo de mantenimiento documentado |
| Rails | H | https://guides.rubyonrails.org | /rails/rails | Framework MVC "everything needed" para apps con base de datos | https://rubyonrails.org/maintenance: fixes de bugs 1 año, seguridad 2 años por serie menor; la página lista 8.1.x (bugs hasta 2026-10-10, seguridad hasta 2027-10-10) y 8.0.x (seguridad hasta 2026-11-07). Fechas según resumen; re-verificar |
| Laravel | H | https://laravel.com/docs | /laravel/docs | Framework PHP full-stack y APIs | https://laravel.com/docs/master/releases: mayor anual (~Q1), bugs 18 meses, seguridad 2 años; v12 (feb 2025, seguridad hasta 2027-02-24); v13 (17 mar 2026 según docs 13.x en Context7). La propia página master muestra aún datos provisionales para 13 |
| Spring Boot | H | https://docs.spring.io/spring-boot | /spring-projects/spring-boot (y /websites/spring_io_spring-boot) | Aplicaciones Spring "production-grade" con autoconfiguración, Tomcat/Jetty/Undertow embebidos | https://spring.io/support-policy: mayores hasta 3 años, menores mínimo 13 meses (OSS)/25 (suscripción); la tabla con fechas por versión no se pudo ver en la página oficial (PARCIAL). Dato de tercero (endoflife.date, no oficial): 4.1 hasta 2027-07, 4.0 hasta 2026-12, 3.5 hasta 2026-06. Última versión mostrada: 4.1.1 |
| ASP.NET Core | H/I | https://learn.microsoft.com/aspnet/core | /dotnet/aspnetcore.docs | Web API, minimal APIs, MVC, Razor Pages, Blazor | https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core: LTS 3 años (pares), STS 2 años (impares, 24 meses desde la 1ª publicación); .NET 10 LTS hasta 2028-11-14; .NET 8 y 9 hasta 2026-11-10 (según la página hoy) |
| Phoenix (Elixir) | H | https://hexdocs.pm/phoenix (redirige a phoenix.hexdocs.pm) | /phoenixframework/phoenix | MVC del lado del servidor; canales y LiveView para tiempo real; v1.8.15 en el encabezado; el instalador exige Elixir ~> 1.18 | Política de soporte/versionado: NO VERIFICADO |
| Go net/http (biblioteca estándar) | G (sin framework de terceros) | https://pkg.go.dev/net/http, https://go.dev/doc/ | /golang/website, /golang/go | `ServeMux` con método y comodines desde Go 1.22 | https://go.dev/doc/devel/release: cada mayor se soporta hasta que salen dos mayores más; promesa de compatibilidad Go 1; mayores cada ~6 meses (1.27.0 el 2026-08-19) |
| BaaS (p. ej. cualquiera) | J | No verificado en este informe | - | - | NO VERIFICADO |

Plataforma de ejecución (relevante para las categorías Node): https://nodejs.org/en/about/previous-releases (VERIFICADO): v26 Current, v24 y v22 LTS; desde Node 27 el ciclo pasa a anual y todas las mayores pasan a LTS; "las aplicaciones de producción solo deben usar Active o Maintenance LTS"; LTS ≈ 30 meses.

---

## 3. Señales de salud y riesgo de mantenimiento

Principio: ninguna señal sola decide. Combinar y registrar fecha. Una puntuación o un número de estrellas no sustituye leer la política de soporte.

| Señal | Qué indica | Cómo comprobarla |
|---|---|---|
| Cadencia de versiones | Si el proyecto sigue vivo y qué ritmo de migración te impone | Página de releases/tags del repositorio (GitHub Releases); en la web oficial, la página de "releases" o "support policy" (ver tabla sección 2) |
| Política de soporte / LTS | Cuánto tiempo recibirás parches de seguridad sin migrar | Página oficial de soporte; compara su ventana con la vida esperada del proyecto. Ejemplos de forma: Angular 12+12 meses, Next 2 años en Maintenance, Rails 1 año bugs/2 años seguridad, .NET 3 años LTS, Laravel 18 meses/2 años. Si no hay política publicada (p. ej. Hono, Vue sin ventanas, FastAPI 0.x), tratarlo como riesgo medio y fijar versiones |
| Versión mayor actual vs la de tu proyecto | Margen antes de EOL | Misma página de soporte; endoflife.date sirve como índice de apoyo, pero es tercero: contrastar siempre con la fuente oficial |
| Gobernanza | Quién decide y qué pasa si se va el patrocinador principal | Buscar GOVERNANCE.md, página de fundación o de equipo. Observado hoy: Django bajo Django Software Foundation (501(c)(3), junta con elecciones anuales); Astro con GOVERNANCE.md (roles, comité técnico, steward); Express y Fastify bajo OpenJS Foundation (Express lo indica por su copyright y aviso; Fastify lo implica en su política LTS, sin verificar gobernanza formal); Next.js propiedad de una organización comercial (el repo es de la org vercel, tipo Organization). Dependencia de una sola empresa = riesgo de cambios de rumbo o de licencia, no un defecto por sí mismo |
| Licencia | Derechos de uso y riesgo de cambio | Archivo LICENSE y campo `license` de la API de GitHub (`https://api.github.com/repos/<org>/<repo>`). Cuidado: la API devolvió `NOASSERTION` para Astro (no identifica la licencia automáticamente), así que abrir LICENSE a mano. Next.js: MIT según la API. Django: BSD según la página de descarga. Revisar cambios de licencia históricos del proyecto o de sus dependencias clave |
| Avisos de seguridad | Si el proyecto publica y corrige vulnerabilidades con proceso | GitHub Advisory Database: https://github.com/advisories con filtros `ecosystem:npm` y `affects:<paquete>`, y la pestaña Security > Advisories del repositorio. Documentación: https://docs.github.com/en/code-security/security-advisories. Importante: tener avisos publicados es señal de proceso sano; cero avisos no prueba seguridad. Mirar tiempo entre aviso y versión corregida. Ejemplo hoy: Astro muestra 10 avisos en la primera de cinco páginas, el más reciente publicado el 2026-08-27 (crítico, RCE en optimización de imágenes AVIF) |
| OpenSSF Scorecard | Prácticas de seguridad de la cadena de suministro (revisión de código, workflows, pinning, política de seguridad) | https://scorecard.dev y API `https://api.scorecard.dev/projects/github.com/<org>/<repo>`; CLI `scorecard --repo=github.com/<org>/<repo>` (requiere token de GitHub). 18 checks puntuados 0-10; un -1 significa "no evaluable". Límites declarados por el proyecto: son heurísticas opinadas, con falsos positivos y negativos; el agregado oculta qué prácticas faltan. Lecturas de hoy a modo de ejemplo del formato, no de ranking: express 8.9 (2026-10-09), django 6.4 (2026-10-05) |
| Nº de mantenedores / factor bus | Continuidad si alguien se va | Pestaña Insights > Contributors, CODEOWNERS, check `Contributors` y `Maintained` de Scorecard; ver si los commits recientes vienen de varias personas y organizaciones. Umbral concreto: no hay uno oficial; documentar el criterio que se elija |
| Guía de migración entre mayores | Coste real de seguir el ritmo del proyecto | Buscar "migration/upgrade guide" por cada mayor: Express (migrating-5, con codemods), Fastify (Migration-Guide-V5), NestJS (migration-guide v11 a v12 con `nest upgrade`), Angular (`ng update` y Update Guide), React Router (upgrading/v7), Astro (guía por mayor), SvelteKit (v2, v3), Laravel (upgrade 12 a 13). Su existencia y la automatización (codemods) reducen el coste |
| Política de deprecación | Previsibilidad | Django: deprecaciones duran al menos 2 versiones; Vue: lo deprecado se elimina en la siguiente mayor; Angular: sigue política de deprecación antes de eliminar API públicas |
| Estabilidad prometida | Riesgo de roturas inesperadas | Versión 0.x (FastAPI) o excepciones de semver (Vue en tipos TS, Fastify en minors por LTS, Next en Maintenance LTS) obligan a fijar versiones y tener pruebas |
| Estado del repositorio | Abandono o archivado | Campo `archived` y `pushed_at` de la API de GitHub; los repositorios consultados hoy estaban activos (pushed 2026-10-12) |
| Soporte comercial para EOL | Salida si te quedas atrás | Algunos proyectos remiten a terceros para versiones EOL (HeroDevs para Express y Fastify); es coste futuro, no sustituto de migrar |

Pasos mínimos propuestos para la skill (checklist): 1) abrir la política de soporte y anotar fecha de fin de la versión que se usaría; 2) revisar avisos en GitHub Advisory Database; 3) ejecutar o consultar Scorecard; 4) leer licencia y gobernanza; 5) localizar la guía de migración de la última mayor; 6) registrar todo con fecha.

---

## 4. Encuestas de la industria (solo indicio de uso)

No miden calidad, ni salud, ni adecuación. Citar siempre con año y sesgo.

| Encuesta | Estado | Dato verificado hoy | Sesgo / límite |
|---|---|---|---|
| Stack Overflow Developer Survey 2025 (https://survey.stackoverflow.co/2025) | PARCIAL | Más de 49.000 respuestas, 177 países, 62 preguntas. Sección de tecnologías, "web frameworks" (todos los encuestados, n=23.678 en esa pregunta): Node.js 48,7%, React 44,7%, jQuery 23,4%, Next.js 20,8%, Express 19,9%, ASP.NET Core 19,7%, Angular 18,2%, Vue.js 17,6%, FastAPI 14,8%, Spring Boot 14,7% | La página de resultados no mostró la metodología de captación (hay una página aparte: NO VERIFICADO). Muestra autoseleccionada de usuarios de un sitio concreto; solo encuestados que respondieron esa pregunta. Estas cifras no se usan para rankear |
| JetBrains State of Developer Ecosystem 2025 (https://devecosystem-2025.jetbrains.com) | PARCIAL | 24.534 desarrolladores tras limpieza; encuesta de abril a junio de 2025; respuestas ponderadas por geografía, empleo, lenguajes y uso de productos JetBrains | La propia página admite posible sesgo hacia usuarios de JetBrains. No se obtuvieron datos de frameworks web: NO VERIFICADO |
| State of JS 2025 (https://2025.stateofjs.com/en-US/) | NO VERIFICADO en contenido | La portada existe pero no mostró nº de respuestas, fechas ni método de captación. La URL https://stateofjs.com/en-US superó el tamaño máximo del fetcher | Por su naturaleza (comunidad JS, autoselección) sobrerrepresenta ecosistema JavaScript; no extrapolar a otros lenguajes. Verificar a mano antes de citar cifras |

Uso permitido en la skill: "indicio de que existe comunidad y oferta de talento/documentación", no criterio de selección.

---

## 5. Tabla de decisión (necesidad -> categoría -> motivo -> contraindicación)

Los ejemplos son solo ilustración y no implican preferencia.

| Necesidad / tipo de proyecto | Categoría recomendada | Motivo | Contraindicación | Ejemplos (ilustrativos) |
|---|---|---|---|---|
| Landing de una página, sin interacción compleja | F (sin framework) o E | Menos dependencias y menos mantenimiento; la política de soporte deja de importar | Si habrá crecimiento a muchas páginas o contenido editable por no técnicos | HTML/CSS plano; Astro como generador |
| Landing o web corporativa con varias páginas, blog, SEO | A o E | HTML estático por defecto; JS solo donde hace falta | Si la web incluirá una app autenticada compleja en el mismo proyecto | Astro; SvelteKit con prerender; Nuxt o Next con exportación estática |
| Documentación o contenido que cambia con despliegues | E | Build previsible, hosting estático | Contenido por usuario sin una capa de API | Astro, VitePress (declarado por Vue como su generador estático) |
| SaaS / producto con SEO en la parte pública y panel privado | B | Un solo proyecto con rutas públicas renderizadas en servidor y rutas privadas; render híbrido por ruta | Si no se quiere operar un runtime de servidor para el frontend | Next.js, Nuxt, SvelteKit, React Router (modo framework) |
| Panel interno / herramienta tras login, sin SEO | C (SPA) o B en modo SPA | No hace falta SSR; menos infraestructura | Primera carga pública crítica | Vue o React con router; React Router o SvelteKit en modo SPA |
| Aplicación grande, muchos desarrolladores, vida de años | D | Convenciones cerradas, CLI y migraciones automatizadas, ventanas de soporte publicadas | Equipo de 1-2 personas o proyecto corto | Angular; en backend NestJS |
| API pura para SPA/móvil/terceros, contrato OpenAPI importante | I | Validación y documentación derivadas de tipos | Si también habrá vistas HTML y admin: faltan piezas integradas | FastAPI; ASP.NET Core minimal APIs |
| SaaS o aplicación de gestión con base relacional, auth, admin, correo, colas | H | Menos decisiones y más piezas integradas; plazo corto | Servicio mínimo; equipos sin experiencia en el lenguaje | Django, Rails, Laravel, Spring Boot, ASP.NET Core, Phoenix |
| Microservicio o API pequeña con equipo que domina el lenguaje | G | Superficie pequeña, pocas dependencias | Si crece sin convenciones: duplicación de auth/validación | Express, Fastify, Hono, Go net/http |
| Tiempo real con mucha concurrencia (chat, presencia) | H con soporte nativo, o G con WebSockets | Primitivas integradas reducen piezas | Equipo sin experiencia en la plataforma | Phoenix (canales, LiveView) |
| Ejecución en borde o múltiples runtimes (Workers, Deno, Bun, Node) | G basado en Web Standards | Mismo código en varios runtimes | Política de soporte no publicada: requiere fijar versiones | Hono |
| MVP sin equipo de backend, reglas de acceso simples | J (BaaS) | Menos operaciones | Lógica compleja, portabilidad y residencia de datos estrictas | No verificados |
| Equipo con un lenguaje dominante (Java, C#, PHP, Python, Ruby, Elixir, Go) | Categoría H/G/I dentro de ese lenguaje | El coste de conocimiento domina al coste del framework | Elegir lenguaje distinto solo por moda | Ver sección 2 |
| Requisito de larga vida con pocas migraciones | Preferir proyectos con LTS largo y guía de migración | Menor coste de mantenimiento | Proyectos 0.x o sin política publicada | Django LTS, .NET LTS, Angular, Laravel |

Regla para la skill: primero lenguaje/habilidades del equipo y modo de renderizado necesario; después categoría; después el ejemplo, validado con la sección 3.

---

## 6. Datos volátiles (fecha de verificación 2026-10-12)

| Dato | Valor visto hoy | URL oficial |
|---|---|---|
| Next.js | 16.x Active LTS, 15.x Maintenance LTS | https://nextjs.org/support-policy |
| Angular | 22 activa (2026-06-03); 21 y 20 LTS; 20 LTS hasta 2026-11-28 | https://angular.dev/reference/releases |
| Astro | Mayor 7.x (7.3.8); seguridad-only para una mayor anterior | https://docs.astro.build/en/upgrade-astro/ |
| React Router | 8.4.0 última; 7.18.4 y 6.30.6 listadas | https://reactrouter.com |
| Vue | Sin ciclo fijo; Vue 2 EOL (banner) | https://vuejs.org/about/releases |
| Express | v5 y v4 listadas vigentes; solo la última de cada línea | https://expressjs.com/en/support/ |
| Fastify | v5 (2024-09-17), fin de LTS TBD; v4 terminó 2025-06-30 | https://fastify.dev/docs/latest/Reference/LTS/ |
| NestJS | Guía de migración v11 a v12 publicada | https://docs.nestjs.com/migration-guide |
| Django | 5.2 LTS (extendido hasta abril 2028), 6.0, 6.1; 6.2 LTS abril 2027 | https://www.djangoproject.com/download/ |
| Rails | 8.1.x y 8.0.x en soporte (fechas según resumen) | https://rubyonrails.org/maintenance |
| Laravel | 12 y 13; seguridad 12 hasta 2027-02-24 | https://laravel.com/docs/master/releases |
| Spring Boot | 4.1.1 última; fechas por versión no vistas en oficial | https://spring.io/projects/spring-boot |
| .NET | 10 LTS hasta 2028-11-14; 8 y 9 hasta 2026-11-10 | https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core |
| Phoenix | 1.8.15 | https://phoenix.hexdocs.pm/overview.html |
| Go | 1.27.2 y 1.26.9 (2026-10-08) soportadas | https://go.dev/doc/devel/release |
| Node.js | 26 Current; 24 y 22 LTS | https://nodejs.org/en/about/previous-releases |
| Scorecard | versión v5.5.0 en resultados de hoy; 18 checks | https://github.com/ossf/scorecard |

Cambios de licencia, deprecaciones y adquisiciones: no se auditó el histórico de ningún proyecto; NO VERIFICADO. La skill debe consultar los comunicados oficiales de cada candidato.

---

## 7. Fuentes y estado

| Fuente | Estado |
|---|---|
| Context7 resolve-library-id: Astro, Next.js, Nuxt, SvelteKit, React Router, Angular, Vue, Express, Fastify, NestJS, Hono, Django, FastAPI, Rails, Laravel, Spring Boot, ASP.NET Core, Phoenix, Go | VERIFICADO (todos resueltos con reputación alta). Context7 puede ir por detrás de la web oficial (Astro) |
| Context7 query-docs de cada uno (alcance y migración) | VERIFICADO salvo Rails (no se ejecutó query-docs) |
| nextjs.org/support-policy | VERIFICADO |
| angular.dev/reference/releases | VERIFICADO |
| vuejs.org/about/releases; v2.vuejs.org | VERIFICADO (sin ventanas de soporte; sin fecha de EOL en la página) |
| nuxt.com política de releases | NO VERIFICADO (404 en dos URLs) |
| docs.astro.build/en/upgrade-astro | VERIFICADO |
| svelte.dev/docs/kit | PARCIAL |
| reactrouter.com/start/modes | VERIFICADO (sin política de soporte) |
| expressjs.com/en/support | VERIFICADO |
| fastify.dev LTS | VERIFICADO |
| docs.nestjs.com | PARCIAL (sin política de soporte) |
| hono.dev | PARCIAL (sin política) |
| djangoproject.com/download y /foundation | VERIFICADO |
| fastapi.tiangolo.com/deployment/versions | VERIFICADO |
| rubyonrails.org/maintenance | VERIFICADO (resumen de la página) |
| laravel.com/docs/master/releases | VERIFICADO |
| spring.io/support-policy y spring.io/projects/spring-boot | PARCIAL (reglas sí; tabla de fechas no); endoflife.date solo como tercero |
| dotnet.microsoft.com política .NET | VERIFICADO |
| phoenix.hexdocs.pm | PARCIAL (sin política de soporte) |
| go.dev/doc/devel/release | VERIFICADO |
| nodejs.org previous-releases | VERIFICADO |
| scorecard.dev, github.com/ossf/scorecard, api.scorecard.dev (express, django) | VERIFICADO |
| docs.github.com (Advisory Database, repository security advisories, security features) | VERIFICADO |
| github.com/withastro/.github GOVERNANCE.md | VERIFICADO |
| api.github.com (licencias, archivado) | VERIFICADO para Next.js y Astro; no consultado para el resto |
| Stack Overflow Survey 2025 | PARCIAL |
| JetBrains Ecosystem 2025 | PARCIAL |
| State of JS 2025 | NO VERIFICADO (contenido) |
| React (react.dev), BaaS concretos, política de soporte de Nuxt, SvelteKit, Hono, NestJS, Phoenix, React Router | NO VERIFICADO |

---

## 8. Resumen final (qué cambiaría la recomendación de la skill)

1. Decidir por categoría y modo de renderizado necesario, no por el nombre del framework; muchos cubren varias categorías.
2. El lenguaje y la experiencia del equipo pesan más que la categoría; cambiarlos exige justificación.
3. Un proyecto sin política de soporte publicada, o en 0.x (p. ej. FastAPI), obliga a fijar versiones y tener pruebas: sube el riesgo, no lo descarta.
4. Si la vida esperada supera la ventana de soporte de la mayor elegida (Next 2 años, Rails 2 años de seguridad, Laravel 2 años), el coste de migración debe entrar en la decisión.
5. LTS largo con guía de migración automatizada (Django, .NET, Angular) reduce coste de mantenimiento en proyectos longevos.
6. Dependencia de una sola empresa (gobernanza) o licencia con NOASSERTION en la API exige leer LICENSE y GOVERNANCE a mano.
7. Scorecard y avisos de seguridad son indicios con límites declarados; un -1 es "no evaluable" y cero avisos no prueba seguridad.
8. Una landing simple no necesita framework de aplicación: sin framework o generador estático minimiza mantenimiento.
9. Las encuestas solo indican uso, con sesgo de muestra; nunca criterio de selección.
10. Todo número de versión o fecha de soporte caduca: re-verificar en la URL oficial el día de la decisión.
11. Lo que cambiaría esta recomendación: un requisito de portabilidad o residencia de datos (descarta BaaS), tiempo real intensivo, ejecución en borde, o un equipo con un lenguaje dominante.
12. Pendiente de verificar antes de usar la skill: Nuxt, SvelteKit, Hono, NestJS y Phoenix (política de soporte), React, BaaS, y las cifras de State of JS.
