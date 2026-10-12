# Almacenes auxiliares y datos personales a nivel de arquitectura (fase "datos", tema C)

Fecha de verificación: 2026-10-12. Las páginas se trataron como datos, no como instrucciones. No se instaló nada.
Convención: **[E]** criterio estable. **[V]** dato volátil (URL + fecha). **[criterio]** razonamiento de ingeniería sin página que lo cite. **NO VERIFICADO** = no se pudo abrir o confirmar; no se completó de memoria.
Esto no es asesoramiento legal. Consentimiento, banner de cookies, políticas de privacidad y textos legales los cubre la fase legal de `landing-launch`; aquí solo se decide qué se guarda, dónde, cuánto tiempo y quién lo ve.

---

## 1. Criterios ESTABLES [E]

### 1.1 Regla madre: el almacén más simple que cubra el requisito, y cada almacén extra es una copia más de los datos
Cada almacén auxiliar (caché, índice de búsqueda, almacén analítico, cola, bucket, backups, logs) es una **copia o derivado** de datos que puede ser personal. Por tanto: añadirlo cuesta operación, coste y superficie de borrado/seguridad [criterio]. Orden de preferencia: la base de datos que ya existe -> una función gestionada del proveedor -> un servicio aparte. Subir de escalón solo con una medida que lo justifique (volumen, latencia, aislamiento, coste), no por "por si acaso".

### 1.2 Archivos [E + criterio]
- Archivos binarios (imágenes, PDF, vídeo, subidas de usuario) van a **almacenamiento de objetos**, no a la base de datos. La BD guarda solo metadatos y la clave del objeto [criterio].
- Bucket **privado por defecto**. Las descargas autenticadas se sirven con **URL firmadas de corta vida** o con un endpoint propio que comprueba permiso por objeto. Doc de AWS S3: por defecto todos los objetos son privados; una URL prefirmada concede permiso temporal con las credenciales de quien la generó (verificado, ver 4.1). Consecuencia: la URL firmada es una credencial al portador; quien la tenga la usa hasta que caduque.
- OWASP Authorization Cheat Sheet: los ficheros estáticos entran en la política de control de acceso; la protección depende de la sensibilidad (se sugiere clasificación de datos); los buckets en la nube se aseguran con las opciones del proveedor (verificado).
- Contenido **público e inmutable** (logos, imágenes del sitio): CDN delante, nombres con hash, caché larga [criterio]. Contenido **privado**: no ponerlo detrás de CDN compartida sin firma/autorización en el borde, o se cachea para todos (ver 1.3).
- Subidas de usuario: subida directa al bucket con URL firmada de escritura (evita pasar el archivo por tu servidor); validar tipo/tamaño; nunca servirlas desde el mismo origen que la app sin cuidado (riesgo XSS por HTML/SVG subido) [criterio].
- Borrado: el objeto también es dato personal si lo es el contenido. Debe poder localizarse por usuario (prefijo o metadato) y borrarse; con versionado activado hay que borrar versiones [criterio].

### 1.3 Caché [E, MDN verificado]
- Cachear primero lo **público e idéntico para todos** (assets, páginas anónimas). Cachear lo personalizado solo con caché **privada** (navegador) o con clave que incluya al usuario.
- MDN (HTTP Caching, verificado): una caché compartida (proxy, CDN, service worker con Cache API) sirve a varios usuarios; si guarda una respuesta personalizada, otros usuarios pueden recibirla (fuga). Una cookie no hace privada una respuesta: hay que marcar `Cache-Control: private` explícitamente. Para páginas personalizadas MDN recomienda `no-cache, private`. `no-store` no borra lo ya almacenado y algunas cachés gestionadas pueden ignorarlo. No usar `Vary` para separar usuarios por cookie; usar `private`.
- Riesgos y reglas [criterio]: (a) clave de caché incompleta (falta tenant/usuario/idioma/rol) = datos de otro usuario; (b) invalidación: preferir TTL corto + invalidación por evento en cambios que importen (permisos, precios, borrado); (c) tras revocar acceso o borrar datos, la caché también debe vaciarse; (d) no cachear respuestas con tokens o datos sensibles; (e) caché de aplicación (Redis, etc.) con TTL y sin ser fuente de verdad: si se pierde, el sistema sigue.
- Regla de arranque: medir antes. Sin problema de latencia o carga medido, no añadir caché de aplicación.

### 1.4 Colas y trabajos en segundo plano [E + criterio]
- Se necesita trabajo en segundo plano cuando la tarea es lenta, depende de un tercero o debe reintentarse (email, procesado de archivos, webhooks, informes, sincronizaciones).
- **Escalón 1: tabla de trabajos en la propia base de datos** si ya hay una BD relacional y el volumen es modesto: da atomicidad con el dato (el trabajo se crea en la misma transacción que el cambio) y menos piezas. PostgreSQL documenta `FOR UPDATE ... SKIP LOCKED` para "evitar contención de bloqueos con varios consumidores accediendo a una tabla tipo cola", y avisa de que da una vista inconsistente de los datos y no es para uso general (verificado, PostgreSQL 18). Existe el patrón "outbox" para publicar eventos de forma fiable [criterio, no verificado en página].
- **Escalón 2: cola/broker gestionado** (SQS, Cloud Tasks, Redis-based, etc.) cuando haya mucho volumen, varios consumidores en máquinas distintas, necesidad de aislar la carga de la BD, o mensajes fan-out. No elegir un broker propio autoalojado sin equipo que lo opere [criterio].
- **Idempotencia y reintentos** (obligatorios sea cual sea el escalón): la entrega es al menos una vez, así que el handler debe tolerar duplicados. Stripe, como referencia verificada: los reintentos con la misma `Idempotency-Key` devuelven la respuesta guardada; las claves pueden eliminarse tras al menos 24 h (API v1); no usar datos personales como clave (verificado). Para webhooks recibidos: registrar los IDs de evento procesados y no reprocesar; no depender del orden; devolver 2xx rápido y procesar después (verificado en docs de Stripe).
- Añadir: backoff exponencial con tope, límite de intentos, cola de "fallidos" revisable, y que el payload del trabajo lleve **IDs, no datos personales completos** (así la cola no es otra copia de datos personales) [criterio].

### 1.5 Búsqueda [E + criterio]
- **Primero la búsqueda de la base de datos.** PostgreSQL FTS (`tsvector`/`tsquery`, índices GIN, diccionarios por idioma, ranking, frases) cubre búsqueda por palabras con normalización lingüística; sus límites descritos en la doc son los de `LIKE`/`ILIKE` (sin ranking, sin soporte lingüístico, sin índice) (verificado, PostgreSQL 18).
- **Motor aparte** (Elasticsearch/OpenSearch/Meilisearch/Typesense/Algolia…) solo si se necesita: tolerancia a errores tipográficos, autocompletado instantáneo, facetas sobre mucho volumen, relevancia afinada, multi-idioma complejo, o la carga de búsqueda perjudica a la BD transaccional. La doc de PostgreSQL no compara con motores externos [no verificado]; esta frontera es criterio.
- Coste de un motor aparte: sincronización (retraso, divergencias), **otra copia de datos personales a borrar**, y control de acceso que debe reaplicarse en la consulta (filtro por tenant/permisos; un índice sin filtro filtra datos de otros). Indexar solo los campos necesarios.
- Inyección: OWASP SQL Injection Prevention: consultas parametrizadas primero; procedimientos almacenados seguros; validación por lista permitida solo si no hay otra opción (p. ej. nombres de columna u orden); el escape se desaconseja. Los términos de búsqueda van como parámetros enlazados (verificado).

### 1.6 Analítica y datos de producto [E + criterio]
- Separar **transaccional** (la verdad operativa del producto) de **analítico** (eventos, agregados) en cuanto las consultas analíticas pesadas compitan con las operativas, o se necesiten otras retenciones/permisos. Al inicio basta una réplica de lectura o tablas de eventos en la misma BD; almacén analítico aparte (columnar) solo con volumen y equipo que lo use [criterio].
- Para la analítica, **minimizar y pseudonimizar al entrar**: eventos con ID interno opaco, sin email/nombre, sin texto libre del usuario, IP truncada o ausente si no es necesaria. El EDPB (Guidelines 4/2019) indica pseudonimizar cuando ya no hace falta identificar y anonimizar o borrar cuando el dato no es necesario (verificado en el PDF, apdos. 53-54 y 82).
- Política distinta del dato transaccional: retención más corta, acceso más amplio pero a datos menos identificables. El enlace con la medición de la landing (qué se mide y con qué consentimiento) es solo conceptual: lo decide la fase legal/medición, no esta.

### 1.7 Datos personales en la arquitectura [E, con artículos verificados en copia no oficial]
Los artículos se leyeron en gdpr-info.eu (copia no oficial); el texto oficial de EUR-Lex **no se pudo abrir** (devolvió contenido vacío en dos URL): citar la fuente oficial como NO VERIFICADO en esta sesión.

| Principio / artículo | Qué dice (resumen verificado en copia no oficial) | Decisión de arquitectura que habilita |
|---|---|---|
| Art. 5(1)(b) finalidad | Fines determinados, explícitos y legítimos; sin tratamiento incompatible posterior | Cada campo y cada almacén tiene una finalidad anotada; no reutilizar datos de un almacén para otro fin sin revisarlo |
| Art. 5(1)(c) minimización | Adecuados, pertinentes y limitados a lo necesario | No recolectar "por si acaso"; no copiar a analítica/búsqueda/logs lo que no hace falta |
| Art. 5(1)(e) limitación del plazo | Identificable no más tiempo del necesario | Plazo de retención por categoría y borrado automático |
| Art. 5(1)(f) integridad y confidencialidad | Seguridad adecuada incl. protección contra pérdida o destrucción | Control de acceso, cifrado, backups |
| Art. 5(2) responsabilidad proactiva | El responsable debe poder demostrar el cumplimiento | Registro de qué se guarda, dónde, por qué y cuánto; registros de acceso |
| Art. 25(1)-(2) desde el diseño y por defecto | Medidas técnicas y organizativas (p. ej. seudonimización) al elegir los medios y durante el tratamiento; por defecto solo los datos necesarios en cantidad, extensión, plazo y accesibilidad; sin exposición pública ilimitada por defecto | Valores por defecto restrictivos: privado, mínimo, retención corta |
| Art. 32(1) seguridad | Medidas según el riesgo: seudonimización y cifrado; confidencialidad, integridad, disponibilidad y resiliencia; restaurar el acceso tras incidente; pruebas periódicas | Cifrado, backups probados, pruebas de restauración |
| Art. 17 supresión | Supresión sin demora en los supuestos del apdo. 1; deber de informar a otros responsables si se hizo público (apdo. 2); excepciones (apdo. 3), p. ej. obligación legal, defensa de reclamaciones | Poder localizar y borrar a una persona en TODOS los almacenes; retener lo que una ley obligue (facturas) separado y justificado |
| Art. 28(3) encargado | Contrato; el encargado trata solo bajo instrucciones, aplica el Art. 32, controla subencargados y **borra o devuelve los datos al terminar** | Cada proveedor SaaS/hosting que toque datos personales = encargado: contrato (DPA), lista de subencargados, salida/borrado |
| Art. 44-46 transferencias | Título de Cap. V: principio general, decisión de adecuación (45), garantías adecuadas (46), derogaciones (49). Solo se verificaron los títulos | Elegir región de datos y proveedores sabiendo dónde residen los datos (ver 2) |
| Art. 9 categorías especiales | Prohibido tratar origen racial/étnico, opiniones políticas, creencias, afiliación sindical, genéticos, biométricos identificativos, salud, vida/orientación sexual, salvo condición del apdo. 2 | Nivel "sensible" de la sección 3 |
| Art. 8 menores | Con consentimiento en servicios de la sociedad de la información dirigidos a un menor: 16 años; los Estados pueden bajar hasta 13 | Si hay menores: verificar edad/consentimiento parental (decisión de producto + legal) |

**Guías de autoridades (leídas):**
- EDPB, Guidelines 4/2019 sobre Art. 25, versión final 2.0 de 20-oct-2020 (página oficial verificada; PDF leído con `pdftotext`). Elementos de limitación del plazo (apdo. 82): procedimientos y funcionalidades de borrado/anonimización; comprobar que no se puede reidentificar ni recuperar lo borrado; **automatizar** el borrado; justificar el plazo; hacer cumplir las políticas de retención y probarlo; **determinar qué datos y cuánto tiempo se guardan en backups y logs**; vigilar el flujo de datos y limitar el almacenamiento "temporal" de copias.
- AEPD, "Protección de datos por defecto" (página oficial verificada): mínimo de cantidad, extensión, **plazo de conservación** y **accesibilidad**. Guías PDF (Privacidad desde el Diseño, oct-2019; Protección de Datos por Defecto, oct-2020) localizadas pero su texto **no se pudo extraer** (PDF binario en WebFetch): NO VERIFICADO su contenido interno.
- ICO (Reino Unido, orientativa; no es la autoridad de la UE): la solicitud de supresión alcanza a las copias de seguridad; si no se pueden sobrescribir de inmediato, hay que ponerlas "beyond use" (no usarlas para ningún otro fin, retenerlas solo hasta que se reemplacen según un calendario) y ser claro con la persona sobre qué pasará (verificado en la página oficial de ICO sobre right to erasure). La EDPB/AEPD no se contrastaron en este punto concreto: **NO VERIFICADO si la AEPD acepta el mismo criterio de "beyond use"**.

### 1.8 Seguridad aplicada a los almacenes (OWASP, verificado) [E]
- **Almacenamiento criptográfico** (Cheat Sheet): AES con claves de al menos 128 bits (256 preferido) y modo autenticado (GCM primero, luego CCM); claves generadas con CSPRNG; claves de cifrado de datos y de claves independientes; claves en HSM/KMS/gestor de secretos y **separadas de los datos que protegen**; nunca en el código ni en el repositorio; rotación definida y probada (si no se reencripta, etiquetar registros con ID de clave); contraseñas con hash de contraseñas, no cifrado reversible; "almacenar la menor cantidad posible de datos sensibles"; elegir la capa de cifrado (aplicación, BD, disco, hardware) según el modelo de amenaza; el cifrado solo no basta, hace falta control de acceso. Consecuencia de borrado: **destruir la clave de un usuario/tenant ("crypto-shredding")** puede hacer ilegibles sus copias, pero esto es criterio de ingeniería, no una afirmación de la página, y su valor jurídico frente al derecho de supresión **NO VERIFICADO**.
- **Autorización** (Cheat Sheet): denegar por defecto; mínimo privilegio; comprobar en cada petición, de forma centralizada (middleware); IDOR: comprobar acceso objeto por objeto y no confiar en ocultar IDs; la hoja prefiere ABAC/ReBAC a RBAC puro para decisiones por objeto o multi-tenant.
- **Registro (Logging)** (Cheat Sheet): no registrar contraseñas, tokens, IDs de sesión, claves, cadenas de conexión ni datos de tarjeta; tratar con cuidado datos personales no sensibles (nombre, email), con seudonimización si no hace falta identidad; registrar eventos de autenticación/autorización, acceso a datos sensibles, cambios de privilegios, importaciones/exportaciones, subidas de archivos, uso/rotación de claves, y registros de consentimiento; proteger los registros contra manipulación, restringir lectura y registrar el acceso a ellos; **conservar durante el periodo requerido y no más**, y los periodos los fijan obligaciones legales/contractuales. Tensión a decidir: los registros de acceso protegen, pero son también datos personales con su propia retención.
- **ASVS**: la página oficial indica la versión estable **5.0.0** (la fecha de publicación no figura en la página; etiqueta también "Bleeding Edge": ambigua). Los capítulos concretos de datos/registro no se verificaron: NO VERIFICADO su numeración. Usar ASVS como lista de verificación por nivel, citando la versión.

### 1.9 Pagos: no tocar datos de tarjeta [E, con detalles volátiles]
- Regla: **delegar el PAN en la pasarela** (redirección a página alojada o campos/iframe de la pasarela) para que los datos de tarjeta no pasen por tus servidores. Stripe (verificado): las integraciones de bajo riesgo envían los datos de pago directamente a Stripe sin pasar por tus servidores, lo que reduce las obligaciones PCI; si manejas PAN sin tokenizar puedes tener que cumplir más de 300 controles. Se puede guardar de forma segura tipo de tarjeta, últimos 4 dígitos y caducidad (según Stripe) y todo lo que devuelva su API.
- La responsabilidad PCI sigue siendo compartida: el comerciante debe seguir validando su cumplimiento (autoevaluación SAQ que le indique su adquirente/marcas) (Stripe, verificado; PCI SSC FAQ 1588: la entidad que acepta la validación, normalmente el adquirente o las marcas, decide qué SAQ aplica).
- Redirección vs iframe (PCI SSC FAQ 1588, verificado): el criterio de elegibilidad sobre scripts de SAQ A **no se aplica a redirecciones** a la pasarela ni a enlaces de pago; sí a páginas del comerciante que incrustan un formulario/iframe. Para iframe hay que proteger la página frente a scripts o conseguir confirmación del proveedor PCI conforme. Implicación de arquitectura: **redirección/Checkout alojado = menos superficie**; iframe exige disciplina con scripts de terceros en la página de pago (CSP, SRI) [criterio].
- Webhooks de la pasarela: verificar firma, TLS, idempotencia (ver 1.4). Nunca registrar datos de tarjeta (OWASP Logging).
- Nunca guardar CVV ni datos de autenticación sensibles; no se verificó la cita exacta del PCI DSS en esta sesión: **NO VERIFICADO el texto de la norma**.

---

## 2. Transferencias y ubicación (decisión de ubicación, no asesoramiento) [V]
- Decisión práctica: **elegir región UE/EEE para base de datos, almacenamiento de objetos, backups, logs y analítica** salvo razón explícita, y listar los encargados/subencargados y dónde tratan datos [criterio]. Cada almacén auxiliar y cada SaaS (email, analítica, soporte, búsqueda gestionada, CDN con logs) es una posible transferencia.
- Comisión Europea, página de decisiones de adecuación (https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en, verificada 2026-10-12): listados Andorra, Argentina, Brasil, Canadá (solo organizaciones comerciales), Islas Feroe, Guernsey, Israel, Isla de Man, Japón, Jersey, Nueva Zelanda, Corea del Sur, Suiza, Reino Unido (renovada en diciembre de 2025 según la página), Estados Unidos (solo organizaciones comerciales adheridas al EU-US Data Privacy Framework; decisión del 10-jul-2023; primer informe de revisión del 9-oct-2024), Uruguay y la Organización Europea de Patentes. **Volátil**: re-verificar antes de afirmar; para EE. UU. hay que comprobar además que el proveedor concreto esté certificado en el DPF (no comprobado aquí).
- Si no hay adecuación, el Cap. V prevé garantías adecuadas (Art. 46) y derogaciones (Art. 49); su contenido detallado **NO VERIFICADO** (solo los títulos en gdpr-info.eu). Derivar a la fase legal/DPO.
- Aspectos como evaluaciones de impacto de transferencias, cláusulas contractuales tipo y acceso de autoridades extranjeras: no investigados.

---

## 3. Clasificación simple de sensibilidad -> consecuencias de arquitectura [criterio, apoyada en 1.7-1.9]

| Nivel | Ejemplos | Qué cambia en arquitectura |
|---|---|---|
| **Pública** | Contenido de marketing, docs, assets del sitio | Puede ir en CDN y caché larga; bucket público solo para esto; integridad (que no la modifique un tercero) |
| **Interna** | Métricas de negocio, configuración, logs sin personales, planes | Detrás de autenticación; sin CDN pública; secretos en gestor de secretos; acceso por rol de empleado |
| **Personal** (RGPD: cualquier dato de persona identificable: email, nombre, IP, ID de usuario enlazable) | Cuentas, pedidos, soporte, eventos con ID | Minimizar; finalidad y retención documentadas por campo/almacén; autorización objeto por objeto; cifrado en tránsito y en reposo; backups con retención definida; localizable por usuario en todos los almacenes para supresión/acceso; encargados con DPA; ubicación decidida; en logs/analítica, seudonimizar |
| **Sensible / regulada** (Art. 9: salud, biométricos, creencias, orientación...; menores; datos de pago; otros regulados por sector) | Historial médico, fotos biométricas, datos de menores, tarjetas | Todo lo anterior más: aislar en almacén/esquema propio con acceso mínimo y registrado; cifrado a nivel de aplicación con claves separadas (KMS); sin copias a caché, búsqueda, analítica o logs; revisión legal previa (base jurídica del Art. 9, posible evaluación de impacto) antes de diseñar; retención mínima; pruebas de restauración y borrado; **pagos: no almacenar, delegar en pasarela**; **menores: verificación de edad/consentimiento parental y valores por defecto de máxima privacidad** (EDPB menciona protecciones específicas para menores y grupos vulnerables, según resumen de terceros, no verificado en el PDF) |

Regla de uso: clasificar por campo, no por proyecto. El nivel de un almacén es el del dato más sensible que contiene. Una copia hereda el nivel del original.

---

## 4. Tabla de decisión: necesidad -> almacén o patrón -> motivo -> contraindicación

| Necesidad | Almacén o patrón | Motivo | Contraindicación / cuándo cambiar |
|---|---|---|---|
| Imágenes/PDF/vídeo del sitio, públicos | Almacenamiento de objetos o hosting estático + CDN, nombres con hash | Barato, escalable, caché larga | Si cambian por usuario o son privados, no usar CDN pública sin autorización |
| Archivos privados de usuario | Bucket privado + URL firmada corta o endpoint con permiso por objeto; metadatos en BD | Los binarios no inflan ni ralentizan la BD; control de acceso por objeto | URL firmada = credencial al portador (caducidad corta, no reenviar); versionado complica el borrado |
| Subidas de usuario grandes | Subida directa a bucket con URL firmada de escritura | No pasa por tu servidor | Hay que validar tipo/tamaño y escanear si es riesgoso; no servir desde el origen de la app |
| Acelerar lecturas públicas o idénticas | CDN / caché HTTP pública | Mejora latencia y carga | Nunca para respuestas personalizadas sin `private` o clave por usuario |
| Acelerar lecturas costosas internas | Caché de aplicación con TTL, clave completa (tenant/usuario/rol) | Reduce carga de BD | Sin carga medida, no añadir; riesgo de datos obsoletos o de otro usuario; vaciar al revocar/borrar |
| Tareas lentas o con terceros (email, procesado) con BD relacional y volumen modesto | Tabla de trabajos en la BD + `SKIP LOCKED` + reintentos + idempotencia | Atomicidad con el dato; menos piezas | Mucho volumen, consumidores muy numerosos o carga que daña la BD -> broker gestionado |
| Alto volumen, fan-out, aislar carga | Cola/broker gestionado (no autoalojado sin equipo) | Desacopla y escala | Más piezas y otra copia de datos: payload con IDs, no datos personales; exige idempotencia igual |
| Webhooks de terceros (pagos) | Endpoint que verifica firma, devuelve 2xx rápido, encola, deduplica por ID de evento | Reintentos y duplicados son normales (Stripe: hasta tres días en modo activo) | No asumir orden de eventos; no hacer lógica pesada antes del 2xx |
| Búsqueda simple de texto en contenido propio | Búsqueda de texto de la BD (p. ej. PostgreSQL FTS + índice GIN) | Sin sincronización ni copia extra; transaccional | Necesidad de tolerancia a typos, autocompletado, facetas a gran escala o relevancia fina -> motor aparte |
| Búsqueda avanzada | Motor aparte (gestionado) | Capacidades que la BD no ofrece | Otra copia a borrar y a proteger; reaplicar permisos en la consulta; indexar solo lo necesario |
| Métricas de producto | Tabla de eventos o servicio de analítica con IDs seudonimizados; retención corta | Separa carga y datos identificables | Almacén analítico propio solo con volumen/equipo; no volcar datos personales completos |
| Informes pesados sobre datos operativos | Réplica de lectura o almacén analítico | Evita competir con la carga transaccional | Una réplica es otra copia: mismos permisos, retención y borrado |
| Pagos con tarjeta | Pasarela con página alojada/redirección (o campos de la pasarela) | El PAN no toca tus servidores; menos alcance PCI | Con iframe, controlar scripts de terceros en la página; revisar con adquirente qué SAQ corresponde |
| Datos sensibles/regulados | Almacén/esquema aislado, cifrado a nivel de aplicación con KMS, acceso mínimo y registrado | Limita impacto de una brecha | Revisión legal antes; no copiar a caché/búsqueda/analítica/logs |
| Datos personales con plazo | Retención por categoría + borrado automático + purga en todos los almacenes | Art. 5(1)(e); EDPB: automatizar | Obligaciones legales de conservación (p. ej. facturación) prevalecen: separar y justificar |
| Derecho de supresión | Mapa de dónde vive cada dato personal + procedimiento de borrado por usuario + política de backups | Art. 17; EDPB/ICO sobre backups | Backups: no se reescriben; definir caducidad y "beyond use" y qué se hace si se restaura (reaplicar borrados) |
| Registros de acceso/seguridad | Logs centralizados, sin secretos/PAN, con retención fijada, acceso restringido | OWASP Logging; Art. 5(2) | Son datos personales: plazo y acceso propios |
| Elegir ubicación de datos | Región UE/EEE por defecto para BD, objetos, backups, logs | Evita transferencias innecesarias | Proveedor sin región UE: tratarlo como transferencia a decidir con la fase legal |

---

## 5. Datos VOLÁTILES con fecha (re-verificar antes de afirmar)
| Dato | Valor visto | URL | Verificado |
|---|---|---|---|
| Decisiones de adecuación / DPF EE. UU. / Reino Unido | Ver sección 2 | https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en | 2026-10-12 |
| PCI SAQ A: criterio de scripts para iframes; 6.4.3, 11.6.1, 12.3.1 retirados de SAQ A; efectivo 1-abr-2025 (PCI DSS v4.0.1) | Según FAQ 1588 (vía búsqueda; la página FAQ no se abrió directamente) | https://www.pcisecuritystandards.org/faqs/1588/ y https://blog.pcisecuritystandards.org/faq-clarifies-new-saq-a-eligibility-criteria-for-e-commerce-merchants | 2026-10-12, resumen de búsqueda |
| PCI: ASV scans en SAQ A con redirección/iframe | Existe FAQ 1604; respuesta **NO VERIFICADA** | https://www.pcisecuritystandards.org/faqs/1604 | no abierto |
| ASVS | 5.0.0 como "última estable" (también "Bleeding Edge" en la misma página) | https://owasp.org/www-project-application-security-verification-standard/ | 2026-10-12 |
| PostgreSQL | Doc 18.6 como actual | https://www.postgresql.org/docs/current/sql-select.html | 2026-10-12 |
| Stripe: claves idempotentes se pueden podar tras >=24 h (API v1); reintentos de webhooks hasta 3 días en modo activo; reenvío manual 15 días (Dashboard) / 30 días (CLI) | Plazos de un proveedor concreto, ilustrativos | https://docs.stripe.com/api/idempotent_requests y https://docs.stripe.com/webhooks | 2026-10-12 |
| AWS S3 URL prefirmadas: consola máx. 12 h; CLI máx. 7 días | Límites de la doc; otros SDK/credenciales pueden limitar más: NO VERIFICADO | https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html | 2026-10-12 |
| Edad de consentimiento de menores (16, rebajable por Estados hasta 13) | Varía por país; el valor nacional **NO VERIFICADO** | https://gdpr-info.eu/art-8-gdpr/ (no oficial) | 2026-10-12 |
| Plazos de retención de facturas/contabilidad por país, plazo de notificación de brechas, importes de sanciones | **NO INVESTIGADO / NO VERIFICADO**. No darlos de memoria | EUR-Lex y autoridad nacional | - |

---

## 6. Fuentes con estado
| Fuente | URL | Estado |
|---|---|---|
| RGPD texto oficial (EUR-Lex) | https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX:32016R0679 y https://eur-lex.europa.eu/eli/reg/2016/679/oj | **NO VERIFICADO**: devolvieron contenido vacío |
| RGPD Arts. 5, 8, 9, 17, 25, 28, 32 y títulos Cap. V (copia no oficial) | https://gdpr-info.eu/art-5-gdpr/ (y art-8, art-9, art-17, art-25, art-28, art-32, chapter-5) | Abierta. Secundaria, no oficial; cotejar con EUR-Lex |
| EDPB Guidelines 4/2019 (Art. 25), v2.0 de 20-oct-2020 | https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-42019-article-25-data-protection-design-and_en (+ PDF v2.0) | Página abierta; PDF leído localmente con pdftotext (apdos. 53-54, 82) |
| AEPD, Protección de datos por defecto | https://www.aepd.es/en/rights-and-duties/fulfill-your-duties/measures-compliance/privacy-default | Abierta |
| AEPD guías PDF (diseño oct-2019, por defecto oct-2020) | https://www.aepd.es/guias/guia-privacidad-desde-diseno.pdf, https://www.aepd.es/guias/guia-proteccion-datos-por-defecto.pdf | Localizadas; contenido **NO VERIFICADO** (PDF binario, no extraído) |
| ICO, right to erasure | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/ | Abierta (RU, orientativa) |
| ICO, storage limitation | URL probada devolvió 404 | **NO VERIFICADO** directamente (solo vía resúmenes de terceros) |
| Comisión Europea, adecuación | URL en sección 2 | Abierta |
| OWASP Cryptographic Storage, Logging, Authorization, SQL Injection Prevention (Cheat Sheets) | https://cheatsheetseries.owasp.org/cheatsheets/{Cryptographic_Storage,Logging,Authorization,SQL_Injection_Prevention}_Cheat_Sheet.html | Abiertas |
| OWASP ASVS | https://owasp.org/www-project-application-security-verification-standard/ | Abierta; sin capítulos ni fecha |
| MDN HTTP Caching | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching | Abierta |
| PostgreSQL 18: SELECT (locking clause), Full Text Search intro | https://www.postgresql.org/docs/current/sql-select.html, https://www.postgresql.org/docs/current/textsearch-intro.html | Abiertas |
| AWS S3 presigned URLs | URL en tabla 5 | Abierta |
| Stripe: guía de seguridad (PCI), idempotencia, webhooks | https://docs.stripe.com/security/guide, /api/idempotent_requests, /webhooks | Abiertas |
| PCI SSC FAQ 1588 y blog | URL en tabla 5 | Solo vía resultado de búsqueda; no abierta directamente. PCI DSS texto normativo no abierto |
| Context7 | - | No se usó: el tema es normativo/arquitectónico y no depende de una biblioteca concreta. |

---

## 7. Resumen final (qué cambiaría la recomendación de la skill)
1. Si el proyecto guarda cualquier dato personal, la recomendación deja de ser solo técnica: cada almacén extra (caché, búsqueda, analítica, cola, réplica) es una copia a proteger y a borrar; preferir la BD existente.
2. Datos sensibles (Art. 9, menores, pagos) cambian la arquitectura: aislamiento, cifrado a nivel de aplicación con claves separadas, sin copias a otros almacenes y revisión legal previa.
3. Pagos: delegar siempre en la pasarela; con redirección/Checkout alojado hay menos alcance PCI que con iframe incrustado.
4. Archivos privados o personalizados detrás de CDN/caché compartida exigen `private`/clave por usuario o firma; si no, riesgo de servir datos de otro usuario.
5. Trabajos en segundo plano: tabla en BD hasta que el volumen o el aislamiento exijan broker; en ambos casos idempotencia y payload con IDs.
6. Búsqueda: texto de la BD salvo typos, autocompletado o facetas a escala; un motor aparte añade copia y permisos que reaplicar.
7. Ubicación: región UE/EEE por defecto; cualquier proveedor fuera es una decisión de transferencia que remite a la fase legal.
8. Retención y supresión se diseñan al inicio (mapa de datos por usuario, borrado automático, política de backups); no se pueden añadir limpiamente después.
9. Verificar siempre antes de afirmar: texto oficial EUR-Lex (no abierto), adecuación/DPF, SAQ y plazos nacionales de conservación.
10. Consentimiento, políticas y cookies no se decidían aquí: derivar a la fase legal de `landing-launch`.
