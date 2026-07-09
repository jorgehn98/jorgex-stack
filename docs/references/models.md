# Modelos por runtime

JorgeX Stack separa el modelo del orquestador de los modelos de sus subagentes:

- El **orquestador** usa el modelo y el nivel de razonamiento elegidos por el usuario en la sesión.
- Los **subagentes** reciben su selección desde `~/.jorgex-stack/model-map.json`.
- `jorgex-stack models` permite cambiar la selección por tier o individualmente por subagente.

## Política por runtime

### OpenCode: sin defaults de proveedor

El stack no presupone OpenAI, MiniMax ni ningún otro proveedor para OpenCode. Una instalación puede tener Grok, GLM, modelos locales o cualquier combinación compatible; un default universal podría ser inválido.

En la primera instalación interactiva de OpenCode:

1. El stack ejecuta `opencode models`.
2. Muestra los identificadores `provider/model` descubiertos.
3. Exige elegir modelos **por tier** (`strong`, `standard`, `cheap`) o **por subagente**.
4. Permite seleccionar una variant cuando el modelo la soporte.
5. Guarda la elección y genera los agentes.

El agente primary `orchestrator` queda fuera del model-map: omite `model` y `variant`, y hereda la selección activa de OpenCode.

`opencode models` confirma que OpenCode conoce un identificador, no que el backend conectado vaya a aceptarlo. Por eso la elección pertenece al usuario y el stack no convierte su propio catálogo en un default.

### Codex

Codex conserva defaults curados para sus subagentes:

| Tier | Modelo | Reasoning effort |
|---|---|---|
| `strong` | `gpt-5.6-terra` | `xhigh` |
| `standard` | `gpt-5.6-terra` | `xhigh` |
| `cheap` | `gpt-5.6-luna` | `medium` |

El tier canónico de cada agente vive en `stack/agents/*.md`. El model-map traduce ese tier al modelo elegido para cada runtime.

### Claude Code

Claude Code conserva sus alias autoactualizables (`fable`, `sonnet`, `haiku`) y también permite cambiarlos con el picker.

## Orquestador de Codex

El stack no escribe `model` ni `model_reasoning_effort` en el orquestador.

### Aplicación de Codex

1. Elige el modelo y el nivel de razonamiento en el compositor de la aplicación.
2. Activa el orquestador con `/orchestrator` o `$orchestrator`.

La skill cambia las instrucciones de la tarea; no cambia el modelo activo. Los subagentes sí usan las asignaciones del model-map.

### Codex CLI

El perfil instala las instrucciones del orquestador, pero no fija modelo ni esfuerzo:

```powershell
codex --profile orchestrator -m gpt-5.6-sol -c model_reasoning_effort='"xhigh"'
```

También puedes seleccionar modelo con `/model` y activar la skill dentro de esa sesión.

## Cambiar modelos

```powershell
pnpm dlx jorgex-stack models --agents opencode
```

El picker de OpenCode ofrece:

- **Por tier**: una elección para `strong`, otra para `standard` y otra para `cheap`.
- **Por subagente**: elección independiente de modelo y variant para cada subagente.

Al terminar ofrece aplicar la selección mediante `sync`.

## Flujos no interactivos

`install --yes`, `sync` y procesos sin TTY nunca inventan proveedores OpenCode. Si el model-map todavía no contiene una selección OpenCode, terminan con error e indican que se ejecute primero el picker interactivo.

Para automatización, prepara `~/.jorgex-stack/model-map.json` antes del install. Después, los comandos no interactivos reutilizan esa selección.

## Model-maps existentes

Actualizar el paquete no sobrescribe selecciones existentes. `install` y `sync` reutilizan el mapa actual sin abrir el picker; solo una primera instalación interactiva de OpenCode exige configurarlo.

Los overrides por nombre de agente tienen precedencia sobre su tier.

OpenCode documenta la selección `provider/model` y los proveedores configurados en [Models](https://opencode.ai/docs/models/), y la herencia de modelo de los agentes en [Agents](https://opencode.ai/docs/agents/).
