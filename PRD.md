# PRD — JorgeX Stack

> Harness multi-agente portable: una sola fuente de configuración (agentes, skills, hooks, memoria Engram, MCPs, system prompt) instalable con un comando en **Claude Code**, **Codex CLI** y **OpenCode**.

**Estado**: v0 — documento vivo. Última actualización: 2026-06-09.

---

## 1. Problema

La config actual vive solo en `C:\Users\jorge\.config\opencode` y tiene estos problemas:

1. **Atada a OpenCode**: 15 agentes, 18 skills, plugins de Engram/hooks y el system prompt no sirven en Claude Code ni Codex sin porte manual.
2. **Dependencias frágiles**: `hooks.ts` y `photo-heart-worktree.ts` son re-exports a rutas locales (`file:///C:/Users/jorge/Desktop/jorgex-custom-tools/...`) que no existen en otra máquina.
3. **Sin gestión de terceros**: Engram (Gentleman-Programming) y varias skills open-source no tienen tracking de versión ni vía de actualización.
4. **Sin instalación reproducible**: montar este setup en otra máquina (o restaurarlo) es trabajo manual.
5. **Secretos en claro**: `opencode.json` tiene API keys hardcodeadas (Context7, Hostinger) — inaceptable en un repo versionado.

## 2. Visión

Lo mismo que hace [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) pero con el stack de Jorge: un repo único con la config canónica + un CLI que la **instala, sincroniza y actualiza** en los tres runtimes, adaptando formatos automáticamente.

```
pnpm dlx jorgex-stack          → TUI: detecta agentes instalados, eliges uno/varios/los 3, instala
pnpm dlx jorgex-stack sync     → re-aplica la config (idempotente)
pnpm dlx jorgex-stack update   → actualiza stack + terceros (Engram, skills upstream)
pnpm dlx jorgex-stack doctor   → verifica que todo está sano
```

## 3. Decisiones tomadas (cerradas con Jorge, 2026-06-09/10)

| # | Decisión | Elección |
|---|----------|----------|
| D1 | Tecnología del instalador | **TypeScript + Node (≥20)**, bundle único (tsup/esbuild), prompts con `@clack/prompts`, publicado en el registry npm y ejecutado con `pnpm dlx jorgex-stack`. Sin Go, sin binarios propios. |
| D2 | Plataformas | **Cross-platform desde v1** (Windows + macOS + Linux). Windows es el entorno principal de pruebas. |
| D3 | Estrategia de despliegue | **Merge idempotente con marcadores** (`<!-- jorgex:seccion -->` en markdown, upsert quirúrgico en JSON/TOML). Backup automático antes de tocar nada + rollback. Nunca machaca contenido manual del usuario. |
| D4 | Plugins de jorgex-custom-tools | Se **copian** al nuevo repo ahora (los originales NO se tocan porque están en uso). **Cuando el proyecto esté completo e instalado**: se eliminan de `C:\Users\jorge\Desktop\jorgex-custom-tools` y pasan a vivir/instalarse SOLO desde JorgeX Stack. Ver §11 F6. |
| D5 | MCPs incluidos | Solo **engram** (local, sin key) y **context7** (placeholder vacío: cada usuario conecta su cuenta/key al instalar o después). Hostinger eliminado. **Ninguna key personal de la config actual de Jorge pasa a este proyecto, jamás.** |
| D6 | Selección de modelos | Por runtime, en el install: Claude Code ofrece solo modelos Claude (alias auto-actualizables: `fable`/`opus`/`sonnet`/`haiku`), Codex solo OpenAI, OpenCode **detecta y ofrece todos los que el usuario tenga conectados** (`opencode models`). Ver §6.1. |
| D7 | Engram existente | La instalación de Engram (binario + **base de datos de memorias en `~/.engram`**) es **intocable en TODOS los flujos**: `install`/`sync` solo detectan y registran (jamás reinstalan, migran ni escriben en la DB); `update` solo INFORMA de releases (actualizar el binario es acción del usuario); `uninstall` **conserva por defecto** todo lo de Engram (registro MCP, plugin engram.ts) — desregistrarlo exige el sí explícito (`--remove-engram` o confirmación interactiva con default No), y ni con eso se tocan binario o DB. Repo upstream: https://github.com/Gentleman-Programming/engram |
| D8 | Gestor de paquetes | **pnpm siempre, nunca npm** — desarrollo, scripts, instalación de dependencias y cualquier instalación que haga el CLI (`pnpm dlx`, `pnpm add -g`). |
| D9 | work/ vs Engram | **Una sola casa por artefacto, cero duplicación** (v2, 2026-06-11): `work/{nombre}/` (gitignorada, SOLO trabajo en curso) contiene `PRD.md` + `plan.md` — el plan es el único tablero de estado (edits quirúrgicos). Engram guarda lo que consumen los agentes y el historial: spec completa de cada tarea (`work/{nombre}/task/{NN}`, el subagente recibe topic_key + título), resultados de fase (`work/{nombre}/{fase}`), cierre (`work/{nombre}/done`) y el backlog del proyecto en la clave ÚNICA `work/backlog`. Al cerrar: PRD a `docs/` solo si tiene valor duradero y la carpeta se borra. Sin `1-TODOs/` ni `3-finalized/`. Ver §9.11. |

## 4. Objetivos

1. Un comando instala la config completa (o por componentes) en Claude Code, Codex y/u OpenCode, a elección.
2. Fuente canónica única: cada agente/skill/hook se define UNA vez; los adapters generan el formato de cada runtime.
3. Paridad funcional con el setup actual de OpenCode (no perder nada en la migración).
4. Engram funcionando en los tres runtimes (MCP + protocolo de memoria + captura pasiva donde sea posible).
5. Hooks funcionando en los tres (nativos en Claude Code y Codex; plugin puente en OpenCode).
6. `update` gestiona: el propio stack, el binario de Engram y las skills de terceros (con fuente y versión registradas).
7. Mejorar el harness actual, no solo portarlo (ver §9).

### No-objetivos (v1)

- Soportar más runtimes (Cursor, Gemini CLI, etc.) — la arquitectura adapter lo deja abierto para v2.
- TUI elaborada tipo Bubbletea — prompts simples de clack bastan.
- Self-update agresivo en cada invocación (decisión consciente contra el default de gentle-ai): `update --check` manual o aviso no bloqueante.
- Skill registry con cache por fingerprint (idea buena de gentle-ai → backlog v1.x).
- Instalación scope-proyecto (v1 solo global/usuario; proyecto en v2).

## 5. Arquitectura del repo

```
JorgeX Stack/
├── PRD.md
├── README.md
├── package.json                 # bin: jorgex-stack
├── stack/                       # ══ FUENTE CANÓNICA (lo que se instala) ══
│   ├── system-prompt/
│   │   └── AGENTS.md            # system prompt global (hoy: ~/.config/opencode/AGENTS.md, mejorado)
│   ├── agents/                  # 15 agentes en formato canónico (md + frontmatter propio)
│   │   ├── orchestrator.md
│   │   ├── backend-analyst.md … type-design-analyzer.md
│   ├── skills/                  # TODAS las skills vendorizadas (terceros con upstream registrado en upstreams.json)
│   ├── commands/                # xreview.md (formato canónico)
│   ├── hooks/
│   │   └── hooks.json           # definición canónica de hooks (formato Claude Code como base)
│   ├── scripts/
│   │   └── post-pr-review.cjs
│   ├── mcp/
│   │   └── servers.json         # manifiesto MCP canónico (env refs, SIN secretos)
│   └── plugins/
│       └── opencode/            # engram.ts, hooks-bridge.ts, worktree.ts (solo OpenCode)
├── upstreams.json               # terceros: fuente, versión instalada, método de update
├── src/                         # ══ CLI ══
│   ├── cli.ts                   # entrypoint: install | sync | update | doctor | uninstall | restore
│   ├── adapters/
│   │   ├── types.ts             # interface Adapter (rutas + estrategias por runtime)
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   └── opencode.ts
│   ├── components/              # lógica por componente, agnóstica del runtime
│   │   ├── system-prompt.ts  agents.ts  skills.ts  commands.ts
│   │   ├── hooks.ts  mcp.ts  engram.ts  plugins.ts
│   ├── lib/
│   │   ├── filemerge.ts         # merge por marcadores (md) + upsert JSON/JSONC/TOML
│   │   ├── backup.ts            # snapshot tar.gz con retención + restore
│   │   └── detect.ts            # qué runtimes hay instalados (binario en PATH + dir config)
│   └── …
└── tests/                       # unit (filemerge, adapters) + paridad entre runtimes
```

**Patrón central (de gentle-ai)**: `Adapter` por runtime declara *dónde* (rutas) y *cómo* (estrategias: merge de system prompt, formato de agentes, sintaxis MCP…). Los componentes iteran (componente × runtime) sin un solo `switch`. Añadir un runtime nuevo = un archivo adapter.

**Pipeline de instalación**: detect → selección → plan (dry-run visible) → **backup** → aplicar componentes → verificar → (si falla) rollback.

## 6. Mapeo por runtime

| Componente | Canónico | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|---|
| System prompt | `stack/system-prompt/AGENTS.md` | sección con marcadores en `~/.claude/CLAUDE.md` | sección en `~/.codex/AGENTS.md` | sección en `~/.config/opencode/AGENTS.md` |
| Agentes (subagentes) | `stack/agents/*.md` | `~/.claude/agents/*.md` (frontmatter `name/description/tools/model`) | `~/.codex/agents/*.toml` (`developer_instructions`, `model_reasoning_effort`, `sandbox_mode`) | `~/.config/opencode/agents/*.md` (`mode/model/tools/permission`) |
| **Orchestrator (primary)** | `stack/agents/orchestrator.md` | **Output style** `~/.claude/output-styles/orchestrator.md` (modifica el system prompt del MAIN agent; se elige con `/config` y persiste) + **skill** `~/.claude/skills/orchestrator/` como activación puntual (`/orchestrator` explícito o carga implícita por description) | **Profile** `~/.codex/orchestrator.config.toml` con `developer_instructions` → `codex --profile orchestrator` + **la misma skill** en `~/.agents/skills/orchestrator/` (los commands de Codex están deprecados; skills es la vía oficial) | **Primary agent** nativo: en el ciclo de Tab junto a build/plan |
| Skills | `stack/skills/` + upstreams | copia espejo en `~/.claude/skills/` (verificado 2026-06: Claude Code NO lee `~/.agents/skills` — sigue agentskills.io solo en formato) | **`~/.agents/skills/`** (estándar agentskills.io — NO `~/.codex/skills`) | **misma copia que Codex**: lee `~/.agents/skills/` global nativo (verificado en código fuente; si una skill existe también en `~/.config/opencode/skills/` esa gana — F6 limpia las legacy de ahí) |
| Commands | `stack/commands/*.md` | `~/.claude/commands/*.md` | como skills (`~/.codex/prompts/` está deprecated) | `~/.config/opencode/commands/*.md` |
| Hooks | `stack/hooks/hooks.json` | merge en `~/.claude/settings.json` → clave `hooks` | `~/.codex/hooks.json` (⚠ requiere trust manual vía `/hooks`) | **plugin puente** `hooks-bridge.ts` (OpenCode no tiene hooks declarativos) |
| MCP | `stack/mcp/servers.json` | `claude mcp add --scope user` o merge en `~/.claude.json` | bloques `[mcp_servers.x]` upsert en `~/.codex/config.toml` | clave `mcp` upsert en `opencode.json` (`command` es **array**, `environment` no `env`) |
| Engram | binario Go + MCP + protocolo | MCP user-scope + protocolo en sección de CLAUDE.md | MCP en config.toml + protocolo en AGENTS.md | MCP + plugin `engram.ts` completo (captura pasiva, compaction, inyección) |
| Plugins TS | `stack/plugins/opencode/` | n/a (funcionalidad cubierta por hooks nativos) | n/a (ídem) | `~/.config/opencode/plugins/` |

**Notas de skills**: una sola copia física en `~/.agents/skills/` sirve a Codex y OpenCode; para Claude Code el instalador mantiene copia espejo en `~/.claude/skills/` (sin symlinks: en Windows requieren Developer Mode). `sync` mantiene ambas alineadas. Frontmatter común seguro: `name` + `description` (extensiones de Claude como `context: fork` solo en la copia de Claude).

### 6.1 Modelos: tiers canónicos + picker por runtime

La config actual referencia modelos vía OpenCode multi-provider (`openai/gpt-5.4`, `minimax/MiniMax-M3`). Eso no es portable. El formato canónico asigna a cada agente un **tier** (`strong | standard | cheap`) y el install resuelve cada tier a un modelo concreto **por runtime, con un picker**:

| Runtime | Qué ofrece el picker | ¿Se actualiza solo? |
|---|---|---|
| Claude Code | Solo modelos Claude: alias `fable` / `opus` / `sonnet` / `haiku` / `inherit` (+ ID concreto opcional). `fable` es el nivel nuevo por encima de opus (Fable 5, `claude-fable-5`, 2026) | **Sí** — los alias apuntan siempre al modelo más reciente de cada familia; cuando Anthropic añade una familia nueva (como fable) basta re-ejecutar `jorgex-stack models` |
| Codex | Solo OpenAI: `default` (omitir `model` → usa el default vigente del CLI) o ID concreto + `model_reasoning_effort` (high/medium/low) por tier | **Solo si usas `default`** — el CLI lo actualiza con sus releases. Un ID fijado es manual: se cambia re-ejecutando el picker (`jorgex-stack models`) |
| OpenCode | **Todos los modelos que el usuario tenga conectados**, detectados en vivo con `opencode models` (registry models.dev, verificado en la máquina de Jorge) | **Sí** — la lista refleja providers/modelos conectados en el momento de instalar; nuevos modelos aparecen al re-ejecutar el picker |

- Defaults sensatos pre-seleccionados por tier (strong → análisis/review/seguridad/orchestrator; standard → implementer/tester; cheap → translator/docs/comments/engram), confirmables con Enter.
- La elección se guarda en `model-map.json` (local del usuario, no en el repo) y `sync` la respeta.
- Comando dedicado `jorgex-stack models` para re-escoger sin reinstalar.

**Regla del orchestrator (cerrada con Jorge, 2026-06-10)**: el orchestrator es SIEMPRE un modo del agente principal que el usuario pilota — **nunca un subagente que se invoca**. OpenCode lo soporta nativo (primary + Tab). En Claude Code y Codex, que no tienen primary seleccionable, se instalan dos vías generadas de la misma fuente canónica: (a) el **modo persistente** — output style en Claude Code (`/config`), profile en Codex (`codex --profile orchestrator`, `developer_instructions`); y (b) la **skill `orchestrator`** para activación puntual dentro de una sesión — elegida frente al command porque una misma SKILL.md sirve en ambos runtimes (estándar agentskills.io), permite invocación explícita (`/orchestrator` · `$orchestrator`) e implícita por description, y los custom prompts de Codex están deprecados. Verificado contra docs y código (openai/codex): no hay modos custom seleccionables en caliente en ninguno de los dos; si los añaden, se migra a eso.

## 7. Componentes en detalle

### 7.1 Hooks — la pieza con más fricción

- **Formato canónico**: el de Claude Code (`hooks.json` con eventos `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`…). Codex usa un formato casi idéntico (mismos eventos núcleo, añade `commandWindows` para Windows — lo usamos).
- **Claude Code**: merge en `settings.json`. Nativo.
- **Codex**: escribir `~/.codex/hooks.json`. ⚠ Los hooks no-managed exigen aprobación manual con `/hooks` — el instalador no puede activarlos solo. `doctor` lo detecta y lo recuerda.
- **OpenCode**: no hay hooks declarativos → `hooks-bridge.ts` (evolución del `hooks.ts` actual): plugin que lee el `hooks.json` canónico y traduce eventos (`PostToolUse` + matcher bash → `tool.execute.after`, `Stop` → `session.idle`, `SessionStart` → init del plugin).
- **Hook actual a portar**: post-`gh pr create` → ejecuta `post-pr-review.cjs` (routing ligero de subagentes de review sobre `git diff BASE...HEAD`). Debe funcionar igual en los tres.

### 7.2 Engram

- Binario Go de Gentleman-Programming ([repo](https://github.com/Gentleman-Programming/engram)). Sirve CLI + MCP server (`engram mcp --tools=agent`). **El binario y los datos van separados**: el binario donde lo instale el método elegido (brew · `go install` → `~/go/bin` · zip de Releases) y los DATOS siempre en `~/.engram/engram.db` (override: `ENGRAM_DATA_DIR`) — esa carpeta es la que D7 protege.
- **Integración oficial por runtime (verificado 2026-06)**: Engram trae `engram setup <agent>` (claude-code, codex, opencode…) y un plugin de marketplace oficial SOLO para Claude Code (`claude plugin marketplace add Gentleman-Programming/engram` + `claude plugin install engram`: MCP + hooks de sesión + skill memory). En OpenCode, `engram setup opencode` escribe el plugin `engram.ts` (el que este stack vendoriza) + MCP en opencode.json; en Codex escribe `[mcp_servers.engram]` + `engram-instructions.md` + compact prompt. No publica marketplace para Codex.
- **Política del stack**: detectar la integración oficial y respetarla — si existe, NO se registra el MCP (duplicaría las tools `mem_*`) y NO se inyecta la sección `engram-protocol` en el system prompt (el plugin/setup ya inyecta el protocolo). En OpenCode la sección no se inyecta nunca: el plugin `engram.ts` que el propio stack instala la aporta en runtime (consolidación de la duplicación detectada en F1). Donde no haya integración, el stack registra el MCP básico + la sección de protocolo, y `doctor`/install sugieren `engram setup <agent>` para la integración completa.
- **Regla D7 — instalación existente intocable**: si el instalador detecta un Engram ya instalado (binario en PATH o ruta conocida, p.ej. `C:\Users\jorge\go\bin\engram.exe`, y/o base de datos existente), lo usa tal cual: registra el MCP apuntando al binario detectado y NO descarga, NO reinstala, NO migra y NO toca la DB (que en el caso de Jorge está llena de memorias en uso). Solo si NO hay Engram en la máquina: descarga release de GitHub con **SHA256 fail-closed**.
- En todos los casos: registra MCP en los runtimes elegidos → inyecta el protocolo de memoria (sección marcada) en el system prompt de cada uno.
- **Una sola fuente del protocolo**: hoy está duplicado (AGENTS.md + inyección del plugin engram.ts). Se consolida: el texto vive en `stack/system-prompt/` y se inyecta una vez por runtime. En OpenCode el plugin deja de inyectar el bloque largo (o se hace la única vía, pero no ambas).
- En OpenCode se conserva el plugin completo (captura pasiva, session resilience, compaction handling) — es la integración más rica y se mantiene.
- `update` trata Engram como tool gestionada (release de GitHub, comparación de versión), pero **solo actualiza el binario con confirmación explícita** y nunca toca la base de datos.

### 7.3 Update: política y flujo

`upstreams.json` registra cada pieza de terceros (ejemplo de formato):

```json
{
  "tools": {
    "engram": { "kind": "binary", "source": "github:Gentleman-Programming/engram", "verify": "sha256", "policy": "respect-existing — D7" }
  },
  "skills": {
    "skill-name": { "source": "github:org/repo", "commit": "...", "modified": false }
  }
}
```

**Auditoría (F1, 2026-06-10)**: las 18 skills están vendorizadas en `stack/skills/` con upstream registrado. Solo `agent-delegation` y `work-lifecycle` son propias; `tdd`, `to-prd`, `to-issues` y `diagnose` de **mattpocock/skills** tienen modificaciones locales (`modified: true`). Resto: anthropics/skills, supabase/agent-skills, vercel(-labs), kepano/obsidian-skills, millionco/react-doctor, safishamsi/graphify.

**Política de `update` (F5.x — implementada con flujo interactivo)**:

1. **`update --check`** (sin TTY o con `--yes`): compara versión local vs upstream (tags/commits de GitHub) y **solo lista** qué hay nuevo. Respeta D7 y D8: no toca nada sin confirmación explícita.

2. **`update` interactivo** (TTY + sin `--yes`): 
   - **Escanea 3 fuentes en paralelo**: stack (npm), Engram (GitHub releases), skills (commit pins en upstreams.json por repo único).
   - **Multiselect**: ofrece marcar lo actualizable (stack, Engram, skills por repo con upstream movido).
   - **Stack**: detecta clon git o instalación global; ofrece `git pull + pnpm install + pnpm build` o `pnpm add -g jorgex-stack@latest` con confirmación.
   - **Engram** (D7 reforzado): 
     * Detecta si el proceso está en ejecución (bloquea en Windows) y advierte.
     * Ofrece **backup de la DB** (`~/.engram/engram.db`) a `~/.jorgex-stack/` ANTES de actualizar el binario.
     * Usa **canal nativo** replicado: brew → `go install` → URL de releases.
     * La DB y las memorias **jamás** se tocan; solo el binario se puede actualizar con confirmación explícita.
   - **Skills**: 
     * Descarga upstream a temporal y **muestra diff SIEMPRE** (obligatorio antes de aplicar).
     * Las skills `modified: true` alertan y exigen doble confirmación (los cambios locales se sobreescriben con backup automático).
     * Reemplaza la copia vendorizada y re-pined el commit en upstreams.json.
   - **Backup automático** de `~/.jorgex-stack/manifest.json` antes de cualquier cambio.
   - **Verificación post-update**: detecta engram actualizado y reporta la nueva versión.

3. **Con `--yes` o sin TTY**: se comporta como `--check` (solo informe).

### 7.4 MCPs

Solo dos MCPs en el stack (D5):

1. **engram** — local, apunta al binario detectado. No necesita key.
2. **context7** — remoto, se instala **vacío** (sin key). Cada usuario conecta su cuenta: el instalador ofrece introducir la key opcionalmente (se escribe SOLO en la config local del runtime) o dejarlo en blanco y configurarla después. Hostinger queda fuera.

**Regla dura**: el manifiesto canónico (`stack/mcp/servers.json`) solo contiene referencias de entorno/placeholders. Ninguna key personal de la config actual de Jorge (`opencode.json`) se copia a este repo, al instalador ni a sus artefactos — ni siquiera en ejemplos, tests o fixtures. CI check de secretos en F5.

### 7.5 Scripts y plugins de jorgex-custom-tools (D4)

- `hooks.ts` (HooksPlugin) y `worktree-plugin.ts` (WorktreePlugin) de `C:\Users\jorge\Desktop\jorgex-custom-tools\plugins\hooks\src\` se **copian** a `stack/plugins/opencode/` y se adaptan (rutas relativas, sin `file:///C:/Users/jorge/...`).
- Los originales **no se tocan** mientras dure el desarrollo (están en uso).
- F6 (cierre): eliminar de jorgex-custom-tools, reinstalar todo desde JorgeX Stack.

## 8. CLI — UX

```
pnpm dlx jorgex-stack             # = install interactivo
  ✔ Detectados: OpenCode ✓  Claude Code ✓  Codex ✗ (no instalado)
  ✔ Engram existente detectado: C:\Users\jorge\go\bin\engram.exe → se respeta (D7)
  ? ¿Para qué agentes instalar? [multiselect: los detectados]
  ? Componentes: [todos | agentes, skills, hooks, engram, mcp, system-prompt…]
  ? Modelos por tier (picker por runtime, §6.1):
      Claude Code → opus / sonnet / haiku (alias)
      Codex       → default / ID + reasoning effort
      OpenCode    → lista en vivo de `opencode models`
  ? Context7: ¿key? [input / dejar vacío y conectar después]
  → Plan (dry-run) → confirmación → backup → instalación → verificación

jorgex-stack install --agents claude,opencode --components all --dry-run --yes
jorgex-stack sync                 # re-aplica config (idempotente, tras editar el repo)
jorgex-stack models               # re-escoger modelos por tier sin reinstalar
jorgex-stack update [--check]     # stack + engram (solo binario, con confirmación) + skills upstream
jorgex-stack doctor               # binarios, MCPs responden, hooks trusted (codex), engram serve vivo, versiones
jorgex-stack restore [--list]     # restaurar backup
jorgex-stack uninstall [--agents ...]   # quita solo lo nuestro (secciones marcadas + archivos propios)
```

Todo comando soporta `--dry-run` y no-interactivo (`--yes` + flags) para CI/scripts.

## 9. Mejoras al harness (no solo portar)

Detectadas en la auditoría de la config actual + ideas de gentle-ai:

1. **Orchestrator — handoff explícito**: documentar la secuencia ANALYZE → PLAN → IMPLEMENT (hoy el paso analyst → implementer queda implícito) y que el orchestrator DEBE procesar las líneas de delegación `→ [agente]: …` que devuelven los subagentes.
2. **Escape valve medible**: sustituir el "if the work turns out to be single scope" por criterios concretos (ej.: <3 archivos, 1 capa, sin cambio de contrato público → se permite saltar PRD).
3. **Deslindar solapamientos**: `code-reviewer` (bugs + guidelines) vs `code-simplifier` (claridad/estructura); renombrar o re-describir `test-analyzer` → deja claro que NUNCA escribe tests (eso es `tester`).
4. **Result contract en subagentes** (de gentle-ai): todo subagente termina con `status / summary / artifacts / delegations / risks` + `mem_save` con `topic_key` estable antes de reportar → las cadenas largas sobreviven a cortes de sesión.
5. **Engram visible cuando falla**: el plugin hoy falla en silencio si `engram serve` no corre. Mínimo: warning una vez por sesión.
6. **Protocolo de memoria sin duplicar** (ver §7.2).
7. **Tiers de modelo** en lugar de modelos hardcodeados (§6).
8. **Secretos fuera de la config** (§7.4).
9. **Backups con retención** en lugar de los `opencode.json.bak-*` manuales acumulados.
10. **Limpieza**: `rules/` y `prompts/` vacíos, backups sueltos y archivos de estado no se migran.
11. **Una sola casa por artefacto: `work/{nombre}/` para lo que revisa el humano, Engram para lo que consumen los agentes (D9 v2)**. Referencia gentle-ai: su default es memory-first puro (topic_keys `sdd/{cambio}/{artefacto}`), con un modo `openspec` de archivos para equipos y un `hybrid` que escribe en ambos (~2x tokens — descartado). El stack toma la partición sin duplicar: **(a)** `work/{nombre}/` (gitignorada — es andamiaje, no producto — y solo existe mientras el trabajo está EN CURSO) con `PRD.md` (lo escribe `to-prd`) y `plan.md` (objetivo, enfoque y tabla de tareas con título + descripción de una línea + estado/wave/deps); el estado vive SOLO en esa tabla y se actualiza con edits quirúrgicos, sin releer el plan tras cada tarea; **(b)** la spec completa de cada tarea atómica → Engram (`work/{nombre}/task/{NN}`): el subagente recibe topic_key + título — prompt fino y visible desde cualquier worktree (un worktree no ve archivos gitignorados del checkout principal); resultados de fase y decisiones → `work/{nombre}/{fase}`; cierre → `work/{nombre}/done`; **(c)** backlog del proyecto en la clave ÚNICA `work/backlog` (una lista upsertada, nunca una clave por idea) o issues (`to-issues`) si el proyecto usa tracker; **(d)** al cerrar, el PRD pasa a `docs/` solo si tiene valor duradero y `work/{nombre}/` se borra — sin `1-TODOs/` ni `3-finalized/`; el historial es memoria + git. La skill `work-lifecycle` es la fuente única del flujo (templates incluidos); `to-prd` escribe el PRD en `work/{nombre}/PRD.md`. Complemento opcional: **vista HTML de revisión bajo demanda** — al presentar PRD o plan, el orquestador la ofrece; si el humano acepta, se genera un render desechable en `work/{nombre}/` (`*.review.html`); los cambios pedidos se aplican SIEMPRE al markdown (única fuente, el HTML se regenera de él) y el HTML se borra al aprobar, antes de ejecutar. Los subagentes nunca lo leen.
12. **Loop autónomo del orquestador**: el humano decide hasta el plan (idea, PRD y plan se iteran con él); aprobado el plan, EXECUTE → VERIFY → SHIP corren sin intervención dentro de un **worktree** (rama = nombre canónico, el checkout principal no se toca) — **commit por tarea o grupo acotado** (el historial de la rama mapea al plan, nunca un commit gigante), verificación por secciones acotadas (por wave, no por micro-cambio), y al terminar: push + `gh pr create` automáticos. Regla general en AGENTS.md §Git: nunca push directo a ramas de producción; push de rama de trabajo/worktree y creación de PR no piden permiso. El hook post-PR lanza la review de los 7 subagentes; el orquestador procesa el informe por niveles: Critical → se aplican sí o sí, Important → a criterio, Suggestions → solo triviales; lo NO aplicado se documenta en `work/backlog` (una línea: qué + por qué se difiere) y lo aplicado entra como nuevas tasks (plan.md + Engram), se ejecuta y se re-verifica. CLOSE devuelve el control: informe al usuario + recomendación de test manual cuando aplica. **El merge del PR jamás es automático** — siempre orden explícita del usuario; tras el merge se cierra (done, borrar carpeta, retirar worktree). Loop interno blindado (loop engineering): VERIFY valida y marca los **Success criteria** del plan (tests verdes no bastan) y regla **anti-thrashing** — máx. 3 intentos por tarea/criterio fallido; al tercero se documenta el bloqueo bajo el topic_key del trabajo y se re-planifica con otro enfoque o se reporta el bloqueo (única interrupción legítima de la autonomía; reintentar a ciegas jamás).

## 10. Seguridad

- Descargas (Engram, skills) con checksum SHA256 fail-closed; instalación de paquetes siempre con pnpm y versiones pinneadas.
- El repo nunca contiene secretos (CI check simple con patrón regex en F5). Por D5, ninguna key de la config actual de Jorge entra en el proyecto en ningún formato.
- ⚠ **Recomendación aparte del proyecto**: las keys de Context7 y Hostinger llevan tiempo en claro en `opencode.json` — conviene rotarlas aunque aquí no se usen.
- `uninstall` y `restore` siempre disponibles; ningún paso destructivo sin backup previo.

## 11. Roadmap

| Fase | Contenido | Done cuando |
|---|---|---|
| **F0** | Scaffold del repo + este PRD + git init | PRD aprobado |
| **F1** | Fuente canónica: migrar y MEJORAR (§9) agentes, AGENTS.md, hooks, scripts, commands, manifiesto MCP; auditar skills propias vs terceros → `upstreams.json`; copiar plugins de jorgex-custom-tools | `stack/` completo, sin secretos, revisado por Jorge |
| **F2** | CLI core: detect, backup/restore, filemerge (md/JSON/TOML), pipeline + **adapter OpenCode** | install en OpenCode reproduce la config actual (paridad verificada) |
| **F3** | **Adapter Claude Code** (agentes md, skills espejo, hooks en settings.json, MCP user scope, CLAUDE.md) | install funcional en Claude Code real |
| **F4** | **Adapter Codex** (agentes TOML, skills en ~/.agents, hooks.json + aviso trust, MCP TOML, AGENTS.md) | install funcional en Codex real |
| **F5** | `update` (stack + engram + upstreams), `doctor`, `uninstall`, tests de paridad, publicación en el registry npm | `pnpm dlx jorgex-stack` funciona en máquina limpia |
| **F6** | **Migración final**: eliminar plugins de jorgex-custom-tools, desinstalar config legacy de `~/.config/opencode`, reinstalar TODO desde JorgeX Stack | El stack es la única fuente; los re-exports `file:///` han desaparecido |

Backlog v1.x: skill registry cacheado, scope proyecto, más runtimes (Cursor/Gemini), diff de 3 vías en updates de skills.

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| Los formatos de los runtimes cambian (Codex evoluciona rápido) | Adapters aislados; tests de instalación; docs de cada formato enlazadas en el código |
| Hooks de Codex requieren trust manual | `doctor` lo verifica y da la instrucción exacta; documentado en README |
| Capacidades desiguales (OpenCode sin hooks nativos; captura pasiva de Engram solo en OpenCode) | Tabla de paridad documentada; el puente cubre lo crítico; lo no portable se declara, no se simula |
| Symlinks/permisos en Windows | No usamos symlinks: copias gestionadas por `sync` |
| Romper la config en uso durante el desarrollo | Backups automáticos + los originales de jorgex-custom-tools intactos hasta F6 |

## 13. Criterios de aceptación (v1)

1. En una máquina limpia con los 3 CLIs instalados: `pnpm dlx jorgex-stack install --agents claude,codex,opencode --yes` deja los 3 funcionando con agentes, skills, hooks, Engram y MCPs.
1b. En la máquina de Jorge: el install detecta su Engram existente, lo respeta (binario y DB intactos) y ninguna key personal aparece en el repo ni en los artefactos generados.
2. Re-ejecutar `sync` dos veces seguidas produce cero cambios (idempotencia byte a byte en lo gestionado).
3. Una edición manual del usuario fuera de las secciones marcadas sobrevive a `sync` y `update`.
4. `update --check` detecta una release nueva de Engram y una skill de terceros desactualizada.
5. `doctor` detecta: runtime ausente, hook sin trust en Codex, Engram caído, secreto faltante.
6. `uninstall` + `restore` devuelven cada runtime a su estado previo.
