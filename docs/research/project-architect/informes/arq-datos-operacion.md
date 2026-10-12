# Arquitectura de datos, tema B: operar la base de datos

Fecha de verificación de todo lo marcado VOLÁTIL: 2026-10-12. Método: WebFetch a páginas oficiales y Context7 (Prisma). El contenido de las páginas se trató como dato. Nada se instaló.

Alcance de los ejemplos: se asume PostgreSQL como motor de referencia porque es donde hay fuentes oficiales verificadas; los criterios valen para otros motores, pero los comandos y límites no.

Aviso de seguridad de contenido: la página de regiones de Neon incluía un texto dirigido a asistentes de IA pidiendo enviar feedback a un endpoint externo. Se ignoró; conviene no confiar en ese tipo de texto en páginas de proveedores.

---

## 1. Criterios estables

### 1.1 Gestionada vs autoalojada vs serverless vs BaaS

Cuatro modelos, definidos por quién opera qué:

- **Gestionada (DBaaS: RDS, Cloud SQL, Azure Database, etc.)**: el proveedor aplica parches, copias y failover; tú eliges tamaño, red y esquema. Instancia siempre encendida, coste por hora más almacenamiento más copias.
- **Autoalojada (VM o servidor propio)**: control total (extensiones, versión, configuración, ubicación física). La operación es tuya: parches de seguridad, copias, monitorización, failover, discos llenos.
- **Serverless (compute que escala a cero y se factura por uso)**: coste casi nulo en reposo, ramas/clones baratos. Compromisos: arranque en frío tras suspensión, límites de conexión por tamaño de cómputo, y funciones de sesión limitadas si pasas por un pooler.
- **BaaS (base de datos más auth, storage, API, funciones empaquetados)**: velocidad de arranque máxima. El bloqueo no está solo en la base de datos sino en lo que la rodea (auth, políticas de acceso, storage, APIs generadas).

Ejes de decisión (estables):

| Eje | Qué preguntar |
|---|---|
| Operación | ¿Quién responde a las 3 a.m. si cae o se corrompe? ¿Hay alguien con competencia de DBA? |
| Coste | Perfil de carga: constante (instancia fija suele ser predecible) vs intermitente (serverless). Mirar también copias, egress y réplicas, no solo cómputo. |
| Control | ¿Necesitas extensiones concretas, versión concreta, acceso superusuario, ajuste de parámetros? Los servicios gestionados restringen superusuario y extensiones. |
| Bloqueo | ¿Cuánto del código depende de algo no portable (auth del proveedor, políticas, funciones propietarias)? Ver sección 1.5. |
| Límites | Tamaño máximo, conexiones, retención de copias, pausa por inactividad en planes gratuitos. Son del plan, no del motor. |
| Residencia de datos | Región fijada al crear (en Neon no se puede cambiar; hay que migrar a un proyecto nuevo). Las copias y réplicas también tienen región: comprobar dónde van. Las garantías legales requieren mirar contratos del proveedor, no solo la lista de regiones. |
| Latencia a la app | Base y aplicación en la misma región y, si es posible, zona. Cada consulta cruza la red; una app en región A y base en región B multiplica el coste de cada petición con varias consultas. Con serverless, sumar el arranque en frío. |
| Criticidad | Una landing con formulario tolera horas de caída; un SaaS de pago no. Esto fija RPO/RTO (sección 2). |

Reglas prácticas:
- Un proyecto pequeño con pocos datos no justifica operar su propia base: el coste humano supera al de la gestionada.
- Autoalojar solo si hay un motivo concreto (control, coste a escala, soberanía) Y alguien que asuma copias y restauración probada.
- Elegir BaaS conociendo de antemano la ruta de salida (sección 1.5), no cuando ya hay que salir.

### 1.2 Copias de seguridad y recuperación (conceptos)

- **RPO (Recovery Point Objective)**: cuántos datos puedes perder, medido en tiempo (p. ej. 5 minutos). Lo fija la frecuencia de copia o el archivado continuo de WAL.
- **RTO (Recovery Time Objective)**: cuánto tarda en volver el servicio. Depende del tamaño de datos, del volumen de log a reaplicar y de lo ensayado que esté el procedimiento.
- **Copia lógica** (`pg_dump`/`pg_restore`): exporta SQL o formato custom/directory. Consistente (snapshot al inicio del dump), portable entre versiones mayores y arquitecturas, permite restauración selectiva. Es lenta en bases grandes y no incluye roles ni tablespaces (esos van con `pg_dumpall --globals-only`). No permite PITR.
- **Copia física** (snapshot de volumen o `pg_basebackup`): copia los ficheros del cluster. Rápida de restaurar; ligada a versión mayor y arquitectura; restaura el cluster entero.
- **Recuperación a un punto en el tiempo (PITR)**: copia base física más archivado continuo de WAL; permite elegir un instante, transacción o punto con nombre. Imprescindible para el error humano ("borré la tabla a las 14:03"). Necesita una secuencia ininterrumpida de WAL desde la copia base.
- **Regla de probar la restauración**: una copia que no se ha restaurado es una hipótesis. Restaurar periódicamente en un entorno aparte, comprobar integridad y medir el RTO real. Azure lo dice explícitamente en su FAQ: la mejor forma de validar es hacer PITR periódicos. Postgres documenta además que hay que probar el archivado y la restauración antes de depender de ellos.
- **Dónde guardar copias**: al menos una copia fuera del dominio de fallo de la base (otra cuenta/proyecto, otra región o proveedor), con acceso separado y, si el proveedor lo ofrece, inmutabilidad o borrado diferido. Motivo concreto: en varios proveedores las copias automáticas se borran al borrar la instancia/proyecto (Azure: "all backups that belong to the server are also deleted"; Supabase: borrar el proyecto elimina las copias). Una copia que muere con el recurso no cubre el borrado accidental ni el compromiso de la cuenta. La regla "3-2-1" es de uso común pero no se pudo verificar en una fuente oficial (NO VERIFICADO, ver sección 5).
- **Cifrar las copias** y proteger sus permisos (OWASP Database Security Cheat Sheet).
- Las copias gestionadas suelen ser **no exportables** (Azure: no se pueden exportar los ficheros de backup automáticos ni crear servidores fuera de su servicio). Para portabilidad hay que hacer además un dump lógico propio.
- En muchos proveedores el restore **crea una instancia nueva** (Azure, Cloud SQL) en vez de sobrescribir: planificar redirección de conexiones, firewall, parámetros y réplicas, que no se copian.
- Configuración (`postgresql.conf`, `pg_hba.conf`) no va en el WAL; hay que respaldarla aparte si se autoaloja.
- Autoalojado: si falla el archivado de WAL, `pg_wal/` crece hasta llenar disco y Postgres hace PANIC; el archivado debe monitorizarse.

### 1.3 Migraciones de esquema

- **Por qué versionarlas**: el esquema es parte del código. Migraciones en ficheros, en el repositorio, aplicadas en orden y registradas en una tabla de historial, dan reproducibilidad (mismo esquema en dev, staging y prod), revisión en PR y trazabilidad. Cambiar esquema a mano en producción rompe todo eso.
- **Reglas**: migraciones inmutables una vez aplicadas en un entorno compartido (se corrige con una nueva); una migración por cambio lógico; revisar el SQL generado (Django: `sqlmigrate`; Prisma: marca operaciones destructivas); ejecutarlas desde el pipeline de despliegue, no desde la app al arrancar con muchas réplicas.
- **Patrón expand/contract (parallel change)**, para cambios sin parada porque aplicación y esquema no se despliegan atómicamente y conviven dos versiones:
  1. *Expand*: añadir lo nuevo sin quitar lo viejo (columna nullable o con default, tabla nueva, índice).
  2. *Migrate*: la app escribe en ambos (dual-write), se rellena el histórico por lotes, se verifica, se pasa la lectura a lo nuevo.
  3. *Contract*: cuando nada usa lo viejo, eliminarlo. Cada fase deja el sistema funcional y es reversible hasta el contract.
  - Ejemplo: renombrar columna = añadir nueva, doble escritura, backfill, cambiar lectura, borrar vieja. Nunca `RENAME` directo con la app viva.
  - Riesgo señalado por Fowler: no terminar la fase contract y dejar dos versiones para siempre.
- **Bloqueos en PostgreSQL (doc oficial de `ALTER TABLE`)**: por defecto toma `ACCESS EXCLUSIVE`. `ADD COLUMN` con default no volátil no reescribe la tabla (versiones recientes); con default volátil, columna generada almacenada o identity, sí. Constraints (`CHECK`, FK) se pueden añadir `NOT VALID` y validar después con `VALIDATE CONSTRAINT`, que solo toma `SHARE UPDATE EXCLUSIVE`. Crear índices con `CONCURRENTLY` (mencionado en fuentes secundarias; no se verificó la página oficial de `CREATE INDEX`, NO VERIFICADO).
- **Migraciones y conexión**: ejecutar migraciones por conexión directa, no por pooler en modo transacción (Neon y la guía de Prisma vía Context7 coinciden: los bloqueos y el estado de sesión fallan a través de PgBouncer en modo transacción).
- **Transaccionalidad del DDL**: en PostgreSQL el DDL es transaccional, y Django envuelve cada migración en una transacción (en MySQL no se puede deshacer una migración fallida). Cambia cómo diseñar el rollback según el motor.
- **Bajar (rollback)**: preferir "roll forward" con una migración nueva; los downgrades solo son fiables si el cambio es reversible sin pérdida de datos. Django lanza `IrreversibleError` en operaciones irreversibles; Rails exige `reversible` o `up/down` para SQL crudo.

**Categorías de herramientas (ejemplos solo ilustrativos, no recomendación):**

| Categoría | Ejemplos | Idea |
|---|---|---|
| Migraciones SQL puras (independientes del lenguaje) | Flyway, Liquibase | Ficheros SQL (o changelog) versionados + tabla de historial. Flyway: versionadas (en orden) y repetibles (se reaplican si cambian). |
| Integradas en ORM/framework | Alembic (SQLAlchemy), Prisma Migrate, Django migrations, Rails migrations | Se generan a partir de modelos o DSL; riesgo: la autogeneración no es perfecta, revisar siempre. |
| Cambio de esquema online especializado | pgroll (PostgreSQL) | Automatiza expand/contract. NO VERIFICADO: la página no se pudo confirmar. |

Criterio de elección: usar la herramienta nativa del ORM/framework que ya use el proyecto; añadir una herramienta SQL independiente solo si varios servicios comparten la base o se quiere desacoplar el esquema de un lenguaje concreto.

### 1.4 Pooling de conexiones y límites

- **Por qué importa**: en PostgreSQL cada conexión es un proceso del sistema operativo con memoria y CPU. `max_connections` por defecto es 100 (lo fija `initdb`), solo cambia al reiniciar, y subirlo aumenta la memoria reservada. Además hay `superuser_reserved_connections` (3 por defecto).
- **Serverless agrava el problema**: cada invocación de función puede abrir su propia conexión; picos de tráfico agotan el límite o saturan la base abriendo conexiones nuevas a ritmo alto (RDS Proxy documenta justo este escenario). Los límites además dependen del tamaño de cómputo (Neon: 104 a 0,25 CU hasta 4.000 con 9 CU o más).
- **Solución**: un pooler que multiplexe muchas conexiones cliente sobre pocas reales (PgBouncer, Supavisor, RDS Proxy, o el pool del propio driver en servidores de larga vida).
- **Modos de pool (PgBouncer)**: *session* (soporta todo), *transaction* (la conexión real se asigna solo durante la transacción), *statement* (el más agresivo). El modo transacción **rompe** `SET/RESET`, `LISTEN`, cursores `WITH HOLD`, `PREPARE/DEALLOCATE` a nivel SQL, tablas temporales `PRESERVE/DELETE ROWS`, `LOAD` y advisory locks de sesión. Neon indica que los prepared statements a nivel de protocolo funcionan desde PgBouncer 1.22.0. Supabase indica que en modo transacción hay que desactivar prepared statements en el driver (con ejemplos por driver).
- **Regla**: conexión **pooled** para la app (sobre todo serverless/edge); conexión **directa** para migraciones, `pg_dump`/`pg_restore`, replicación lógica y tareas de administración.
- RDS Proxy: puede "fijar" (pinning) sesiones y perder el beneficio del pool; limitaciones propias (misma VPC, no soporta CancelRequest en PostgreSQL). Cada proxy y pooler gestionado añade una restricción: leer sus limitaciones antes de adoptarlo.
- Dimensionar: (instancias de app) x (tamaño de pool por instancia) debe quedar por debajo del límite de conexiones de la base, dejando margen para migraciones, mantenimiento y herramientas.

### 1.5 Portabilidad y salida de un BaaS

Reducir el bloqueo:
- Usar SQL estándar y tipos comunes; si se usa una extensión o función propietaria, que sea una decisión consciente y anotada (ADR), no un accidente del ORM o del panel.
- Mantener el esquema en migraciones propias en el repo, no solo creado desde el panel del proveedor.
- Hacer dumps lógicos periódicos propios y restaurarlos en otro sitio (local o en otro proveedor) como prueba de portabilidad.
- Aislar el acceso a datos tras una capa propia (repositorios/servicios) para que cambiar de proveedor no toque toda la app.
- Cadena de conexión y credenciales por configuración, nunca fijas en código.

Qué comprobar para salir de un BaaS (checklist):
- Que `pg_dump`/dump estándar funciona y qué **no** incluye. Casos documentados por Supabase: los backups diarios no incluyen contraseñas de roles personalizados ni objetos de Storage; restaurar una copia vieja no recupera objetos de Storage borrados después; hay que recrear manualmente Edge Functions, ajustes de auth, claves de API, ajustes de Realtime y réplicas de lectura (guía de restauración de dashboard, aplicable a proyectos con backups lógicos antiguos).
- Qué parte de la lógica de acceso vive en el proveedor (políticas RLS, funciones, triggers, auth, hooks) y si es SQL exportable o configuración del panel.
- Dónde viven los ficheros (storage) y cómo se exportan, aparte de la base.
- Usuarios y hashes de contraseña de la autenticación: si se pueden exportar y con qué formato, y si el nuevo sistema los acepta (no verificado para ningún proveedor concreto en este informe: NO VERIFICADO).
- Extensiones usadas y su disponibilidad en el destino.
- Región y volumen: tiempo de transferencia y ventana de parada.
- Contrato y plan: retención de datos tras cancelar, pausa por inactividad, fecha de borrado.

### 1.6 Cifrado y secretos

En tránsito:
- Exigir TLS en servidor (`hostssl` en `pg_hba.conf`) y verificar el certificado en cliente. En libpq, `sslmode=require` cifra pero **no protege frente a MITM**; solo `verify-full` (CA + nombre de host) lo hace y es el recomendado en entornos sensibles; el valor por defecto `prefer` no es recomendable en despliegues seguros. Versión mínima TLS por defecto en Postgres 18: 1.2.
- OWASP (Database Security): configurar la base para aceptar solo conexiones cifradas; instalar certificado de confianza; clientes con TLS moderno y verificación del certificado. OWASP TLS Cheat Sheet: preferir TLS 1.3, TLS 1.2 por compatibilidad, desactivar 1.0 y 1.1. Esa hoja no trata las conexiones a bases de datos específicamente.
- Varios proveedores entregan cadena de conexión con `sslmode=require` por defecto: comprobar si ofrecen el certificado raíz para `verify-full`.

En reposo:
- Capas posibles: aplicación, base de datos (TDE), sistema de ficheros/disco, hardware. Cuál sirve depende del modelo de amenaza: el cifrado de disco protege frente a robo físico del soporte, poco frente a un atacante remoto con acceso al sistema (OWASP Cryptographic Storage). Lo más fuerte: no guardar el dato sensible.
- Gestionadas: cifrado en reposo suele ser un ajuste de creación. RDS: solo se puede activar al crear la instancia (o restaurando una copia de snapshot cifrada); no se puede desactivar ni cambiar la clave de una instancia ya cifrada; deshabilitar la clave KMS deja la instancia inaccesible. Azure: cifrado AES-256 siempre activo y no desactivable (copias incluidas).
- Claves separadas de los datos; cifrado de sobre (DEK cifrada por KEK); plan de rotación y conservar claves antiguas mientras haya copias que las necesiten (OWASP Cryptographic Storage).
- Datos especialmente sensibles (documentos de identidad, datos de salud): considerar cifrado a nivel de aplicación columna a columna, con la limitación de que no se puede consultar por esos campos.

Secretos de acceso a la base:
- Nunca en el código ni en el repositorio; fuera del web root y con permisos restringidos (OWASP Database Security).
- Gestor de secretos centralizado, rotación regular, y credenciales dinámicas de corta vida cuando sea posible; revocar en el servicio de destino, no solo reiniciar la app (OWASP Secrets Management).
- Evitar variables de entorno planas cuando haya alternativas, y no pasar secretos por ENV/ARG de Docker (OWASP Secrets Management; la hoja admite que el inyectado por el orquestador es preferible).
- Mínimo privilegio: cuenta distinta por aplicación/servicio y por entorno; la cuenta de la app no es propietaria de la base ni superusuaria; una cuenta aparte (con más permisos) para migraciones (OWASP Database Security).
- Aislamiento de red: la base no debe ser accesible desde internet salvo necesidad; restringir por IP/VPC/red privada.
- CI/CD es entorno de producción: secretos con alcance mínimo y rotados.

---

## 2. Tabla de decisión (situación -> alojamiento -> motivo -> contraindicación)

| Situación | Opción de alojamiento | Motivo | Contraindicación |
|---|---|---|---|
| Landing o web estática con formulario; pocos datos, tolera horas de caída | Base serverless o BaaS en plan gratuito/bajo, o ningún motor propio (servicio de formularios) | Coste casi nulo y cero operación | Los planes gratuitos pueden pausar por inactividad o no tener copias (Supabase free: sin backups automáticos y pausa tras una semana sin actividad; Neon free: ventana de 6 h). No para datos que no puedas perder |
| MVP/SaaS pequeño, equipo sin DBA, carga variable | Gestionada (instancia pequeña) o serverless con pooler | Copias y parches delegados; PITR disponible | Serverless con ORM que usa prepared statements o sesión: revisar compatibilidad con el pooler en modo transacción |
| SaaS en producción con clientes de pago, RPO de minutos | Gestionada con PITR activado, réplica/HA, copia lógica externa independiente | RPO/RTO acotados y operados por el proveedor | Retención PITR del plan puede ser corta (7 a 35 días según proveedor); sin copia externa, depender de una sola cuenta es un riesgo |
| Equipo quiere ir muy rápido y acepta acoplarse (auth, storage, API incluidos) | BaaS | Menos código de infraestructura | Bloqueo mayor (auth, políticas, storage, funciones); definir antes la ruta de salida y hacer dumps propios |
| Serverless/edge con muchas invocaciones concurrentes | Base con pooler (modo transacción) o proxy gestionado | Evita agotar `max_connections` | Funciones de sesión (`SET`, `LISTEN`, advisory locks de sesión) no funcionan; migraciones por conexión directa |
| Necesidad de extensiones concretas, versión fija o parámetros del servidor | Autoalojada, o gestionada que soporte esas extensiones (comprobar la lista) | Control | Autoalojar exige copias, archivado WAL, parches y restauración probados; sin ello, peor que gestionada |
| Residencia de datos estricta (UE, sector regulado) | Gestionada/serverless en región concreta, o autoalojada en infraestructura propia | La región se fija al crear y las copias/réplicas deben quedarse en ella | La lista de regiones no es garantía legal: revisar contrato y ubicación de copias (por ejemplo, geo-redundancia las copia a otra región) |
| API interna/herramienta de equipo con datos reducidos y sin SLA | SQLite/Postgres autoalojado sencillo con dump programado | Mínima complejidad | Un solo servidor sin copia externa y sin restauración probada; Django desaconseja SQLite en producción por limitaciones de DDL |
| Base grande (cientos de GB) con requisito de RTO bajo | Gestionada con snapshots físicos + PITR | La restauración de snapshots no depende del tamaño tanto como la lógica (Azure indica que la restauración desde snapshot no depende del tamaño; el replay de WAL sí) | Dump lógico como única estrategia: horas de restauración |
| Salida prevista de un proveedor | Esquema en migraciones propias + dump periódico probado | Reduce coste de salida | Depender de funciones del panel o del proveedor que no se exportan |

---

## 3. Checklist

### Copias
- [ ] RPO y RTO definidos por escrito (aunque sea una línea) y alineados con el plan contratado.
- [ ] Copias automáticas activas y retención conocida (días).
- [ ] PITR activado si el RPO es de minutos; ventana de PITR comprobada (Cloud SQL: `get-latest-recovery-time`).
- [ ] Al menos una copia lógica propia (`pg_dump -Fc` o directory) en otra cuenta/región/proveedor, cifrada.
- [ ] La copia no se borra al borrar la instancia/proyecto (retención tras borrado o copia final).
- [ ] Protección contra borrado accidental (bloqueo del recurso, protección de borrado, MFA en la cuenta).
- [ ] Restauración probada en entorno aparte, con tiempo medido y fecha anotada; repetir periódicamente (p. ej. trimestral) y tras cambios grandes.
- [ ] Procedimiento de restauración escrito: quién, qué orden, cómo redirigir conexiones, qué no se restaura solo (parámetros, firewall, roles, réplicas, storage).
- [ ] Roles y globales cubiertos (`pg_dumpall --globals-only` si se hace dump por base).
- [ ] Alerta de fallo de copia o de archivado WAL (autoalojado: disco de `pg_wal`).
- [ ] Credenciales de las copias separadas de las de producción.

### Migraciones
- [ ] Esquema en ficheros versionados en el repositorio; el panel del proveedor no es la fuente de verdad.
- [ ] Migraciones aplicadas por el pipeline, con conexión directa, con usuario de migración distinto del de la app.
- [ ] Migración revisada en PR (SQL generado incluido); operaciones destructivas marcadas.
- [ ] Copia/snapshot antes de migraciones destructivas.
- [ ] Cambios incompatibles con expand/contract; fase contract programada y no olvidada.
- [ ] Revisados los bloqueos (`ACCESS EXCLUSIVE`), `NOT VALID` + `VALIDATE`, índices concurrentes, backfills por lotes.
- [ ] Probar la migración contra una copia con volumen realista antes de producción.
- [ ] Estrategia de rollback definida (roll forward por defecto).
- [ ] Una sola ejecución concurrente de migraciones (bloqueo o job único).

### Conexiones y seguridad
- [ ] Pooler en serverless; modo y limitaciones conocidas; prepared statements configurados según el pooler.
- [ ] Conexiones totales previstas por debajo del límite, con margen.
- [ ] TLS exigido en servidor y `verify-full` en cliente cuando sea posible.
- [ ] Cifrado en reposo activo (decidir al crear si el proveedor no permite activarlo después); claves y su rotación documentadas.
- [ ] Secretos en gestor, no en repo ni en imágenes; rotación; cuenta de mínimo privilegio por servicio/entorno.
- [ ] Base no expuesta a internet sin necesidad; reglas de red restrictivas.

---

## 4. Datos volátiles (verificados el 2026-10-12)

Todo lo de esta sección cambia con los planes del proveedor; no debe fijarse en la skill, solo enlazarse y verificarse.

| Proveedor / dato | Valor observado | Fuente | Estado |
|---|---|---|---|
| PostgreSQL docs | Versión mostrada: 18 (18.6) | postgresql.org/docs/current | VOLÁTIL |
| Supabase backups | Pro 7 días, Team 14, Enterprise hasta 30; Free sin backups automáticos; PITR de pago (7/14/28 días, aprox. 100/200/400 USD al mes), exige al menos cómputo Small; activar PITR detiene los backups diarios; RPO de PITR peor caso 2 min | supabase.com/docs/guides/platform/backups | VOLÁTIL, verificado |
| Supabase pricing | Planes Free/Pro/Team/Enterprise; Free 500 MB y pausa tras una semana sin actividad; Pro/Team 8 GB incluidos y 0,125 USD/GB adicional; conexiones por tamaño de cómputo (Micro: 60 directas / 200 pooler; hasta 16XL: 500 / 12.000) | supabase.com/pricing | VOLÁTIL, verificado |
| Neon pricing | Planes Free/Launch/Scale; Free: 1 GB por proyecto, 20 GB total, escribir se bloquea al excederlo, ventana de restauración 6 h; Launch hasta 7 días; Scale hasta 30 días; scale-to-zero: Free 5 min no desactivable, Launch desactivable, Scale configurable; almacenamiento 0,35 USD/GB-mes; restauración instantánea 0,20 USD/GB-mes | neon.com/pricing | VOLÁTIL, verificado |
| Neon regiones | 8 regiones AWS (3 EE. UU., Fráncfort, Londres, Singapur, Sídney, São Paulo); regiones Azure obsoletas y proyectos Free inactivos más de 90 días sujetos a borrado desde 2026-10-05; región fija al crear | neon.com/docs/introduction/regions | VOLÁTIL, verificado |
| Neon conexiones | `max_connections` de 104 (0,25 CU) a 4.000 (9 CU o más); PgBouncer hasta 10.000 clientes | neon.com/docs/connect/connection-pooling | VOLÁTIL, verificado |
| Azure Database for PostgreSQL (flexible server) | Retención 7 (por defecto) a 35 días; RPO de log hasta unos 5 min; almacenamiento de backup gratis hasta el 100 % del almacenamiento aprovisionado; geo-redundancia solo al crear; hasta 7 backups a demanda; LTR hasta 10 años con límites (1 TiB máx., etc.); página con fecha ms.date 2026-07-05 | learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore | VOLÁTIL, verificado |
| Azure precios | Página abre pero con precios no visibles ("$-") | azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/ | NO VERIFICADO (precios) |
| AWS RDS backups | Backups automáticos, PITR dentro del periodo de retención; snapshots manuales hasta 100 por región; los backups automáticos se borran con la instancia salvo que se pida retenerlos | docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html | VOLÁTIL, verificado; el rango de retención no aparece en esta página: NO VERIFICADO |
| AWS RDS precios | Dimensiones: horas de instancia, almacenamiento, almacenamiento de backup, IOPS aprovisionadas, transferencia; sin tarifas específicas de PostgreSQL en esa página | aws.amazon.com/rds/pricing/ | VOLÁTIL, verificado (solo dimensiones) |
| AWS RDS Proxy | 20 proxies por cuenta, hasta 200 secretos por proxy, sin soporte de CancelRequest en PostgreSQL, 16 KB de sentencia provoca pinning | docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html | VOLÁTIL, verificado |
| Google Cloud SQL backups | Tipos: a demanda, automáticas, final; retención de automáticas de 1 día a 10 años según opción; final por defecto 30 días | docs.cloud.google.com/sql/docs/postgres/backup-recovery/backups | VOLÁTIL, verificado (la URL cloud.google.com redirige a docs.cloud.google.com) |
| Google Cloud SQL precios | La página devolvió el contenido truncado | cloud.google.com/sql/pricing | NO VERIFICADO |
| Prisma | En Context7: `migrate dev` (desarrollo), `migrate deploy` (producción, sin shadow database), conexión directa para el CLI; la página de docs consultada por WebFetch describía una CLI distinta ("contract emit", "db migrate") que no se pudo conciliar con Context7 | Context7 /prisma/web; prisma.io/docs | VOLÁTIL; discrepancia entre fuentes, verificar versión instalada |

---

## 5. Fuentes con estado

Estado: OK = abierta y leída; PARCIAL = abierta con carencias; NO VERIFICADO = no abierta o no confirmada.

### PostgreSQL (documentación oficial, versión 18)
- https://www.postgresql.org/docs/current/backup.html — OK (índice del capítulo 25).
- https://www.postgresql.org/docs/current/backup-dump.html — OK (pg_dump, formatos, pg_dumpall, límites).
- https://www.postgresql.org/docs/current/continuous-archiving.html — OK (WAL, base backup, PITR, avisos).
- https://www.postgresql.org/docs/current/runtime-config-connection.html — OK (`max_connections`, TLS).
- https://www.postgresql.org/docs/current/ssl-tcp.html — OK. La tabla de `sslmode` que acompañaba la respuesta venía de conocimiento del resumidor, no de esa página; se confirmó en libpq-ssl.
- https://www.postgresql.org/docs/current/libpq-ssl.html — OK (tabla de `sslmode`, MITM).
- https://www.postgresql.org/docs/current/sql-altertable.html — OK (bloqueos, `NOT VALID`, `ADD COLUMN`).

### Proveedores gestionados (ilustrativos, no recomendación)
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html — OK (parcial en retención).
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html — OK.
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html — OK.
- https://aws.amazon.com/rds/pricing/ — OK (dimensiones).
- https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backups — OK.
- https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr — PARCIAL (no detalla retención por defecto).
- https://cloud.google.com/sql/pricing — NO VERIFICADO (truncada).
- https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore — OK.
- https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/ — PARCIAL (sin precios).
- https://supabase.com/docs/guides/platform/backups — OK.
- https://supabase.com/docs/guides/database/connecting-to-postgres — OK.
- https://supabase.com/docs/guides/platform/migrating-within-supabase/dashboard-restore — OK.
- https://supabase.com/docs/guides/platform/migrating-and-upgrading-projects — OK (el resumen indica lagunas: auth y roles no detallados).
- https://supabase.com/pricing — OK.
- https://neon.com/docs/introduction/branch-restore — OK.
- https://neon.com/docs/connect/connection-pooling — OK.
- https://neon.com/docs/introduction/regions — OK (con texto sospechoso dirigido a IA, ignorado).
- https://neon.com/pricing — OK.

### Migraciones
- https://documentation.red-gate.com/flyway/flyway-concepts/migrations — OK (la URL antigua `/fd/migrations-184127470.html` da 404).
- https://docs.liquibase.com/ — PARCIAL (portada; no confirma formatos de changelog).
- https://alembic.sqlalchemy.org/en/latest/tutorial.html — OK.
- https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production — PARCIAL/discrepante (ver sección 4); Context7 `/prisma/web` — OK.
- https://docs.djangoproject.com/en/stable/topics/migrations/ — OK.
- https://guides.rubyonrails.org/active_record_migrations.html — OK.
- https://martinfowler.com/bliki/ParallelChange.html — OK (expand/migrate/contract).
- https://www.pgroll.com/docs/ — NO VERIFICADO (solo el título).
- Fuentes secundarias de expand/contract (blogs, dev.to) — solo contexto de WebSearch, no se abrieron; no usar como cita.

### Pooling
- https://www.pgbouncer.org/features.html — OK (modos de pool y funciones no soportadas en modo transacción).

### Seguridad (OWASP)
- https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html — OK (poco contenido sobre cifrado en reposo).
- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html — OK.
- https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html — OK.
- https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html — OK (no trata bases de datos específicamente).

### Sin confirmar
- Regla 3-2-1 de copias en fuente oficial (CISA/CMU PDF): el PDF no se pudo leer (binario). NO VERIFICADO. Se menciona en el texto solo como práctica común.
- `CREATE INDEX CONCURRENTLY` en la doc oficial: no abierta. NO VERIFICADO.
- Exportación de usuarios de auth y hashes en BaaS concretos: no verificado.
- Residencia de datos en términos legales (GDPR, certificaciones): fuera de lo verificado.

---

## 6. Resumen final (qué cambiaría la recomendación de la skill)

1. Si el RPO exigido es de minutos o menos, la skill debe exigir PITR y una copia lógica externa; con RPO de horas basta una copia diaria.
2. Si el plan o la capa gratuita no incluye copias ni PITR (Supabase Free; ventana de 6 h en Neon Free), la skill no debe recomendarlo para datos que no se pueden perder.
3. Si hay serverless/edge, el pooler pasa a requisito, con conexión directa para migraciones y atención a prepared statements.
4. Si se usa un BaaS, la skill debe pedir antes la ruta de salida (dump propio, esquema en migraciones, inventario de lo no exportable) y avisar de que backups gestionados no equivalen a portabilidad.
5. Si el proveedor no deja activar cifrado en reposo después de crear (RDS), la decisión se toma al crear; la skill debe preguntarlo al inicio.
6. Si la residencia de datos es obligatoria, mirar también dónde van copias y réplicas (geo-redundancia copia a otra región) y que la región no se cambia sin migrar.
7. Si hay clientes de pago o datos sensibles, `sslmode=verify-full`, mínimo privilegio y gestor de secretos pasan de buena práctica a requisito.
8. Si el equipo no tiene a nadie con competencia de operación, desaconsejar autoalojar salvo motivo concreto.
9. Si se necesita una extensión o versión fija, comprobar su disponibilidad en el proveedor antes de elegirlo.
10. Los precios, retenciones y límites de la sección 4 caducan: la skill debe enlazarlos y verificarlos en el momento, nunca fijarlos.
11. Prisma: hay discrepancia entre la página de docs consultada y Context7; verificar la versión del proyecto antes de dar comandos.
12. Pendientes NO VERIFICADOS (Cloud SQL precios, Azure precios, pgroll, regla 3-2-1, hashes de auth en BaaS) deben marcarse como tales en la skill hasta confirmarlos.
