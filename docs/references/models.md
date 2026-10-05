# Modelos y esfuerzo por subagente

Seis subagentes sin tier/default de modelo o esfuerzo. El principal pertenece al runtime y Stack no impone su modelo/contexto. Las elecciones personales existentes se conservan al aplicar canon. Un solo perfil sirve al uso humano/programático.

En `jorgex-stack`: Instalar/configurar → Subagentes → runtime → agente → Editar modelo/esfuerzo. Modelo y esfuerzo se editan por separado; **Guardar** escribe únicamente esos campos en el archivo nativo, con backup y comprobación de ownership/contenido esperado. Volver sin guardar descarta el borrador; volver después de guardar no deshace lo guardado. Aplicar canon no es requisito para navegar al editor, pero un archivo ausente/ajeno requiere aplicación explícita antes de guardar.

| Runtime | Catálogo | Guardado |
| --- | --- | --- |
| Claude | SDK oficial `supportedModels()` | frontmatter `model`/`effort` |
| Codex | app-server `model/list`, paginación | TOML `model`/`model_reasoning_effort` |
| OpenCode v2 | server `/api/model`, snapshot por ubicación | frontmatter `model` con variante `#…` |
| Pi | RPC `get_available_models` + `get_state` | frontmatter `model`/`thinking` |

Consultas automáticas acotadas; abrir el menú no instala herramientas ni cambia modelo activo. Falta de catálogo/autenticación muestra aviso y permite mantener, heredar o introducir ID exacto manual. No se normalizan aliases ni se sustituye silenciosamente una selección preexistente ausente del catálogo. Sin entitlement certificado ni escala universal de esfuerzos.

Solo se ofrecen esfuerzos acreditados para el modelo; Pi informa niveles del activo sin cambiar principal. OpenCode requiere modelo para variante. Cambiar modelo conserva una variante anterior con aviso, sin afirmar compatibilidad con el nuevo. IDs manuales no prueban acceso ni contexto API; OAuth/desktop no equivale a API. Las APIs experimentales Codex/OpenCode pueden cambiar; no se mantiene un catálogo curado de respaldo.

Una segunda escritura idéntica no cambia archivo ni crea backup. Si el archivo cambió durante edición, Guardar bloquea sin sobrescribir. Cuerpo, herramientas, permisos y archivos vecinos permanecen intactos. [Producto](../../README.md).
