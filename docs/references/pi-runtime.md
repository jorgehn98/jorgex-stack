# Pi oficial y extensiones

Stack utiliza el host oficial Pi y sus gestores nativos. No stage privado, lock derivado, runner de proyección, pins/históricos, receipt de provider/runtime ni capability compartida entre repos. Los paquetes conservan la integridad estándar de su gestor; Stack no construye una segunda attestation.

Aplicar configuración deliberadamente ejecuta `pi update --all` y registra paquetes sin pins: pi-subagents, @juicesharp/rpiv-ask-user-question, pi-web-access, @gotgenes/pi-permission-system, gentle-engram, @narumitw/pi-goal y compact-tools. Stack comprueba el registro nativo y comunica fallos parciales; no poda entradas npm ajenas ni deshace toda la operación si falla una extensión. compact-tools es el paquete visual independiente del repo Pi: su publicación corresponde al titular y es prerrequisito de instalación desde registry, no queda probada por un pack local.

Stack copia la cabecera local `stack/assets/pi/jorgex-header.ts` a `~/.pi/agent/extensions/jorgex-header.ts`, no la instala como otro paquete. Pi conserva tema/defaultProvider/defaultModel/defaultThinkingLevel elegidos por usuario. Herdr no se instala ni modifica. Agentes en `~/.pi/agent/agents`; skills comunes en `~/.agents/skills`; instrucciones globales en `~/.pi/agent/AGENTS.md`. Las variables nativas pueden cambiar rutas.

Engram usa tools/hooks oficiales de gentle-engram, sin MCP adicional ni variante TypeBox de Stack. El corte explícito retira jorgex-pi con el gestor nativo; un Engram MCP personalizado bloquea la retirada selectiva y exige resolución explícita, nunca se borra por inferencia. No hay migración universal de contratos antiguos.

Browser Control se registra como MCP stdio; su proveedor posee relay/extension/attach. Ver [browser](browser-automation.md). Pi RPC consulta modelos y el estado activo sin cambiarlo; [modelos](models.md).

## Permisos y límites

**Carga con pnpm aislado:** se reprodujo un fallo de resolución de `p-limit` al cargar pi-web-access0.35.0 con Pi1.0.2, también mediante el bin publicado. El seguimiento está en [Pi#8092](https://github.com/earendil-works/pi/issues/8092) y [PR#8112](https://github.com/earendil-works/pi/pull/8112). Registrar el paquete no demuestra que cargue; no se considera resuelto hasta verificar una release corregida. Stack no añade dependencias, hoisting ni un loader privado para ocultarlo.

Pi utiliza el gestor configurado por el usuario. Si es pnpm11, su espera predeterminada de24h puede seleccionar una versión anterior a `latest`; Stack no desactiva esa protección ni promete haber probado una release que el gestor no instaló.

Lectores Stack usan tools `read, grep, find, ls`; implementer/generalist incluyen bash/edit/write. Sin delegación anidada. Pi tiene seis archivos propios, no modifica builtin del proveedor. El sistema de permisos es extensión nativa; doctor lee su configuración y no afirma enforcement. [Permisos](permissions.md).

**Contexto de los subagentes:** pi-subagents arranca los agentes propios con prompt limpio. Cada uno declara `inheritProjectContext` e `inheritGlobalContext` para recibir los `AGENTS.md` de proyecto y global, y `skills: lean-code` cuando su prompt la nombra; no heredan el catálogo completo de skills.

**Timeout temporal de dos horas:** al Aplicar Configuración/Todo, Stack siembra `timeoutMs: 7200000` en la configuración nativa `~/.pi/agent/extensions/subagent/config.json` **solo si el campo está ausente**. Conserva cualquier elección previa (también si vale dos horas), sin reclamarla por igualdad, y los demás campos. Hay backup antes de modificar un archivo existente; reaplicar no produce cambios. Desinstalar retira únicamente el campo creado por Stack que siga valiendo 7200000; un override personal se conserva.

No es infinito ni modifica ahora instalaciones personales. La comprobación del paquete oficial pi-subagents 0.76.0 acredita la ruta y un entero positivo hasta 2147483647; omisión/0/false no desactivan el plazo. Este default sustituye el backstop de foreground y single-agent async cuando no hay elección explícita de llamada/frontmatter; esas elecciones mantienen la prioridad nativa del proveedor. No impone deadline top-level a compuestos async ni reemplaza los defaults de sus hijos. No cambia `bg_wait`, `toolTimeoutMs`, `httpIdleTimeoutMs`, plazos de comandos/pruebas, modelos ni permisos/condiciones de la sesión padre. La limitación sigue siendo del proveedor: retomar el modo sin deadline cuando upstream lo acredite, sin fork, wrapper o supervisor.

Doctor no instala/resuelve versiones ni prueba memorias. Desinstalar conserva host, DB/sesiones/credenciales y Engram por defecto; retira solo recursos propios según manifest, con backup. Ver [preservación](../../README.md#preservación-y-retirada). Smokes sintéticos de composición no certifican todo el Memory Protocol ni una instalación personal Windows.
