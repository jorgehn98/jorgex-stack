# JorgeX Stack

Harness multi-agente portable: una sola fuente de configuración — agentes, skills, hooks, memoria persistente ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs y system prompt — instalable con un comando en **Claude Code**, **Codex CLI** y **OpenCode**.

> Inspirado en [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), reconstruido para el stack JorgeX.

```
pnpm dlx jorgex-stack          # instala (interactivo: elige runtimes, componentes y modelos)
pnpm dlx jorgex-stack sync     # re-aplica la config (idempotente)
pnpm dlx jorgex-stack update   # actualiza stack + terceros (Engram, skills upstream)
pnpm dlx jorgex-stack doctor   # verifica que todo está sano
```

## Estado

🚧 **En desarrollo — fase F0 (scaffold).** El diseño completo, las decisiones y el roadmap están en [PRD.md](PRD.md).

## Desarrollo

Requisitos: Node ≥ 20 y pnpm (nunca npm).

```
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck
pnpm cli --help
```
