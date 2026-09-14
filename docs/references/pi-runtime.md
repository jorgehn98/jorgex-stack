# Pi runtime

JorgeX Stack integra Pi mediante dos capas coordinadas: el paquete Pi-native exacto y una proyección de recursos compartidos propiedad de Stack. Pi no se traduce a través del manifest de componentes ni del model map de Stack.

Esta referencia conserva la introducción histórica de `jorgex-pi@0.8.0` y las adopciones anteriores. El pin vigente consume el artefacto publicado `jorgex-pi@0.8.23`, con procedencia `ebb5e6e18e8e9297ffbf7bd53cf6785b952474b9`; su identidad, procedencia y digests son autoritativos en `src/lib/pi-runtime-pin.json`. `src/lib/pi-runtime.ts` es la autoridad del lifecycle y sus contratos. El lector `.github/scripts/pi-pin.mjs` valida ese JSON y el workflow recibe de él la URL y el tamaño mediante variables de entorno. La publicación de Stack usa el auto-bump existente al mergear y selecciona el patch disponible; el número final se resuelve en el registro.

El canon de Stack y el paquete Pi adoptado mantienen una snapshot de 17 árboles de skills con 89 archivos de skill. El contrato 0.8.23 añade `initialization-diagnostics-v1` sobre `experience-defaults-v1`: en la primera inicialización siembra solo los campos ausentes `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true`, y conserva cambios o borrados del usuario sin resembrarlos. `hideThinkingBlock` solo cambia la presentación; `defaultThinkingLevel` y el razonamiento no cambian. Pi solo posee los campos de settings que crea y registra en su receipt; los valores preexistentes del usuario quedan sin ownership. El handoff Playwright ya está implementado y probado en `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json`; la identidad, procedencia e integridad del paquete adoptado son autoritativas en `src/lib/pi-runtime-pin.json`.

## Paquete e integridad

El artefacto histórico de referencia es el [tarball `jorgex-pi@0.8.0` publicado en npm](https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.0.tgz), con `89128340` bytes. Para el pin vigente, consulta `src/lib/pi-runtime-pin.json`: contiene nombre, versión, `source`, commit de procedencia, tamaño y SHA-256/SHA-512. La URL pública se deriva de la versión por `.github/scripts/pi-pin.mjs`; no se duplican aquí valores que cambian en cada adopción.

La verificación del tarball sigue siendo obligatoria antes de cualquier operación gestionada. La entrada del paquete queda normalizada al `source` del JSON y conserva los campos adicionales de la entrada existente. Solo la forma gestionada exacta `{ "source": "...", "skills": [], "prompts": [] }` completa el lifecycle de instalación, proyección, `sync` y `doctor`; filtros no vacíos, filtros personalizados o metadatos adicionales se conservan y quedan bloqueados como `source-divergent`, sin normalizarse ni eliminarse silenciosamente.

Los filtros `skills: []` y `prompts: []` se aplican únicamente después de que la proyección compartida haya terminado. Así el paquete no carga una segunda copia de los recursos comunes.

El gestor de paquetes interno de Pi es la única excepción npm del lifecycle: Stack usa pnpm para desarrollo, dependencias y herramientas globales, y nunca lanza npm directamente. El paquete registra un receipt separado en `~/.jorgex-stack/pi-receipt.json` únicamente después de que su runner confirme una instalación sana. Ese receipt es el hand-off del binario Engram verificado; no transfiere su propiedad a Pi ni a Stack.

## Procedencia, attestation y paridad

Estos identificadores describen objetos distintos y no deben intercambiarse:

- El commit productor del pin vigente está en `src/lib/pi-runtime-pin.json` (`provenance.commit`).
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
| System prompt | `~/.pi/agent/AGENTS.md` | Stack, en secciones marcadas `jorgex:system-prompt`, `jorgex:engram-protocol`, `jorgex:playwright` y `jorgex:chrome-devtools`; el `AGENTS.md` estático no incluye Context7 y Pi 0.8.23 lo añade desde el bootstrap, conservando el bloque legacy como entrada migrable |
| Skills compartidas | `~/.agents/skills` | Stack; se conservan si también las usa otro runtime |
| Prompt | `~/.pi/agent/prompts/lean-audit.md` | Stack |

El `AGENTS.md` estático proyectado por Stack no contiene Context7. Pi 0.8.23 añade esa sección desde su bootstrap nativo después de registrar el bridge HTTP aislado; una entrada `available` permite el registro, pero no acredita un handshake HTTP.

En el pin vigente, Pi 0.8.23 requiere `modular-system-prompts-v1` y `context7-http-v1`, y proyecta las secciones canónicas de system prompt de forma modular.

La proyección usa las mismas copias canónicas de `stack/` que los demás runtimes. El contenido del usuario fuera de las secciones marcadas se conserva. Pi 0.8.22 requiere `modular-system-prompts-v1` y `context7-http-v1`, y proyecta las secciones canónicas de system prompt de forma modular. Context7 se registra mediante un bridge HTTP aislado en memoria durante el bootstrap: `available` significa que la configuración permite el registro, pero no implica un handshake HTTP. Si existe un conflicto, Pi conserva los archivos MCP y bloquea la activación gestionada. No se escriben configuración MCP ni credenciales. Playwright y Chrome DevTools se proyectan en sus bloques propios cuando sus capacidades están habilitadas. El bloque legacy `jorgex:browser` se mantiene para migración y cleanup compatibles. Cuando la preferencia gestionada de Playwright está activa, añade o retira dinámicamente su sección en `AGENTS.md`. La instalación global del CLI y de Chromium es compartida por la máquina; el selector `--playwright-runtimes` decide en qué runtimes se proyecta la guía. El contrato adoptado declara `playwright-handoff-v1`, y el paquete Pi adoptado mantiene 17 árboles de skills con 89 archivos de skill e implementa y prueba `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json`. Las instalaciones repetidas reparan la entrada alias de Pi y conservan sus campos adicionales. Si ese fallo deja un estado parcial o divergente, repite `install`; `sync` no repara ese bloqueo. El paquete Pi adoptado permite activar Chrome DevTools MCP con `--devtools`; Stack proyecta el handoff fijo en `PI_CODING_AGENT_DIR/jorgex-pi/devtools.v1.json` y guarda su SHA-256 en el campo opcional `devtools.sha256` del receipt de proyección. `--no-devtools` lo retira tras revalidar integridad. El servidor se registra como proxy lazy (`directTools: false`), por lo que Pi no precarga el catálogo completo de herramientas. Un conflicto o archivo ajeno bloquea y conserva el estado. El cambio requiere recargar Pi para que el bootstrap cree la sesión con la nueva configuración.

En el rollout histórico de `work-audit`, Stack `1.9.2` adoptó Pi `0.8.0`; la versión publicada `1.9.3` conserva ese pin saliente. La publicación de Stack fue aceptada por npm y el readback confirmó metadata y tarball públicos; esas evidencias siguen separadas de la verificación local del artefacto Pi.

## Pin vigente y contrato

El contrato del pin vigente, sus capacidades, runner, escrituras gestionadas y política de modelo se declara en `src/lib/pi-runtime.ts`. La fixture independiente `tests/fixtures/pi-runtime.ts` consume la metadata de artefactos y paridad de `tests/fixtures/pi-runtime-artifacts.json` para las pruebas; no es una segunda autoridad del pin. La disponibilidad para consumo comienza tras la publicación y adopción verificadas; la validación, el pin exacto, la integridad y la compatibilidad siguen siendo obligatorios.

La compatibilidad vigente es una allowlist explícita de Pi `0.84.2` y `0.85.1`; no incluye `0.85.0` ni un intervalo implícito. Los límites del contrato vigente corresponden a los extremos de esa lista. El contrato 0.8.23 incluye `modular-system-prompts-v1`, `context7-http-v1`, `permissions-policy-v1`, `experience-defaults-v1` e `initialization-diagnostics-v1`, además de los handoffs de Playwright y DevTools.

### Diagnóstico de inicialización pendiente

Durante la instalación del paquete, antes de la proyección y del `sync` final, `initialization-diagnostics-v1` permite aceptar provisionalmente solo el envelope exacto de `doctor` que devuelve `INITIALIZATION_REQUIRED`: salida JSON de una sola línea, `schemaVersion: 1`, `command: "doctor"`, `ok: false`, el paquete `jorgex-pi@0.8.23` y su runner, cinco checks ordenados (`package`, `engram`, `context7` en `ok`; `permissions` y `experience` en `ok` o `error`, con al menos uno en `error`), y `error.phase: "initialization"`, `error.code: "INITIALIZATION_REQUIRED"`, `error.message: "Pi initialization is pending: run sync to complete first initialization."` y `error.remedy: "Run jorgex-pi sync --json and retry."`. Ese estado es **pending**, no healthy. La proyección debe completarse y `sync` debe finalizar la inicialización; cualquier otro resultado unhealthy, malformed o divergente bloquea la instalación.

## Preparar una adopción de Pi

Con la App configurada y `JORGEX_AUTOMATION_ENABLED=true`, el coordinador puede proponer la adopción del paquete Pi publicado y verificado. Antes de preparar una PR manual, comprueba runs y PRs existentes según el [runbook Stack ↔ Pi](stack-pi-automation.md). Sin opt-in, ante incompatibilidad o fallo explícito, el preparador local y la PR manual son la alternativa, con review, gates y merge por orden de Jorge. Si falta el artefacto publicado, la adopción sigue bloqueada por esa dependencia externa; no edites pines ni hashes a mano para sustituirlo.

Para esa preparación manual, ejecuta el preparador desde un checkout de Stack en rama de trabajo o detached, nunca `main`/`master`:

```text
node .github/scripts/prepare-pi-adoption.mjs --pi-dir ABS --version EXACT [--accept-pi-version 0.85.1] [--accept-playwright-skill-removal] [--accept-modular-system-prompts] [--accept-context7-http] [--accept-permissions-policy] [--accept-experience-defaults] [--apply]
```

`--pi-dir` apunta a un checkout Git separado de Pi. El preparador lee ese repositorio: exige el tag `vEXACT`, su ascendencia en `origin/main` y la de la procedencia actual, y compara contratos publicados y vigentes. La versión debe ser exacta, estar publicada en npm y ser compatible; una incompatibilidad requiere revisión manual y no se resuelve retocando fixtures o goldens.

`--accept-pi-version 0.85.1` muestra la aceptación explícita de una versión exacta solicitada para ampliar la compatibilidad del contrato tras el smoke real. Solo permite añadir exactamente esa versión a las versiones probadas, conserva `0.84.2` y mantiene los límites correspondientes; no acepta `0.85.0`, rangos ni otras versiones. Sin este flag, un cambio semántico de compatibilidad se rechaza. La aceptación no anticipa una release ni sustituye la verificación del artefacto publicado.

`--accept-playwright-skill-removal` es opcional. Sin esta opción, la retirada de la entrada `playwright-cli` se rechaza. Debe usarse cuando el artefacto publicado elimina únicamente esa entrada de la paridad: el preparador exige los `sourcePath`/`targetPath` canónicos, comprueba que el subtree no existe en la fuente Stack fusionada ni en el productor Pi, verifica el tarball anterior con sus hashes fijados y compara el inventario nuevo con una única diferencia, la retirada de `package/skills/playwright-cli/**`. Esta opción por sí sola no autoriza otros cambios; puede combinarse con flags explícitos que pasan sus propias verificaciones. El handoff Playwright, el SDK existente, las dependencias y el resto del contrato deben permanecer iguales. La aceptación es manual porque esta topología cruza dos checkouts Git y un tarball publicado; no se puede inferir el borrado seguro a partir de un recuento o de una diferencia parcial.

`--accept-modular-system-prompts` es opcional y solo acepta la transición concreta a `modular-system-prompts-v1`. El preparador exige que el artefacto publicado añada exactamente esa capability, que su paridad declare los tres módulos canónicos (`context7.md`, `browser-playwright.md` y `browser-chrome-devtools.md`) con sus hashes, que conserve la exclusión de integración `context7-mcp` y que retire exactamente las dos exclusiones de overlay de navegador correspondientes. También verifica los bytes de cada módulo contra la fuente Stack indicada por el commit de paridad y valida el tarball publicado, sus bytes y hashes, y el inventario exacto del archivo anterior más esos tres módulos. La opción no es un bypass genérico y no autoriza cambios adicionales de contrato, procedencia, inventario o integridad.

`--accept-context7-http` es opcional y solo acepta el delta exacto de Context7 HTTP: añade `context7-http-v1`, incorpora `extensions/context7-config.mjs`, elimina la exclusión `context7-mcp`, añade la metadata `runner.context7` y el estado preservado de usuario, y extiende el esquema estricto del runner con `context7` y su check en `status`/`doctor`. El preparador compara el contrato, los bytes, hashes e inventario del artefacto publicado con el productor; no es un bypass. Consulta el [runbook Stack ↔ Pi](stack-pi-automation.md) para la coordinación y recuperación.

`--accept-experience-defaults` solo acepta la transición exacta a `experience-defaults-v1`: actualiza `bin/jorgex-pi.mjs` y los contratos, y añade una escritura nueva (el receipt de lifecycle) para pasar de seis a siete escrituras externas. La escritura existente de `settings.json` conserva sus rutas y recibe únicamente la semántica de los defaults ausentes. Verifica el binario, los contratos, bytes, hashes e inventario frente al productor publicado; no cambia `defaultThinkingLevel` ni el razonamiento.

El modo por defecto y `--apply` exigen Stack limpio, en rama de trabajo o detached y sin índices enmascarados (`assume-unchanged` o `skip-worktree`). Para una versión nueva, incluso el dry-run descarga y verifica el tarball mediante SRI, SHA-256/SHA-512, inventario y contratos, pero no ejecuta Pi, publica, crea PR ni configura App. `--apply` actualiza normalmente el pin y `tests/fixtures/pi-runtime-artifacts.json` con rollback ante errores; la metadata de la fixture sigue independiente y `src/lib/pi-runtime.ts` intacto. `--accept-devtools-handoff` relaja únicamente la comparación revisada que añade `chrome-devtools-handoff-v1` y elimina su exclusión emparejada; `--accept-playwright-handoff` permite únicamente insertar `playwright-handoff-v1` y añadir `package/extensions/playwright.ts` cuando el preparador verifica el conjunto exacto de archivos frente al tarball previo, cuyos hashes están fijados, y comprueba los bytes del nuevo módulo contra el commit productor de Pi. No relaja las demás comprobaciones de contrato o integridad. Ninguno valida handoffs vivos ni es bypass de integridad. Úsalos junto con `--pi-dir ABS --version EXACT [--apply]`; no alteran el pin, la snapshot ni la historia por sí solos.

Una versión igual o anterior al pin actual produce `unchanged` sin tocar Pi ni preparar archivos. Si falla la escritura, el preparador intenta restaurar los JSON; si no puede completar el rollback, conserva los backups y comunica su ruta para recuperación manual. Esto es distinto del rollback de una instalación: usa una versión publicada de Stack que reconozca el receipt presente y sigue el procedimiento de esta referencia, sin editar receipts, hashes ni estado del usuario.

## Histórico: candidato Stack 1.9.6 / Pi 0.8.4

El release publicado histórico fijaba `npm:jorgex-pi@0.8.4`. La fuente ejecutable fijaba `89133070` bytes, SHA-256 `e30cbc0595bfbaa35b37f97096b77d46749315e3cf6ab13f830fe84432798b10` y SHA-512 `39255e7ccf7aad2cbe1069e2dbeb3335dc59f28ad1f0f32b677889e39e167e5fd39b546da9f448c33fad4581f0b4a8f1dda95a2f1b1bce010cc031b188ffc292`. Su `provenance.commit` era `2b5cf37d9bfdb0c574e66712000ecc432eca8a69`; el `parity.source.commit` comprobado en el artefacto era `5e89b970e72cfac0003b11e054c861bed6d44884`. Esta transición histórica quedó superseded por la adopción publicada de Stack `1.9.7` / Pi `0.8.4`.

Stack `1.9.5`, `1.9.6` y `1.9.7` son referencias históricas. La disponibilidad inmediata tras publicación y adopción verificadas no cambia la validación, el merge, el pin exacto ni la compatibilidad exigidos.

## Lifecycle y seguridad

La coordinación opcional entre Stack y Pi está descrita en el [runbook de automatización Stack ↔ Pi](stack-pi-automation.md). Esta automatización no forma parte del lifecycle local de Pi y permanece desactivada por defecto.

- `install` verifica el tarball, hace backup y ejecuta la secuencia completa `package install → projection install → package sync`. La última operación ejecuta la inicialización nativa de Pi después de que Stack haya proyectado sus recursos compartidos; si la proyección se bloquea, no se intenta inicializar el paquete. Si esa inicialización queda bloqueada o devuelve un resultado inesperado, `install` falla de forma segura y devuelve el remedio `sync --agents pi`.
- `sync` repara drift del paquete o de la proyección sin duplicar recursos; dos pasadas consecutivas son idempotentes.
- `doctor` comprueba package receipt, projection receipt, entradas exactas, rutas y drift, pero no repara. El diagnóstico de Stack puede marcar el runner como no saludable de forma genérica; para el estado detallado de Context7 (`available`, `conflict` o `invalid`) consulta el `doctor` nativo de Pi. `available` no implica un handshake HTTP.
- `uninstall` hace backup antes de retirar, elimina únicamente lo declarado por los receipts y conserva archivos compartidos que sigan siendo propiedad de otro runtime.
- Si un receipt es ilegible, de otro scope, parcial o de historial desconocido, la operación destructiva falla cerrada; no se adopta ni se elimina estado manual silenciosamente.
- El binario y la base de datos/memorias de Engram son siempre del usuario. La instalación interactiva puede ofrecer el canal nativo con confirmación explícita; la base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario.

Pi no escribe, posee ni elimina archivos MCP. En Claude Code, Codex y OpenCode, una configuración Context7 previa compatible se conserva, incluso si procede de una instalación antigua o de un `--target-dir`; esos runtimes solo pueden retirarla cuando un ownership explícito y canónico de Stack lo autoriza.

Las operaciones con `--target-dir` aíslan home, `PI_CODING_AGENT_DIR`, estado, backups y receipt dentro del target, sin consultar la configuración real de Pi o Engram.

## Receipt exacto y rollback

La transición documentada es de un receipt de Pi anterior al pin vigente. Antes de consumir una versión de Stack, resuelve su número exacto en el registro y comprueba que su pin reconoce el receipt presente; nunca uses `latest` ni una versión aproximada. No se borran `HOME` ni receipts. Si el receipt no es reconocido o la limpieza no puede verificar ownership, la operación se detiene; no se editan receipts ni hashes, no se borra `HOME`, Engram o la proyección de otro runtime.

Upgrade desde el receipt histórico anterior al pin vigente, en este orden: (1) comprueba en el registro una versión de Stack que reconozca el receipt presente; (2) ejecuta con esa versión `uninstall --agents pi`; (3) resuelve en el registro la versión exacta que consuma el JSON vigente y confirma que su pin reconoce ese receipt; (4) ejecuta con esa versión `install --agents pi`.

Rollback al receipt histórico anterior, en este orden: (1) resuelve en el registro la versión exacta de la release que reconoce el receipt vigente; (2) ejecuta con esa versión `uninstall --agents pi`; (3) confirma en el registro la versión que reconoce el receipt anterior; (4) ejecuta con esa versión `install --agents pi`. No conviertas estos pasos en comandos con un identificador supuesto: cada versión debe salir del registro y del pin verificado.

Las parejas históricas se conservan como referencia y cada paso usa la versión de Stack que reconoce el receipt presente. No se editan receipts ni se borra estado manualmente:

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

La instalación o consumo del paquete Pi queda disponible tras la publicación y adopción verificadas. El preparador no actualiza transparentemente receipts antiguos: cada transición debe usar la versión exacta que reconoce el receipt presente.

## Engram

Engram es obligatorio para el paquete gestionado, pero queda fuera de ownership. Si ya existe un binario válido, se conserva. `install` resuelve o instala antes de configurar cualquier runtime el binario oficial fijado en v1.20.0, bajo `~/.local/bin/engram` (o el equivalente de la plataforma), verificando tamaño y SHA-256; el instalador de release no requiere Brew ni Go. En una ejecución interactiva se pide confirmación; `--engram` autoriza la descarga en flujos no interactivos. `sync`, dry-run y `--target-dir` no descargan Engram. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario. La ruta verificada se conserva en el package receipt como hand-off para el runtime.

## Comandos

| Comando Stack | Comportamiento Pi |
| --- | --- |
| `install --agents pi` | Verifica el tarball, instala y normaliza el paquete, proyecta recursos, ejecuta `sync` para inicializar Pi y escribe ambos receipts. |
| `sync --agents pi` | Reconcilia paquete y proyección; no instala recursos globales ni duplica skills/prompts. |
| `models --agents pi` | Devuelve routing heredado de la sesión; no escribe model map de Stack. |
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
| `unsupported-pi-version` | Usa una versión explícitamente probada (`0.84.2` o `0.85.1`) por el release congelado; no asumas compatibilidad con versiones intermedias. |
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

La evidencia autoritativa de identidad e integridad del paquete es `src/lib/pi-runtime-pin.json`; el lifecycle es `src/lib/pi-runtime.ts`. La de la proyección es `src/lib/pi-projection-lifecycle.ts` junto con `src/adapters/pi.ts` y los componentes compartidos que proyecta.
