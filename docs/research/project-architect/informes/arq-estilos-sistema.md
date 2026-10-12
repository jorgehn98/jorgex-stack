# Estilos de arquitectura de sistema y criterio del más simple que cumple

Fecha de verificación: 2026-10-12. Alcance: fase "tipo de proyecto y arquitectura" de la skill.
Convención: **[V]** = página abierta y leída en esta sesión; **[NV]** = NO VERIFICADO (no se pudo abrir la fuente primaria o solo hay referencias secundarias). Las cifras y citas salen de lo leído; lo que es inferencia mía va marcado como "criterio propio".

Limitación honesta: WebFetch resume las páginas con un modelo pequeño, así que las citas literales cortas vienen de ese resumen y conviene recontrastarlas antes de citarlas textualmente en un documento público.

---

## 1. Criterios ESTABLES

### 1.1 Regla por defecto

Monolito desplegable único con módulos internos con límites explícitos (monolito modular), sobre un único almacén de datos, hasta que una señal concreta de la sección 5 justifique separar algo. Los servicios gestionados (BD, auth, colas, almacenamiento) se usan desde el día 1 porque quitan operación sin añadir coordinación entre equipos.

Base en fuentes:
- Fowler, *Monolith First*: "you shouldn't start a new project with microservices"; "Almost all the successful microservice stories have started with a monolith that got too big and was broken up" [V, 2015-06-03].
- Fowler, *Microservice Premium*: la mayoría de sistemas deben ser una sola aplicación con buena modularidad interna; microservicios solo cuando el sistema es demasiado complejo para gestionarse como monolito [V, 2015-05-13].
- Azure Architecture Center: la complejidad de la arquitectura debe corresponder con el dominio; si es demasiado simple acaba en *big ball of mud*, y "es mejor a veces relajar una restricción que perseguir pureza arquitectónica" [V].

Matiz importante (criterio propio, apoyado en Fowler): la vía "diseñar un monolito modular para partirlo luego" la describe Fowler como difícil de lograr, con pocos éxitos confirmados, y señala que los módulos suelen erosionarse en la práctica [V]. Por tanto "modular" exige reglas aplicadas por herramienta (comprobación automática de dependencias entre módulos en CI), no solo carpetas. Shopify es el ejemplo documentado de hacerlo con herramientas (ver 4.3).

### 1.2 Qué decide realmente el estilo (los cinco ejes)

1. **Necesidad de despliegue independiente**: es el motivo más fuerte para separar. Si todas las partes se despliegan siempre juntas, separarlas solo añade red (caso Istio, 4.4).
2. **Tamaño y estructura de equipos**: la separación compra autonomía entre equipos. Fowler: los límites de módulo importan más cuanto más grandes son los equipos, porque la disciplina se mantiene peor a escala [V, *Microservice Trade-Offs*, 2015-07-01]. Con un equipo, no hay autonomía que comprar.
3. **Perfil de escala**: separar compensa si partes distintas tienen perfiles de carga muy distintos (CPU, memoria, ráfagas) y no basta con replicar el monolito entero. Es raro que un producto nuevo lo necesite.
4. **Madurez operativa**: Azure indica que microservicios exige "prácticas de desarrollo y DevOps maduras" [V]; Fowler: "You need a mature operations team to manage lots of services" [V]. Mínimo razonable antes de más de un servicio: CI/CD automatizado, observabilidad con trazas correlacionadas, gestión de versiones de contratos, guardia.
5. **Claridad del dominio**: los límites de servicio mal trazados son caros de corregir; Fowler: mover funcionalidad entre servicios es "much harder" que en un monolito [V]. Azure lista como antipatrón implementar microservicios sin comprender el dominio [V].

### 1.3 Coste de coordinación y de operación por estilo (cualitativo, estable)

| Estilo | Coste de operación | Coste de coordinación de equipo | Fallo típico |
|---|---|---|---|
| Monolito | Mínimo: un artefacto, un despliegue, una BD | Crece con el tamaño: releases coordinadas, conflictos de código | Acoplamiento interno sin límites, release lenta |
| Monolito modular | Igual que el monolito | Bajo-medio; exige disciplina de límites | Los módulos se erosionan si nada lo impide |
| Web-cola-worker (monolito + proceso en segundo plano) | Bajo: una cola y un worker | Bajo | Frontend y worker crecen como dos monolitos con esquemas compartidos [V Azure] |
| Backend-for-frontend (BFF) | Un servicio extra por cliente | Medio: equipo de frontend asume backend; duplicación de código | BFF con lógica de negocio; salto de red extra [V Azure] |
| Serverless / FaaS | Bajo en infraestructura, medio en depuración y pruebas | Bajo-medio | Límites de ejecución, arranque en frío, acoplamiento al proveedor [V Fowler/Roberts] |
| Orientado a eventos | Medio-alto: broker, esquemas, idempotencia, reintentos | Medio-alto: contratos de eventos versionados | Consistencia eventual no diseñada, difícil de trazar [V Azure] |
| Microservicios | Alto: orquestación, observabilidad, descubrimiento, versionado | Alto en diseño de límites; bajo entre equipos si los límites son buenos | Monolito distribuido |
| Sin backend propio (BaaS) | Mínimo | Mínimo | Reglas de seguridad en el cliente mal escritas, lock-in, techo de lógica |

### 1.4 Descripción por estilo

**Monolito (una unidad de despliegue)**
- Conviene: producto nuevo, equipo pequeño, dominio aún por descubrir, necesidad de transacciones fuertes. DHH: equipos pequeños deben construir un monolito bien estructurado; Basecamp lo hacía con unos 12 programadores [V, 2016-02-29, opinión de parte, no estudio].
- No conviene: varios equipos que se bloquean entre sí en cada release, o partes con requisitos de escala y disponibilidad muy diferentes.
- Riesgo habitual: estructura interna pobre (AWS reconoce que sin diseño modular el monolito sufre alto acoplamiento y baja cohesión y lanzar funciones se vuelve lento [V]). Nótese que AWS Prescriptive Guidance es una guía de modernización de monolitos existentes y su sesgo es favorable a descomponer; no es evidencia de que deba empezarse con microservicios.

**Monolito modular**
- Conviene: es el punto de partida por defecto. Mismo despliegue y misma BD, pero con módulos por subdominio, API pública por módulo y dependencias comprobadas por herramienta.
- No conviene: si el equipo no va a aplicar los límites automáticamente, es un monolito normal con otro nombre. También cuando un módulo ya necesita ciclo de despliegue o escala propios.
- Riesgo: erosión de límites (Fowler [V]). Mitigación con evidencia: Shopify (4.3).
- Nota de fuentes: ni AWS, ni Azure ni Google tienen (en lo que pude abrir) una página oficial que defina "monolito modular" como estilo. El término se apoya en Fowler (menciones en *Monolith First* y *Microservice Premium*) y en casos de ingeniería. Las páginas de blogs que lo recomiendan con umbrales de equipo (por ejemplo "menos de 15 ingenieros") son opinión sin evidencia; no usar esos umbrales como regla.

**Servicios separados / microservicios**
- Conviene (Azure [V]): dominio complicado, actualizaciones frecuentes, equipos autónomos, límites de dominio claros (DDD), organización con capacidades DevOps avanzadas. Fowler añade como factores de complejidad: equipos grandes, multi-tenant, evolución independiente de funciones de negocio, escala y, sobre todo, tamaño de la aplicación [V].
- No conviene: producto nuevo, dominio no estable, equipo pequeño, sin automatización de despliegue ni observabilidad, requisitos de consistencia fuerte entre las partes.
- Coste (Azure [V]): descubrimiento de servicios, consistencia de datos, transacciones, comunicación entre servicios, gobernanza, latencia en cadenas de llamadas, versionado, habilidades del equipo.
- Riesgo principal, **monolito distribuido**: servicios desplegables por separado pero acoplados por llamadas síncronas, BD compartida, librerías de dominio compartidas o despliegues coordinados. Azure lista como antipatrones el código/dependencias compartidas entre servicios y exponer servicios directamente a los consumidores [V]. Señales de diagnóstico (ver sección 5.3). Nota: la definición coloquial de "monolito distribuido" proviene de fuentes secundarias de blog (vFunction, InfoQ, Capital One), todas **[NV]** como autoridad; el contenido de Azure (acoplamiento por esquema compartido o librerías comunes, alta cohesión funcional) sí es verificado y cubre el mismo fenómeno.

**Serverless / funciones (FaaS)**
- Conviene (Fowler/Roberts [V]): cargas dirigidas por eventos, con picos o bajo volumen, equipos que quieren reducir operación.
- No conviene: sistemas de baja latencia estricta, cargas constantes de alta utilización donde servidores dedicados pueden costar menos, dependencia de estado en memoria de larga vida, procesos largos (hay tope de duración, ver datos volátiles).
- Riesgos: lock-in, pruebas de integración difíciles ("no local environment can fully simulate the cloud environment"), arranques en frío, límites de ejecución, depuración. Ojo: la fuente de Fowler/Roberts es de 2018; las cifras concretas de aquel artículo (tope de 5 minutos) están obsoletas, ver 2.1. La lista cualitativa de riesgos sigue siendo válida como criterio.
- Combinar FaaS con monolito es legítimo: una función para un trabajo puntual (procesar imagen, webhook) no convierte el sistema en "arquitectura serverless".

**Backend-for-frontend (BFF)**
- Conviene (Azure [V]): un backend general acumula demandas contradictorias de varios clientes, o un cliente necesita otro lenguaje/cadencia; un servicio por interfaz.
- No conviene (Azure [V]): una sola interfaz usa el backend, o las interfaces hacen peticiones iguales; si ya hay GraphQL con resolvers por cliente, o API gateway con microservicios, el BFF puede no aportar.
- Coste: más servicios que desplegar, salto de red extra, duplicación de código. Debe contener solo lógica específica del cliente; lo transversal (autorización, monitorización) va aparte.
- Criterio propio: con un solo cliente web y un monolito, el BFF es sobreingeniería. Un framework full-stack con renderizado en servidor ya hace de BFF.

**Orientado a eventos y colas**
- Conviene (Azure [V]): varios subsistemas procesan los mismos eventos, tiempo real, procesamiento complejo de eventos, alto volumen (IoT), desacoplar escalabilidad y fiabilidad de productores y consumidores.
- No conviene (Azure [V]): flujos simples petición-respuesta donde bastan llamadas síncronas; transacciones que requieren consistencia fuerte entre servicios; equipo sin experiencia operando sistemas asíncronos distribuidos.
- Coste y riesgos (Azure [V]): entrega garantizada, consistencia eventual, orden e idempotencia, errores (DLQ), pérdida de datos, observabilidad (ID de correlación), evolución de esquemas de eventos. En web-cola-worker, el fallo "escribo en BD y no llego a encolar" se resuelve con *transactional outbox* [V].
- Distinción útil (criterio propio): una cola para trabajo en segundo plano (web-cola-worker) es barata y casi siempre justificada; una arquitectura de eventos de dominio con múltiples consumidores es un compromiso mucho mayor.

**Sin backend propio (BaaS / servicios gestionados)**
- Definición (Roberts [V]): servicios de terceros alojados que cubren necesidades del servidor (BD, autenticación) y el cliente llama directamente.
- Conviene: prototipos, productos con lógica de servidor mínima, equipos sin operaciones. Es la opción de menor coste de coordinación y operación.
- No conviene: lógica de negocio compleja o sensible que no debe vivir en el cliente, requisitos de portabilidad/ubicación de datos, flujos con transacciones multi-entidad complejas, integraciones que exigen secretos.
- Riesgos: lock-in (Roberts [V]), control del proveedor sobre disponibilidad y precios, seguridad que pasa a depender de reglas declarativas del servicio (error fácil: dejar datos abiertos), techo de lógica que fuerza a añadir funciones/servidor después.
- Mitigación (criterio propio): preferir BaaS con base de datos estándar (por ejemplo PostgreSQL) y exportación; aislar el acceso a datos tras una capa propia aunque sea fina.

---

## 2. Datos VOLÁTILES (verificar antes de reutilizar)

### 2.1 Límites de AWS Lambda [V, 2026-10-12]
Fuente: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- Duración máxima por invocación: 900 s (15 min) en funciones normales; hasta 5.400 s (90 min) en "Lambda Managed Instances" para invocaciones asíncronas o con ciertos orígenes de eventos.
- Memoria: 128 MB a 10.240 MB. Concurrencia por defecto: 1.000 ejecuciones simultáneas (aumentable). Las cuentas nuevas tienen cuotas reducidas.
- Carga útil: 6 MB (síncrona), 1 MB (asíncrona); respuesta en streaming hasta 200 MB.
- Paquete zip: 50 MB comprimido, 250 MB descomprimido; imagen de contenedor hasta 10 GB.
- La página menciona productos recientes (Lambda MicroVMs, durable functions). Los nombres y límites cambian a menudo: tratarlos como datos que caducan.

### 2.2 Precios y cuotas de BaaS [V, 2026-10-12]
- Supabase (https://supabase.com/pricing): Free 0 USD/mes, 500 MB de BD por proyecto, 50.000 MAU, 5 GB de egress, 1 GB de archivos, pausa tras 1 semana de inactividad, 2 proyectos activos. Pro desde 25 USD/mes: 8 GB de disco, 100.000 MAU, 250 GB de egress, sin pausa por inactividad.
- Firebase (https://firebase.google.com/pricing): plan Spark sin coste: Firestore 1 GiB, 20K escrituras/día, 50K lecturas/día; Auth 50K MAU; **Cloud Functions no disponible en Spark** (requiere Blaze, de pago por uso, con 2M invocaciones/mes incluidas).
- Implicación para la skill: el plan gratuito sirve para prototipo, pero pausas por inactividad y la ausencia de funciones en el plan gratuito afectan a la decisión de "sin backend". Reverificar cifras antes de recomendarlas.

### 2.3 Nombres de servicios gestionados citados por Azure [V, 2026-10-12]
Páginas con fecha de última actualización posterior a 2026-09 (cambian): Azure Container Apps, App Service, Functions, Service Bus, Event Grid, Event Hubs, API Management; para colas hay herramientas como NServiceBus y MassTransit. No fijar nombres de producto en la skill; referirse a "plataforma de contenedores gestionada", "cola gestionada", "broker de eventos".

### 2.4 Fechas de las propias páginas (para estimar caducidad)
- Azure Architecture Styles: ms.date 2025-09-25, actualizada 2026-09-24 [V].
- Azure Microservices style: ms.date 2025-06-30, actualizada 2026-08-06 [V].
- Azure Event-driven: ms.date 2026-03-06 [V]. Azure Web-Queue-Worker: 2026-01-06 [V]. Azure BFF: 2025-03-19, actualizada 2026-09-25 [V]. Azure N-tier: 2025-08-15 [V].
- AWS Serverless Applications Lens: publicada 2022-07-14 [V] (antigua; no usarla para límites actuales).

---

## 3. Tabla de decisión

| Situación | Estilo recomendado | Motivo | Contraindicación |
|---|---|---|---|
| Producto nuevo, 1-8 desarrolladores, dominio aún cambiante | Monolito modular, una BD, servicios gestionados | Menor coste operativo y de coordinación; permite descubrir límites (Fowler, Monolith First) | Si nadie va a hacer cumplir los límites de módulo, se degrada a bola de barro |
| Prototipo/MVP con poca lógica de servidor (CRUD, auth, archivos) | Sin backend propio (BaaS) con BD estándar | Mínima operación; velocidad | Lógica sensible o compleja; requisitos de portabilidad o residencia de datos; dependencia de plan gratuito con pausas |
| Web con tareas pesadas o largas (informes, correo, imágenes) | Monolito modular + cola + worker (web-cola-worker) | Desacopla trabajo lento sin multiplicar servicios (Azure) | Si no hay tareas largas, el worker sobra; sin outbox hay inconsistencias entre BD y cola |
| Carga con picos, eventos esporádicos, tareas aisladas | Funciones puntuales junto al monolito o serverless | Pago por uso y sin gestionar servidores (Fowler/Roberts) | Latencia estricta, carga constante alta, procesos más largos que el tope, miedo al lock-in |
| Web + móvil + terceros con necesidades de API divergentes y backend general que se vuelve cuello de botella | Añadir BFF por cliente sobre el backend existente | Evita contradicciones de un API único (Azure) | Un solo cliente; APIs iguales; GraphQL ya resuelve; BFF con lógica de negocio |
| Varios equipos (decenas de ingenieros) bloqueados por releases conjuntas y límites de dominio estables | Extraer servicios por subdominio (estrangulamiento), manteniendo el resto como monolito | La autonomía entre equipos es el beneficio real de microservicios (Azure, Fowler) | Sin CI/CD, observabilidad ni guardia; límites no claros; BD compartida que no se piensa separar |
| Una parte con escala/ráfaga o requisito de aislamiento muy distinto (vídeo, ingesta, ML) | Extraer solo ese componente como servicio o worker | Escala independiente solo donde hace falta | Extraer "por si acaso" sin medir; conservar BD compartida |
| Múltiples sistemas deben reaccionar a los mismos hechos, tiempo real, IoT, alto volumen | Arquitectura orientada a eventos con broker gestionado | Desacople de productores/consumidores, escalado (Azure) | Flujos síncronos simples; consistencia fuerte exigida; equipo sin experiencia asíncrona |
| Migrar aplicación empresarial existente a la nube con mínimos cambios | N-tier / monolito en plataforma gestionada | Bajo coste de migración (Azure) | No ayuda a despliegue independiente; deuda de modularidad |
| Sistema de microservicios existente donde casi todo se despliega junto y hay BD compartida | Consolidar servicios acoplados en uno (monolito modular o servicios más gruesos) | Se paga la red sin recibir autonomía (Istio, Segment) | Servicios con equipos y ciclos de vida realmente independientes |

---

## 4. Evidencia pública de vuelta a monolito y de monolito que escala

Criterio: se incluyen solo casos cuya fuente primaria pude abrir. Todos son evidencia anecdótica de cada contexto, no prueba general; el sesgo de supervivencia y de autoselección (empresas que cuentan su historia) aplica.

### 4.1 Segment (Twilio): de más de 140 servicios a uno [V, primaria]
Fuente: https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices/ (antes segment.com/blog/goodbye-microservices/; redirige). Autora: Alexandra Noonan, 2018-07-10.
- Problemas: cola compartida con bloqueo de cabecera de línea cuando un destino se ralentiza; un repositorio por destino y cambios de librería compartida que había que probar y desplegar en decenas de servicios, con versiones desalineadas; patrones de carga muy distintos que complicaban el autoescalado; el trabajo operativo crecía con cada destino y la velocidad caía.
- Acción: consolidar en un servicio, un monorepo y una única versión por dependencia (unas 120).
- Coste admitido: el aislamiento de fallos se vuelve difícil (un destino que falla puede tirar a todos); menos eficacia de cachés en memoria; actualizar una dependencia compartida puede romper varios destinos.
- Lectura (criterio propio): es un caso de **monolito distribuido** (muchos servicios pequeños con librería compartida y mismo equipo) más que un fallo de microservicios en sí.

### 4.2 Istio: de componentes separados del plano de control a `istiod` [V, primaria]
Fuente: https://istio.io/latest/blog/2020/istiod/ (Craig Box, 2020-03-19, Istio 1.5).
- Razones: todo el plano de control ya estaba en Go; lo operaba normalmente un solo equipo; los componentes se publicaban siempre juntos y nunca se probaron en versiones mezcladas; el coste de escala lo dominaba una sola función; la separación daba poco aislamiento de seguridad.
- Lectura: es la regla de oro del criterio de despliegue independiente. Si siempre se despliega junto y lo opera el mismo equipo, separar solo añade piezas. El propio autor aclara que no concluye que los microservicios sean malos en general.

### 4.3 Shopify: monolito modular a gran escala [V, primaria]
Fuente: https://shopify.engineering/shopify-monolith (Philip Müller, 2020-09-16).
- Cifras citadas en esa fecha: más de 2,8 millones de líneas de Ruby, 500.000 commits, cientos de desarrolladores, 37 componentes en el monolito principal, en desarrollo continuo desde al menos 2006.
- Método: componentes por subdominio (DDD), Packwerk para análisis estático de referencias y dependencias en PRs, Sorbet para contratos en los límites, Rails Engines, inversión de control (pub/sub interno) para quitar ciclos, y un equipo responsable por componente.
- Honestidad del caso: el análisis inicial mostró que cada componente dependía de más de la mitad de los demás con muchos ciclos, y Packwerk cubría solo cerca de un tercio de los componentes en esa fecha; es decir, es un trabajo en curso y cuesta esfuerzo sostenido, y la cultura (Architecture Guild) importa tanto como las herramientas. Cifras de 2020, probablemente desactualizadas.

### 4.4 Descartado: Amazon Prime Video (monitorización de audio/vídeo) [NV]
- Título del post: "Scaling up the Prime Video audio/video monitoring service and reducing costs by 90%", de Marcin Kolny (fecha 2023-03-22 según búsqueda, no verificada en la página).
- No pude abrir la fuente primaria: la URL de primevideotech.com devolvió una redirección 301 a una página genérica de Amazon (aboutamazon.com) y no al artículo. La copia en PDF de terceros (wudsn.com) contiene solo metadatos y el título; no se pudo leer el cuerpo. Todo lo demás (Step Functions + Lambda, límite de escala al 5 %, 90 % de ahorro) proviene de resultados de búsqueda secundarios, que **no uso como evidencia**.
- Aviso para la skill: aunque el caso se cite mucho, no sirve como "vuelta a monolito" sin su fuente primaria, y por lo que se reporta era un solo servicio interno de análisis, no la plataforma de streaming. No incluir la cifra del 90 % en la skill.

### 4.5 Otras apariciones no usadas
- DHH, "The Majestic Monolith" [V, 2016-02-29]: es una opinión argumentada (Basecamp, ~12 programadores), no un caso medido. Sirve como posición, no como dato.
- Artículos de blog que fijan umbrales de equipo para elegir estilo [NV como evidencia]: son opinión secundaria sin metodología.

---

## 5. Señales de migración

Regla general: migrar por una señal medida y repetida (varias semanas o releases), no por una previsión. Cada señal debe nombrar qué cuello de botella resuelve y cómo se comprobará que mejoró.

### 5.1 Monolito (o modular) -> extraer un servicio / servicios separados
Señales (criterio propio, apoyadas en Azure, AWS Prescriptive Guidance y Fowler):
- Equipos que se bloquean entre sí: cola de releases, conflictos de integración frecuentes, necesidad de coordinar un despliegue grande (AWS lo cita como carga de coordinación [V]).
- Un módulo con cadencia de cambio, requisitos de escala o de disponibilidad claramente distintos y medidos (no estimados).
- Requisito regulatorio o de seguridad que exige aislar datos o proceso.
- Un componente con otra tecnología imprescindible (GPU, runtime distinto).
- Límites de dominio estables (llevan meses sin moverse entre módulos) y ya aplicados por herramienta.
Prerrequisitos antes de extraer: CI/CD automatizado, observabilidad con correlación, contratos versionados, propietario del servicio con guardia. Método habitual: estrangulamiento gradual desde los bordes dejando el núcleo (Fowler, *Monolith First*, y patrón *strangler fig* en AWS [V]).

### 5.2 Microservicios (o muchas piezas) -> consolidar
Señales (Segment e Istio):
- Los servicios casi siempre se despliegan juntos o en el mismo orden.
- Mismo equipo opera todos, con cadencia de versión única.
- Librerías compartidas que obligan a actualizar muchos servicios a la vez.
- Una sola capacidad domina el coste y el resto aporta poco por separado.
- La mayor parte del tiempo de ingeniería va a plomería (colas, reintentos, versiones) y no a producto.

### 5.3 Señales de monolito distribuido (diagnóstico)
- Un cambio funcional toca varios servicios y exige despliegues coordinados.
- BD o esquema compartido entre servicios; librerías de dominio compartidas (antipatrón en Azure [V]).
- Cadenas de llamadas síncronas largas A -> B -> C y APIs "charlatanas" (Azure [V]: indicio de acoplamiento y baja cohesión).
- Ningún servicio puede probarse sin los demás.
Acción: o se rediseñan límites con acoplamiento asíncrono y datos propios, o se consolida. No se resuelve añadiendo más servicios.

### 5.4 Sin backend / BaaS -> backend propio
- Aparece lógica de negocio que debe ocultarse del cliente o requiere secretos/integraciones.
- Las reglas de seguridad declarativas se vuelven imposibles de razonar o probar.
- Costes del proveedor crecen de forma no lineal (egress, lecturas) o los límites del plan bloquean (ver 2.2).
- Necesidad de portabilidad o de residencia de datos.
Primer paso: una capa de API propia delante, no reescribir todo.

### 5.5 Serverless puro -> contenedor o monolito en plataforma gestionada
- Procesos que chocan con topes de duración, memoria o carga útil (2.1).
- Carga alta y estable donde el pago por uso sale más caro que una instancia (Roberts [V]).
- Latencia por arranque en frío inaceptable.
- Dolor de pruebas locales y depuración que frena al equipo.

### 5.6 Cola simple -> arquitectura de eventos
- Más de un consumidor independiente necesita los mismos hechos; hay que reproducir o auditar flujo de eventos; volumen o latencia que la cola no atiende.
- Condición previa: idempotencia, ID de correlación, estrategia de versionado de esquemas, DLQ y propietario por tipo de evento (Azure [V]).

### 5.7 Añadir BFF
- Un cliente nuevo (móvil, socio) fuerza cambios en el API que rompen o complican al cliente existente; el equipo del cliente espera al del backend para cada ajuste (Azure [V]).

---

## 6. Fuentes

| Fuente | URL | Estado | Notas |
|---|---|---|---|
| Fowler, Monolith First | https://martinfowler.com/bliki/MonolithFirst.html | Verificado 2026-10-12 | 2015-06-03; el propio Fowler admite pocas evidencias |
| Fowler, Microservice Premium | https://martinfowler.com/bliki/MicroservicePremium.html | Verificado 2026-10-12 | 2015-05-13 |
| Fowler, Microservice Trade-Offs | https://martinfowler.com/articles/microservice-trade-offs.html | Verificado 2026-10-12 | 2015-07-01 |
| Fowler/Lewis, Microservices | https://martinfowler.com/articles/microservices.html | Verificado 2026-10-12 | Costes y prerrequisitos implícitos; la página enlaza el artículo de trade-offs |
| Fowler/Roberts, Serverless Architectures | https://martinfowler.com/articles/serverless.html | Verificado 2026-10-12 (cola de 2.865 caracteres sin leer) | 2018-05-22; cifras de límites obsoletas |
| Azure, Architecture styles | https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/ | Verificado 2026-10-12 | Tabla de estilos y restricciones |
| Azure, Microservices | https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/microservices | Verificado 2026-10-12 | Beneficios, retos, antipatrones |
| Azure, Event-driven | https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/event-driven | Verificado 2026-10-12 | Cuándo no usar |
| Azure, Web-Queue-Worker | https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/web-queue-worker | Verificado 2026-10-12 | |
| Azure, N-tier | https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/n-tier | Verificado 2026-10-12 | |
| Azure, Backends for Frontends | https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends | Verificado 2026-10-12 | |
| AWS Prescriptive Guidance, Decomposing monoliths | https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/introduction.html | Verificado 2026-10-12 | Sesgo pro-descomposición (guía de modernización) |
| AWS Lambda quotas | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html | Verificado 2026-10-12 | Datos volátiles |
| AWS Well-Architected Serverless Applications Lens | https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html | Verificado solo la portada (2022-07-14); contenido de pilares no leído | No se usó para criterios |
| Google Cloud, What is microservices architecture | https://cloud.google.com/learn/what-is-microservices-architecture | **NO VERIFICADO**: el contenido no llegó; la antigua página de arquitectura redirige aquí | Por tanto no hay criterio de Google en este informe |
| AWS Well-Architected Framework (pilares generales) | https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html | **NO VERIFICADO** (no abierto) | |
| Azure Well-Architected, simplicidad | https://learn.microsoft.com/en-us/azure/well-architected/design-guides/simplicity | **NO VERIFICADO** (404) | |
| Segment/Twilio, Goodbye Microservices | https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices/ | Verificado 2026-10-12 | 2018-07-10 |
| Istio, Introducing istiod | https://istio.io/latest/blog/2020/istiod/ | Verificado 2026-10-12 | 2020-03-19 |
| Shopify Engineering, monolito modular | https://shopify.engineering/shopify-monolith | Verificado 2026-10-12 | 2020-09-16 |
| DHH, The Majestic Monolith | https://signalvnoise.com/svn3/the-majestic-monolith/ | Verificado 2026-10-12 | Opinión, 2016-02-29 |
| Prime Video Tech, Scaling up audio/video monitoring | https://www.primevideotech.com/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90 | **NO VERIFICADO**: redirige a página genérica; sin cuerpo legible | Descartado como evidencia |
| Supabase pricing | https://supabase.com/pricing | Verificado 2026-10-12 | Volátil |
| Firebase pricing | https://firebase.google.com/pricing | Verificado 2026-10-12 | Volátil |
| Definiciones de "monolito distribuido" (vFunction, InfoQ, Capital One, DZone, InfoWorld) | varias | **NO VERIFICADO** (solo vistas en resultados de búsqueda, no abiertas) | No usar como cita |
| Context7 | no aplica | No usado | Tema sin librería concreta |

---

## 7. Resumen final: qué cambiaría la recomendación de la skill

1. Por defecto, monolito modular con una sola BD y servicios gestionados; microservicios solo ante una señal medida de la sección 5.1.
2. "Modular" solo cuenta si hay límites verificados por herramienta en CI; sin eso, tratarlo como monolito normal.
3. Preguntar primero por despliegue independiente real y por número de equipos; el tamaño de equipo solo orienta, no hay umbral verificado.
4. Madurez operativa (CI/CD, observabilidad, guardia) es condición previa para más de un servicio, no un extra.
5. Una cola con worker es barata y casi siempre válida; eventos de dominio con múltiples consumidores es un compromiso mayor y se justifica por consumidores reales.
6. BFF solo con varios clientes con necesidades divergentes; con un cliente es sobreingeniería.
7. BaaS válido para MVP, con base de datos estándar y una capa propia delante; revisar límites y pausas del plan gratuito (volátiles).
8. Serverless para tareas puntuales y picos; revisar topes de duración, carga y lock-in antes de basar todo el sistema en funciones.
9. Incluir el diagnóstico de monolito distribuido (despliegues coordinados, BD o librerías compartidas) y permitir recomendar consolidar, no solo dividir.
10. No citar Prime Video ni umbrales de equipo de blogs; casos sólidos: Segment, Istio (consolidación) y Shopify (monolito modular).
11. Falta verificar Google Cloud y los pilares de AWS/Azure Well-Architected antes de citarlos como fuente.
12. Mantener los límites y precios fuera del cuerpo de la skill; enlazar a la fuente con su fecha.
