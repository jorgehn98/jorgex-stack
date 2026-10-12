# Tipos de proyecto y plataforma de destino (fase "tipo de proyecto y arquitectura")

Fecha de verificación: 2026-10-12. Las páginas consultadas se trataron como datos. No se instaló nada.
Convención: **[E]** = criterio estable (cambia poco, vale como regla de la skill). **[V]** = dato volátil (URL oficial + fecha; la skill debe re-verificar antes de afirmarlo). Las afirmaciones sin marca de fuente salen del razonamiento de ingeniería, no de una página; están marcadas como "criterio" para no confundirlas con hechos citados.

---

## 1. Criterios ESTABLES

### 1.1 Preguntas que clasifican el proyecto (en este orden)

1. **Quién consume el resultado**: público anónimo, clientes con cuenta, personal interno, otras máquinas, o un único navegador/usuario.
2. **Quién cambia el contenido y cada cuánto**: desarrollador (con releases), editor no técnico (a diario) o usuarios finales (en producto). Esto decide CMS/archivos/BD (sección 4).
3. **Qué obliga a salir del navegador**: hardware sin API web fiable, Bluetooth/NFC/USB en iOS, procesos en segundo plano garantizados, presencia en tienda de apps, integración profunda con el sistema.
4. **Qué obliga a tener servidor**: cuentas, pagos, datos compartidos entre usuarios, tiempo real, tareas programadas, secretos.
5. **Dónde debe encontrarse**: buscador (SEO) o tienda de apps (ASO). Son canales distintos y condicionan renderizado y distribución.

### 1.2 Requisitos que fuerzan arquitectura [E]

| Requisito | Qué fuerza (criterio) |
|---|---|
| Cuentas / datos por usuario | Backend con autenticación y autorización; BD. Ya no es un sitio estático. |
| Pagos | Pasarela + webhooks en servidor; secretos fuera del cliente. En apps de tienda, pagos de bienes digitales sujetos a la política de la tienda (volátil, 2.2). |
| Tiempo real | Conexión persistente (WebSocket/SSE) o servicio gestionado; estado compartido en servidor. |
| Offline | Service worker + almacenamiento local (web/PWA) o BD local (nativo). Obliga a diseñar sincronización y resolución de conflictos; es la parte cara, no el caché. |
| SEO | HTML renderizado en servidor o en build (SSG/SSR). Un SPA solo cliente o Flutter web no encajan (ver fuente Flutter FAQ). |
| Push | Web Push requiere service worker y permiso del usuario (MDN Push API). En iOS exige app añadida a pantalla de inicio (2.1). Si push fiable es crítico en iOS, el nativo/multiplataforma reduce el riesgo. |
| Hardware | Cámara, micrófono, geolocalización, WebAuthn, sensores básicos: maduros en web (web.dev capacidades). Bluetooth, NFC, USB, Serial, HID: disponibles solo en algunos navegadores; no asumirlos en iOS (2.3). |

### 1.3 Regla de decisión de plataforma [E]

Elegir la opción **más web** que cubra los requisitos duros, porque tiene un único código, despliegue inmediato y sin revisión de tienda:

1. Web responsive (con SSR/SSG según SEO) si no hay requisito duro de sistema.
2. PWA si se necesita instalación, offline parcial o push, y se acepta el techo de capacidades del navegador, sobre todo en iOS.
3. Envoltorio web en nativo (Capacitor, o TWA en Android) si se necesita presencia en tienda o algún plugin nativo suelto, pero el producto es esencialmente web.
4. Multiplataforma (React Native/Expo, Flutter) si la experiencia es app-céntrica, con UI nativa, y se quiere un código para iOS y Android.
5. Nativo (Swift/Kotlin) si hay requisito duro de plataforma (APIs recién salidas, rendimiento extremo, extensiones de sistema, widgets, apps de una sola plataforma).

Señal de que se eligió mal: el equipo escribe puentes nativos para la mayor parte de las funciones (el multiplataforma pierde su sentido), o la PWA necesita Bluetooth/NFC/push fiable en iOS (el navegador es el techo).

### 1.4 Doc oficial que respalda el encaje multiplataforma [E, con versiones volátiles]

- React Native recomienda para apps nuevas usar un **framework (Expo)** en lugar de CLI sin framework; el modo sin framework es "compatible pero no recomendado" (reactnative.dev, verificado).
- Expo: Expo Go es solo para aprender/prototipar; para producción se recomienda **development build** (docs.expo.dev workflow, verificado). Expo soporta web con renderizado estático/cliente (docs.expo.dev/workflow/web, verificado), útil para código compartido, pero no sustituye a un framework web de contenido para SEO fuerte (criterio).
- Flutter: "no es adecuado para SEO ni sitios de contenido estáticos"; encaja en apps SPA/PWA y apps móviles existentes; para contenido recomiendan HTML plano o Jaspr (docs.flutter.dev web FAQ, verificado).
- Capacitor: runtime nativo para apps "web nativas" con plugins en Swift/Java/JS (capacitorjs.com, verificado). Su relación con PWA no se pudo confirmar en esa página.

---

## 2. Datos VOLÁTILES (re-verificar antes de usar)

### 2.1 PWA en iOS / iPadOS [V]
- Web Push en iOS/iPadOS: requiere iOS/iPadOS 16.4+, app añadida a pantalla de inicio con `display` "standalone" o "fullscreen", y permiso pedido tras interacción directa del usuario. No requiere membresía de desarrollador Apple. Fuente: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (artículo del 2023-02-16). Verificado 2026-10-12. Puede haber cambiado en versiones posteriores; el artículo no cubre iOS 17-27.
- Badging API solo en web apps añadidas a pantalla de inicio (no en Safari ni WKWebView) y el badge solo aparece con permiso de notificaciones. Fuente: https://webkit.org/blog/14112/webkit-features-for-safari-17-0/ (el contenido recuperado trata solo Badging; la URL del artículo menciona Safari 17.0 pero el texto recuperado no coincide con ese título: contenido verificado, atribución de versión NO VERIFICADA).
- Instalación: desde iOS 16.4 se puede instalar desde el menú Compartir en Safari, Chrome, Edge, Firefox y Orion; `beforeinstallprompt` no está soportado en iOS (la instalación es manual para el usuario). Safari macOS 17+ permite "Añadir al Dock" con o sin manifest. Fuente: https://developer.mozilla.org/en/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable. Verificado 2026-10-12.
- Almacenamiento: Safari borra el almacenamiento escribible por script (IndexedDB, localStorage, caché de service workers) tras 7 días de uso sin interacción con el sitio; las web apps de pantalla de inicio llevan su propio recuento y WebKit no espera que se borren sus datos de origen. Fuente: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (artículo de 2020). Verificado 2026-10-12; **estable de hecho pero de 2020, confirmar vigencia**. Consecuencia: offline "serio" en iOS fuera de pantalla de inicio es frágil.
- UE: en febrero 2024 Apple anunció retirar las web apps de pantalla de inicio en la UE y el 2024-03-01 revirtió la decisión. Fuente secundaria (prensa): https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/ (solo se vio el resumen de búsqueda; **no verificado contra Apple directamente**). La página oficial de Apple sobre DMA (https://developer.apple.com/support/dma-and-apps-in-the-eu/) **no menciona PWA** (verificado), así que no hay confirmación oficial vigente del estado en 2026.
- Firefox escritorio no instala PWAs; Firefox Android crea un acceso directo del navegador, no un WebAPK (MDN, mismo enlace de instalación, verificado).

### 2.2 Políticas de tiendas [V]
- Apple App Review Guidelines (https://developer.apple.com/app-store/review/guidelines/, verificado, **sin fecha de revisión visible**; solo se leyeron los primeros 100.000 de 112.273 caracteres): 4.2 (la app debe ser más que un sitio reempaquetado; no se aceptan apps que sean principalmente marketing, enlaces o "web clippings"), 4.2.6 (apps de plantilla o generador comercial se rechazan salvo que las envíe el proveedor del contenido), 3.1.1 (bienes digitales vía compra dentro de la app), 3.1.3 (excepciones: reader, multiplataforma, empresarial, persona a persona, bienes físicos, compañeras gratuitas). 3.1.3(e): bienes y servicios físicos consumidos fuera de la app pueden usar otros pagos (relevante para tienda online con app).
- Apple UE, distribución web: iOS 17.5+/iPadOS 18, notarización, dominio registrado, criterios financieros; el 2026-10-01 entran las condiciones UE unificadas (Core Technology Commission 5%). Fuente: https://developer.apple.com/support/web-distribution-eu/ (verificado 2026-10-12). Irrelevante para la mayoría de proyectos pequeños por los criterios de elegibilidad.
- Google Play, nivel de API objetivo: apps nuevas y actualizaciones deben apuntar a Android 16 (API 36) antes del 2026-08-31, con extensión posible hasta 2026-11-01. Fuente: https://support.google.com/googleplay/android-developer/answer/11926878 (verificado 2026-10-12).
- Google Play, cuentas personales creadas después del 2023-11-13: prueba cerrada con al menos 12 testers durante 14 días continuos antes de publicar en producción. Fuente: https://support.google.com/googleplay/android-developer/answer/14151465 (verificado 2026-10-12). Impacta el calendario de cualquier app móvil de una persona o microequipo.
- Google Play, pagos: Play Billing obligatorio para bienes digitales con excepciones por región (EEE, EE. UU., Reino Unido, etc.). Fuente: https://support.google.com/googleplay/android-developer/answer/9858738 y .../16497028 (EE. UU.: informe de transacciones y comisión desde 2026-10-01 según actualización de 2026-07-22). **Parcialmente verificado**: solo se obtuvo el resumen de una búsqueda sobre esas páginas, no su texto completo. La política de EE. UU. depende de una orden judicial vigente hasta 2027-11-01 según prensa (https://www.pocketgamer.biz/google-play-opens-up-third-party-payments-in-the-us-marking-a-turning-point-for-developer-revenue/, fuente secundaria).
- Extensiones, Chrome Web Store: Manifest V3 exige que toda la lógica esté en el paquete; prohíbe `eval` y scripts remotos (excepciones: Debugger API y User Scripts API). Fuente: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements (**parcialmente verificado**: resumen de búsqueda sobre esa URL; la página de políticas generales devolvió 404 en dos URL probadas). Complemento: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3 (verificado: service workers sustituyen páginas de fondo; `webRequest` bloqueante en deprecación).

### 2.3 Capacidades de hardware/OS en la web [V]
- web.dev clasifica por madurez: cámara, micrófono, geolocalización, WebAuthn, WebRTC, Web Share, portapapeles en "verde"; Web Bluetooth, WebNFC, WebUSB, Web Serial, WebHID, File System Access, Background Sync, Web Push, Payment Request "solo en algunos navegadores". **La página es de 2022-04-20**: tratar como desactualizada. Fuente: https://web.dev/learn/pwa/capabilities (verificado, desfasado).
- MDN: Background Synchronization API "no es Baseline", borrador WICG (https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API, verificado; navegadores concretos NO VERIFICADOS porque la tabla de compatibilidad no cargó). Web Bluetooth: "no Baseline", experimental, solo contexto seguro (https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API, verificado). Push API: Baseline "ampliamente disponible" desde marzo 2023 (https://developer.mozilla.org/en-US/docs/Web/API/Push_API, verificado).
- TWA (Android): abre la PWA dentro de una app Android con Digital Asset Links; el contenido debe ser útil primero en el navegador. Fuente: https://developer.chrome.com/docs/android/trusted-web-activity/overview (verificado; el requisito "Chrome 72+" es de una página antigua; la guía de subida a Play Store no se leyó).
- Safari Web Extensions: se distribuyen empaquetadas en una app contenedora (macOS/iOS) con conversor `xcrun safari-web-extension-converter`. Fuente: https://developer.apple.com/documentation/safariservices/safari-web-extensions. **NO VERIFICADO**: el contenido recuperado fue solo el título; el detalle anterior viene de conocimiento previo, no de la página.
- Flutter: versiones/plataformas soportadas según la página (Flutter 3.47; Android 24-37, iOS 15-27; web: Chrome/Edge/Firefox últimas 2 estables, Safari 15.6+). Fuente: https://docs.flutter.dev/reference/supported-platforms (verificado 2026-10-12).

---

## 3. Taxonomía de tipos de proyecto

Cada tipo: qué lo distingue, requisitos que fuerzan arquitectura, plataforma y errores típicos. Todo lo que no cita fuente es criterio.

### 3.1 Sitio informativo / marketing
- **Distingue**: contenido casi fijo, objetivo de conversión o presencia, visitantes anónimos, lo edita el dueño o el equipo con poca frecuencia.
- **Fuerza**: SEO, rendimiento (carga), accesibilidad, formularios (y su envío a un servicio), analítica y consentimiento.
- **Plataforma**: SSG (p. ej. Astro) con contenido en archivos; JS mínimo. Sin BD propia.
- **Errores**: montar SPA o CMS completo "por si acaso"; añadir login que no se necesita; confundirlo con "sitio editorial" cuando nadie editará a diario.

### 3.2 Sitio con contenido editorial gestionado (CMS)
- **Distingue**: volumen de contenido creciente, editores no técnicos, publicación frecuente, taxonomías, programación, borradores, revisión.
- **Fuerza**: modelo de contenido, roles y flujo editorial, previsualización, medios, SEO, a veces multilenguaje.
- **Plataforma**: ver sección 4 (archivos+Git con UI, headless con BD, o CMS tradicional).
- **Errores**: elegir por la herramienta de moda sin preguntar quién edita; sobredimensionar con BD cuando son 30 páginas; ignorar que el editor necesita previsualizar y publicar sin un desarrollador.

### 3.3 Tienda online
- **Distingue**: catálogo, carrito, pagos, impuestos, envío, stock, pedidos, correos transaccionales, política legal.
- **Fuerza**: pagos y webhooks en servidor, cuentas (o invitado), SEO de fichas de producto, consistencia de stock y pedidos, cumplimiento (IVA, privacidad, PCI delegado a la pasarela).
- **Plataforma**: plataforma de comercio existente (SaaS o plataforma abierta) para catálogos normales; a medida solo con requisitos que ninguna plataforma cubra. Frontend SSR/SSG con SEO.
- **Errores**: construir el carrito y la lógica fiscal desde cero; tratar una tienda de 5 productos como e-commerce completo (puede bastar un enlace de pago); asumir que una app móvil de una tienda de bienes físicos debe usar compra dentro de la app (3.1.3(e) permite otros métodos para bienes físicos, verificado en Apple).

### 3.4 Aplicación web con cuentas (SaaS)
- **Distingue**: usuarios autenticados, datos por inquilino/usuario, lógica de negocio, suscripciones, uso recurrente.
- **Fuerza**: autenticación y autorización, multi-tenencia, BD relacional en la mayoría de casos, facturación recurrente, auditoría, correo, colas; SEO solo en la parte pública (landing, docs).
- **Plataforma**: web app (SSR/SPA) + API + BD. PWA solo si aporta instalación u offline real.
- **Errores**: tratar el SaaS como "web + login" sin diseñar permisos y tenencia desde el inicio; mezclar landing pública (SEO) con la app tras login en el mismo renderizado sin necesidad; construir app móvil antes de validar la web.

### 3.5 Herramienta interna
- **Distingue**: pocos usuarios conocidos, red/SSO corporativo, sin SEO, valor en datos y flujos, plazo corto.
- **Fuerza**: autenticación corporativa, permisos por rol, acceso a datos internos, auditoría; despliegue interno.
- **Plataforma**: web (o low-code/panel de administración generado desde el esquema). Si es de una organización, apps "enterprise" cuentan con excepción de pago en Apple (3.1.3(c)) y las apps privadas de organización están exentas del requisito de API objetivo de Google Play (verificado).
- **Errores**: estética y escalabilidad de producto público; app móvil nativa para un formulario; saltarse permisos "porque es interno".

### 3.6 API / servicio sin interfaz
- **Distingue**: consumidores son máquinas u otros desarrolladores; el producto es el contrato.
- **Fuerza**: contrato versionado (OpenAPI), autenticación por clave/token, límites de uso, observabilidad, idempotencia, documentación.
- **Plataforma**: servicio HTTP; serverless o contenedor según carga. Sin UI salvo panel y docs.
- **Errores**: diseñar la API según tablas de la BD en vez de casos de uso; sin versionado; olvidar documentación y límites; confundir con "backend de una app" que no lo expone a terceros.

### 3.7 Aplicación móvil
Ver árbol de decisión en 3.7.1. Distingue: uso frecuente en móvil, hardware o sistema como núcleo, distribución por tienda.
- **Fuerza**: push fiable, acceso a hardware, offline con sincronización, widgets/atajos/segundo plano, presencia en tienda, políticas de tienda (2.2) y calendario de revisión; en Google Play, prueba cerrada de 12 testers/14 días para cuentas personales nuevas (verificado).
- **Errores**: hacer app cuando una web responsive bastaba; enviar a Apple una "web envuelta" sin valor (4.2); subestimar el tiempo de revisión y los requisitos de tienda; elegir Flutter/React Native y luego escribir módulos nativos para casi todo; ignorar que el pago de bienes digitales pasa por la tienda.

#### 3.7.1 Señales para web / PWA / multiplataforma / nativo

| Señal | Web | PWA | Envoltorio (Capacitor/TWA) | Multiplataforma (RN/Expo, Flutter) | Nativo |
|---|---|---|---|---|---|
| Solo consulta/formularios | Sí | | | | |
| Instalable, offline moderado | | Sí | | | |
| Push fiable en iOS | No | Con límites (pantalla de inicio, iOS 16.4+) | Sí (con plugin nativo) | Sí | Sí |
| Presencia en tienda | | | Sí (cuidado con 4.2) | Sí | Sí |
| Bluetooth/NFC/USB en iOS | No | No | Plugin | Librería/módulo | Sí |
| UI muy nativa y animaciones | No | No | Limitada | Sí | Sí |
| Un código iOS+Android | Sí | Sí | Sí | Sí | No |
| APIs de sistema recién salidas, widgets, extensiones | No | No | Parcial | Con módulo nativo | Sí |
| SEO importante | Sí | Sí | n/a | No (Flutter web) / parcial (Expo web estático) | n/a |

### 3.8 Extensión de navegador
- **Distingue**: vive dentro del navegador, actúa sobre páginas o el navegador, permisos explícitos.
- **Fuerza**: Manifest V3 (service worker, sin código remoto), permisos mínimos y política de privacidad, revisión de la tienda, WebExtensions para portar entre navegadores (Firefox, con "pocos cambios" según MDN, verificado), Safari requiere app contenedora (NO VERIFICADO en la fuente oficial).
- **Errores**: depender de un servidor que entrega lógica (viola MV3); pedir permisos amplios; asumir que "un código sirve para todos" sin probar las diferencias de API; olvidar que Safari exige empaquetar y firmar.

### 3.9 Automatización / bot
- **Distingue**: sin usuario interactivo habitual; disparado por tiempo o evento; integra APIs de terceros.
- **Fuerza**: ejecución programada (cron, colas, webhooks), secretos, reintentos e idempotencia, logs y alertas, límites de tasa y términos de uso de las plataformas integradas, estado mínimo persistente.
- **Plataforma**: script/servicio en serverless o contenedor pequeño; sin frontend o solo un panel.
- **Errores**: construir una app completa para algo que es un script con cron; sin observabilidad (falla en silencio); ignorar términos de la plataforma (scraping, bots) y rotación de credenciales.

---

## 4. Contenido gestionado: archivos, BD o CMS

Fuente de criterio: quién edita y con qué frecuencia. Documentación consultada con Context7 (Astro `/withastro/docs`, Decap `/websites/decapcms`, Payload `/payloadcms/payload` v3.85.0): verificada.

| Quién edita / frecuencia | Enfoque | Motivo | Contraindicación |
|---|---|---|---|
| El desarrollador, pocos cambios | Markdown/MDX/JSON en Git; en Astro, content collections con loader `glob()` y esquema Zod | Sin BD ni servicio; versionado, revisión por PR, build estático | Editores no técnicos no pueden publicar sin ayuda |
| Equipo pequeño no técnico, semanal | Contenido en Git + CMS con interfaz sobre Git (Decap o similar): UI, flujo editorial con `publish_mode: editorial_workflow`, escribe en el repo | Mantiene archivos como fuente de verdad; sin BD; UI para editores | Cada publicación dispara build; requiere autenticación con Git (backend GitHub); "open authoring" solo con backend GitHub, no Git Gateway; flujo editorial limitado frente a un CMS con BD; mantenimiento de Decap por verificar |
| Editores no técnicos, diario, muchos documentos, roles, programación | CMS headless con BD (p. ej. Payload con Postgres/SQLite/MongoDB y control de acceso por colección) o headless SaaS | Roles, borradores, relaciones, consultas, contenido bajo demanda | Operar BD y backend; coste y complejidad; el frontend debe regenerar/revalidar |
| Contenido generado por usuarios, transaccional o muy relacional | Base de datos propia en la aplicación (no CMS) | Es dato de producto, no contenido editorial | Usar un CMS aquí duplica el modelo |
| Sitio pequeño con editor único que quiere "WordPress" | CMS tradicional (acoplado, con plantillas y plugins) | Todo en uno, ecosistema de plugins, curva baja para el editor | Seguridad y actualizaciones continuas; menor control del frontend y rendimiento; acoplamiento |
| Contenido que cambia por entorno/idioma y requiere vista previa en vivo | Headless con BD y modo preview | La previsualización necesita acceso al borrador | Más piezas que mantener |

Reglas [E]:
- Cambia más rápido el contenido que el código, o lo edita alguien sin Git: la UI de edición es obligatoria; solo queda decidir si escribe en Git o en BD.
- Si el contenido tiene relaciones, búsqueda, permisos por documento o volumen alto, BD. Si es un conjunto de documentos que un humano lee entero, archivos.
- Preguntar siempre quién edita y cada cuánto antes de nombrar una herramienta; el error común es elegir por el stack, no por el flujo editorial.

---

## 5. Tabla de decisión (tipo/necesidad -> enfoque -> motivo -> contraindicación)

| Tipo / necesidad | Enfoque recomendado | Motivo | Contraindicación |
|---|---|---|---|
| Sitio de marketing, edita el dev | SSG (Astro) + Markdown/JSON en Git | SEO, velocidad, sin BD | Editores no técnicos frecuentes |
| Sitio de marketing, editor no técnico ocasional | SSG + CMS sobre Git (Decap/similar) | UI sin BD | Publicación en tiempo real, roles complejos |
| Sitio editorial con mucho contenido y roles | CMS headless con BD + frontend SSR/SSG | Flujo editorial, roles, programación | Presupuesto/ops mínimos |
| Blog pequeño con un solo autor técnico | Markdown en Git | Mínimo coste | Autor que no use Git |
| Tienda con catálogo estándar | Plataforma de e-commerce existente + frontend SEO | Pagos, impuestos, stock resueltos | Requisitos de negocio atípicos |
| Venta de muy pocos productos/servicios | Enlace de pago de la pasarela sobre sitio estático | Mínima superficie | Catálogo que crece, stock |
| SaaS con cuentas | Web app + API + BD relacional, auth probada | Datos por usuario, facturación | Sitio sin datos de usuario |
| SaaS que necesita offline/instalación | PWA sobre la web app | Un código, sin tienda | Push fiable/hardware en iOS, Bluetooth/NFC |
| Herramienta interna | Web sencilla o panel autogenerado + SSO | Pocos usuarios, sin SEO | Exposición pública sin controles |
| API/servicio sin UI | Servicio HTTP con OpenAPI + auth por token | El contrato es el producto | Necesidad de interfaz para usuarios finales |
| App móvil con hardware/push/tienda y un equipo pequeño | Expo (RN) o Flutter | Un código, UI nativa, recomendación oficial de RN | Casi todo es nativo propio; SEO (Flutter web) |
| App móvil con APIs de sistema recientes, widgets, extensiones | Nativo (Swift/Kotlin) | Acceso inmediato a la plataforma | Equipo único o presupuesto para un solo código |
| Web existente que debe estar en tiendas | Capacitor (o TWA en Android) | Reutiliza la web | Apple 4.2 si es solo web reempaquetada |
| Extensión de navegador | WebExtensions MV3 (Chrome/Edge/Firefox); Safari con app contenedora | Portabilidad de API | Código remoto, permisos amplios |
| Automatización/bot | Script o función programada con cola y logs | Sin UI innecesaria | Proceso que exige interacción humana frecuente |

---

## 6. Fuentes y estado

| Fuente | URL | Estado |
|---|---|---|
| web.dev Learn PWA (índice) | https://web.dev/learn/pwa | Verificado (sin criterios de instalación en esa página; sin fechas) |
| web.dev capacidades PWA | https://web.dev/learn/pwa/capabilities | Verificado, desfasado (2022-04-20) |
| MDN PWAs instalables | https://developer.mozilla.org/en/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable | Verificado |
| MDN PWAs (índice) | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps | Verificado |
| MDN Push API | https://developer.mozilla.org/en-US/docs/Web/API/Push_API | Verificado |
| MDN Background Sync | https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API | Verificado (soporte por navegador NO VERIFICADO) |
| MDN Web Bluetooth | https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API | Verificado (navegadores concretos no obtenidos) |
| MDN WebExtensions | https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions | Verificado (no cubre Safari ni versiones de manifest) |
| WebKit: Web Push iOS | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ | Verificado (2023-02-16) |
| WebKit: Badging / Safari 17 | https://webkit.org/blog/14112/webkit-features-for-safari-17-0/ | Verificado en parte; contenido recuperado no coincide con el título |
| WebKit: tracking prevention (7 días) | https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ | Verificado (2020) |
| Apple DMA/UE | https://developer.apple.com/support/dma-and-apps-in-the-eu/ | Verificado; no cita PWA |
| Apple Web Distribution UE | https://developer.apple.com/support/web-distribution-eu/ | Verificado |
| Apple App Review Guidelines | https://developer.apple.com/app-store/review/guidelines/ | Verificado en parte (100.000/112.273 caracteres; sin fecha de revisión) |
| Apple: Building web apps for iOS | https://developer.apple.com/documentation/webkit/building-web-apps-for-ios | 404, NO VERIFICADO |
| Apple Safari Web Extensions | https://developer.apple.com/documentation/safariservices/safari-web-extensions | NO VERIFICADO (solo título recuperado) |
| Google Play: API objetivo | https://support.google.com/googleplay/android-developer/answer/11926878 | Verificado |
| Google Play: prueba de cuentas personales | https://support.google.com/googleplay/android-developer/answer/14151465 | Verificado |
| Google Play: Payments policy / EE. UU. | https://support.google.com/googleplay/android-developer/answer/9858738 ; .../16497028 | Parcial (resumen de búsqueda, no texto completo) |
| Chrome MV3 qué es | https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3 | Verificado |
| Chrome Web Store: requisitos MV3 | https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements | Parcial (resumen de búsqueda). Otras dos URL de políticas: 404 |
| Chrome TWA | https://developer.chrome.com/docs/android/trusted-web-activity/overview | Verificado (parte de Play Store no leída) |
| React Native entorno | https://reactnative.dev/docs/environment-setup | Verificado |
| Expo workflow | https://docs.expo.dev/workflow/overview/ | Verificado |
| Expo web | https://docs.expo.dev/workflow/web/ | Verificado |
| Flutter plataformas | https://docs.flutter.dev/reference/supported-platforms | Verificado |
| Flutter web FAQ | https://docs.flutter.dev/platform-integration/web/faq | Verificado |
| Capacitor | https://capacitorjs.com/docs | Verificado |
| Astro content collections | Context7 `/withastro/docs` | Verificado |
| Decap CMS | Context7 `/websites/decapcms` | Verificado |
| Payload CMS | Context7 `/payloadcms/payload` v3.85.0 | Verificado |
| Apple revierte PWAs UE (prensa) | https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/ | No verificado directamente (solo resumen de búsqueda; secundaria) |
| Google Play EE. UU. (prensa) | https://www.pocketgamer.biz/google-play-opens-up-third-party-payments-in-the-us-marking-a-turning-point-for-developer-revenue/ | No verificado directamente (secundaria) |

Pendientes sin cubrir: soporte de PWA en iOS posterior a 16.4 (versiones 17-27) desde fuente oficial; tabla de compatibilidad de navegadores para Background Sync/Web Bluetooth; texto completo de las políticas de Chrome Web Store; guías de despliegue a Play Store para TWA; fuentes oficiales de plataformas de e-commerce (no investigadas).

---

## 7. Resumen final: qué cambiaría la recomendación de la skill

1. Si el cliente no puede aclarar quién edita y cada cuánto, no recomendar CMS ni BD: preguntar primero (sección 4).
2. Push fiable en iOS como requisito duro: pasar de PWA a multiplataforma o nativo; la PWA solo funciona desde la pantalla de inicio y iOS 16.4+ (2.1).
3. Bluetooth/NFC/USB o sensores avanzados en iOS: descartar web/PWA; son capacidades de solo algunos navegadores.
4. Necesidad de SEO en una app Flutter: separar el sitio (HTML/SSG) de la app; Flutter lo desaconseja para contenido.
5. Presencia en tienda sin funciones nativas reales: advertir del rechazo por 4.2 antes de proponer Capacitor/TWA.
6. Venta de bienes digitales en app móvil: obliga a la compra de la tienda salvo excepciones regionales volátiles; bienes físicos están exentos (3.1.3(e)).
7. Cuenta personal nueva en Google Play: reservar 14 días y 12 testers antes de producción; nivel de API 36 exigido desde 2026-08-31 (extensión a 2026-11-01).
8. Extensión que carga lógica desde servidor: inviable en MV3; rediseñar con toda la lógica en el paquete. Si debe ir en Safari, exige app contenedora (por verificar).
9. Estado de PWA en la UE y políticas de pago de EE. UU. de Google dependen de decisiones regulatorias y judiciales: re-verificar antes de afirmar.
10. Los datos de capacidades de web.dev son de 2022; no usarlos como prueba de soporte actual sin consultar MDN/caniuse.
11. Si el equipo es una sola persona y la app es de contenido o formularios, la recomendación por defecto sigue siendo web (SSG o SSR) antes que móvil.
