# 21 — Interfaces web, estados y experiencia

> Investigación y propuesta. 2026-10-02. Sintetiza patrones de estado, foco, navegación y composición a partir de librerías con código y SHA pinned y de la especificación W3C. **No** ejecuta, **no** instala, **no** lee repos remotos en esta pasada. Las fuentes viven en [fuentes.md](fuentes.md) (UX01–UX06).

## 1. Lo que se transfiere y lo que no

- **UX01 Radix Primitives — `dialog.stories.tsx` + `dialog.module.css` + `dialog.tsx` (Dialog package)** — historias modal/no-modal/anidado, contenido largo, foco y retorno; CSS `data-state` conduce presencia (`150 ms` opacity, `200 ms` scale, `300 ms` exit) como **ejemplo particular**, **no** como regla universal; `prefers-reduced-motion` exige verificación de integración por caso; props semánticas `closed` vs `unmounted` y release de focus trap — **no** cambia el framework DOM "porque sí".
- **UX02 Carbon — `DataTable-dynamic-content.stories.js` + `DataTable-pagination.stories.js`** — select/batch actions/expand/search toggle; estados `aria-hidden`/`tabIndex` para `Failed/InProgress/Succeeded` son **datos simulados**, no operación real; el comportamiento de "search clear" necesita verificación (no se ejecuta); empty initial vs no-results vs loading vs error son **distintos**; la acción de recuperación no es ilustración decorativa; **no** se fuerza la tabla a cards; las relaciones semánticas se mantienen en celdas estrechas aunque el reflow no cubra todo (toolbar/paginación se tratan aparte).
- **UX03 React Aria Components — `Table.stories.tsx` + `useTable.ts` (TextField stories + implementation)** — loading/empty/resize; drag con `Enter` start, `Escape` cancel, foco vuelve si no hay target válido; anuncios de sort localizados vía `useTable.ts` — **contrato observado**, no se escucha TTS; errores nativos de `TextField` y `submit`/`reset`/labels se leen del source, **no** se prueban con lector real; el path exacto del story puede variar en el registry, **no** se inventa.
- **UX04 WCAG 2.2 — Understanding reflow (two-dim table)** — la excepción aplica a tablas con relación semántica en 2D, **no** se generaliza a celdas/headers como búsqueda libre.
- **UX05 WCAG 2.2 — Understanding status messages** — informar resultado/espera/error **sin** foco y **sin** alertan chatty en cada cambio; no se interpreta como "todos los cambios se anuncian".
- **UX06 Conceptos generales — back/forward/fallback/no-JS** — los stories **no** los demuestran; sólo el plan real de la arquitectura los soporta, **no** se hereda la promesa de la librería.

Cada fuente se cita con su SHA pinned y la URL exacta por archivo; lo verificado por lectura se distingue de lo declarado por metadatos (ver [fuentes.md](fuentes.md)).

## 2. Lo que el componente **no** resuelve por sí mismo

- **No** garantiza fallback sin JS: depende de la arquitectura, **no** de la librería.
- **No** garantiza experiencia de lector de pantalla: el contrato del componente y la configuración del usuario mandan.
- **No** certifica `prefers-reduced-motion`: cada CSS de animación exige verificación; la presencia de una media query en otra parte **no** la aplica.
- **No** mapea el back/forward del navegador por defecto: requiere plan de routing, **no** se asume.

## 3. Tres casos prototipo (estado, foco, error)

### 3.1 Panel de configuración con foco en popover anidado

- **Apertura controlada** y **no controlada** declaradas; foco inicial y retorno al cerrar.
- **Contenido largo y estrecho**: la altura del contenedor y el scroll interno **no** desplazan el foco fuera del panel.
- **Cierre y continuación**: cerrar **no** aborta la tarea principal; la pieza sigue siendo utilizable.

### 3.2 Tabla de recursos con batch action y estados

- **Estados reales**: loading inicial, empty (sin datos), no-results (filtro sin match), error recuperable, éxito.
- **Acciones**: select-all, batch, búsqueda, paginación, expansión de fila.
- **Prohibido**: ilustración decorativa como única recuperación; **no** se mezcla "no results" con "loading".
- **Owner simulado ≠ operación real**: los datos son simulados para maquetar; el comportamiento live exige verificación.

### 3.3 Explorador de archivos con resize, selección, drag cancelado

- **Resize**: layout estable; las celdas no rompen la relación semántica.
- **Selección vacía / loading / drag deshabilitado**: estados visibles y announced según `UX05`.
- **Cancelación con `Escape`** y **sin target válido**: el foco vuelve al elemento anterior; el árbol **no** queda en estado inconsistente.
- **Contraste / ancho 320**: la propuesta sigue WCAG, **no** se impone a cada canvas; el nodo debe mantener su rol.

## 4. Gen / 3D en interfaces: contexto, **no** hero obligatorio

- **Más allá del hero**: assets generativos o 3D pueden ser contexto (ilustración de fondo, ambient), **no** un puesto obligatorio.
- **Si decorativos**: no capturan foco, no portan información exclusiva.
- **Si interactivos**: necesitan controles, fallback y entrada real del usuario; el "3D accesible" no se demuestra por los repos investigados.

## 5. Lo que Visual Director aporta y lo que no

- **Aporta**: composición, tipografía, jerarquía, adaptación de assets y motion con sentido.
- **No aporta**: permisos de negocio, persistencia backend, historial funcional, implementación de dominio. Esos son trabajo de un sistema profesional, no de este dossier.
- **No** introduce un design system nuevo por componente.

## 6. Anchura 320, foco, contraste, motion

- **Anchura 320**: la propuesta sigue WCAG, **no** fuerza a cada canvas; el nodo debe mantener su rol semántico.
- **Foco**: visible y lógico; restore al cerrar popovers; `Escape` cancela; nada queda en estado inconsistente.
- **Contraste**: por rol, **no** sólo por color; el `+` y `−`de Essential Words como ejemplo de control no-sólo-color.
- **Motion**: motivación + accesibilidad; `prefers-reduced-motion` se verifica por caso, no se hereda.

## 7. Lo que el capítulo no promete

- **No** afirma que un componente concreto dé una experiencia accesible **per se**; la accesibilidad es del conjunto (componente + arquitectura + configuración + verificación).
- **No** afirma que los demos HTTP coincidan con el source al deployment; el snapshot se cita con su SHA, no se re-renderiza.
- **No** introduce SKILL.md ni modificaciones a la skill existente.

## 8. Conexión con los demás capítulos

- [03-web-narrativa-cro-y-motion.md](03-web-narrativa-cro-y-motion.md) — el motion con sentido y la CRO como hipótesis se anclan a estos patrones de estado y foco.
- [17-casos-web-narrativos-y-cro.md](17-casos-web-narrativos-y-cro.md) — WC01–WC06 ilustran patrones; este capítulo los formaliza a nivel de estado e interacción.
- [07-validacion-y-decisiones-pendientes.md](07-validacion-y-decisiones-pendientes.md) — el caso "state vs backend fake-success + focus UX" verifica este capítulo.
