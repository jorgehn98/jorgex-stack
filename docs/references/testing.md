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
