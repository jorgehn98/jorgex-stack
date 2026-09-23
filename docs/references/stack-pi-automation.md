# Runbook de automatización Stack ↔ Pi

Este runbook describe la coordinación opcional entre `jorgehn98/jorgex-stack` y `jorgehn98/jorgex-pi`. No instala paquetes, no habilita la automatización y no sustituye la revisión ni el merge humanos.

## Alcance y configuración

La automatización usa una GitHub App dedicada, instalada únicamente en `jorgex-stack` y `jorgex-pi`. Sus permisos son:

- `contents: write` y `pull_requests: write` en los repositorios necesarios;
- ningún permiso de workflows, npm, administración ni acceso adicional.

El workflow sólo se activa cuando la variable de repositorio `JORGEX_AUTOMATION_ENABLED` vale exactamente `true`. La otra variable necesaria para crear el token es `JORGEX_AUTOMATION_APP_CLIENT_ID`. La clave privada `JORGEX_AUTOMATION_APP_PRIVATE_KEY` es un secreto: configúrala sólo mediante la interfaz segura de GitHub; nunca la pegues en chat, archivos del repositorio o logs.

No se configura `stack-release App` ni se solicitan valores durante este procedimiento.

Referencias oficiales: [tokens de instalación de GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) y [crear un evento `repository_dispatch`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).

## Flujo operativo

1. Fusiona primero el coordinador de Stack y el notificador de Pi, en el orden aprobado.
2. Instala la GitHub App dedicada en ambos repositorios y configura sus permisos, `JORGEX_AUTOMATION_APP_CLIENT_ID` y el secreto `JORGEX_AUTOMATION_APP_PRIVATE_KEY` mediante la interfaz segura de GitHub.
3. Configura `JORGEX_AUTOMATION_ENABLED=true`.
4. Ejecuta `workflow_dispatch` en `main` para el smoke inicial o espera al evento `pi-published-v1` del notificador de Pi.
5. Comprueba el preflight y el resultado: puede ser un no-op o una PR con los datos, candidato y gates esperados. Si el preflight falla, termina antes de crear una PR; no hagas reintentos ciegos.
6. `ready` y checks verdes no autorizan el merge: el merge sigue siendo humano.

La coordinación acepta eventos `push` y `workflow_dispatch` sobre `main`, y el dispatch `pi-published-v1` con el payload exacto `version`, `producer_sha` y `run_id`. Las propuestas se limitan a las rutas y tamaños que valida `.github/scripts/stack-pi-automation.mjs`; las duplicidades, incompatibilidades, races, cambios de base o divergencias bloquean explícitamente. La compatibilidad Pi es una lista explícita de versiones probadas definida por el contrato y `pi-runtime.md`; no se interpreta como un intervalo.

## Preparación y escritura

El preparador trabaja con checkouts limpios de ambos repositorios y genera un artefacto acotado. La preparación y sus verificaciones se ejecutan sin el token de la App. El job de escritura usa el artefacto del mismo run, vuelve a validar la base y el árbol, y comprueba el head y base exactos de la PR antes de marcarla ready.

Una propuesta rechazada no se recrea automáticamente con la misma identidad: requiere recuperación manual. Si una escritura remota falla después de crear la PR, el estado puede haber quedado incierto (por ejemplo, la PR puede estar ya lista); conserva la PR y la rama, verifica su estado y, si necesitas editarla, vuelve a ponerla en draft antes de hacerlo. No repitas la operación sin resolver la causa. No se publica de nuevo un paquete para recuperar una notificación: inspecciona el dispatch desde el coordinador y usa su recuperación manual.

Cuando la adopción amplía la lista de versiones compatibles, el preparador exige la aceptación explícita de la versión exacta (`--accept-pi-version EXACT`) después del smoke real. Esa opción solo añade esa versión, conserva las anteriores y ajusta los límites a los extremos de la lista resultante; no relaja otras comparaciones del contrato ni las comprobaciones de integridad o hashes.

La retirada de la skill Playwright del paquete Pi requiere además `--accept-playwright-skill-removal`; sin esa opción, la retirada se rechaza. La opción solo acepta una entrada `playwright-cli` en la paridad con `sourcePath` y `targetPath` canónicos, ausente tanto de la fuente Stack fusionada como del checkout productor de Pi. Por sí sola no autoriza otros cambios y puede combinarse con flags explícitos que pasan sus propias verificaciones. Para proteger la topología del cambio, descarga el tarball anterior y valida sus hashes fijados, y exige que el inventario del nuevo tarball sea idéntico salvo por `package/skills/playwright-cli/**`; el handoff Playwright, el SDK existente, las dependencias y el resto de contratos se conservan. Esta aceptación es manual porque la comprobación necesita coordinar ambos checkouts y el artefacto publicado, no solo leer el diff de una rama.

La transición a `modular-system-prompts-v1` requiere además `--accept-modular-system-prompts`; sin esa opción se rechaza. Esta opción solo acepta la adición de esa capability, los tres módulos canónicos (`context7.md`, `browser-playwright.md` y `browser-chrome-devtools.md`) y la retirada exacta de las dos exclusiones de overlay de navegador, manteniendo la exclusión `context7-mcp`. El preparador verifica la correspondencia de bytes y hashes entre la fuente Stack y el checkout productor, el artefacto publicado y sus SRI/SHA, y el inventario exacto anterior más los tres módulos. No es un bypass genérico ni autoriza otros cambios.

La adopción de `context7-http-v1` requiere además `--accept-context7-http`; sin esa opción se rechaza. Esta aceptación solo permite el delta exacto que añade la capability `context7-http-v1`, elimina la exclusión de capability `context7-mcp`, añade `runner.context7` con transporte HTTP, registro `isolated in-memory bridge at Pi bootstrap`, diagnóstico sin handshake implícito, preservación de `PI_CODING_AGENT_DIR/mcp.json` propiedad del usuario y cleanup sin configuración MCP ni credenciales. También añade la definición `context7` al esquema de respuesta del runner y el check `context7` al resultado de estado/doctor. Verifica el contrato, el artefacto publicado, sus bytes y hashes, el inventario y la correspondencia con el productor; no es un bypass de integridad ni acepta cambios adicionales.

La adopción de `permissions-policy-v1` requiere además `--accept-permissions-policy`; sin esa opción se rechaza. El contrato base declara tres escrituras externas; con esta capability el delta añade tres nuevas y deja seis en total: la configuración, el receipt de lifecycle y los backups de la política, todos gestionados por Pi. Stack no reclama ownership ni reimpone la configuración. La siembra es solo para una configuración ausente y conserva el estado existente, inválido o concurrente. El preparador vuelve a comprobar contrato, bytes, hashes e inventario del artefacto publicado; el flag no es un bypass.

La adopción de `experience-defaults-v1` requiere además `--accept-experience-defaults`; sin esa opción se rechaza. La transición exacta añade una escritura nueva (el receipt de lifecycle) y deja siete escrituras externas en total, conserva las seis rutas previas de paquete y permisos, y valida el módulo/binario de experiencia, contratos, bytes, hashes e inventario frente al productor publicado. Los defaults `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true` se siembran solo en la primera inicialización y en campos ausentes; cambios o borrados del usuario no se resembran. `hideThinkingBlock` afecta la presentación, no `defaultThinkingLevel` ni el razonamiento.

La adopción oficial de Engram requiere `--accept-official-engram`; sin esa opción se rechaza por defecto. Solo acepta el delta revisado que mantiene el comportamiento del provider y elimina la proyección Stack-owned del protocolo y del filtrado de herramientas. El preparador conserva las comprobaciones de contrato, inventario, bytes, tamaño, SRI, SHA e integridad del tarball; el flag no es un bypass ni instala Engram.

## Recuperación y rollback

Si el coordinador falla cerrado por un contrato no soportado y no crea una PR, no se debe reintentar a ciegas. Para esta adopción de `initialization-diagnostics-v1`, tras comprobar el estado de runs y PRs se requirió el preparador manual verificado con `--accept-initialization-diagnostics`, seguido de una PR manual con la base actual, review y gates.

El run [`35705370190`](https://github.com/jorgehn98/jorgex-stack/actions/runs/35705370190) falló cerrado antes de crear la PR porque requería la revisión contractual de la adopción oficial. Pi `0.8.28` ya estaba publicado y verificado; por tanto, la recuperación usa el preparador local desde un checkout limpio de Stack y el checkout productor de Pi, con la versión exacta publicada y `--accept-official-engram`. Después se abre una PR manual con la base actual y se ejecutan review y gates. No se vuelve a publicar Pi, no se editan pines ni hashes manualmente y no se convierte esta recuperación en una instalación personal. El seguimiento de la automatización queda en [issue #147](https://github.com/jorgehn98/jorgex-stack/issues/147).

La automatización pasa permanentemente `acceptOfficialEngram` al preparador de adopción para poder reconciliar esa transición cuando el diff real coincide; esa configuración permanente no fuerza la aceptación: el preparador solo activa el delta cuando el estado real coincide exactamente con la transición revisada. Cualquier cambio posterior vuelve a requerir revisión manual.

- **Notificación fallida:** corrige la causa y usa `workflow_dispatch` del coordinador, sin reejecutar el publisher mutable. El dispatch recupera notificaciones o reconcilia nuevas entradas; no recrea propuestas cerradas de la misma identidad, aunque elimines su rama.
- **PR o rama ya existente:** inspecciona la propuesta y su estado; no la sobreescribas ni fuerces la referencia.
- **Cierre sin merge o rechazo:** es terminal para la automatización de esa identidad; nunca sobrescribe el rechazo humano. La recuperación humana consiste en restaurar/reabrir la PR original cuando sea posible (volver a draft antes de cambiar código), o usar el preparador local verificado y abrir manualmente otra PR con base actual, review y gates.
- **Base o candidato divergente:** detén la ejecución y revalida desde el `main` actual; cambiar la base no cambia la identidad de la entrada. Si esa identidad ya tiene una propuesta cerrada, aplica la recuperación humana anterior: un dispatch no crea otra.
- **Desactivación:** establece `JORGEX_AUTOMATION_ENABLED` en un valor distinto de `true` o elimina la activación de la variable. Conserva las PRs y ramas existentes para revisión o cierre manual.

La automatización no está activa por defecto. Este documento no afirma ahorro medido ni una publicación automática; sólo documenta el procedimiento para habilitarla de forma deliberada y reversible.

## Fuentes del runbook

- `.github/workflows/stack-pi-automation.yml`
- `.github/scripts/stack-pi-automation.mjs`
- `docs/references/pi-runtime.md`
