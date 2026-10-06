# Límites de Claude Code

Claude consume subagentes nativos y enlaces a la biblioteca común de skills. No se acreditó lectura directa de `~/.agents/skills`, por eso Stack crea un enlace por skill desde su ruta nativa, sin duplicar contenido ni tocar skills ajenas.

Para instrucciones globales se usa `~/.agents/AGENTS.md` y un puente mínimo `@…` en `~/.claude/CLAUDE.md`. El AGENTS.md de proyecto no equivale a cargar automáticamente un AGENTS.md global; no borrar instrucciones ajenas al crear el puente. Los marcadores ambiguos o archivo ilegible bloquean. No hay output-style/mode propio.

La configuración fresh arranca en `bypassPermissions` con el aviso de modo peligroso preaceptado. Las reglas `deny` bloquean en todos los modos y las `allow` no tienen efecto en bypass. `Read`/`Edit` deny cubren las tools de archivo, los comandos de shell que Claude reconoce y las redirecciones; no cubren un proceso que abre archivos por su cuenta ni un `grep -r` desde el directorio. Un deny no admite excepción posterior, así que las variantes de `.env` se enumeran para no bloquear `.env.example`. Lectores no reciben Bash/escritura/delegación y escritores no subdelegan; verificar la carga efectiva en el host.

Engram usa plugin y MCP oficiales, no hooks Stack de lifecycle/worktree. Stack ya no repara Git automáticamente ni afirma solución universal upstream. Revisar Git explícitamente si ocurre un fallo. Chrome/cuenta compatibles pertenecen a Claude; Stack no instala browser extra. El catálogo SDK no acredita acceso a modelos. [Permisos](permissions.md) · [Modelos](models.md).
