# Estilo global de escritura

Stack puede añadir tus preferencias de escritura a las instrucciones globales de Claude Code, Codex, OpenCode y Pi. Es opcional: el archivo no se crea automáticamente y no requiere instalar Humanizer, gentle-ai ni otra skill.

## Configurar y actualizar

Crea `~/.jorgex-stack/writing-style.md` como archivo UTF-8. `~` representa tu directorio de usuario. Un ejemplo sintético:

```markdown
Usa español de España, natural y directo.
Conecta las ideas en párrafos breves y explica el porqué cuando ayude a decidir.
Evita las fórmulas de cortesía repetitivas. Respeta siempre el formato solicitado.
```

Después, sincroniza los runtimes que utilices:

```bash
pnpm dlx jorgex-stack sync --agents claude-code,codex,opencode,pi --mode human
pnpm dlx jorgex-stack doctor --agents claude-code,codex,opencode,pi
```

La lista selecciona los destinos; no instala runtimes que falten. También se aplica durante `install`. Cada cambio en la fuente requiere otra sincronización y una sesión nueva del runtime. No hay selector de estilos, recarga en caliente ni estilos distintos por runtime.

Si partes de una skill de redacción, extrae únicamente preferencias de idioma, tono, claridad y estructura. Deja en la skill los pasos de trabajo, herramientas, preguntas obligatorias y formatos de entrega específicos. No copies su frontmatter, ejemplos privados o instrucciones de activación como si fueran preferencias permanentes.

Stack limita esta capa a la prosa dirigida al usuario. El encargo, los formatos de máquina, el código, las instrucciones técnicas y las autorizaciones conservan sus reglas. La capa no cambia modelos, permisos, agentes primarios ni configuraciones nativas de personalidad.

## Fuente, destinos y validación

La fuente pertenece al usuario. Stack copia una instantánea de su texto normalizado a la sección independiente `writing-style`, fuera de las secciones de sistema, Engram y navegador. Conserva el contenido ajeno a los marcadores gestionados.

| Runtime | Destino global habitual |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Pi | `~/.pi/agent/AGENTS.md` |

Los adapters resuelven los destinos efectivos. El texto proyectado pasa a formar parte del contexto que recibe el modelo cuando el runtime carga ese archivo. La fuente, las proyecciones y sus backups son archivos locales; no se incorporan al canon ni al paquete público de Stack.

Install/sync, sus dry-runs y el sync interno de update validan la fuente antes de sus escrituras. Un directorio, un error de lectura, UTF-8 inválido o texto que contenga `jorgex:` producen un error; no se interpretan como desactivación. Se normalizan saltos de línea y espacios exteriores, conservando el contenido interior. Los enlaces escritos en el Markdown no se descargan ni se expanden como imports.

## Desactivar, desinstalar y recuperar

- **Desactivar:** deja el archivo vacío o solo con espacios, o muévelo fuera de la ruta configurada; después ejecuta sync. Se retira únicamente la sección de estilo. Puedes guardar la fuente en otra ubicación para recuperarla.
- **Modo programático:** install/sync con `--mode programmatic` retira la sección aunque la fuente siga presente. Volver a `--mode human` permite proyectarla otra vez. En Pi esta selección filtra la capa de estilo; no sustituye el prompt base de JorgeX Pi.
- **Uninstall:** retira la proyección conforme al ownership y los backups del lifecycle existente. Conserva la fuente privada y el contenido ajeno.
- **Restore:** restaura los destinos de un backup mediante el comando habitual. Puede recuperar una proyección antigua; el siguiente sync vuelve a aplicar la fuente actual. No restaura ni modifica la fuente.

Uninstall y restore no necesitan leer la fuente y no quedan bloqueados si está dañada. Los backups pueden contener el estilo anterior; trátalos como parte de tu configuración privada. Consulta también el [lifecycle de Pi](pi-runtime.md).

## Probar en un destino aislado

Con `--target-dir`, la única fuente es `<target-dir>/writing-style.md`. Stack no busca el estilo en el HOME real y rechaza enlaces de esa fuente que salgan del destino. Prepara allí un ejemplo sintético:

```bash
pnpm dlx jorgex-stack sync --agents codex --target-dir ./prueba-estilo --mode human --dry-run
pnpm dlx jorgex-stack sync --agents codex --target-dir ./prueba-estilo --mode human
pnpm dlx jorgex-stack doctor --agents codex --target-dir ./prueba-estilo
```

El dry-run valida y planifica sin escribir. Para los runtimes de archivos, usa un destino por runtime. En Pi la proyección aislada se encuentra bajo `<target-dir>/pi-agent/AGENTS.md`.

El diagnóstico aislado usa modo humano por defecto. Si preparaste una proyección programática, pasa también `--mode programmatic` a doctor para comparar contra la ausencia esperada del estilo:

```bash
pnpm dlx jorgex-stack doctor --agents codex --target-dir ./prueba-estilo --mode programmatic
```

Sin un modo explícito, el diagnóstico del HOME utiliza la preferencia guardada.

El diagnóstico de Stack con `doctor --target-dir` se limita explícitamente al estilo: no equivale a un doctor completo del sistema. Si seleccionas Pi, el CLI conserva además su comprobación separada del paquete Pi.

## Diagnóstico y límites de carga

Doctor muestra la ruta de la fuente, si está configurada o desactivada, su tamaño normalizado y si la sección proyectada coincide. No imprime el cuerpo ni afirma que el modelo esté siguiendo el estilo. Si hay diferencias, revisa la fuente y sincroniza; si no puede leer un archivo, revisa la ruta y los permisos.

«Global» significa ámbito de usuario, no prioridad absoluta. La configuración de proyecto, las instrucciones superiores y las opciones del runtime pueden cambiar lo que llega al modelo:

- **Claude Code:** Stack usa CLAUDE.md y conserva el output-style seleccionado. Los estilos nativos y las excepciones de contexto de subagentes siguen aplicándose. [Memoria y reglas](https://code.claude.com/docs/en/memory), [output styles](https://code.claude.com/docs/en/output-styles), [contexto de subagentes](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup).
- **Codex:** un `AGENTS.override.md` global no vacío puede ocultar AGENTS.md. Doctor avisa sin editarlo. Comprueba la versión instalada y los límites de carga; Stack no cambia `personality` ni reemplaza las instrucciones base. [Carga de AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- **OpenCode:** la proyección usa AGENTS.md, no un prompt de agente ni la opción `instructions`. Las versiones V1 y V2 difieren; no presupongas que una opción de una versión funciona igual en otra. [Reglas V1](https://opencode.ai/docs/rules/), [instrucciones V2](https://opencode.ai/v2/docs/instructions).
- **Pi:** JorgeX Pi conserva esta sección independiente al recomponer las secciones compartidas. Sus agentes que heredan contexto de proyecto pueden recibirla también; deben conservar sus formatos técnicos obligatorios. Opciones upstream que deshabilitan archivos de contexto o cambian su precedencia dependen de la versión. [Archivos de contexto de Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md).

La coincidencia de archivos y la conservación durante el bootstrap no demuestran carga nativa ni una calidad concreta de redacción. Comprueba el resultado en una sesión nueva de tu runtime autenticado, incluyendo un encargo de formato estricto. No se garantiza herencia uniforme por todos los subagentes ni una voz idéntica entre modelos.
