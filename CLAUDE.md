# JorgeX Stack

Harness multi-agente portable: una fuente canónica de configuración (agentes, skills, hooks, memoria Engram, MCPs, system prompt) + un CLI en TypeScript que la instala, sincroniza y actualiza en **Claude Code**, **Codex CLI** y **OpenCode**.

**`PRD.md` es la fuente de verdad del proyecto. Léelo antes de cualquier cambio no trivial.** Las decisiones cerradas (D1–D9) están en PRD §3 y no se re-discuten sin Jorge.

## Reglas duras (no negociables)

1. **pnpm siempre, nunca npm** — desarrollo, scripts, y cualquier instalación que ejecute el CLI (`pnpm dlx`, `pnpm add`).
2. **Cero secretos en el repo**: ninguna key/token en código, ejemplos, tests o fixtures. Los únicos MCPs del stack son `engram` (sin key) y `context7` (placeholder vacío; cada usuario conecta su cuenta).
3. **El Engram del usuario es intocable**: el instalador detecta binario/DB existentes y los respeta. Nunca reinstalar, migrar ni tocar la base de datos. Update del binario solo con confirmación explícita. Upstream: https://github.com/Gentleman-Programming/engram
4. **No tocar `C:\Users\jorge\Desktop\jorgex-custom-tools`** hasta la fase F6: sus plugins se COPIAN a `stack/plugins/opencode/`, los originales siguen en uso.
5. **Merge idempotente**: toda escritura en configs de usuario va dentro de secciones marcadas (`<!-- jorgex:seccion -->` en markdown, upsert quirúrgico en JSON/TOML). Backup automático antes de escribir. Re-ejecutar `sync` dos veces = cero cambios.
6. **Sin switches por runtime en `src/components/`**: toda variación entre Claude Code / Codex / OpenCode vive en su adapter (`src/adapters/`). Añadir un runtime = añadir un adapter, sin tocar componentes.

## Arquitectura

```
stack/      → fuente canónica: lo que se instala (agentes, skills, hooks, mcp, system-prompt, plugins)
src/
  cli.ts      → entrypoint: install | sync | models | update | doctor | restore | uninstall
  adapters/   → uno por runtime: declara DÓNDE (rutas) y CÓMO (estrategias/formatos)
  components/ → uno por componente: QUÉ se instala, agnóstico del runtime
  lib/        → filemerge (marcadores/upserts), backup, detect, download (SHA256 fail-closed)
upstreams.json → terceros gestionados por `update` (engram, skills open-source) con fuente y versión
```

Mapeo de formatos por runtime: PRD §6 (tabla). Modelos: tiers `strong|standard|cheap` resueltos con picker por runtime (PRD §6.1) — Claude Code solo alias Claude (`fable`/`opus`/`sonnet`/`haiku`), Codex solo OpenAI, OpenCode lista en vivo de `opencode models`. La elección del usuario va a `model-map.json` local, nunca al repo.

## Comandos

```
pnpm install        # dependencias
pnpm build          # tsup → dist/
pnpm typecheck      # tsc --noEmit
pnpm cli <cmd>      # ejecutar el CLI local (node dist/cli.js)
```

## Estilo

- Simplicidad máxima: la solución más simple gana; nada de abstracciones para requisitos que no existen.
- Código e identificadores en inglés; docs y comunicación con Jorge en español.
- Commits locales solo cuando Jorge lo pida. Nunca push sin petición explícita.

## Estado

- ✅ F0: PRD + scaffold + git init
- ✅ F1: fuente canónica en `stack/` — 15 agentes portados (frontmatter canónico tier/readonly/bash + result contract + deslindes), AGENTS.md + engram-protocol.md (única fuente del protocolo), hooks.json + post-pr-review.cjs (payload dual Claude/OpenCode), commands, mcp/servers.json, 18 skills vendorizadas (16 third-party con upstream en upstreams.json; solo agent-delegation y work-lifecycle son propias), work-lifecycle reescrita memory-first (D9), 3 plugins opencode vendorizados (copia fiel; rutas personales a parametrizar en F2: engram.ts:23, hooks.ts:76-78/299-300, worktree.ts:63-64/97-99, package.json main desactualizado)
- ✅ F2: CLI core funcional — lib (paths/fsx/filemerge/detect/backup/model-map/canonical), adapter OpenCode completo, 7 components agnósticos, pipeline detect→plan→diff→backup→apply→verify con verificación de idempotencia automática, CLI real (install/sync/models/restore; --target-dir para pruebas). Verificado e2e: 120 archivos a dir temporal, 2ª pasada 0 cambios, key de usuario/claves propias/contenido manual preservados. 12 tests vitest. Repo público: https://github.com/jorgehn98/jorgex-stack
- ✅ F3: adapter Claude Code — 14 subagentes a ~/.claude/agents (readonly → allowlist Read/Grep/Glob[+Bash] + tools de memoria engram; sin restricción → hereda todo; agente engram solo lectura de memoria), orchestrator como slash command /orchestrator (los subagentes de Claude Code no pueden lanzar subagentes), commands con {{input}}→$ARGUMENTS, hooks upsert en settings.json (sin duplicar, identificados por matcher+script), MCP user-scope en ~/.claude.json (sibling del configDir → --target-dir nunca toca el real), CLAUDE.md con secciones marcadas. e2e: 117 archivos, idempotente, preservación de hooks/claves del usuario verificada. 17 tests.
- ✅ F4: adapter Codex — 14 subagentes a ~/.codex/agents/*.toml (developer_instructions en literal multiline ''', sandbox read-only/workspace-write por readonly, model_reasoning_effort por tier, model omitido si "default"), orchestrator como profile ~/.codex/orchestrator.config.toml (codex --profile orchestrator) + skill, commands→skills en ~/.agents/skills (custom prompts deprecados; dir compartido con OpenCode, derivado del padre del configDir para que --target-dir no toque el real), hooks.json con matcher shell + aviso de trust manual /hooks (helper compartido lib/hooks-format.ts con Claude Code), MCP por upsert TOML quirúrgico (lib/filemerge.ts upsertTomlSection: preserva comentarios, secciones ajenas y keys del usuario). post-pr-review.cjs tolera tool_name shell/local_shell y command como array. e2e: 118 archivos idempotentes, preservación de config.toml verificada. 27 tests.
- ✅ F5: CLI completo — uninstall (borra lo nuestro + unmerge de archivos compartidos vía planUnmerge por adapter + removeMarkdownSection/removeTomlSection/removeNativeHooks; e2e: solo queda lo del usuario), doctor (engram + drift por runtime + trust codex + key context7), update --check (GitHub API: detecta release nueva de engram; npm registry para el stack; skills modified listadas para diff manual), picker de modelos interactivo (OpenCode: lista en vivo de `opencode models`; Claude: alias; Codex: default/ID), install interactivo (multiselect de runtimes + confirm), paquete npm listo (LICENSE MIT, repository, prepublishOnly). 38 tests incl. paridad de los 15 agentes entre los 3 adapters. PENDIENTE de Jorge: `pnpm publish --access public` (requiere su login npm). Auto-update de skills desde upstream → backlog v1.x.
- ⏳ F6: migración final — eliminar plugins de jorgex-custom-tools, desinstalar config legacy de ~/.config/opencode, reinstalar TODO desde el stack
- Roadmap completo: PRD §11
