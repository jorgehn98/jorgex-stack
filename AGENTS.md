# JorgeX Stack

JorgeX Stack instala configuración compartida en Claude Code, Codex, OpenCode y Pi: agentes, skills, hooks, MCPs, system prompt y plugins. Este archivo guía el trabajo en este repositorio; no es el prompt que instala el CLI. El canon instalable vive en `stack/` y las referencias duraderas en `docs/`. Las decisiones cerradas no se cambian sin Jorge.

## Reglas no negociables

1. **pnpm siempre, nunca npm**, salvo los comandos del registry permitidos por `.github/workflows/publish.yml` (`npm pack --dry-run --ignore-scripts` y `npm publish --ignore-scripts --provenance`).
2. **Cero secretos:** no keys, tokens ni credenciales en código, ejemplos, tests o fixtures. Engram no necesita key; Context7 usa un placeholder vacío para que cada usuario conecte su cuenta. Chrome DevTools MCP es opt-in y default-off; si se activa, usa `chrome-devtools-mcp@1.6.0` con `--isolated --redact-network-headers --no-performance-crux --no-usage-statistics`. La redacción cubre cabeceras, no cuerpos de request/response: evita sesiones o datos sensibles.
3. **Engram es intocable:** install/sync detectan y respetan su binario y `~/.engram`; update puede actualizar solo el binario con confirmación explícita y backup ofrecido. Uninstall conserva el registro por defecto; solo `--remove-engram` o una confirmación explícita default No permite desregistrarlo. Ni siquiera entonces se toca la DB, las memorias o el binario.
4. No tocar `C:\Users\jorge\Desktop\jorgex-custom-tools`; sus plugins se conservan y cualquier proyección gestionada se copia a `stack/plugins/opencode/`, sin retirar los originales.
5. **Merge idempotente:** las escrituras en configuración de usuario usan marcadores `<!-- jorgex:seccion -->` o upserts quirúrgicos JSON/TOML, con backup previo. Una segunda ejecución de `sync` no debe producir cambios.
6. `src/components/` es agnóstico del runtime. Las diferencias de Claude Code, Codex y OpenCode viven en `src/adapters/`; añadir runtime significa añadir adapter, no switches en components.
7. No inventar APIs, OAuth, nombres, rutas ni contratos. Verificar primero en código, migraciones, tests o documentación canónica.

## Arquitectura y límites

```text
stack/        fuente canónica instalable
src/          CLI y librerías
  cli.ts      install | sync | models | update | doctor | restore | uninstall
  adapters/   rutas, formatos y estrategias por runtime
  components/ qué se instala, independiente del runtime
  lib/        merge, backup, detección, manifest y mapas de modelos
upstreams.json terceros gestionados por update
```

Stack gestiona la instalación de JorgeX Pi; Pi posee su proyección Pi-native, bootstrap, contratos, dependencias y lifecycle. `src/lib/pi-runtime.ts` en Stack fija la versión, URL del tarball, tamaño, SHA-256 y SHA-512 aceptados; nunca usar `latest`. Consultar `docs/references/pi-runtime.md` para transiciones y rollback: usar versiones que reconozcan cada receipt, sin editar receipts ni hashes, ni borrar HOME, Engram o proyecciones ajenas.

Un cambio de Stack que afecte agentes, skills, system prompt, permisos, Engram, browser routing, modelos o contratos compartidos exige revisar la snapshot/paridad, generadores, contratos, bootstrap y documentación de Pi. Un cambio de Pi exige revisar `src/lib/pi-runtime.ts`, `tests/fixtures/pi-runtime.ts`, tests Pi y `docs/references/pi-runtime.md` en este repo. La paridad registra el commit canónico en `source.commit`; no duplicar la fuente: lo compartido nace en Stack y la adaptación Pi vive en Pi.

Pareja publicada y verificada: `jorgex-stack@1.9.7` + `npm:jorgex-pi@0.8.4`. Pi `0.8.5` está publicado independientemente; este checkout mantiene la base Stack `1.9.7` con el pin candidato Pi `0.8.5`. Al mergear se espera el auto-bump a Stack `1.9.8` y su publicación sin esperar las 24 h. La barrera gestionada de 24 h en npm afecta al consumo/instalación real del paquete Pi nuevo, no a validación, merges ni releases. Tamaño y hashes se verifican localmente; la attestation externa de npm queda fuera del runtime y `provenance.commit` es informativo salvo verificación explícita.

Todo cambio de Stack requiere comprobar impacto/paridad con Pi, aunque no necesite cambios allí. Las proyecciones propias de Stack se actualizan en el mismo PR; el paquete publicado de Pi, en un PR secuencial enlazado. No cerrar el trabajo antes del último checkpoint necesario.

## Canon de skills y runtime

La snapshot vigente contiene 18 skills: propias (`agent-delegation`, `lean-code`, `orchestrator`, `work-audit`, `work-lifecycle`, `xreview`) y vendorizadas (`deploy-to-vercel`, `diagnose`, `find-skills`, `mcp-builder`, `playwright-cli`, `react-doctor`, `skill-creator`, `supabase`, `supabase-postgres-best-practices`, `tdd`, `to-issues`, `to-prd`). Los adapters ejecutan solo copias locales de `stack/skills`, nunca upstreams en runtime.

`upstreams.json` conserva source/path y commit aceptado de cada skill vendorizada. Solo un mantenedor desde un clon git puede proponer su actualización: descarga temporal, diff visible y confirmación antes de reemplazar/re-pin; `modified: true` requiere confirmación adicional. Para skills, `update --check` en un paquete instalado es discovery-only: no consulta ni ejecuta upstreams. La limpieza de componentes retirados solo elimina rutas propias según manifest, con backup incluso si se modificaron; conserva rutas ajenas. Nunca tocar vaults ni binarios de Obsidian al retirar sus skills.

Los wrappers primary de Claude Code, Codex y OpenCode cargan la skill canónica `stack/skills/orchestrator/SKILL.md`. Las skills compartidas son independientes del modo; overlays humanos/programáticos son propios de cada runtime.

Permisos fresh: se siembran solo si la configuración está ausente o vacía, con warning al sembrar; una configuración existente se preserva sin reimposición ni warning. Política exacta: `docs/references/permissions.md`. Modelos y límites: `docs/references/models.md`; wrappers primary sin modelo/effort fijados, defaults solo en campos ausentes. Valores idénticos preexistentes no se reclaman; uninstall retira solo campos creados por Stack que sigan canónicos. No equiparar límites OAuth locales con contexto API ni prometer aceptación sin smoke real.

Browser: Playwright CLI `@playwright/cli@0.1.18` es el camino recomendado y opt-in; DevTools MCP es avanzado y opt-in. Bajo `--target-dir` no se lee ni escribe el estado real del navegador, ni se ejecutan planes globales. Si las preferencias `~/.jorgex-stack/playwright-cli.json` o `devtools-mcp.json` son ilegibles, las mutaciones fallan cerradas antes de tocar nada y `doctor` indica la ruta y el remedio. Detalles de lifecycle, ownership, aislamiento y troubleshooting: `docs/references/browser-automation.md`.

Convención de plugins OpenCode: nunca `console.*`; el logging usa `client.app.log`, se espera y se tragan sus rechazos. Todo hook se envuelve en `safe()` para registrar y resolver sin propagar excepciones. La carga del plugin es fail-safe (`return {}`), y los `spawnSync`/`$` de git fijan `stderr` para no heredarlo.

## Desarrollo y verificación

```text
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm cli <cmd>
```

Todo trabajo no trivial usa un git worktree. Primero resolver la raíz con `git rev-parse --show-toplevel`, asegurar `worktrees/` en el `.git/info/exclude` local y crear el directorio dentro de esa raíz si falta. Usar `<project-root>/worktrees/<canonical-name>` para single-PR o `<project-root>/worktrees/<canonical-name>-prNN` para checkpoints multi-PR (branch = worktree name). No crear worktrees junto al repo, bajo `work/` ni en temporales.

El orchestrator es el owner del routing `short`/`standard`, que se decide antes del workflow por alcance, incertidumbre, riesgo y verificación; no son modos humanos/programáticos ni se enruta por número de archivos. Estos criterios describen el contrato de aplicabilidad, no un algoritmo de decisión nuevo. `short` exige un objetivo claro y que el contrato afectado esté entendido, además de alcance acotado y verificación suficiente; puede tener un responsable principal o un especialista sin cadena formal obligatoria. Si crecen el alcance, el riesgo o la incertidumbre, se promueve a `standard` antes de continuar. `short` standalone no fabrica PRD, plan, Spec, PRE o POST; dentro de un SDD activo conserva la Spec, fila, ownership y lifecycle aprobados.

En el SDD formal, el PRD vive en `work/{name}/PRD.md` y `plan.md` es el único tablero operativo (ambos gitignored). Cada tarea formal declara una única spec recuperable: observación Engram identificada por proyecto + topic_key `work/{name}/task/{NN}` con identidad/acceso verificados (ID local opcional, vinculado a esa identidad en el almacén actual; resolver según el handoff de `work-lifecycle` antes del get), o Markdown canónico `work/{name}/tasks/{NN}.md`; la columna `Spec` del plan la referencia. Engram conserva resultados de fase, checkpoints e historia. Entre merges intermedios se conservan PRD/plan y cada checkpoint va en `work/{name}/pr/{NN}`; `work/{name}/done` y el borrado de `work/{name}/` solo llegan al cierre del último PR. Seguir la skill `work-lifecycle`.

Para `work/backlog`, el coordinador es el **único escritor**: leer con `mem_get_observation`, preservar lo ajeno, enviar el **contenido completo** con `mem_update` y volver a leer para **verificar**. Nunca escrituras **concurrentes** ni upsert ciego. No dividirlo por ítems hasta disponer de listado completo paginado por topic; con tracker, usar issues sin duplicar backlog.

Para cambios no triviales: elegir la base según la dependencia —producción actualizada para trabajo independiente o candidato padre Git estable y verificado para trabajo dependiente—, conforme a las capacidades disponibles, las reglas del proyecto y el orden registrado; un objetivo por PR y commit por tarea/grupo acotado. Tras el primer commit+push, abrir con `gh pr create --draft`. Antes de `gh pr ready <number>` completar código, bump aplicable, tests locales, `pnpm qa:quality` si existe, preview si aplica, diff y review final.

Cuando el proyecto tenga checks/CI de PR configurados, esperar los Quality Gates y ejecutar `gh pr checks <number>` para el último commit candidato. Si no existen checks de PR configurados, confirmar desde workflows/rulesets/integraciones: su ausencia no bloquea el merge. Un resultado vacío de `gh pr checks` justo después de ready no demuestra esa ausencia. Inmediatamente antes de reportar o mergear, comparar `gh pr view --json headRefOid` con el SHA candidato. Nunca pushear a una PR ready: primero `gh pr ready --undo <number>`, modificar en draft y repetir verificación, review y gates aplicables.

Las PRs dependientes pueden encadenarse sobre un candidato padre Git estable y verificado cuando el trabajo esté aprobado, las capacidades disponibles y las reglas del proyecto lo permitan y se respete el orden registrado. Distingue siempre entre trabajo independiente (base `main` de producción actualizada), dependencia Git (rama/worktree hijo desde un candidato padre estable y verificado) y prerrequisito externo (artefacto, migración, despliegue o decisión que debe existir). Registra en el plan la base y su SHA, la PR padre o prerrequisito, y el orden; una PR hija puede abrirse contra un padre todavía abierto conforme a esas condiciones. Los padres en estado ready son inmutables. Si cambia la base, se hace retarget o cambia el contexto de integración, la PR afectada vuelve a Draft antes de cambiarla y se recalculan diff, cobertura y gates; no se garantiza el auto-retarget del proveedor. El merge siempre requiere una orden explícita de Jorge, en orden seguro; aprobación del plan, estado ready o checks verdes no autorizan merge ni auto-merge, y no se crea una hija en un padre abierto sólo para mantener actividad. Un prerrequisito externo pendiente bloquea a su consumidor, no al resto del trabajo aprobado; `STOP` sólo cuando no quede otro trabajo aprobado que pueda ejecutarse de forma segura con las decisiones y capacidades disponibles. Nunca hacer commit o push sin petición explícita, salvo autorización expresa de un plan orquestado aprobado; esa autorización no incluye merge.

**Límite actual de Goal Mode F7:** el Goal Mode de OpenCode registra `waiting_for_merge` para una PR abierta y su store/supervisor pausa la continuación automática. Esta política no modifica esa máquina de estados: no se debe sortear ni prometer retarget automático, autonomía de todas las cadenas ni continuación apilada automática en ese modo. Se continúa sólo con capacidades aprobadas y disponibles.

**Cadencia de review del orquestador:** durante EXECUTE usar tests/lint/typecheck por bloques coherentes. Terminar un writer, hacer commit/push o abrir draft no dispara reviewers. Review anticipada solo por riesgo concreto no cubierto determinísticamente, un especialista y como máximo una por bloque crítico. Review multiagente final una vez por PR sobre el SHA candidato todavía draft; repetir solo si los fixes cambian materialmente el diff o introducen un riesgo distinto.

Testing es una decisión explícita basada en riesgo: elegir el seam autoritativo más cercano y preferir verificación específica antes que suite amplia. Para cambios docs-only mecánicos, la decisión puede ser **no new test**; no crear snapshots de prosa por obligación. TDD aplica a reglas de negocio, bugs/regresiones, contratos e invariantes. Referencia: `docs/references/testing.md`.

## Publicación npm

El workflow publica al mergear en `main` si hay cambios publicables. Si la versión ya existe en npm, auto-bumpea solo patch; minor/major se deciden manualmente en `package.json` dentro del PR. No esperar que el workflow decida minor/major. La recuperación y sus comprobaciones de SHA/tags están documentadas en `README.md`, sección Publicación; no cancelar una publicación mutable ni inventar un flujo alternativo. Código y cambios de comportamiento nunca se empujan directamente a `main`.

## Estilo y documentación

Código e identificadores en inglés; documentación y comunicación en español. Simplicidad máxima: KISS, YAGNI, Clean Code y DRY. Cambios de comportamiento requieren docs; si una página cambia, revisar navegación y metadata. Mantener links internos válidos y claims respaldados por código, tests, migraciones, git history (solo para cronología) o docs canónicas.

Referencias operativas: `docs/references/sdd-workflow.md`, `docs/references/quality-receipt.md`, `docs/references/permissions.md`, `docs/references/models.md`, `docs/references/browser-automation.md`, `docs/references/pi-runtime.md` y `docs/references/testing.md`.

## Seguridad

Revisar autenticación, permisos, secretos y datos sensibles con mínimo privilegio. Validar entradas externas en rutas sensibles. No exponer credenciales en respuestas, logs ni documentación.

## Roadmap

El roadmap y el estado operativo viven únicamente en `plan.md`; la historia y los checkpoints cerrados se conservan en Engram, mientras cada spec formal sigue su fuente `Spec` declarada. Este briefing no replica historial ni una sección `Estado`.
