# Permisos

## Política

- Trabajo ordinario sin prompts de aprobación: lectura, edición, shell, red y herramientas.
- Únicos denies de Stack: lectura y edición de rutas de secretos.
- Los subagentes lectores conservan sus restricciones de rol. La política no autoriza merges, publicaciones ni ampliar el encargo.
- No es un sandbox: un proceso arbitrario puede leer lo que las reglas de herramientas no ven. Cero credenciales en ejemplos, fixtures y logs.

## Secretos denegados

`.env` y sus variantes, `.ssh/`, `.aws/credentials`, `.npmrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`. `.env.example` queda legible.

Esta lista aplica a Claude, OpenCode y Pi; Codex es la excepción descrita abajo. OpenCode y Pi comparten la lista de `src/lib/canonical.ts` (`*` también casa `/`; gana la última coincidencia). Claude usa su propia sintaxis en `stack/config/defaults.json`.

## Por runtime

| Runtime | Configuración fresh | Alcance del deny | Límite |
|---|---|---|---|
| Claude Code | `defaultMode: bypassPermissions`, aviso de modo peligroso preaceptado, `deny` de `Read`/`Edit` | Tools de archivo y comandos de shell reconocidos (`cat`, `head`, `tail`, `sed`, `tee`, redirecciones) | Deny gana siempre y no admite excepción: las variantes de `.env` se enumeran en vez de usar `.env.*`. [Límites](claude-code-limits.md) |
| Codex | `approval_policy = "never"` y perfil `jorgex-yolo`: lectura global, escritura en HOME y workspace, red activa, deny de `~/.ssh` y `~/.aws` | Sandbox del proveedor: cubre cualquier comando | **No protege `.env`, `.npmrc` ni claves sueltas.** No es bypass: fuera de HOME y `/tmp` no escribe |
| OpenCode v2 | `external_directory` permitido, `read`/`edit` denegados sobre secretos, cliente `autoaccept` | Tools `read` y `edit` | Shell no pasa por estas reglas. El adapter exige major 2 |
| Pi | `yoloMode: true`, `*` y `bash` permitidos, `path` denegado sobre secretos | Todas las tools y rutas dentro de comandos bash | Depende de que cargue `@gotgenes/pi-permission-system`; doctor lee el JSON y no certifica enforcement |

**Codex:** solo se deniegan directorios. Con Codex CLI 0.158.0 y bubblewrap 0.12 se reprodujo que dos o más archivos denegados existentes hacen fallar todos los comandos del sandbox (`bwrap: Can't write data to file …: Bad file descriptor`), y `":root" = "write"` no arranca; un directorio denegado funciona. La lista de archivos se ampliará cuando el proveedor lo corrija, tras repetir la prueba con `codex sandbox -P jorgex-yolo`. Algunas herramientas pueden chocar con el sandbox (sockets de Docker, escrituras fuera de HOME).

## Preservación

- Se siembra solo en configuración ausente o vacía, con aviso.
- Una configuración existente no se reescribe. Si difiere del default se avisa sin volcar contenido; Stack no ofrece reemplazo: edítala a mano después de un backup.
- Pi: la política se crea solo si el archivo no existe y se conserva al desinstalar.
- Configuración inválida, ilegible o en conflicto bloquea la unidad. [Retirada](../../README.md#preservación-y-retirada).

## Roles

- Lectores: analyst, reviewer, security-auditor, simplifier. Escritores: implementer, generalist.
- Claude, OpenCode y Pi no dan shell, edición ni delegación a los lectores.
- Codex hereda el sandbox del padre: sus lectores conservan shell y el aislamiento depende de una sesión padre de solo lectura.
