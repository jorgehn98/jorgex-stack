# Límites conocidos de la integración con Claude Code

Decisiones deliberadas, **no bugs**. Cada punto es un límite del propio Claude Code
(no del stack); se documentan aquí para que una auditoría futura no los vuelva a
descubrir como si fueran fallos. Revisados y aceptados el 2026-06-19.

---

## 1. `git push --force` en `ask` es best-effort para el agente principal

**Qué.** La regla `Bash(git push --force:*)` de `stack/config/defaults.json` (bloque
`claude-code.permissions.ask`) **no** captura `git push origin main --force` cuando
`--force` va al final del comando.

**Por qué.** El matching de permisos de Claude Code es por prefijo **posicional**:
`Bash(<prefijo>:*)` solo casa lo que empieza por ese prefijo. No existe ningún patrón
de permiso que cace `--force` en cualquier posición.

**Mitigación existente.**
- En los subagentes full-bash (`implementer`, `tester`, `translator`),
  `stack/scripts/block-destructive-git.cjs` (hook `PreToolUse`, exit 2) sí detecta
  `--force` / `-f` / refspec `+` en cualquier posición y tras opciones globales de git.
- El agente principal lo pilota el humano, y la branch protection de GitHub rechaza el
  force-push a ramas protegidas (donde está el daño real: reescribir la historia).

**Por qué se deja así.** No se puede arreglar con permisos (matching posicional). Un hook
`PreToolUse` global para el agente principal contradice el diseño del stack —el agente
principal no se restringe— y el daño irreversible ya lo cubre GitHub.

---

## 2. El guardrail del lifecycle de PR se evalúa en cada comando Bash/PowerShell

**Qué.** El matcher del hook en `stack/hooks/hooks.json` es `Bash|PowerShell`. El filtro
real por `gh pr create` y `gh pr ready` lo hace el propio
`stack/scripts/post-pr-review.cjs`, que sale en `exit 0` cuando el comando no aplica. El
nombre histórico del script se conserva para que `sync` actualice la entrada existente sin
dejar un hook huérfano en la configuración del usuario.

**Por qué.** Claude Code no tiene filtro nativo por *contenido* del comando en el matcher
(la extensión `x-command-includes` del formato canónico solo la aplica el puente de
OpenCode; en Claude Code y Codex se omite y filtra el script).

**Coste.** Arrancar `node` una vez por comando shell (~ms), no bloqueante.

**Por qué se deja así.** El campo `if:` (Claude Code v2.1.85+) afinaría el disparo, pero su
matching también es posicional: perdería casos como `cd x && gh pr create --draft` o
`cd x && gh pr ready 123`, que el filtro del script sí captura. Afinarlo lo haría **menos**
correcto, y rompería la abstracción canónica multi-runtime.

---

## 3. Los hooks se renderizan en shell-form en Windows

**Qué.** Los hooks se escriben como `command: "node \"<ruta>\""` (shell-form), no en
exec-form (`command: "node"`, `args: [...]`). Aplica tanto al hook de `settings.json`
(lifecycle de PR) como al hook `PreToolUse` del frontmatter de los subagentes (git-guard).

**Por qué.** Es el formato canónico único que comparten los tres runtimes (Claude Code,
Codex, OpenCode); ver `src/lib/hooks-format.ts`.

**Riesgo.** Depende de que `node` esté en el `PATH` del shell que Claude Code use en
Windows. En la práctica, `node "<ruta>"` es shell-agnóstico (funciona en Git Bash, cmd y
PowerShell) mientras `node` esté en el `PATH` del sistema.

**Por qué se deja así.** Pasar a exec-form es un refactor multi-runtime (`hooks-format.ts`
+ el render del frontmatter en los tres adapters) por un caso —`node` fuera del `PATH`—
que no se da entre el público objetivo: quien usa `gh pr create`/`gh pr ready` ya tiene Git for Windows
(y por tanto Git Bash) instalado.

---

> Si alguno de estos límites produce un síntoma real (un force-push que se cuela, lag
> perceptible tras cada comando, o un hook que no corre en Windows), reabrir la decisión
> con la evidencia concreta. Hasta entonces, optimizarlos sería añadir complejidad o
> fricción sin reducir un riesgo demostrado.
