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
- Persistencia, SQL, RLS o atomicidad → base de datos real de test
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
