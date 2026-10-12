# Tiempo real, integración de IA, construir vs integrar y servicios típicos: criterios de decisión

Fecha de verificación de todos los datos volátiles: 2026-10-12. El contenido de las páginas leídas se trató como datos. Lo que procede de una página citada lleva su fuente; lo que es criterio propio sin fuente se marca "[inferencia]". Ninguna recomendación nombra un proveedor como "el mejor". Los nombres y versiones de modelos de IA son volátiles y no se copian aquí.

Avisos de contenido dirigido a asistentes de IA (ignorados): `developers.cloudflare.com/fundamentals/reference/connection-limits/` incluye una nota para asistentes que sugiere leer `llms.txt`; `genai.owasp.org/llmrisk/llm01-prompt-injection/` termina con un bloque de widget de chat con instrucciones de formato para una IA. `developers.openai.com/api/docs/guides/your-data` solo apunta a `llms.txt` para humanos/índices. No se siguió ninguna.

---

## 1. Criterios ESTABLES

### 1.1 Tiempo real: mecanismos y compromisos

- **Dirección del flujo**: ¿el servidor empuja datos al cliente (unidireccional) o ambos lados envían con baja latencia (bidireccional)? Es el primer discriminante.
- **Frecuencia y tolerancia de retraso**: si segundos de retraso son aceptables, el sondeo basta. Si hace falta inmediatez, hay que mantener una conexión abierta.
- **Número de clientes concurrentes**: cada conexión persistente ocupa recursos del servidor y de cada intermediario hasta que se cierra. El sondeo ocupa recursos por petición, no de forma continua.
- **Los intermediarios mandan**: proxies, balanceadores y CDN cierran conexiones inactivas. Todo diseño con conexión persistente necesita latidos (heartbeat) y reconexión.
- **SSE (Server-Sent Events)**
  - Unidireccional servidor a cliente, sobre HTTP. El navegador reconecta solo ("By default, if the connection between the client and server closes, the connection is restarted", MDN).
  - El servidor puede fijar el tiempo de reconexión con `retry`; el cliente envía `Last-Event-ID` al reconectar (WHATWG §9.2.4 y §9.2.6), lo que permite reanudar sin perder eventos si el servidor guarda un historial [la reanudación real es responsabilidad del servidor, inferencia].
  - Sobre HTTP/1.1 el límite es de 6 conexiones por navegador y dominio, compartido entre pestañas. Con HTTP/2 el máximo de streams se negocia (por defecto 100) (MDN). Es un riesgo real si el usuario abre varias pestañas.
  - Proxies antiguos pueden cortar conexiones inactivas: la especificación aconseja enviar un comentario (`:`) "cada 15 segundos o así" (WHATWG §9.2.7).
  - Solo el navegador decide cuándo reconectar y con qué backoff ("the client may also add backoff", WHATWG §9.2.3).
- **WebSocket (RFC 6455)**
  - Bidireccional sobre una sola conexión TCP, pensado para funcionar por los puertos HTTP 80/443 y con proxies (RFC 6455 §1.5).
  - Ping/Pong sirve de keepalive y de comprobación de vida (§5.5). El protocolo NO define reconexión: la reconexión, el backoff y la reanudación son del código de la aplicación (RFC 6455).
  - La interfaz `WebSocket` del navegador "no soporta backpressure": si llegan mensajes más rápido de lo que se procesan, se llena la memoria o se bloquea la CPU (MDN). `WebSocketStream` es no estándar y de un solo motor de renderizado; `WebTransport` es más complejo y con menos soporte (MDN).
  - Seguridad (OWASP WebSocket Security Cheat Sheet): `wss://`, validar `Origin` con lista permitida, autenticar en el handshake (riesgo CSWSH con cookies), autorizar cada mensaje, límite de tamaño de mensaje, límite de tasa, timeouts de inactividad.
- **Servicio gestionado de tiempo real** [inferencia, no hay fuente oficial genérica]: traslada el coste de mantener millones de conexiones, el escalado y la reconexión a un tercero, a cambio de coste por conexión/mensaje, bloqueo (protocolo/SDK propio) y un plan de salida. Tiene sentido cuando hay muchos clientes concurrentes, presencia, difusión por canales o salas, y el equipo no quiere operar conexiones persistentes.
- **Escalado de conexiones persistentes** [inferencia]: el servidor deja de ser sin estado. Con varias instancias hace falta un bus (pub/sub) para repartir mensajes entre ellas, o afinidad de sesión; los despliegues cortan conexiones y todos los clientes reconectan a la vez (tormenta de reconexiones), así que backoff con jitter y un límite de conexiones por usuario son obligatorios.
- **Streaming de respuestas de IA** no es "tiempo real" en sentido estricto: es una respuesta HTTP larga con SSE (la API de Anthropic usa SSE, ver 1.2). Si solo se transmite la respuesta de un modelo al navegador, SSE suele bastar y no hace falta WebSocket [inferencia].

### 1.2 Integración de IA (LLM) a nivel de arquitectura

- **Claves siempre en el servidor.** Google: "Never expose keys client-side in production: Do not hardcode API keys directly in web or mobile apps"; recomienda un proxy de backend. Además: no subir claves a Git, leerlas de variables de entorno, usar un gestor de secretos en producción, alertas de facturación, y ante fuga: crear clave nueva, desplegarla y luego desactivar la antigua (Google, API key). OpenAI: no poner claves en código ni repos públicos, cargarlas por variables de entorno o gestor de secretos, poner caducidad, rotar (crear, actualizar, verificar, revocar), separar proyectos de staging y producción; la página NO trata la exposición en cliente de forma explícita (OpenAI production best practices). Anthropic: la página de visión general de la API describe claves y workspaces para separar entornos y controlar gasto, pero NO enuncia explícitamente "no en el cliente" en lo leído; la regla es igualmente válida por los otros dos proveedores y por razones de coste [inferencia].
- **Capa propia entre la aplicación y el modelo** [inferencia]: una interfaz interna (entrada: mensajes y parámetros; salida: texto/estructura, uso de tokens, error tipificado) hace intercambiable el modelo, centraliza límites, registros, redacción de datos sensibles y evaluación. No hace falta una abstracción multi-proveedor genérica desde el día 1 (YAGNI): basta con que ningún código de negocio importe el SDK del proveedor directamente.
- **Qué datos se envían y adónde**: tratar todo lo que entra en un prompt como datos que salen de tu perímetro. Pasos estables: clasificar datos (personales, financieros, salud, secretos), minimizar y redactar antes de enviar, decidir región de procesamiento y retención, y firmar el acuerdo de tratamiento de datos que aplique [inferencia sobre el proceso; los hechos del proveedor son volátiles, ver sección 3].
- **Límites de tasa y manejo de errores**
  - Cada proveedor mide por minuto (peticiones y tokens) y por nivel de uso (ver 3.2). Un 429 puede indicar tasa excedida o tope de gasto; la causa cambia la reacción: reintentar con espera frente a no reintentar.
  - Patrón recomendado por OpenAI: backoff exponencial con jitter, tope de intentos y de tiempo total de reintento, respetar `Retry-After` como mínimo, no reintentar errores de cuota/facturación, y si haces tu propio bucle de reintentos, desactivar los reintentos del SDK o contarlos para no multiplicar peticiones.
  - Anthropic: el SDK oficial reintenta con backoff exponencial dos veces por defecto y respeta `retry-after`; el tope de gasto mensual devuelve 429 sin `retry-after` y los reintentos fallan hasta que se restablece el acceso; un tope de gasto propio devuelve 400 (ver 3.2). En streaming, un error puede llegar DESPUÉS de un 200, por lo que el manejo normal de códigos HTTP no basta (Anthropic, errors).
  - Cada respuesta incluye un identificador de petición (`request-id` en Anthropic): guardarlo en los registros para soporte.
- **Latencia y streaming**: la latencia depende sobre todo del modelo y del número de tokens generados; los tokens del prompt aportan poco. El streaming reduce el tiempo hasta el primer token, no el tiempo total (OpenAI production best practices). Peticiones largas sin streaming se arriesgan a que redes intermedias corten conexiones inactivas: Anthropic recomienda streaming o la API por lotes para peticiones largas (Anthropic, errors).
- **Trabajo diferido**: para tareas que no necesitan respuesta inmediata, las API por lotes tienen cuotas separadas de las síncronas (OpenAI y Anthropic, ver 3.2) y un descuento de coste en Anthropic (50 % según su visión general de la API, ver 3.3).
- **Costes por uso**: coste = tokens × precio por token (OpenAI). Controlar con: límite de gasto duro del proveedor, alertas, límite propio por usuario/cuenta, tope de `max_tokens`, tope de tamaño de entrada, caché de prompts/respuestas, modelo más pequeño donde la calidad lo permita. El precio es volátil, nunca se fija en la skill.
- **Evaluación de resultados** [inferencia]: un conjunto fijo de casos con salida esperada o criterio de aceptación, ejecutable antes de cambiar de modelo, de prompt o de versión. Sin esto no se puede cambiar de modelo ni detectar degradación. Validar la forma de la salida con código determinista (OWASP LLM01, prevención 2).
- **Fallback** [inferencia]: definir de antemano qué ve el usuario si el modelo falla o se agota la cuota (mensaje claro, cola, función sin IA, segundo modelo). Un segundo proveedor solo compensa si la capa propia y la evaluación ya existen.
- **Límites de gasto**: defensa en capas: tope del proveedor (con aviso: al alcanzarse se detiene todo el tráfico afectado), tope por workspace/proyecto, tope por usuario en tu aplicación, y monitorización de anomalías. Cubre el riesgo "Unbounded Consumption" (OWASP LLM10): denial of wallet, entradas de longitud variable, extracción de modelo; mitigaciones OWASP: límites de tamaño de entrada, límites de tasa y cuotas por usuario, timeouts, degradación controlada, monitorización.
- **Riesgos (OWASP Top 10 for LLM Applications, edición 2025)**: LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure, LLM03 Supply Chain, LLM04 Data and Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector and Embedding Weaknesses, LLM09 Misinformation, LLM10 Unbounded Consumption. Los tres que más pesan en arquitectura:
  - **Inyección de instrucciones (LLM01)**: directa o indirecta (contenido externo con instrucciones). OWASP afirma que no se conoce una prevención totalmente fiable; las medidas reducen impacto: acotar el comportamiento, validar formato de salida con código determinista, filtrar entrada y salida, mínimo privilegio, aprobación humana en acciones de riesgo, separar y etiquetar contenido no confiable, pruebas adversarias, tratar al modelo como usuario no confiable.
  - **Divulgación de datos (LLM02)**: sanear y enmascarar datos antes de enviarlos, controles de acceso con mínimo privilegio, políticas de retención claras, no confiar solo en el prompt del sistema porque la inyección puede saltárselo.
  - **Agencia excesiva (LLM06)**: causas: demasiada funcionalidad, demasiados permisos, demasiada autonomía. Prevención: pocas funciones y granulares (no "ejecutar shell"), permisos mínimos (p. ej. BD solo lectura), actuar con el contexto de seguridad del usuario, aprobación humana en acciones de alto impacto, autorización aplicada en los sistemas posteriores y no en el modelo, registro y límite de tasa.
  - Regla estable derivada: la salida del modelo es entrada no confiable para el resto del sistema (LLM05) [inferencia a partir de OWASP].

### 1.3 Construir vs integrar (marco general) [criterio propio; no hay fuente normativa]

Preguntas en este orden:

1. **¿Es núcleo del producto o commodity?** Si es lo que diferencia al producto frente a la competencia, se construye o se controla. Si todos lo necesitan igual (correo, pagos, auth, analítica), se integra.
2. **¿Cuál es el coste total de propiedad?** Integrar: cuota + uso + tiempo de integración + mantenimiento de la integración + coste de salir. Construir: desarrollo + operación + seguridad + guardia + actualizaciones durante años. Lo olvidado casi siempre es el coste de operar y de mantener lo construido.
3. **¿Cuánto tiempo hay hasta validar?** Integrar acorta el camino a un producto usable; construir solo compensa si el servicio es el producto o el coste a escala lo exige.
4. **¿Qué riesgo asume cada opción?** Integrar: caída del proveedor, cambio de precios o de términos, cierre. Construir: errores de seguridad propios (pagos, auth y cifrado son el caso típico donde construir suele ser peor).
5. **¿Qué bloqueo (lock-in) crea y cuál es la salida?** Datos exportables en formato abierto, API estándar o capa propia que aísle al proveedor, contrato con plazo de salida, coste real de migrar. Si no se puede describir la salida en dos frases, el bloqueo es alto.
6. **¿Qué datos del usuario salen del perímetro y qué exige la normativa aplicable?** (región, tratamiento, retención).
7. **Reversibilidad**: elegir integrar lo fácil de sustituir y encapsular lo difícil. Revisar la decisión cuando cambie el volumen, el precio o el riesgo.

### 1.4 Terceros y cadena de suministro

- **Dependencias y SDK**
  - Fijar versiones verificadas mediante archivos de bloqueo (lockfiles) (OWASP Software Supply Chain Security Cheat Sheet).
  - Inventario con SBOM, incluidas dependencias transitivas, generado automáticamente en CI (OWASP).
  - Antes de adoptar: mantenimiento activo, uso extendido, madurez, versión liberada, pruebas, documentación de uso seguro, proceso claro de notificación de vulnerabilidades, y licencia compatible con tu uso (OWASP).
  - Procedencia (provenance) generada en la plataforma de compilación y verificada antes de confiar (OWASP; GitHub attestations).
  - CI/CD con mínimo privilegio, MFA, rotación de credenciales, entornos efímeros y repositorio privado de artefactos (OWASP).
- **Avisos de seguridad**: GitHub: el grafo de dependencias cruza con la GitHub Advisory Database; las alertas de Dependabot avisan de dependencias vulnerables y de malware; las actualizaciones de seguridad abren PR al parche mínimo; las actualizaciones de versión mantienen al día aunque no haya vulnerabilidad y requieren configuración (`dependabot.yml`). Dependabot admite periodo de espera (`cooldown`) para nuevas versiones (GitHub, opciones de Dependabot).
- **Gestión de vulnerabilidades** (OWASP Vulnerable Dependency Management Cheat Sheet): análisis de composición desde el inicio del proyecto (añadirlo tarde crea un atasco), actuar sobre dependencias directas, si no hay parche aplicar mitigaciones y aislar la función, y tomar la aceptación de riesgo como decisión explícita. La hoja no define plazos de corrección: cada equipo fija los suyos.
- **Evaluación de salud del proyecto**: OpenSSF Scorecard ejecuta 18 comprobaciones (vulnerabilidades conocidas, mantenimiento, política de seguridad, revisión de código, protección de ramas, dependencias fijadas, permisos de tokens, releases firmados, etc.), con puntuación por comprobación y agregada (scorecard.dev).
- **SLA de proveedores** [inferencia; sin fuente leída]: leer el SLA real, no la página de precios; comprobar el porcentaje comprometido, qué cuenta como caída, el crédito como única remedio, exclusiones, y si el SLA aplica a tu plan. Un SLA no sustituye un plan para cuando el proveedor cae.
- **Plan de salida** [inferencia]: exportación de datos probada, inventario de dónde se usa el proveedor, interfaz propia que lo aísle, tiempo estimado de migración, y qué hacer si cierra con poco aviso.
- **Revisión de licencias**: automatizarla en CI y decidir una política (permitidas, a revisar, prohibidas) antes de que haya dependencias [inferencia].

---

## 2. Tablas de decisión

### 2.1 Tiempo real y IA: necesidad, enfoque, motivo, contraindicación

| Necesidad | Enfoque | Motivo | Contraindicación |
|---|---|---|---|
| Datos que cambian cada minuto o más lento; pocos clientes; no importa 5-30 s de retraso | Sondeo (polling) con intervalo y caché HTTP | Sin conexión persistente; funciona con cualquier proxy; más simple de operar y depurar [inferencia] | Muchos clientes sondeando en vano multiplican la carga; si hace falta menos de unos segundos de retraso |
| Sondeo pero con retraso largo y respuesta cuando haya novedades | Sondeo largo (long polling) [inferencia] | Casi inmediato sin protocolo nuevo | Mantiene peticiones colgadas como una conexión persistente, con los mismos problemas de timeouts, sin las ventajas de reconexión integrada de SSE |
| Servidor empuja al cliente (notificaciones, progreso, feed, tokens de un LLM) | SSE | Reconexión automática y `Last-Event-ID` incluidos en el navegador; solo HTTP (MDN, WHATWG) | Cliente que también envía datos con baja latencia; límite de 6 conexiones por dominio en HTTP/1.1; clientes que no son navegador sin soporte; buffering de proxies que retiene los eventos [inferencia] |
| Comunicación bidireccional de baja latencia (chat, colaboración, juegos, cursores compartidos) | WebSocket | Un canal en ambos sentidos sin abrir conexiones por mensaje (RFC 6455) | Reconexión, reanudación y latidos son tuyos; sin backpressure en la API del navegador (MDN); servidor con estado; exige validar `Origin` y autenticar (OWASP) |
| Muchos clientes concurrentes, canales, presencia, difusión, y no se quiere operar conexiones | Servicio gestionado de tiempo real | Traslada el escalado y la reconexión al proveedor [inferencia] | Coste por conexión/mensaje, bloqueo de SDK/protocolo, límites del proveedor, dependencia de su disponibilidad |
| Notificaciones puntuales a usuarios que no tienen la página abierta | Notificaciones push o correo (servicio aparte) [inferencia] | No requiere conexión abierta | Depende de permisos del usuario y de terceros |
| Tablero con 1-2 actualizaciones por minuto | Sondeo cada 30-60 s | Basta y no añade infraestructura [inferencia] | Si el producto se vende por inmediatez |
| Respuesta de un LLM visible mientras se genera | Streaming por SSE desde tu servidor al cliente | El proveedor ya usa SSE; reduce tiempo al primer token (Anthropic streaming; OpenAI) | El servidor debe reenviar sin buffering y gestionar errores tras el 200 |
| Llamada a LLM sin interacción en vivo (resumir en lote, clasificar) | API por lotes o cola de trabajos | Cuota separada de la síncrona; en Anthropic con descuento (50 %, volátil) | Resultados no inmediatos |
| LLM que tiene que ejecutar acciones (enviar correo, escribir en BD) | Herramientas mínimas, permisos mínimos, aprobación humana en lo irreversible | OWASP LLM06 | Autonomía total sin verificación |
| Datos personales o confidenciales en el prompt | Minimizar, redactar, región fijada, ZDR o acuerdo de tratamiento si el proveedor lo ofrece | OWASP LLM02; opciones de proveedor (ver 3.3) | Planes gratuitos o sin acuerdo de datos: algunos proveedores usan el contenido para mejorar productos (Google, ver 3.3) |
| Proveedor de LLM puede cambiar o desaparecer | Capa propia + conjunto de evaluación | Permite cambiar de modelo con evidencia [inferencia] | Sobreabstracción multi-proveedor sin necesidad real |

### 2.2 Servicios típicos y pregunta de decisión (sin recomendar proveedores)

| Servicio | Pregunta de decisión |
|---|---|
| Analítica de producto / web | ¿Qué decisiones concretas voy a tomar con estos datos, y puedo tomarlas sin identificar a personas ni pedir consentimiento intrusivo? |
| Monitorización de errores y trazas | ¿Quién recibe el aviso, en cuánto tiempo debe actuar, y qué datos personales pueden acabar en los informes de error? |
| Registros y métricas (observabilidad) | ¿Qué pregunta tengo que poder contestar a las 3 de la madrugada y cuánto tiempo de retención necesito? |
| Búsqueda | ¿Basta con filtros y consultas en la base de datos actual, o necesito relevancia, tolerancia a erratas y facetas con el volumen esperado? |
| Almacenamiento de archivos | ¿Qué tamaño, privacidad (público/privado/URL firmada), región y ciclo de vida (borrado, retención) tienen los archivos, y cómo los exporto? |
| Correo transaccional | ¿Qué correos son críticos (restablecer clave, factura), cómo garantizo entregabilidad (dominio, SPF/DKIM/DMARC) y qué hago si cae el proveedor? |
| Correo de marketing / boletín | ¿Tengo consentimiento y baja gestionada, y quién posee la lista si cambio de herramienta? |
| Pagos | ¿Qué modelo cobro (puntual, suscripción, marketplace), en qué países, y cómo evito tocar datos de tarjeta (delegar el cobro)? |
| Autenticación e identidad | ¿Qué métodos de acceso necesito hoy y en 12 meses (clave, enlace mágico, social, SSO, MFA), y puedo exportar usuarios y hashes si me voy? |
| Autorización y roles | ¿Los permisos son simples (rol fijo) o dependen de recursos y organizaciones, y dónde se aplican (siempre en el servidor)? |
| Feature flags / experimentos | ¿Necesito activar por usuario o porcentaje sin desplegar, o basta una variable de configuración? |
| CDN y caché de borde | ¿Qué contenido es idéntico para todos y cacheable, y qué latencia o ancho de banda justifica una capa más? |
| DNS, dominio y certificados | ¿Quién controla el dominio y la renovación, y puedo moverlo sin cortes? |
| Cola de trabajos / tareas programadas | ¿Qué trabajo no debe bloquear la petición del usuario, y qué pasa si falla o se duplica (idempotencia, reintentos)? |
| Base de datos gestionada | ¿Qué RPO/RTO (pérdida y tiempo de recuperación) tolero, y cómo restauro una copia de seguridad probada? |
| Notificaciones push / SMS | ¿Es crítico llegar al usuario fuera de la aplicación, y cuánto cuesta cada mensaje a escala? |
| Tiempo real gestionado | ¿Cuántas conexiones concurrentes tendré y justifica ese número no operarlas yo? |
| IA / LLM | ¿Qué datos salen, qué pasa si el modelo falla o miente, quién paga el pico de uso, y cuánto cuesta cambiar de modelo? |
| Moderación / antispam / captcha | ¿Qué abuso espero (registro, formularios, contenido) y qué daño causa si pasa? |
| Soporte / formularios / CRM | ¿Dónde viven los datos de contacto y quién puede exportarlos o borrarlos? |
| Copias de seguridad y recuperación | ¿Cuándo se probó por última vez una restauración completa? |

---

## 3. Datos VOLÁTILES (verificados 2026-10-12)

### 3.1 Tiempo real: límites de intermediarios

| Dato | Valor observado | Fuente oficial | Estado |
|---|---|---|---|
| SSE sobre HTTP/1.1: conexiones por navegador y dominio | 6 (compartido entre pestañas) | MDN, Using server-sent events | VERIFICADO |
| SSE sobre HTTP/2: streams simultáneos | negociado, por defecto 100 | MDN, Using server-sent events | VERIFICADO |
| Latido recomendado para SSE | comentario cada ~15 s | WHATWG HTML §9.2.7 | VERIFICADO |
| nginx: tiempo sin datos antes de cerrar un proxy WebSocket | 60 s por defecto (`proxy_read_timeout`) | nginx.org (vía Context7) | VERIFICADO |
| nginx: cabeceras para WebSocket | pasar `Upgrade` y `Connection` explícitamente | nginx.org/en/docs/http/websocket.html (vía Context7) | VERIFICADO |
| Application Load Balancer (AWS): tiempo de inactividad por defecto | 60 s; rango 1-4000 s; recomienda enviar al menos 1 byte antes de que venza y que el timeout de la aplicación sea mayor que el del balanceador | AWS ELB, Edit attributes | VERIFICADO |
| Application Load Balancer: PING de HTTP/2 | no reinicia el temporizador de inactividad | AWS ELB, Edit attributes | VERIFICADO |
| Cloudflare: cliente a Cloudflare, inactividad HTTP/2 y keep-alive HTTP/1.1 | 400 s, no configurable | developers.cloudflare.com/fundamentals/reference/connection-limits/ | VERIFICADO |
| Cloudflare: Cloudflare a origen, inactividad del proxy | 900 s, no configurable | idem | VERIFICADO |
| Cloudflare: lectura del proxy (524) | 125 s, configurable solo en zonas Enterprise | idem | VERIFICADO |
| Cloudflare: cifra de 100 s de inactividad para WebSocket | aparece en fuentes de terceros y comunidad; la página oficial leída no la menciona | websocket.org, comunidad | NO VERIFICADO como oficial; tratar como indicio |
| Cuotas de WebSocket de Amazon API Gateway (inactividad, duración máxima, tamaño de mensaje) | la página leída (`limits.html`) no contenía las cuotas de WebSocket y el intento de página específica devolvió solo el título | docs.aws.amazon.com/apigateway/ | NO VERIFICADO. Cualquier cifra recordada de memoria no debe usarse |
| Límites de servicios gestionados de tiempo real concretos | no consultados (no se recomienda proveedor) | documentación de cada proveedor | NO VERIFICADO; la skill debe mandar a leer los del proveedor elegido |

### 3.2 IA: límites de tasa y gasto

| Dato | Valor observado | Fuente | Estado |
|---|---|---|---|
| Anthropic: unidades de límite | peticiones, tokens de entrada y tokens de salida por minuto, por clase de modelo; algoritmo token bucket; 429 con `retry-after` | platform.claude.com/docs/en/api/rate-limits | VERIFICADO |
| Anthropic: solo los tokens de entrada no cacheados cuentan para el límite de entrada en la mayoría de modelos | ver página (hay una excepción para un modelo antiguo) | idem | VERIFICADO |
| Anthropic: topes de gasto mensual por nivel | Start 500 USD, Build 1.000 USD, Scale 200.000 USD, Custom sin tope. Al llegar al tope, 429 sin `retry-after` hasta 00:00 UTC del mes siguiente | idem | VERIFICADO (volátil) |
| Anthropic: tope de gasto propio al alcanzarse | HTTP 400 `invalid_request_error` | idem | VERIFICADO |
| Anthropic: tamaño máximo de petición | Messages 32 MB; Batch 256 MB; Files 500 MB | platform.claude.com/docs/en/api/errors | VERIFICADO (volátil) |
| Anthropic: reintentos del SDK | 2 por defecto, backoff exponencial, respeta `retry-after` | idem | VERIFICADO |
| Anthropic: errores mid-stream | pueden llegar tras un 200 | idem | VERIFICADO |
| OpenAI: dimensiones | RPM, RPD, TPM, TPD, IPM (según modelo); límites por organización y por proyecto; 429 `slow_down` y 503 `server_is_overloaded`; reintentar con backoff exponencial y jitter; aumentar el tráfico de forma gradual (máx. +50 % cada 15 min desde 1M TPM de entrada) | developers.openai.com/api/docs/guides/rate-limits (la URL antigua platform.openai.com redirige con 301) | VERIFICADO |
| OpenAI: niveles de uso (límite mensual) | Free 100 USD, Build 500 USD, Launch 5.000 USD, Grow 200.000 USD, según compras de crédito acumuladas | idem | VERIFICADO (volátil) |
| Google (Gemini API): dimensiones | RPM, TPM, RPD, por proyecto (no por clave); RPD se reinicia a medianoche del Pacífico; niveles según gasto acumulado en Google Cloud; 429 `RESOURCE_EXHAUSTED` | ai.google.dev/gemini-api/docs/rate-limits | VERIFICADO (volátil) |
| Google: límite de gasto en ventana de 10 min | Tier 1: 10 USD, Tier 2: 50 USD, Tier 3: 200 USD | idem | VERIFICADO (volátil) |

### 3.3 IA: datos, retención y región

| Dato | Valor observado | Fuente | Estado |
|---|---|---|---|
| Anthropic: retención por defecto del contenido de la API | contenido de prompts y salidas no se retiene por defecto, con excepción de "Covered Models" que exigen 30 días; los datos retenidos no se usan para entrenar sin permiso expreso; existe ZDR y preparación HIPAA con tabla de elegibilidad por función | platform.claude.com/docs/en/manage-claude/api-and-data-retention (leída por extractos de líneas) | VERIFICADO parcialmente (extractos); leer la página completa antes de afirmar algo concreto sobre una función |
| Anthropic: región de inferencia | parámetro `inference_geo`: `"global"` (por defecto) o `"us"`; solo `"us"` como geografía del workspace (no editable tras crearlo); `"us"` cuesta 1,1x en modelos recientes; los límites de tasa se comparten entre geografías; en Bedrock/Google Cloud la región la fija el endpoint | platform.claude.com/docs/en/manage-claude/data-residency | VERIFICADO (volátil; solo hay "us" y "global", sin opción de la UE en lo leído) |
| OpenAI: entrenamiento con datos de API | por defecto, no se usan para entrenar desde 1 de marzo de 2023, salvo aceptación expresa | developers.openai.com/api/docs/guides/your-data | VERIFICADO |
| OpenAI: retención | registros de monitorización de abuso hasta 30 días por defecto; el estado de aplicación (archivos, hilos, almacenes vectoriales) se conserva hasta que se borre; ZDR con aprobación previa | idem | VERIFICADO |
| OpenAI: residencia de datos | ajuste por proyecto con aprobación comercial; algunas regiones procesan inferencia (EE. UU., Europa EEE+Suiza, EAU para algunos modelos) y otras solo almacenan; recargo del 10 % en modelos elegibles posteriores al 5 de marzo de 2026 | idem | VERIFICADO (volátil) |
| Google (Gemini API): servicios no pagados | el contenido puede usarse para mejorar productos y revisores humanos pueden leerlo; "Do not submit sensitive, confidential, or personal information to the Unpaid Services" | ai.google.dev/gemini-api/terms | VERIFICADO |
| Google: servicios pagados | no se usan los prompts ni respuestas para mejorar productos; se registran un periodo limitado para prevención de abusos y obligaciones legales; usuarios del EEE, Suiza y Reino Unido solo pueden usar servicios pagados al poner clientes API a disposición de usuarios | idem | VERIFICADO |
| Google: claves | no en cliente; proxy de backend; variables de entorno; gestor de secretos; alertas de facturación; rotación en caso de fuga | ai.google.dev/gemini-api/docs/api-key | VERIFICADO |
| OpenAI: seguridad de claves, artículo del centro de ayuda | HTTP 403 | help.openai.com/en/articles/5112595 | NO VERIFICADO (usada la guía de producción en su lugar) |
| Anthropic: afirmación explícita "no exponer la clave en el cliente" | no figura en la visión general de la API leída | platform.claude.com/docs/en/api/overview | NO VERIFICADO como texto literal; la regla se apoya en Google y en el razonamiento de coste |

### 3.4 Nombres, versiones y precios de modelos

No se copian. Las páginas oficiales de límites de Anthropic listan muchas familias y versiones de modelos con cifras distintas por nivel: es el caso más claro de dato que caduca en semanas. La skill debe indicar: "consultar la lista de modelos y los precios del proveedor elegido el día de la decisión", con estas URLs oficiales:

- Anthropic: https://platform.claude.com/docs/en/api/rate-limits (límites) y su página de precios, enlazada desde la de residencia de datos: https://platform.claude.com/docs/en/about-claude/pricing (no leída: NO VERIFICADO su contenido)
- OpenAI: https://developers.openai.com/api/docs/guides/rate-limits
- Google: https://ai.google.dev/gemini-api/docs/rate-limits

### 3.5 Cadena de suministro: valores de herramientas

| Dato | Valor | Fuente | Estado |
|---|---|---|---|
| Dependabot: cooldown por defecto en actualizaciones de versión | 3 días (no aplica a actualizaciones de seguridad); configurable por `default-days` o por semver | docs.github.com, Dependabot options reference (leída solo hasta ~100.000 caracteres de 181.768) | VERIFICADO (volátil, lectura parcial) |
| Dependabot: pinning | no cubierto en la parte leída | idem | NO VERIFICADO |
| OpenSSF Scorecard: número de comprobaciones | 18 | https://scorecard.dev/ | VERIFICADO (volátil) |
| GitHub: SBOM exportable en SPDX y attestations de procedencia | disponibles; attestations en repositorios públicos, deben generarse explícitamente | docs.github.com, about supply chain security | VERIFICADO (la disponibilidad en repositorios privados no se comprobó) |

---

## 4. Fuentes con estado

| Fuente | URL | Estado |
|---|---|---|
| MDN, Using server-sent events | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events | LEÍDA. No dice si SSE solo admite GET ni confirma `Last-Event-ID` (confirmado en WHATWG) |
| WHATWG HTML, Server-sent events | https://html.spec.whatwg.org/multipage/server-sent-events.html | LEÍDA |
| RFC 6455 (WebSocket) | https://www.rfc-editor.org/rfc/rfc6455 | LEÍDA parcialmente (100.000 de 184.425 caracteres) |
| MDN, WebSockets API | https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API | LEÍDA |
| OWASP WebSocket Security Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html | LEÍDA |
| nginx (proxy_read_timeout, WebSocket) | https://nginx.org/en/docs/http/websocket.html | LEÍDA vía Context7 |
| AWS ELB, Edit attributes (idle timeout) | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html | LEÍDA |
| Cloudflare, Connection limits | https://developers.cloudflare.com/fundamentals/reference/connection-limits/ | LEÍDA (contiene nota dirigida a asistentes: ignorada) |
| AWS API Gateway, cuotas | https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html | ABIERTA pero sin cuotas de WebSocket: NO VERIFICADO |
| OWASP Top 10 for LLM Applications (2025), índice | https://genai.owasp.org/llm-top-10/ | LEÍDA |
| OWASP LLM01 Prompt Injection | https://genai.owasp.org/llmrisk/llm01-prompt-injection/ | LEÍDA (contiene bloque de instrucciones para IA: ignorado). La URL `llm012025-prompt-injection` dio 404 |
| OWASP LLM02, LLM06, LLM10 | https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/ , https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ , https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/ | LEÍDAS |
| Anthropic, rate limits | https://platform.claude.com/docs/en/api/rate-limits | LEÍDA |
| Anthropic, errors | https://platform.claude.com/docs/en/api/errors | LEÍDA |
| Anthropic, API overview | https://platform.claude.com/docs/en/api/overview | LEÍDA |
| Anthropic, data residency | https://platform.claude.com/docs/en/manage-claude/data-residency | LEÍDA |
| Anthropic, API and data retention | https://platform.claude.com/docs/en/manage-claude/api-and-data-retention | LEÍDA parcialmente (extractos) |
| Anthropic, streaming | https://platform.claude.com/docs/en/build-with-claude/streaming | ABIERTA solo en su comienzo (confirma uso de SSE); errores mid-stream confirmados vía página de errores |
| OpenAI, rate limits | https://developers.openai.com/api/docs/guides/rate-limits | LEÍDA |
| OpenAI, your data | https://developers.openai.com/api/docs/guides/your-data | LEÍDA |
| OpenAI, production best practices | https://developers.openai.com/api/docs/guides/production-best-practices | LEÍDA |
| OpenAI, API key safety (help center) | https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety | NO VERIFICADO (403) |
| Google, rate limits | https://ai.google.dev/gemini-api/docs/rate-limits | LEÍDA |
| Google, terms | https://ai.google.dev/gemini-api/terms | LEÍDA |
| Google, API key | https://ai.google.dev/gemini-api/docs/api-key | LEÍDA |
| OWASP Software Supply Chain Security Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html | LEÍDA |
| OWASP Vulnerable Dependency Management Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Vulnerable_Dependency_Management_Cheat_Sheet.html | LEÍDA |
| GitHub, Dependabot security updates | https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates | LEÍDA |
| GitHub, supply chain security | https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-supply-chain-security | LEÍDA |
| GitHub, Dependabot options reference | https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference | LEÍDA parcialmente |
| OpenSSF Scorecard | https://scorecard.dev/ y https://openssf.org/projects/scorecard/ | LEÍDAS |
| OWASP Dependency/Supply chain: SLSA y OpenSSF completos | no consultados más allá de lo citado | NO VERIFICADO |
| Pricing de proveedores de IA | no consultado | NO VERIFICADO |
| SLA de proveedores y marco construir vs integrar | sin fuente leída | criterio propio [inferencia] |

---

## 5. Resumen final (qué cambiaría la recomendación de la skill)

1. Si basta con retraso de segundos y pocos clientes, recomendar sondeo; solo subir a SSE o WebSocket con necesidad medible, no por moda.
2. Si el flujo es solo servidor a cliente (incluido el streaming de un LLM), SSE antes que WebSocket; WebSocket solo si el cliente también envía con baja latencia.
3. Si hay proxy, balanceador o CDN delante, comprobar sus timeouts de inactividad (60 s en nginx y en ALB por defecto, 400 s/125 s/900 s en Cloudflare) y exigir latidos y reconexión con backoff y jitter.
4. Si hay muchas conexiones concurrentes y nadie quiere operarlas, valorar un servicio gestionado, pero solo tras leer sus límites; las cuotas de WebSocket de API Gateway quedan NO VERIFICADAS.
5. La clave de un LLM nunca va en el cliente (Google lo dice textualmente; OpenAI y Anthropic lo cubren por separado menos explícitamente); toda llamada pasa por tu servidor con límite por usuario.
6. Si hay datos personales o confidenciales, cambia el proveedor y el plan: las condiciones de uso de datos difieren entre plan gratuito y de pago (Google), y la región solo ofrece "us"/"global" en Anthropic; exigir ZDR o acuerdo de datos y verificar la región el día de la decisión.
7. Si el producto depende de la IA, añadir capa propia, conjunto de evaluación, fallback y tope de gasto en capas; los topes y niveles cambian y un 429 por tope de gasto no se arregla reintentando.
8. Si el modelo ejecuta acciones, aplicar OWASP LLM06: herramientas mínimas, permisos mínimos y aprobación humana; la inyección no tiene prevención fiable.
9. Construir solo lo que diferencia al producto; auth, pagos y correo se integran salvo razón fuerte, con salida descrita (exportación, interfaz propia).
10. Si hay dependencias de terceros, lockfile, SBOM, alertas de Dependabot y revisión de licencias desde el inicio; el cooldown (3 días por defecto en Dependabot) ayuda frente a versiones maliciosas recién publicadas [inferencia sobre su utilidad].
11. Tratar como datos caducos y con fecha: modelos, precios, cuotas, niveles y regiones; Cloudflare 100 s, cuotas de API Gateway y el contenido completo de retención de Anthropic quedan NO VERIFICADOS o parciales.
12. Contenido dirigido a asistentes de IA detectado en Cloudflare y OWASP LLM01: ignorado y anotado.
