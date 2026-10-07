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
| Claude Code | Subagentes nativos, enlaces de skills, `~/.agents/AGENTS.md` con puente mínimo en `~/.claude/CLAUDE.md` y permisos fresh; plugin/MCP oficial Engram. Sin browser adicional. |
| Codex | Agentes TOML, skills compartidas, instrucciones globales y permisos fresh; plugin/hooks/MCP oficiales Engram. Sin browser desktop añadido. |
| OpenCode v2 | Agentes/permisos nativos, server `opencode.json(c)`, cliente `cli.json`, panel local `./tui/subagents`; setup oficial Engram completo y Browser Control. V1 no soportado. |
| Pi oficial | Agentes con contexto de proyecto y global, instrucciones, cabecera local, configuración MCP y política de permisos fresh; extensiones nativas instaladas por Pi, incluido Engram y compact-tools. Sin tema impuesto ni instalador jorgex-pi. |

Las rutas efectivas respetan configuración nativa/variables del runtime. Context7 usa placeholder vacío para que cada usuario conecte su cuenta; nunca se distribuyen credenciales. [Estilo de escritura](docs/references/writing-style.md) se proyecta en todos los runtimes, sin overlay programático.

### Engram oficial

Aplicar instalación/actualización de configuración resuelve el **último release estable oficial**. Verifica metadata viva del asset publicado, nombre/plataforma, tamaño y SHA-256 antes de activar el binario. Sin red o metadata válida falla cerrado, sin fallback estático. Si ya está vigente no lo redescarga. Un binario anterior solo se sustituye tras consentimiento explícito y backup del binario, sin exportar memorias (`engram export` sigue disponible de forma nativa); se instala en `~/.local/bin/engram` o equivalente, sin Brew/Go y sin tocar `~/.engram`.

Los pasos nativos (actualizadores del runtime, registro de paquetes, setup de Engram) son síncronos y pueden tardar: cada uno se anuncia con una línea «Paso nativo en curso» que muestra solo el binario, su subcomando y, cuando lo hay, el paquete o plugin por el que va; nunca rutas, flags ni la salida del subproceso. En Claude Code, el setup de Engram se ejecuta con `--protocol=slim` para no repetir en el hook de inicio el protocolo que ya entregan las instrucciones del MCP; si Engram ya registra un modo para Claude Code (`engram setup claude-code --protocol=full|slim`), Stack lo respeta.

Claude/Codex/OpenCode usan el setup oficial completo; Pi usa `gentle-engram` como tools/hooks nativos, no Engram MCP adicional. Stack no parchea el plugin, TypeBox ni `<private>`. En OpenCode retira por configuración el monitor extra `opencode-subagent-statusline` y utiliza su panel v2; plugin/hooks/MCP Engram quedan intactos. La limitación upstream de captura con `<private>` anidado no se considera corregida: [reporte original](https://github.com/Gentleman-Programming/engram/issues/1558#issuecomment-5896556683). Tests de composición no prueban todo el Memory Protocol ni una instalación personal Windows.

### Browser y modelos

**Browser Control** solo en OpenCode/Pi, vía CLI/MCP oficiales y extensión Chromium del proveedor. Necesita adopción explícita de pestaña; no fallback a Playwright o DevTools. Stack no supervisa el relay ni adjunta perfiles. [Límites y seguridad](docs/references/browser-automation.md).

Catálogos nativos: Claude SDK oficial, Codex app-server, OpenCode v2 `/api/model`, Pi RPC. Si faltan autenticación/catálogo, se muestra aviso y permite herencia o ID manual. Solo esfuerzos acreditados para el modelo; sin catálogo curado ni promesa de entitlement. [Modelos](docs/references/models.md).

## Preservación y retirada

Antes de cambiar configuración existente hay backup en `~/.jorgex-stack/backups`. Los respaldos no se podan automáticamente: se conservan hasta una limpieza manual deliberada y pueden ocupar espacio creciente. Antes de eliminar snapshots, comprueba qué originales contienen y cuáles necesitas conservar para recuperar cambios; no los borres durante una operación activa. El manifest original se respalda una vez por operación, mientras el ownership se persiste por unidad para conservar evidencia de fallos parciales. Marcadores Markdown y upserts JSON/TOML preservan contenido ajeno; archivos propios se registran en un manifest mínimo local. Configuración existente de permisos no se reimpone; drift se informa sin volcar contenido. Un archivo ilegible, manifest inválido, ruta enlazada o conflicto de ownership bloquea la unidad afectada, no se interpreta como estado vacío. El backup previo al setup de Engram (`engram-setup`) copia solo los archivos que ese setup reescribe: `settings.json` y `.claude.json` en Claude Code; `config.toml`, `engram-instructions.md` y `engram-compact-prompt.md` en Codex; `opencode.json[c]`, `tui.json[c]` y `plugins/engram.ts` en OpenCode. Las versiones hasta 2.0.9 copiaban todos los archivos del nivel superior del directorio del runtime, incluidos credenciales (`auth.json` de Codex), historial y logs: revisa y elimina a mano los snapshots `*-engram-setup` antiguos que no necesites.

Desinstalar retira solo recursos gestionados seleccionados, con confirmación y backup; las skills tienen alcance **global compartido**, anunciado antes de aplicar. Conserva runtimes, herramientas compartidas, Engram por defecto, DB/memorias, credenciales, sesiones, browser/perfiles y datos ajenos. Un archivo propio puede retirarse con backup aunque haya sido modificado; una entrada de configuración modificada se conserva/libera. El manifest no autentica propiedad frente a manipulación: revisa/restaura su backup antes de mutar si sospechas inconsistencias.

Un archivo que ya existe en una ruta que Stack proyecta (subagentes, archivos de skills gestionadas, cabecera de Pi, recursos del cliente OpenCode) y que el manifest no registra se trata como ajeno, aunque lo instalara una versión anterior de Stack: se conserva sin tocar y tanto Aplicar como Doctor avisan de si es «idéntico al canon» o «distinto del canon». Para recuperar su gestión, aplica la unidad afectada desde Instalar / configurar o Actualizar: Stack pregunta archivo por archivo, con No por defecto. Al aceptar, un archivo distinto se respalda en un snapshot `adopt-<runtime>`, se sustituye por el canon y queda registrado como propio —un subagente adoptado conserva el modelo/esfuerzo que tuviera, igual que uno propio—; uno idéntico solo se registra, sin escritura ni backup. Desde entonces Stack lo actualiza y lo retira como cualquier recurso propio. Si respondes No, sigue siendo tuyo y el aviso se repite; Doctor no falla por ello. Enlaces simbólicos, directorios y skills completas ajenas nunca se ofrecen para adopción.

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

La versión se prepara en el PR; major/minor requieren decisión explícita de Jorge. [publish.yml](.github/workflows/publish.yml) publica automáticamente una versión nueva al merge en `main`. Una versión ya publicada y con tag válido no genera otra release, aunque cambien código o documentación: no hay auto-patch ni commits de versión posteriores al merge.

Validación con `contents:read`: SHA inmutable de main, typecheck/tests/build y un solo `pnpm pack`. Ese tarball, su identidad de paquete/versión y su SRI SHA-512 pasan a publicación por artifact. El job OIDC (`id-token:write`, sin escritura de repositorio) publica esos bytes con `npm publish --ignore-scripts --provenance` y confirma `dist.integrity` en npm. Solo entonces un job sin checkout ni ejecución de producto usa `contents:write` para crear el tag inmutable `v<versión>` del mismo SHA. No hay App de bump ni GitHub release adicional. La concurrencia no cancela publicaciones activas; tampoco cancelarlas manualmente.

**Recuperación:** `workflow_dispatch` sobre main exige `release_sha` completa (40 hex), ancestro de main. Una versión existente solo puede recuperarse si el tarball reconstruido coincide con su SRI; nunca se republica ni se mueve un tag. Un push ordinario con versión publicada pero sin tag exige esa recuperación explícita. Los reruns del job de publicación vuelven a consultar npm y omiten publish si los bytes ya coinciden; un rerun de tag conserva el SHA confirmado. Una versión nueva histórica o un candidato obsoleto se bloquea para no retroceder `latest`. Revisiones históricas sin este script/contrato no tienen compatibilidad garantizada.

Solo 404 significa versión ausente: auth/red/metadata inválida fallan cerrado. Un rerun con versión aún ausente falla cerrado: esperar metadata y aclarar el resultado anterior antes de iniciar otra publicación. Tras publicar, el readback sondea npm cada 15 s hasta acumular 5 minutos de espera y solo espera mientras el registro responda 404 por propagación; cualquier otro resultado (auth/HTTP no-ok, red, metadata inválida, integridad distinta) falla en ese intento, sin reintentar. Si el tope se agota la versión queda sin tag: no autoriza republish; cuando npm la liste, `gh run rerun <id> --failed` omite publish, verifica el SRI y crea el tag mientras el artifact del run siga retenido (7 días); después, la recuperación con `release_sha`. Si GitHub rechaza realmente el tag (por ejemplo 403), npm queda publicado y el fallo es parcial recuperable con la SHA exacta, sin elevar tokens automáticamente. No hay veto preventivo por mezclar workflows y producto ni garantía de permisos para cualquier ref histórica.

Trusted Publisher, antiguos recursos App/secrets, entornos y rulesets siguen bajo administración del titular: retirar su uso en código no los cambia ni acredita permisos externos. No usar publicación como probe ni modificar paquetes históricos o datos del usuario.

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
