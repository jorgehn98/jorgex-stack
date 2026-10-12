# Verificación Supabase (fuentes oficiales)

Fecha de lectura de todas las fuentes: 2026-10-12. Las páginas se leyeron con WebFetch (resumen automático de la página, no lectura literal completa). Todo lo marcado volátil puede cambiar sin aviso.

Nota de seguridad: la página https://supabase.com/docs contenía un bloque "Agent Prompt" dirigido a asistentes de IA (instalar paquetes y ejecutar `supabase init`). Se ignoró y se anota aquí; no se instaló ni ejecutó nada.

## Tabla de hechos

### 1. Productos

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Postgres completo por proyecto; Auth (email/contraseña, passwordless, OAuth); Storage (archivos, con políticas RLS); Realtime; Edge Functions; Vector/AI; Cron; Queues; Data REST API (más GraphQL listado aparte) | https://supabase.com/docs | verificado | no |
| Cron = extensión `pg_cron`; tareas SQL, funciones o HTTP (p. ej. Edge Function); programación desde por segundo hasta anual | https://supabase.com/docs/guides/cron | verificado | no |
| Queues = sistema de colas sobre Postgres basado en `pgmq`; entrega garantizada, "exactly-once" dentro de una ventana de visibilidad, archivado | https://supabase.com/docs/guides/queues | verificado | no |
| Vectores: pgvector, búsqueda semántica/keyword/híbrida, embeddings en Edge Functions | https://supabase.com/docs/guides/ai | verificado | no |
| Estados por feature: Queues "Public Alpha"; Cron "Beta"; Realtime Broadcast/Presence/Postgres changes GA; Broadcast Authorization "Public Beta"; Vector database GA; Vector Buckets "Public Alpha" | https://supabase.com/docs/guides/getting-started/features | verificado | sí |
| Data API generada con PostgREST en `https://<project_ref>.supabase.co/rest/v1/`; acceso gobernado por RLS, roles y grants | https://supabase.com/docs/guides/api | verificado | no |
| Arquitectura: todos los componentes hablan con una única instancia Postgres; gateway Envoy | https://supabase.com/docs/guides/getting-started/architecture | verificado | no |

### 2. Licencias (LICENSE de cada repositorio, no una sola)

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| supabase/supabase (monorepo, incluye Studio/docs): Apache 2.0 | https://github.com/supabase/supabase/blob/master/LICENSE | verificado (solo el LICENSE raíz; subcarpetas no revisadas) | no |
| supabase/auth (GoTrue): MIT | https://github.com/supabase/auth/blob/master/LICENSE | verificado | no |
| supabase/realtime: Apache 2.0 | https://github.com/supabase/realtime/blob/main/LICENSE | verificado | no |
| supabase/storage: Apache 2.0 | https://github.com/supabase/storage/blob/master/LICENSE | verificado | no |
| supabase/edge-runtime: MIT | https://github.com/supabase/edge-runtime/blob/main/LICENSE | verificado | no |
| supabase/supavisor: Apache 2.0 | https://github.com/supabase/supavisor/blob/main/LICENSE | verificado | no |
| supabase/postgres: The PostgreSQL License | https://github.com/supabase/postgres/blob/develop/LICENSE | verificado | no |
| PostgREST (proyecto de terceros usado por Supabase): MIT, "2014-2026 The PostgREST contributors" | https://raw.githubusercontent.com/PostgREST/postgrest/main/LICENSE (la URL github.com/.../blob devolvió 503) | verificado | no |
| La documentación lista además Deno (MIT), postgres-meta (Apache 2.0), Envoy (Apache 2.0) | https://supabase.com/docs/guides/getting-started/architecture | verificado (solo vía docs, LICENSE no leídos) | no |

### 3. Autoalojamiento

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Método recomendado: Docker Compose. Kubernetes (Operator/Helm) es mantenido por la comunidad. La CLI local es solo para desarrollo y "no debe exponerse a tráfico externo" | https://supabase.com/docs/guides/self-hosting | verificado | no |
| Servicios del Compose: Studio, Envoy (gateway por defecto; Kong opcional), Auth, PostgREST, Realtime, Storage, imgproxy, postgres-meta, Edge Runtime (Deno), Postgres, Supavisor; Logflare y Vector (analítica/logs, opcionales) | https://supabase.com/docs/guides/self-hosting/docker | verificado | sí (la lista cambia con versiones) |
| Requisitos: mínimo 4 GB RAM, 2 CPU, 40 GB SSD; recomendado 8 GB+, 4 CPU, 80 GB+ | https://supabase.com/docs/guides/self-hosting/docker | verificado | sí |
| Limitaciones que admite la doc frente a cloud: un solo proyecto (Studio sin multi-org/multi-proyecto); sin branching, sin backups gestionados ni PITR, sin Management API, sin métricas avanzadas, sin analytics/vector buckets/ETL | https://supabase.com/docs/guides/self-hosting | verificado | sí |
| Responsabilidad del operador: aprovisionar, endurecer seguridad, mantener Postgres, alta disponibilidad, backups/DR, monitoreo. Soporte solo comunitario | https://supabase.com/docs/guides/self-hosting | verificado | no |
| Detalles: SMTP propio para email; HTTPS requiere reverse proxy; Storage local por defecto (opcional backend S3); claves en `.env` (rotación con script); actualizaciones manuales (`update.sh`), snapshots estables ~mensuales; mezclar tags de imagen "no garantizado"; analytics desactivadas por defecto | https://supabase.com/docs/guides/self-hosting/docker | verificado | sí |
| Self-hosted no recolecta telemetría (la CLI sí) | https://supabase.com/docs/guides/self-hosting | verificado | no |
| Disponibilidad por feature en self-hosting (Queues, Cron, etc.) | https://supabase.com/docs/guides/getting-started/features (la columna no se pudo leer) | NO VERIFICADO | sí |

### 4. Plan gratuito y de pago (TODO VOLÁTIL)

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Free: 2 proyectos activos (pausados ilimitados); DB 500 MB (CPU compartida, 500 MB RAM); Storage 1 GB, subida máx. 50 MB; egress 5 GB + 5 GB cached; 50.000 MAU | https://supabase.com/pricing | verificado | SÍ |
| Free: pausa tras 1 semana de inactividad (pricing); la checklist dice "baja actividad en 7 días puede pausarse", restaurable desde dashboard | https://supabase.com/pricing ; https://supabase.com/docs/guides/deployment/going-into-prod | verificado | SÍ |
| Free: sin backups automáticos, sin PITR; no se pueden descargar backups de DB; la doc recomienda exportar con `supabase db dump` y guardar copias externas | https://supabase.com/pricing ; https://supabase.com/docs/guides/platform/backups ; going-into-prod | verificado | SÍ |
| Proyecto pausado: ventana de restauración de 1 año desde Studio; después solo se descargan el backup y los objetos de Storage | https://supabase.com/docs/guides/platform/migrating-and-upgrading-projects | verificado | SÍ |
| Otra página dice: dos organizaciones free, cada una con un proyecto activo | https://supabase.com/docs/guides/troubleshooting/pausing-pro-projects-vNL-2a | verificado (difiere en redacción de pricing; conviene confirmar) | SÍ |
| Pro desde $25/mes, Team desde $599/mes; backups diarios 7 días (Pro), 14 (Team), hasta 30 (Enterprise); Pro/Team no se pausan por inactividad | https://supabase.com/pricing ; backups | verificado | SÍ |
| PITR: add-on en Pro/Team/Enterprise, $100/mes por cada 7 días de retención (pricing); requiere compute mínimo Small; WAL cada ~2 min (RPO peor caso 2 min); activarlo detiene los backups diarios | https://supabase.com/pricing ; https://supabase.com/docs/guides/platform/backups | verificado | SÍ |
| Compute: Pro y Team incluyen Micro y $10/mes de créditos de compute; proyectos adicionales pagan su compute completo | https://supabase.com/pricing | verificado | SÍ |
| Límites Realtime: Free 200 conexiones, 100 mensajes/s; Pro 500/500; Team 10.000/2.500 | https://supabase.com/docs/guides/realtime/limits | verificado | SÍ |
| Límites Edge Functions: 256 MB; wall-clock 150 s Free / 400 s de pago; CPU 2 s por petición; 100 funciones Free, 1.000 Pro | https://supabase.com/docs/guides/functions/limits | verificado | SÍ |
| Qué pasa al superar cuotas / spend cap | https://supabase.com/docs/guides/platform/manage-your-usage (solo índice) | NO VERIFICADO | SÍ |
| Auth por defecto: correo integrado limitado a 2/hora; 30 usuarios nuevos/hora con SMTP propio; OTP 360/hora | https://supabase.com/docs/guides/deployment/going-into-prod | verificado | SÍ |

### 5. Portabilidad

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Supabase declara diseñar para portabilidad (pg_dump, CSV); cloud compatible con self-hosted | https://supabase.com/docs/guides/getting-started/architecture | verificado (declaración de la propia empresa) | no |
| Ruta oficial plataforma -> self-hosted: `supabase db dump` x3 (`roles.sql`, `schema.sql`, `data.sql`; usar la CLI, no pg_dump crudo), restaurar con psql y `session_replication_role = replica` | https://supabase.com/docs/guides/self-hosting/restore-from-platform | verificado | sí |
| Auth: el dump incluye `auth.users` (cuentas conservadas). La guía NO trata los hashes de contraseña por separado; hay que verificar logins tras restaurar. Los JWT/claves de plataforma dejan de valer: nuevos secretos y los usuarios deben reiniciar sesión | https://supabase.com/docs/guides/self-hosting/restore-from-platform | verificado parcialmente (hashes: NO VERIFICADO) | sí |
| La guía de backup/restore por CLI tampoco aclara si las filas de `auth` van incluidas ni cubre hashes | https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore | NO VERIFICADO (hashes) | sí |
| Storage: los dumps SQL NO copian los archivos (solo metadatos). Doc ofrece script Node con supabase-js que descarga y sube cada objeto; la guía a self-hosted dice que Storage "no está cubierto" | https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore ; restore-from-platform | verificado | sí |
| Backups de plataforma no incluyen objetos de Storage; no se restauran objetos borrados | https://supabase.com/docs/guides/platform/backups | verificado | no |
| Storage es S3-compatible (List/Get/Put/Delete/multipart/CopyObject); sin versionado; sin CORS/lifecycle/cifrado de bucket. No se confirma explícitamente rclone/AWS CLI ("casi cualquier cliente S3") | https://supabase.com/docs/guides/storage/s3/compatibility | verificado (compatibilidad con rclone: NO VERIFICADO) | sí |
| Borrar objetos con SQL los deja huérfanos en el bucket; usar la API de Storage | https://supabase.com/docs/guides/storage/management/delete-objects | verificado | no |
| Vault/pgsodium: sin copiar la root key no se descifran los datos en el nuevo proyecto; triggers/RLS añadidos en `auth`/`storage` y Realtime publications, webhooks, import maps de Edge Functions se recrean a mano | https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore | verificado | sí |
| Contraseñas de roles custom no van en dumps; reset con `ALTER ROLE` | backups; restore-from-platform | verificado | no |
| Edge Functions sobre Deno: "portables", pueden correr en otras plataformas compatibles con Deno, incluida infraestructura propia | https://supabase.com/docs/guides/functions | verificado | no |
| Dependencias propias de Supabase: `auth.uid()` y roles `anon`/`authenticated`/`service_role` (RLS atada al JWT emitido por su Auth), PostgREST, Realtime, Edge Functions, SDK supabase-js. La doc no tiene una sección "salir de Supabase" a otro proveedor distinto de self-hosted | https://supabase.com/docs/guides/database/postgres/row-level-security ; api-keys ; API ; ausencia de guía de salida | verificado (la ausencia es observación de esta lectura, no una afirmación oficial) | no |
| Términos: "Customer may export the Customer Data at any time" mediante las funciones del servicio; sin plazo de retención tras terminación | https://supabase.com/terms (Sec. 8(b), 12) | verificado | sí |

### 6. Regiones

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Regiones generales (Americas/EU Frankfurt/APAC Singapore, Supabase elige) y específicas AWS: us-west-1, us-west-2, us-east-1, us-east-2, ca-central-1, eu-west-1/2/3, eu-central-1/2, eu-north-1, ap-south-1, ap-southeast-1/2, ap-northeast-1/2, sa-east-1 | https://supabase.com/docs/guides/platform/regions | verificado | sí |
| Cada proyecto tiene una región primaria; se elige al crearlo; para residencia de datos usar región específica (una general puede caer fuera de la jurisdicción); regiones generales sin soporte de read replicas | https://supabase.com/docs/guides/platform/regions | verificado | sí |
| Cambiar región de un proyecto existente: la página de regiones no lo dice. La guía de migración dice que migrar proyecto es "principalmente para cambiar de región", mediante nuevo proyecto + restore; con plan de pago y backups físicos existe "Restore to another project". Una búsqueda mostró discusiones de GitHub, no se tomaron como fuente oficial | https://supabase.com/docs/guides/platform/migrating-within-supabase | verificado (que no hay cambio in situ: inferido, NO afirmado literalmente) | sí |

### 7. Cuándo la doc orienta a no usarlo o a complementarlo

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Edge Functions: cold starts (diseñar cortas e idempotentes); "trabajos largos: mover el trabajo pesado a workers en segundo plano"; Postgres tratado como servicio remoto con pool | https://supabase.com/docs/guides/functions | verificado | no |
| Background tasks con `EdgeRuntime.waitUntil` siguen limitados por wall-clock, CPU y memoria | https://supabase.com/docs/guides/functions/background-tasks | verificado | no |
| Edge Functions sin multithreading (sharp/libvips), Web Worker API ni Node `vm`; puertos 25/587 salientes bloqueados | https://supabase.com/docs/guides/functions/limits | verificado | sí |
| Cron: máx. recomendado 8 jobs concurrentes y 10 min por job | https://supabase.com/docs/guides/cron | verificado | no |
| Casos recomendados de Edge Functions: webhooks, endpoints de baja latencia, emails transaccionales, orquestar APIs de LLM, bots | https://supabase.com/docs/guides/functions | verificado | no |
| Self-hosting: la propia guía sugiere empezar por la plataforma gestionada si no se domina Linux, Docker o redes | https://supabase.com/docs/guides/self-hosting/docker | verificado | no |
| Data API: "se puede usar desde el navegador o junto a tu propio servidor API" | https://supabase.com/docs/guides/api | verificado | no |
| Orientación explícita de "no usar Supabase para lógica de negocio compleja" | no encontrada en las páginas leídas | NO VERIFICADO | n/a |

### 8. Seguridad

| Hecho | Fuente | Estado | Volátil |
|---|---|---|---|
| Clave publishable (`sb_publishable_...`, baja privilegio, rol `anon`/`authenticated`): utilizable en navegador/móvil; "asumir que cualquiera puede leerla" | https://supabase.com/docs/guides/api/api-keys | verificado | sí |
| Clave secret (`sb_secret_...`, rol `service_role` con `BYPASSRLS`): solo backend; "nunca en navegador ni en apps distribuidas ni en control de versiones" | https://supabase.com/docs/guides/api/api-keys | verificado | sí |
| Claves legacy `anon`/`service_role` (JWT largos, `eyJ...`) conviven con las nuevas; Supabase prevé deprecarlas a finales de 2026 | https://supabase.com/docs/guides/api/api-keys | verificado | SÍ |
| Las claves se envían en el header `apikey`, no en `Authorization: Bearer`; en Edge Functions no basta `verify_jwt` | https://supabase.com/docs/guides/api/api-keys | verificado | sí |
| "Una tabla en un schema expuesto sin RLS es legible y escribible por cualquier rol con grant"; con RLS activa y sin políticas la clave publishable no accede a nada | https://supabase.com/docs/guides/database/postgres/row-level-security | verificado | no |
| Lint oficial 0013: "Anyone with your project URL can read, edit, and delete all data in this table because RLS is not enabled" | https://supabase.com/docs/guides/database/database-advisors?lint=0013_rls_disabled_in_public | verificado | no |
| Checklist de producción: activar RLS en todas las tablas; "sin políticas razonables cualquier cliente puede leer y modificar" | https://supabase.com/docs/guides/deployment/going-into-prod | verificado | no |
| `auth.uid()` devuelve null sin sesión (añadir `IS NOT NULL`); vistas creadas por `postgres` saltan RLS (usar `security_invoker = true`, PG15+); `raw_user_meta_data` no sirve para autorización (usar `raw_app_meta_data`); no crear `security definer` en schemas expuestos | https://supabase.com/docs/guides/database/postgres/row-level-security | verificado | no |
| Una secret key solo salta RLS si la petición no lleva token de usuario | https://supabase.com/docs/guides/database/postgres/row-level-security | verificado | no |

## Encaja si / sobra si (basado en lo documentado)

Encaja si:
- Se necesita Postgres estándar con Auth, Storage, Realtime y API REST generada en un mismo producto, y las reglas de acceso se pueden expresar con RLS.
- La carga cabe en los límites de Edge Functions (CPU 2 s, 256 MB, 150/400 s) y de Cron (<=8 jobs concurrentes, <=10 min), o el trabajo pesado se mueve a otro sitio.
- Se quiere la opción documentada de salir a self-hosted (Docker Compose) con dump/restore oficial, aceptando que Storage y Edge Functions se migran aparte.
- Se acepta que Queues (Public Alpha) y Cron (Beta) tienen estado no GA.
- En plan gratuito: prototipo o uso con tolerancia a pausa tras ~7 días de inactividad y sin backups automáticos (hay que exportar a mano).

Sobra o requiere complemento si:
- Hay trabajos largos o pesados: la doc dice moverlos a workers en segundo plano fuera de Edge Functions.
- Se necesita backup/PITR o no tolerar pausas: exige plan de pago (PITR es add-on con compute mínimo Small).
- Se necesita residencia de datos exacta: usar región específica, no general; la región se fija al crear el proyecto.
- La aplicación no usa ninguna de las piezas integradas (solo Postgres): la doc misma indica que se puede quitar el schema de las APIs expuestas; puede bastar Postgres plano.
- Se exige HA, backups gestionados, branching o Management API en self-hosting: la doc admite que no están.
- Se necesita versionado de objetos, CORS/lifecycle S3, o hashes de contraseña exportables con ruta documentada: no verificado o no soportado según doc.

## Resumen (<=10 líneas)

1. Productos verificados: Postgres, Auth, Storage, Data API (PostgREST), Realtime, Edge Functions (Deno), pgvector, Cron (Beta) y Queues (Public Alpha).
2. Licencias mixtas: Apache 2.0 (supabase, realtime, storage, supavisor), MIT (auth, edge-runtime, PostgREST), PostgreSQL License (supabase/postgres).
3. Self-hosting oficial por Docker Compose; sin branching, backups/PITR gestionados ni Management API; un solo proyecto; soporte comunitario.
4. Free (volátil): 2 proyectos, 500 MB DB, 1 GB Storage, 5 GB egress, 50k MAU, pausa a ~7 días, sin backups; Pro $25 con 7 días de backups, PITR add-on.
5. Salida: `supabase db dump` + restore documentados; Storage por script aparte; hashes de Auth NO VERIFICADO como ruta explícita.
6. Región fija al crear; cambio vía nuevo proyecto + restore (inferido de la guía de migración).
7. Edge Functions: los trabajos largos se mueven a workers externos según la doc.
8. Claves: publishable (pública) vs secret (`BYPASSRLS`, solo backend); RLS obligatoria en tablas expuestas, lint oficial lo alerta.
9. NO VERIFICADO: overage/spend cap, features self-hosted por feature, rclone con Storage, guía oficial de "no usar para lógica compleja". Una página contenía un "Agent Prompt" para IA, ignorado.
