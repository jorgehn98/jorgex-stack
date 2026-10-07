# JorgeX Stack

Stack configura Claude Code, Codex, **OpenCode v2** y **Pi oficial** mediante sus mecanismos nativos. `stack/` es el canon instalable; `src/components/` describe recursos compartidos y `src/adapters/` sus formatos/rutas. No hay segundo instalador Pi, bootstrap privado, pins de proveedores ni snapshots/paridad entre repositorios.

## Producto y límites

- Entrada pública única: `jorgex-stack`, menú Clack con Instalar/configurar, Actualizar, Doctor y Desinstalar. Sin subcomandos, flags ni operación headless. Abrir/navegar no instala; Aplicar y Guardar son acciones explícitas.
- Once skills locales y seis subagentes; principal nativo + skill orchestrator. Sin primary propio, tiers, modelos/esfuerzos predeterminados ni overlays humano/programático. Catálogo: [stack/agents/README.md](stack/agents/README.md) y [README](README.md).
- Skills compartidas en `~/.agents/skills`; Claude utiliza enlaces por skill y un puente global mínimo. Preservar skills/instrucciones ajenas y rechazar conflictos, archivos ilegibles o marcadores ambiguos.
- Integraciones oficiales Engram completas; install/update deliberados resuelven último release estable con metadata viva, asset publicado, tamaño y SHA-256. Sin red o evidencia válida, fallar cerrado. Antes de sustituir binario existente, consentimiento explícito y backup del binario; Stack no exporta memorias. Nunca modificar DB, memorias o sesiones desde Stack. En Claude Code, `engram setup` recibe `--protocol=slim` solo si Engram no registra ya un modo para ese runtime; un modo existente se respeta. Doctor es solo lectura.
- Browser Control nativo solo OpenCode/Pi; no Playwright, DevTools ni supervisor de relay. No perfiles autenticados o datos sensibles sin autorización. [Límites browser](docs/references/browser-automation.md).
- Pi posee host, paquetes y la aplicación de permisos; Stack proyecta agentes, MCP/configuración, cabecera local y una política de permisos solo cuando falta. compact-tools es extensión independiente, no instalador. Su publicación por el titular es prerrequisito externo: un paquete local no demuestra disponibilidad en el registro. No modificar el repo Pi por rutina.
- Configuración idempotente, backup previo y ownership mínimo local. No reclamar valores preexistentes por igualdad ni borrar contenido ajeno. Un manifest inválido bloquea mutación; no es prueba criptográfica de propiedad. Sin migrador histórico universal ni rollback entre proveedores; errores parciales visibles.
- No tocar `C:\Users\jorge\Desktop\jorgex-custom-tools`, datos de Engram, vaults, credenciales ni sesiones. Dossier Visual Director en `docs/research/visual-director/`: investigación histórica propia, no instrucciones activas. No añadir material de terceros, binarios, transcripciones ni rutas personales; no reescribir historia como contrato actual.

## Trabajo y verificación

El workflow tiene una sola fuente: [orchestrator](stack/skills/orchestrator/SKILL.md). Specs formales en `work/{nombre}/tasks/NN.md`, PRD para alcance y plan como único tablero; Engram para historia/decisiones. Implementer posee producción/pruebas y aplica simplificaciones; simplifier siempre lector. No cadena fija de especialistas, panel obligatorio ni séptimo perfil. Verificación proporcional en [testing](docs/references/testing.md).

Usar un worktree para trabajo no trivial, dentro de `worktrees/` de la raíz comprobada con Git y excluido localmente; también son válidos los worktrees nativos del runtime. No sobrescribir trabajo ni usar Git destructivo sin autorización. Mantener PR draft mientras cambia; Ready al final de implementación/verificación/review pertinente. Verificar checks requeridos y SHA candidato antes de integrar. Commit/push según autorización del encargo; merge siempre por orden explícita de Jorge. Un merge intermedio no cierra todo el objetivo.

**pnpm siempre**, excepto `npm publish` por OIDC en el workflow de publicación. Requisitos en `package.json`; verificar toolchain preparado antes de aislar HOME. No instalar/cambiar herramientas implícitamente. Comandos reales:

```text
pnpm install --frozen-lockfile
pnpm exec vitest run tests/<archivo>.test.ts
pnpm typecheck
pnpm build
pnpm test
pnpm cli
```

No hay lint ni qa:quality. Reutilizar tests de preservación, merge, backups e integridad oficial; retirar solo pruebas exclusivas de mecanismos eliminados. Antes de temporales/procesos: teardown automático, plazos acotados, almacenamiento adecuado fuera del repo para HOME/stage, detener solo procesos propios y verificar cleanup. No simular checks verdes ni cancelar publicaciones mutables.

## Publicación y CI

[Publicación](README.md#publishing): versión preparada en el PR y major/minor explícito; publicación automática de una versión nueva al merge, sin auto-patch ni commits de versión en main. Un tarball validado, OIDC, SRI de registry y tag inmutable del mismo SHA; recuperación con SHA explícita de main y coincidencia de bytes. No prometer número futuro, editar pins/hash ajenos ni publicar manualmente sin autorización. Quality gate verifica build/typecheck/tests del producto, no contratos Pi retirados. Trusted Publisher, rulesets y credenciales son configuración del titular, nunca un cambio implícito de código.

Código/identificadores y `README.md` en inglés; resto de documentación y comunicación en español. KISS, YAGNI y lean-code antes de código significativo. Verificar APIs/rutas contra fuentes reales, no inventar contratos ni enforcement de permisos. Permisos fresh sin prompts con deny solo de secretos; una configuración existente nunca se reescribe: [permisos](docs/references/permissions.md). Cero secretos en código, ejemplos, fixtures, logs y reportes. [Referencias operativas](README.md#references).
