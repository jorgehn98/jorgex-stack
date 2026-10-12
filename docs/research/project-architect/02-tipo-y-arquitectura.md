# 02-tipo-y-arquitectura — borrador

Fuentes: informes/arq-renderizado.md, arq-estilos-sistema.md, arq-tipos-proyecto.md (investigación propia con fuentes oficiales y Fowler; sin material de terceros adaptado). Estado: borrador pendiente de revisión.
Regla de la fase: dar criterios, no recetas. Lo volátil (versiones, nombres de funciones, límites, políticas de tiendas) va enlazado a su fuente oficial con fecha; no se escribe en el cuerpo de la skill.

## Entrada
Brief (01): tipo, usuarios, escala, datos, funcionalidades que fuerzan arquitectura, equipo, restricciones, stack existente (o "ninguno").

## Decisión A: tipo de proyecto y plataforma de destino
Clasificar con cinco preguntas, en orden:
1. ¿Quién consume el resultado? (público anónimo, clientes con cuenta, personal interno, máquinas)
2. ¿Quién cambia el contenido y cada cuánto? (decide archivos, CMS o base de datos)
3. ¿Qué obliga a salir del navegador? (hardware sin API web fiable, Bluetooth/NFC/USB en iOS, segundo plano garantizado, presencia en tienda)
4. ¿Qué obliga a tener servidor? (cuentas, pagos, datos compartidos, tiempo real, tareas programadas, secretos)
5. ¿Dónde debe encontrarse? (buscador o tienda de apps)

Tipos reconocidos: sitio informativo/marketing, sitio editorial con CMS, tienda online, aplicación con cuentas (SaaS), herramienta interna, API/servicio, aplicación móvil, extensión de navegador, automatización/bot. Un proyecto suele combinar varios (SaaS = landing pública + app tras login).

**Regla de plataforma: elegir la opción más web que cubra los requisitos duros** (web responsive > PWA > envoltorio web > multiplataforma > nativo).
Móvil, en breve: solo se sale de la web ante un requisito duro: push fiable en iOS, Bluetooth/NFC/USB, widgets o APIs de sistema recientes, o presencia en tienda con valor nativo real (Apple rechaza webs simplemente reempaquetadas). Si lo hay, multiplataforma (Expo/React Native o Flutter) con un equipo pequeño, nativo si la plataforma manda. Flutter web no sirve para SEO ni contenido. Políticas de tiendas, requisitos de API y soporte de PWA en iOS son volátiles: enlazar a la fuente oficial y verificar con fecha, no escribirlos en la skill. Extensiones de navegador y bots: se tratan como casos pequeños con una línea cada uno (extensión: Manifest V3, sin código remoto; bot: script programado con logs, no una app).

**Contenido gestionado** (preguntar quién edita y cada cuánto antes de nombrar herramienta):
- Desarrollador, pocos cambios: archivos Markdown/JSON en Git.
- Equipo no técnico, semanal: archivos en Git con CMS de interfaz sobre Git.
- No técnicos a diario, roles, programación, muchos documentos: CMS headless con base de datos.
- Contenido de usuarios o muy relacional: base de datos de la aplicación, no CMS.
Definir siempre: cómo se dispara la actualización (webhook o tiempo), cómo previsualizan borradores y qué pasa si el CMS cae.

**Tienda online** (caso ocasional; no se entra en carrito, pagos ni impuestos): la skill pregunta qué tipo de tienda es (pocos productos o catálogo grande, físico o digital, suscripciones, mercados o marketplaces, requisitos atípicos) y ofrece dos caminos con sus costes:
- **Plataforma de comercio existente** (tipo Shopify u otra, SaaS o abierta): camino por defecto en la mayoría de casos, porque pagos, impuestos, stock y pedidos ya están resueltos. Para muy pocos productos, basta un enlace de pago de la pasarela sobre un sitio estático.
- **A medida desde cero**: solo si el modelo de negocio o los requisitos no caben en ninguna plataforma; implica asumir pagos y webhooks en servidor, impuestos, stock, correos transaccionales y cumplimiento.
La recomendación sale de criterio propio, no de documentación oficial: marcarlo así. No se nombran plataformas concretas como "la mejor"; precios y límites se enlazan a su fuente con fecha. Si el usuario elige a medida, se pasa al flujo general de aplicación con cuentas, datos y servicios (fases 4 y 5).

## Decisión B: modelo de renderizado (si hay interfaz web)
Seis ejes, en orden: quién necesita ver el contenido sin ejecutar JS; si el contenido es igual para todos; frecuencia de cambio y tolerancia a obsoleto; cantidad de URLs; cuánta interactividad y dónde; capacidad operativa.
Orden por defecto, de más simple a más complejo: **estático (SSG) > regeneración o caché con invalidación (ISR) > servidor por petición (SSR) > SPA** (SPA solo donde el SEO no aplica, p. ej. tras login).
- Se mezcla por ruta, no por proyecto. Aislar lo dinámico (shell estático + zona dinámica, islas) antes que convertir toda la ruta en SSR.
- Contenido público que debe indexarse o ser citado por IA: debe estar en el HTML inicial. Google sigue recomendando SSR o prerender y trata el dynamic rendering como workaround. Que otros rastreadores de IA no ejecuten JS está medido solo por un estudio de tercero (Vercel/MERJ, 2024): indicio, no garantía; verificar con `curl` o con JS desactivado.
- Edge es una decisión de despliegue, no un modelo de contenido (fase 6).
- ISR depende del framework y del hosting (runtime, caché compartida en multi-instancia, no existe con export estático): comprobarlo en la doc vigente antes de proponerlo.
- Con streaming, verificar qué ve un cliente sin JS.
- Medir antes de optimizar; CWV: LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1 (enlaza con landing-launch/10).

## Decisión C: estilo de arquitectura del sistema
**Por defecto: monolito modular, una sola base de datos y servicios gestionados** (BD, auth, colas, almacenamiento) desde el día 1, hasta que una señal medida justifique separar algo.
- "Modular" solo cuenta si los límites entre módulos los hace cumplir una herramienta en CI; sin eso, es un monolito normal.
- Cinco ejes para separar: necesidad real de despliegue independiente; tamaño y estructura de equipos; perfil de escala distinto y medido; madurez operativa (CI/CD, observabilidad con trazas, guardia); claridad del dominio. No hay umbral de equipo verificado.
- Piezas baratas y casi siempre válidas: cola + worker para tareas largas. Eventos con varios consumidores es un compromiso mayor: solo con consumidores reales.
- BFF solo con varios clientes de necesidades divergentes. BaaS válido para MVP con base de datos estándar y una capa propia delante; revisar límites y pausas del plan gratuito (volátil). Serverless para tareas puntuales y picos; revisar topes de ejecución y lock-in.
- Señales de migración (siempre medidas y repetidas): extraer un servicio por equipos bloqueados, escala o aislamiento distinto, tecnología imprescindible; consolidar si los servicios se despliegan juntos, los opera un equipo y la plomería domina; diagnosticar monolito distribuido (cambios que tocan varios servicios, BD o librerías compartidas, cadenas síncronas largas) y consolidar o rediseñar, nunca añadir más servicios.
- Evidencia usable (fuente primaria): Segment (de más de 140 servicios a uno, 2018), Istio (unificó su plano de control, 2020), Shopify (monolito modular a gran escala, con dependencias circulares reconocidas en 2020). No citar Prime Video ni umbrales de blogs.

## Entregable
Sección del registro de decisiones: tipo(s) de proyecto, plataforma de destino, estrategia de contenido, modelo de renderizado por zona, estilo de arquitectura y la razón de cada una, alternativas descartadas, y "señales que harían revisar esta decisión". Datos volátiles con enlace y fecha. `[NEED: …]` para lo que dependa de una respuesta pendiente.

## Verificación
- Para cada decisión, el requisito del brief que la justifica (si no hay, sobra).
- Contenido público: comprobar HTML sin JS cuando ya exista algo (o declarar que se comprobará en la fase 8).
- Afirmaciones volátiles: abrir la documentación oficial vigente del framework o plataforma elegidos y anotar versión y fecha.

## Auditoría (modo revisar)
Contrastar lo construido con el brief: ¿el modelo de renderizado encaja con el SEO y la frescura exigidos? ¿hay SPA con contenido público? ¿microservicios sin despliegue independiente, equipos ni madurez operativa (diagnóstico de monolito distribuido)? ¿app móvil donde bastaba la web? ¿CMS o base de datos sin quién edite? ¿"modular" sin comprobación automática? Severidades: bloqueante si el contenido público no es visible sin JS y el SEO es objetivo, o si hay una plataforma imposible para un requisito duro; alta si hay sobreingeniería con coste operativo real; media o baja el resto.

## Puerta
No se pasa a 03 sin: tipo(s) de proyecto y plataforma decididos y justificados con el brief, estrategia de contenido, modelo de renderizado por zona, estilo de arquitectura por defecto o señal medida que lo supere, y datos volátiles verificados con fecha o marcados como no verificados.

## No verificado / pendiente (no pasa a la skill como hecho)
- Estado y versión de las live collections de Astro; vigencia de presets edge en Nuxt; ISR en SvelteKit; documentación propia de Remix; guía de ISR con Cache Components en Next.js.
- Criterios de Google Cloud y pilares de AWS/Azure Well-Architected: no abiertos.
- Safari Web Extensions y app contenedora; soporte de PWA en iOS 17+ y reversión en la UE (solo prensa); políticas de Chrome Web Store (MV3) y de pagos de Google Play: solo resúmenes de búsqueda.
- web.dev sobre capacidades PWA es de 2022: no usar como prueba de soporte actual (consultar MDN/caniuse).
- Citas literales cortas de Fowler/Azure salen de resúmenes automáticos: recontrastar antes de entrecomillar.
- Plataformas de e-commerce: criterio propio, no contrastado con fuentes oficiales.

## Enlaces oficiales a incluir en la skill (se verifican al redactar)
web.dev (rendering, Core Web Vitals), Google Search Central (JavaScript SEO basics, dynamic rendering, AI features), documentación vigente del framework elegido, Azure Architecture Center, Fowler (Monolith First, Microservice Premium, Microservice Trade-Offs), Apple App Review Guidelines, Google Play (target API), MDN (Push API, PWA), reactnative.dev, docs.expo.dev, docs.flutter.dev.
