# Permisos

Stack siembra permisos únicamente en configuración fresh/ausente/vacía, con aviso. Una configuración existente se preserva; si difiere se avisa sin volcar contenido. Stack no ofrece reemplazo de permisos existentes: revisa/edita manualmente la configuración nativa del runtime después de crear un backup, conservando tus restricciones. Abrir/navegar/aplicar canon no reimpone permisos.

- **Claude:** allow Read/Grep/Glob; ask shell/escritura/web; deny patrones sensibles. El matching de reglas Bash es posicional y best-effort; [límites Claude](claude-code-limits.md).
- **Codex:** perfil `jorgex-read-anywhere`, approval on-request y denies sensibles. Lectores conservan shell por capacidades reales de Codex; el aislamiento depende de una sesión padre readonly. No declarar enforcement por `sandbox_mode` en el perfil del subagente ni construir un supervisor propio.
- **OpenCode v2:** reglas nativas ordenadas por action/resource/effect, allow trabajo ordinario, asks Git sensible/SSH y denies destrucción/secretos. No traducción ni soporte v1. El adapter exige major 2 antes de escritura real.
- **Pi:** configuración/permisos pertenecen a la extensión nativa @gotgenes/pi-permission-system; doctor lee JSON y no repara ni certifica enforcement. Allowlist nativa de tools por agente y sin delegación anidada.

Analyst/reviewer/security-auditor/simplifier son lectores; implementer/generalist escriben. Claude/OpenCode/Pi no dan shell/edit/spawn a lectores. Codex es la excepción explícita anterior. No modificar builtin del host ni crear otro perfil de simplifier escritor.

Lectura amplia puede exponer secretos no cubiertos por patrones: no equivale a aislamiento exhaustivo. Cero credenciales en ejemplos, fixtures y logs. Integraciones oficiales ejecutan código de proveedores por sus canales nativos. Configuración inválida/ilegible/conflicto bloquea la unidad; los backups y manifest local conservan datos pero no prueban autoridad frente a manipulación. [Retirada](../../README.md#preservación-y-retirada).
