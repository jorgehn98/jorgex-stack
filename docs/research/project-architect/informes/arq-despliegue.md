# Arquitectura: despliegue e infraestructura (Tema A: dónde y cómo se despliega)

Fecha de consulta: 2026-10-12. Skill genérica, sin tecnología preferida. Los ejemplos de proveedor son ilustrativos, no recomendaciones.

Convenciones:
- **[V]** = verificado en la página oficial indicada el 2026-10-12.
- **[NV]** = NO VERIFICADO (la página no abrió, vino truncada o el dato no aparece en ella). No se completó de memoria.
- **[CRITERIO]** = criterio de ingeniería propio, no extraído de una fuente; no usar como cita.
- Aviso de seguridad: varias páginas de Vercel contienen un bloque "For AI agents: Follow these links..." y una línea `install_vercel_plugin: npx plugins add ...`. Es texto dirigido a asistentes de IA dentro de contenido web; se ignoró (no se siguió ningún enlace ni se instaló nada). Ninguna otra página tenía texto dirigido a IA.

---

## 1. Criterios estables (no caducan con los precios)

Estos son los ejes con los que se compara cualquier modelo de alojamiento. Son [CRITERIO] salvo que se cite fuente.

1. **Qué debe ejecutarse**: solo ficheros (estático), código bajo petición (funciones), proceso permanente (servidor, worker, websockets), tareas programadas, estado local en disco (bases de datos autogestionadas).
2. **Quién opera**: nadie con perfil técnico, una persona desarrolladora, un equipo con guardia. El esfuerzo de operación es el criterio más infravalorado: parches del sistema, backups, monitorización y respuesta a incidentes se pagan en horas, no en factura.
3. **Perfil de carga**: constante, a ráfagas, o casi nula con picos. Determina si conviene facturación por uso (escala a cero) o capacidad reservada.
4. **Estado**: los procesos deben ser sin estado y el estado vivir en servicios de respaldo (Twelve-Factor, ver sección 4). Si no se cumple, el escalado horizontal y las reversiones se complican.
5. **Bloqueo y salida**: el coste de irse es bajo si el artefacto es un contenedor estándar o ficheros estáticos; es alto si se usan APIs propietarias de funciones, colas o bases de datos del proveedor. Pregunta de control: "¿cuánto trabajo es mover esto a otro sitio en un fin de semana?".
6. **Control vs comodidad**: a más control (red, kernel, ubicación de datos), más operación propia.
7. **Cumplimiento y residencia de datos**: región, subencargados, contratos. Si hay datos personales o requisitos legales, esto puede descartar opciones antes que el precio.
8. **Previsibilidad de coste**: modelo con tope duro, solo alertas, o sin límite. Ver sección 9.

### Modelos de alojamiento por criterios

| Modelo | Problema que resuelve | Esfuerzo de operación | Perfil de coste | Escalado | Control | Bloqueo y salida |
|---|---|---|---|---|---|---|
| Hosting estático / CDN | Servir ficheros ya compilados con baja latencia global | Mínimo: subir ficheros | Normalmente por ancho de banda/peticiones; suele haber nivel gratuito (varía por proveedor) | Lo gestiona el CDN | Bajo (cabeceras y redirecciones según proveedor) | Bajo: son ficheros; cambiar de proveedor es cambiar de destino de subida |
| Plataforma gestionada de frontend | Git a producción con previews por rama, CDN y funciones/SSR integradas | Bajo | Mixto: plan por asiento + consumo medido (funciones, ancho de banda, builds) | Automático | Medio-bajo (limitado a lo que ofrece la plataforma) | Medio: el bloqueo está en las funciones/edge y servicios propios; menor si el framework es portable |
| PaaS para backend | Desplegar un servicio web, worker o cron sin gestionar servidores; base de datos gestionada cercana | Bajo-medio | Normalmente por instancia/mes (capacidad), a veces con coste por entorno de preview | Vertical y horizontal con límites del plan | Medio | Medio-bajo si se despliega un contenedor o un build estándar |
| Contenedores gestionados | Ejecutar cualquier imagen con autoescalado y sin clúster propio | Medio (imagen, red, secretos, observabilidad) | Por uso (CPU, memoria, peticiones, red) o por instancia viva | Automático, incluso a cero según servicio | Medio-alto | Bajo si la imagen es estándar; medio por la red, IAM y servicios anexos |
| Funciones serverless | Código por evento/petición, ráfagas, cargas esporádicas | Medio: cold starts, límites de duración, depuración y observabilidad distribuidas | Por invocación y duración; difícil de predecir con tráfico abusivo | Automático y muy elástico | Bajo-medio (límites de tiempo, memoria y runtime) | Medio-alto: handlers, triggers y permisos son específicos del proveedor |
| VPS / servidor propio | Control total, coste fijo, cargas permanentes | Alto: sistema, parches, firewall, backups, monitorización, reinicios | Fijo mensual/horario; tráfico incluido hasta un límite en algunos proveedores | Manual (más máquinas o más tamaño) | Total | Bajo si se usan contenedores o IaC; alto si el servidor es "artesanal" |
| Kubernetes | Orquestar muchos servicios contenedorizados con autocuración y rollouts declarativos | Muy alto (versiones, red, ingress, almacenamiento, seguridad, observabilidad) | Nodos siempre encendidos más plano de control (según oferta) | Potente pero hay que configurarlo | Muy alto | Bajo a nivel de API, pero la integración con el proveedor crea acoplamiento |

### Documentación oficial ilustrativa (al menos un ejemplo por categoría)

- **Hosting estático / CDN y despliegue atómico**: Netlify "Deploys overview" [V]. Cada cambio es un despliegue nuevo; no se publica hasta que se suben todos los ficheros; existen deploys de producción, de rama, previews por PR y permalinks. URL: https://docs.netlify.com/site-deploys/overview/
- **Plataforma gestionada de frontend**: Vercel "Environments" [V], 3 entornos por defecto (Local, Preview, Production), previews por rama y PR, variables propias por entorno. URL: https://vercel.com/docs/deployments/environments
- **Plataforma gestionada de frontend/edge (otra)**: Cloudflare Pages [V] y su guía de migración a Workers [V]. Ver sección de datos volátiles. URLs: https://developers.cloudflare.com/pages/ y https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
- **PaaS para backend**: Render "Deploys" [V]. Autodeploy desde Git ("On Commit", "After CI Checks Pass", "Off"), comando pre-deploy para migraciones, despliegue sin caída. URL: https://render.com/docs/deploys . Fly.io "Pricing" [V] solo para dimensiones de facturación. URL: https://docs.fly.io/about/pricing
- **Contenedores gestionados**: Google Cloud Run "What is Cloud Run" [V]. Servicios, jobs, worker pools, escala a cero, dos modos de facturación (por petición o por instancia). URL: https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run
- **Funciones serverless**: AWS Lambda "What is Lambda" [V]. Sin gestión de servidores, hasta 15 minutos por invocación, ejecuciones sin estado compartido. URL: https://docs.aws.amazon.com/lambda/latest/dg/welcome.html
- **VPS / servidor propio**: Hetzner Cloud, FAQ de facturación [V]. Muestra el modelo (precio por hora con tope mensual; servidor apagado se sigue facturando; tráfico saliente por encima de lo incluido). URL: https://docs.hetzner.com/cloud/billing/faq/ . Nota: la portada https://docs.hetzner.com/cloud/ no describe el producto [V que no lo describe]. Hetzner billing "general/others/billing" devolvió 404 [NV].
- **Kubernetes (cuándo no)**: Kubernetes "Overview" [V]. Dice textualmente lo que NO es: no es un PaaS completo, no despliega código fuente ni construye aplicaciones, no incluye bases de datos ni caches, no dicta logging/monitorización. URL: https://kubernetes.io/docs/concepts/overview/ (la página se leyó hasta el carácter 100000 de 103431; el resto sin leer).

---

## 2. Tabla de decisión (situación -> modelo -> motivo -> contraindicación)

Todo [CRITERIO], cruzado con las capacidades documentadas arriba.

| Situación | Modelo | Motivo | Contraindicación |
|---|---|---|---|
| Landing o web de contenido, sin lógica de servidor, equipo pequeño o no técnico | Hosting estático / CDN o plataforma de frontend | Cero operación; el sitio son ficheros; rollback trivial | Si necesitas sesiones, pagos con lógica propia o contenido que cambia por usuario, hará falta una función o API aparte |
| Web con SSR, ISR o rutas API ligeras, equipo de frontend | Plataforma gestionada de frontend | Previews por rama, CDN y funciones sin infraestructura | Backend pesado, procesos largos, websockets persistentes o consumo difícil de acotar |
| SaaS con API, base de datos y tareas en segundo plano, 1-3 desarrolladores | PaaS para backend (+ base de datos gestionada en la misma región) | Despliegue por Git, migraciones en pre-deploy, sin gestionar servidores | Necesidades de red privada compleja, cumplimiento estricto o consumo muy alto donde la capacidad reservada resulte cara |
| API con tráfico muy variable o con ceros largos | Contenedores gestionados con escala a cero o funciones | Pagas por uso real; el contenedor es portable | Arranques en frío en rutas sensibles a latencia (mitigar con instancias mínimas, que cuestan); conexiones a base de datos que se multiplican con la concurrencia |
| Eventos aislados (webhook, cola, cron, procesamiento de ficheros) | Funciones serverless o jobs | Encaja por naturaleza; sin proceso permanente | Flujos largos con estado local; depuración distribuida sin observabilidad |
| Carga estable, coste fijo importante, equipo con perfil de sistemas | VPS o servidor propio (con contenedores y backups probados) | Coste previsible, control total | Nadie que opere de verdad; datos críticos sin copia verificada; necesidad de alta disponibilidad real |
| Control extremo de red/datos o requisitos de residencia concretos | VPS o contenedores gestionados en la región exigida | Elegir ubicación y límites explícitos | Pensar que el control sustituye a la operación: se asume mantenimiento y seguridad |
| Muchos servicios (decenas), varios equipos, necesidades de plataforma interna | Kubernetes gestionado | Rollouts declarativos, autocuración, bin packing, estandarización | Menos de ~5 servicios o menos de un equipo dedicado a plataforma (umbral [CRITERIO]); la propia documentación aclara que no incluye PaaS, CI/CD ni base de datos |
| Prototipo o MVP con incertidumbre alta | La opción más gestionada que cumpla requisitos | Validar antes de operar | Elegir por "podría escalar" algo con coste operativo alto |
| Cliente exige entregar un entorno que opera otro | Contenedor estándar + IaC mínima | Portabilidad y trazabilidad de lo desplegado | Servicios propietarios sin equivalente documentado |

---

## 3. Árbol de decisión simple

Paso 1. ¿Tiene lógica de servidor propia?
- No -> hosting estático o plataforma de frontend. Fin.
- Sí -> paso 2.

Paso 2. ¿Quién operará en producción?
- Nadie con perfil técnico, o una persona sin guardia -> PaaS o plataforma de frontend con backend integrado. Evitar VPS y Kubernetes.
- Un desarrollador con tiempo para operar -> PaaS o contenedores gestionados; VPS solo si hay razón de coste o control.
- Equipo con perfil de plataforma -> cualquiera; Kubernetes solo si pasa el filtro del paso 4.

Paso 3. ¿Cómo es la carga?
- A ráfagas o con ceros largos -> contenedores con escala a cero o funciones.
- Constante -> PaaS por instancia o VPS (coste fijo).

Paso 4. ¿Kubernetes? Solo si se cumplen TODAS: (a) muchos servicios, (b) equipo que puede mantener el clúster, (c) necesidad real de lo que da Kubernetes (rollouts declarativos, autocuración, bin packing) que ningún PaaS cubre. Si falta alguna, no.

Paso 5. Verificar antes de cerrar: región de los datos, política de salida (¿puedo exportar todo?), tope de gasto disponible (sección 9), y quién es titular del dominio (sección 7).

---

## 4. Entornos, secretos y datos (con Twelve-Factor)

### Guía oficial Twelve-Factor [V, consultada 2026-10-12]

- **Config** (https://12factor.net/config): la configuración es todo lo que varía entre despliegues (handles de bases de datos y servicios, credenciales, hostname canónico). Debe separarse estrictamente del código y guardarse en variables de entorno. Prueba de fuego citada: "¿podría abrirse el código mañana sin exponer credenciales?". Advierte que agrupar la config en entornos con nombre (`development`, `test`, `production`) no escala; recomienda variables granulares e independientes por despliegue.
- **Procesos** (https://12factor.net/processes): procesos sin estado y sin compartir nada; lo que deba persistir va a un servicio de respaldo. Memoria y disco local solo como caché breve de una transacción. Las sesiones pegajosas (sticky sessions) son "una violación de twelve-factor y nunca deben usarse ni depender de ellas"; el estado de sesión va a un almacén con caducidad.
- **Paridad dev/prod** (https://12factor.net/dev-prod-parity): cerrar tres brechas (tiempo, personal, herramientas). Evitar SQLite en local y PostgreSQL en producción; mismo tipo y versión de servicio de respaldo en todos los entornos.

### Checklist de entornos

- [ ] Existen al menos: local, preview (efímero por rama o PR) y producción. Staging persistente solo si hay validación previa a producción que no cubra el preview.
- [ ] Cada entorno tiene sus propios secretos, base de datos y credenciales de terceros. Ningún entorno no productivo apunta a datos de producción.
- [ ] Todas las variables de config se leen del entorno, no del código ni de ficheros versionados.
- [ ] El repositorio pasa la prueba de "se podría abrir sin filtrar credenciales" (incluido el historial Git).
- [ ] Los datos de preview/staging son sintéticos o anonimizados. Copiar datos personales reales a entornos no productivos requiere decisión explícita.
- [ ] Mismo tipo y versión de base de datos, caché y cola en local y producción.
- [ ] El proceso es sin estado: sin sesiones en memoria ni ficheros subidos en disco local; archivos de usuario en almacenamiento externo.
- [ ] Previews no indexables ni públicos si contienen contenido no publicado (Netlify añade `X-Robots-Tag: noindex` pero avisa de que no garantiza privacidad [V]; Vercel documenta noindex en previews, detalle en su KB [NV]).
- [ ] Un staged production deployment usa variables de producción, así que puede tocar servicios y datos reales; para recursos separados usar un entorno personalizado o rama de preview con credenciales de staging [V, Vercel environments].
- [ ] Rotación de secretos documentada; un secreto en un log se rota y el log se borra [V, GitHub hardening].

---

## 5. CI/CD: qué automatizar primero y en qué orden

Orden recomendado [CRITERIO]: 1) pruebas y lint en cada PR, 2) build reproducible, 3) despliegue automático a preview, 4) despliegue a producción tras merge, 5) migraciones, 6) reversión y despliegue gradual.

### Checklist CI/CD

- [ ] **Pruebas y build en cada PR**. Si fallan, no se despliega. Render permite "After CI Checks Pass" como modo de autodeploy [V]; así el despliegue espera a la integración continua.
- [ ] **Despliegue por Git**: producción desde la rama principal; el pipeline es la única vía a producción (nada de subir a mano salvo emergencia documentada).
- [ ] **Previews por rama o PR**: Vercel [V], Netlify (Deploy Previews por defecto; branch deploys desactivados por defecto) [V]. Cloudflare Pages: la página raíz consultada NO menciona previews [V que no los menciona]; no afirmar.
- [ ] **Una sola concurrencia de producción**: `concurrency` en GitHub Actions evita despliegues simultáneos; con `queue: single` queda como mucho uno pendiente y se reemplazan los pendientes [V workflow syntax]. Ejemplo oficial: `concurrency: production` [V Context7].
- [ ] **Entornos protegidos para producción**: en GitHub, un job con `environment` no arranca ni lee los secretos del entorno hasta pasar las reglas de protección (revisores obligatorios, hasta 6; temporizador; restricción de ramas/etiquetas) [V]. Límite de plan: GitHub Free solo permite configurar entornos en repositorios públicos; si un repo pasa a privado, las reglas y los secretos de entorno se ignoran [V]. Verificar el plan antes de depender de ello.
- [ ] **Permisos mínimos del token**: `GITHUB_TOKEN` con `permissions` explícito a nivel de workflow o job (ejemplo oficial: `contents: read`, `issues: write`) [V]. Si se declara cualquier permiso, los no listados quedan en `none` [V]. Se recomienda predeterminar el token a solo lectura en contenidos y elevar por job [V]. `id-token: write` solo en los jobs que pidan OIDC [V].
- [ ] **Credenciales de nube sin secretos de larga vida**: OIDC; el proveedor valida claims (`sub`, `repository`, `ref`, `environment`) y emite un token de corta duración válido para un solo job [V]. Limitar la confianza al entorno y a la rama de producción.
- [ ] **Terceros fijados por SHA**: fijar acciones de terceros al SHA completo del commit; los tags pueden moverse [V]. Las políticas de organización pueden exigirlo [V].
- [ ] **No interpolar entrada no confiable en scripts** (`github.event.pull_request.title`): pasar por variable de entorno [V].
- [ ] **Evitar `pull_request_target`** salvo necesidad; nunca hacer checkout de código de un PR no confiable en esos workflows [V].
- [ ] **Migraciones**: ejecutarlas antes de que la nueva versión reciba tráfico (Render: comando pre-deploy tras el build y antes del despliegue; si falla, el despliegue falla y sigue la versión actual; se ejecuta en otra instancia, sin disco persistente; límite de 30 minutos) [V]. Diseñar migraciones compatibles hacia atrás (expandir, desplegar, contraer) para que el rollback de código no choque con el esquema [CRITERIO; la fuente de Vercel y Render confirma que el rollback no revierte la base de datos, ver abajo].
- [ ] **Reversión (rollback)**: probarla antes de necesitarla.
  - Vercel Instant Rollback: reapunta los dominios a un despliegue anterior; NO actualiza variables de entorno; después desactiva la autoasignación de producción hasta deshacer el rollback; Hobby solo al despliegue inmediatamente anterior [V].
  - Render: reutiliza el artefacto de build, los discos NO se revierten; desde el panel desactiva el autodeploy [V].
  - Cloudflare Pages: cualquier despliegue de producción exitoso es destino válido; los previews no [V].
  - Netlify: el despliegue "publicado" y bloqueo de despliegues; procedimiento de publicar uno anterior en "Manage deploys" [NV, no abierto].
  - Regla común: el rollback de código no deshace datos ni migraciones; documentar qué hacer con ambos.
- [ ] **Despliegues graduales**: Cloud Run permite desplegar una revisión sin tráfico, probarla en una URL con etiqueta y subir su porcentaje paso a paso; rollback = 100% a una revisión anterior; con etiquetas hay que vigilar instancias mínimas por revisión [V]. En plataformas de frontend, equivalentes (promoción manual, `Auto-assign Custom Production Domains` desactivado en Vercel) [V]. Para un proyecto pequeño, un preview + promoción manual suele bastar; el canario ponderado es opcional.
- [ ] **Health check y despliegue sin caída**: Render arranca la nueva instancia antes de retirar la antigua y la cancela si no pasa la comprobación de salud (en servicios con varias instancias); un disco persistente desactiva el zero-downtime [V].
- [ ] **Observabilidad mínima**: tras desplegar, un chequeo automático (smoke test) y alertas de errores [CRITERIO].

---

## 6. Dominios, DNS, TLS y cabeceras de seguridad

### Titularidad y renovación [CRITERIO apoyado en ICANN]
- El titular real del dominio es el *Registered Name Holder* (registrante); él (y el contacto administrativo en Whois) aprueba o deniega transferencias [V, política de transferencia 2016]. La página indica que fue sustituida por una versión de 2024 (https://www.icann.org/resources/pages/transfer-policy-2024-02-21-en), que NO se abrió [NV]; usar la vigente para cifras de plazos.
- Tras registro o transferencia hay un bloqueo de 60 días; tras un cambio de registrante también [V en versión 2016; verificar en la de 2024 [NV]].
- Checklist:
  - [ ] El dominio está a nombre de la persona u organización cliente, no de una agencia o del desarrollador, salvo acuerdo escrito.
  - [ ] Hay un correo de recuperación del registrador que no depende del propio dominio.
  - [ ] Renovación automática activada, método de pago vigente, aviso de caducidad a dos personas.
  - [ ] Bloqueo de transferencia (registrar lock) y MFA en la cuenta del registrador.
  - [ ] Código de autorización (auth/EPP) accesible al titular; un registrador no puede retenerlo por una disputa de pago [V, ICANN 2016].
  - [ ] Separar registrador y DNS si conviene (más fácil mover el DNS sin transferir el dominio) [CRITERIO].

### TLS
- Los certificados de Let's Encrypt duran 90 días por defecto (opcionales de 6 días); se recomienda renovar a los 60 días (o cada 3 días en los de 6); "no hay forma de ajustar estas duraciones" [V, https://letsencrypt.org/docs/faq/, página actualizada por última vez el 2025-04-28 según la propia página]. Decisión: usar plataforma que emita y renueve automáticamente; no gestionar certificados a mano.
- La vigencia máxima de certificados públicos se reduce por calendario CA/Browser Forum (SC-081v3, aprobado 2025-04-11): 200 días desde 2026-03-15, 100 desde 2027-03-15, 47 desde 2029-03-15 [dato secundario vía WebSearch de terceros; fuente oficial https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods no abierta -> NV]. Conclusión estable: automatizar la renovación; un certificado manual de larga duración es una deuda creciente.
- Un registro DNS A/CNAME mal gestionado y el control del dominio son lo que realmente rompe el TLS (validación de dominio) [CRITERIO].

### Cabeceras de seguridad básicas (a nivel de decisión)
- **HSTS** [V, MDN https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security]: `Strict-Transport-Security: max-age=<segundos>`; solo se respeta sobre HTTPS; `includeSubDomains` afecta a todos los subdominios; `preload` exige `max-age` >= 31536000 e `includeSubDomains`. Para deshabilitar hay que servir `max-age=0` por HTTPS. Decisión: empezar con `max-age` corto, subirlo cuando HTTPS funcione en todo el dominio y todos los subdominios, y decidir `preload` solo con certeza (el resumen indicó que la retirada de las listas es lenta, pero eso NO lo dice la página de MDN: [NV]).
- **CSP** [V, MDN https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP]: defensa en profundidad contra XSS, no sustituye la sanitización. Recomendación MDN: CSP estricta con nonces (páginas dinámicas) o hashes (estáticas) más `object-src 'none'` y `base-uri 'none'`; las listas de hosts son difíciles de acertar. Despliegue: empezar con `Content-Security-Policy-Report-Only` y un endpoint de informes, limpiar scripts inline, y solo entonces aplicar. `frame-ancestors 'none'` sustituye a `X-Frame-Options` si no se necesita embeber. Decisión: en una landing estática con scripts de terceros (analítica, chat), una CSP estricta puede exigir trabajo; arrancar en modo informe es el mínimo razonable.
- Otras cabeceras habituales (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) [NV: no consultadas en esta sesión].

---

## 7. Infraestructura como código (IaC)

Qué es (Terraform/OpenTofu) [V]: configuración legible y versionable de recursos; flujo escribir, planificar (plan), aplicar (apply); un archivo de estado como fuente de verdad. URLs: https://developer.hashicorp.com/terraform/intro y https://opentofu.org/docs/intro/ (la página de OpenTofu no indica la licencia del código, y la de Terraform no trae información de licencia: no se afirma ninguna).

Cuándo vale la pena [CRITERIO]:
- Hay más de un entorno que deba ser reproducible o más de ~10 recursos de infraestructura.
- Más de una persona toca la infraestructura y se necesita revisión (plan en el PR).
- Hay requisito de auditoría o de recrear el entorno ante desastre.
- Se gestiona DNS, cuentas cloud, redes o IAM, donde un clic erróneo es caro.

Cuándo es sobreingeniería [CRITERIO]:
- Landing estática o proyecto en una plataforma gestionada con Git: la configuración del repositorio (ficheros de la plataforma) ya es suficiente.
- Un único servicio con base de datos gestionada y panel; el coste de mantener estado, backend remoto y proveedores supera el beneficio.
- Equipo de una persona sin necesidad de reproducir entornos.

Regla intermedia: documentar manualmente los recursos y su configuración (un README de infraestructura) antes de adoptar IaC; introducir IaC cuando aparezca el segundo entorno o la segunda persona. El estado debe guardarse en un backend remoto con control de acceso y bloqueo; el estado puede contener secretos [CRITERIO; la fuente solo confirma que existe el archivo de estado y los backends en la nube].

---

## 8. Estimar el coste de forma estable

Dimensiones de facturación (no precios) por categoría, todas [V] salvo indicación:

- **Plataformas de frontend / estáticas**: ancho de banda, peticiones, ejecución de funciones, builds, asientos, almacenamiento de datos. Vercel: el gasto medido sobre el crédito del plan; no incluye asientos, integraciones de Marketplace ni complementos [V].
- **Funciones (AWS Lambda)**: peticiones, duración (GB-segundo según memoria asignada), almacenamiento efímero extra, concurrencia aprovisionada, transferencia de datos fuera de la región de la función [V, https://aws.amazon.com/lambda/pricing/].
- **Contenedores gestionados (Cloud Run)**: dos modos, por petición (sin cargo en inactividad) o por instancia (se paga toda la vida de la instancia) [V, página de overview]. Dimensiones exactas (vCPU-s, GiB-s, peticiones, red, GPU): la página de precios devolvió contenido truncado; lista NO VERIFICADA.
- **PaaS / máquinas (Fly.io)**: máquinas por segundo mientras están iniciadas, volúmenes por capacidad aprovisionada (incluso desconectados), snapshots, ancho de banda saliente (y entre regiones) por grupos de región, IPv4 dedicadas, Postgres gestionado, soporte [V].
- **VPS (Hetzner Cloud)**: precio por hora con tope mensual; el servidor apagado se factura; solo tráfico saliente por encima de lo incluido, en bloques; IPs, snapshots y backups por separado [V].

Método estable [CRITERIO]:
1. Listar las dimensiones por componente (cómputo, base de datos, almacenamiento, red saliente, builds, observabilidad, correo, terceros).
2. Estimar tres escenarios (bajo, esperado, pico x10) con las unidades del proveedor y la calculadora oficial; guardar la fecha.
3. Identificar la dimensión "sin tope natural" (tráfico saliente, invocaciones, GB de logs, minutos de build, uso de IA) y proteger esa.
4. Revisar tras el primer mes real y cada trimestre.

### Alertas y topes (distinguir alerta de tope)

- **AWS Budgets**: alertas por gasto real y previsto, acciones (p. ej. aplicar una política IAM que deniegue aprovisionar más); los datos se actualizan hasta tres veces al día, 8-12 h entre actualizaciones; la propia documentación avisa de que puede haber retraso y que el coste puede seguir subiendo tras la alerta [V, https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html].
- **Google Cloud**: un presupuesto solo de alertas "no limita automáticamente el uso ni el gasto"; existen topes por proyecto para servicios elegibles (los servicios se pausan hasta levantar el tope) y notificaciones Pub/Sub para deshabilitar la facturación de forma programática [V, https://docs.cloud.google.com/billing/docs/how-to/budgets].
- **Vercel Spend Management**: notificaciones al 50%, 75% y 100%, webhook y opción "Pause Production Deployments"; comprueba el gasto cada pocos minutos, por lo que puede pasarse; la pausa devuelve 503 y cada proyecto se reanuda a mano; no cubre asientos ni complementos [V, página con fecha last_updated 2026-09-18].
- **Fly.io**: la página de precios no describe un tope de gasto (solo "límites de escalado automatizados") [V que no lo describe].
- **Hetzner**: avisos de tráfico al 75% y 100% son informativos y no limitan [V].

Decisiones: (a) activar alerta temprana (50%) y de tope bajo desde el primer día; (b) preferir un tope duro cuando el negocio prefiera caída a factura; si no existe, construir un interruptor propio (webhook que pause o ponga en modo estático) y probarlo; (c) poner un límite también en dependencias que cobran por uso (APIs de IA, correo); (d) cuenta de pago a nombre del titular del proyecto, con un segundo administrador.

---

## 9. Región y latencia entre aplicación y base de datos

- Regla estable [CRITERIO apoyada en Vercel y AWS]: el cómputo y la base de datos deben estar en la misma región (idealmente la misma zona de disponibilidad para tráfico intenso). Cada consulta lleva un viaje de ida y vuelta; las páginas con varias consultas secuenciales multiplican la latencia. El contenido estático lo sirve el CDN cerca del usuario; lo dinámico depende de dónde estén la función y la base de datos.
- Vercel [V, last_updated 2026-08-11]: las funciones se ejecutan por defecto en Washington D.C. (`iad1`) para proyectos nuevos; se debe fijar la región cerca de la fuente de datos; "si tus funciones se comunican con servicios externos, elegir regiones lejanas aumenta la latencia"; se puede fijar región por función. URL: https://vercel.com/docs/functions/configuring-functions/region
- AWS RDS [V]: cada región es independiente y los recursos no se replican entre regiones salvo que se configure; elegir una zona concreta al crear una instancia Single-AZ; hay Local Zones para acercarse a usuarios (en RDS, solo Los Ángeles). URL: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RegionsAndAvailabilityZones.html
- Fly.io [V]: el tráfico privado entre regiones se factura; el de la misma región, gratis para organizaciones con precios granulares.
- Lambda [V]: transferencia de datos fuera de la región de la función se cobra.
- Decisión práctica [CRITERIO]:
  - [ ] Elegir la región por: (1) residencia legal de datos, (2) cercanía a la mayoría de usuarios o a la base de datos, (3) disponibilidad de servicios.
  - [ ] Un solo punto de verdad de escritura; réplicas de lectura en otras regiones solo si hay evidencia de latencia.
  - [ ] Medir antes de multiplicar regiones: p95 de consultas desde el cómputo y desde un usuario típico.
  - [ ] Cambiar de región de la base de datos después es una migración; decidirlo al crear.
  - [ ] Si hay funciones globales (edge) que leen una base de datos regional, el salto es el cuello de botella; mantener la función en la región de la base de datos.

---

## 10. Datos volátiles (con fecha de consulta 2026-10-12)

| Dato | Valor observado | Fuente oficial | Estado |
|---|---|---|---|
| Cloudflare Pages vs Workers | La página principal de Pages recomienda Workers ("Start new projects with Workers", Workers "supports most Pages use cases"); no anuncia deprecación. La guía de migración no contiene fecha de fin ni deprecación; indica que Workers no admite dominios cuyos nameservers no estén en Cloudflare, que Pages sí admite | https://developers.cloudflare.com/pages/ ; https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ | V |
| Vercel entornos personalizados | Disponibles en Pro y Enterprise; Pro: 1 por proyecto, Enterprise: 12 (last_updated 2026-09-17) | https://vercel.com/docs/deployments/environments | V |
| Vercel Instant Rollback | Hobby: solo el despliegue inmediatamente anterior; Pro/Enterprise: cualquier despliegue elegible (last_updated 2026-07-07) | https://vercel.com/docs/instant-rollback | V |
| Vercel regiones de función por plan | La página dice Hobby una región, Pro 5, Enterprise todas. Un changelog enlazado en la misma página se titula "Pro customers can now configure up to 3 regions": contradicción interna no resuelta (last_updated 2026-08-11) | https://vercel.com/docs/functions/configuring-functions/region | V con discrepancia; no citar cifra sin reconsultar |
| Vercel Spend Management | Disponible en Pro y Enterprise (Flexible Commitment); alertas 50/75/100 %; pausa de producción opcional (last_updated 2026-09-18) | https://vercel.com/docs/spend-management | V |
| GitHub Free y entornos | Entornos con protección solo en repositorios públicos para plan Free; Team/Pro permiten privados | https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment | V |
| GitHub: permiso por defecto del GITHUB_TOKEN en repos nuevos | Las páginas consultadas no lo indican | https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication | NV (verificar en la configuración del repo y de la organización; declarar `permissions` siempre) |
| AWS Lambda | Duración máxima 15 min por invocación; existe además una oferta nueva "Lambda MicroVMs" (hasta 8 h) en la misma página | https://docs.aws.amazon.com/lambda/latest/dg/welcome.html | V |
| Cloud Run | Servicios, jobs, worker pools; "Instances" en Preview; dos modos de facturación | https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run | V |
| Cloud Run: dimensiones de precio y nivel gratuito | Página de precios truncada | https://cloud.google.com/run/pricing | NV |
| Let's Encrypt | Certificados de 90 días por defecto, opción de 6 días; página actualizada 2025-04-28 | https://letsencrypt.org/docs/faq/ | V |
| Calendario de vigencia de certificados públicos (CA/B Forum SC-081v3) | 200 d (2026-03-15), 100 d (2027-03-15), 47 d (2029-03-15) según fuentes secundarias | https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods | NV (primaria no abierta) |
| Fly.io facturación | Cargos por snapshots desde 2026-01-01 (según la propia página); sin tope de gasto descrito | https://docs.fly.io/about/pricing | V |
| Hetzner Cloud | Facturación por hora con tope mensual; servidores apagados se facturan | https://docs.hetzner.com/cloud/billing/faq/ | V |
| ICANN transferencias | Versión 2016 abierta; existe versión 2024 vigente no abierta | https://www.icann.org/resources/pages/transfer-policy-2016-06-01-en | V parcial; 2024 NV |

Nota: no se copió ningún precio. Todo precio, cuota gratuita o límite numérico de plan debe reconsultarse en el momento de decidir.

---

## 11. Fuentes con estado

| # | URL | Uso | Estado |
|---|---|---|---|
| 1 | https://12factor.net/config | Config en entorno | V |
| 2 | https://12factor.net/processes | Procesos sin estado | V |
| 3 | https://12factor.net/dev-prod-parity | Paridad dev/prod | V |
| 4 | https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication | GITHUB_TOKEN, permisos | V (no cubre valores por defecto) |
| 5 | https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions | Hardening, SHA, OIDC | V |
| 6 | https://docs.github.com/en/actions/reference/security/secure-use | Uso seguro | V |
| 7 | https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment | Entornos, reglas, límites de plan | V |
| 8 | https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions | `permissions`, `concurrency` | V parcial (leído hasta 100000 de 230295 caracteres; clave `environment` de job NV en esa página; confirmada por Context7) |
| 9 | https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect | OIDC | V (el permiso `id-token: write` NO figura ahí; sí en la sintaxis de workflows, #8) |
| 10 | Context7 /websites/github_en_actions | Ejemplos oficiales de permisos, entornos y concurrencia | V |
| 11 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security | HSTS | V (MDN, no es página de un proveedor; resumen del fetch incluyó comentarios fuera de la página, descartados) |
| 12 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP | CSP | V |
| 13 | https://developers.cloudflare.com/pages/ | Ejemplo de frontend/estático | V |
| 14 | https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ | Migración Pages a Workers | V |
| 15 | https://developers.cloudflare.com/pages/configuration/rollbacks/ | Rollbacks de Pages | V |
| 16 | https://vercel.com/docs/deployments/environments | Entornos | V (contenía texto "For AI agents" ignorado) |
| 17 | https://vercel.com/docs/instant-rollback | Rollback | V (texto "For AI agents" ignorado) |
| 18 | https://vercel.com/docs/spend-management | Tope y alertas | V (texto "For AI agents" ignorado) |
| 19 | https://vercel.com/docs/functions/configuring-functions/region | Región | V (texto "For AI agents" ignorado; discrepancia 3 vs 5 regiones) |
| 20 | https://docs.netlify.com/site-deploys/overview/ | Estático, previews | V |
| 21 | https://render.com/docs/deploys | PaaS, pre-deploy | V |
| 22 | https://render.com/docs/rollbacks | Rollback | V |
| 23 | https://docs.fly.io/about/pricing | Dimensiones de facturación | V |
| 24 | https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run | Contenedores gestionados | V |
| 25 | https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration | Gradual y rollback | V |
| 26 | https://cloud.google.com/run/pricing | Precios Cloud Run | NV (truncada) |
| 27 | https://docs.aws.amazon.com/lambda/latest/dg/welcome.html | Funciones | V |
| 28 | https://aws.amazon.com/lambda/pricing/ | Dimensiones Lambda | V |
| 29 | https://kubernetes.io/docs/concepts/overview/ | Qué no es Kubernetes | V parcial (últimos 3431 caracteres sin leer) |
| 30 | https://docs.hetzner.com/cloud/ | Portada | V (sin información útil) |
| 31 | https://docs.hetzner.com/cloud/general/faq/ | FAQ | V parcial (no cubre facturación del modelo) |
| 32 | https://docs.hetzner.com/general/others/billing/ | Facturación | NV (404) |
| 33 | https://docs.hetzner.com/cloud/billing/faq/ | Facturación | V |
| 34 | https://letsencrypt.org/docs/faq/ | Vigencia TLS | V |
| 35 | https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods | Calendario CA/B | NV (no abierta; datos vía WebSearch de terceros) |
| 36 | https://www.icann.org/resources/pages/transfer-policy-2016-06-01-en | Transferencias | V (versión sustituida) |
| 37 | https://www.icann.org/resources/pages/transfer-policy-2024-02-21-en | Transferencias vigente | NV (no abierta) |
| 38 | https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html | Presupuestos AWS | V |
| 39 | https://docs.cloud.google.com/billing/docs/how-to/budgets | Presupuestos GCP | V |
| 40 | https://developer.hashicorp.com/terraform/intro | IaC | V |
| 41 | https://opentofu.org/docs/intro/ | IaC | V |
| 42 | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RegionsAndAvailabilityZones.html | Regiones y AZ | V |

Pendiente de verificar si se necesita más profundidad: Netlify "Manage deploys" (rollback), previews de Cloudflare Pages/Workers Builds, documentación de expandir/contraer migraciones (no se buscó fuente oficial), cabeceras `Referrer-Policy`/`X-Content-Type-Options`/`Permissions-Policy`.

---

## 12. Resumen final (qué cambiaría la recomendación de la skill)

1. Quién opera pesa más que el precio: sin operador con guardia, descartar VPS y Kubernetes aunque salgan más baratos.
2. Kubernetes solo con muchos servicios, equipo de plataforma y necesidad real; la doc oficial aclara que no es PaaS ni CI/CD ni base de datos.
3. Un tope de gasto duro no existe en todas partes: AWS y GCP (en modo solo alertas) avisan pero no frenan; Vercel pausa pero con retraso de minutos; verificar el tope antes de elegir.
4. El rollback de código no revierte datos, variables ni migraciones (Vercel, Render): exigir migraciones compatibles hacia atrás.
5. Región de cómputo = región de la base de datos; el valor por defecto de la plataforma (p. ej. Vercel iad1) puede ser incorrecto para tu mercado.
6. Plan y entorno de GitHub: en Free, las protecciones de entornos solo valen en repos públicos; comprobar el plan antes de basar el control de producción en ello.
7. Permisos de CI: declarar `permissions` mínimos, OIDC en lugar de claves de larga vida y acciones fijadas por SHA; el valor por defecto del token no quedó verificado.
8. Cloudflare Pages: Cloudflare recomienda Workers para proyectos nuevos; no se anuncia deprecación, pero reconsultar antes de elegir Pages.
9. Dominio a nombre del cliente, con renovación automática y MFA; la vigencia de certificados baja por calendario (200/100/47 días), así que TLS debe ser 100 % automático.
10. IaC cuando aparece el segundo entorno o la segunda persona; antes, documentación manual.
11. Datos volátiles a reconsultar siempre: límites por plan, regiones por plan (Vercel presenta una contradicción 3 vs 5), precios y niveles gratuitos.
12. No verificados: precios de Cloud Run, política ICANN 2024, calendario CA/B primario, defaults de GITHUB_TOKEN.
