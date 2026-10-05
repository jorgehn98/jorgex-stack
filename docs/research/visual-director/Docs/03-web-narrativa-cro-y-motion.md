# 03 — Web: narrativa, CRO y motion

> Investigación y propuesta. 2026-10-02. Cubre la lógica de página, la disciplina CRO como hipótesis verificable, los patrones de motion por rol y la accesibilidad/rendimiento como guardrails. No instala ni ejecuta. Fuentes en [fuentes.md](fuentes.md) (W01–W14).

## 1. Mensaje: a quién llega, qué cambia, qué objetivo

Una pieza web responde cuatro preguntas antes de tocar la dirección:

- **Quién llega** y desde qué intención (búsqueda, recomendación, publicidad, directo).
- **Qué diferencia real** ofrece frente a la alternativa obvia.
- **Qué objeciones** tiene esa persona antes de actuar.
- **Qué objetivo de negocio** sirve la página (lead cualificado, reserva, venta, exploración, registro).

Las objeciones son la materia del mensaje. Sin ellas, la página se llena de adjetivos que no convencen.

## 2. Viaje y dos velocidades

La página navega a dos velocidades:

- **Exploración narrativa**: lectura o recorrido lineal, con cadencia, ritmo y pausas. Es el camino del visitante curioso.
- **Vía rápida**: anclas de navegación, índice, CTA accesibles sin completar la animación ni el scroll. Es el camino del visitante con objetivo concreto.

Una pieza bien hecha **no obliga** a seguir la exploración para llegar al CTA. Saltar a una sección, abrir un menú o copiar un enlace debe funcionar en cualquier momento.

## 3. Ficha de sección

Cada sección principal responde, sin depender de animación:

- **Pregunta del usuario**: qué se pregunta al llegar ahí.
- **Mensaje**: qué afirma la sección en una frase.
- **Prueba**: qué la sostiene (dato, captura, testimonio verificable, comparativa).
- **Interacción**: qué puede hacer la persona ahí.
- **Acción**: qué CTA sale de la sección.
- **Alternativa estática**: cómo se ve y funciona sin motion (versión con reduced-motion, sin JS, sin canvas).

La animación mejora la experiencia; nunca es el único camino.

## 4. Personalidad sin animación

La personalidad de una página se sostiene con composición, tipografía, sistema visual, materiales y voz. La animación **acompaña**, no define. Si la página pierde su carácter sin motion, el carácter estaba en el motion, no en el diseño.

## 5. CRO como hipótesis, no como promesa

La optimización de conversión es una hipótesis que se prueba. **No se garantiza** que más motion, más scroll o más tiempo en página produzcan más leads.

- **Hipótesis de ejemplo**: una demo que aclara el proceso **aumenta los contactos cualificados** frente a la versión estática.
- **Métrica principal**: lead cualificado, reserva, venta o registro, no scroll ni tiempo en página.
- **Diagnóstico**: exposición, inicio, errores, abandono. Las métricas de scroll y tiempo son contexto, no éxito.
- **Guardrails**: accesibilidad, rendimiento y calidad del lead. Una variante más rápida de generar pero peor para el lead no es ganadora.

### A/B testing con tráfico bajo

- A/B requiere tráfico suficiente para que la diferencia sea interpretable. Con tráfico bajo, **entrevistas + análisis de embudo** diagnostican mejor que un test A/B causal.
- Antes/después no es causal si cambian otras variables. Un A/B necesita **asignación aleatoria y consistente**, métrica predefinida, **regla de parada predefinida** y **no mirar p-valor para parar** (W10).
- Tareas de usabilidad con pocos usuarios dan dirección; los tests cuantitativos confirman o desmienten.

## 6. Patrones de motion con contraindicaciones

| Patrón | Cuándo encaja | Cuándo evitar |
| --- | --- | --- |
| Capítulos editoriales | Relato largo con cadencia propia | Como sustituto de la estructura de la información |
| Diagrama progresivo | Mostrar una secuencia con texto fijo | Móvil: apilar y permitir lectura sin scroll largo con pin |
| Before/after controlable | Comparación que el usuario activa | Comparación "engañosa" con keyframes que no se pueden pausar ni mover con teclado |
| Exploración del producto por estados | Producto, dashboard, UI rica | Cargar todo de golpe o saltarse el foco del teclado |
| Continuidad card → case | Transición narrativa entre casos | ViewTransitions sin fallback, foco o history bien cuidados |
| Feedback cerca del CTA | Confirmación inmediata del envío | Ocultar el error o la espera bajo animaciones |

## 7. Motion: cuatro tipos distintos

- **Disparado por estado**: aparece al completar una acción o un hover/focus.
- **Scroll-trigger**: aparece al entrar en viewport.
- **Scroll-linked**: ligado al progreso del scroll (parallax, progress).
- **Por tiempo**: timeline fijo.

Confundirlos lleva a animaciones que ignoran al usuario o que pierden accesibilidad.

## 8. Stack por capas

- **CSS y WAAPI** primero, con soporte local. Scroll timelines de CSS tienen soporte concreto (W02).
- **View Transitions API**: útil para transiciones, no aporta semántica ni foco por sí sola (W03).
- **GSAP**: timeline, pin/scrub y `gsap.matchMedia()` con limpieza por media query (W11, W12).
- **Motion (motion/react)**: estado y layout, con `prefers-reduced-motion` aplicado por defecto (W13).
- **Rive**: máquinas de estados diseñadas con HTML accesible; renderizar el canvas no exime de dar alternativas (W14).
- **SVG** para gráficos vectoriales; **Canvas** para procedural denso; **Three.js / R3F** cuando el volumen aporta; **vídeo prerender** frente a imagen cuando la estática no comunica el movimiento.

## 9. Accesibilidad WCAG 2.2

- **2.2.2 Pause, Stop, Hide (A)**: animación auto-iniciada de más de 5 s junto a otro contenido requiere pausa; no es opcional.
- **2.3.1 Three Flashes (A)**: no más de 3 destellos por segundo salvo umbral general.
- **2.3.3 Animation from Interactions (AAA)**: la paralaje por scroll y el motion significativo son **AAA, no AA**; el cumplimiento AA no exige evitarlo, pero la disciplina sí.
- **`prefers-reduced-motion`**: aplica a animaciones y transiciones; no sustituye al resto de la accesibilidad.
- **Foco de teclado, reflow, no drags-only**: la pieza debe ser operable sin ratón y sin arrastre.
- **Captions y audio description** cuando la pieza los requiera.

## 10. Rendimiento: Core Web Vitals

- **LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1** al percentil 75 móvil y escritorio (W04).
- Field data manda; Lighthouse es diagnóstico, no métrica de usuario real.
- `transform` y `opacity` cuando encajan; reservar tamaños de medios; lazy en lo que está fuera de vista; pausa de vídeo fuera de viewport; evitar `will-change` indiscriminado.
- No hacer scroll hijacking por defecto; no animar gratuitamente sobre errores, pagos o lectura larga.

## 11. Lo que este capítulo evita

- No garantiza CRO ni ranking de bibliotecas.
- No trata reduced-motion como sustituto del resto de accesibilidad.
- No usa parallax ni scroll-linked como cumplimiento AA; son decisiones AAA.
- No invierte la jerarquía: contenido, luego semántica, luego motion, luego estética.

## 12. Pendientes

- Medir en campo, no solo en Lighthouse, antes de cerrar el bucle CRO.
- Documentar el fallback de cada patrón de motion (reduced-motion, sin JS, sin canvas).
- Confirmar la compatibilidad de la API de scroll timelines con la matriz de navegadores objetivo.
- Cerrar el plan de CRO con métrica principal y regla de parada antes de empezar.
