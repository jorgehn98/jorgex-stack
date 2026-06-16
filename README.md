# JorgeX Stack

Harness multi-agente portable: una sola fuente de configuración — 15 agentes, 18 skills, hooks, memoria persistente ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs y system prompt — instalable con un comando en **Claude Code**, **Codex CLI** y **OpenCode**.

> Inspirado en [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), reconstruido para el stack JorgeX.

## Uso

Instalación y uso vía npm (no requiere clonar el repo):

```
pnpm dlx jorgex-stack install    # interactivo: elige runtimes y confirma
pnpm dlx jorgex-stack models     # picker de modelos por runtime y tier (strong/standard/cheap)
pnpm dlx jorgex-stack sync       # re-aplica la config (idempotente; limpia huérfanos)
pnpm dlx jorgex-stack doctor     # verifica que todo está sano (Engram, drift, hooks, keys)
pnpm dlx jorgex-stack update     # interactivo: scan stack/Engram/skills, multiselect, diff/confirm
                                 # Con --check: solo informe sin cambios
                                 # Con --yes: modo batch (solo informe)
pnpm dlx jorgex-stack restore    # restaura un backup
pnpm dlx jorgex-stack uninstall  # desinstala lo nuestro y conserva lo del usuario (Engram intacto)
```

En desarrollo (desde un clon), los mismos comandos van por `pnpm cli <comando>` (ver [Desarrollo](#desarrollo)).

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

CLI completo y migración real ejecutada (F6); el stack es la única fuente de configuración. Las versiones se publican automáticamente en [npm](https://www.npmjs.com/package/jorgex-stack) según el flujo descrito en [Publicación](#publicación). El diseño, las decisiones (D1–D9) y el roadmap están en [PRD.md](PRD.md).

## Publicación

La release la dispara el push/merge a `main` y la ejecuta GitHub Actions. No se usa `pnpm publish` ni hace falta login de npm:

- **Patch automático**: si el push a `main` contiene cambios publicables y la versión actual de `package.json` ya está en npm, el workflow hace bump patch (`1.0.x` → `1.0.(x+1)`), commitea `chore(release): bump version to v…` y publica. Sin intervención.
- **Sin release**: cambios solo en `work/`, `worktrees/`, tests o archivos no listados como publicables (`src/`, `stack/`, `upstreams.json`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsup.config.ts`, `README.md`, `PRD.md`) no generan release.
- **Minor y major manuales**: bump explícito de `package.json` en el PR (el workflow detecta que el siguiente patch ya existe en npm y exige el bump).
- **OIDC / trusted publishing**: el workflow usa `id-token: write` y el `registry-url` de `setup-node`. No hay `NPM_TOKEN` ni `NODE_AUTH_TOKEN` en ningún secreto. La única excepción a la regla "pnpm siempre" es `npm publish` aquí, por compatibilidad del registry.

Los detalles de diseño están en [PRD §7.6](PRD.md#76-publicación-automática-en-npm).

## Desarrollo

Requisitos: Node ≥ 20 y pnpm (nunca npm).

```
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck
pnpm test         # vitest
pnpm cli --help
```
