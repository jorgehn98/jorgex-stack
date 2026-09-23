# Pi runtime

JorgeX Stack integra Pi mediante dos capas coordinadas: el paquete Pi-native exacto y una proyección de recursos compartidos propiedad de Stack. Pi no se traduce a través del manifest de componentes ni del model map de Stack. El proveedor oficial de Engram conserva la propiedad de su setup, MCP, herramientas y captura; Stack no inyecta un protocolo Engram ni filtra sus herramientas.

Las instalaciones/actualizaciones gestionadas deliberadas no usan un pin estático como selector. `src/lib/pi-runtime.ts` coordina el lifecycle; `src/lib/pi-install-preflight.ts` resuelve en vivo el `dist-tags.latest` estable publicado, valida URL/SRI, descarga bytes verificados, prepara un stage aislado y construye el candidato desde el paquete staged contra el contrato Stack. `src/lib/pi-runtime-pin.json` y `src/lib/pi-runtime-history.json` conservan identidades congeladas, incluidas referencias históricas para receipts y recuperación; no describen una instalación personal actual. El workflow `pi-artifact.yml` también resuelve la versión observada y verifica SRI. La publicación de Stack usa el auto-bump existente al mergear y selecciona el patch disponible.

El canon de Stack y el paquete Pi adoptado mantienen una snapshot de 17 árboles de skills con 89 archivos de skill. El contrato vigente añade `initialization-diagnostics-v1` sobre `experience-defaults-v1`: en la primera inicialización siembra solo los campos ausentes `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true`, y conserva cambios o borrados del usuario sin resembrarlos. `hideThinkingBlock` solo cambia la presentación; `defaultThinkingLevel` y el razonamiento no cambian. Pi solo posee los campos de settings que crea y registra en su receipt; los valores preexistentes del usuario quedan sin ownership. El handoff Playwright ya está implementado y probado en `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json`; para una instalación gestionada, la identidad del paquete se obtiene del receipt autenticado y la integridad se vuelve a comprobar contra el tarball verificado/cacheado.

## Paquete e integridad

En cada install/update deliberado, el resolver consume metadata del registro para obtener la versión exacta, URL canónica e integridad SRI del tarball; los bytes descargados se verifican antes del stage. El `provenance.commit` resuelto es informativo, no una attestation. Los valores del JSON pin/historial son referencias congeladas, no la fuente de la selección productiva dinámica.

La verificación del tarball precede a la activación. El stage aísla la instalación Pi-native y fija seis dependencias con versiones e integridades; smoke e inspección del lock/tree deben concluir antes de tocar la entrada activa. La activación respalda el estado, promueve el release privado y publica solo el entry propio; si falla, intenta restaurar el estado previo. La entrada de paquete y el receipt deben coincidir con el candidato activado; receipt schema 1 añade `managedPackage` con link/release y evidencia de dependencias, lock y árbol para verificación offline. Las rutas del stage/downloads no son selectores de versiones.

El paquete adoptado mantiene su comportamiento oficial de provider; Stack no añade filtros de herramientas ni una allowlist Engram.

El gestor de paquetes interno de Pi es la única excepción npm del lifecycle: Stack usa pnpm para desarrollo, dependencias y herramientas globales, y nunca lanza npm directamente. El paquete registra un receipt separado en `~/.jorgex-stack/pi-receipt.json` únicamente después de que su runner confirme una instalación sana. Ese receipt es el hand-off del binario Engram verificado; no transfiere su propiedad a Pi ni a Stack.

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

## Proyección compartida de Stack

La proyección se ejecuta después de la instalación del paquete y se registra en `~/.jorgex-stack/pi-projection-receipt.json`:

| Recurso | Destino | Propiedad |
| --- | --- | --- |
| System prompt | `~/.pi/agent/AGENTS.md` | Stack, en secciones marcadas `jorgex:system-prompt`, `jorgex:playwright` y `jorgex:chrome-devtools`; Engram lo configura el proveedor oficial y Stack no proyecta `jorgex:engram-protocol` |
| Skills compartidas | `~/.agents/skills` | Stack; se conservan si también las usa otro runtime |
| Prompt | `~/.pi/agent/prompts/lean-audit.md` | Stack |

El `AGENTS.md` estático proyectado por Stack no contiene Context7. Pi añade esa sección desde su bootstrap nativo después de registrar el bridge HTTP aislado; una entrada `available` permite el registro, pero no acredita un handshake HTTP.

La proyección usa las mismas copias canónicas de `stack/` que los demás runtimes. El contenido del usuario fuera de las secciones marcadas se conserva. Pi requiere `modular-system-prompts-v1` y `context7-http-v1`, y proyecta las secciones canónicas de system prompt de forma modular. Context7 se registra mediante un bridge HTTP aislado en memoria durante el bootstrap: `available` significa que la configuración permite el registro, pero no implica un handshake HTTP. Si existe un conflicto, Pi conserva los archivos MCP y bloquea la activación gestionada. No se escriben configuración MCP ni credenciales. Playwright y Chrome DevTools se proyectan en sus bloques propios cuando sus capacidades están habilitadas. El bloque legacy `jorgex:browser` se mantiene para migración y cleanup compatibles. Cuando la preferencia gestionada de Playwright está activa, añade o retira dinámicamente su sección en `AGENTS.md`. La instalación global del CLI y de Chromium es compartida por la máquina; el selector `--playwright-runtimes` decide en qué runtimes se proyecta la guía. El contrato adoptado declara `playwright-handoff-v1`, y el paquete Pi adoptado mantiene 17 árboles de skills con 89 archivos de skill e implementa y prueba `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json`. Las instalaciones repetidas reparan la entrada alias de Pi y conservan sus campos adicionales. Si ese fallo deja un estado parcial o divergente, repite `install`; `sync` no repara ese bloqueo. El paquete Pi adoptado permite activar Chrome DevTools MCP con `--devtools`; Stack proyecta el handoff fijo en `PI_CODING_AGENT_DIR/jorgex-pi/devtools.v1.json` y guarda su SHA-256 en el campo opcional `devtools.sha256` del receipt de proyección. `--no-devtools` lo retira tras revalidar integridad. El servidor se registra como proxy lazy (`directTools: false`), por lo que Pi no precarga el catálogo completo de herramientas. Un conflicto o archivo ajeno bloquea y conserva el estado. El cambio requiere recargar Pi para que el bootstrap cree la sesión con la nueva configuración.

En el rollout histórico de `work-audit`, Stack `1.9.2` adoptó Pi `0.8.0`; la versión publicada `1.9.3` conserva ese pin saliente. La publicación de Stack fue aceptada por npm y el readback confirmó metadata y tarball públicos; esas evidencias siguen separadas de la verificación local del artefacto Pi.

## Resolución dinámica y contrato

El contrato compatible permanece definido en `src/lib/pi-runtime.ts`; la release y sus capacidades se descubren desde el paquete staged en cada install/update deliberado. La resolución de una versión no equivale a aceptar semánticamente cualquier cambio: el stage compara el contrato publicado con el contrato Stack y bloquea divergencias incompatibles. La CI `pi-artifact.yml` resuelve el `latest` observado y verifica SRI, pero no implica que el runtime use una versión personal ya migrada.

La lista `testedVersions` en el contrato representa compatibilidad probada del host Pi; no fija la versión publicada de `jorgex-pi`. Pi `0.87.1` con el artefacto publicado `jorgex-pi@0.8.31` pasó el smoke Pi healthy. Las actualizaciones gestionadas cruzando versiones han sido verificadas también con código de prueba sintético; no se afirma que una instalación personal se haya actualizado en vivo. El agente conductual `engram` permanece en el contrato; su setup y herramientas son provider-owned.

### Diagnóstico de inicialización pendiente

Durante la instalación del paquete, antes de la proyección y del `sync` final, `initialization-diagnostics-v1` permite aceptar provisionalmente solo el envelope exacto de `doctor` que devuelve `INITIALIZATION_REQUIRED`: salida JSON de una sola línea, `schemaVersion: 1`, `command: "doctor"`, `ok: false`, con el nombre, versión y raíz del paquete iguales al candidato verificado y su runner, cinco checks ordenados (`package`, `engram`, `context7` en `ok`; `permissions` y `experience` en `ok` o `error`, con al menos uno en `error`), y `error.phase: "initialization"`, `error.code: "INITIALIZATION_REQUIRED"`, `error.message: "Pi initialization is pending: run sync to complete first initialization."` y `error.remedy: "Run jorgex-pi sync --json and retry."`. Ese estado es **pending**, no healthy. La proyección debe completarse y `sync` debe finalizar la inicialización; cualquier otro resultado unhealthy, malformed o divergente bloquea la instalación.

## Adopción y automatización

La automatización Stack ↔ Pi es snapshot-only: no resuelve ni adopta releases Pi en Stack. No hay que ejecutar un preparador local de adopción ni rotar hashes manualmente como operación rutinaria. Un cambio semántico del contrato requiere revisión específica y actualización deliberada del contrato canónico; un artefacto incompatible bloquea la instalación gestionada antes de activación. El [runbook Stack ↔ Pi](stack-pi-automation.md) cubre la coordinación de snapshots, no adopción de paquetes.

## Histórico: candidato Stack 1.9.6 / Pi 0.8.4

El release publicado histórico fijaba `npm:jorgex-pi@0.8.4`. La fuente ejecutable fijaba `89133070` bytes, SHA-256 `e30cbc0595bfbaa35b37f97096b77d46749315e3cf6ab13f830fe84432798b10` y SHA-512 `39255e7ccf7aad2cbe1069e2dbeb3335dc59f28ad1f0f32b677889e39e167e5fd39b546da9f448c33fad4581f0b4a8f1dda95a2f1b1bce010cc031b188ffc292`. Su `provenance.commit` era `2b5cf37d9bfdb0c574e66712000ecc432eca8a69`; el `parity.source.commit` comprobado en el artefacto era `5e89b970e72cfac0003b11e054c861bed6d44884`. Esta transición histórica quedó superseded por la adopción publicada de Stack `1.9.7` / Pi `0.8.4`.

Stack `1.9.5`, `1.9.6` y `1.9.7` son referencias históricas. La disponibilidad inmediata tras publicación y adopción verificadas no cambia la validación, el merge, el pin exacto ni la compatibilidad exigidos.

## Lifecycle y seguridad

La coordinación opcional entre Stack y Pi está descrita en el [runbook de automatización Stack ↔ Pi](stack-pi-automation.md). Esta automatización no forma parte del lifecycle local de Pi y permanece desactivada por defecto.

- `install` ejecuta primero `engram setup pi` en una instalación real, con backup y rollback de `settings.json`, `mcp.json` y el árbol `npm`; si falla, Pi no se activa. Después verifica el tarball, hace backup de `settings.json` y ejecuta `package install → projection install → package sync`. La última operación ejecuta la inicialización nativa de Pi después de que Stack haya proyectado sus recursos compartidos; si la proyección se bloquea, no se intenta inicializar el paquete.
- `sync` repara drift del paquete o de la proyección sin duplicar recursos; dos pasadas consecutivas son idempotentes.
- `doctor` comprueba package receipt, projection receipt, entradas exactas, rutas y drift, pero no repara. El diagnóstico de Stack puede marcar el runner como no saludable de forma genérica; para el estado detallado de Context7 (`available`, `conflict` o `invalid`) consulta el `doctor` nativo de Pi. `available` no implica un handshake HTTP.
- `uninstall` hace backup antes de retirar, elimina únicamente lo declarado por los receipts y conserva archivos compartidos que sigan siendo propiedad de otro runtime.
- Si un receipt es ilegible, de otro scope, parcial o de historial desconocido, la operación destructiva falla cerrada; no se adopta ni se elimina estado manual silenciosamente.
- El binario, la base de datos y las memorias de Engram son siempre del usuario. El setup oficial puede ejecutarse una vez durante un `install` real con confirmación para descargar un binario ausente; `sync`, dry-run y `--target-dir` no ejecutan `engram setup pi` ni descargas globales. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario.

Pi no escribe, posee ni elimina archivos MCP. En Claude Code, Codex y OpenCode, una configuración Context7 previa compatible se conserva, incluso si procede de una instalación antigua o de un `--target-dir`; esos runtimes solo pueden retirarla cuando un ownership explícito y canónico de Stack lo autoriza.

Las operaciones con `--target-dir` aíslan home, `PI_CODING_AGENT_DIR`, estado, backups y receipt dentro del target, sin consultar la configuración real de Pi o Engram. No descargan el paquete; si el caller aporta un candidato/stage ya verificado, pueden ejecutar smoke y runner aislados dentro del target.

## Receipt exacto y rollback

Los receipts históricos schema 1 sin `managedPackage` requieren la ruta explícita de migración autenticada o uninstall legacy offline. Una vez gestionado, `sync`, `models`, `doctor` y `uninstall` verifican el receipt y los bytes/cache del release sin resolver una versión nueva. Nunca edites receipts ni hashes ni borres `HOME`, Engram o la proyección de otro runtime para forzar confianza.

La migración de un receipt histórico se realiza mediante `install --agents pi` deliberado: el lifecycle autentica el receipt legacy y el estado propio, respalda lo necesario y solo continúa con el candidato staged verificado. Si no puede autenticar el estado, falla cerrado y no modifica estado ajeno.

La restauración automática cubre fallos durante la activación/verificación del release nuevo. Si la activación terminó y después falla la proyección o el `sync` final, puede requerirse recuperación manual desde el backup retenido; no se garantiza restauración automática en todo fallo posterior. El release anterior se identifica mediante el receipt verificado, nunca editándolo.

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

La resolución dinámica no equivale a una migración automática durante `sync`: solo un `install`/`update` deliberado adquiere y activa una release nueva. Los receipts antiguos siguen necesitando migración autenticada.

## Engram

Engram es obligatorio para el paquete gestionado, pero queda fuera de ownership. Si ya existe un binario válido, siempre se conserva. Cuando falta y hay autorización, `install` consulta en tiempo de ejecución el último release estable oficial de GitHub (`releases/latest`, sin prerelease ni draft y nunca una branch) antes de configurar cualquier runtime. Comprueba la metadata viva del asset exacto para plataforma y arquitectura —nombre esperado, estado publicado, tamaño y SHA-256— y falla cerrado si no hay red o falta cualquier dato; no existe fallback estático u offline. Escribe bajo `~/.local/bin/engram` (o el equivalente de la plataforma) y no requiere Brew ni Go. En una ejecución interactiva se pide confirmación; `--engram` autoriza la descarga en flujos no interactivos. `sync`, dry-run y `--target-dir` no descargan Engram. Update sigue siendo explícito y no reemplaza implícitamente un binario existente. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario. La ruta verificada se conserva en el package receipt como hand-off para el runtime.

El plugin oficial de Claude sigue requiriendo Engram estable 2.0.0 o superior. Un binario existente por debajo de ese mínimo haría que Claude escribiera el archivo obsoleto `mcp/engram.json`; por eso el preflight de Claude lo bloquea antes del setup. Stack nunca reemplaza automáticamente un binario existente: hay que actualizarlo explícitamente y repetir `install`. El plugin oficial de Claude aporta hooks y skill; `engram setup claude-code` registra aparte el MCP del usuario y no implica un MCP incluido en Stack ni un smoke autenticado de modelo-herramienta.

## Comandos

| Comando Stack | Comportamiento Pi |
| --- | --- |
| `install --agents pi` | Verifica el tarball, instala y normaliza el paquete, proyecta recursos, ejecuta `sync` para inicializar Pi y escribe ambos receipts. |
| `sync --agents pi` | Reconcilia paquete y proyección; no instala recursos globales ni duplica skills/prompts. |
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
