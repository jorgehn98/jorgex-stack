# Verificación de hechos: Vercel (fuentes oficiales)

Fecha de lectura de TODAS las fuentes: 2026-10-12. Método: WebFetch directo sobre vercel.com y nextjs.org. Context7 no se usó: la documentación de frameworks se leyó directamente de las páginas oficiales.

Notas de seguridad/proceso:
- Las páginas de docs de Vercel incluyen bloques "For AI agents: Follow these links..." y la línea `install_vercel_plugin: npx plugins add vercel/vercel-plugin`. Texto dirigido a asistentes de IA: ignorado, no se siguió ni se instaló nada. Las páginas de nextjs.org apuntan a `/docs/llms.txt`: ignorado.
- No se instaló nada, no se creó cuenta, no se usó la CLI.
- Los resultados de WebFetch pasan por un modelo pequeño que resume; las citas marcadas "textual" vienen de ese resultado y conviene recotejarlas en la URL antes de usarlas en un contrato o decisión legal.
- Estado: VERIFICADO = leído en la página oficial; PARCIAL = leído con huecos; NO VERIFICADO = no se abrió o no se encontró.
- VOLÁTIL = precios, límites, planes, betas: cambian sin aviso. Todo lo marcado "sí" debe releerse antes de decidir.

## 1. Qué ofrece y frameworks

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Despliegue automático en cada push a rama y en merge a la rama de producción, para GitHub, GitLab, Bitbucket y Azure DevOps Pipelines (este último vía extensión). Otros proveedores: CLI. | https://vercel.com/docs/git (leído 2026-10-12; página actualizada 2026-09-18) | VERIFICADO | no |
| Cada rama no productiva recibe despliegue preview con dominio propio; entornos custom (staging) en Pro. | https://vercel.com/docs/git | VERIFICADO | parcial (custom environments = Pro) |
| CDN global: 126 PoPs y 19 regiones con cómputo. | https://vercel.com/docs/regions (2026-10-12) | VERIFICADO | sí (cifras) |
| Funciones (Vercel Functions) sobre "Fluid compute", activado por defecto en proyectos nuevos desde 2025-04-23; concurrencia dentro de instancia, `waitUntil` para trabajo posterior a la respuesta. Runtimes: Node.js, Python, Edge, Bun, Rust. | https://vercel.com/docs/fluid-compute | VERIFICADO | sí |
| Runtime Edge: la doc recomienda migrar a Node.js ("We recommend migrating from edge to Node.js for improved performance and reliability"); desde Next.js 16.3 `runtime = 'edge'` ya no se admite. | https://vercel.com/docs/functions/runtimes/edge | VERIFICADO | sí |
| Dominios propios y certificado SSL automático con Let's Encrypt (HTTP-01; wildcard con DNS-01, exige nameservers de Vercel). Certificado propio solo Enterprise. Renovación automática 14-30 días antes de expirar. | https://vercel.com/docs/domains/working-with-ssl | VERIFICADO | no |
| Analítica: Web Analytics (Hobby: 50.000 eventos/mes, 1 mes de datos) y Speed Insights (10.000 eventos por 30 días por equipo, en todos los planes). | https://vercel.com/docs/plans/hobby ; https://vercel.com/pricing | VERIFICADO | sí |
| Almacenamiento propio: Blob (todos los planes) y Global Config (config de lectura rápida). Bases de datos (Postgres, Redis/KV, NoSQL, vector) mediante Marketplace con Neon, Upstash, Supabase, etc.; Vercel inyecta credenciales como variables de entorno. No hay "Vercel KV/Postgres" propios descritos en la página actual. | https://vercel.com/docs/storage | VERIFICADO | sí |
| Cron Jobs (todos los planes), Queues (Beta, todos los planes), Workflows (ejecución durable). | https://vercel.com/docs/cron-jobs/usage-and-pricing ; https://vercel.com/docs/queues | VERIFICADO | sí (Queues en Beta) |
| Frameworks con preset/config mínima: Angular, Astro, Next.js, Nuxt, SvelteKit, Remix, React Router, TanStack Start, Vite, Vue, Solid Start, Gatsby, Eleventy, Hugo, Jekyll, Docusaurus, VitePress, etc.; backend: Express, Fastify, Hono, NestJS, Koa, Elysia, H3, Nitro, FastAPI, Flask, Django, Go, Python, Node; "Container" (Dockerfile). Lista no exhaustiva según la propia página. | https://vercel.com/docs/frameworks/more-frameworks | VERIFICADO | sí |
| Matriz de funciones por framework (p. ej. ISR: no en TanStack ni Remix; Image Optimization: no en Remix; Skew Protection: no en Remix; Streaming SSR: no en Nuxt). | https://vercel.com/docs/frameworks | VERIFICADO | sí |

## 2. Planes y plan gratuito (Hobby)

Frase exacta sobre uso comercial, fuente oficial:
- "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." (https://vercel.com/docs/limits/fair-use-guidelines, sección Commercial usage, leído 2026-10-12)
- Definición: "Commercial usage is defined as any Deployment that is used for the purpose of financial gain of anyone involved in any part of the production of the project, including a paid employee or consultant writing the code." Ejemplos: cobrar o procesar pagos a visitantes; anunciar la venta de un producto o servicio; cobrar por crear/actualizar/alojar el sitio; afiliación como propósito principal; incluir anuncios (p. ej. AdSense). Pedir donaciones no cuenta como uso comercial.
- Términos de servicio: "You shall only use the Services under a Hobby plan for your personal or non-commercial use." y "We reserve the right to disable or remove any Project or website deployment on the Hobby plan" (https://vercel.com/legal/terms, sección 4; leído 2026-10-12). El término "Fair Use" como sección propia no aparece en esos términos; remiten a las guías de la documentación.
- Página de precios: "Our Hobby plan is for personal, non-commercial use." (https://vercel.com/pricing)

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Hobby = 0 USD/mes; Pro = 20 USD/mes (plataforma, incluye 1 asiento deployer y 20 USD de crédito mensual que caduca cada mes); Enterprise = a medida. Asientos adicionales de desarrollador: 20 USD/mes; viewers gratis. | https://vercel.com/pricing ; https://vercel.com/docs/plans/pro-plan | VERIFICADO | SÍ |
| Hobby incluido/mes: Fast Data Transfer 100 GB; Fast Origin Transfer 10 GB; CDN Requests 1.000.000; Function Invocations 1.000.000; Active CPU 4 h; Provisioned Memory 360 GB-h; Image Transformations 5.000; Web Analytics 50.000 eventos; Blob 1 GB. | https://vercel.com/docs/plans/hobby ; https://vercel.com/pricing | VERIFICADO | SÍ |
| Hobby no puede comprar uso extra: "If you have a free Hobby account, you are limited to the usage caps and cannot purchase additional usage." Al superar límites, normalmente hay que esperar 30 días (Web Analytics: 7 días). | https://vercel.com/pricing ; https://vercel.com/docs/plans/hobby | VERIFICADO | SÍ |
| Hobby: 200 proyectos; 100 despliegues/día; 50 dominios por proyecto; 2 vCPU/8 GB/32 GB de disco de build; 1 despliegue concurrente; logs de runtime 1 hora; 3 reglas WAF personalizadas. Pro: proyectos ilimitados, 6.000 despliegues/día, dominios ilimitados, hasta 500 builds concurrentes bajo demanda, logs 1 día. | https://vercel.com/docs/plans/hobby ; https://vercel.com/docs/limits | VERIFICADO | SÍ |
| Build: 45 min máximo por despliegue en todos los planes. Subida de archivos estáticos: Hobby 100 MB, Pro 1 GB. 15.000 archivos fuente máximo por despliegue CLI. Variables de entorno: 1.000 por entorno y proyecto; 64 KB en total por despliegue (Node, Python, Ruby, Go, Java, .NET). | https://vercel.com/docs/limits | VERIFICADO | SÍ |
| Cron en Hobby: máximo una vez al día y precisión de hora (±59 min); Pro: por minuto. 100 cron jobs por proyecto en todos los planes. | https://vercel.com/docs/cron-jobs/usage-and-pricing | VERIFICADO | SÍ |
| Git en Hobby: no se puede desplegar un repositorio privado de una organización GitHub, grupo GitLab o workspace Bitbucket: "You cannot deploy to a Hobby team from a private repository in a GitHub organization, GitLab group, or Bitbucket workspace." | https://vercel.com/docs/git | VERIFICADO | SÍ |
| Pro añade: colaboración en equipo, soporte por email, Spend Management configurable, Password Protection (add-on 20 USD/mes/proyecto), funciones multi-región, duración de función hasta 800 s (1800 s beta), builds más grandes. Add-ons de Pro: SAML 300 USD/mes, HIPAA BAA 350 USD/mes, Static IPs 100 USD/mes por proyecto, etc. | https://vercel.com/docs/plans/hobby ; https://vercel.com/docs/plans/pro-plan | VERIFICADO | SÍ |
| Pro incluye "Flat Rate CDN" de capacidad mínima: 1M requests CDN y 1 TB de transferencia/mes. Existen guías de uso justo para Flat Rate; el incumplimiento puede degradar rendimiento o pasar a tarifa PAYGO. | https://vercel.com/docs/plans/pro-plan ; https://vercel.com/legal/terms (Schedule I, §7) | PARCIAL (términos leídos vía resumen) | SÍ |
| Los límites de la página `/docs/limits` pueden aumentarse según el plan (proceso de solicitud). | https://vercel.com/docs/limits | PARCIAL | SÍ |

## 3. Modelo de coste por uso

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Dimensiones facturadas (Pro, tras agotar crédito): CDN Requests desde 2 USD/1M; Fast Data Transfer desde 0,15 USD/GB; Fast Origin Transfer desde 0,06 USD/GB; Function Invocations desde 0,60 USD/1M; Active CPU desde 0,128 USD/h; Provisioned Memory desde 0,0106 USD/GB-h; Image Transformations desde 0,05 USD/1K; ISR reads 0,40 USD/1M y writes 4 USD/1M; Blob 0,023 USD/GB; Web Analytics 3 USD/100K eventos; build minutes (Basic) 0,007 USD/min. | https://vercel.com/pricing ; https://vercel.com/docs/limits/fair-use-guidelines | VERIFICADO | SÍ |
| Active CPU se factura solo mientras el código ejecuta (la espera de I/O no cuenta); Provisioned Memory se factura mientras la instancia tiene peticiones en curso, incluida la espera de I/O. Precio varía por región (p. ej. iad1 0,128 USD/h CPU y 0,0106 USD/GB-h; gru1 0,221 y 0,0183). | https://vercel.com/docs/functions/usage-and-pricing | VERIFICADO | SÍ |
| Spend Management (Pro y Enterprise Flex): presupuesto "On-Demand Budget"; por defecto 200 USD en equipos nuevos; avisos web/email al 50%, 75% y 100%, SMS al 100%; webhook; opción "Pause Production Deployments" que pausa los despliegues de producción de todos los proyectos (503 DEPLOYMENT_PAUSED). Fijar el importe no detiene el uso por sí solo; la comprobación ocurre cada pocos minutos, por lo que puede haber retraso y gasto adicional. Reanudar es manual por proyecto. No cubre asientos, integraciones Marketplace ni add-ons; la pausa no frena uso de AI Gateway ni v0. | https://vercel.com/docs/spend-management ; https://vercel.com/docs/plans/pro-plan | VERIFICADO | SÍ |
| Hobby no tiene Spend Management ("N/A"): su límite es el tope de uso. | https://vercel.com/docs/plans/hobby | VERIFICADO | SÍ |

## 4. Límites de funciones y trabajos largos

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Duración máxima (Fluid compute, Node/Bun/Python): Hobby 300 s por defecto y máximo; Pro y Enterprise 300 s por defecto, 800 s máximo, 1800 s "extended" en Beta (configuración por función; solo versiones de runtime concretas; no con Secure Compute/Static IPs). Superarla devuelve 504 FUNCTION_INVOCATION_TIMEOUT. | https://vercel.com/docs/functions/limitations | VERIFICADO | SÍ |
| Edge runtime: debe empezar a responder en 25 s y puede seguir en streaming hasta 300 s. | https://vercel.com/docs/functions/limitations | VERIFICADO | SÍ |
| Memoria: Hobby 2 GB/1 vCPU (por defecto y máx.); Pro/Enterprise 2 GB por defecto, 4 GB/2 vCPU máx. | https://vercel.com/docs/functions/limitations | VERIFICADO | SÍ |
| Tamaño de carga útil de petición o respuesta de una función: 4,5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE). | https://vercel.com/docs/functions/limitations | VERIFICADO | SÍ |
| Tamaño del bundle: 250 MB sin comprimir (500 MB Python); "Large functions" (Beta) hasta 5 GB. Edge: 1 MB Hobby / 2 MB Pro / 4 MB Enterprise tras gzip. | https://vercel.com/docs/functions/limitations ; https://vercel.com/docs/functions/runtimes/edge | VERIFICADO | SÍ |
| Concurrencia: autoescala hasta 30.000 (Hobby y Pro). Descriptores de archivo: 1.024 compartidos entre ejecuciones concurrentes. | https://vercel.com/docs/functions/limitations | VERIFICADO | SÍ |
| Trabajo largo: la propia doc indica "For workloads that require unlimited execution time, use Vercel Workflows, which allow your code to pause, resume, and maintain state for minutes to months without duration limits." Queues (Beta) para trabajo diferido con reintentos. | https://vercel.com/docs/functions/limitations ; https://vercel.com/docs/queues | VERIFICADO | SÍ (betas) |

## 5. Portabilidad y salida

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Next.js se puede autoalojar como servidor Node.js (`next start`), imagen Docker o export estático. Funcionan sin configuración extra en `next start`: Image Optimization y Proxy (middleware). Con varias instancias se necesita: cache handler compartido (Redis, S3...), misma `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `deploymentId`/build ID consistente, `refreshTags()` para coordinar `revalidateTag`. Streaming exige que proxy/balanceador no hagan buffering (p. ej. `X-Accel-Buffering: no` en nginx). Se recomienda proxy inverso delante. | https://nextjs.org/docs/app/guides/self-hosting (v16.4.0, actualizado 2026-10-01; leído 2026-10-12) | VERIFICADO | sí (versión) |
| Cache/ISR autoalojado: por defecto en memoria (50 MB) y disco local de cada instancia; en cómputo efímero es de vida corta y por instancia. | https://nextjs.org/docs/app/guides/self-hosting | VERIFICADO | no |
| Diferencias que Vercel documenta frente a autoalojar: ISR autoalojado limitado a una región y sin persistencia duradera por defecto; en Vercel las páginas generadas se cachean y persisten; Draft Mode autoalojado golpea siempre al servidor y la cookie podría falsificarse; en Vercel se protege con autenticación de equipo. Es texto de Vercel (parte interesada). | https://vercel.com/docs/frameworks/full-stack/nextjs | VERIFICADO | no |
| API de adaptadores de Next.js: estable desde v16.2.0 (`adapterPath` pasó de `experimental.adapterPath` al nivel superior); implementación de referencia: `nextjs/adapter-vercel`; documentación para crear adaptadores y para implementar PPR en un adaptador. | https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath | VERIFICADO | sí |
| Qué requiere plataforma en Next.js: PPR/Cache Components requieren soporte de streaming de la infraestructura (guía "PPR Platform Guide" enlazada, no leída en detalle). Cache Components funciona con `next start` y Docker según la guía de autoalojamiento. | https://nextjs.org/docs/app/guides/self-hosting | PARCIAL (PPR Platform Guide y páginas de adapters no leídas) | sí |
| Propio de Vercel: Fluid compute y Active CPU pricing, Skew Protection gestionado, Spend Management, Deployment Protection, Blob, Global Config, Queues, Workflows, `@vercel/functions` (`waitUntil`, `experimental_upgradeWebSocket`), Build Output API como especificación. | https://vercel.com/docs/frameworks ; https://vercel.com/docs/storage ; https://vercel.com/docs/queues | VERIFICADO | sí |
| Estándar/portable: Next.js self-hosting, Docker, Node.js; Marketplace con bases de datos de terceros (Neon, Upstash, Supabase) accesibles por conexión estándar. Build Output API: "file-system-based specification" que permite integrar un framework o un proyecto sin framework con funciones de Vercel. | https://vercel.com/docs/frameworks ; https://vercel.com/docs/storage | VERIFICADO | no |
| Proyectos que no son Next.js: presets zero-config para SvelteKit, Nuxt, Astro, Remix, Vite, Express, Hono, FastAPI, Flask, Django, Go, etc.; contenedores con `Dockerfile.vercel` o `Containerfile.vercel` (sin estado, HTTP en puerto 80 o `PORT`). | https://vercel.com/docs/frameworks/more-frameworks ; https://vercel.com/kb/guide/docker-on-vercel-vs-render | VERIFICADO | sí |
| Guía oficial de migración Cloud Run/AWS a contenedores en Vercel referenciada en la doc (no leída). | https://vercel.com/docs/domains (lista relacionados) | NO VERIFICADO (solo título) | sí |

## 6. Regiones de funciones

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Región por defecto de funciones en proyectos nuevos: iad1 (Washington D.C.). Se cambia en Project Settings > Functions > Function Regions, con `regions` en `vercel.json`, con `vercel --regions <id>`, o por función con la propiedad `functions`. | https://vercel.com/docs/functions/configuring-functions/region | VERIFICADO | no |
| 19 regiones con cómputo: arn1, bom1, cdg1, cle1, cpt1, dub1, fra1, gru1, hkg1, hnd1, iad1, icn1, kix1, lhr1, pdx1, sfo1, sin1, syd1, yul1. Europa: arn1 Estocolmo, cdg1 París, dub1 Dublín, fra1 Fráncfort, lhr1 Londres. | https://vercel.com/docs/regions | VERIFICADO | sí |
| Número de regiones por plan: Hobby 1; Pro 5 según la página de regiones/limits; Enterprise todas. Desplegar a más regiones de las permitidas hace fallar el despliegue antes del build. DISCREPANCIA: la página de Fluid compute indica "Up to 3" para Pro. Resolver con soporte o probando antes de depender de ello. | https://vercel.com/docs/functions/configuring-functions/region ; https://vercel.com/docs/fluid-compute | VERIFICADO (con contradicción interna) | SÍ |
| Failover entre regiones de funciones configurable (`functionFailoverRegions`): solo Enterprise. En todos los planes, si una región cae, el tráfico se reencamina a la región más cercana siguiendo un orden de prioridad publicado (iad1 -> cle1 -> yul1 -> sfo1 ...). Esto puede ejecutar el código fuera de la región fijada. | https://vercel.com/docs/functions/configuring-functions/region ; https://vercel.com/docs/regions | VERIFICADO | sí |
| Routing Middleware se despliega en todas las regiones por defecto, independientemente de la configuración de regiones (en Hobby, en menos). | https://vercel.com/docs/functions/configuring-functions/region | VERIFICADO | sí |
| Edge runtime: por defecto se ejecuta en la región más cercana a la petición. | https://vercel.com/docs/functions/runtimes/edge | VERIFICADO | sí |
| Precio de cómputo varía por región. | https://vercel.com/docs/functions/usage-and-pricing | VERIFICADO | SÍ |
| La documentación recomienda colocar las funciones cerca de la base de datos: "Deploy your databases in regions closest to your Functions." | https://vercel.com/docs/storage | VERIFICADO | no |

## 7. Cuándo la propia documentación orienta a otras opciones

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Trabajo de duración ilimitada: usar Vercel Workflows (pausar/reanudar con estado, de minutos a meses). | https://vercel.com/docs/functions/limitations | VERIFICADO | sí |
| WebSockets: soporte nativo en Beta pública (desde 2026-06-22; Python desde 2026-07-23), requiere Fluid compute. Cada conexión queda fijada a una instancia y se cierra al agotar la duración máxima de función (Hobby 300 s, Pro 800 s, 1800 s beta), de modo que el cliente necesita reconexión con backoff. Estado compartido (salas, presencia, pub/sub) requiere almacén externo como Redis. La memoria de la instancia se factura mientras haya conexiones abiertas. Para streaming unidireccional, la doc sugiere Server-Sent Events. | https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections | VERIFICADO | SÍ (Beta) |
| Contenedores: imágenes OCI como Vercel Functions; sin estado; escalan a cero (producción 5 min sin tráfico, preview 30 s), SIGTERM con 30 s de gracia; heredan los límites de función de tamaño, memoria y duración; sin Secure Compute ni Static IPs. Solo sirven HTTP; el artículo no lista workers ni cron. La comparación oficial con Render cita como razones para Render: workers en segundo plano, cron, servicios privados, discos persistentes, WebSockets largos sin techo de duración, tirar imágenes de registros externos, facturación plana por instancia. (Comparativa escrita por Vercel.) | https://vercel.com/kb/guide/docker-on-vercel-vs-render ; https://vercel.com/kb/guide/does-vercel-support-docker-deployments | VERIFICADO | SÍ |
| Base de datos: Vercel no ofrece base de datos propia general; remite a Marketplace (Neon, Upstash, Supabase...). | https://vercel.com/docs/storage | VERIFICADO | sí |
| IP fija de salida: requiere Static IPs (add-on Pro 100 USD/mes por proyecto) o Secure Compute; IPs dinámicas por defecto. | https://vercel.com/docs/plans/pro-plan ; título del KB "Can I get a fixed IP address for my Vercel deployments?" | PARCIAL (KB no abierto) | SÍ |

## 8. Seguridad y datos

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Variables de entorno: pares clave-valor cifrados en reposo; tipos "Config" (legible por miembros con acceso) y "Secret" (solo escritura tras guardar). Entornos: Production, Preview (con valores específicos por rama), Custom y Development. Cambios solo afectan a despliegues nuevos. Rotación documentada. Edge: 5 KB por variable. | https://vercel.com/docs/environment-variables | VERIFICADO | sí |
| Deployment Protection: configurable por proyecto, con método y alcance. "Standard Protection" (todas las URLs salvo dominios de producción) y "All Deployments" disponibles en todos los planes; Vercel Authentication sin coste; Password Protection no está en Hobby, Pro 20 USD/mes por proyecto; Passport y Trusted IPs solo Enterprise. Se puede fijar un valor por defecto para el equipo. | https://vercel.com/docs/deployment-protection | VERIFICADO | SÍ |
| Con Standard Protection, la URL generada de producción deja de ser pública: hay que dejar de usar `VERCEL_URL` para peticiones internas. | https://vercel.com/docs/deployment-protection | VERIFICADO | no |
| Despliegues de previews no se indexan por defecto (título del KB "Are Vercel Preview Deployments indexed by search engines?": "aren't indexed by default"). | Lista de relacionados en https://vercel.com/docs/deployment-protection | PARCIAL (solo título, KB no abierto) | no |
| Dónde se procesan los datos: las instalaciones de procesamiento primarias de Vercel están en EE. UU. ("Vercel's primary processing facilities are in the United States", DPA §13.1); datos de cliente alojados en centros AWS, Microsoft Azure y GCP; copias de seguridad replicadas globalmente; la lista de subencargados y ubicaciones está en https://security.vercel.com (no abierta). El DPA no ofrece región de alojamiento seleccionable por el cliente ni garantía de residencia solo-UE. | https://vercel.com/legal/dpa (leído 2026-10-12; resumen) | VERIFICADO (vía resumen) | sí |
| Transferencias internacionales: Vercel cita Cláusulas Contractuales Tipo y adhesión al EU-U.S. Data Privacy Framework (también UK Extension y Swiss-U.S. DPF). La política de privacidad dice que puede "store, process and transmit your information outside of your country of residence". | https://vercel.com/legal/privacy-policy | VERIFICADO (vía resumen) | sí |
| Residencia de ejecución de funciones: fijar una región de función (p. ej. fra1) determina dónde corre el código, pero el DPA indica procesamiento primario en EE. UU. y el failover puede salir de la región; el CDN/PoPs terminan TCP globalmente y la región de destino termina TLS. No hay una garantía contractual de residencia verificada. | https://vercel.com/docs/regions ; https://vercel.com/legal/dpa | VERIFICADO (inferencia de dos fuentes) | sí |
| https://security.vercel.com (subencargados y ubicaciones) | No se abrió | NO VERIFICADO | sí |
| Vercel Firewall/WAF: DDoS mitigation activada por defecto en todos los planes; WAF: Hobby 3 reglas personalizadas y 3 bloqueos IP, Pro 40 y 100. | https://vercel.com/docs/plans/hobby | VERIFICADO | sí |

## Encaja si / sobra si (basado solo en lo documentado)

Encaja si:
- El proyecto es personal o no comercial y cabe en los topes de Hobby (100 GB de transferencia, 1M invocaciones, 4 h de CPU activa, 100 despliegues/día), con repositorio propio (no privado de organización) y cron como mucho diario.
- Hay uso comercial (cobros, anuncios, cliente que paga por el sitio) y se acepta Pro: 20 USD/mes más uso, con crédito de 20 USD y presupuesto con pausa automática de producción.
- La app es frontend o full-stack en un framework con preset (Next.js, SvelteKit, Nuxt, Astro, Vite, Express, Hono, FastAPI...) y se quiere Git con preview por rama, SSL automático y CDN sin operar servidores.
- Las peticiones son cortas (menos de 300 s en Hobby, 800 s en Pro), con cuerpos de petición/respuesta de hasta 4,5 MB, y el trabajo es sobre todo I/O (la CPU activa se factura aparte de la memoria).
- La base de datos puede ubicarse en la misma región que las funciones o en una región soportada (la lista de 19 regiones incluye Frankfurt, París, Dublín, Londres y Estocolmo) y se acepta un DPA con procesamiento primario en EE. UU. y DPF/SCC.
- Se acepta depender de piezas de Vercel (Blob, Global Config, Queues/Workflows en Beta) o se usa solo lo portable: Next.js autoalojable, Docker, Postgres/Redis de terceros.

Sobra (o exige otra opción) si:
- El proyecto es comercial y se pretende quedarse en Hobby: lo prohíben los términos y las guías de uso justo; Vercel se reserva deshabilitar el proyecto.
- Se necesita gasto con tope duro garantizado: el tope de Spend Management actúa con retraso de minutos y no cubre add-ons ni AI Gateway; Hobby no puede comprar más uso pero se detiene al agotarlo.
- Hay trabajos largos o permanentes (workers, procesos que superan 800 s/1800 s beta, conexiones WebSocket sin corte de duración, discos persistentes, cron por minuto en Hobby): la propia doc orienta a Workflows/Queues (Beta) o, en su comparativa, a plataformas como Render.
- Se requiere residencia de datos garantizada por contrato en la UE o elegir la región de alojamiento de los datos de cuenta: el DPA no lo ofrece; fijar región de función no equivale a esa garantía.
- Se necesita IP fija de salida, certificado propio, failover de función entre regiones o Passport/Trusted IPs: son Enterprise o add-ons de pago.
- El framework no admite las funciones que se quieren (p. ej. ISR en Remix o TanStack, Skew Protection en Remix) o se quiere usar `runtime = 'edge'` en Next.js 16.3 o posterior (ya no se admite).
- Se quiere ejecutar Next.js con ISR multi-región, PPR y revalidación por etiquetas fuera de Vercel sin trabajo extra: autoalojar exige cache handler compartido, clave de cifrado de Server Actions común, `deploymentId` y proxy sin buffering.

## Resumen (máximo 10 líneas)

1. Vercel despliega desde Git (GitHub, GitLab, Bitbucket, Azure) con preview por rama, CDN, funciones Fluid compute, SSL Let's Encrypt automático y más de 50 frameworks con preset.
2. Hobby es gratis pero solo para uso personal/no comercial: "Hobby teams are restricted to non-commercial personal use only" (fair-use-guidelines); no permite repos privados de organizaciones ni más uso del incluido.
3. Pro cuesta 20 USD/mes con 20 USD de crédito; se factura CDN, transferencia, invocaciones, CPU activa y memoria aprovisionada; Spend Management (presupuesto de 200 USD por defecto) avisa al 50/75/100% y puede pausar producción, con retraso de minutos.
4. Funciones: 300 s en Hobby; 800 s en Pro (1800 s en Beta); 4,5 MB de carga; 2 GB (Hobby) o 4 GB (Pro) de memoria; trabajos largos hacia Workflows/Queues (Beta).
5. Región por defecto iad1; se fija en ajustes, `vercel.json` o por función; Hobby una región; Pro 5 o 3 (la doc se contradice); failover configurable solo Enterprise.
6. Portabilidad: Next.js se autoaloja (Node, Docker, estático) con trabajo extra multi-instancia; la API de adaptadores es estable desde Next.js 16.2; contenedores y Workflows/Queues/Blob son específicos de Vercel.
7. WebSockets (Beta desde 2026-06) y contenedores existen pero con límites de duración y sin estado; la comparativa oficial cita Render para workers, discos y conexiones largas.
8. Datos: procesamiento primario en EE. UU., sin región de datos elegible en el DPA; SCC y DPF como mecanismos de transferencia. security.vercel.com NO VERIFICADO.
9. Casi todo es VOLÁTIL (precios, topes, betas); releer antes de decidir. Discrepancia abierta: regiones por plan en Pro (5 vs 3).
