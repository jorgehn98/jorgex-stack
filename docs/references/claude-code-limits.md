# Límites de Claude Code

Claude consume subagentes nativos y enlaces a la biblioteca común de skills. No se acreditó lectura directa de `~/.agents/skills`, por eso Stack crea un enlace por skill desde su ruta nativa, sin duplicar contenido ni tocar skills ajenas.

Para instrucciones globales se usa `~/.agents/AGENTS.md` y un puente mínimo `@…` en `~/.claude/CLAUDE.md`. El AGENTS.md de proyecto no equivale a cargar automáticamente un AGENTS.md global; no borrar instrucciones ajenas al crear el puente. Los marcadores ambiguos o archivo ilegible bloquean. No hay output-style/mode propio.

Reglas Bash son posicionales: `Bash(git push --force:*)` no cubre todas las posiciones de `--force`. Ask genérico de Bash y protecciones del repo son mitigaciones, no una prueba de control exhaustivo. Lectores no reciben Bash/escritura/delegación y escritores no subdelegan; verificar la carga efectiva en el host.

Engram usa plugin y MCP oficiales, no hooks Stack de lifecycle/worktree. Stack ya no repara Git automáticamente ni afirma solución universal upstream. Revisar Git explícitamente si ocurre un fallo. Chrome/cuenta compatibles pertenecen a Claude; Stack no instala browser extra. El catálogo SDK no acredita acceso a modelos. [Permisos](permissions.md) · [Modelos](models.md).
