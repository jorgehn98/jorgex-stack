# Arquitectura de datos, Tema A: tipos de almacenamiento y cuándo hace falta una base de datos

Fecha de verificación: 2026-10-12. Contenido de las páginas tratado como DATOS. No se instaló nada. No se recomienda un "mejor motor".

Convenciones:
- VERIFICADO = la página se abrió y la afirmación sale de ella (cita corta entre comillas, en inglés tal cual).
- [criterio] = juicio mío, sin respaldo de fuente primaria.
- NO VERIFICADO = no se pudo abrir o no confirma lo que se buscaba.
- VOLÁTIL = licencias, versiones, funciones: revisar siempre la URL oficial antes de afirmarlo.

---

## 1. Criterios estables

### 1.1 Cuándo NO hace falta una base de datos [criterio, salvo lo indicado]

La pregunta útil no es "qué base uso" sino "qué datos cambian, quién los escribe, cuántos escritores a la vez y qué pasa si se pierden".

| Opción | Basta cuando | Deja de bastar cuando |
|---|---|---|
| Archivos en Git (JSON/Markdown/YAML/MDX) | Contenido editorial o configuración que cambia por despliegue; lo edita el equipo; se quiere historial y revisión gratis | Escriben usuarios finales en tiempo de ejecución; hay escrituras concurrentes; se necesita consultar o filtrar por muchos campos; el contenido cambia sin redespliegue |
| Servicio de terceros (formularios, CMS headless, email/CRM, pagos, auth) | El dato es de un dominio resuelto por un producto (leads, pagos, contenido editorial); no se necesita lógica propia sobre él | Se necesita unir ese dato con datos propios, exportarlo con garantías, o el coste/lock-in supera al de operar una base |
| Hoja de cálculo | Volumen pequeño, un puñado de editores humanos, sin integridad crítica | Datos con relaciones, concurrencia de escritura desde el código, requisitos de auditoría o integridad |
| Almacenamiento de objetos | Binarios (imágenes, PDF, vídeo, exportaciones, copias de seguridad) y datos que se leen enteros por clave | Hay que consultar por contenido o hacer actualizaciones atómicas entre varias claves |
| Base de datos | Hay estado de usuario o negocio, escrituras concurrentes, relaciones, necesidad de consultar, transacciones o integridad | (ver familias) |

Respaldo parcial del almacenamiento de objetos (VERIFICADO, AWS S3, https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html, 2026-10-12):
- "Amazon S3 provides strong read-after-write consistency for PUT and DELETE requests of objects" y "Updates to a single key are atomic."
- Límites: "Updates are key-based. There is no way to make atomic updates across keys." y "Amazon S3 does not support object locking for concurrent writers... the request with the latest timestamp wins."
- Es decir, un almacén de objetos no sustituye a una base cuando hay escrituras concurrentes o atomicidad entre registros. Es una página de un proveedor concreto; otros proveedores de objetos pueden diferir (NO VERIFICADO fuera de S3).

Respaldo de SQLite como "sustituto de archivos ad hoc" (VERIFICADO, ver 1.4): SQLite "works particularly well as a replacement for these ad hoc data files" y su página de formato de archivo de aplicación dice que ofrece escrituras atómicas y evita escribir código propio de E/S. Esto es útil: entre "JSON en disco" y "servidor de base de datos" existe un tramo intermedio.

Criterio para decidir [criterio]: si el dato lo escriben usuarios en producción, o hay más de un proceso/instancia escribiendo, o se perdería dinero/confianza al corromperlo, ya no es "un archivo".

### 1.2 Familias de almacenamiento

Garantías = lo que la documentación oficial confirma. Las filas sin cita en "garantías" son mi síntesis [criterio].

#### Relacional (PostgreSQL, MySQL/InnoDB, MariaDB, SQLite)
- Problema que resuelve: datos con estructura y relaciones, integridad, consultas arbitrarias (joins, agregados) y transacciones.
- Conviene: la mayoría de aplicaciones con estado (cuentas, pedidos, permisos, contenido relacional); cuando las preguntas futuras sobre los datos no se conocen de antemano.
- No conviene: grafos muy profundos como consulta principal, series de billones de filas con analítica pura, caché de latencia mínima, búsqueda con ranking lingüístico avanzado a gran escala.
- Garantías (VERIFICADO):
  - PostgreSQL: aislamiento Read Committed por defecto; Repeatable Read y Serializable existen y exigen reintentos: "Applications using this level must be prepared to retry transactions due to serialization failures." (https://www.postgresql.org/docs/current/transaction-iso.html, doc 18.6). MVCC: "reading never blocks writing and writing never blocks reading" (https://www.postgresql.org/docs/current/mvcc-intro.html).
  - MySQL 8.4: "In MySQL 8.4, InnoDB is the default MySQL storage engine"; "Its DML operations follow the ACID model"; claves foráneas y bloqueo por fila (https://dev.mysql.com/doc/refman/8.4/en/innodb-introduction.html).
  - Esquema: impuesto por la base (tablas tipadas, constraints).
- Extensiones relevantes dentro de PostgreSQL (VERIFICADO):
  - JSON: "most applications should prefer to store JSON data as jsonb"; "even for applications where maximal flexibility is desired, it is still recommended that JSON documents have a somewhat fixed structure"; "It is quite possible for both approaches to co-exist" (https://www.postgresql.org/docs/current/datatype-json.html). Esto cubre buena parte del caso "documental ligero" sin otra base.
  - Búsqueda de texto integrada: LIKE/ILIKE "lack many essential properties" (sin soporte lingüístico, sin ranking, lentos sin índice) y el FTS integrado los aborda (https://www.postgresql.org/docs/current/textsearch-intro.html).
  - Vectorial: la extensión pgvector (no es del núcleo) ofrece búsqueda exacta ("perfect recall") y aproximada con HNSW/IVFFlat con pérdida de recall (https://github.com/pgvector/pgvector). Licencia de pgvector: NO VERIFICADO (la página no la mostró).

#### Documental (MongoDB)
- Problema: agregados anidados, esquema variable por documento, lectura de un documento completo de una vez.
- Conviene: datos que se leen y escriben como unidad autocontenida; estructura heterogénea.
- No conviene: muchas relaciones entre entidades que se consultan cruzadas, o muchas transacciones multi-documento.
- Garantías (VERIFICADO, MongoDB manual): "an operation on a single document is atomic"; hay transacciones distribuidas, pero "a distributed transaction incurs a greater performance cost over single document writes, and the availability of distributed transactions should not be a replacement for effective schema design" (https://www.mongodb.com/docs/manual/core/transactions/). La consistencia de lectura se elige por nivel (`local`, `majority`, `linearizable`, `snapshot`...); con `local` "Data may be rolled back" (https://www.mongodb.com/docs/manual/reference/read-concern/, manual 9.0 "Current" en la fecha). La consistencia es configurable, no un único valor.
- Esquema: flexible por defecto (afirmación general, validación opcional; no verificada en página).

#### Clave-valor / caché (Redis, Valkey)
- Problema: acceso por clave con latencia mínima, contadores, sesiones, colas ligeras, límites de tasa, caché.
- Conviene: datos derivados o efímeros que se pueden reconstruir.
- No conviene como única fuente de verdad de datos que no se pueden perder, salvo que se configure y acepte la persistencia.
- Garantías (VERIFICADO, https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/): hay RDB (instantáneas), AOF (registro), ambos o ninguna persistencia ("sometimes used when caching"). RDB: "you should be prepared to lose the latest minutes of data". AOF con fsync cada segundo: "you can only lose one second worth of writes." La propia página dice que para "a degree of data safety comparable to what PostgreSQL can provide you" se usan ambos. Sin esquema ni consultas relacionales.
- Valkey: "an open source (BSD) high-performance key/value datastore" bajo Linux Foundation (https://valkey.io/). La compatibilidad exacta con Redis no se verificó más allá de lo que dicen terceros en esa página.

#### Columnar / analítica (ClickHouse, DuckDB, almacenes de datos)
- Problema: agregaciones sobre muchísimas filas, informes, analítica de producto.
- Conviene: lecturas analíticas, cargas por lotes o flujo de eventos, volúmenes enormes.
- No conviene como base transaccional de la aplicación (muchas escrituras pequeñas, actualizaciones por fila).
- Garantías: ClickHouse se describe como "a column-oriented SQL database management system (DBMS) for online analytical processing (OLAP)" con consultas que "routinely process billions and trillions of rows" (https://clickhouse.com/docs/intro). Lo que dice sobre transacciones o actualizaciones: NO VERIFICADO (la página no lo trata). DuckDB: NO CONSULTADO.

#### Grafo (Neo4j)
- Problema: consultas centradas en relaciones y recorridos de profundidad variable.
- Conviene: "a project's questions and challenges revolve around the relationship between elements" (recorridos, rutas, conexiones ocultas) (https://neo4j.com/docs/getting-started/get-started-with-neo4j/graph-database/).
- No conviene: datos tabulares con relaciones simples; un join normal basta.
- Garantías ACID de Neo4j: NO VERIFICADO (la página consultada no las menciona).

#### Búsqueda de texto (Elasticsearch, OpenSearch, y FTS integrado de PostgreSQL)
- Problema: ranking por relevancia, facetas, tolerancia a erratas, análisis lingüístico a escala.
- Conviene: cuando el FTS de la base principal no alcanza en ranking, volumen o funciones de búsqueda.
- No conviene como fuente primaria de verdad: es un índice secundario que se alimenta desde otra fuente [criterio]. La documentación de Elastic consultada no dice nada sobre su uso como almacén primario (https://www.elastic.co/docs/get-started: sin afirmación), así que esto es criterio mío.
- Antes de añadirlo: probar el FTS integrado (VERIFICADO arriba para PostgreSQL).

#### Series temporales (TimescaleDB/Tiger Data, InfluxDB, etc.)
- Problema: métricas e IoT con inserciones por marca de tiempo, retención y agregación por ventanas.
- Documentación de TimescaleDB: NO VERIFICADO (https://docs.timescale.com redirige a tigerdata.com y esa página devolvió 404). No se cita nada de ella.

#### Vectorial (pgvector, bases vectoriales dedicadas, S3 Vectors)
- Problema: similitud semántica sobre embeddings.
- Conviene: RAG, recomendación, búsqueda semántica.
- Matiz verificado: la búsqueda aproximada cambia resultados respecto a la exacta ("Adding an approximate index trades some recall for speed"). pgvector permite guardar vectores "with the rest of your data" (https://github.com/pgvector/pgvector).
- S3 también ofrece "vector buckets" (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html).
- Documentación de motores vectoriales dedicados: NO CONSULTADA.

### 1.3 Regla por defecto

"Empezar por una base relacional de propósito general salvo que un requisito la descarte."
- Respaldo en fuente primaria: NO ENCONTRADO como recomendación oficial. Ninguna documentación consultada dice "empiece por relacional". Marcar como **[criterio]**.
- Argumentos verificables que la sostienen (no la prueban):
  - MongoDB admite que el modelado correcto reduce la necesidad de transacciones y que las distribuidas no sustituyen al buen diseño de esquema.
  - PostgreSQL cubre JSON (`jsonb`), búsqueda de texto y, con extensión, vectores, así que una sola base puede aplazar la adopción de otras familias.
  - Redis dice que su persistencia combinada busca seguridad "comparable to what PostgreSQL can provide".
- Qué requisitos la descartan [criterio]: datos que solo se leen enteros por clave (objetos), analítica masiva de eventos, grafo como consulta dominante, caché pura, dispositivo local sin servidor (ahí SQLite sigue siendo relacional pero embebido).
- Advertencia: la regla es un punto de partida para decidir con menos riesgo, no una prueba de superioridad. No es válida si el equipo ya opera otra tecnología con éxito y los requisitos la satisfacen.

### 1.4 SQLite (VERIFICADO, https://www.sqlite.org/whentouse.html, "Appropriate Uses For SQLite", 2026-10-12)

La página contiene la sección "Situations Where A Client/Server RDBMS May Work Better" (no se encontró una página separada con el título "Distributed Or Client/Server RDBMS"; el contenido está en esta misma).

Cuándo sí:
- "SQLite works great as the database engine for most low to medium traffic websites (which is to say, most websites)."
- Dispositivos embebidos/IoT, formato de archivo de aplicación, análisis de datos, caché de datos empresariales, formato de transferencia, "Replacement for ad hoc disk files", pruebas y demos.
- Lista de verificación de la página: red entre datos y aplicación -> cliente/servidor; muchos escritores concurrentes -> cliente/servidor; datos grandes -> cliente/servidor; si no: "For device-local storage with low writer concurrency and less than a terabyte of content, SQLite is almost always a better solution."

Cuándo no:
- "If there are many client programs sending SQL to the same database over a network, then use a client/server database engine instead of SQLite."
- Sitios de escritura intensiva o que "requires multiple servers": "consider using an enterprise-class client/server database engine".
- Concurrencia: "SQLite supports an unlimited number of simultaneous readers, but it will only allow one writer at any instant in time."
- WAL (https://www.sqlite.org/wal.html): "All processes using a database must be on the same host computer; WAL does not work over a network filesystem"; "there can only be one writer at a time".
- Formato de archivo de aplicación (https://www.sqlite.org/appfileformat.html): resiste archivos malformados pero abrir archivos no confiables puede suponer riesgos.

Consecuencia práctica [criterio]: SQLite sirve para webs de poco tráfico, herramientas internas, apps de escritorio/móvil y prototipos con una sola instancia de servidor y disco persistente. No sirve si hay varias instancias de aplicación escribiendo, plataformas sin disco persistente o requisitos de réplica/alta disponibilidad gestionada. Para entornos sin disco persistente (algunos serverless), confirmar con el proveedor [criterio, no verificado].

### 1.5 Consistencia y teorema CAP

Consistencia fuerte frente a eventual (conceptos estables) [criterio de exposición, con evidencia de productos]:
- Fuerte: tras una escritura confirmada, cualquier lectura posterior la ve. Compromiso: más latencia o menos disponibilidad ante fallos de red/réplicas.
- Eventual: las réplicas convergen con el tiempo; las lecturas pueden ver datos viejos. Compromiso: menor latencia/mayor disponibilidad a cambio de manejar anomalías en la aplicación.
- No es una propiedad fija del motor: depende de la configuración. Evidencia: MongoDB elige consistencia por operación (`local` puede revertirse; `majority` es duradera; `linearizable` refleja todas las escrituras confirmadas por mayoría, es "slower" y solo aplica a un documento) (https://www.mongodb.com/docs/manual/reference/read-concern/). S3 ofrece lectura fuerte tras escritura por objeto pero no atomicidad entre claves ni bloqueo para escritores concurrentes (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html). Redis con réplicas y fsync parcial: puede perder escrituras recientes (https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).
- En una sola base relacional, el aislamiento de transacciones es otro eje distinto: Read Committed (por defecto en PostgreSQL) frente a Serializable, que obliga a reintentar (https://www.postgresql.org/docs/current/transaction-iso.html).

Advertencias sobre CAP (fuentes primarias):
- Brewer, "CAP Twelve Years Later: How the 'Rules' Have Changed", IEEE Computer, 2012; copia autorizada en InfoQ, 2012-05-30 (https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/, VERIFICADO): "the '2 of 3' view is misleading on several fronts"; "because partitions are rare, there is little reason to forfeit C or A when the system is not partitioned"; "CAP prohibits only a tiny part of the design space"; "all three properties are more continuous than binary".
- Kleppmann, "A Critique of the CAP Theorem", arXiv:1509.05393, 2015-09-17 (https://arxiv.org/abs/1509.05393, VERIFICADO por paráfrasis del resumen): detecta ambigüedades en las definiciones y problemas de formalización; matiza la lectura común de que las bases eventualmente consistentes tienen mejor disponibilidad; propone el marco "delay-sensitivity".
- Uso en la skill [criterio]: no usar "CAP" como argumento para elegir motor; sirve solo para recordar que, ante partición de red, hay que decidir qué se sacrifica, y que eso se configura por operación.

### 1.6 Multi-tenencia en SaaS

Patrones y compromisos. Para el patrón de esquema por inquilino no hay fuente oficial de compromisos en lo consultado; es [criterio].

| Patrón | Aislamiento | Coste/densidad | Operación | Notas |
|---|---|---|---|---|
| Base compartida con columna de inquilino (tablas comunes + `tenant_id`) | Lógico; depende de que la aplicación o RLS filtren bien | Mayor densidad, menor coste | Un solo esquema que migrar, una sola copia de seguridad | Microsoft: "highest density of tenants to infrastructure... lowest financial cost"; límites: "scale limits", "noisy neighbors", "Tenant requirements", y "tenant-level schema customization is difficult" |
| Esquema por inquilino (en una misma base) | Intermedio | Intermedio | Migraciones multiplicadas por N esquemas | [criterio] Microsoft advierte contra "table-based isolation" (una tabla por inquilino), que "can't support large numbers of tenants"; análogo a esquemas por inquilino, no equivalente: extrapolación mía. PostgreSQL define esquemas, pero "schemas are not rigidly separated: a user can access objects in any of the schemas in the database they are connected to, if they have privileges", y no menciona multi-tenencia |
| Base por inquilino | Alto, aislamiento más claro | Mayor coste | Más trabajo: despliegue, migraciones y supervisión automatizados | Microsoft: "each tenant's data is isolated... you might be able to support some degree of customization"; advierte que sin automatización "the complexity... becomes overwhelming"; sirve cuando hay claves propias, copias por inquilino o ubicaciones distintas |

Fuentes: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data (VERIFICADO; página actualizada según metadatos el 2026-10-11, orientada a Azure pero los compromisos son generales), https://www.postgresql.org/docs/current/ddl-schemas.html (doc 18.6).

Condiciones que empujan hacia más aislamiento (Microsoft, VERIFICADO): inquilinos con claves de cifrado propias, políticas de copia/restauración propias, o ubicación geográfica distinta. La restauración de un solo inquilino en base compartida "might require you to restore the database to a separate resource and selectively recover that tenant's data".

Mezcla posible: "use a multitenant database for most of your tenants but deploy single-tenant stamps for tenants who pay more or who have unusual requirements" (misma fuente).

Autenticación no es aislamiento (AWS, VERIFICADO, https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html; la página se declara "for historical reference only"): "a user could be authenticated and authorized, and still access the resources of another tenant."

Seguridad a nivel de fila en PostgreSQL (VERIFICADO, https://www.postgresql.org/docs/current/ddl-rowsecurity.html, doc 18.6):
- Activar: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; después "all normal access to the table... must be allowed by a row security policy."
- Denegación por defecto: "If no policy exists for the table, a default-deny policy is used."
- Excepciones: "Superusers and roles with the BYPASSRLS attribute always bypass the row security system"; los propietarios de la tabla normalmente la eluden salvo `FORCE ROW LEVEL SECURITY`; `TRUNCATE` y `REFERENCES` no están sujetos; las comprobaciones de integridad referencial "always bypass row security".
- Rendimiento y fugas: las políticas que solo miran la fila actual son "the simplest and best-performing case"; los sub-SELECT pueden provocar condiciones de carrera con fuga de información; hay riesgo de "covert channel" por claves foráneas.
- Implicaciones [criterio]: la aplicación no debe conectarse con el rol propietario ni con BYPASSRLS; hay que propagar la identidad del inquilino en cada conexión/consulta (en pools de conexiones, esto exige cuidado). Microsoft: "This approach can be complex to design, implement, test, and maintain. Many multitenant solutions don't use row-level security because of those complexities." RLS es una defensa en profundidad, no sustituto de filtrar en la aplicación.
- RLS en otros motores (SQL Server, etc.): NO VERIFICADO en documentación oficial propia. MySQL: NO CONSULTADO sobre RLS.

---

## 2. Tabla de decisión: necesidad -> familia -> motivo -> contraindicación

| Necesidad | Familia | Motivo | Contraindicación |
|---|---|---|---|
| Contenido que cambia solo con despliegues | Archivos en Git (JSON/MD) | Sin servidor, historial, revisión [criterio] | Escritura por usuarios en producción o concurrente |
| Captura de leads/formularios | Servicio de terceros o tabla en la base | Sin operar infraestructura [criterio] | Necesidad de unir datos con el resto del producto |
| Imágenes, PDF, vídeo, exportaciones, copias | Almacenamiento de objetos | Lectura por clave, atomicidad por objeto (S3) | Atomicidad entre claves, bloqueo de escritores concurrentes (S3 no los da) |
| App de un solo servidor, poco tráfico, o herramienta local | SQLite (relacional embebida) | whentouse: webs de tráfico bajo-medio, "less than a terabyte", baja concurrencia de escritura | Varios servidores/clientes en red, muchos escritores, sistema de ficheros en red con WAL |
| SaaS/aplicación con cuentas, pedidos, permisos, integridad | Relacional de propósito general (PostgreSQL, MySQL/InnoDB, MariaDB) | ACID, esquema, constraints, joins; regla por defecto [criterio] | Ver señales de cambio |
| Estructuras anidadas heterogéneas leídas como unidad | Documental, o `jsonb` en PostgreSQL | Atomicidad por documento (MongoDB); `jsonb` con GIN (PostgreSQL) | Muchas relaciones cruzadas; transacciones multi-documento frecuentes (coste según MongoDB) |
| Sesiones, caché, límites de tasa, contadores | Clave-valor (Redis/Valkey) | Latencia mínima | Única fuente de verdad sin aceptar pérdida (RDB: minutos; AOF everysec: ~1 s) |
| Analítica sobre miles de millones de filas | Columnar (ClickHouse, etc.) | Diseñado para OLAP | Carga transaccional con escrituras pequeñas (transacciones: NO VERIFICADO) |
| Recorridos de relaciones profundos | Grafo | Consultas centradas en relaciones | Datos tabulares con relaciones simples |
| Búsqueda con ranking y lenguaje | FTS de la base; motor de búsqueda si no alcanza | PostgreSQL FTS: ranking, lexemas, índice | Motor de búsqueda como fuente de verdad [criterio] |
| Métricas con marca de tiempo y retención | Series temporales o columnar | [criterio] (documentación no verificada) | Pocos datos: una tabla indexada por tiempo basta [criterio] |
| Similitud semántica / RAG | Vectorial (extensión en la base, o dedicada) | pgvector: vectores junto a los demás datos | Esperar resultados idénticos a la búsqueda exacta con índice aproximado |
| SaaS multi-inquilino | Base compartida + `tenant_id` (+ RLS) | Mayor densidad y menor coste | Requisitos de aislamiento duro, claves o regiones por inquilino |

---

## 3. Señales para cambiar de decisión

[criterio], apoyadas donde se indica:
- SQLite -> cliente/servidor: más de una instancia de servidor, escritores concurrentes, base en red (whentouse, wal).
- Archivos en Git -> base: aparece escritura de usuarios, necesidad de filtrar/ordenar por campos, o ediciones sin redespliegue.
- Servicio de terceros -> base propia: necesidad de unir datos, límites de exportación, coste o lock-in.
- Base única -> añadir otra familia: solo cuando se mida que la base actual no cumple (por ejemplo, el FTS no da el ranking requerido; las agregaciones analíticas ralentizan las consultas transaccionales; la caché es necesaria por latencia medida).
- Base compartida -> aislamiento mayor: aparecen claves de cifrado por inquilino, restauración por inquilino, residencia de datos, o un inquilino genera carga que afecta a los demás (Microsoft).
- Consistencia: si el producto no tolera lecturas obsoletas (dinero, inventario), subir el nivel de aislamiento/lectura y diseñar reintentos (PostgreSQL Serializable; MongoDB `majority`/`linearizable`).
- Redis/clave-valor como única fuente: cambiar si la pérdida de segundos o minutos no es aceptable.
- Licencia: si el producto se ofrece como servicio o se redistribuye, revisar la licencia del motor (sección 4).

---

## 4. Datos volátiles (verificados 2026-10-12)

| Dato | Estado verificado | URL oficial |
|---|---|---|
| PostgreSQL, versiones soportadas | 18 (18.6, 2025-09-25, fin 2030-11-14); 17 (17.11, fin 2029-11-08); 16 (16.15, fin 2028-11-09); 15 (15.19, fin 2027-11-11); 14 (14.24, fin 2026-11-12). Política: 5 años por versión mayor | https://www.postgresql.org/support/versioning/ |
| PostgreSQL, licencia | PostgreSQL License, "similar to the BSD or MIT licenses" | https://www.postgresql.org/about/licence/ |
| MySQL | 8.4 documentado, InnoDB por defecto; licencia: servidor y bibliotecas cliente disponibles bajo GPLv2, y licencia comercial para quien no quiera la GPL | https://dev.mysql.com/doc/refman/8.4/en/innodb-introduction.html ; https://www.mysql.com/about/legal/licensing/oem/ |
| MariaDB | La página de versiones menciona 12.3 como serie estable de largo plazo ("maintained for three years"), 13.0 rolling, 13.2 en desarrollo; también 13.1, 11.8, 11.4, 10.11, 10.6 sin estado. Fechas y EOL: NO VERIFICADO. Licencia: NO VERIFICADO | https://mariadb.com/kb/en/mariadb-server-release-dates/ |
| MongoDB | Manual 9.0 marcado "Current". Código del servidor: SSPL v1 para versiones publicadas tras 2018-10-16 (según el README de GitHub; la página oficial de licencia solo muestra el texto de la SSPL; la cláusula 13 impone publicar el código del servicio si se ofrece la funcionalidad como servicio) | https://www.mongodb.com/docs/manual/ ; https://github.com/mongodb/mongo ; https://www.mongodb.com/legal/licensing/server-side-public-license |
| Redis | <= 7.2 BSD-3; 7.4 a 7.8.x RSALv2 o SSPLv1; >= 8.0.0 RSALv2, SSPLv1 o AGPLv3. "RSALv2 is not an open source license", "SSPLv1 is not an open source license", "AGPLv3 is an OSI-approved open source license". El cambio de marzo de 2024 está citado; la fecha de GA de Redis 8: NO VERIFICADO. Función `BACKUP` desde Redis 8.10.0 según la documentación | https://redis.io/legal/licenses/ ; https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/ |
| Valkey | BSD, bajo Linux Foundation | https://valkey.io/ |
| Elasticsearch | Licencias ELv2, SSPL y AGPL (AGPL añadida, anuncio 2024-08-29: "adding another option, and not removing anything") | https://www.elastic.co/blog/elasticsearch-is-open-source-again |
| SQLite | Páginas oficiales consultadas sin versión; WAL: mejoras citadas en 3.11.0 y 3.22.0 | https://www.sqlite.org/whentouse.html ; https://www.sqlite.org/wal.html |
| pgvector | Soporta Postgres 13 y posteriores (Docker pg13 a pg18); licencia no confirmada | https://github.com/pgvector/pgvector |
| Microsoft multitenant | Página con fecha de metadatos 2026-08-21, actualizada 2026-10-11 | https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data |
| AWS tenant isolation | Whitepaper marcado "for historical reference only" | https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html |

Nota: la skill no debe fijar versiones, licencias ni funciones de esta tabla; debe indicar al usuario que las compruebe en la URL oficial el día de la decisión.

---

## 5. Fuentes y estado

| Fuente | Estado |
|---|---|
| SQLite whentouse (Appropriate Uses) | VERIFICADO |
| SQLite appfileformat | VERIFICADO |
| SQLite WAL | VERIFICADO |
| PostgreSQL RLS (ddl-rowsecurity), 18.6 | VERIFICADO |
| PostgreSQL transaction isolation, 18.6 | VERIFICADO |
| PostgreSQL MVCC intro | VERIFICADO |
| PostgreSQL schemas (ddl-schemas), 18.6 | VERIFICADO |
| PostgreSQL JSON types | VERIFICADO |
| PostgreSQL full text search intro | VERIFICADO |
| PostgreSQL licence / versioning | VERIFICADO |
| MySQL 8.4 InnoDB introduction | VERIFICADO |
| MySQL licensing OEM | VERIFICADO |
| MariaDB release dates | PARCIAL (sin fechas ni EOL) |
| MongoDB transactions | VERIFICADO |
| MongoDB read concern (9.0) | VERIFICADO |
| MongoDB production notes (licencia) | NO VERIFICADO (sin mención) |
| MongoDB SSPL texto / GitHub README | VERIFICADO el texto de la licencia; asociación con el servidor vía README de GitHub |
| Redis persistence | VERIFICADO |
| Redis licenses | VERIFICADO |
| Valkey | VERIFICADO |
| Elastic get-started | PARCIAL (sin definición de búsqueda/vectores ni uso como almacén primario) |
| Elastic open source again (blog) | VERIFICADO |
| ClickHouse intro | PARCIAL (sin transacciones/actualizaciones) |
| Neo4j graph database | PARCIAL (sin ACID) |
| TimescaleDB / Tiger Data | NO VERIFICADO (redirección y 404) |
| pgvector (GitHub) | PARCIAL (licencia no vista) |
| AWS S3 Welcome (consistencia) | VERIFICADO |
| Brewer 2012 (InfoQ, copia del artículo IEEE) | VERIFICADO |
| Kleppmann arXiv 1509.05393 | VERIFICADO (resumen, por paráfrasis de la herramienta) |
| Microsoft Azure multitenant storage-data | VERIFICADO |
| AWS SaaS tenant isolation | VERIFICADO (histórico) |
| DuckDB, InfluxDB, OpenSearch, bases vectoriales dedicadas | NO CONSULTADOS |
| Git/Markdown/hoja de cálculo como almacenamiento | Sin fuente primaria; todo [criterio] |
| Context7 | No usado: las páginas oficiales alcanzaron; no se aportó nada adicional |

---

## 6. Resumen final (qué cambiaría la recomendación de la skill)

1. La regla "relacional de propósito general por defecto" es [criterio]; ninguna fuente oficial la afirma. Presentarla como heurística, no como norma.
2. SQLite deja de ser válida con varias instancias de servidor, muchos escritores o base en red (WAL no funciona sobre sistema de ficheros en red).
3. Un almacén de objetos no da atomicidad entre claves ni bloqueo de escritores concurrentes (S3): no sustituye a una base cuando hay concurrencia.
4. Redis/Valkey como fuente única de verdad implica aceptar pérdida (minutos con RDB, ~1 s con AOF everysec) o usar ambos modos.
5. MongoDB: las transacciones multi-documento cuestan y no sustituyen al buen modelado; si el dominio es muy relacional, esto empuja a relacional.
6. La consistencia se configura por operación (MongoDB read concern, aislamiento PostgreSQL); no usar CAP "2 de 3" para elegir motor (Brewer 2012, Kleppmann 2015).
7. Multi-tenencia: base compartida + `tenant_id` es la más barata; subir de aislamiento solo por claves, restauración, residencia de datos o carga ruidosa. Esquema por inquilino: sin fuente oficial de compromisos, [criterio].
8. RLS de PostgreSQL: denegación por defecto, pero los superusuarios, BYPASSRLS y propietarios la eluden; la aplicación no debe conectarse con esos roles. Complejo de propagar identidad (Microsoft).
9. Licencias volátiles: Redis (BSD hasta 7.2; luego RSALv2/SSPLv1; desde 8.0 también AGPLv3), MongoDB SSPL, Elasticsearch (ELv2/SSPL/AGPL): revisar si el producto se ofrece como servicio.
10. Huecos sin verificar que la skill no debe afirmar: series temporales (TimescaleDB), transacciones en ClickHouse, ACID en Neo4j, fechas y licencia de MariaDB, licencia de pgvector.
11. Versiones de PostgreSQL: 14 llega a fin de vida el 2026-11-12; la skill no debe recomendar versiones sin consultar la página de versiones.
