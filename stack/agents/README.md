# Agentes canónicos

## Roles

| Agente | Función | Acceso |
|---|---|---|
| implementer | Cambio acotado con sus pruebas y documentación local | Escritura, shell |
| generalist | Documentación, traducción o tareas mecánicas acotadas | Escritura, shell |
| analyst | Una pregunta concreta sobre el código antes de decidir | Solo lectura |
| reviewer | Corrección, cobertura, tipos, errores y comentarios de un candidato | Solo lectura |
| security-auditor | Autorización, permisos, datos sensibles y fronteras de confianza | Solo lectura |
| simplifier | Complejidad material de un cambio, con `lean-code` | Solo lectura |

El principal es el nativo de cada runtime y usa la skill `orchestrator`; no hay agente primary propio.

## Formato

- Frontmatter: `name`, `description`, `mode`, `readonly`, `bash`, `spawn`. Sin tier, modelo ni esfuerzo de fábrica.
- Cuerpo en inglés, por secciones: `Goal`, `Inputs`, criterios del dominio, `Limits`, `Result`. Se omite la sección que quede vacía.
- Los adapters proyectan el formato nativo; modelos y esfuerzos son preferencias personales por runtime.

## Reglas

- Los lectores no tienen shell general ni subdelegan; reciben diff e historia del coordinador.
- El reviewer reporta comentarios; el implementer los corrige.
- Simplifier es siempre lector. Una simplificación directa se asigna al implementer con `lean-code`, sin review previa.
- Los permisos efectivos se comprueban en cada runtime: un prompt de solo lectura no sustituye una restricción que el runtime sí puede aplicar.
- No se modifican builtin del proveedor ni se mantienen aliases de roles retirados.

## Procedencia de los criterios

| Agente | Fuentes anteriores |
|---|---|
| implementer | implementer, tester, política TDD |
| reviewer | code-reviewer, test-analyzer, type-design-analyzer, silent-failure-hunter, comment-fixer |
| generalist | docs-maintainer, translator |
| analyst | codebase-analyst |
| security-auditor | security-auditor |
| simplifier | code-simplifier, lean-code |
