# JorgeX Stack

Harness multi-agente portable: una sola fuente de configuración — 15 agentes, 18 skills, hooks, memoria persistente ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs y system prompt — instalable con un comando en **Claude Code**, **Codex CLI** y **OpenCode**.

> Inspirado en [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), reconstruido para el stack JorgeX.

## Uso

Hasta la publicación en npm, desde un clon del repo:

```
pnpm install && pnpm build

node dist/cli.js install    # interactivo: elige runtimes y confirma
node dist/cli.js models     # picker de modelos por runtime y tier (strong/standard/cheap)
node dist/cli.js sync       # re-aplica la config (idempotente; limpia huérfanos)
node dist/cli.js doctor     # verifica que todo está sano (Engram, drift, hooks, keys)
node dist/cli.js update     # comprueba releases de Engram, del stack y skills vendorizadas
node dist/cli.js restore    # restaura un backup
node dist/cli.js uninstall  # desinstala lo nuestro y conserva lo del usuario (Engram intacto)
```

Publicado en npm será `pnpm dlx jorgex-stack <comando>`.

Todo comando soporta `--dry-run`, `--yes` y `--target-dir <dir>` (pruebas sin tocar la config real). Las escrituras llevan backup automático y verificación de idempotencia; el merge en configs de usuario es quirúrgico (secciones marcadas en markdown, upsert en JSON/TOML) — lo tuyo no se toca jamás.

## Estado

**v0.6.0 — CLI completo y migración real ejecutada (F6).** El diseño, las decisiones (D1–D9) y el roadmap están en [PRD.md](PRD.md).

## Desarrollo

Requisitos: Node ≥ 20 y pnpm (nunca npm).

```
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck
pnpm test         # vitest
pnpm cli --help
```
