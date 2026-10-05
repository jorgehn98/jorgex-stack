# Pi oficial y extensiones

Stack utiliza el host oficial Pi y sus gestores nativos. No stage privado, lock derivado, runner de proyección, pins/históricos, receipt de provider/runtime ni capability compartida entre repos. Los paquetes conservan la integridad estándar de su gestor; Stack no construye una segunda attestation.

Aplicar configuración deliberadamente ejecuta `pi update --all` y registra paquetes sin pins: pi-subagents, @juicesharp/rpiv-ask-user-question, pi-web-access, @gotgenes/pi-permission-system, gentle-engram, @narumitw/pi-goal y compact-tools. Stack comprueba el registro nativo y comunica fallos parciales; no poda entradas npm ajenas ni deshace toda la operación si falla una extensión. compact-tools es el paquete visual independiente del repo Pi: su publicación corresponde al titular y es prerrequisito de instalación desde registry, no queda probada por un pack local.

Stack copia la cabecera local `stack/assets/pi/jorgex-header.ts` a `~/.pi/agent/extensions/jorgex-header.ts`, no la instala como otro paquete. Pi conserva tema/defaultProvider/defaultModel/defaultThinkingLevel elegidos por usuario. Herdr no se instala ni modifica. Agentes en `~/.pi/agent/agents`; skills comunes en `~/.agents/skills`; instrucciones globales en `~/.pi/agent/AGENTS.md`. Las variables nativas pueden cambiar rutas.

Engram usa tools/hooks oficiales de gentle-engram, sin MCP adicional ni variante TypeBox de Stack. El corte explícito retira jorgex-pi con el gestor nativo; un Engram MCP personalizado bloquea la retirada selectiva y exige resolución explícita, nunca se borra por inferencia. No hay migración universal de contratos antiguos.

Browser Control se registra como MCP stdio; su proveedor posee relay/extension/attach. Ver [browser](browser-automation.md). Pi RPC consulta modelos y el estado activo sin cambiarlo; [modelos](models.md).

## Permisos y límites

Lectores Stack usan tools `read, grep, find, ls`; implementer/generalist incluyen bash/edit/write. Sin delegación anidada. Pi tiene seis archivos propios, no modifica builtin del proveedor. El sistema de permisos es extensión nativa; doctor lee su configuración y no afirma enforcement. [Permisos](permissions.md).

**Timeout:** pi-subagents 0.73.1 instalado admite `timeoutMs` positivo hasta 2147483647; omisión/0/false no acreditan ejecución ilimitada. Stack no impone un deadline total propio de 30 minutos, pero tampoco configura un número enorme ni promete infinito. El límite efectivo pertenece al proveedor y al encargo. Retomar esta petición cuando el proveedor oficial acredite un modo sin deadline; no usar fork/harness ni configuración personal para suplirlo.

Doctor no instala/resuelve versiones ni prueba memorias. Desinstalar conserva host, DB/sesiones/credenciales y Engram por defecto; retira solo recursos propios según manifest, con backup. Ver [preservación](../../README.md#preservación-y-retirada). Smokes sintéticos de composición no certifican todo el Memory Protocol ni una instalación personal Windows.
