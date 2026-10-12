# Landing Launch — dossier de investigación

Material de trabajo con el que se construyó la skill **Landing Launch**, cuya fuente vive en [`stack/skills/landing-launch/`](../../../stack/skills/landing-launch/SKILL.md). Sirve para modificar la skill con el contexto de por qué es como es; no es una dependencia de la skill instalada ni un conjunto de instrucciones activas, y no se incluye en el paquete npm.

La skill no se ha probado todavía con evaluaciones (casos de prueba ni optimización de la descripción). Este dossier no contiene resultados de evaluación.

## Cómo leerlo

- **Fechas.** La investigación legal se hizo y se contrastó el 2026-10-12. Las cifras, plazos y fechas legales de los capítulos eran las vigentes ese día; compruébalas en su fuente oficial antes de usarlas o de llevarlas a la skill.
- **Estado de la verificación legal.** Los tres informes legales marcan cada afirmación: `[OFICIAL]` o `[V]` (leída en fuente oficial), `[TERCEROS]` (interpretación de despachos, blogs o proveedores) y `[NV]`/`[NO VERIFICADO]` (no comprobada). Las páginas se leyeron con una herramienta que devuelve un resumen, no el texto íntegro, y algunas fuentes oficiales dieron error de acceso (por ejemplo, partes de la legislación de California y EUR-Lex en algún caso). Lo marcado como no verificado o de terceros no debe citarse sin releer la fuente. Los informes describen lo que dicen las normas; no son asesoramiento legal.
- **Volátil.** Leyes, umbrales, sanciones, versiones de guías oficiales, requisitos de plataformas y APIs cambian. La skill lleva solo lo estable y enlaza a la fuente oficial para lo demás; si se amplía, hay que mantener ese criterio y volver a verificar.
- **Material fuente.** El material de terceros analizado no forma parte de este repositorio. No se añade aquí material de terceros, binarios, transcripciones ni rutas personales.

## Cómo se derivó la skill

1. Se partió de [Marketing Skills](https://github.com/coreyhaines31/marketingskills), de Corey Haines (licencia MIT), como base de criterios de marketing y CRO. Se leyó, se filtró y se condensó; no se copió entera. Por eso la skill lleva un `NOTICE.md` con la licencia y cada referencia cita sus fuentes.
2. Se completó con búsqueda web y documentación oficial (Google Search Central, web.dev, WCAG, autoridades de protección de datos y similares) para lo que cambia o para lo que el repositorio no cubre (legal, rendimiento, accesibilidad, español).
3. Para cada fase se escribió un extracto en español (capítulos 01–11) con lo que se queda, lo que se descarta y por qué. Con ellos se redactó la skill final, en inglés.

## Decisiones tomadas

- `SKILL.md` define propósito, entrada y salida, tipos de landing, orden y puertas de calidad, sin detalles de implementación. Cada archivo de `references/` recoge qué decidir, qué entrega, cómo implementarlo (solo lo que una IA no acierta sola), cómo verificar y la puerta a la siguiente fase.
- La jurisdicción es un dato de entrada: se pregunta al usuario y el legal se organiza por jurisdicción. La norma que importa suele ser la del lugar donde residen los usuarios, no la de la sede del titular.
- Lo que depende de versión, API o ley vigente no se memoriza: se consulta en documentación oficial (Context7 u otra fuente) y se enlaza.
- La entrada es un diseño ya aprobado (Visual Director) y el stack del proyecto. La skill no diseña.
- Psicología y CRO no tienen archivo propio: se funden en la fase 03; el CRO como proceso de iteración va en la 11.
- La fase 10 (rendimiento y accesibilidad) se añadió a petición expresa del titular, tras captación, analítica y legal (para que scripts y banner ya estén definidos) y antes de la QA final, que pasó a ser la fase 11.
- Dos modos: crear (once fases con puertas) y auditar (completo o por área).
- Criterio al resumir: se queda lo que tiene consecuencias, los errores frecuentes, los detalles cambiantes y el orden entre fases; se va lo básico que una IA ya sabe hacer.

## Qué se descartó y por qué

| Descartado | Motivo |
| --- | --- |
| SEO programático y arquitectura de sitios grandes | Decisión del titular: la skill no cubre sitios grandes. |
| Competidores, plan de marketing, anuncios, emails y similares | Fuera del alcance de una landing. |
| Lanzamiento de producto (Product Hunt, fases alfa/beta, anuncios) | Estrategia de producto, no de una landing. |
| Estudios de precio avanzados (Van Westendorp, MaxDiff), subidas de precio, paywalls | Estrategia continua; queda como nota, no como fase. |
| GTM en detalle, analítica de producto (Mixpanel, Amplitude, Segment), MMM, incrementalidad | Excede lo que necesita una landing. |
| Programas de contenido para IA (LinkedIn, YouTube, listados y comparativas) | Son programas de contenido, no una landing. |
| Panel de expertos con puntuación en copy | Añade proceso sin mejorar el resultado. |

Cada extracto indica al inicio sus fuentes y, al final o en línea, lo descartado en esa fase.

## Capítulos

| Fase de la skill | Extracto |
| --- | --- |
| 01 Brief | [01-brief.md](01-brief.md) |
| 02 Mensaje, oferta y precio | [02-mensaje-y-precio.md](02-mensaje-y-precio.md) |
| 03 Estructura y conversión | [03-arquitectura-y-conversion.md](03-arquitectura-y-conversion.md) |
| 04 Copywriting | [04-copywriting.md](04-copywriting.md) |
| 05 SEO | [05-seo.md](05-seo.md) |
| 06 Visibilidad en buscadores de IA | [06-seo-ia.md](06-seo-ia.md) |
| 07 Captación | [07-captacion.md](07-captacion.md) |
| 08 Analítica | [08-analitica.md](08-analitica.md) |
| 09 Legal y consentimiento | [09-legal.md](09-legal.md) |
| 10 Rendimiento y accesibilidad | [10-rendimiento-y-accesibilidad.md](10-rendimiento-y-accesibilidad.md) |
| 11 QA, lanzamiento e iteración | [11-qa-lanzamiento-iteracion.md](11-qa-lanzamiento-iteracion.md) |

Investigaciones legales que sustentan el capítulo 09:

- [legal-ue-es.md](legal-ue-es.md): Unión Europea y España.
- [legal-uk-us.md](legal-uk-us.md): Reino Unido y Estados Unidos.
- [legal-latam-global.md](legal-latam-global.md): Latinoamérica y otros mercados.

Los extractos son borradores de extracción en español; la skill final (en inglés) los resume y prevalece sobre ellos. Si difieren, manda la skill.
