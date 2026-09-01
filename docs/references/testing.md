# Política de testing

JorgeX Stack exige una **decisión de testing por cambio**, no un test nuevo por cambio.

## Decisión obligatoria

Antes de elegir TDD o implementación directa, determina:

1. **Riesgo**: qué regresión relevante puede introducir el cambio.
2. **Protección existente**: qué test actual ya la detecta.
3. **Comportamiento nuevo**: qué contrato o regresión necesita protección adicional.
4. **Seam**: qué nivel de test está más cerca del fallo real.
5. **Acción**: añadir, actualizar, reutilizar o no crear test, con motivo concreto.

`No new test` es válido para estilos, wiring, código generado, refactors mecánicos, código trivial o comportamiento ya cubierto. “Es un cambio pequeño” no basta como justificación.

## Cuándo usar TDD

TDD sigue siendo la opción preferida para:

- Reglas de negocio, cálculos, validaciones, fechas y zonas horarias
- Bugs y regresiones reales
- Contratos públicos, schemas, eventos y protocolos
- Autenticación, autorización, RLS, separación de tenants, billing, privacidad e integridad de datos
- Operaciones destructivas, concurrencia, atomicidad e idempotencia
- Interacciones y contratos de accesibilidad importantes

No se impone automáticamente para estilos, DOM decorativo, wiring, aliases, wrappers, código generado o refactors mecánicos.

## Elegir el test

Principio: **un comportamiento, un test autoritativo en el seam más fuerte y cercano al riesgo**.

- Regla o cálculo puro → unitario/módulo
- Interacción o accesibilidad → componente/browser con semántica estable
- Persistencia, SQL, RLS, migraciones o atomicidad transaccional de datos → base de datos real de test
- Concurrencia o atomicidad fuera de datos → ejecución en la frontera real implicada (filesystem, cola, proceso o estado compartido)
- Endpoint público o función privilegiada → contrato/integración en esa frontera
- Flujo crítico entre sistemas → end-to-end

Otra capa solo se justifica si protege un contrato distinto. Repetir la misma expectativa en unitario, componente e integración aumenta coste sin aumentar necesariamente la protección.

## Qué evitar

- Clases Tailwind, DOM decorativo y estructura incidental
- Existencia de funciones, wrappers, aliases, constantes o callbacks triviales
- Conteos u orden exacto de llamadas internas
- Suites de “integración” que mockean todas las piezas importantes
- Contratos SQL demostrados exclusivamente con regex sobre el texto
- Nuevos tests cuyo único objetivo es elevar coverage

Los mocks siguen siendo útiles en fronteras externas, caras, destructivas o no deterministas. Deben representar el contrato mínimo relevante, no duplicar la lógica de producción.

## Política portable instalada

Esta es la orientación que Stack instala junto con `tdd`, `tester`, `test-analyzer` y
`orchestrator` para usarla en proyectos consumidores. Es una política de decisión
y de evidencia, no un gate, una garantía de ejecución ni una autoridad
`enforced`. La fuente operativa sigue siendo el canon instalado: [TDD y sus
ejemplos](../../stack/skills/tdd/SKILL.md), [tester](../../stack/agents/tester.md),
[test-analyzer](../../stack/agents/test-analyzer.md) y
[orchestrator](../../stack/skills/orchestrator/SKILL.md).

### Decidir y ejecutar sin inventar contexto

La decisión por cambio responde a las cinco preguntas de [Decisión obligatoria](#decisión-obligatoria): riesgo, protección existente, comportamiento nuevo, seam y acción. No exige un formulario ni un schema nuevo; basta con dejar la decisión en el plan o informe que el proyecto ya utilice.

Antes de escribir, seleccionar o ejecutar un test:

- Lee el contrato completo relevante: implementación, API pública, documentación,
  configuración y tests existentes. Conserva un caso de control independiente si
  el contrato tiene ejemplos normales y de frontera.
- Detecta el runner, script/comando, setup y scope reales, incluidos los filtros
  de ruta. Ejecuta el comando o script documentado por ese proyecto y el filtro
  más estrecho que cubra el riesgo. Los scripts documentados del gestor de
  paquetes (`pnpm`, `npm`, etc.) son válidos; si una fixture o README documenta
  un comando directo (por ejemplo, `node --test`), ese comando prevalece sobre
  un wrapper alternativo.
- Reutiliza el tooling disponible. No impongas Node, Vitest, pnpm, TypeScript u
  otro ecosistema. Prohíbe únicamente invocar o resolver un comando que pueda
  auto-instalar un runner/herramienta ausente o pedir interacción sin permiso.
  Si para ejecutar el comando hace falta cualquiera de esas acciones, detén la
  comprobación y reporta la limitación.

### Seam, fidelidad y determinismo

Elige el entorno mínimo que conserve el contrato. Una regla pura puede ejecutarse
en el runtime ligero que ya tenga el proyecto; UI y accesibilidad, base de datos y
RLS, filesystem, procesos, concurrencia o un protocolo de red deben conservar la
frontera real cuando esa frontera sea el riesgo. Un mock o fake es válido para una
frontera externa, cara, destructiva o no determinista, pero solo debe representar
el contrato que se está comprobando. [mocking.md](../../stack/skills/tdd/mocking.md)
detalla ese límite.

Controla únicamente las fuentes de variación relevantes: reloj y zona horaria,
random/IDs, ordenación, estado compartido, filesystem y red. Usa fixtures
temporales aislados y limpia siempre, también al fallar; nunca dependas por
accidente del HOME, datos del usuario o un servicio vivo. Si la red es parte del
contrato, declara el alcance y la infraestructura real; si no lo es, usa una doble
de frontera estrecha, no una suite falsa que replique la lógica de producción.

Los errores esperados se capturan y afirman en el límite que los posee. El stderr,
logs y fallos de teardown inesperados siguen siendo visibles: no suprimas la
salida global para fabricar un verde. Conserva el primer fallo. Repeticiones
acotadas sirven solo para diagnosticar una causa de flakiness y deben quedar
explicadas; reintentar hasta verde o ampliar timeouts sin causa diagnosticada no
es evidencia.

Si falta la suite, el runner, la infraestructura de una frontera o el permiso para
ejecutarla, nombra la protección ausente, propone el seam/setup que la cubriría y
declara la limitación. La ausencia no convierte automáticamente el cambio en
`no new test`, pero tampoco autoriza a instalar herramientas o a usar datos reales
para rellenar el hueco.

### Responsabilidades y evidencia

- **TDD** mantiene la política de riesgo, seam, fidelidad y decisión `no new test`;
  [tests.md](../../stack/skills/tdd/tests.md) resume ejemplos y anti-patrones.
- **Tester** puede decidir, escribir/fijar o verificar en el proyecto consumidor;
  debe informar comando, setup, scope, resultado y límites de la evidencia.
- **Test-analyzer** es *read-only*: evalúa el comportamiento cambiado por el diff
  y la evidencia relevante, incluidos tests existentes fuera del diff y la
  infraestructura de tests relacionada cuando haga falta. No escribe ni ejecuta
  tests, no convierte el análisis en una auditoría de suites o CI no relacionados
  y solo delega gaps accionables.
- **Orchestrator** coordina bloques coherentes y reutiliza evidencia válida; no
  repite la rúbrica ni ejecuta la suite completa por defecto.

Distingue tres clases de evidencia:

1. **Entrega determinista**: render/install/sync, snapshot, paridad o idempotencia
   comprueban que se entregan los artefactos esperados. No prueban por sí solos la
   conducta de un runtime ni del agente.
2. **Evaluación de conducta**: un escenario con contexto y fixture controlados
   comprueba si una orientación produce una decisión útil, con un oráculo
   independiente y un control cuando corresponda. Es evidencia de prompting y
   calibración, no enforcement ni garantía universal.
3. **Smoke nativo**: la CLI/runtime real confirma carga y activación. Si faltan
   CLI, credenciales o permisos, ese runtime queda pendiente; no se declara
   probado por haber renderizado su artefacto.

Los outputs, timings, modelos, fixtures y resultados de una evaluación concreta
son evidencia de esa ejecución, no defaults ni requisitos de esta política. La
documentación de `install`/`sync` describe la entrega y el aislamiento; no muta el
HOME, configuración, Engram o servicios del lector.

### CI solo cuando sea el alcance

La orientación de CI se activa únicamente si la tarea afecta workflows, gates,
filtros de rutas, frecuencia o coste. Inspecciona el provider y su configuración
real: triggers, jobs, comandos, checks requeridos, refs y semántica de publicación
y recuperación. No inventes una receta universal ni un provider obligatorio.

- Usa refs base/head (o equivalentes) explícitas para diff y decisiones de paths;
  valida errores del comando y de la configuración compartida.
- Si el path o la configuración no se pueden clasificar con confianza, ejecuta la
  lane pertinente o falla cerrado. Nunca omitas de forma optimista.
- Compara muestras equivalentes —misma clase de evento, ref, scope y lane— y
  separa tiempo de pared, suma de jobs, cola y consumo/facturación. No conviertas
  una medición local o un resultado de baseline en objetivo universal.
- Una validación draft/candidato puede cancelar ejecuciones obsoletas solo cuando
  la semántica del proyecto lo permita. Nunca canceles un publish/release mutable
  ni dejes una publicación a medias; conserva gates y recovery. Cambiar settings o
  fabricar checks requiere permiso explícito.

## Aplicación local en este repositorio

Esta sección describe únicamente la verificación interna del repositorio **JorgeX Stack**. No modifica la política portable anterior ni convierte Vitest, pnpm o estos comandos en requisitos para los proyectos consumidores.

### Comando, descubrimiento y filtros

Ejecuta los comandos desde la raíz del checkout de Stack, no desde la carpeta que contiene varios worktrees:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` ejecuta `vitest run`. La configuración del repositorio (`vitest.config.ts`) fija `test.dir = "./tests"`, por lo que la ejecución normal descubre solo la suite canónica de `tests/` y no copias bajo `worktrees/` o `.pnpm-store/`.

Para comprobar el inventario sin ejecutar los tests:

```text
pnpm exec vitest list --filesOnly --json --static-parse
```

Para una comprobación focal, filtra por archivo o por nombre; los filtros sirven para feedback rápido y no sustituyen una ejecución completa cuando el cambio la requiera:

```text
pnpm test tests/test-discovery.test.ts
pnpm test tests/browser-preferences-safety.test.ts tests/quality-verifier-package.test.ts
pnpm test tests/quality-verifier-package.test.ts -t "T37 package contract"
```

`--no-file-parallelism` o `--maxWorkers=1` son controles diagnósticos puntuales para investigar contención, no defaults ni soluciones para ocultar un timeout. Conserva el stderr y el primer fallo al comparar ejecuciones.

### Entorno aislado

- Usa un checkout/worktree limpio y el runtime de desarrollo del proyecto. `engines.node >=22.5` describe el runtime del paquete, pero no garantiza pnpm 11; para desarrollo, reproduce el Node 24 de CI y el `packageManager` fijado por el repositorio (`pnpm@11.1.1`). No añadas runners ni dependencias para esta verificación.
- Los tests que ejercitan instalación, configuración o filesystem deben usar raíces temporales y limpiar siempre en `finally`. No ejecutes una prueba diagnóstica contra el HOME real, la configuración personal, credenciales, datos de Engram o servicios externos.
- Si un wrapper aísla rutas mediante variables de entorno, cada variable debe omitirse o contener una ruta temporal no vacía. En particular, una cadena vacía en `PI_CODING_AGENT_DIR` se interpreta como una ruta literal y no activa el fallback al directorio Pi por defecto.
- Las carpetas temporales de verificación para casos no-Git o para comprobar el stripping de TypeScript deben quedar fuera del checkout (incluido `.git`) y fuera de `node_modules`; colocarlas dentro de esas rutas cambia el resultado de las guardas y del descubrimiento.
- El inventario estático (`--static-parse`) sirve para comprobar el alcance de archivos. No equivale al número de casos que puede registrar la ejecución: los tests dinámicos o condicionales pueden aparecer solo al ejecutar.

### Comportamiento y causa corregida

La configuración local debe conservar estas propiedades:

- La prueba de descubrimiento crea tests canónicos y copias en `worktrees/` y `.pnpm-store/`; la comprobación CLI queda verde y solo devuelve los archivos bajo `tests/`.
- Los dos focos de integración que agotaban el timeout global de 5 s tienen un presupuesto local de 15 s, sin convertir ese presupuesto en un timeout global.
- La prueba de descubrimiento tiene su propio presupuesto de test de 15 s y limita a 10 s el proceso CLI hijo; esos límites solo cubren esa comprobación de inventario.
- La causa corregida era doble: el descubrimiento desde una raíz con copias inflaba el trabajo paralelo, y dos setups de integración legítimamente lentos superaban el presupuesto por defecto. No se corrige reduciendo workers, añadiendo retries, silenciando la salida ni aceptando un verde espurio.

Las ejecuciones focales no sustituyen una ejecución completa del checkout cuando el cambio la requiera. No debe inferirse de este aislamiento que la suite global esté verde ni que exista una mejora de latencia o de coste de CI.

### Limitaciones

- `test.dir` aplica cuando Vitest se lanza con la configuración de este checkout; invocar otro root o una configuración externa puede cambiar el alcance y debe inspeccionarse de nuevo.
- Los conteos observados en la raíz del repositorio incluyen worktrees/store presentes en esa máquina y no son el tamaño objetivo de la suite canónica.
- Los 15 s de los dos focos de integración y los 15 s propios del test de descubrimiento no justifican ampliar timeouts globales ni copiar esos valores a otros tests sin diagnóstico comparable; el proceso CLI de discovery mantiene su límite separado de 10 s.
- Acotar el descubrimiento no demuestra ausencia de flakiness, ahorro de facturación ni corrección de CI remoto. La cadencia y los gates de GitHub pertenecen a la documentación específica de CI, no a esta receta local.

El workflow de publicación y su preflight conservador están descritos en [README → Publishing](../../README.md#publishing). Las pruebas locales de `release` comprueban sus guardas y fixtures Git, pero no equivalen a una publicación real, a un smoke de OIDC ni al smoke manual de acceso del release App.

### Piloto property para mantenedores

El piloto de property testing de Stack es opt-in y solo se ejecuta desde un
checkout del repositorio; no forma parte del paquete instalado ni de la
ejecución normal:

- `fast-check@4.9.0` es una dependencia de desarrollo únicamente. El script
  `pnpm test:property` ejecuta `vitest run --dir pilots/property`; `pnpm test`
  y la CI por defecto no descubren ni ejecutan `pilots/property`. No es un
  comando público de la CLI.
- Se mantiene una propiedad por repositorio. En Stack, la propiedad cubre
  `upsertTomlSection`: aplica el cuerpo solicitado, conserva las secciones
  ajenas y deja el resultado estable al aplicarlo una segunda vez. El piloto
  paralelo de Pi cubre el receipt de Engram con el caso positivo y sus
  invalidadores contractuales; allí se ejecuta
  `node --test --test-concurrency=1 pilots/property/*.test.mjs`.
- La ejecución de Stack usa 100 casos y `seed: 20260831` mediante `fc.assert`.
  Es un presupuesto reproducible del piloto, no un umbral de calidad ni un
  gate de CI. Se conserva el shrink por defecto.
- Para repetir un fallo, usa el `seed` y el `path` nativos que informa
  `fc.assert`; si hace falta una edición local temporal, restáurala después.
  No inventes flags de entorno o de CLI para el replay.

El resultado del piloto informa sobre la propiedad solo cuando se ejecuta; no
debe presentarse como enforcement de CI ni como garantía de seguridad del
sistema operativo. Esta referencia no fija timings ni resultados concretos;
se registran por separado cuando exista una medición.

### Piloto coverage para mantenedores

El piloto de coverage de Stack es opt-in y sirve para inspeccionar el mapeo de
líneas de una selección explícita; no forma parte de `pnpm test`, de la CI por
defecto ni del paquete publicado.

Ejecútalo desde la raíz de un checkout de Stack:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm test:coverage
```

La configuración de `pilots/coverage/vitest.config.ts` limita el piloto a
estas tres suites:

- `tests/quality-policy.test.ts`
- `tests/quality-receipt.test.ts`
- `tests/quality-verifier.test.ts`

y a estas tres fuentes:

- `src/lib/quality-policy.ts`
- `src/lib/quality-receipt.ts`
- `src/lib/quality-verifier.ts`

El provider es V8 mediante `@vitest/coverage-v8@4.1.8`, que debe mantenerse
pareado exactamente con `vitest@4.1.8`; el piloto no es motivo para actualizar
ninguna de las dos dependencias. Los informes se escriben en
`coverage/quality/`: `coverage-final.json`, `lcov.info` y `lcov-report/`.
Son artefactos locales ignorados por Git y no forman parte de la publicación.

El line mapping indica qué líneas de las fuentes incluidas fueron ejecutadas
por esas suites; no demuestra que el comportamiento esté completamente
validado. Un informe solo es interpretable cuando contiene las fuentes
esperadas del scope explícito: si falta una, el informe está incompleto y no
debe interpretarse su porcentaje. Este piloto no cubre el runner, la CLI hija
en `dist` ni el alcance global del repositorio; los archivos que no se importan
desde el scope declarado siguen presentes y no quedan cubiertos por ello.

El piloto no añade thresholds, cambios en la suite por defecto, CI, wrappers,
tests ni código de producto. La decisión de testing para este wiring es no
crear un test nuevo: se verifican los comandos y los informes reales cuando se
ejecuta el piloto. No se fijan aquí números ni timings volátiles.

## CI interno del artefacto Pi

Esta sección describe únicamente el workflow propio de Stack en
`.github/workflows/pi-artifact.yml`. No convierte sus herramientas, eventos o
gates en requisitos para los proyectos consumidores; la línea portable A queda
fuera de esta sección.

### Dos lanes con un único job

El workflow conserva un único job interno (`validate`) y cambia su nombre
visible según el evento:

- **Draft checks**: una pull request en borrador que recibe `opened`,
  `synchronize`, `reopened` o `converted_to_draft`. Ejecuta checkout, registra
  la identidad, instala dependencias con `pnpm install --frozen-lockfile` y
  ejecuta `pnpm typecheck`.
- **Quality gate**: una pull request cuyo payload no marca `draft: true`,
  incluida la transición `ready_for_review`, y cualquier ejecución de
  `workflow_dispatch`.
  Además de la lane común, descarga el tarball exacto fijado por el workflow y
  ejecuta `tests/pi-cross-repo-contract.test.ts`, la suite completa
  (`pnpm test`) y el build (`pnpm build`).

Los pasos caros usan la misma expresión de GitHub Actions que decide el nombre
del job: `workflow_dispatch` siempre es full; una pull request es full cuando
la acción es `ready_for_review` o `draft != true`. En borrador, que un paso
guardado figure como `skipped` o que **Draft checks** termine en verde solo
prueba la comprobación barata; no es un pase del contrato Pi, de la suite ni
del build completo.

El job tiene `timeout-minutes: 10`, `concurrency` por número de pull request o
por ref manual y `cancel-in-progress: true`. Así se cancelan validaciones
obsoletas del mismo candidato lógico; no se cancela ni se reutiliza este grupo
para publicación mutable. Los permisos del workflow y del job son
`contents: read`, y checkout usa `persist-credentials: false`: esta validación
no hace push, tag ni publicación.

Si algún día se protege una rama con un check requerido de este workflow, el
nombre que debe seleccionarse es **Quality gate**, nunca **Draft checks** ni el
identificador interno `validate`. Activar o modificar esa protección pertenece a
una operación autorizada aparte; esta documentación no afirma que el check ya
esté configurado como required ni modifica settings.

### SHA comprobada y evidencia

Checkout fija `ref: ${{ github.sha }}` y el paso **Record workflow identity**
comprueba que `git rev-parse HEAD` coincide con esa SHA y la deja en el
`GITHUB_STEP_SUMMARY`, junto con el evento, la acción y, cuando existen, las
SHAs head y base de la pull request.

En una ejecución `pull_request`, `GITHUB_SHA` es la revisión de merge que
GitHub prepara para el workflow; no debe confundirse con
`github.event.pull_request.head.sha` (la punta de la rama origen) ni con
`github.event.pull_request.base.sha` (la punta de la rama destino). En una
ejecución manual, `GITHUB_SHA` es el commit de la ref seleccionada para ese
run. Un nuevo commit cambia la SHA candidata y deja obsoleta la evidencia del
gate anterior: hay que leer el summary y el resultado del run correspondiente
a la nueva SHA. Los fallos, cancelaciones y reruns siguen siendo parte de la
diagnosis; un rerun no convierte una lane barata en una Quality gate.

### Ejecución manual

`workflow_dispatch` fuerza la lane completa. Para lanzarla sobre una ref
concreta y observar el run, conserva la URL o el ID que devuelve el dispatch:

```text
gh workflow run pi-artifact.yml --ref <branch-or-tag>
# De la URL .../actions/runs/<run-id>, extrae el ID numérico devuelto.
gh run watch <run-id> --exit-status
gh run view <run-id> --json event,headBranch,headSha,status,conclusion,jobs
```

GitHub solo permite despachar manualmente un workflow cuyo archivo existe en
la rama por defecto; `--ref` selecciona la ref sobre la que se ejecuta esa
validación, no sustituye ese requisito. `gh run view` y `gh run watch` reciben
el ID numérico, no la URL completa. En la salida de `gh run view`, verifica
`event=workflow_dispatch`, la ref reportada en `headBranch` y la SHA esperada
en `headSha`; inspecciona también `jobs` para confirmar los pasos de la lane
completa, no solo `status` o `conclusion`. El summary de la ejecución es la
referencia para la SHA realmente comprobada. Una ejecución manual valida la
ref/head elegida, pero no sustituye el **Quality gate** de `pull_request` sobre
la revisión de merge sintética. Tampoco marca una pull request como lista para
revisión ni cambia por sí misma la protección de ramas.

### Runtime y caché de Actions

Las cinco actions actualizadas ejecutan su runtime interno sobre Node 24; esto
no debe confundirse con `node-version: 24`, que selecciona el Node del proyecto
para `pnpm` y los comandos de validación. En ambos workflows, cada
`setup-node` fija `package-manager-cache: false`: solo se conservan las dos
cachés de dependencias `cache: pnpm` declaradas explícitamente, sin caché
automática antes del preflight ni en los jobs privilegiados `bump` y `publish`.
Las lanes, triggers, cadencia, concurrencia/cancelación y timeouts existentes
se mantienen sin cambios; esto no demuestra ahorro de tiempo o facturación,
ni establece un SLO o una protección adicional.

El routing draft/full puede evitar trabajo caro antes de que exista un
candidato, pero este repositorio público no debe presentar esa forma como un
ahorro facturado medido. Tampoco se deben descartar fallos o reruns para
fabricar una señal verde: la conclusión solo es interpretable junto con la
lane y la SHA.

## App de releases y smoke manual de acceso

La operación del App, el smoke manual y el guard metadata-only del bump están en [README → Publishing](../../README.md#publishing). `.github/workflows/release-app-check.yml` es manual/main-only y auth-only: comprueba el alcance del token con un `GET`, sin checkout, instalación, tests/build, push, tag ni npm.

Ejecútalo solo después de incorporarlo en la rama por defecto; las pruebas locales de `release` no equivalen a autenticación App, trusted publishing OIDC ni publicación real. Tampoco es un smoke nativo de Pi ni configura branch protection; Stack y Pi mantienen publicación, snapshot/paridad y lifecycle separados.
