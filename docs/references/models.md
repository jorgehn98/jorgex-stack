# Modelos por runtime

JorgeX Stack separa el modelo del orquestador de los modelos de sus subagentes:

- El **orquestador** siempre usa el modelo y el nivel de razonamiento elegidos por el usuario en la sesión.
- Los **subagentes** reciben defaults por tier desde `~/.jorgex-stack/model-map.json`.
- `jorgex-stack models` permite cambiar esos defaults por tier o individualmente por subagente.

## Defaults por runtime

Estos defaults se escriben al crear un model-map nuevo:

| Tier | Codex | OpenCode |
|---|---|---|
| `strong` | `gpt-5.6-terra` + `xhigh` | `openai/gpt-5.6-terra` + `xhigh` |
| `standard` | `gpt-5.6-terra` + `xhigh` | `openai/gpt-5.6-terra` + `xhigh` |
| `cheap` | `gpt-5.6-luna` + `medium` | `minimax/MiniMax-M3` + `high` |

El tier canónico de cada agente vive en `stack/agents/*.md`. El model-map solo traduce ese tier al dialecto de cada runtime.

## Orquestador: modelo elegido en runtime

El stack no escribe `model`, `model_reasoning_effort` ni `variant` en ningún orquestador.

### Aplicación de Codex

1. Elige el modelo y el nivel de razonamiento en el compositor de la aplicación.
2. Activa el orquestador con `/orchestrator` o `$orchestrator`.

La skill cambia las instrucciones de la tarea; no cambia el modelo activo. Los subagentes que lance sí usan sus asignaciones Terra/Luna del model-map.

### Codex CLI

El perfil instala las instrucciones del orquestador, pero no fija modelo ni esfuerzo:

```powershell
codex --profile orchestrator -m gpt-5.6-sol -c model_reasoning_effort='"xhigh"'
```

También puedes arrancar una sesión normal, seleccionar modelo con `/model` y activar la skill del orquestador dentro de esa sesión.

### OpenCode

El agente primary `orchestrator` omite `model` y hereda el modelo seleccionado en OpenCode. Los subagentes sí pueden fijar un `provider/model` y una `variant` propios.

## Picker y proveedores de OpenCode

OpenCode descubre los modelos disponibles desde sus proveedores configurados. El stack ejecuta `opencode models` y usa directamente sus identificadores `provider/model` en el picker.

```powershell
pnpm dlx jorgex-stack models
```

El picker ofrece dos modos:

- **Por tier**: una elección para `strong`, otra para `standard` y otra para `cheap`.
- **Por subagente**: elección independiente de modelo y variant para cada subagente.

MiniMax M3 es el default barato de OpenCode. Luna permanece en el catálogo descubierto, pero no se usa como default porque puede aparecer en `opencode models` y aun así ser rechazado por el backend conectado con `Model not found`. El listado confirma que OpenCode conoce el identificador; no garantiza acceso efectivo al modelo.

El picker sigue permitiendo elegir Luna, MiniMax u otro modelo por tier o por agente. El orquestador no entra en este reparto porque su modelo se selecciona en la sesión.

OpenCode documenta la selección `provider/model`, el catálogo de proveedores configurados y las variants incorporadas en [Models](https://opencode.ai/docs/models/) y la herencia de modelo de los agentes en [Agents](https://opencode.ai/docs/agents/).

## Model-maps existentes

Actualizar el paquete no sobrescribe `~/.jorgex-stack/model-map.json`. Una selección existente puede ser deliberada y el stack no intenta adivinarlo.

Para adoptar los nuevos defaults después de actualizar:

```powershell
pnpm dlx jorgex-stack models
```

Revisa las elecciones y acepta el `sync` ofrecido al final. También puedes editar el JSON manualmente; los overrides por nombre de agente tienen precedencia sobre su tier.
