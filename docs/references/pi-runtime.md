# Pi runtime

JorgeX Stack integra Pi mediante dos capas coordinadas: el paquete Pi-native exacto y una proyección de recursos compartidos propiedad de Stack. Pi no se traduce a través del manifest de componentes ni del model map de Stack. El proveedor oficial de Engram conserva la propiedad de su setup, MCP, herramientas y captura; Stack no inyecta un protocolo Engram ni filtra sus herramientas.

Las instalaciones/actualizaciones gestionadas deliberadas no usan un pin estático como selector. `src/lib/pi-runtime.ts` coordina el lifecycle; `src/lib/pi-install-preflight.ts` resuelve en vivo el `dist-tags.latest` estable publicado, valida URL/SRI, descarga bytes verificados, prepara un stage aislado y construye el candidato desde el paquete staged contra el contrato Stack. `src/lib/pi-runtime-pin.json` y `src/lib/pi-runtime-history.json` conservan identidades congeladas, incluidas referencias históricas para receipts y recuperación; no describen una instalación personal actual. El workflow `pi-artifact.yml` también resuelve la versión observada y verifica SRI. La publicación de Stack usa el auto-bump existente al mergear y selecciona el patch disponible.

El canon de Stack y el paquete Pi adoptado mantienen una snapshot de 17 árboles de skills con 89 archivos de skill. El contrato vigente añade `initialization-diagnostics-v1` sobre `experience-defaults-v1`: en la primera inicialización siembra solo los campos ausentes `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true`, y conserva cambios o borrados del usuario sin resembrarlos. `hideThinkingBlock` solo cambia la presentación; `defaultThinkingLevel` y el razonamiento no cambian. Pi solo posee los campos de settings que crea y registra en su receipt; los valores preexistentes del usuario quedan sin ownership. Pi compatible publicado acepta el handoff Playwright v2 byte-bound en `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json`; el nombre del archivo se conserva. El lector v1 histórico no autentica launcher/árbol y no es fallback para nuevos opt-ins. Stack exige paquete Pi y receipt browser verificados y lee `contract/browser-handoffs.v1.json` del paquete instalado antes de proyectar v2/v3; un Pi antiguo sin esa declaración bloquea la nueva proyección sin inferir soporte por número de versión. Para una instalación gestionada, la identidad del paquete Pi procede del receipt autenticado y se vuelve a comprobar contra el tarball verificado/cacheado.

## Paquete e integridad

En cada install/update deliberado, el resolver consume metadata del registro para obtener la versión exacta, URL canónica e integridad SRI del tarball; los bytes descargados se verifican antes del stage. El `provenance.commit` resuelto es informativo, no una attestation. Los valores del JSON pin/historial son referencias congeladas, no la fuente de la selección productiva dinámica.

La verificación del tarball precede a la activación. El stage aísla la instalación Pi-native, verifica seis dependencias directas con versiones e integridades y materializa copias package-local byte-identical para el loader de Pi; el lock conserva sus entradas verificadas y solo el inventario del árbol incluye esas copias, mientras que el `releaseId` se deriva del tarball más los digests del lock y del árbol. Smoke e inspección del lock/tree deben concluir antes de tocar la entrada activa. La activación respalda el estado, promueve el release privado y publica solo el entry propio; si falla, intenta restaurar el estado previo. La entrada de paquete y el receipt deben coincidir con el candidato activado; receipt schema 1 añade `managedPackage` con link/release y evidencia de dependencias, lock y árbol para verificación offline. Las rutas del stage/downloads no son selectores de versiones.

El paquete adoptado mantiene su comportamiento oficial de provider; Stack no añade filtros de herramientas ni una allowlist Engram.

El gestor de paquetes interno de Pi es la única excepción npm del lifecycle: Stack usa pnpm para desarrollo, dependencias y herramientas globales, y nunca lanza npm directamente. El cierre privado de Pi se publica únicamente desde el stage verificado; no se reutiliza el árbol npm compartido ni se pisa el estado de paquetes ajenos. El paquete registra un receipt separado en `~/.jorgex-stack/pi-receipt.json` únicamente después de que su runner confirme una instalación sana. Ese receipt es el hand-off del binario Engram verificado; no transfiere su propiedad a Pi ni a Stack.

## Inventario operativo de Pi

Esta tabla separa lo que Stack gestiona de lo que Pi o el usuario ya deben proporcionar. Las versiones de los candidatos se resuelven desde `dist-tags.latest` en cada `install`/`update` deliberado; no hay números de versión futuros fijados en la documentación.

| Elemento | Estado | Qué hace Stack | Qué no hace |
| --- | --- | --- | --- |
| Host Pi (`pi` o launcher gestionado) | Prerrequisito | Detecta el ejecutable y lo usa para staging, smoke y RPC | No sustituye la instalación del host ni ejecuta su actualización nativa |
| `jorgex-pi` | Obligatorio y gestionado | Resuelve el último release estable publicado, verifica tarball/SRI, stage, smoke y receipt privado | No instala el alias flotante `latest` ni adopta un paquete manual sin receipt |
| Seis companions del paquete Pi | Obligatorios dentro del release | Verifica sus versiones e integridades observadas y conserva copias package-local byte-identical para el loader | No los resuelve como seis actualizaciones independientes |
| `gentle-engram` y `pi-mcp-adapter` | Providers oficiales: `gentle-engram` siempre; `pi-mcp-adapter` solo cuando el candidato instalado no declara transporte nativo | En `install`/`update`, con candidato nativo resuelve solo `gentle-engram` en un stage aislado fuera del agente activo, verifica lock/SRI/árbol y promociona únicamente ese directorio con backup; sin nativo, resuelve también `pi-mcp-adapter` y promociona los dos con la misma verificación. En sucesivas vueltas autentica de nuevo raíces, metadata, binarios y fuentes bajo el lock común | No actualiza el árbol npm activo con el updater nativo de Pi ni poda el enlace/receipt privado de `jorgex-pi` |
| Binario Engram | Obligatorio para el setup, propiedad del usuario | Conserva uno válido; si falta, `install` puede resolver el release estable oficial con autorización explícita | No reemplaza implícitamente un binario existente |
| Base de datos y memorias Engram | Datos del usuario | Ninguna mutación | Nunca los actualiza, migra ni elimina |
| Configuración MCP Pi (`mcp.json`/`mcp-adapter.json`) | Configuración del provider | Transporte nativo: `mcp.json` es la autoridad persistente de `engram`, `context7` y `chrome-devtools`; la firma y la inspección vienen del productor Pi verificado y la autoridad granular vive en `pi-projection-receipt.json`. Transporte legacy: lee la ruta declarada por la metadata del adapter instalado y migra solo la raíz oficial con backup | No trata una entrada ajena, ambigua o ilegible como conexión sana; no descubre servidores desde una ruta del adapter ni invoca `!` raw para probar disponibilidad |
| Proyección Stack (prompt, skills y recibos) | Gestionada por Stack | Proyecta y reconcilia sus secciones con ownership y backup | No inyecta el protocolo ni filtra las herramientas del provider Engram |
| Context7 | Integrado por defecto; credenciales opcionales | Mantiene el bridge de bootstrap y la guía si el candidato lo declara | No escribe credenciales ni convierte `available` en un handshake confirmado |
| Playwright CLI / Chrome DevTools MCP | Opcionales y opt-in por runtime | Solo para una preferencia Pi explícita, resuelve y verifica sus árboles/hand-offs durante un `install`/`update` deliberado; DevTools puede seleccionar un Chromium ya instalado en una ruta conocida y compatible | No instala navegadores ni activa browser tooling por defecto; el Chromium del sistema no pasa a ser propiedad de Stack |

Los seis companions son `@gotgenes/pi-permission-system` (permisos), `@juicesharp/rpiv-ask-user-question` (preguntas), `@narumitw/pi-goal` (objetivos), `pi-subagents` (subagentes), `pi-web-access` (acceso web) y `strip-json-comments` (lectura JSONC). Se cargan como extensiones o dependencias del paquete; no se instalan como seis CLI globales. Que el paquete de acceso web esté presente no configura automáticamente cuentas externas.

La integración también incluye la marca/tema JorgeX, el prompt `lean-audit` y las 17 skills compartidas de la snapshot. `pi-engram` y `pi-mcp-adapter` son los entrypoints CLI de sus respectivos providers, no sustituyen el binario `engram`. Playwright se invoca mediante el dispatcher verificado `jorgex-stack-playwright`; Chrome DevTools es un servidor MCP. En Pi, durante un `install`/`update` deliberado con DevTools opt-in, Stack busca únicamente un Chromium instalado en rutas conocidas del sistema, comprueba que sea un ejecutable regular no simbólico y pasa su ruta física mediante el selector autenticado; no lo instala, no lo versiona ni lo convierte en un artefacto propiedad de Stack. Si no encuentra uno compatible, conserva el navegador predeterminado del provider y no descarga otro. Las herramientas MCP se descubren bajo demanda y su lista depende del servidor conectado.

La instalación o actualización gestionada de un Pi existente con receipt válido continúa por la ruta autenticada de `update`; una instalación manual, un receipt ilegible o un estado ambiguo se bloquea. La activación correcta de providers elimina el stage, tarballs y backups temporales; si falla la finalización MCP después de promoverlos, el resultado informa **providers activos, MCP pendiente** y conserva el stage diagnóstico y el backup para recuperación. No se presenta como rollback total; los restos se limpian solo tras completar o recuperar esa transacción.

La smoke aislada confirma la carga del runtime, el registro de extensiones y los comandos públicos del candidato (incluidos `goal`, `subagents`, `permission-system`, `websearch`, `jorgex:header`, `mcp-adapter` y `mcp` cuando corresponde). El endpoint de prueba pertenece al stage y devuelve `503` deliberadamente para evitar que la sonda inicie un daemon o use el servicio de memoria personal; esa prueba no es una certificación del servicio Engram. La certificación de una conexión MCP y las herramientas efectivamente visibles requieren el readback de la configuración oficial y una sesión real separada.

## Procedencia, attestation y paridad

Estos identificadores describen objetos distintos y no deben intercambiarse:

- El commit productor de la entrada congelada en `src/lib/pi-runtime-pin.json` es dato histórico; no identifica necesariamente la release observada por una instalación gestionada en vivo.
- La fuente Stack de la paridad queda evidenciada por `tests/fixtures/pi-runtime.ts` (`parity.source.commit`); no es el commit productor de Pi.
- El pin saliente `0.8.9` queda como referencia histórica de rollback, no como pin actual.
- La identificación histórica de `0.8.0` se conserva en la sección de inventario; no debe reutilizarse para el pin actual.
- El metadata de registry no aporta `gitHead`; no se debe inventar uno.

La procedencia documentada se limita al commit productor del JSON y al `parity.source.commit` de la fixture. La verificación local vincula el tarball al tamaño y a los SHA-256/SHA-512 del JSON; son comprobaciones del mismo checkout, no raíces de confianza independientes. La attestation de provenance de npm es externa al runtime de Stack: `provenance.commit` es informativo salvo que se verifique expresamente esa attestation fuera de Stack.

## Inventario y contrato 0.8.0 (histórico)

La snapshot validada declara:

| Campo | Valor |
| --- | --- |
| `testedVersions` | `[0.84.2]` |
| `schemaVersion` | `1` |
| Runner | `jorgex-pi`, comandos `status`, `doctor`, `models`, `sync` y `cleanup`, contrato `v1` |
| `maxStdoutBytes` | `65536` |
| Escrituras externas gestionadas | `settings.json`, `models.json`, `jorgex-pi/sol-lifecycle.v1.json` |
| Snapshot canónica | 15 agentes, 18 árboles de skill y 97 archivos de skill |
| Allowlist activa | 14 agentes runtime, 17 skills activas y el orchestrator primary durmiente |
| `parity.source.commit` | `11e7666ea4e40bde1de8bc434610747eb797ab9c` |
| Inventario del artefacto | `13403` entradas |

Las 14 capabilities del contrato son `foundation-contract-v1`, `stack-snapshot-v2`, `runtime-agents-v1`, `permission-gated-tools-v1`, `structured-questions-v1`, `web-access-v1`, `goal-continuation-v1`, `mcp-adapter-v1`, `engram-runtime-tools-v1`, `runner-json-v1`, `tui-branding-v1`, `managed-primary-model-v1`, `quality-receipt-contract-v1` y `quality-capabilities-contract-v1`.

Respecto al pin anterior `0.7.0`, se mantienen las 14 capabilities y el mismo runtime, la clausura de dependencias empaquetadas y las tres escrituras externas gestionadas. `0.8.0` añade `work-audit` a la snapshot, que pasa de **17 a 18 skills** y de 96 a 97 archivos, y a la allowlist activa, que pasa de **16 a 17 skills**; el inventario del artefacto pasa de `13402` a `13403` entradas. `playwright-cli` permanece en la snapshot, pero fuera de la allowlist activa por ser opt-in. El delta documenta la capacidad empaquetada y no crea una migración in-place.

## Configuración MCP efectiva y smoke

El archivo MCP que se verifica es el que declara el `pi-mcp-adapter` instalado: para adapter mayor `2` se lee `mcp.json`; para mayor `3` o superior, `mcp-adapter.json`. Si falta o es inválida la metadata del adapter, no se hace fallback silencioso a la ruta histórica. En la ruta moderna, una definición oficial Engram duplicada en `mcp.json` es conflicto: la migración oficial respalda ambas rutas, conserva configuración ajena y escribe solo la raíz oficial cuando puede demostrar que la configuración no cambió durante la operación. La configuración acepta JSONC acotado (comentarios y comas finales), pero el contrato canónico sigue exigiendo `mcpServers.engram` directo y exacto. Cuando el candidato Pi declara el contrato nativo (`mcp-native-v1`), la autoridad pasa a `mcp.json` persistente y la rama adapter queda fuera del flujo: ver [Transporte nativo y autoridad granular](#transporte-nativo-y-autoridad-granular).

El smoke se ejecuta contra el stage y vuelve a ejecutarse sobre la topología de enlace después de promover el release. Usa Pi en RPC sin sesión, aprobación ni contexto, con `--offline` y sin solicitar respuestas a un modelo; comprueba las capabilities públicas y falla ante cualquier `extension_error` o notificación de error salvo el mensaje exacto de Engram ausente en la sonda package-only. Esa excepción no certifica el MCP: la configuración oficial se verifica aparte antes de declarar el runtime saludable.

## Transporte nativo y autoridad granular

La rama nativa requiere que el candidato Pi verificado declare la capability `mcp-native-v1` en su contrato raíz y una binding `mcpNative` igual al canon Stack (versión de schema, ruta del contrato, servidores y entrypoints de definición y ownership). El consumidor Pi-published `0.8.40` publica y verifica ese contrato en npm; su `tarballSRI/sha256` se autenticó contra los bytes descargados. Esa identidad es release, no un nuevo selector estático para futuras instalaciones: cada `install`/`update` resuelve otra vez `dist-tags.latest` y repite la verificación.

La selección nativa no se infiere por `testedVersions`, por el número de capabilities raíz ni por el semver del host Pi. Procede exclusivamente del contrato staged verificado: el runtime Pi nativo activa el transporte sólo cuando el productor verificado declara la capability y la binding descritas. Sin la declaración la rama nativa se cierra; un Pi antiguo sin `contract/native-mcp.v1.json` válido no entra en nativo y conserva la rama legacy con su flujo de receipts.

El archivo `PI_CODING_AGENT_DIR/mcp.json` es la autoridad persistente de los tres servidores protegidos:

| Servidor | Forma canónica nativa |
| --- | --- |
| `engram` | `command` absoluto al binario Engram verificado, `args: `["mcp", "--tools=agent"]`` |
| `context7` | `url: "https://mcp.context7.com/mcp"`; conserva cualquier `headers` opaco preexistente y respeta `enabled`, `exposure` y `toolExposure` del usuario |
| `chrome-devtools` | Definición resuelta por `resolveNativeDevtoolsDefinition` del productor Pi verificado, contra el handoff `devtools.v1.json` materializado en un agent dir temporal; se publica en `mcp.json` con los flags exactos `--isolated --redact-network-headers --no-performance-crux --no-usage-statistics` |

El digest de cada definición (`definitionSha256`) lo calcula el productor Pi sobre sus propios entrypoints; Stack no reproduce su lógica ni duplica el cuerpo. El sello de cleanup (`cleanupSha256`) es independiente: SHA-256 de la entrada completa propia, sólo se estampa cuando Stack crea la entrada o cuando la entrada previa coincide exactamente con su sello.

La autoridad se publica en el receipt de proyección bajo la clave `mcpNative` con `schemaVersion: 1` y un objeto `entries` por servidor:

```json
{
  "mcpNative": {
    "schemaVersion": 1,
    "entries": {
      "engram": { "definitionSha256": "<digest del productor Pi>", "cleanupSha256": "<sello de cleanup>" },
      "context7": { "definitionSha256": "<digest del productor Pi>" },
      "chrome-devtools": { "definitionSha256": "<digest del productor Pi>", "cleanupSha256": "<sello de cleanup>" }
    }
  }
}
```

`mcpNative` no es propiedad del archivo `mcp.json`: la autoridad vive en `~/.jorgex-stack/pi-projection-receipt.json`. Stack no vuelve a calcularla al releer; sólo valida su forma estricta. Si está presente y mal formada, el bloque falla cerrado en lugar de inventar ausencia. Las preferencias de usuario dentro de cada entrada (`headers` opacos en Context7; `cwd`, `env`, `exposure`, `toolExposure`, `enabled` en Engram y DevTools) se conservan en cada promoción.

### Inspección y estados

`inspectNativeMcpOwnership` (sobre el módulo Pi realmente instalado en `npm/node_modules/jorgex-pi`) devuelve cuatro clases de información con nombres distintos:

- `ownership`: estado por servidor (`absent`, `unowned`, `conflict`, `managed`) y `cleanupEligible` por entrada.
- `config`: forma de cada entrada en `mcp.json`.
- `catalogue`: herramientas y servidores que el productor ve bajo su propio registro.
- `connection`: siempre `not-verified` en una inspección offline; una sesión Pi real con handshake abierto es la única fuente de "connected".

Los nombres no se mezclan: la rama activa (fresh/update) bloquea si el checker activo detecta `state === "conflict"` en algún servidor o en el paquete; antes del sync interno y antes de desactivar el paquete privado. Una entrada `unowned` que coincide byte a byte con la forma canónica nativa se respeta sin reclamarla (caso `engram` oficial directo); cualquier otro servidor protegido sin autoridad bloquea en lugar de fallar el runner interno después de la promoción.

### Etapas y provider

`install` y `update` deliberados con candidato nativo ejecutan `runNativePiMcpPhase`. El orden es siempre: validar el contrato staged → releer todos los snapshots (`mcp.json`, handoff, projection receipt, package receipt) → exigir el package receipt gestionado en update y su ausencia en fresh → autenticar la autoridad granular previa con scope exacto y reclamar el checker activo si el candidato es update → resolver la definición DevTools en un agent dir temporal con el handoff materializado, sin escribir el árbol activo → planificar las tres entradas protegidas y reclamar el digest por servidor → promover solo `gentle-engram` en su stage aislado (verificar lock/SRI/árbol antes y después, con `treeSha256` exacto) → commit del handoff DevTools (si difiere) y de `mcp.json` con snapshot rechecks, readback y rollback acotado a la propia escritura → construir y publicar la autoridad granular. La rama nativa nunca resuelve ni promociona `pi-mcp-adapter`: la presencia de un adapter registrado sin autoridad propia se preserva, pero no se reinserta como requerido.

### Cleanup y entradas personalizadas

`reconcileNativeAuthorityAfterCleanup` retira solo las entradas donde `cleanupEligible === true` y conserva las personalizadas liberando su sello (sin renovar `cleanupSha256`). Las preferencias del usuario dentro de la entrada no se modifican: el contrato sólo deja de reclamarla. `cleanupEligible` requiere que el sello de cleanup siga siendo válido; un sello ausente o divergente mantiene la entrada sin posibilidad de borrado automático.

### DevTools nativo y flags

El handoff Pi `devtools.v1.json` con `schemaVersion: 3` se materializa sólo cuando difiere de los bytes activos. Stack no duplica su cuerpo: lee los flags `--isolated --redact-network-headers --no-performance-crux --no-usage-statistics` desde la definición resuelta por el productor Pi verificado. Si el handoff activo difiere del materializado, el bloque falla cerrado y Pi no queda activado. DevTools sigue usando un Chromium del sistema en una ruta física compatible cuando existe; nunca instala Chrome de escritorio ni versiona un navegador propiedad de Stack.

### Snapshot, readback y autoridad

Cada escritura de `mcp.json` relee los bytes previos, compara, escribe, relee y restaura sólo mientras el archivo siga conteniendo la propia escritura de esta operación. La autoridad granular se publica al final, después del readback del commit: nunca se reclama autoridad sobre un commit que no se ha leído correctamente. El commit del handoff y el de `mcp.json` se aplican por separado con recheck entre ambos; un fallo en la autoridad granular revierte ambos sobre sus bytes previos. Un fallo de provider o de bootstrap revierte sólo los bytes que la propia operación escribió, no el cierre completo de la instalación.

### Target-dir nativo fresco

Un `--target-dir` nativo fresco usa las rutas canónicas `<target>/home/.jorgex-stack/pi-receipt.json` y `pi-projection-receipt.json`, recibe el stage de provider ya verificado inyectado (la red permanece apagada dentro del target) y copia el artefacto Pi verificado a `<target>/home/.jorgex-stack/packages/jorgex-pi-<version>.tgz` comparando SHA-256 antes y después. El target no descarga paquetes ni consulta el HOME real. Los layouts legacy `<target>/state`, `<target>/diag` y `<target>/cleanup` se conservan para diagnóstico y cleanup; un intento de relocalización de la autoridad existente sobre el sandbox fresco se rechaza en lugar de duplicar receipts o crear symlinks.

### SDK, permisos y modelo

Las traducciones que el SDK nativo del Pi publica ya en su contrato (incluidos los wildcards `Bash` que el Pi convierte en reglas equivalentes) no se reinterpretan en el canon Stack. Las plantillas canónicas de permisos Stack y los defaults de `openai-codex/gpt-5.6-sol` (con `contextWindow: 872000` solicitado) siguen siendo los mismos. Una release Pi nativa no introduce un selector adicional en las plantillas; la autoridad nativa se suma al modelo de ownership, no a las reglas por defecto.

La proyección se ejecuta después de la instalación del paquete y se registra en `~/.jorgex-stack/pi-projection-receipt.json`:

| Recurso | Destino | Propiedad |
| --- | --- | --- |
| System prompt | `~/.pi/agent/AGENTS.md` | Stack, en secciones marcadas `jorgex:system-prompt`, `jorgex:playwright` y `jorgex:chrome-devtools`; Engram lo configura el proveedor oficial y Stack no proyecta `jorgex:engram-protocol` |
| Skills compartidas | `~/.agents/skills` | Stack; se conservan si también las usa otro runtime |
| Prompt | `~/.pi/agent/prompts/lean-audit.md` | Stack |

El `AGENTS.md` estático proyectado por Stack no contiene Context7. Pi añade esa sección desde su bootstrap nativo después de registrar el bridge HTTP aislado; una entrada `available` permite el registro, pero no acredita un handshake HTTP.

La proyección usa las mismas copias canónicas de `stack/` que los demás runtimes. El contenido del usuario fuera de las secciones marcadas se conserva. Pi requiere `modular-system-prompts-v1` y `context7-http-v1`, y proyecta las secciones canónicas de system prompt de forma modular. Context7 se registra mediante un bridge HTTP aislado en memoria durante el bootstrap: `available` significa que la configuración permite el registro, pero no implica un handshake HTTP. Si existe un conflicto, Pi conserva los archivos MCP y bloquea la activación gestionada. No se escriben configuración MCP ni credenciales. Playwright y Chrome DevTools se proyectan en sus bloques propios cuando sus capacidades están habilitadas. El bloque legacy `jorgex:browser` se mantiene para migración y cleanup compatibles. Cuando la preferencia gestionada de Playwright está activa, añade o retira dinámicamente su sección en `AGENTS.md`. Stack mantiene el release Playwright en un árbol privado verificado; solo la caché Chromium es compartida por la máquina. El selector `--playwright-runtimes` controla la guía de los runtimes elegidos, incluido Pi cuando su candidato declara la capability existente. El contrato conserva `playwright-handoff-v1` para compatibilidad histórica; el handoff nuevo v2 incluye dispatcher Stack externo al release y digests de comando, launcher y árbol. En Windows Pi ejecuta el `.js` autenticado mediante Node sin shell. No se degrada a v1 si falla la validación v2. Las instalaciones repetidas reparan la entrada alias de Pi y conservan sus campos adicionales. Si ese fallo deja un estado parcial o divergente, repite `install`; `sync` no repara ese bloqueo. El paquete Pi adoptado permite activar Chrome DevTools MCP con `--devtools`; Stack proyecta el handoff DevTools v3 con launcher local verificado en `PI_CODING_AGENT_DIR/jorgex-pi/devtools.v1.json` y guarda su SHA-256 en el campo opcional `devtools.sha256` del receipt de proyección. `--no-devtools` lo retira tras revalidar integridad. El servidor se registra como proxy lazy (`directTools: false`), por lo que Pi no precarga el catálogo completo de herramientas. Un conflicto o archivo ajeno bloquea y conserva el estado. El cambio requiere recargar Pi para que el bootstrap cree la sesión con la nueva configuración.

En el rollout histórico de `work-audit`, Stack `1.9.2` adoptó Pi `0.8.0`; la versión publicada `1.9.3` conserva ese pin saliente. La publicación de Stack fue aceptada por npm y el readback confirmó metadata y tarball públicos; esas evidencias siguen separadas de la verificación local del artefacto Pi.

## Resolución dinámica y contrato

El contrato compatible permanece definido en `src/lib/pi-runtime.ts`; la release y sus capacidades se descubren desde el paquete staged en cada install/update deliberado. La resolución de una versión no equivale a aceptar semánticamente cualquier cambio: el stage compara el contrato publicado con el contrato Stack y bloquea divergencias incompatibles. La CI `pi-artifact.yml` resuelve el `latest` observado y verifica SRI, pero no implica que el runtime use una versión personal ya migrada.

La lista `testedVersions` en el contrato representa compatibilidad probada del host Pi; no fija la versión publicada de `jorgex-pi`, y no selecciona el modo nativo: ese modo lo activa exclusivamente el productor Pi verificado cuando su contrato raíz declara `mcp-native-v1` con la binding `mcpNative` canónica (ver [Transporte nativo y autoridad granular](#transporte-nativo-y-autoridad-granular)). Pi `0.87.1` con el artefacto publicado `jorgex-pi@0.8.31` pasó el smoke Pi healthy; Pi `0.8.40` publica el contrato nativo `mcp-native-v1` cuyo tarball y SRI se verificaron en este PR (no es un nuevo selector estático). Las actualizaciones gestionadas cruzando versiones han sido verificadas también con código de prueba sintético; no se afirma que una instalación personal se haya actualizado en vivo. El agente conductual `engram` permanece en el contrato; su setup y herramientas son provider-owned.

### Diagnóstico de inicialización pendiente

Durante la instalación del paquete, antes de la proyección y del `sync` final, `initialization-diagnostics-v1` permite aceptar provisionalmente solo el envelope exacto de `doctor` que devuelve `INITIALIZATION_REQUIRED`: salida JSON de una sola línea, `schemaVersion: 1`, `command: "doctor"`, `ok: false`, con el nombre, versión y raíz del paquete iguales al candidato verificado y su runner, cinco checks ordenados (`package`, `engram`, `context7` en `ok`; `permissions` y `experience` en `ok` o `error`, con al menos uno en `error`), y `error.phase: "initialization"`, `error.code: "INITIALIZATION_REQUIRED"`, `error.message: "Pi initialization is pending: run sync to complete first initialization."` y `error.remedy: "Run jorgex-pi sync --json and retry."`. Ese estado es **pending**, no healthy. La proyección debe completarse y `sync` debe finalizar la inicialización; cualquier otro resultado unhealthy, malformed o divergente bloquea la instalación.

## Adopción y automatización

La automatización Stack ↔ Pi es snapshot-only: no resuelve ni adopta releases Pi en Stack. No hay que ejecutar un preparador local de adopción ni rotar hashes manualmente como operación rutinaria. Un cambio semántico del contrato requiere revisión específica y actualización deliberada del contrato canónico; un artefacto incompatible bloquea la instalación gestionada antes de activación. El [runbook Stack ↔ Pi](stack-pi-automation.md) cubre la coordinación de snapshots, no adopción de paquetes.

## Histórico: candidato Stack 1.9.6 / Pi 0.8.4

El release publicado histórico fijaba `npm:jorgex-pi@0.8.4`. La fuente ejecutable fijaba `89133070` bytes, SHA-256 `e30cbc0595bfbaa35b37f97096b77d46749315e3cf6ab13f830fe84432798b10` y SHA-512 `39255e7ccf7aad2cbe1069e2dbeb3335dc59f28ad1f0f32b677889e39e167e5fd39b546da9f448c33fad4581f0b4a8f1dda95a2f1b1bce010cc031b188ffc292`. Su `provenance.commit` era `2b5cf37d9bfdb0c574e66712000ecc432eca8a69`; el `parity.source.commit` comprobado en el artefacto era `5e89b970e72cfac0003b11e054c861bed6d44884`. Esta transición histórica quedó superseded por la adopción publicada de Stack `1.9.7` / Pi `0.8.4`.

Stack `1.9.5`, `1.9.6` y `1.9.7` son referencias históricas. La disponibilidad inmediata tras publicación y adopción verificadas no cambia la validación, el merge, el pin exacto ni la compatibilidad exigidos.

## Lifecycle y seguridad

La coordinación opcional entre Stack y Pi está descrita en el [runbook de automatización Stack ↔ Pi](stack-pi-automation.md). Esta automatización no forma parte del lifecycle local de Pi y permanece desactivada por defecto.

- `install` verifica primero el tarball y prepara el stage aislado. Para un candidato con transporte nativo, ejecuta `runNativePiMcpPhase` antes de la promoción del paquete y de la proyección; con candidato legacy, ejecuta `engram setup pi` con backup y rollback de `settings.json`, `mcp.json`, `mcp-adapter.json` y el árbol `npm`. El candidato verificado debe declarar el lector MCP que va a usar antes de migrar la configuración. Después hace backup de `settings.json` y ejecuta `package install → projection install → package sync`. La última operación ejecuta la inicialización nativa de Pi después de que Stack haya proyectado sus recursos compartidos; si la proyección se bloquea, no se intenta inicializar el paquete. El checker nativo activo (`beforeInitialization`/`beforePackageDeactivation`) corre contra el módulo Pi realmente instalado y bloquea antes del sync interno y antes de desactivar el paquete privado.
- `sync` reaplica la proyección del paquete autenticado y comprueba la configuración MCP existente sin resolver versiones ni descargar providers; dos pasadas consecutivas son idempotentes. Si hay un paquete activo obsoleto, usa `update --agents pi`, no `sync`. Cuando el paquete instalado es nativo, `sync` valida la autoridad granular sin reclamar entradas ajenas y conserva `mcp.json` y la autoridad tal como están.
- `doctor` comprueba package receipt, projection receipt, entradas exactas, rutas y drift, pero no repara. El diagnóstico de Stack puede marcar el runner como no saludable de forma genérica; para el estado detallado de Context7 (`available`, `conflict` o `invalid`) consulta el `doctor` nativo de Pi. `available` no implica un handshake HTTP. En modo nativo la autoridad `mcpNative` del receipt de proyección se verifica por su forma; una autoridad presente pero mal formada bloquea la operación en lugar de inventar ausencia.
- `uninstall` hace backup antes de retirar, elimina únicamente lo declarado por los receipts y conserva archivos compartidos que sigan siendo propiedad de otro runtime. En modo nativo corre la comprobación activa de ownership antes de desactivar el paquete privado, retira sólo las entradas con sello de cleanup completo y libera el sello de las personalizadas conservadas.
- Si un receipt es ilegible, de otro scope, parcial o de historial desconocido, la operación destructiva falla cerrada; no se adopta ni se elimina estado manual silenciosamente.
- El binario, la base de datos y las memorias de Engram son siempre del usuario. El setup oficial puede ejecutarse una vez durante un `install` real con confirmación para descargar un binario ausente; `sync`, dry-run y `--target-dir` no ejecutan `engram setup pi` ni descargas globales. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario.

Pi no escribe, posee ni elimina archivos MCP. En Claude Code, Codex y OpenCode, una configuración Context7 previa compatible se conserva, incluso si procede de una instalación antigua o de un `--target-dir`; esos runtimes solo pueden retirarla cuando un ownership explícito y canónico de Stack lo autoriza.

Las operaciones con `--target-dir` aíslan home, `PI_CODING_AGENT_DIR`, estado, backups y receipt dentro del target, sin consultar la configuración real de Pi o Engram. No descargan el paquete; si el caller aporta un candidato/stage ya verificado, pueden ejecutar smoke y runner aislados dentro del target.

## Receipt exacto y rollback

Los receipts históricos schema 1 sin `managedPackage` requieren la ruta explícita de migración autenticada o uninstall legacy offline. Una vez gestionado, `sync`, `models`, `doctor` y `uninstall` verifican el receipt y los bytes/cache del release sin resolver una versión nueva. Nunca edites receipts ni hashes ni borres `HOME`, Engram o la proyección de otro runtime para forzar confianza.

La migración de un receipt histórico se realiza mediante `install --agents pi` deliberado: el lifecycle autentica el receipt legacy y el estado propio, respalda lo necesario y solo continúa con el candidato staged verificado. Si no puede autenticar el estado, falla cerrado y no modifica estado ajeno.

La restauración automática cubre fallos durante la activación/verificación del release nuevo. Si el paquete ya quedó activado y verificado y después falla la proyección o la configuración MCP/sync final, la operación queda bloqueada con el backup retenido para recuperación manual; no se declara rollback completo ni se garantiza restauración automática en todo fallo posterior. El release anterior se identifica mediante el receipt verificado, nunca editándolo.

Las parejas históricas siguientes describen releases pasadas, no comandos recomendados para una instalación actual. No se editan receipts ni se borra estado manualmente:

```bash
# Receipt Pi 0.7.0 → 0.8.0
pnpm dlx jorgex-stack@1.9.0 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.2 install --agents pi

# Rollback desde receipt Pi 0.8.0 → 0.7.0
pnpm dlx jorgex-stack@1.9.2 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.0 install --agents pi

# Transición histórica Stack 1.9.6 / Pi 0.8.4
pnpm dlx jorgex-stack@1.9.5 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.6 install --agents pi

# Rollback histórico Pi 0.8.4 → 0.8.3, usando primero la versión que reconoce cada receipt
pnpm dlx jorgex-stack@1.9.6 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.5 install --agents pi
```

La resolución dinámica no equivale a una migración automática durante `sync`: solo un `install`/`update` deliberado adquiere y activa una release nueva. La adopción de una release Pi requiere que esté publicada y que su declaración de lector MCP, tarball e integridad pasen la verificación del stage; no se inventa ni se fija una versión futura en Stack. El updater nativo de Pi (`pi update --extensions`) y las actualizaciones de paquetes gestionadas por el provider no son un sustituto seguro del lifecycle privado verificado de Stack, porque no aportan su receipt ni sus garantías de activación y recuperación. Los receipts antiguos siguen necesitando migración autenticada.

## Variante temporal del provider y recibo separado (candidato, devtool)

> **Estado actual**: candidato / devtool, todavía no publicado en npm. La fase nativa del padre (PR203) ya viene importada como base de este candidato; este contrato **extiende** esa fase nativa con el hook de provenance/compat bajo la misma política de input/receipt de la flag candidata verificada y no duplica authority, config ni cardinality. El caller nativo del padre ejecuta su fase propia (`runNativePiMcpPhase` y receipts análogos del padre) —no se reutiliza aquí como updater ni se sustituye. Las garantías de Windows, del set de providers nativo, del MCP nativo, de la autorización personal y de la publicación/adopción del release oficial corregido **no están verificadas** por este candidato; este texto no las declara. La variante descrita es un artefacto local derivado —no es un fork ni un release npm— que aplica exclusivamente el diff de la corrección upstream `#1567` sobre bytes oficiales verificados, registra su procedencia en un recibo separado (con `provenance.origin` igual a `derived` mientras el oficial siga afectado por `#1567`, o a `registry` cuando el oficial ya venga corregido) y se retira cuando el release oficial corregido se active como `registry` sin etapa derivada.

### Contexto y límites

La corrección upstream `#1567` (retirar la dependencia propia `typebox` y declarar `peerDependencies.typebox` como opcional en el manifest del provider) está fusionada en el repositorio oficial de `gentle-engram` pero todavía no publicada en npm. Mientras el release oficial no la incorpore, los providers gestionados disparan el warning legítimo del host Pi y bloquean el smoke estricto. Esperar la corrección bloquea los PRs relacionados; parchear el árbol instalado sin registrar su procedencia lo confundiría con un artefacto oficial.

Stack puede, sólo bajo opt-in explícito, instalar y registrar una variante local derivada de los bytes oficiales verificados. La variante:

- Conserva **nombre y versión** del provider (sin cambios respecto al upstream).
- Tiene su **propio SRI/digest** y un lock ligado a los bytes efectivamente instalados; no reutiliza la metadata de registry del upstream como SRI derivada.
- Preserva la evidencia del origen: payload original del manifiesto en `manifestBase64` (texto base64 que decodifica al manifiesto bounded; el límite aplica al payload decodificado, no al string literal), digest del payload, identidad del patch y recipe acotado verificable offline.
- Mantiene `provenance.origin = "derived"` mientras el release oficial siga afectado por el diff `#1567`; cuando el oficial ya viene corregido, el builder devuelve `provenance.origin = "registry"` y conserva la misma evidencia acotada para que la verificación offline siga siendo reproducible.
- Se **retira** únicamente cuando el release oficial corregido pasa el stage verificado y se activa como `registry`; el builder deja de declarar derivación sólo tras éxito, y el fallo conserva el recibo/árbol derived anterior. No hay fallback a un pin antiguo.

Esta sección describe el contrato, no una adopción personal: el lector debe entender que, hasta que la publicación del PR204 y los gates pendientes no se cierren, `--engram-typebox-compat` es un flag candidato y el recibo de provider no está disponible en `latest`.

### `--engram-typebox-compat`

`--engram-typebox-compat` es un **booleano explícito** con admisión limitada. Cuando el flag no se pasa en la línea de comandos, la propiedad queda **realmente ausente** (`undefined`), no se añade ningún campo obligatorio a flags/fixtures existentes y no se conserva ninguna preferencia en estado del usuario.

- Se acepta únicamente en `install` y `update` deliberados cuyo `--agents` incluya `pi` y **sin** combinar con `--dry-run` ni `--target-dir`.
- `update --check` rechaza el flag antes de cualquier efecto, al igual que `--dry-run` o `--target-dir` en `install` o `update`. `--dry-run` y `--target-dir` siguen sin adquirir providers ni escribir estado personal.
- `sync`, `models`, `doctor`, `uninstall` e `install` sin `pi` también rechazan el flag antes de cualquier efecto.
- Cualquier valor no booleano en el campo propagado falla antes de iniciar el stage (CLI, install, managed runtime y updater del provider).

El flag no es global: aplica al comando actual, al agent Pi presente y a un release verificado. Su activación no muta el árbol de un Pi ya sano; sólo participa cuando la receta derivada es coherente con el opt-in del caller.

### Recibo separado de providers

Stack registra la procedencia de los providers `gentle-engram` y `pi-mcp-adapter` en `<home>/.jorgex-stack/pi-provider-receipt.json` (schemaVersion 1). Este archivo es **distinto** del `pi-receipt.json` (recibo del paquete JorgeX Pi) y no altera la autoridad MCP ni la cardinalidad del set nativo.

| Campo raíz | Significado |
| --- | --- |
| `schemaVersion` | `1` (único valor actual) |
| `agentDir` | ruta absoluta normalizada del agent Pi activo; debe coincidir con la activación |
| `mcpTransport` | `native` o `legacy`, derivado del contrato del Pi instalado; no se infiere por longitud |
| `providers[]` | set exacto nativo/legacy según `mcpTransport` |

Cada entrada de `providers[]` declara `name`, `version`, `source` canónico `npm:<name>@<version>`, `packageRoot` (`npm/node_modules/<name>`), `integrity` sha512 del registry, `treeSha256` del árbol activo, `bins`, `manifestSha256` y un `provenance` **opcional** ligado a la adquisición `#1567`-compat. `provenance` se emite cuando el caller pasa el opt-in: con un release oficial ya corregido el builder devuelve `provenance.origin = "registry"` y conserva la receta original; mientras el oficial sigue afectado por `#1567`, el builder devuelve `provenance.origin = "derived"`. En ambos casos el `path` de stage se descarta antes de serializar, y el payload original del manifiesto se conserva como `manifestBase64` (texto base64 que decodifica al manifiesto bounded; el límite aplica al **payload decodificado**, no al recuento literal del string base64 —por eso un `manifestBase64` de 64 KiB de bytes puede verse como más caracteres en el archivo). El digest y la referencia del patch acompañan al payload para que la verificación offline pueda reaplicar la misma función de patch sobre el payload conservado. Esto es **procedencia local reproducible**, no attestation independiente de npm ni del publisher. El orden de campos es determinista para preservar idempotencia; el recibo no incluye timestamps, rutas de stage ni datos de auth.

La ausencia del recibo (`kind: "absent"`) preserva las instalaciones previas a este contrato; no las reclama ni les atribuye procedencia. El opt-in no convierte un árbol preexistente en derivado por mera igualdad de bytes: la promoción a `derived` ocurre sólo si el caller pasa el snapshot nulo y la activación pasa la verificación offline.

### Verificación read-only y diagnóstico

`verifyPiProviderReceipt` ata cada entrada al estado activo: `source` en `settings.json`, identidad, versión, bins, manifest y `treeSha256` del árbol activo. Un recibo malformado, symlinked o con bindings inválidos **lanza excepción**; nunca se devuelve como setup sano. Si ya existe un recibo gestionado y se omite el snapshot, la activación falla antes de escribir; la omisión no se reporta como saludable y no se deja el recibo obsoleto.

`doctor` consume este helper y reporta dos modalidades a partir del campo `provenance` del recibo:

- `registry`: artefacto oficial sin derivación; puede conservar `provenance.origin = "registry"` si pasó la comprobación de compatibilidad, o no llevar `provenance` en la adquisición ordinaria.
- `derived`: la adquisición del provider tiene `provenance.origin = "derived"` (el release oficial seguía afectado por `#1567` en el momento de la activación); la receta original acotada se conserva de la misma forma.

`doctor` no consulta la red, no repara, no escribe estado del usuario y nunca presenta un error como setup sano. La instalación de un derivado sin receta válida, un recibo inconsistente o unos bytes activos que no se atan al snapshot se reportan como error, no como aviso; las instalaciones sin este contrato se mantienen sin él. La autoridad MCP nativo, el set nativo y la cardinalidad de la cohorte pública pertenecen a PR203; este contrato no los duplica ni los anticipa.

### Lifecycle de la variante

- **Transacción única.** La activación cubre `settings.json`, las raíces y el recibo en una sola transacción con backup, readback y rollback idempotente. El no-op exige también un recibo válido e idéntico al snapshot aprobado; sin recibo previo, el opt-in obliga a una promoción verificable aunque el árbol coincida.
- **Detección de modificaciones ajenas.** La divergencia previa bloquea la operación. Si impide restaurar durante un rollback, se reporta `recovery incomplete` y se conserva el backup; nunca se sobrescriben los cambios del usuario. El rollback sólo restaura el recibo/raíces/settings cuando siguen siendo los escritos por esta operación.
- **Retirada y `update` deliberado sobre derivado existente.** Ocurre únicamente cuando el release oficial corregido pasa el stage verificado y se activa como `registry`; el builder deja de declarar derivación sólo tras éxito, y el fallo conserva el recibo/árbol derived anterior. Mientras la receta derivada esté activa, una `update` deliberada **conserva la receta sin volver a requerir el flag**, siempre que el recibo existente haya pasado la verificación previa (`providerReceiptSnapshot` válido). No hay fallback a un pin antiguo, no se autosiembran preferencias y ningún otro comando propaga el opt-in; no se reemplaza silenciosamente la receta derivada por bytes no verificados.
- **Updaters ajenos y comandos fuera de la transacción.** Comandos manuales, removedores externos o el updater nativo de Pi (modo manual) pueden sustituir, podar o degradar los bytes del provider fuera de la transacción gestionada de Stack; el verificador detecta ese drift entre settings/raíz/recibo/`treeSha256` y lo reporta, pero **no es una ACL** que impida esos comandos. El updater de providers de **Stack** (función) opera exclusivamente sobre el **transporte legacy**; el transporte nativo lo maneja la **fase nativa del padre** (PR203, `runNativePiMcpPhase`) con la misma política de opt-in (`--engram-typebox-compat`) y de snapshot (`providerReceiptSnapshot`), y la autoridad nativa permanece en el recibo de autoridad del padre —**ortogonal** al `pi-provider-receipt.json` de Stack. Esta rama no está entera en legacy por falta de integración nativa: la función updater cubre su transporte y la fase nativa cubre el suyo. El opt-in no afirma una instalación nativa fresca operativa en Windows ni en cohorte público, ni publicación npm, ni aplicación personal por este candidato.

Este contrato de recibo/transacción aplica al agent Pi y a los providers asociados; no modifica los contratos de proyección compartida, settings primarios ni MCP authority descritos en otras secciones.

## Engram

Engram es obligatorio para el paquete gestionado, pero queda fuera de ownership. Si ya existe un binario válido, siempre se conserva. Cuando falta y hay autorización, `install` consulta en tiempo de ejecución el último release estable oficial de GitHub (`releases/latest`, sin prerelease ni draft y nunca una branch) antes de configurar cualquier runtime. Comprueba la metadata viva del asset exacto para plataforma y arquitectura —nombre esperado, estado publicado, tamaño y SHA-256— y falla cerrado si no hay red o falta cualquier dato; no existe fallback estático u offline. Escribe bajo `~/.local/bin/engram` (o el equivalente de la plataforma) y no requiere Brew ni Go. En una ejecución interactiva se pide confirmación; `--engram` autoriza la descarga en flujos no interactivos. `sync`, dry-run y `--target-dir` no descargan Engram. Update sigue siendo explícito y no reemplaza implícitamente un binario existente. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario. La ruta verificada se conserva en el package receipt como hand-off para el runtime.

El plugin oficial de Claude sigue requiriendo Engram estable 2.0.0 o superior. Un binario existente por debajo de ese mínimo haría que Claude escribiera el archivo obsoleto `mcp/engram.json`; por eso el preflight de Claude lo bloquea antes del setup. Stack nunca reemplaza automáticamente un binario existente: hay que actualizarlo explícitamente y repetir `install`. El plugin oficial de Claude aporta hooks y skill; `engram setup claude-code` registra aparte el MCP del usuario y no implica un MCP incluido en Stack ni un smoke autenticado de modelo-herramienta.

## Comandos

Stack reconoce la versión del host Pi sin ejecutarlo: admite tanto el binario de un paquete npm directo como el launcher POSIX observado del instalador gestionado de Pi (`install/managed-install.json` con layout `releases-v1`). Para este último comprueba la versión actual contra el manifest de `@earendil-works/pi-coding-agent` dentro del release; si la metadata no coincide, bloquea la operación en lugar de adivinar la versión o usar el `.bin` interno como atajo. No se afirma compatibilidad con un layout gestionado de Windows no verificado. En un PC nuevo, ejecuta primero `install --agents pi`; `sync --agents pi` solo reconcilia una instalación Stack que ya tiene receipt gestionado y no crea ese receipt desde cero.

| Comando Stack | Comportamiento Pi |
| --- | --- |
| `install --agents pi` | En un Pi nuevo verifica el tarball, instala y normaliza el paquete, proyecta recursos, ejecuta `sync` para inicializar Pi y escribe ambos receipts; sobre un receipt gestionado válido continúa por la actualización autenticada. |
| `sync --agents pi` | Reconcilia receipt, proyección y configuración MCP ya gestionada; no resuelve versiones, no descarga providers ni duplica skills/prompts. |
| `update --agents pi` | Resuelve y verifica `jorgex-pi`, `gentle-engram` y `pi-mcp-adapter` en stages aislados; sobre un receipt gestionado válido actualiza el release y los dos providers sin tocar el host Pi, Engram ni datos ajenos. |
| `models --agents pi` | Devuelve la información primaria gestionada del paquete Pi; no escribe model map de Stack. |
| `doctor --agents pi` | Comprueba package/projection receipts, scope, entradas y drift. |
| `update --check --agents pi` | Ejecuta mediante el runner una comprobación de solo lectura del paquete y del registro; no compara la proyección compartida, no ejecuta el smoke del navegador y no entra en el updater global. Usa `doctor --agents pi` para el diagnóstico completo de paquete y proyección. |
| `uninstall --agents pi` | Hace backup, limpia solo ownership verificable y conserva Engram y estado ajeno. |

`--dry-run` no ejecuta Pi ni escribe receipts.

## Modelo principal

Pi gestiona su propia proyección primaria: `openai-codex/gpt-5.6-sol` y `contextWindow: 872000` para ese modelo. Pi registra ownership por campo y elimina únicamente valores canónicos que aún posea. Estos contratos se conservan en `src/lib/pi-runtime.ts`; 872K es metadata local solicitada, no una garantía del límite de contexto aceptado por el backend OAuth.

## Troubleshooting

| Resultado | Remedio |
| --- | --- |
| `tarball-integrity` | No omitas la verificación; reintenta desde un registro/red de confianza. |
| `unsupported-pi-version` / contrato incompatible | La release staged no satisface el contrato actual. No relajes la validación ni edites hashes; conserva el stage para diagnóstico y reintenta cuando el paquete publicado sea compatible. |
| `engram-required` / `engram-missing-target` | Configura Engram explícitamente; en target añade el binario dentro de `<target>/bin/engram`. |
| `manual-existing` | El paquete existe sin package receipt; consérvalo o retíralo explícitamente antes de pedir ownership gestionado. |
| `duplicate-package` / `source-divergent` | Conserva una única entrada exacta con `skills: []` y `prompts: []`, y vuelve a ejecutar `sync`. |
| `receipt-corrupt` / `receipt-untrusted` / `partial-state` | No borres el receipt a ciegas; inspecciona settings, proyección y scope, y usa el Stack publicado que reconoce ese pin para el rollback o la limpieza. |
| `projection-cleanup-failed` | Corrige el estado o restaura el backup y reintenta `uninstall`; no fuerces la eliminación. |
| `runner-output` / `runner-unhealthy` | Comprueba integridad, Engram y receipts antes de reinstalar. |

### Instalaciones afectadas de Stack 1.9.44

En una instalación gestionada con Stack `1.9.44`, `install` omitió invocar la sincronización de inicialización de Pi después de proyectar los recursos; por eso `doctor` podía seguir indicando un estado saludable aunque Pi no hubiera completado esa inicialización. Ejecuta la recuperación con esa versión exacta:

```bash
pnpm dlx jorgex-stack@1.9.44 sync --agents pi
pnpm dlx jorgex-stack@1.9.44 doctor --agents pi
```

Después de que `doctor` confirme el estado esperado, abre una sesión nueva de Pi para que use la inicialización completada. Esta recuperación documenta el arreglo del lifecycle gestionado de Stack; no es una solución ni una descripción del issue Pi #56.

La resolución/stage vive en `src/lib/pi-install-preflight.ts` y módulos asociados; el lifecycle y los contratos en `src/lib/pi-runtime.ts`/`src/lib/pi-package-lifecycle.ts`. Pin e historial son referencias congeladas. La evidencia de la proyección está en `src/lib/pi-projection-lifecycle.ts`, `src/adapters/pi.ts` y los componentes compartidos que proyecta.
