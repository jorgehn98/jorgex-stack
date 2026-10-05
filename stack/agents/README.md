# Agentes canónicos

Seis roles: implementer, analyst, reviewer, security-auditor, simplifier y generalist. El principal es el nativo de cada runtime y usa la skill orchestrator; no hay un agente primary propio.

Cada Markdown declara nombre, descripción y capacidades, seguido del prompt. Sin tier, modelo o esfuerzo de fábrica. Los adapters proyectan el formato nativo y las preferencias personales se configuran por runtime, sin copiar cuerpos.

`readonly`, `bash` y `spawn` describen la capacidad por defecto. Analyst/reviewer/security-auditor y simplifier en review son lectores, sin shell general ni subdelegación; reciben el diff del coordinador. Implementer posee producción y pruebas. Generalist resuelve tareas acotadas sencillas. Simplifier siempre es lector; implementer aplica simplificaciones autorizadas con lean-code. La simplificación directa no requiere una review previa ni otro perfil.

Los permisos efectivos deben comprobarse en cada runtime: un prompt de solo lectura no sustituye una restricción que el runtime sí permite aplicar. No modificar builtin del proveedor ni mantener aliases históricos de los roles retirados.
