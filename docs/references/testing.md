# Verificación proporcional

Implementer posee producción y pruebas. Política de testing/TDD en [su skill](../../stack/skills/implementer/SKILL.md): escoger riesgo real, protección existente y seam más cercano; no suite/snapshot de prosa por ceremonia ni cadena tester/implementer.

## Comandos del repo

```text
pnpm exec vitest run tests/<archivo>.test.ts
pnpm typecheck
pnpm build
pnpm test
pnpm test:property
```

Vitest limita discovery a `tests/`; property pilot conserva invariantes útiles de merge TOML (no contratos de calidad retirados). No coverage pilot exclusivo de receipts, quality-verifier, lint ni qa:quality. Suite integrada cuando el candidato sea coherente; pruebas focales por bloque, sin repetir todo por archivo. Tests de host OpenCode opt-in requieren binario real compatible y hogar aislado; skip no acredita smoke. Catálogos autenticados y browser personal necesitan consentimiento específico. El recorrido en navegador de `Verify` del [orchestrator](../../stack/skills/orchestrator/SKILL.md) es evidencia añadida sobre lo integrado y no sustituye ni justifica borrar los tests de la lista «Test first for» de `implementer`; en duda, se añade el test.

Toolchain declarada en package.json, con Node 24 en Actions/pnpm 11.1.1. Verificar preparado exacto antes de aislar entorno, sin descarga/switch implícitos. Acotar setup/ejecución; disponer teardown automático antes de temporales, detener solo procesos propios y verificar cleanup incluso al fallar. HOME/stage fuera del workspace, con capacidad/filesystem adecuados; no copiar auth personal para hacer pasar smokes.

## Runtime y caché de Actions

Quality gate de PR ejecuta instalación frozen, typecheck, tests y build del Stack restante. Un solo build por lane, sin pi-artifact/paridad/pins. Publicación valida el candidato y reutiliza su dist, conserva OIDC/provenance; la versión se prepara en el PR, sin auto-patch. Node 24, setup-node sin instalación implícita de gestor y caché pnpm solo tras prepararlo. Acciones fijadas por SHA; checkouts de lectura no preservan credenciales. Checks requeridos deben corresponder al candidato/contexto actual; no sustituir un gate externo por texto ni afirmar que no existe porque `gh pr checks` esté vacío.

Ver [publicación](../../README.md#publishing) y [workflow canónico](../../stack/skills/orchestrator/SKILL.md). No se genera recibo privado de calidad ni export para otro runtime.
