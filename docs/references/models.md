# Modelos por runtime

JorgeX Stack separa dos políticas:

- El **agente principal** de Codex y Pi usa `gpt-5.6-sol` mediante la autenticación de la suscripción. OpenCode v2 usa `openai/gpt-6.1-sol` como default nativo (ver §OpenCode v2 abajo); los wrappers primary siguen sin fijar modelo ni effort y heredan el default global de su runtime.
- Los **subagentes** conservan su selección independiente por tier o por agente en `~/.jorgex-stack/model-map.json`.

`jorgex-stack models` solo cambia la segunda política. Los wrappers primary siguen sin fijar modelo ni esfuerzo: heredan el default global del runtime. La sustitución por runtime no cambia el resto de los defaults.

## Defaults del agente principal

### Codex

En `~/.codex/config.toml`, Stack añade solo cuando faltan:

```toml
model = "gpt-5.6-sol"
model_context_window = 872000
```

Son 872K tokens de ventana configurada para entrada; con el umbral nativo de compactación del 95 %, Codex compacta alrededor de 828,4K. Stack no fija `model_auto_compact_token_limit`: así conserva el comportamiento nativo y futuras correcciones del runtime.

La cifra no equivale al contexto de la API. Este flujo usa la autenticación de Codex/ChatGPT y reserva por separado la salida máxima del modelo.

### OpenCode v2

Esta sección cubre el **server config** (`opencode.json` o
`opencode.jsonc`): modelos, providers, permissions, MCP y el resto del
estado nativo del host. El archivo compacto del **cliente v2**
(`cli.json` —presentación, audio, panel TUI) es un archivo distinto
en la misma raíz efectiva (`OPENCODE_CONFIG_DIR` →
`$XDG_CONFIG_HOME/opencode` → default de HOME) y sus defaults se
describen en el [README](../../README.md#opencode-v2-un-solo-runtime-soportado),
no aquí. Una sección más abajo (§ Subagentes) sigue el roster de
subagentes v2, también del server config.

OpenCode v2 siembra `opencode.json`/`opencode.jsonc` (raíz efectiva:
`OPENCODE_CONFIG_DIR` si está definido, si no `$XDG_CONFIG_HOME/opencode`
o el default de HOME) con un agente principal nativo en
`openai/gpt-6.1-sol`. La compactación, los títulos y los resúmenes usan
modelos declarados aparte; eso no garantiza por sí solo cuotas distintas
ni límites por agente — el host decide el enrutamiento real:

```jsonc
{
  "model": "openai/gpt-6.1-sol",
  "providers": {
    "openai": {
      "models": {
        "gpt-6.1-sol": {
          "limit": {
            "context": 872000,
            "input": 744000,
            "output": 128000
          }
        },
        "gpt-6-astra": {
          "limit": {
            "context": 872000,
            "input": 744000,
            "output": 128000
          }
        }
      }
    },
    "opencode-go": {
      "models": {
        "deepseek-v4.1-flash": {
          "limit": { "context": 400000, "output": 128000 }
        },
        "muse-spark-1.3-contributor": {
          "limit": { "context": 400000, "output": 128000 }
        }
      }
    }
  },
  "agents": {
    "plan": { "disabled": true },
    "title": { "model": "openai/gpt-6-luna#none" },
    "summary": { "model": "minimax/MiniMax-M3#thinking" }
  },
  "compaction": {
    "auto": true,
    "keep": { "tokens": 20000 }
  },
  "update": "auto",
  "formatter": true,
  "lsp": false,
  "worktree": { "directory": "worktrees" }
}
```

- **`openai/gpt-6.1-sol`** es el default del agente principal; el wrapper
  primary sigue sin fijar modelo ni effort, y `agents.plan.disabled: true`
  apaga el modo plan para que el flujo por defecto no dependa de Shift+Tab.
  El wrapper primary no fija modelo global: el agente principal hereda
  el default del host cuando no se declara un override en su frontmatter.
- **`agents.title.model` y `agents.summary.model`** se siembran solo si
  faltan (y `agents.title` solo si no existe `small_model` ni el alias
  legacy `agent.title`): `openai/gpt-6-luna#none` para los títulos y
  `minimax/MiniMax-M3#thinking` para los resúmenes. La compactación solo
  activa `auto: true` y `keep.tokens: 20000`; no hay clave nativa
  `compaction.model` (la compactación sigue el modelo de la sesión por
  defecto del host). Título y resumen se mantienen como agentes separados
  para separar responsabilidades, no como promesa de cuota por agente.
- **Límites explícitos por modelo**: `gpt-6.1-sol` y `gpt-6-astra`
  declaran `context: 872000 / input: 744000 / output: 128000`; los modelos
  de OpenCode-managed (`deepseek-v4.1-flash`,
  `muse-spark-1.3-contributor`) usan `context: 400000 / output: 128000`.
  Estos límites son metadatos locales solicitados al backend; no son una
  promesa de ventana universal y pueden depender de la cuenta OAuth del
  usuario. Stack no anuncia la ventana de 1,05 M de la API.
- **`update: "auto"`** describe la preferencia del binario OpenCode; no
  autoriza a Stack a actualizar el binario del usuario ni a saltarse la
  verificación de install/update. Si `update` ya existe (manual), se
  respeta; el alias legacy `autoupdate` también.
- **`formatter: true`, `lsp: false`, `worktree.directory: "worktrees"`**
  reflejan el canon v2 nativo: Stack respeta el formatter del host,
  desactiva el LSP gestionado y ancla `worktree.directory` a la cadena
  relativa `"worktrees"` desde el checkout canónico del host (no es un
  cwd arbitrario ni una ruta de sesión: el host la resuelve al iniciar
  el worktree). Si el usuario ya tenía un valor manual se respeta.
- **Permisos y `agents`:** el wrapper primary no añade `name` ni `tier`;
  la identificación del agente vive en el nombre de archivo Markdown
  bajo `.config/opencode/agents/`. Los modelos/variants se serializan como
  escalares YAML seguros para no inyectar campos en el frontmatter.

### Pi

`jorgex-pi` —no los adapters de Stack— gestiona su propia política y proyección primaria. El pin exacto, su integridad y la transición reconocida por Stack son autoridad de `src/lib/pi-runtime.ts` y `docs/references/pi-runtime.md`; no se mantienen aquí estados publicados o candidatos:

- `defaultProvider = "openai-codex"`;
- `defaultModel = "gpt-5.6-sol"`;
- `providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow = 872000`.

Pi registra ownership por campo y su cleanup solo retira valores canónicos que siga poseyendo. Igual que en OpenCode, 872K es metadata local solicitada hasta confirmar la aceptación del backend OAuth.

La proyección compartida de Stack no cambia esta propiedad: solo instala los recursos comunes en `~/.pi/agent/AGENTS.md`, `~/.agents/skills` y `~/.pi/agent/prompts/lean-audit.md`. La selección de modelo sigue siendo propiedad del paquete Pi y de su recibo de ownership.

## Sustituir el default principal

Edita el campo global del runtime después de instalarlo:

- Codex: `model` o `model_context_window` en `config.toml`.
- OpenCode v2: `model`, `agents.title.model`, `agents.summary.model`,
  `compaction.keep.tokens` o los límites del modelo en `opencode.json` /
  `opencode.jsonc`. La sustitución por agente (`agents.<id>.model`) tiene
  precedencia sobre el default global.
- Pi: los defaults en `settings.json` o el override en `models.json`.

`install` solo rellena campos ausentes y conserva sustituciones del usuario. Stack registra en `~/.jorgex-stack/primary-model.json` qué campos creó en Codex/OpenCode; `uninstall` solo retira esos campos si todavía coinciden con el valor canónico. Un valor canónico preexistente no se reclama ni se borra. El cleanup de Pi usa su propio recibo de ownership.

## Subagentes

### Codex

En un mapa nuevo o cuando falta el mapa del runtime se siembran los defaults
de los tres tiers, sin overrides nominales. En un mapa guardado no se
reescriben los tiers ni los overrides guardados; un agente sin override
resuelve, no obstante, el tier canónico que tenga actualmente. El wrapper
primary heredado permanece intacto.

| Tier | Modelo | Reasoning effort |
|---|---|---|
| `strong` | `gpt-6-astra` | `low` |
| `standard` | `gpt-5.6-luna` | `max` |
| `cheap` | `gpt-5.6-luna` | `medium` |

El tier `standard` incluye, entre otros, `codebase-analyst`. En Codex,
`code-reviewer` pertenece ahora al tier canónico `standard` y recibe
`gpt-5.6-luna/max`; `security-auditor` y `silent-failure-hunter` son los
subagentes que permanecen en `strong` y heredan Astra/low. Codex no tiene
overrides nominales por defecto.

El picker de Codex pregunta primero el modelo y después el effort. El `max`
nuevo solo se ofrece para Astra y la familia 5.6; los modelos legacy,
`default` o `custom` no reciben ese effort nuevo sin soporte verificado. Un
variant existente que no esté listado se conserva solo si se mantiene el mismo
modelo; al cambiar de modelo no se arrastra. La lista y los variants de
OpenCode no cambian.

### OpenCode v2

Los subagentes v2 se siembran con un `model#variant` único por agente,
serializado como escalar YAML seguro. El roster canónico vive en
`src/lib/model-map.ts` (`DEFAULT_MODEL_MAP.opencode`) e incluye los tres
tiers (`strong`, `standard`, `cheap`) más overrides nominales por nombre
de agente. Una selección guardada del usuario se conserva, los cambios de
tier no pisan los overrides por agente y un agente sin override resuelve
el tier canónico actual. Los modelos listados en el roster son los
aprobados para el canon v2 (Sol 6.1, Luna 6, DeepSeek 4.1 Flash, Muse
Spark 1.3 Contributor y MiniMax-M3); los detalles exactos se leen del
model-map y pueden ampliarse por agente sin cambiar el canon de los
demás runtimes.

`install --yes`, `sync` y procesos sin TTY también usan los defaults del
roster en una config fresca, sin exigir selección previa ni invocar el
catálogo de modelos. La primera instalación interactiva sigue permitiendo
elegir por tier o por agente cuando se ejecuta explícitamente; las
elecciones explícitas guardadas tienen precedencia sobre los defaults
del roster. `code-reviewer` hereda `standard` salvo override personal.

La lista de variants para OpenCode v2 sigue siendo exclusiva del runtime;
Codex conserva su propio `max`/`medium` por modelo y la regla
"variant no listado no se arrastra al cambiar de modelo" no se aplica
cruzando runtimes.

### Claude Code

Claude Code conserva sus alias `fable`, `sonnet` y `haiku`, modificables mediante el picker. Con los defaults y salvo override personal, `code-reviewer` hereda `sonnet`.

## Cambiar subagentes

```powershell
pnpm dlx jorgex-stack models --agents codex
```

Los overrides por nombre de agente tienen precedencia sobre su tier. Actualizar Stack no sobrescribe model-maps existentes; si un agente no tiene override, una actualización de su tier canónico puede cambiar el modelo efectivo que hereda.

El picker permite elegir voluntariamente **por tier** o **por subagente**, uno a
uno. La segunda opción guarda solo las diferencias como overrides por nombre
de agente; así se puede asignar, por ejemplo, Astra/max únicamente a roles
concretos. No cambia el modelo primary ni convierte una elección existente en
un override gestionado por Stack; `install` tampoco sobrescribe elecciones
guardadas.
## Recuperar un model-map inválido

Si `~/.jorgex-stack/model-map.json` existe pero contiene JSON malformado, Stack rechaza el archivo y detiene las operaciones que consumen ese mapa antes de sustituir las elecciones por defaults. El error muestra la ruta del archivo y recomienda corregir el JSON o restaurar una copia revisada.

La recuperación es manual: corrige el JSON o restaura una copia revisada y vuelve a ejecutar la operación. No ejecutes `models` para reparar el archivo automáticamente ni lo borres para forzar un reinicio. Un archivo ausente usa los defaults; un mapa parcial válido hereda los tiers disponibles por defecto y conserva los overrides válidos.

El puente de instalación Pi-only con Playwright no consume este mapa y no queda bloqueado por él.
