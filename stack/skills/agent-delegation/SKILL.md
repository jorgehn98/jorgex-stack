---
name: agent-delegation
description: Regla universal de delegación entre subagentes. Usar cuando durante una tarea aparezca trabajo que pertenece a otro especialista y no deba resolverse en el mismo scope.
---

# Agent Delegation

## Regla universal

Si durante tu tarea encuentras trabajo que pertenece a otro especialista, **no lo absorbas**. Haz solo tu parte y reporta el resto.

Importante sobre el mecanismo:

- Tú (subagente) **no lanzas a otros subagentes**. Solo el agente principal (orquestador) puede invocarlos.
- No te salgas de tu scope para "ayudar". Si algo no te corresponde, lo dejas sin hacer y lo delegas.
- Las delegaciones van **en tu output final**, en el formato de abajo. El orquestador las lee y decide a quién invocar.

## Agentes disponibles

| Agente | Scope | Delega aquí cuando aparezca... |
|---|---|---|
| `implementer` | escribe código de producción | falta código para que algo funcione; hay que implementar el cambio real |
| `tester` | escribe/ejecuta tests | faltan tests, hay tests rotos por un cambio de contrato, o hay que verificar comportamiento |
| `translator` | traducciones, locales, multiidioma | strings hardcodeadas visibles, locales desincronizados, copy en varios idiomas |
| `docs-maintainer` | documentación (/docs y docs site público) | el cambio deja docs desactualizadas o requiere nueva documentación |
| `backend-analyst` | análisis backend (read-only) | hace falta mapear servicios, DB, APIs o riesgos backend antes de actuar |
| `frontend-analyst` | análisis frontend (read-only) | hace falta mapear componentes, estado, rendering o riesgos de UI antes de actuar |
| `security-auditor` | seguridad y privacidad (read-only) | auth, permisos, secretos, datos sensibles, validación de input, webhooks |
| `code-reviewer` | calidad de código vs guías (read-only) | hace falta revisar el diff contra las reglas del proyecto y detectar bugs |
| `code-simplifier` | simplificación (read-only, propone) | el código introduce complejidad que merece simplificarse |
| `silent-failure-hunter` | manejo de errores (read-only) | hay try/catch, fallbacks, errores silenciados o flujos async que auditar |
| `comment-fixer` | comentarios (escribe SOLO comentarios, los corrige directamente) | hay comentarios/docstrings nuevos o cambiados que corregir |
| `test-analyzer` | cobertura de tests (read-only) | hay que evaluar si los tests cubren bien lo cambiado (analiza, NO escribe) |
| `type-design-analyzer` | diseño de tipos/invariantes (read-only) | cambian tipos, interfaces, schemas o contratos públicos |
| `engram` | lectura de memoria (read-only) | hace falta recuperar contexto, decisiones o trabajo previo de memoria |

Nota: `test-analyzer` analiza cobertura pero no escribe tests; escribir los tests recomendados es de `tester`.

## Formato obligatorio

Una línea por delegación, al final de tu output:

```markdown
→ [agente]: [trabajo pendiente] — [archivos/rutas] — [inputs mínimos]
```

## Ejemplos

- `implementer` detecta tests desactualizados → `tester`
- `implementer` detecta strings hardcodeadas o locales nuevos → `translator`
- `tester` detecta que falta código de producción → `implementer`
- cualquier agente detecta auth, permisos o datos sensibles → `security-auditor`
- cualquier agente detecta cambio documental relevante → `docs-maintainer`
- `test-analyzer` detecta gaps de cobertura → `tester` (que los escribe)

## Regla de conflicto

Si una task mezcla varios scopes, considéralo un problema de planificación. Ejecuta solo tu parte y devuelve las delegaciones pendientes en tu output final para que el orquestador las reparta.
