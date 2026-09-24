# Runbook de automatización Stack ↔ Pi

Este runbook describe la coordinación opcional entre `jorgehn98/jorgex-stack` y `jorgehn98/jorgex-pi`. La automatización sincroniza snapshots del canon; no instala paquetes Pi, no selecciona una versión Pi ni modifica la configuración personal. No habilita la automatización por sí sola y no sustituye la revisión ni el merge humanos.

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
5. Comprueba el preflight y el resultado: puede ser un no-op o una PR de snapshot. Si el preflight falla, termina antes de crear una PR; no hagas reintentos ciegos.
6. `ready` y checks verdes no autorizan el merge: el merge sigue siendo humano.

La coordinación acepta eventos `push` y `workflow_dispatch` sobre `main`, y el dispatch `pi-published-v1` con el payload exacto `version`, `producer_sha` y `run_id`. Las propuestas se limitan a las rutas y tamaños que valida `.github/scripts/stack-pi-automation.mjs`; las duplicidades, incompatibilidades, races, cambios de base o divergencias bloquean explícitamente. La sincronización de snapshot no adopta el paquete Pi ni actualiza un receipt personal.

## Preparación y recuperación

El preparador de la automatización trabaja con checkouts limpios y genera un artefacto acotado. La preparación y sus verificaciones se ejecutan sin el token de la App. El job de escritura usa el artefacto del mismo run, vuelve a validar la base y el árbol, y comprueba el head y base exactos de la PR antes de marcarla ready.

Una propuesta rechazada no se recrea automáticamente con la misma identidad: requiere recuperación manual. Si una escritura remota falla después de crear la PR, el estado puede haber quedado incierto (por ejemplo, la PR puede estar ya lista); conserva la PR y la rama, verifica su estado y, si necesitas editarla, vuelve a ponerla en draft antes de hacerlo. No repitas la operación sin resolver la causa. No se publica de nuevo un paquete para recuperar una notificación: inspecciona el dispatch desde el coordinador y usa su recuperación manual.

- **Notificación fallida:** corrige la causa y usa `workflow_dispatch` del coordinador, sin reejecutar el publisher mutable.
- **PR o rama ya existente:** inspecciona la propuesta y su estado; no la sobreescribas ni fuerces la referencia.
- **Cierre sin merge o rechazo:** es terminal para la automatización de esa identidad; nunca sobrescribe el rechazo humano. La recuperación humana consiste en restaurar/reabrir la PR original cuando sea posible (volver a draft antes de cambiar código), o resolver el cambio desde el flujo normal aprobado.
- **Base o candidato divergente:** detén la ejecución y revalida desde el `main` actual; cambiar la base no cambia la identidad de la entrada.
- **Desactivación:** establece `JORGEX_AUTOMATION_ENABLED` en un valor distinto de `true` o elimina la activación de la variable. Conserva las PRs y ramas existentes para revisión o cierre manual.

La resolución de versión para una instalación/actualización Pi gestionada pertenece al runtime Stack y se documenta en [Pi runtime](pi-runtime.md); no es responsabilidad de esta automatización. Direct Pi updates tampoco son rollback de Stack.

## Fuentes del runbook

- `.github/workflows/stack-pi-automation.yml`
- `.github/scripts/stack-pi-automation.mjs`
- `docs/references/pi-runtime.md`
