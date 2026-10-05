# Modelos por runtime

Stack instala los seis agentes sin modelos, esfuerzos, variantes ni límites de contexto prefijados. El principal se elige en el runtime; Stack no lo cambia para consultar catálogos. Las elecciones existentes se conservan al reconciliar agentes gestionados y los archivos ajenos no se sobrescriben.

## Edición individual

El selector conectado a `jorgex-stack models` permite elegir un runtime y un agente gestionado, consultar su catálogo y guardar esa unidad con backup. No reinstala ni actualiza herramientas ni cambia permisos. El guardado modifica únicamente los campos de modelo/esfuerzo del archivo nativo; mantiene instrucciones, herramientas y demás políticas. Los roles readonly conservan sus restricciones; Codex hereda el sandbox del padre.

- **Mantener:** conserva el valor actual aunque no figure en el catálogo. Guardar sin cambios no reescribe el archivo.
- **Heredar:** elimina el override elegido, sin escribir nombres ficticios `default`/`inherit`. Modelo y esfuerzo tienen elecciones independientes; OpenCode necesita un modelo explícito para almacenar una variante.
- **ID exacto:** permite introducir un ID sin cambiar sus mayúsculas, con advertencia de acceso no acreditado. No introduce esfuerzos manuales ni una escala universal.
- **Guardar y aplicar:** guarda inmediatamente el agente con backup; volver no deshace lo guardado. Los cambios pendientes permiten guardar, descartar o continuar editando. Se requiere nueva sesión o reload según el runtime; no se modifica una sesión abierta.

La edición requiere un terminal interactivo y un agente instalado/gestionado. No edita archivos ajenos, enlaces ni preferencias ambiguas/ilegibles. Si el archivo cambia mientras está abierto en el selector, el guardado se bloquea y debe abrirse de nuevo. Los backups usan el mecanismo común de Stack.

## Catálogo observado, no catálogo curado

La consulta ocurre al abrir la edición de un agente, no al navegar por las listas de runtimes/agentes. Usa la ubicación del proyecto actual, que puede diferir de la configuración global del agente.

| Runtime | Fuente | Persistencia y límite |
|---|---|---|
| Claude Code | SDK oficial `Query.supportedModels()`; `supportedEffortLevels` cuando existe | `agents/<nombre>.md`: `model`, `effort`. Sin mensajes al LLM; proceso SDK cerrado después de consultar. |
| Codex | App-server stdio `initialize` / `initialized`, `model/list` paginado | `agents/<nombre>.toml`: `model`, `model_reasoning_effort`. API experimental; no threads ni turns para listar. |
| OpenCode v2 | `GET /api/model` con `location.directory`, en un servidor existente indicado por el usuario | `agents/<nombre>.md`: `model: "provider/model#variante"`. Solo HTTP loopback, sin credenciales en la URL ni redirecciones. No inicia un servicio. API experimental; el snapshot puede preceder la carga de plugins. Variantes por ID, no escala universal de esfuerzo. |
| Pi | RPC `get_available_models`, `get_state`, `get_available_thinking_levels` | `agents/<nombre>.md`: `model`, `thinking`. Proceso `--mode rpc --no-session`; niveles acreditados únicamente para el modelo activo, sin cambiarlo para sondear otros. |

El arranque nativo puede cargar plugins/hooks, conexiones o cachés: no se promete ausencia absoluta de efectos. La consulta no escribe configuración de modelos ni envía prompts al LLM. Se limita a 15 segundos, con cierre de los procesos propios y límites de respuesta; la terminación puede necesitar hasta 3 segundos adicionales. No muestra respuestas crudas, headers, cuerpos ni credenciales.

Si la autenticación, conexión, versión o formato impide consultar, aparece una explicación y siguen disponibles mantener, heredar o introducir ID exacto. Si los esfuerzos de un modelo son desconocidos, solo mantener/heredar: no se inventan niveles ni se atribuyen los del principal a otro modelo. Un ID listado tampoco garantiza entitlement, cuota, contexto efectivo o éxito de una llamada al backend.

## Fuente de preferencias

Los archivos nativos de cada agente son la fuente de verdad. No se guarda un mapa paralelo; el antiguo `~/.jorgex-stack/model-map.json` no se lee, reescribe ni elimina. No se migran tiers a modelos prefijados. Cambiar un agente no altera el default principal, otros agentes ni archivos globales del runtime. Las preferencias globales se administran con las interfaces nativas del proveedor.

## Evidencia y límites

La normalización, paginación, escritura aislada, conservación de preferencias, fallos y cierre acotado se verifican con respuestas sintéticas y procesos mínimos de prueba, sin cuentas personales. Esto no certifica ejecución autenticada ni soporte del backend de una cuenta; el smoke real requiere autorización independiente, también en Windows.

Fuentes documentales: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [frontmatter de Claude](https://code.claude.com/docs/en/sub-agents), [Codex app-server](https://developers.openai.com/codex/app-server), [OpenCode v2 API](https://opencode.ai/v2/docs/api) y documentación RPC del Pi instalado. Stack usa el SDK oficial como cliente de descubrimiento; no instala otra versión de Claude para cambiar el modelo.
