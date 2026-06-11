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
node dist/cli.js update     # interactivo: scan stack/Engram/skills, multiselect, diff/confirm
                             # Con --check: solo informe sin cambios
                             # Con --yes: modo batch (solo informe)
node dist/cli.js restore    # restaura un backup
node dist/cli.js uninstall  # desinstala lo nuestro y conserva lo del usuario (Engram intacto)
```

Publicado en npm será `pnpm dlx jorgex-stack <comando>`.

Todo comando soporta `--dry-run`, `--yes` y `--target-dir <dir>` (pruebas sin tocar la config real). Las escrituras llevan backup automático y verificación de idempotencia; el merge en configs de usuario es quirúrgico (secciones marcadas en markdown, upsert en JSON/TOML) — lo tuyo no se toca jamás.

### Update: flujo interactivo

`update` gestiona tres fuentes:

1. **Stack** (jorgex-stack): detecta si es clon git o instalación global, oferece actualización con confirmación.
2. **Engram** (binario): detecta la versión instalada, ofrece actualización con **canal nativo** (brew → `go install` → URL releases). No hace falta parar nada: igual que el upstream en macOS/Linux, los procesos vivos siguen con la versión antigua hasta reiniciar los clientes; en Windows el `.exe` en uso se rota por rename antes de instalar. **Backup automático de la DB antes de actualizar**. La base de datos y las memorias jamás se tocan.
3. **Skills vendorizadas**: detecta cambios en los upstream registrados en `upstreams.json`, descarga el upstream a temporal, **muestra diff obligatorio** y solicita confirmación. Las skills con cambios locales (`modified: true`) alertan y exigen doble confirmación.

Uso:
- `update --check`: scan de versiones sin aplicar cambios.
- `update` (TTY, sin `--yes`): multiselect interactivo con diffs visibles y confirmaciones paso a paso.
- `update --yes` o sin TTY: se comporta como `--check` (solo informe).

Autenticación con GitHub: las consultas usan `GH_TOKEN`/`GITHUB_TOKEN` del entorno o, si no existen, el token de tu sesión de `gh` CLI (`gh auth token` — solo lectura local, nunca se loguea ni persiste). Sin token, GitHub limita las consultas en paralelo y algunos upstreams pueden salir como "sin conexión".

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
