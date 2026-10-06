# Permisos

## Política

- Trabajo ordinario sin prompts de aprobación: lectura, edición, shell, red y herramientas.
- Únicos denies de Stack: lectura y edición de rutas de secretos.
- Los subagentes lectores conservan sus restricciones de rol. La política no autoriza merges, publicaciones ni ampliar el encargo.
- No es un sandbox: un proceso arbitrario puede leer lo que las reglas de herramientas no ven. Cero credenciales en ejemplos, fixtures y logs.

## Secretos denegados

`.env` y sus variantes, `.ssh/`, `.aws/credentials`, `.npmrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`. `.env.example` queda legible.

OpenCode y Pi comparten la lista de `src/lib/canonical.ts` (`*` también casa `/`; gana la última coincidencia). Claude usa su propia sintaxis en `stack/config/defaults.json`.

## Por runtime

| Runtime | Configuración fresh | Alcance del deny | Límite |
|---|---|---|---|
| Claude Code | `defaultMode: bypassPermissions`, aviso de modo peligroso preaceptado, `deny` de `Read`/`Edit` | Tools de archivo y comandos de shell reconocidos (`cat`, `head`, `tail`, `sed`, `tee`, redirecciones) | Deny gana siempre y no admite excepción: las variantes de `.env` se enumeran en vez de usar `.env.*`. [Límites](claude-code-limits.md) |
| Codex | Perfil `jorgex-read-anywhere` y approval `on-request` | Sandbox del proveedor | Pendiente de decisión: ver nota |
| OpenCode v2 | `external_directory` permitido, `read`/`edit` denegados sobre secretos, cliente `autoaccept` | Tools `read` y `edit` | Shell no pasa por estas reglas. El adapter exige major 2 |
| Pi | `yoloMode: true`, `*` y `bash` permitidos, `path` denegado sobre secretos | Todas las tools y rutas dentro de comandos bash | Depende de que cargue `@gotgenes/pi-permission-system`; doctor lee el JSON y no certifica enforcement |

**Codex:** el perfil actual sigue preguntando y limita la escritura al workspace. Con Codex CLI 0.158.0 y bubblewrap 0.12 se reprodujo que dos o más archivos denegados existentes hacen fallar todos los comandos del sandbox (`bwrap: Can't write data to file …: Bad file descriptor`); un archivo o un directorio denegado funcionan. El cambio a un perfil sin prompts espera esa decisión.

## Preservación

- Se siembra solo en configuración ausente o vacía, con aviso.
- Una configuración existente no se reescribe. Si difiere del default se avisa sin volcar contenido; Stack no ofrece reemplazo: edítala a mano después de un backup.
- Pi: la política se crea solo si el archivo no existe y se conserva al desinstalar.
- Configuración inválida, ilegible o en conflicto bloquea la unidad. [Retirada](../../README.md#preservación-y-retirada).

## Roles

- Lectores: analyst, reviewer, security-auditor, simplifier. Escritores: implementer, generalist.
- Claude, OpenCode y Pi no dan shell, edición ni delegación a los lectores.
- Codex hereda el sandbox del padre: sus lectores conservan shell y el aislamiento depende de una sesión padre de solo lectura.
