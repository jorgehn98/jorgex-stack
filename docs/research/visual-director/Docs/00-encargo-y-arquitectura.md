# 00 — Encargo y arquitectura mínima (v1)

> **Arquitectura mínima definida para el primer borrador — implementación pendiente.** 2026-10-03. La nueva versión conforme a esta arquitectura aún no está implementada; la skill original `visual-director/` existe y permanece intacta, y el usuario puede seguir invocándola como hasta ahora. La activación de esa skill operativa sigue siendo **manual** por decisión del usuario, y este capítulo **no** la nombra distinto ni la sustituye: define la dirección de la próxima versión, no la fase actual. Este capítulo es la **fuente autorizada** de las decisiones de arquitectura del primer borrador; los capítulos 01–23 son investigación comparativa y material de soporte, no instrucciones de runtime concurrentes. **No** se afirma que el usuario haya revisado cada elección artística ni que se haya hecho QA de assets; el cierre arquitectónico refleja la decisión del usuario de "cerrar arquitectura mínima, ir documentando/organizando/actualizando" — no una validación artística pieza por pieza.

## 1. Encargo y origen

El coordinador pidió preparar un dossier que documente y proponga la evolución de `visual-director/` sin tocar la skill ni ejecutar instalaciones. La pasada del 2 de octubre consolidó encargo, métodos de vídeo, herramientas, web, CLODYSSEY, edición, brand kit, criterio artístico, casos y un caso read-only (PhotoHeart). La pasada del 3 de octubre cierra la **arquitectura mínima** del primer borrador y la deja escrita de forma que un lector futuro sepa qué hace la skill, qué no hace, qué referencia cargar y qué no debe esperar. La skill original queda intacta; su activación sigue siendo **manual** por decisión del usuario.

## 2. Estado observacional conservado (2 Oct 2026)

Estos hechos son **observación fechada** del estado del repositorio en la pasada anterior, no decisiones de arquitectura. Se conservan para que la auditoría pueda verificar qué se inspeccionó.

- **Skill original intacta**: `SKILL.md` + 13 archivos en `references/` + 2 plantillas en `assets/` + `evals/evals.json` con 16 prompts — ningún cambio aplicado. La presencia de los prompts no acredita ejecución.
- **Carpeta `Docs/`**: 24 documentos numerados (00–23) + `README.md` + `fuentes.md`. El capítulo 23 y el material fuente de CLODYSSEY analizado no forman parte de este repositorio.
- **Revisión del mapa**: [`visual-director-mapa.md`](../visual-director-mapa.md) (2 de octubre de 2026) ya distinguía observación de propuesta y señalaba huecos. Se conserva como vista histórica del estado; el aviso de archivo de autoridad se añade en su cabecera en esta pasada.
- **Caso PhotoHeart**: el capítulo 23 describe la V3 **aprobada según el usuario** y **no verificada** por esta revisión. No se reabre su polish ni se reproduce su V3; el caso se cita como referencia de lecciones, no como benchmark a igualar.
- **Vídeo final y audio de CLODYSSEY**: sin inspeccionar en esta fase; la verificación queda pendiente, registrada como tal.

## 3. Decisiones cerradas de arquitectura (v1)

Las siguientes decisiones quedan cerradas para el primer borrador. La skill las recoge cuando se materialice; el dossier no las reabre.

### 3.1 Una sola skill raíz

- **Una** skill raíz de invocación manual: `visual-director` (nombre real existente, no se introduce un nombre nuevo en este capítulo; "manual" describe la activación, no el nombre). **No** una familia de skills nuevas por herramienta ni por framework.
- El núcleo artista **comparte** brief + idea + brand + look + criterio de prueba + routing + prototype + execute-review + delivery + final style memory entre todos los medios.
- **Medios y métodos son combinables**, no un árbol exclusivo. El medio (web / audiovisual / gráfica fija) y el método de producción (código / 3D / generación / material existente) son ejes ortogonales.
- **Nuevos medios** entran después como extensiones con caso de uso concreto; **no** se crean carpetas vacías por adelantado.

### 3.2 Tres rutas de entrega v1

| Ruta | Entregables típicos | Límite v1 |
| --- | --- | --- |
| **Web / interfaces** | landing, UI, marketing, editorial, portfolio, comercio, producto, dashboard, aplicación, experiencia interactiva e inmersiva | estados, accesibilidad, responsive; el vídeo hero es **entrega web** pero recibe guía AV cuando se produce o revisa como asset de vídeo |
| **Audiovisual** | guion, motion, creación 3D, generación, montaje de grabaciones; motion design, tipografía en movimiento, UI en vídeo, datos, narrativo/cinematográfico, producto, híbridos | no cuarta categoría de entrega por ser 3D; 3D es **método/asset** |
| **Gráfica fija (DIRECTOR mínima)** | cartel, banner, miniatura, ilustración, diapositiva fija | pieza no temporal y no interactiva; **no** sistema de identidad completo, **no** preprensa, **no** juegos XR, **no** motor 3D propio |

Fuera del alcance v1 (se citan solo para no reabrirlos por accidente): sistema de identidad completo, preprensa, juegos XR, motor 3D nuevo, audio puro autónomo como entregable independiente. **Audio**: capability de apoyo a audiovisual, web y asset; **no** medio puro NUEVO por defecto en v1. **3D**: método/asset compartido por las tres rutas, no cuarta categoría de entrega.

### 3.3 Producción, prototipo y entrega

- **Múltiples entregables** con un mismo brief y visual system se producen con QA individual cuando hace falta, no se reescribe el sistema por cada pieza.
- **Imagen / vídeo / audio generation** son capacidades **compartidas** por las tres rutas; el método concreto se elige por el problema, no por menú.
- El caso de uso decide el camino: web con vídeo hero = entrega web, con guía AV cuando se produce o revisa el asset de vídeo.
- **Nuevos medios o métodos** posteriores: solo cuando un caso real lo justifique; **no** se pre-crean carpetas ni archivos.

## 4. Fases del núcleo artista (tabla ENTRADA → decisión → SALIDA)

El flujo se resume por fase. Cada fase declara su entrada, su decisión interna y la salida esperada con su evidencia. Las fases intermedias resuelven decisiones y dejan la evidencia necesaria cuando aporta valor; la fase final entrega lo solicitado. La documentación de avance no sustituye a la pieza ni obliga a crear un artefacto nuevo por fase. El flujo es **resumable**, no una tubería full-forced: una consulta puntual de idea se detiene en propuesta; una continuación re-entra en la fase pendiente con los registros previos.

| # | Entrada | Decisión | Salida (evidencia / readiness) |
| --- | --- | --- | --- |
| 0 | Contexto (fase previa, brief existente, tokens visuales, assets, audiencia + objetivo) y **modo** (`NEW` / `REDESIGN` / `CONTINUATION` / `EDIT`) | Clasificar el encargo; cargar solo referencias para la **decisión de la fase actual** (no pre-cargar el set entero) | Clasificación registrada; referencia mínima cargada para la decisión en curso |
| 1 | Brief del usuario (idea definida o abierta) | Si la idea es **conocida**: transformar y preservar sin reiniciar. Si es **abierta**: 2–3 hipótesis realmente distintas; recomendar una o prototipar si el material lo exige; preguntas compactas sucesivas solo para lo esencial | Hipótesis o prototipo característico; preguntas solo cuando cambia decisiones materiales |
| 2 | Brief + modo | Dirección / sistema: paleta, tipografía, composición, imagen, material, motion, cámara, audio (donde aplique); reutilizar brand existente cuando exista | Dirección propuesta o reutilizada; sin reescribir la marca previa |
| 3 | Dirección aprobada o propuesta | Plan de producción: **métodos mínimos suficientes** con herramientas existentes; coste, derechos y viabilidad **antes** de prometer o renderizar el lote | Plan con métodos, costes, derechos, viabilidad; el render del lote no empieza aquí |
| 4 | Plan | Prototipo representativo del **riesgo creativo y técnico** (un buen frame no prueba ritmo; metadatos de fps no prueban suavidad; derechos de assets antes de usarlos en la pipeline) | Prototipo con sus advertencias declaradas |
| 5 | Prototipo aprobado (o aprobación delegada del alcance) | Producción **autónoma** dentro del scope ya aprobado: render real, inspección de modalidades disponibles, evaluación creativa + técnica contra el brief, corrección de causa, re-chequeo de las partes afectadas, persistencia de checkpoint; **límites de coste / tiempo / reintentos** acordados con el proyecto o fijados por las reglas de nivel superior — **no** un número fijo de revisiones | Lote producido, evaluado, corregido, persistido |
| 6 | Lote producido | Delivery: qué se construyó, cómo se previsualizó, fuente y límites verificados → feedback del usuario → ejemplo final aceptado registrado en la memoria de estilo del proyecto / actualización de brand norm **solo dentro del scope aprobado** | Pieza entregada; ejemplo final aceptado; memory actualizada dentro del scope |

- **No** se añaden firmas ceremoniales por fase si la decisión ya está delegada.
- **No** se imponen preguntas, prototipos o artefactos de fase para trabajos one-off o invocación explícita rutinaria.
- Si el usuario pide solo ideas, la respuesta se detiene en la **propuesta**; no se fuerza la elección de visión.
- **Continuación**: re-entra en la fase pendiente usando los registros previos; **no** relanza la conversación de visión.
- **Unknowns esenciales** (derechos, permisos, presupuesto, capacidades) se preguntan al usuario; los **asumidos acotados** se declaran; **no** se congela todo el trabajo por detalles no esenciales.
- **STOP** suficiente cuando: calidad alcanzada, fuera de alcance, sin mejora posible entre iteraciones, recursos agotados, falta una modalidad de asset, o el runtime está bloqueado. Si no se puede **observar**, **no** se afirma "superado"; una aprobación editorial sigue aprobada, pero la verificación técnica pendiente se declara por separado.
- **PhotoHeart V3** queda aprobada por el usuario y no se reabre su polish sin un objetivo nuevo.

## 5. Brief — campos lógicos, no JSON obligatorio

El brief es **lógico y opcional por contexto**, no un esquema JSON fijo. Se recoge lo que cambia decisiones; **no** se exige omnisciencia. Los registros del proyecto prevalecen sobre un nuevo intake si ya están vigentes.

- **Goal** — marketing vs demo vs tutorial se distinguen desde aquí.
- **Audience** — a quién va; nivel, contexto, dispositivo.
- **Core message / action** — lo único que debe recordarse o hacerse.
- **Deliverable / format(s)** — qué se entrega y en qué formato.
- **Desired perception** — cómo debe sentirse.
- **Brand assets / rights** — qué assets y qué derechos se pueden usar.
- **Non-negotiables** — lo que no se rompe.
- **Technical context / success criteria** — stack, navegadores, accesibilidad, rendimiento, criterios de éxito (al menos uno creativo + uno técnico).
- **Cost / time / authorized actions** + **declared assumptions** — presupuesto, plazo, qué se puede ejecutar sin pedir, y qué se asume (con declaración explícita).

**Ejemplos** de pregunta de alto valor cuando hace falta: ¿una gráfica se ve de **lejos** o de **cerca**? ¿un vídeo busca **emoción** o **proceso**? ¿una landing busca **aclarar** o **actuar**? **No** se inventan marca, testimonios ni datos de prueba: las hipótesis no suplen los hechos.

## 6. Métodos compartidos (se eligen por rol, no por menú)

Cada método se elige por la **función que cumple**, no por catálogo. Distintos motores pueden coexistir; **un dueño por propiedad / reloj**. Cuando el vídeo es programático, se elige **un** reloj primario.

- **Material existente / captura** — footage, fotos, audio grabado. La captura nativa (cámara en tiempo real) es válida cuando el caso lo pide; **no** se declara `MediaRecorder` universalmente malo.
- **CSS / SVG / JS code-motion / Canvas / 3D** — capa programática para web y para vídeo si encaja.
- **3D authoring / render / previz** — cámara y blocking proxy + apariencia; el modelo 3D usado como **referencia** para generación posterior no promete fidelidad exacta de geometría; compatible cuando encaja.
- **Generative media** — proveedor existente, neutro sobre la entrada real: comprobar **entradas admitidas** según la interfaz o el checkpoint de cada modelo — imagen inicial, imagen final, vídeo, pose, trayectorias o cámara — y **no** asumir que basta con "la última imagen" en todas las pipelines; cada modelo declara su contrato, no se promete desde un catálogo.
- **Audio (VO / música / SFX)** — se elige por necesidad real y derechos; **no** se asume "voz mala si falta" — la decisión se justifica.
- **Assembly / edit / compositing / transcription** — para material grabado: in/out, source → timeline, captions; ASR ≠ alignment ≠ VAD; se preservan colas verdaderas y significado final; metadatos de fps no equivalen a cadencia.

## 7. Referencias futuras: archivo, dueño, cuándo cargar

Estructura **plana**, no jerárquica; **una referencia por responsabilidad**, sin duplicar. Los nombres reales del repositorio actual se conservan para no generar churn; los archivos aún no creados se muestran como `path/` en árbol de código, no como referencia navegable hasta que existan.

| Área | Archivo | Dueño | Estado actual |
| --- | --- | --- | --- |
| Brief común | `references/discovery.md` | núcleo | existente |
| Dirección creativa | `references/visual-direction.md` | núcleo | existente |
| Sistema visual | `references/design-system.md` | núcleo | existente |
| Registro de diseño | `references/design-record.md` | núcleo | existente — reusa `DESIGN.md` del proyecto |
| Ruta web / interfaces + estados + QA | `references/frontend-routing.md` | web | existente; contraste con [`21`](21-web-interfaces-estados-y-experiencia.md) |
| Ruta audiovisual general + sub-flujos programático / grabado (edición + transcripción) | `references/video-routing.md` | audiovisual | existente; **no** todo AV empieza por Remotion vs HyperFrames |
| Ruta gráfica fija | `references/graphic-routing.md` | gráfica | **propuesto** — cartel, banner, miniatura, ilustración, diapositiva |
| Motion programático JS / Canvas / WebGL | `references/motion-graphics.md` | motion | existente |
| 3D y shaders | `references/3d-shaders.md` | 3D | existente |
| Generación imagen / vídeo | `references/generative-media.md` | generación | **propuesto** |
| Audio (VO / música / SFX) | `references/audio.md` | audio | **propuesto** |
| OpenDesign | `references/opendesign.md` | recursos | existente; endurecer "no estado de instalación" + "preguntar antes de instalar" |
| Criterios comunes y por medio | `references/quality-bar.md` | calidad | existente |
| Official docs | `references/official-docs.md` | recursos | existente |

Total objetivo cuando se materialice: **14 referencias + SKILL.md + 2 plantillas opcionales + evals.json** (sin runtimes extra en la skill). `toolbox.md` y `recipes.md` se **consolidan** en las referencias relevantes durante un futuro draft autorizado: no se duplican por defecto, no se borran ahora, no se crean archivos nuevos ahora. El árbol de código siguiente muestra la **estructura objetivo**; los archivos aún no existentes se citan como planeados, no como referencia vigente.

```text
visual-director/
├─ SKILL.md
├─ references/
│  ├─ discovery.md            # brief común
│  ├─ visual-direction.md     # dirección
│  ├─ design-system.md        # sistema visual
│  ├─ design-record.md        # registro
│  ├─ frontend-routing.md     # web + estados + QA
│  ├─ video-routing.md        # AV + sub-flujos programático / grabado
│  ├─ graphic-routing.md      # gráfica fija (propuesto)
│  ├─ motion-graphics.md      # motion programático
│  ├─ 3d-shaders.md           # 3D + shaders
│  ├─ generative-media.md     # generación imagen / vídeo (propuesto)
│  ├─ audio.md                # VO / música / SFX (propuesto)
│  ├─ opendesign.md           # recursos
│  ├─ quality-bar.md          # criterios comunes + por medio
│  └─ official-docs.md        # verificación por tecnología
├─ assets/                    # CREATIVE_BRIEF.template.md + VISUAL_PLAN.template.md (opcionales)
└─ evals/evals.json
```

**Cuándo cargar qué** — pista rápida (no exhaustiva). El lector carga la raíz y solo la referencia del medio + los métodos que ese medio necesita; **no** se pre-carga `Docs/` entero.

| Decisión | Cargar |
| --- | --- |
| Brief y dirección | `discovery.md` → `visual-direction.md` → `design-system.md` |
| Pieza web | `frontend-routing.md` (+ `motion-graphics.md` si hay motion) → `quality-bar.md` |
| Pieza audiovisual | `video-routing.md` (programático / grabado) → `motion-graphics.md` / `3d-shaders.md` / `generative-media.md` / `audio.md` según método |
| Gráfica fija | `graphic-routing.md` (propuesto) → `quality-bar.md` |
| QA transversal | `quality-bar.md` |

## 8. Referencias de herramientas (futuro, breve, condicional)

- Una herramienta externa entra como **1–2 frases** con rol, cuándo aplica y disponibilidad; el detalle vive en la doc oficial.
- **Verificación previa**: binarios del sistema (`command -v` / `--version`), dependencias del proyecto (`package.json` u homólogos), MCP / conectores disponibles, auth (sin imprimir secretos), capacidades declaradas hoy.
- **No hay shortlist de marca** obligatoria: la selección la hace el usuario; la skill no recomienda proveedor favorito. Cuando el usuario declara uno, se verifica `connected`, `caps`, `auth`, `scope` y créditos antes de invocarlo.
- **Conectar o instalar no autoriza** gasto, subida, publicación ni delegación a otro agente. Si la herramienta ya está instalada con uso y créditos autorizados, **no** se pide nuevo permiso dentro de ese scope; se pide cuando se excede el lote, aparecen datos sensibles nuevos, aparece proveedor o cuenta no previstos, o se requieren permisos nuevos.
- **MCP remoto con OAuth** normalmente **no** requiere runtime local; se añade la URL/endpoint en el cliente que el usuario indique. **`npx` no es inocuo** — puede descargar y ejecutar; la skill lee lo que el paquete declara antes de invocarlo.
- **OpenDesign** se mantiene como **guía opcional, no ejecutor**, sin estilo impuesto y sin estado de instalación persistido en la skill. Cualquier ampliación a generación exige cambio explícito de alcance.
- La skill **no** guarda rutas de host, versiones del entorno local ni estado de instalación en un cuerpo reutilizable. La verificación de doc oficial se hace **en el momento** de usar la herramienta, no se reproduce como catálogo.
- **Sin scripts de preflight universales**; la verificación se hace caso a caso cuando hace falta.
- **Si falta una herramienta necesaria**, explicar el motivo y **pedir permiso** con el **comando oficial vigente** adecuado al sistema operativo, gestor de paquetes y versión; **no** instalarla por efecto lateral ni en un script oculto. Si falta un **conector generativo**, preguntar al usuario qué plataforma o cliente usa y si quiere conectarla; si no tiene ninguna o pide ayuda, **ofrecer alternativas justificadas**, **sin** preferencia fija de proveedor, y dejar la elección al usuario. La skill **no** guarda en su cuerpo el estado de "instalado/no instalado" ni el proveedor elegido por el proyecto, porque ambos pertenecen al entorno y al proyecto, no a la skill.

## 9. Propiedad y fronteras (lo que esta skill NO absorbe)

- **Root** es dueña de: qué resultado, qué proceso, qué intención, qué decisión artística, qué coordinación visual. La skill **no** sustituye orquestación de proyecto, git/CI, auth de negocio, estados de UI, ni persistencia de datos.
- **Ejecución técnica**: la realiza el **agente actual o el experto asignado**, con acceso a docs y skills oficiales cuando aporten. La skill aporta instrucciones de dirección y producción al agente actual o al especialista ya asignado. Ese agente puede ejecutar el trabajo visual dentro del alcance y permisos aprobados; usar la skill no activa automáticamente servicios de generación, instala otras skills ni lanza nuevos agentes. Consultar una skill técnica existente cuando sea útil no significa invocar otro agente o servicio.
- **Workflow de proyecto** sigue siendo dueña de tareas, delivery operacional, git y deploy. La skill **no** aprueba installer = budget = upload = publish por sí misma; cada uno requiere la confirmación que el workflow del proyecto ya tiene prevista. La skill **no** convierte la conexión de un MCP en una instrucción de gasto automática que anule el brief.
- **Sin regímenes ocultos** de instalación de skills, sin auto-instalación de paquetes globales, sin set predefinido de skills a montar.

## 10. ONE HOME per dato (reglas para el proyecto)

- **Dueño único por dato**: se identifica la **fuente autorizada de cada dato** según su naturaleza — código, biblioteca de tokens o Figma u otro maestro del proyecto para los **valores exactos**; registro visual (`DESIGN.md` u otro) para la **intención**; plan del proyecto para **tareas y fases**; checkpoint o handover existente para la **evidencia**. **No** se impone un ganador universal (por ejemplo, el código del proyecto no siempre prevalece sobre un sistema de tokens o sobre Figma: la fuente canónica es la que el proyecto ya eligió para ese dato). Las discrepancias se **explicitan**, no se silencian. Cada dato mantiene **un dueño** y se **referencia** desde la skill, no se duplica.
- **Estados**: `propuesto / inferido / observado / declarado / aprobado / verificación pendiente` conviven; una decisión puede estar **aprobada** y su **verificación** seguir pendiente por separado.
- **Aprobación no es verificación**: una aprobación editorial no presenta la verificación técnica como superada; ambas se registran, sin colapsarse.
- **Re-entrar por fase**: el estado de cada fase vive en el registro del proyecto; re-entrar **no** relanza el trabajo entero, solo pide el delta. Sin un registro adecuado, se conserva **un único registro visual mínimo** siguiendo la **convención del proyecto** cuando el trabajo sea reutilizable o tenga varias iteraciones; una **exploración puntual** puede quedar registrada en la respuesta, no exige archivo nuevo. Retomar una **producción** exige conservar las decisiones y la evidencia mínimas para no repetir dirección ni QA. **No** se crea un tablero nuevo por defecto ni se meten estados de tareas en `DESIGN.md`; si el proyecto ya tiene un plan, los estados continúan allí. **No** se crean archivos obligatorios por cada fase; el registro se adapta al proyecto, no al revés.
- **Decisiones reutilizables** persisten entre iteraciones; un chat efímero de exploración **no** se replica como docs nuevos por ceremonia.
- **Cambio de marca** vs **variante de campaña**: una variante aprobada entra al brand kit como **ejemplo aprobado** con su alcance; **no** sustituye la norma de identidad salvo que el usuario pida el cambio de marca o delegue explícitamente.
- **PhotoHeart V3**: aprobada por el usuario; **no** se reabre su polish sin objetivo nuevo; la skill **no** la usa como benchmark a igualar.
- **Historial**: se usa `git`/historial del proyecto; **no** se mantiene una base de datos de procedencia por píxel.

## 11. Lo que esta arquitectura evita

- **No** convierte `Docs/` en instrucciones de runtime paralelas a `SKILL.md`. La skill operativa se construye desde `SKILL.md` + `references/`; `Docs/` es investigación comparativa y soporte, no compite.
- **No** se duplica el brief por medio. Núcleo cubre lo común; cada medio adapta.
- **No** se hace catálogo de herramientas. Cada decisión se justifica con el brief.
- **No** se guardan rutas de instalación en la skill. El estado del entorno pertenece al entorno.
- **No** se mezclan ejes. Medio y método son ortogonales.
- **No** se reabre la dirección cuando ya está aprobada. Se conserva salvo cambio autorizado; se revisa solo el delta.
- **No** se sustituyen `DESIGN.md`, el PRD ni el plan del proyecto. La skill reusa al dueño existente.
- **No** se firma cada fase por ceremonia; las decisiones ya delegadas se ejecutan.
- **No** se afirma cobertura exhaustiva. La matriz en [`18`](18-cobertura-del-encargo.md) documenta evidencia, no tareas.
- **No** se reabre la aprobación de PhotoHeart V3. El caso se cita como lección, no como objetivo.

## 12. Estado y pendientes

- **Cerrado en esta pasada (2026-10-03)**: la **arquitectura mínima** del primer borrador (sección 3), las fases del núcleo artista (sección 4), el brief lógico (sección 5), los métodos compartidos (sección 6), la estructura de referencias con dueños (sección 7), las referencias de herramientas (sección 8), la propiedad y fronteras (sección 9), y la regla de "one home per dato" (sección 10).
- **Sigue pendiente**: la **materialización** de la nueva versión de la skill (editar `SKILL.md` para alinearlo con esta arquitectura sin alterar la skill actual `visual-director/`, fusionar las prácticas de `Docs/04`–`09` que no contradigan 00, **crear las tres referencias planeadas del primer borrador** — `graphic-routing.md`, `generative-media.md`, `audio.md` — en la futura pasada autorizada, **usando contenido útil ya investigado en `Docs/`**, y fusionar `toolbox.md` y `recipes.md` en las referencias relevantes). Esta pasada **no** crea los archivos ni instala motores ni crea carpetas vacías; la materialización se hace solo en una pasada posterior autorizada. La arquitectura v1 ya **define** las tres rutas (web / audiovisual / gráfica fija) y los métodos compartidos; **no** se reabre por falta de ejecución. Las referencias planeadas están listadas como **planeadas para v1**, no como "propuestas abiertas": existen en la estructura, se materializan en la pasada autorizada, y cualquier método nuevo fuera de v1 sigue requiriendo caso de uso concreto.
- **Sigue intacto**: la skill original y el caso PhotoHeart.
- **Sigue sin verificar**: el vídeo final y el audio de CLODYSSEY; los renders de cualquier caso futuro; las métricas reales de cualquier entrega.
- **Sigue sin afirmar**: que el usuario haya revisado cada elección artística pieza por pieza, o que se haya hecho QA de assets. La arquitectura está cerrada; la calidad se demuestra en runtime, no en este dossier.
- **Mapa histórico**: [`visual-director-mapa.md`](../visual-director-mapa.md) conserva su cuerpo del 2 de octubre como vista histórica; en esta pasada se le añade un aviso en cabecera que apunta a este capítulo como autoridad vigente.
