// Barrera de git destructivo para subagentes full-bash (implementer, tester,
// translator). El agente principal (orchestrator/primary) NO se restringe.
// OpenCode lo aplica nativo (permission.bash, deny por patrón); Claude Code vía
// un hook PreToolUse por-subagente (no tiene deny de comandos por-agente). Codex
// solo recibe la línea de refuerzo en el cuerpo del agente (sin barrera nativa).

/**
 * Patrones glob de git destructivo a denegar en OpenCode. OpenCode evalúa por
 * orden y gana la última regla que matchea, así que el adapter emite "*" : allow
 * PRIMERO y estos deny DESPUÉS.
 *
 * OpenCode solo tiene globs por prefijo: no puede saltar opciones globales ni
 * tokenizar como el hook de Claude Code. Por eso `git -C <dir> reset` o un `git
 * checkout HEAD -- .` se le escapan; la línea de refuerzo en el cuerpo del
 * agente es el backstop real en OpenCode. El `.cjs` (Claude Code) sí es robusto.
 */
export const DESTRUCTIVE_GIT_DENY = [
  "git reset*",
  "git clean*",
  "git checkout -- *",
  "git restore*",
  "git push*--force*", // posición libre: caza "git push origin main --force[-with-lease]"
  "git push -f*",
  "git switch*--discard-changes*",
] as const;

/** Script guard (PreToolUse de Claude Code) que bloquea git destructivo en subagentes. */
export const GIT_GUARD_SCRIPT = "block-destructive-git.cjs";
