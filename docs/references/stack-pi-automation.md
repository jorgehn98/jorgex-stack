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

La coordinación acepta eventos `push` y `workflow_dispatch` sobre `main`, y el dispatch `pi-published-v1` con el payload exacto `version`, `producer_sha` y `run_id`. Las propuestas se limitan a las rutas y tamaños que valida `.github/scripts/stack-pi-automation.mjs`; las duplicidades, incompatibilidades, races, cambios de base o divergencias bloquean explícitamente.

## Preparación y escritura

El preparador trabaja con checkouts limpios de ambos repositorios y genera un artefacto acotado. La preparación y sus verificaciones se ejecutan sin el token de la App. El job de escritura usa el artefacto del mismo run, vuelve a validar la base y el árbol, y comprueba el head y base exactos de la PR antes de marcarla ready.

Una propuesta rechazada no se recrea automáticamente con la misma identidad: requiere recuperación manual. Si una escritura remota falla después de crear la PR, el estado puede haber quedado incierto (por ejemplo, la PR puede estar ya lista); conserva la PR y la rama, verifica su estado y, si necesitas editarla, vuelve a ponerla en draft antes de hacerlo. No repitas la operación sin resolver la causa. No se publica de nuevo un paquete para recuperar una notificación: inspecciona el dispatch desde el coordinador y usa su recuperación manual.

## Recuperación y rollback

- **Notificación fallida:** corrige la causa y relanza manualmente el workflow del coordinador. No vuelvas a ejecutar el publisher mutable ni cambies el payload fuera del contrato.
- **PR o rama ya existente:** inspecciona la propuesta y su estado; no la sobreescribas ni fuerces la referencia.
- **Base o candidato divergente:** detén la ejecución y prepara una propuesta nueva desde el estado actual de `main`.
- **Desactivación:** establece `JORGEX_AUTOMATION_ENABLED` en un valor distinto de `true` o elimina la activación de la variable. Conserva las PRs y ramas existentes para revisión o cierre manual.

La automatización no está activa por defecto. Este documento no afirma ahorro medido ni una publicación automática; sólo documenta el procedimiento para habilitarla de forma deliberada y reversible.

## Fuentes del runbook

- `.github/workflows/stack-pi-automation.yml`
- `.github/scripts/stack-pi-automation.mjs`
- `docs/references/pi-runtime.md`
