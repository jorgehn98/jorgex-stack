# JorgeX Stack

Configuración compartida para **Claude Code, Codex CLI, OpenCode v2 y Pi oficial**: once skills locales, seis subagentes e integraciones nativas. Stack no instala un segundo runtime Pi ni mantiene contratos/receipts privados de proveedores.

## Uso

Requiere **Node >= 22.5** y pnpm. Browser Control requiere Node >= 22.19. Instala los runtimes que quieras por sus canales oficiales y ejecuta:

```sh
pnpm add -g jorgex-stack
jorgex-stack
```

También puedes abrir el menú con `pnpm dlx jorgex-stack`. No admite subcomandos ni flags (tampoco `--version` o `--yes`) ni modo headless. Sin terminal interactivo no modifica archivos ni espera entrada. La versión de distribución está en `package.json` y en el registro, no en un alias del instalador.

El menú ofrece **Instalar/configurar, Actualizar, Doctor y Desinstalar**, con secciones Todo, Skills compartidas, Configuración por runtime y Subagentes. Selecciona destino/unidad y **Aplicar**; navegar o volver no ejecuta instalaciones. La edición de modelo/esfuerzo tiene su propio **Guardar**, independiente de Aplicar. Cambios ya guardados permanecen al volver; borradores sin guardar se descartan al salir del editor. Un fallo deja visibles las unidades aplicadas/pendientes, sin rollback global ni reintentos automáticos.

Los runtimes ausentes no se instalan al abrir una pantalla. Actualizar configuración utiliza canales nativos (`claude update`, `codex update`, `opencode upgrade`, `pi update --all` y registro de paquetes oficiales); actualizar solo skills o agentes no actualiza herramientas. Doctor compara configuración local sin instalar, descargar, iniciar browser ni escribir memorias; no certifica carga efectiva, acceso a modelos o enforcement de permisos.

## Canon compartido

Skills: **diagnose, grilling, lean-code, mcp-builder, orchestrator, retro, skill-creator, to-spec, visual-director, what y xreview**. Se copian completas desde `stack/skills` a `~/.agents/skills`, sin updater de repositorios externos ni pins de skills. Pi/Codex/OpenCode las descubren nativamente; Claude usa enlaces por skill desde su ruta nativa, no otra copia.

Subagentes: **implementer, analyst, reviewer, security-auditor, simplifier y generalist**. El principal pertenece al runtime y carga orchestrator como skill. Sin tiers ni modelos/esfuerzos de fábrica; tampoco defaultProvider/defaultModel/defaultThinkingLevel impuestos a Pi. Implementer posee código y pruebas; simplifier siempre lector. Los modelos se guardan por agente en su archivo nativo, preservando cuerpo y permisos.

Un solo perfil sirve al uso humano y programático. Las APIs nativas (SDK/CLI, Codex app-server, OpenCode v2 server, Pi RPC) permiten operaciones estructuradas según cada host, no takeover universal de una TTY abierta. Herdr no se instala/configura: una integración personal existente se conserva.

Workflow canónico: [orchestrator](stack/skills/orchestrator/SKILL.md). No se duplica aquí. Visual Director, retro y what respetan sus límites de invocación manual. [Visual Director activo](stack/skills/visual-director/README.md) es portable; su [dossier histórico](docs/research/visual-director/README.md) no es dependencia de runtime ni se incluye en el paquete npm.

## Configuración e integraciones

| Runtime | Recursos Stack e integración |
| --- | --- |
| Claude Code | Subagentes nativos, enlaces de skills, `~/.agents/AGENTS.md` con puente mínimo en `~/.claude/CLAUDE.md`; plugin/MCP oficial Engram. Sin browser adicional. |
| Codex | Agentes TOML, skills compartidas, instrucciones globales y permisos fresh; plugin/hooks/MCP oficiales Engram. Sin browser desktop añadido. |
| OpenCode v2 | Agentes/permisos nativos, server `opencode.json(c)`, cliente `cli.json`, panel local `./tui/subagents`; setup oficial Engram completo y Browser Control. V1 no soportado. |
| Pi oficial | Agentes, instrucciones, cabecera local y configuración MCP; extensiones nativas instaladas por Pi, incluido Engram y compact-tools. Sin tema impuesto ni instalador jorgex-pi. |

Las rutas efectivas respetan configuración nativa/variables del runtime. Context7 usa placeholder vacío para que cada usuario conecte su cuenta; nunca se distribuyen credenciales. [Estilo de escritura](docs/references/writing-style.md) se proyecta en todos los runtimes, sin overlay programático.

### Engram oficial

Aplicar instalación/actualización de configuración resuelve el **último release estable oficial**. Verifica metadata viva del asset publicado, nombre/plataforma, tamaño y SHA-256 antes de activar el binario. Sin red o metadata válida falla cerrado, sin fallback estático. Si ya está vigente no lo redescarga. Un binario anterior solo se sustituye tras consentimiento y export de memorias + backup; se instala en `~/.local/bin/engram` o equivalente, sin Brew/Go y sin tocar `~/.engram`.

Claude/Codex/OpenCode usan el setup oficial completo; Pi usa `gentle-engram` como tools/hooks nativos, no Engram MCP adicional. Stack no parchea el plugin, TypeBox ni `<private>`. En OpenCode retira por configuración el monitor extra `opencode-subagent-statusline` y utiliza su panel v2; plugin/hooks/MCP Engram quedan intactos. La limitación upstream de captura con `<private>` anidado no se considera corregida: [reporte original](https://github.com/Gentleman-Programming/engram/issues/1558#issuecomment-5896556683). Tests de composición no prueban todo el Memory Protocol ni una instalación personal Windows.

### Browser y modelos

**Browser Control** solo en OpenCode/Pi, vía CLI/MCP oficiales y extensión Chromium del proveedor. Necesita adopción explícita de pestaña; no fallback a Playwright o DevTools. Stack no supervisa el relay ni adjunta perfiles. [Límites y seguridad](docs/references/browser-automation.md).

Catálogos nativos: Claude SDK oficial, Codex app-server, OpenCode v2 `/api/model`, Pi RPC. Si faltan autenticación/catálogo, se muestra aviso y permite herencia o ID manual. Solo esfuerzos acreditados para el modelo; sin catálogo curado ni promesa de entitlement. [Modelos](docs/references/models.md).

## Preservación y retirada

Antes de cambiar configuración existente hay backup en `~/.jorgex-stack/backups`. Marcadores Markdown y upserts JSON/TOML preservan contenido ajeno; archivos propios se registran en un manifest mínimo local. Configuración existente de permisos no se reimpone; drift se informa sin volcar contenido. Un archivo ilegible, manifest inválido, ruta enlazada o conflicto de ownership bloquea la unidad afectada, no se interpreta como estado vacío.

Desinstalar retira solo recursos gestionados seleccionados, con confirmación y backup; las skills tienen alcance **global compartido**, anunciado antes de aplicar. Conserva runtimes, herramientas compartidas, Engram por defecto, DB/memorias, credenciales, sesiones, browser/perfiles y datos ajenos. Un archivo propio puede retirarse con backup aunque haya sido modificado; una entrada de configuración modificada se conserva/libera. El manifest no autentica propiedad frente a manipulación: revisa/restaura su backup antes de mutar si sospechas inconsistencias.

No hay migrador universal para instalaciones históricas. La retirada explícita del paquete jorgex-pi y de scripts/plugins registrados propios no migra sesiones ni historia. Los backups pueden recuperarse manualmente en sus rutas originales después de revisar el contenido; no hay comando público Restore.

## Desarrollo y CI

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/cli.test.ts
pnpm typecheck
pnpm build
pnpm test
pnpm cli
```

Toolchain de desarrollo en `package.json`; Node 24 en Actions y pnpm 11.1.1. Sin lint/qa:quality. [Testing](docs/references/testing.md). El paquete distribuye un solo bin (`dist/cli.js`) y `stack/`, con licencias/notices; no export quality-verifier, receipts/capabilities privados ni dossier de investigación. `Quality gate` ejecuta typecheck/tests/build reales de PR; publicación también valida el candidato.

### Publicación

El workflow [publish.yml](.github/workflows/publish.yml) publica al merge/push a `main` cuando hay cambios publicables: `src/`, `stack/`, package/lock y configuración de build. Docs/tests/work no generan versión por sí solos. Major/minor se decide explícitamente en el PR por cambios de contrato; el auto-bump solo busca el primer **patch libre** si la versión ya existe. El candidato major no promete un número futuro publicado.

La validación resuelve una SHA inmutable y comprueba typecheck/tests/build antes de publicar; preflight solo omite trabajo cuando el diff acumulado desde el tag válido no contiene producto. Referencias/tag/diff inválidos fallan cerrado. Una run obsoleta no publica otro HEAD. Auto-bump exige diff real exclusivamente de `package.json.version`, sin archivos ajenos; solo el commit automático lleva `[skip ci]` para evitar recursión. Se conserva la guarda cuando el diff mezcla workflows con producto y el auto-bump no es elegible.

Publicación npm por OIDC/provenance, sin token npm guardado; el App temporal de `stack-release` solo hace el bump del repo, no publica Pi. Checkouts de lectura no conservan credenciales; permisos separados para validación, bump, publicación y tag. La excepción a pnpm son `npm pack --dry-run --ignore-scripts` y `npm publish --ignore-scripts --provenance` en ese workflow. Concurrencia de publish no cancela una publicación activa; no cancelarla manualmente.

**Recuperación:** iniciar una run nueva de `workflow_dispatch` sobre `main`, con `release_sha` de 40 hex de la SHA aceptada/publicada, ancestro de main. No rerun de una ejecución rechazada ni refs mutables. Si no se proporciona SHA y la versión ya existe pero falta tag, falla: usar la SHA realmente publicada, no etiquetar HEAD por intuición. La recuperación no hace otro bump ni evita la guarda de permisos de workflows; si requiere intervención elevada, corresponde al titular. Tag solo sobre SHA validada y tras publish success/skipped pertinente; un tag existente con SHA diferente bloquea. Readback público de npm observa disponibilidad sin modificar publicación/tag.

[release-app-check.yml](.github/workflows/release-app-check.yml) es un smoke manual de autenticación/alcance en main, sin checkout/push/publicación. Requiere autorización independiente; no usar publish como probe de credenciales. Trusted Publisher, entorno release, secretos y rulesets solo los administra el titular.

## Referencias

- [Pi oficial y extensiones](docs/references/pi-runtime.md)
- [Browser Control](docs/references/browser-automation.md)
- [Modelos](docs/references/models.md)
- [Permisos](docs/references/permissions.md)
- [Límites Claude](docs/references/claude-code-limits.md)
- [Estilo](docs/references/writing-style.md)
- [Testing](docs/references/testing.md)
- [Entrada al workflow](docs/references/sdd-workflow.md)
- [Investigación histórica](docs/research/README.md)

MIT para Stack; preservar licencias/atribución incluidas de skills y terceros. El dossier conserva evidencia histórica y material externo, no otorga derechos de uso adicionales sobre assets.
