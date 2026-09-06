# Modelos por runtime

JorgeX Stack separa dos políticas:

- El **agente principal** de Codex, OpenCode y Pi usa `gpt-5.6-sol` mediante la autenticación de la suscripción.
- Los **subagentes** conservan su selección independiente por tier o por agente en `~/.jorgex-stack/model-map.json`.

`jorgex-stack models` solo cambia la segunda política. Los wrappers primary siguen sin fijar modelo ni esfuerzo: heredan el default global del runtime.

## Defaults del agente principal

### Codex

En `~/.codex/config.toml`, Stack añade solo cuando faltan:

```toml
model = "gpt-5.6-sol"
model_context_window = 872000
```

Son 872K tokens de ventana configurada para entrada; con el umbral nativo de compactación del 95 %, Codex compacta alrededor de 828,4K. Stack no fija `model_auto_compact_token_limit`: así conserva el comportamiento nativo y futuras correcciones del runtime.

La cifra no equivale al contexto de la API. Este flujo usa la autenticación de Codex/ChatGPT y reserva por separado la salida máxima del modelo.

### OpenCode

En `~/.config/opencode/opencode.json`, Stack solicita al proveedor OAuth de OpenAI:

```json
{
  "model": "openai/gpt-5.6-sol",
  "provider": {
    "openai": {
      "models": {
        "gpt-5.6-sol": {
          "limit": {
            "context": 872000,
            "input": 744000,
            "output": 128000
          }
        }
      }
    }
  }
}
```

Estos límites son metadatos locales solicitados. No demuestran por sí solos que el backend OAuth acepte toda la ventana; hay que confirmarlo con una prueba real de contexto largo. No se anuncia aquí el límite de 1,05M de la API.

### Pi

`jorgex-pi@0.8.4` —no los adapters de Stack— gestiona la proyección primaria del candidato de Stack. El Stack publicado `1.9.5` reconoce todavía `npm:jorgex-pi@0.8.3`; el código candidato de Stack `1.9.6` ya reconoce `npm:jorgex-pi@0.8.4`, aunque su consumo mediante el canal publicado espera a la publicación de `1.9.6`:

- `defaultProvider = "openai-codex"`;
- `defaultModel = "gpt-5.6-sol"`;
- `providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow = 872000`.

Pi registra ownership por campo y su cleanup solo retira valores canónicos que siga poseyendo. Igual que en OpenCode, 872K es metadata local solicitada hasta confirmar la aceptación del backend OAuth.

La proyección compartida de Stack no cambia esta propiedad: solo instala los recursos comunes en `~/.pi/agent/AGENTS.md`, `~/.agents/skills` y `~/.pi/agent/prompts/lean-audit.md`. La selección de modelo sigue siendo propiedad del paquete Pi y de su recibo de ownership.

## Sustituir el default principal

Edita el campo global del runtime después de instalarlo:

- Codex: `model` o `model_context_window` en `config.toml`.
- OpenCode: `model` o los límites del modelo en `opencode.json`.
- Pi: los defaults en `settings.json` o el override en `models.json`.

`sync` solo rellena campos ausentes y conserva sustituciones del usuario. Stack registra en `~/.jorgex-stack/primary-model.json` qué campos creó en Codex/OpenCode; `uninstall` solo retira esos campos si todavía coinciden con el valor canónico. Un valor canónico preexistente no se reclama ni se borra. El cleanup de Pi usa su propio recibo de ownership.

## Subagentes

### Codex

| Tier | Modelo | Reasoning effort |
|---|---|---|
| `strong` | `gpt-5.6-terra` | `xhigh` |
| `standard` | `gpt-5.6-terra` | `xhigh` |
| `cheap` | `gpt-5.6-luna` | `medium` |

### OpenCode

Los subagentes siguen siendo provider-agnostic. La primera instalación interactiva ejecuta `opencode models` y exige elegir por tier o por agente. `install --yes`, `sync` y procesos sin TTY fallan si todavía no existe esa selección; nunca inventan modelos de subagente.

### Claude Code

Claude Code conserva sus alias `fable`, `sonnet` y `haiku`, modificables mediante el picker.

## Cambiar subagentes

```powershell
pnpm dlx jorgex-stack models --agents opencode
```

Los overrides por nombre de agente tienen precedencia sobre su tier. Actualizar Stack no sobrescribe model-maps existentes.

## Recuperar un model-map inválido

Si `~/.jorgex-stack/model-map.json` existe pero contiene JSON malformado, Stack rechaza el archivo y detiene las operaciones que consumen ese mapa antes de sustituir las elecciones por defaults. El error muestra la ruta del archivo y recomienda corregir el JSON o restaurar una copia revisada.

La recuperación es manual: corrige el JSON o restaura una copia revisada y vuelve a ejecutar la operación. No ejecutes `models` para reparar el archivo automáticamente ni lo borres para forzar un reinicio. Un archivo ausente usa los defaults; un mapa parcial válido hereda los tiers disponibles por defecto y conserva los overrides válidos.

El puente de instalación Pi-only con Playwright no consume este mapa y no queda bloqueado por él.
