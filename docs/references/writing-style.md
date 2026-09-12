# Estilo global de escritura

Stack incluye un prompt genérico de estilo de escritura como parte de su canon. Durante `install` y `sync` crea o actualiza automáticamente `~/.jorgex-stack/writing-style.md` y, en modo humano, proyecta su contenido efectivo en las instrucciones globales de Claude Code, Codex, OpenCode y Pi seleccionados. El prompt está escrito en inglés para mantener el idioma del resto de las instrucciones del sistema, pero indica al modelo que responda en el idioma que usa el usuario, salvo que este pida otro. No necesitas crear el archivo ni instalar otra skill.

## Configurar y actualizar

El canon incluido vive en `stack/system-prompt/writing-style.md` dentro del paquete. El archivo local es una copia gestionada para que el estilo pueda viajar con el contexto global de cada runtime. `~` representa tu directorio de usuario. Stack coloca el canon dentro de un bloque marcado como `jorgex:writing-style-default`; si ya tienes texto fuera de ese bloque, lo conserva.

El uso normal no requiere preparar nada:

```bash
pnpm dlx jorgex-stack install --agents claude-code,codex,opencode,pi --mode human
pnpm dlx jorgex-stack sync --agents claude-code,codex,opencode,pi --mode human
```

Si editas el archivo para añadir notas propias, mantenlas fuera del bloque gestionado. En cada `sync`, Stack vuelve a aplicar el canon incluido y conserva esas notas. El canon ya contiene las instrucciones de estilo necesarias y deja fuera corpus, informes y activación como skill.

El archivo local resultante tiene esta forma conceptual:

```markdown
<!-- jorgex:writing-style-default -->
[canon de estilo incluido por Stack]
<!-- /jorgex:writing-style-default -->

[notas locales opcionales, conservadas por Stack]
```

Un ejemplo sintético de nota local sería:

```markdown
Cuando el encargo sea para un cliente, mantén el registro profesional que ya use ese cliente.
```

Después de cambiar notas locales, sincroniza los runtimes que utilices:

```bash
pnpm dlx jorgex-stack sync --agents claude-code,codex,opencode,pi --mode human
pnpm dlx jorgex-stack doctor --agents claude-code,codex,opencode,pi
```

La lista selecciona los destinos; no instala runtimes que falten. Cada cambio en el canon o en las notas locales requiere otra sincronización y una sesión nueva del runtime. No hay selector de estilos, recarga en caliente ni estilos distintos por runtime.

Stack limita esta capa a la prosa dirigida al usuario. El encargo, los formatos de máquina, el código, las instrucciones técnicas y las autorizaciones conservan sus reglas. La capa no cambia modelos, permisos, agentes primarios ni configuraciones nativas de personalidad.

## Fuente, destinos y validación

Stack toma el canon del paquete y prepara una instantánea del archivo local antes de realizar cualquier escritura. Con esa instantánea actualiza el bloque gestionado y proyecta el contenido efectivo a la sección independiente `writing-style`, fuera de las secciones de sistema, Engram y navegador. Conserva el contenido ajeno a los marcadores gestionados.

| Runtime | Destino global habitual |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Pi | `~/.pi/agent/AGENTS.md` |

Los adapters resuelven los destinos efectivos. El texto proyectado pasa a formar parte del contexto que recibe el modelo cuando el runtime carga ese archivo. El canon forma parte del paquete; el archivo local, las proyecciones y sus backups permanecen en el equipo del usuario.

Install/sync, sus dry-runs y el sync interno de update validan el canon y el archivo local antes de sus escrituras. Un canon ausente o vacío, un directorio, un error de lectura, UTF-8 inválido o marcadores locales ambiguos producen un error; no se interpretan como desactivación. Se normalizan saltos de línea y espacios exteriores, conservando el contenido interior. Los enlaces escritos en el Markdown no se descargan ni se expanden como imports.

## Desactivar, desinstalar y recuperar

- **Archivo local ausente o vacío:** `install` y `sync` vuelven a crear o completar el bloque desde el canon incluido. No es un mecanismo de desactivación.
- **Modo programático:** install/sync con `--mode programmatic` retira la sección aunque la fuente siga presente. Volver a `--mode human` permite proyectarla otra vez. En Pi esta selección filtra la capa de estilo; no sustituye el prompt base del runtime.
- **Uninstall:** retira la proyección conforme al ownership y los backups del lifecycle existente. Conserva el archivo local instalado y el contenido ajeno.
- **Restore:** repone los archivos incluidos en el backup elegido mediante el comando habitual. Si el backup `writing-style` contiene el archivo local, también puede restaurarlo. Restore no valida el contenido contra el canon; el siguiente sync vuelve a aplicar el canon actual y conserva las notas ajenas válidas.

Uninstall no necesita leer el archivo local y no queda bloqueado si está dañado. Restore opera sobre el backup seleccionado y puede recuperar ese archivo sin depender de que su contenido sea válido. Los backups pueden contener el estilo anterior; trátalos como parte de tu configuración privada. Consulta también el [lifecycle de Pi](pi-runtime.md).

## Probar en un destino aislado

Con `--target-dir`, Stack instala el canon únicamente en `<target-dir>/writing-style.md` y no busca el archivo local del HOME real. Rechaza enlaces de esa fuente que salgan del destino. Prepara allí el destino aislado:

```bash
pnpm dlx jorgex-stack sync --agents codex --target-dir ./prueba-estilo --mode human --dry-run
pnpm dlx jorgex-stack sync --agents codex --target-dir ./prueba-estilo --mode human
pnpm dlx jorgex-stack doctor --agents codex --target-dir ./prueba-estilo
```

El dry-run valida y planifica sin escribir la fuente local, backups ni proyecciones. Un archivo local nuevo recibe permisos POSIX `0600`; si ya existe, conserva sus permisos. En un destino aislado, los backups se guardan dentro de `<target-dir>/backups`. Para los runtimes de archivos, usa un destino por runtime. En Pi la proyección aislada se encuentra bajo `<target-dir>/pi-agent/AGENTS.md`.

El diagnóstico aislado usa modo humano por defecto. Si preparaste una proyección programática, pasa también `--mode programmatic` a doctor para comparar contra la ausencia esperada del estilo:

```bash
pnpm dlx jorgex-stack doctor --agents codex --target-dir ./prueba-estilo --mode programmatic
```

Sin un modo explícito, el diagnóstico del HOME utiliza la preferencia guardada.

El diagnóstico de Stack con `doctor --target-dir` se limita explícitamente al estilo: no equivale a un doctor completo del sistema. Si seleccionas Pi, el CLI conserva además su comprobación separada del paquete Pi.

## Diagnóstico y límites de carga

Doctor muestra la ruta del canon, la ruta del archivo local, si este está instalado, pendiente o desactualizado, su tamaño normalizado y si la sección proyectada coincide. No imprime el cuerpo ni afirma que el modelo esté siguiendo el estilo. Si hay diferencias, sincroniza; si no puede leer un archivo, revisa la ruta y los permisos.

«Global» significa ámbito de usuario, no prioridad absoluta. La configuración de proyecto, las instrucciones superiores y las opciones del runtime pueden cambiar lo que llega al modelo:

- **Claude Code:** Stack usa CLAUDE.md y conserva el output-style seleccionado. Los estilos nativos y las excepciones de contexto de subagentes siguen aplicándose. [Memoria y reglas](https://code.claude.com/docs/en/memory), [output styles](https://code.claude.com/docs/en/output-styles), [contexto de subagentes](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup).
- **Codex:** un `AGENTS.override.md` global no vacío puede ocultar AGENTS.md. Doctor avisa sin editarlo. Comprueba la versión instalada y los límites de carga; Stack no cambia `personality` ni reemplaza las instrucciones base. [Carga de AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- **OpenCode:** la proyección usa AGENTS.md, no un prompt de agente ni la opción `instructions`. Las versiones V1 y V2 difieren; no presupongas que una opción de una versión funciona igual en otra. [Reglas V1](https://opencode.ai/docs/rules/), [instrucciones V2](https://opencode.ai/v2/docs/instructions).
- **Pi:** Stack proyecta esta sección independiente al recomponer las secciones compartidas. El paquete Pi adoptado ya no añade un fallback propio con `Communication Style` en español. Sus agentes que heredan contexto de proyecto pueden recibir también la sección proyectada y deben conservar sus formatos técnicos obligatorios. Las opciones upstream que deshabilitan archivos de contexto o cambian su precedencia dependen de la versión. [Archivos de contexto de Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md).

La coincidencia de archivos y la conservación durante el bootstrap no demuestran carga nativa ni una calidad concreta de redacción. Comprueba el resultado en una sesión nueva de tu runtime autenticado, incluyendo un encargo de formato estricto. No se garantiza herencia uniforme por todos los subagentes ni una voz idéntica entre modelos.
