# Fase despliegue e infraestructura. Tema B: observabilidad y operación proporcionales

Fecha de investigación: 2026-10-12. Ninguna página abierta contenía texto dirigido a asistentes de IA (las que mencionan `llms.txt` solo lo enlazan en la navegación; se ignora). Sin proveedores recomendados. Nada instalado.

Leyenda: [V] verificado en la página abierta hoy; [NV] no verificado; VOLÁTIL = puede cambiar, ver fecha.

## 1. Criterios estables

1. **Proporcionalidad.** Observar lo que, si falla, cuesta dinero o confianza; todo lo demás es coste de mantenimiento. SRE book: diseñar la monitorización "con vistas a la simplicidad"; lo que se recoge y nunca se muestra ni alerta es candidato a eliminarse [V sre-book/monitoring-distributed-systems].
2. **Síntoma antes que causa.** Alertar de lo que ve el usuario (no responde, errores, lentitud), no de que "la CPU está al 90%". Los fallos de una sola máquina son "demasiado ruidosos para ser accionables" [V practical-alerting]. Las causas viven en paneles y registros para diagnosticar.
3. **Caja negra para avisar, caja blanca para depurar.** Sondas externas reflejan lo que vive el usuario; las métricas internas explican el porqué [V monitoring-distributed-systems; practical-alerting].
4. **Cuatro señales doradas** para cualquier servicio con usuarios: latencia (separando éxitos de errores), tráfico, errores, saturación [V].
5. **Toda alerta que despierta a alguien debe ser accionable** y requerir criterio humano; si la respuesta es robótica, no debe ser aviso sino automatización o ticket [V].
6. **Tres canales de severidad:** aviso inmediato a la persona de guardia; ticket para lo importante no urgente; panel/dato informativo para el resto [V practical-alerting].
7. **Evitar flapping:** exigir duración mínima o combinar condiciones (ratio y tasa absoluta) para no avisar por picos sin significado, sobre todo con poco tráfico [V practical-alerting].
8. **Registros como flujo de eventos a stdout;** el entorno de ejecución los captura y enruta, la app no gestiona ficheros de log [V 12factor.net/logs].
9. **Minimizar datos en telemetría:** no recoger lo personal salvo que sea imprescindible; revisar qué emiten por defecto las librerías de instrumentación; el hash por sí solo no anonimiza entradas pequeñas y predecibles (p. ej. IDs numéricos) [V OTel handling-sensitive-data].
10. **Secretos fuera del código, de la config versionada y de los logs;** prueba de fuego de 12-factor: ¿se podría abrir el código hoy sin comprometer credenciales? [V 12factor.net/config; OWASP Secrets].
11. **Copias y restauración:** no se repite aquí; enlazar con la fase de datos (copias, pruebas de restauración, RPO/RTO).

## 2. Tabla de niveles

| Tipo de proyecto | Qué observar | Cómo avisar | Operación mínima asociada |
|---|---|---|---|
| **Mínimo**: landing / web estática / sitio de contenido | Disponibilidad desde fuera (sonda HTTP externa a la URL principal y a la del formulario/contacto si existe); caducidad del certificado y del dominio; entrega del formulario (que llega el mensaje) | Correo o mensaje de chat a una persona; sin guardia. Ticket/recordatorio para renovaciones | Quién responde y cómo se revierte el último despliegue; alerta de factura; MFA en hosting, DNS y dominio |
| **Medio**: aplicación o web con backend, API pequeña, sin cobro crítico | Lo anterior + tasa de errores (5xx y excepciones no controladas), latencia de las rutas principales, registros estructurados centralizados, saturación básica (disco, memoria, cola), éxito de tareas programadas | Aviso al canal del equipo en horario laboral por síntoma sostenido (errores/latencia por encima de umbral durante X minutos); resto a ticket | Informe de errores sin datos personales; revisión mensual de costes y dependencias; procedimiento de reversión escrito |
| **Alto**: SaaS de pago / API con clientes que dependen de ella | Lo anterior + trazas distribuidas para localizar la causa, SLIs de los flujos críticos (login, pago, API principal), SLO ligero con alertas de consumo de presupuesto de error, comprobaciones sintéticas del recorrido completo, auditoría de seguridad (autenticación, autorización, cambios de privilegios) | Guardia con rotación y canal de aviso con confirmación y escalado; ticket para consumo lento del presupuesto; página de estado/comunicación a clientes | Roles de incidente definidos, postmortem sin culpa, simulacros de reversión y restauración, topes de gasto y revisión mensual formal |

Criterio de salto de nivel (propuesta, no de fuente): subir de nivel cuando una caída de una hora ya tiene coste económico o contractual concreto, o cuando más de una persona toca producción.

## 3. Los tres pilares y OpenTelemetry

**Pilares:** registros (eventos con marca de tiempo), métricas (mediciones numéricas en el tiempo), trazas (recorrido de una petición por el sistema) [V opentelemetry.io/docs/what-is-opentelemetry y /docs/concepts/signals]. Las trazas y métricas sirven para ver qué pasa y dónde; los registros para el detalle. Para un proyecto pequeño, registros estructurados + sonda externa + informe de errores cubren casi todo; trazas se justifican con varios servicios o latencia difícil de localizar (criterio propio, no de fuente).

**Qué es OpenTelemetry** [V]: marco de observabilidad de código abierto, neutral respecto a proveedor y herramienta, proyecto de la CNCF (fusión de OpenTracing y OpenCensus). Cubre: especificación, protocolo OTLP, convenciones semánticas, APIs, SDK por lenguaje, instrumentación (incluida automática) y Collector. **No es un backend:** el almacenamiento y la visualización quedan a otras herramientas. Ventaja para la skill: instrumentar una vez con estándar abierto y poder cambiar de destino sin reescribir. Coste: complejidad; para nivel mínimo es excesivo.

### Madurez por señal (VOLÁTIL, consultado 2026-10-12)

Fuente 1: https://opentelemetry.io/docs/specs/status/ (la página no indica fecha de actualización) [V]

| Señal | API | SDK | Protocolo (OTLP) | Collector |
|---|---|---|---|---|
| Trazas | stable | stable | stable | stable |
| Métricas | stable | **mixed** (la página dice "under active development") | stable | stable; pipelines de métricas experimentales y soporte Prometheus en desarrollo |
| Registros | Bridge API stable (con soporte experimental de convenciones de eventos) | stable | stable | stable |
| Baggage | stable | stable | N/A | N/A |
| Perfiles | no listado | no listado | development | development |

Fuente 2: https://opentelemetry.io/docs/languages/ (por lenguaje) [V, sin fecha en la página]. Aquí la realidad es más desigual que la especificación:

| Lenguaje | Trazas | Métricas | Registros |
|---|---|---|---|
| C++ | Stable | Stable | Stable |
| C#/.NET | Stable | Stable | Stable |
| Erlang/Elixir | Stable | Development | Development |
| Go | Stable | Stable | Release candidate |
| Java | Stable | Stable | Stable |
| JavaScript | Stable | Stable | Development |
| Kotlin | Development | Development | Development |
| PHP | Stable | Stable | Stable |
| Python | Stable | Stable | Development |
| Ruby | Stable | Development | Development |
| Rust | Beta | Stable | Stable |
| Swift | Stable | Development | Development |

Otras notas [V]: /docs/concepts/signals/ lista trazas, métricas, registros y baggage como soportados; eventos y perfiles como "en desarrollo o propuesta". /docs/concepts/signals/profiles/ marca Perfiles como "Alpha".

Lectura para la skill: **trazas = estable en todo; registros y métricas = estables en la especificación pero dependen del lenguaje elegido**, así que la skill debe comprobar la tabla del lenguaje concreto en vez de asumir. Perfiles: no recomendar como base. Discrepancia a tener en cuenta: la página de estado de la especificación da el SDK de registros como estable, mientras la tabla de lenguajes muestra Development en JavaScript y Python; manda la tabla del lenguaje para decidir.

Context7 (/websites/opentelemetry_io) devolvió un ejemplo de `otelcol components` con estabilidad de componentes del Collector (versión 0.96.0, antigua; en ese ejemplo el receptor/exportador otlp tenía trazas y métricas Stable y registros Beta). Es ilustrativo y desfasado; no usarlo como estado actual. El estado actual de cada componente del Collector es NV: no se abrió el registro de componentes.

## 4. Disponibilidad, alertas y a quién se avisa

- **Comprobación externa** [V practical-alerting]: sondas que ejecutan comprobaciones de protocolo desde fuera y reflejan la experiencia real; sondear tanto el frontal como los backends ayuda a localizar. Una comprobación desde la misma infraestructura no detecta fallos de DNS, certificado o red. Que la sonda y la persona avisada no dependan del mismo proveedor que el servicio es criterio propio.
- **Qué comprobar** (criterio propio apoyado en la caja negra): código de respuesta y un contenido esperado, no solo "responde"; caducidad del certificado con margen suficiente para actuar; flujo crítico (login/pago) en nivel alto.
- **Alertas útiles frente a ruido:** síntoma, accionable, con duración mínima, deduplicadas y agrupadas (Alertmanager es el ejemplo del libro de inhibir y agrupar) [V]. OWASP A09:2025 recoge el fallo opuesto: alertas que nunca se revisan o con demasiados falsos positivos [V top10.owasp.org/2025/A09_2025-Security_Logging_and_Alerting_Failures].
- **A quién y cómo:** mínimo, una persona con nombre y un canal que realmente mira (correo no basta si nadie lo lee en fin de semana); medio, canal de equipo en horario; alto, rotación de guardia con confirmación y escalado. El libro separa aviso a guardia, ticket e informativo [V]. La mecánica concreta de escalado/rotación no está en las páginas abiertas: criterio propio.
- **Alertas sobre SLO (nivel alto):** SRE Workbook recomienda alertas multiventana y multi-tasa de consumo (aviso solo si la ventana larga y la corta superan el umbral; la corta es ~1/12 de la larga). Umbrales de ejemplo para SLO 99,9 %: aviso 1 h/5 min tasa 14,4 (2 % del presupuesto), aviso 6 h/30 min tasa 6 (5 %), ticket 3 días/6 h tasa 1 (10 %). El criterio `for:` simple no se recomienda [V sre.google/workbook/alerting-on-slos/].

## 5. SLO en versión ligera

Definiciones [V sre-book/service-level-objectives]: SLI = medida (disponibilidad, latencia, error); SLO = objetivo sobre ese SLI; SLA = contrato con consecuencias (si no hay consecuencia, es SLO).

**Versión ligera:** 1 a 3 SLOs sobre los flujos críticos (por ejemplo "99,5 % de peticiones correctas al mes" y "p95 de latencia del flujo de pago < X"), revisión mensual del consumo, sin automatización compleja al principio.

**Reglas del libro** [V]: no fijar el objetivo según el rendimiento actual sin reflexión; simple (agregaciones complicadas ocultan cambios); tan pocos SLOs como sea posible; si un SLO nunca ayuda a decidir prioridades, quizá no vale la pena; empezar flojo y apretar con el tiempo.

**Cuándo vale la pena:** hay usuarios o clientes que dependen del servicio, varias personas que deben ponerse de acuerdo entre fiabilidad y nuevas funciones, y tráfico suficiente para que el dato signifique algo. **Cuándo es excesivo:** landing o sitio estático (basta la sonda de disponibilidad), proyecto de una persona sin compromiso con terceros, o tráfico muy bajo. Con poco tráfico un único fallo dispara la tasa de consumo (ejemplo del Workbook: 1 fallo de 10 peticiones por hora con SLO 99,9 % = tasa 1000x); mitigaciones del libro: tráfico sintético, agrupar servicios, reintentos con espera, o bajar el SLO/alargar ventana (decisión de producto) [V alerting-on-slos]. Con objetivos extremos también falla: al 90 % el umbral del 2 % nunca se activa en una hora [V].

## 6. Respuesta a incidentes mínima

Base: SRE book "Managing Incidents" y "Postmortem Culture" [V]. Lo siguiente es la versión reducida para proyectos pequeños (adaptación propia).

- **Quién:** una persona responsable del incidente (comanda y decide) y, si hay más gente, solo una persona modifica el sistema; en equipos de una persona, escribir en una nota quién avisa a quién. El libro define cuatro roles: mando, operaciones (única que cambia el sistema), comunicación, planificación [V].
- **Cuándo declarar:** pronto. Criterios del libro: hace falta otro equipo, el cliente lo ve, o sigue sin resolverse tras una hora de análisis [V].
- **Qué canal:** un único canal designado y un documento vivo del incidente con cronología; el libro usa un registro fiable de comunicaciones útil luego para el postmortem [V].
- **Cómo se revierte:** documentado antes del incidente. Prioridad: parar el daño, restaurar servicio y conservar evidencias, antes que buscar la causa raíz [V]. Mecanismo concreto de reversión (versión anterior desplegable, banderas de funcionalidad) depende de la arquitectura: criterio propio.
- **Comunicación:** actualizaciones periódicas a equipo e interesados; nivel alto añade comunicación a clientes (página de estado). Dato propio: acordar quién redacta el mensaje y un texto base.
- **Traspaso:** explícito y confirmado ("ahora eres el mando, ¿de acuerdo?") [V].
- **Revisión sin culpa:** escrita tras el incidente con impacto, mitigación, causas, acciones de seguimiento; centrada en causas contribuyentes, no en personas; supone buena fe; sin información que identifique a usuarios finales. Disparadores sugeridos: caída visible, pérdida de datos, intervención de guardia (reversión), resolución lenta, o fallo de monitorización que obligó a descubrirlo a mano. Un postmortem sin revisar "es como si no existiera" [V postmortem-culture].
- **Practicar:** el libro recomienda ensayar el proceso y rotar roles [V].
- Plan de respuesta formal: OWASP A09 cita NIST SP 800-61r2 [V como mención; el documento NIST no se abrió, NV].

## 7. Registro de errores y datos personales (a nivel de decisión)

OWASP Logging Cheat Sheet [V] indica **no registrar o enmascarar/hashear/cifrar**: código fuente, identificadores de sesión (hash si hace falta seguir eventos), tokens de acceso, contraseñas, cadenas de conexión, claves de cifrado y secretos, datos de tarjeta/cuenta bancaria, datos personales sensibles (salud, identificadores oficiales), información comercialmente sensible, y datos por encima de la clasificación del sistema de logs. Añade: "no registrar datos salvo que esté legalmente sancionado"; excluir datos de usuarios que se opusieron o no consintieron.

Decisiones para la skill:
- Registrar identificadores internos opacos en lugar de correo, nombre o IP completa; si hace falta IP, truncar (ejemplos de OTel: quitar el último octeto IPv4, conservar solo dominio del correo, solo año/mes de una fecha) [V OTel handling-sensitive-data].
- No volcar cuerpos de petición/respuesta, cabeceras de autorización ni cookies en trazas o informes de error; filtrar en el origen o con procesadores del Collector (atributos, filtrado, redacción por lista permitida, transformación) [V].
- Revisar qué emite la instrumentación automática antes de activarla [V].
- Sanear datos de eventos contra inyección en logs (CR/LF y delimitadores; CWE-117) [V].
- Proteger los logs: acceso restringido y auditado, transporte seguro, fuera de rutas web, y diligencia previa antes de enviarlos a terceros (herramienta externa de errores incluida) [V].
- Retención: periodo definido y corto por defecto; OWASP pide retener lo suficiente para forense. Plazo concreto: decisión del proyecto, NV en fuente.
- Sin análisis legal: la skill solo debe marcar "datos personales en telemetría" como decisión que consultar con quien lleve el cumplimiento.

## 8. Control de costes

Fuentes: FinOps Foundation https://www.finops.org/wg/managing-cloud-cost-anomalies/ [V, 2026-10-12]. Lo siguiente combina esa página y criterio propio.

- **Alerta de facturación desde el primer día**, con umbrales sobre gasto real y previsión (la búsqueda muestra que Microsoft Learn lo recomienda; página no abierta, NV).
- **Un presupuesto es mensual y llega tarde:** el Foundation señala que los presupuestos se miden por mes/trimestre/año y dejan sin detectar la variación diaria; la detección de anomalías funciona mejor a escala diaria o de días consecutivos [V]. Para proyectos pequeños, alerta por salto de gasto diario además de la del presupuesto.
- **Enrutar por severidad:** crítico a chat, alto a correo, bajo/medio a revisión periódica [V].
- **Datos con retraso:** los datos de facturación en nube pueden tardar hasta unas 36 horas [V]; un tope "duro" no es instantáneo.
- **Topes:** pregunta de decisión para la skill: ¿el proveedor permite un tope que corte servicio, o solo avisa? Depende del producto, por eso no se generaliza aquí (NV). Riesgo principal: servicios con cobro por uso o por petición sin límite (funciones, egreso, almacenamiento de registros, ingestión de telemetría).
- **Revisión mensual como práctica:** 30 minutos, comparar real con previsión, anotar por qué varió y quién es dueño de cada recurso (etiquetas). El Foundation sugiere retrospectivas mensuales/trimestrales/anuales [V]; la cadencia de 30 min viene de un blog (Cloudaware, no abierto, NV).
- **La propia observabilidad cuesta:** volumen de logs y trazas puede ser el mayor gasto; muestrear trazas y fijar retención (criterio propio).

## 9. Seguridad operativa mínima

- **MFA** [V OWASP MFA Cheat Sheet]: exigir en login, en acciones sensibles (cambio de contraseña/correo, desactivar MFA, elevar a admin) y en todas las rutas (APIs y apps móviles se olvidan); a todos, y sobre todo a administradores. Preferir FIDO2/WebAuthn/passkeys; TOTP estándar como opción práctica por defecto; SMS/llamada es un factor "restringido" según NIST SP 800-63B, desaconsejado con datos personales o financieros. Recuperación con códigos de un solo uso sin convertirla en vía de salto. Para el acceso al panel del proveedor, DNS, repositorio y gestor de secretos aplica el mismo criterio (criterio propio).
- **Mínimo privilegio** [V OWASP Secrets]: personas y servicios acceden solo a los secretos que necesitan; cuentas de servicio con permisos acotados; cuentas separadas por entorno (extensión propia).
- **Secretos** [V]: fuera de código, configuración versionada y logs; rotación regular (automática si se puede); auditar quién los usó; escanear fugas en desarrollo y CI; pasos documentados para revocar, rotar y eliminar un secreto expuesto. Configuración por entorno en variables, gestionada de forma independiente por despliegue [V 12factor.net/config].
- **Dependencias** [V 12factor.net/dependencies; OWASP Vulnerable Dependency Management]: declarar todo en un manifiesto con versiones exactas, no asumir paquetes del sistema; inventario incluyendo transitivas; análisis automático desde el inicio del proyecto; actualizar en entorno de pruebas y promover si pasan las pruebas; actuar sobre dependencias directas. La hoja OWASP no fija cadencia; la cadencia (p. ej. revisión mensual con el control de costes) es decisión propia.
- **Actualizaciones de sistema:** el sistema operativo/imagen base y el runtime se parchean en la misma revisión periódica; con plataformas gestionadas lo hace el proveedor, pero hay que comprobar quién es responsable (NV: no hay fuente abierta específica para esto).
- **Cabeceras** [V OWASP HTTP Headers Cheat Sheet]: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (revisar riesgos de HSTS antes de activar); `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Content-Security-Policy` (compleja, usar su hoja propia); `frame-ancestors` en CSP preferible a `X-Frame-Options: DENY`; `Permissions-Policy` deshabilitando lo que no se use; CORS con orígenes concretos, no `*` salvo API pública; `Cache-Control: no-store` en respuestas sensibles; `Cross-Origin-Opener-Policy`/`Embedder`/`Resource-Policy` según necesidad. No usar `Expect-CT` ni HPKP; no fijar `X-XSS-Protection`; ocultar `Server` y `X-Powered-By`. Los valores son VOLÁTILES. La página del proyecto OWASP Secure Headers no listó cabeceras en la parte accesible y la ancla `#div-headers` dio 404: NV por esa vía.
- **Registro de seguridad** [V Logging Cheat Sheet]: autenticación (éxitos y fallos), fallos de autorización, validación de entrada, cambios de configuración y de privilegios, uso de cuentas admin/compartidas, exportaciones de datos, fallos TLS. Proteger los logs contra manipulación y registrar quién los lee.

## 10. Checklist mínima (cualquier proyecto en producción)

- [ ] Sonda externa a la URL pública (y a la ruta crítica si existe); aviso a una persona con nombre.
- [ ] Alerta de caducidad de certificado y de dominio con margen.
- [ ] Alerta de facturación (real y previsión) y salto diario si es posible.
- [ ] MFA en proveedor, DNS, dominio, repositorio y correo del administrador; recuperación guardada fuera del sistema.
- [ ] Secretos fuera del repositorio; procedimiento de rotación/revocación escrito.
- [ ] Registros a stdout o destino gestionado, estructurados, sin datos personales ni secretos.
- [ ] Reversión del último despliegue documentada y probada una vez.
- [ ] Una persona de contacto y un canal para incidentes; plantilla de mensaje.
- [ ] Revisión mensual de 30 minutos: costes, alertas disparadas (ruido), dependencias y parches.
- [ ] Copias y restauración: ver fase de datos (no repetir aquí).
- Añadir en nivel medio: informe de errores sin PII, métrica de errores y latencia con aviso por síntoma sostenido, escaneo de dependencias automático, cabeceras de seguridad básicas.
- Añadir en nivel alto: SLO ligero con alertas por consumo, trazas, guardia con escalado, postmortem sin culpa, comunicación a clientes, auditoría de eventos de seguridad.

## 11. Fuentes y estado

| Fuente | URL | Estado (2026-10-12) |
|---|---|---|
| OTel, estado de la especificación | https://opentelemetry.io/docs/specs/status/ | V, sin fecha en la página |
| OTel, qué es | https://opentelemetry.io/docs/what-is-opentelemetry/ | V |
| OTel, soporte por lenguaje | https://opentelemetry.io/docs/languages/ | V, sin fecha |
| OTel, señales | https://opentelemetry.io/docs/concepts/signals/ y /profiles/ | V |
| OTel, datos sensibles | https://opentelemetry.io/docs/security/handling-sensitive-data/ | V |
| OTel vía Context7 | /websites/opentelemetry_io | V parcial; ejemplo de Collector de versión 0.96, desfasado |
| SRE book, monitorización | https://sre.google/sre-book/monitoring-distributed-systems/ | V |
| SRE book, alertas prácticas | https://sre.google/sre-book/practical-alerting/ | V |
| SRE book, SLO | https://sre.google/sre-book/service-level-objectives/ | V |
| SRE book, incidentes | https://sre.google/sre-book/managing-incidents/ | V |
| SRE book, postmortem | https://sre.google/sre-book/postmortem-culture/ | V |
| SRE Workbook, alertas sobre SLO | https://sre.google/workbook/alerting-on-slos/ | V |
| OWASP Logging Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html | V |
| OWASP Top 10:2025 A09 | https://top10.owasp.org/2025/A09_2025-Security_Logging_and_Alerting_Failures | V (la URL owasp.org/Top10/2025/... redirige 308 aquí) |
| OWASP Secrets Management | https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html | V |
| OWASP MFA | https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html | V |
| OWASP HTTP Headers | https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html | V |
| OWASP Vulnerable Dependency Mgmt | https://cheatsheetseries.owasp.org/cheatsheets/Vulnerable_Dependency_Management_Cheat_Sheet.html | V |
| OWASP Secure Headers Project | https://owasp.org/www-project-secure-headers/ | V parcial; no lista cabeceras; ancla 404 |
| Twelve-Factor: logs, config, dependencias | https://12factor.net/logs, /config, /dependencies | V |
| FinOps Foundation, anomalías | https://www.finops.org/wg/managing-cloud-cost-anomalies/ | V |
| Microsoft Learn FinOps anomalías; Cloudaware; Opslyft | (solo vistos en resultados de búsqueda) | NV |
| NIST SP 800-61r2, NIST SP 800-63B | no abiertos | NV (solo citados por OWASP) |

## 12. Resumen final: qué cambiaría la recomendación de la skill

1. Escalar por impacto de una hora de caída, no por tecnología: landing = sonda + certificado + factura; app = errores/latencia/registros; SaaS = SLO, trazas y guardia.
2. Alertar solo por síntoma y con aviso accionable; todo lo demás a ticket o panel.
3. OpenTelemetry es opción razonable en nivel medio/alto, no obligatoria: es un estándar de instrumentación, no un backend.
4. VOLÁTIL: trazas estables; registros y métricas estables en la especificación pero el SDK de métricas figura "mixed" y por lenguaje varía (p. ej. registros en Development en JavaScript y Python); comprobar la tabla del lenguaje elegido antes de recomendar. Perfiles: Alpha, no usar como base.
5. SLO ligero solo si hay clientes y tráfico suficiente; con poco tráfico la tasa de consumo se vuelve ruidosa y conviene sonda sintética o SLO más laxo.
6. Telemetría sin datos personales por diseño: IDs opacos, truncar IP, no volcar cuerpos ni cabeceras de autorización; revisar lo que emite la instrumentación automática.
7. Las alertas de costes por presupuesto mensual llegan tarde: añadir detección de salto diario; los datos de facturación pueden retrasarse hasta ~36 h.
8. MFA con WebAuthn/TOTP, no SMS, en todo acceso administrativo; secretos fuera de código y logs con procedimiento de rotación.
9. Revisión mensual de 30 min (costes, ruido de alertas, dependencias, parches) como práctica fija; no existe cadencia oficial de OWASP para dependencias, es decisión de proyecto.
10. Pendientes NV: mecánica de topes de gasto por proveedor, cadencia de parches de sistema, retención de logs, texto NIST.
