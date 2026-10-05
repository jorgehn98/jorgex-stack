# Modelos y esfuerzo por subagente

Seis subagentes sin tier/default de modelo o esfuerzo. El principal pertenece al runtime y Stack no impone su modelo/contexto. Las elecciones personales existentes se conservan al aplicar canon. Un solo perfil sirve al uso humano/programático.

En `jorgex-stack`: Instalar/configurar → Subagentes → runtime → agente → Editar modelo/esfuerzo. Modelo y esfuerzo se editan por separado; **Guardar** escribe únicamente esos campos en el archivo nativo, con backup y comprobación de ownership/contenido esperado. Volver sin guardar descarta el borrador; volver después de guardar no deshace lo guardado. Aplicar canon no es requisito para navegar al editor, pero un archivo ausente/ajeno requiere aplicación explícita antes de guardar.

| Runtime | Catálogo | Guardado |
| --- | --- | --- |
| Claude | SDK oficial `supportedModels()` | frontmatter `model`/`effort` |
| Codex | app-server `model/list`, paginación | TOML `model`/`model_reasoning_effort` |
| OpenCode v2 | server `/api/model`, snapshot por ubicación | frontmatter `model` con variante `#…` |
| Pi | RPC `get_available_models` + `get_state` | frontmatter `model`/`thinking` |

Para OpenCode v2, al entrar en **Modelo** o **Esfuerzo / variante** se ofrece primero la URL observada en el registro nativo de solo lectura: `$XDG_STATE_HOME/opencode/service.json`, o `~/.local/state/opencode/service.json` si no está definido XDG. Se admite una dirección manual; `http://127.0.0.1:4096` queda únicamente como alternativa standalone si no hay registro válido. No se inicia un servidor ni se consulta red al abrir el menú.

La consulta utiliza Basic con el usuario nativo `opencode` y la contraseña del registro solo si el origen seleccionado coincide exactamente con el registrado (incluidos host y puerto loopback). No se transfieren credenciales entre aliases loopback, se rechazan redirecciones y no se piden contraseñas por chat. Registro ausente, ilegible, malformado o extraño: aviso visible y consulta manual sin esa autenticación. No se escribe registro/configuración ni otro store de credenciales, ni se ejecuta `service get password`, start, restart o pair. Fuente: [contrato público de OpenCode v2.0.23](https://github.com/anomalyco/opencode/blob/v2.0.23/packages/client/src/effect/service.ts).

Consultas automáticas acotadas; abrir el menú no instala herramientas ni cambia modelo activo. Falta de catálogo/autenticación muestra aviso y permite mantener, heredar o introducir ID exacto manual. No se normalizan aliases ni se sustituye silenciosamente una selección preexistente ausente del catálogo. Sin entitlement certificado ni escala universal de esfuerzos.

Solo se ofrecen esfuerzos acreditados para el modelo; Pi informa niveles del activo sin cambiar principal. OpenCode requiere modelo para variante. Cambiar modelo conserva una variante anterior con aviso, sin afirmar compatibilidad con el nuevo. IDs manuales no prueban acceso ni contexto API; OAuth/desktop no equivale a API. Las APIs experimentales Codex/OpenCode pueden cambiar; no se mantiene un catálogo curado de respaldo.

Una segunda escritura idéntica no cambia archivo ni crea backup. Si el archivo cambió durante edición, Guardar bloquea sin sobrescribir. Cuerpo, herramientas, permisos y archivos vecinos permanecen intactos. [Producto](../../README.md).
