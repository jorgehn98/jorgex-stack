# 03-arquitectura-y-conversion — extractos

Fuentes: Marketing Skills (Corey Haines, MIT), skill marketing-psychology (filtrado). Más: cro (SKILL + experiments), signup, site-architecture (descartada), búsqueda web sobre estructura y datos de CTA. Estado: borrador completo de la fase.

## Criterio de filtrado
De ~80 modelos del origen se conservan solo los que cambian decisiones de una landing. Descartados por no aplicar al lanzamiento de una página: modelos de pensamiento estratégico (Pareto, Lindy, barbell, circle of competence, etc.), modelos de crecimiento (flywheel, network effects, loops, switching costs), retención/churn.

## Modelos útiles → dónde se aplican
| Modelo | Regla para la landing |
|---|---|
| Ley de Hick | Menos opciones = más decisiones. Un CTA principal; formularios con los campos mínimos; 3 tramos de precio, no 7. |
| Fogg (Motivación × Capacidad × Disparador) | Falta uno = no hay acción. Alta motivación pero esfuerzo alto no convierte; fácil pero sin CTA visible tampoco. |
| Energía de activación | Primer paso trivial: precargar, plantillas, victoria rápida, formulario corto. |
| Anclaje | Primer número visto condiciona. Mostrar el precio alto/original/competidor antes. |
| Señuelo / Good-Better-Best | El tramo medio es el objetivo; el caro lo hace razonable, el barato ancla. |
| Efecto por defecto | Preseleccionar el plan recomendado. (Nunca casillas de consentimiento premarcadas: ver legal.) |
| Paradoja de la elección | Una opción "la mejor para la mayoría". |
| Prueba social | Cifras de clientes, testimonios con nombre, logos, reseñas; los números dan confianza. |
| Autoridad | Certificaciones, "aparecido en", avales de expertos. |
| Reciprocidad | Dar valor antes de pedir (recurso útil, versión gratuita). |
| Compromiso y coherencia / pie en la puerta | Pedir un paso pequeño primero (email, prueba) antes del grande. |
| Aversión a la pérdida | Enmarcar lo que pierden por no actuar; solo con datos reales. |
| Aversión al arrepentimiento | Garantía, prueba gratis, "sin permanencia" junto al CTA. |
| Efecto pratfall | Admitir una limitación ("no somos los más baratos, pero…") sube confianza. |
| Maldición del conocimiento | Lo obvio para ti confunde al recién llegado; probar el copy con alguien ajeno al sector. |
| Contraste / antes-después | Mostrar el "antes" con claridad para que el "después" se note. |
| Encuadre | "90% de éxito" ≠ "10% de fallo"; encuadrar en positivo con el mismo dato. |
| Contabilidad mental | "3 €/día" se percibe distinto de "90 €/mes"; usar solo si es honesto. |
| Efecto cero-precio | Gratis es psicológicamente distinto de barato; pasar de 1 a 0 pesa más que de 2 a 1. |
| Descuento hiperbólico | Priorizar beneficio inmediato ("empieza hoy") sobre el lejano. |
| Gradiente de meta / Zeigarnik | Progreso visible y tareas abiertas empujan a completar (multi-paso, onboarding). |
| Exposición simple / sesgo de similitud | Consistencia de marca; historia del fundador, "hecho por X para X". |
| Precios | Terminación en 9 = valor; redondo = premium. Regla del 100: bajo 100 € mejor "20% dto."; sobre 100 € mejor "50 € dto.". |
| Escasez | Solo genuina (ver 02-F). |
| AIDA | Estructura de la página: atención, interés, deseo, acción. |

## Tabla problema → modelos (conservar)
Conversión baja: Hick, energía de activación, Fogg. Objeción de precio: anclaje, encuadre, contabilidad mental, aversión a la pérdida. Confianza: autoridad, prueba social, reciprocidad, pratfall. Urgencia: escasez real, aversión a la pérdida. Parálisis de decisión: paradoja de la elección, defecto, nudge.

## Guardarraíl ético (del origen, mantener)
Aplicar con honestidad: escasez y pérdida solo si son reales; defecto y urgencia nunca como patrón oscuro. Esto enlaza con la parte legal de consentimiento y con la regla anti-escasez-falsa de 02-F.

## Estructura de la página (orden = orden de las preguntas del lector)
Secuencia base (SaaS/lead-gen): hero (qué es, para quién, por qué importa + CTA) > prueba social breve > problema > solución/funciones como beneficios > cómo funciona > testimonios/casos > precio (si aplica) > FAQ (3-7 preguntas, las objeciones reales de 02) > CTA final.
- Lógica: enganchar, validar, explicar, probar, habilitar, resolver dudas, convertir. Precio antes de explicar el valor, o FAQ antes de la prueba, rompe el flujo (afirmación de blogs, sin datos de test; tratar como heurística).
- Prueba social: una línea o barra de logos en el hero o justo debajo, y repetida junto a los CTAs. Excepción: si una figura reconocible carga el hero, la prueba puede ir más abajo.
- Longitud por conciencia (02-B): más consciente = corta y orientada a oferta; menos consciente = más larga, con problema y educación.
- Variantes por tipo (a validar al implementar):
  - Ecommerce/producto: hero > bloque de compra > beneficios > prueba social > FAQ/upsell.
  - Lead-gen/anuncios: sin navegación, móvil primero, un solo color de CTA, formulario con los campos mínimos.
  - Waitlist/lanzamiento: hero + email + prueba/expectativa + FAQ corta; página corta.
  - Servicio local/pyme: qué hago, dónde, prueba (reseñas, casos), proceso, contacto visible (teléfono/mapa), FAQ.
- Hueco declarado: las fuentes dan poca guía fiable para webinar, app-download y B2B enterprise; si aparece uno, buscar aparte.
- Descartado: `site-architecture` (jerarquía de sitios, migraciones, navegación de varias páginas). Una landing es una página; solo se conserva "navegación mínima".

## Reglas de conversión (CRO, orden por impacto)
1. **Claridad de propuesta de valor** (mayor impacto): ¿se entiende qué es y por qué importa en 5 segundos? Beneficio principal específico y diferenciado, en palabras del cliente, no del equipo. Fallos: centrado en funciones, demasiado vago o demasiado ingenioso, decir todo en vez de lo más importante.
2. **Titular**: comunica el valor central, es específico (números, plazos), coincide con la fuente de tráfico. Patrones: "obtén [resultado] sin [dolor]", especificidad, prueba social ("+10.000 equipos").
3. **CTA**: una acción principal, visible sin scroll (en 375 px de ancho), con copy de valor ("Obtener mi informe", no "Enviar"/"Saber más"), repetida en hero, mitad y final. Jerarquía clara entre primario y secundario.
4. **Jerarquía visual y escaneo**: el mensaje debe salir de un vistazo; imágenes que apoyan, no distraen. (El diseño lo fija Visual Director; aquí solo se verifica.)
5. **Prueba y confianza**: logos, testimonios atribuidos con foto, casos con cifras reales, reseñas, sellos de seguridad si procede; junto a los CTAs y tras las afirmaciones de beneficio.
6. **Manejo de objeciones**: precio/valor, "¿funcionará para mí?", dificultad de implantación, "¿y si no funciona?"; vía FAQ, garantía, comparativa, transparencia del proceso.
7. **Fricción**: demasiados campos, pasos poco claros, navegación confusa, datos innecesarios, móvil, carga lenta.

### Datos sobre CTA y navegación (con cautela)
- Quitar navegación y usar un solo CTA es el consejo mayoritario. Cifras citadas: 1 CTA 13,5%, 2 CTA 11,9%, 3+ CTA 10,5% (análisis Unbounce, 18.639 páginas, vía terceros); caso VWO de 3% a 6% al quitar nav (un solo sitio, mejor caso, no típico). Descartada la cifra "+266%" por contradecir al resto.
- CTA fijo (sticky) en móvil: estudio de 2.000 páginas (T4 2025-T1 2026) +11% solo sticky, +6% solo above-fold, +12% ambos: no se acumulan. Usar sticky solo si la página supera ~2 pantallas; en páginas cortas sobra.
- Formulario above-fold si tráfico caliente; tras la prueba si tráfico frío de pago.
- Tasas de conversión móvil vs escritorio varían mucho por fuente; no fijar benchmarks absolutos en la skill, medir los propios.
Fuentes: [Digital Applied (2.000 páginas)](https://www.digitalapplied.com/blog/landing-page-conversion-study-2000-pages-tested-2026), [Colorlib](https://colorlib.com/wp/landing-page-statistics/), [21st.dev](https://21st.dev/blog/landing-page-sections), [involve.me](https://www.involve.me/blog/landing-page-structure).

## Formato de salida de la fase (de cro, adaptado)
Entregar: mapa de secciones (orden + función + qué pregunta responde cada una), mapa de CTAs, lista de pruebas/objeciones asignadas a secciones, y una lista de "victorias rápidas" frente a "cambios de alto impacto". Hipótesis para testear solo después del lanzamiento (fase 10).

## Puerta
No se pasa a 04 sin mapa de secciones aprobado y CTA principal definido. Si la arquitectura exige secciones que el diseño no tiene, volver a Visual Director.
