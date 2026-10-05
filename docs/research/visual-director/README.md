# Documentación de Visual Director Skill

La fuente activa de **Visual Director** se mantiene en `stack/skills/visual-director/` de este repo; Stack instala su copia compartida en `~/.agents/skills/visual-director/`. Este dossier reúne la investigación, el mapa y la evidencia de las pruebas; no es una dependencia de la skill instalada.

El dossier vive ahora en `docs/research/visual-director/` de JorgeX Stack, trasladado desde el Escritorio para continuar aquí la investigación y el análisis de proyectos externos. La skill activa no se ha modificado en este traslado.

## Cómo usarla

> Usa @visual-director para [encargo].

La versión interna del paquete instalado es `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`); el nombre ya no lleva V2. La carga es solo explícita: El metadato original `metadata.opencode/autoinvoke: false` se conserva; no acredita el mismo enforcement en todos los hosts. Si una sesión anterior no reconoce el nuevo nombre, abre una sesión nueva. Para un agente con acceso a archivos también sirve pedirle que lea `~/.agents/skills/visual-director/SKILL.md`.

Instalar la skill no instala herramientas, conecta servicios ni autoriza gastos o publicaciones. Las instrucciones conservan autonomía dentro del encargo autorizado; las pruebas realizadas no limitan todos los futuros encargos a propuestas.

## Índice

| Contenido | Entrada |
| --- | --- |
| Investigación y arquitectura de preparación | [Índice del dossier](Docs/README.md) |
| Arquitectura mínima acordada | [Encargo y arquitectura](Docs/00-encargo-y-arquitectura.md) |
| Mapa histórico | [Mapa](visual-director-mapa.md) |
| Snapshot original usado en las pruebas, no instalación activa | [Baseline histórico](visual-director-v2-workspace/skill-snapshot/visual-director/SKILL.md) |
| Método, límites y evidencia de evaluación | [Workspace](visual-director-v2-workspace/README.md) |
| Primera ronda: cuatro propuestas | [Resultados](visual-director-v2-workspace/iteration-1/benchmark.md) · [Visor](visual-director-v2-workspace/iteration-1/review.html) |
| Segunda ronda: conversaciones y repetición | [Método](visual-director-v2-workspace/iteration-2/README.md) · [Resultados](visual-director-v2-workspace/iteration-2/benchmark.md) · [Visor](visual-director-v2-workspace/iteration-2/review.html) |
| Tercera ronda: pieza audiovisual, puente RGB→JS, revisión export/caché — propuesta `2.0.1-draft` vs `2.0.0-draft` | [Método](visual-director-v2-workspace/iteration-3/README.md) · [Resultados](visual-director-v2-workspace/iteration-3/benchmark.md) · [Visor](visual-director-v2-workspace/iteration-3/review.html) |
| Cuarta ronda: controles derivados de BLISS — propuesta `2.0.2-draft` vs `2.0.1-draft` | [Método](visual-director-v2-workspace/iteration-4/README.md) · [Resultados](visual-director-v2-workspace/iteration-4/benchmark.md) · [Visor](visual-director-v2-workspace/iteration-4/review.html) |
| Inventario e integridad del primer traslado, registro histórico | [Manifiesto](traslado.json) |
| Caso 24: revisión estática del repo `JohnHeibel/PDoomVideo` (SHA pinned) y un prompt del usuario para una producción derivada — aplicado a `2.0.1-draft` | [Capítulo 24](Docs/24-pdoomvideo-y-produccion-derivada.md) · [Fuentes PV01–PV04](Docs/fuentes.md) |
| Caso 25: revisión estática del paquete `bliss-making-of/` (327 archivos, 360.413.558 bytes), método portable extraído y aplicación a `2.0.2-draft` | [Capítulo 25](Docs/25-bliss-making-of-y-composicion-hibrida.md) · [Manifiesto](Docs/bliss-source-manifest.json) · [Fuentes BL01–BL10](Docs/fuentes.md) |

## Qué se conservó

- La investigación en `Docs/` y el mapa en la raíz, donde los colocó el usuario. La carpeta operativa original de 17 archivos se eliminó por su petición.
- El workspace: 188 archivos trasladados sin cambiar transcripciones, resultados, snapshots ni visores.
- La skill instalada se renombró de `visual-director-v2` a `visual-director`: carpeta, manifiesto, invocación y `skill_name` de los casos actuales. No cambiaron los métodos ni los permisos; se mantiene la carga manual.

Los snapshots son versiones congeladas para comparación, **no instalaciones activas**. No se deben editar para incorporar mejoras futuras.

## Rutas antiguas y actuales

| Antes, en el Escritorio | Ahora |
| --- | --- |
| `visual-director-v2/` | `~/.agents/skills/visual-director/` |
| `visual-director/Docs/` y su mapa | `docs/research/visual-director/Docs/` y `visual-director-mapa.md` |
| Skill operativa original `visual-director/` | Eliminada; baseline de pruebas conservada en el workspace |
| `visual-director-v2-workspace/` | `docs/research/visual-director/visual-director-v2-workspace/` |

Las rutas absolutas antiguas, los nombres V1/V2 y los hashes en registros de ejecución se mantienen tal como se capturaron. El manifiesto `traslado.json` describe el primer traslado, anterior a esta eliminación y renombrado. Los enlaces del índice y los visores llevan a las ubicaciones actuales.

## Estado y siguientes pruebas

La versión interna del paquete instalado es `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`). Las evaluaciones fueron de planificación: primera ronda V2 20/20 frente a original 16/20; segunda ronda 20/20 en ambas; repetición focalizada 3/3 en ambas; **tercera ronda** `2.0.1-draft` 15/15 frente a `2.0.0-draft` 14/15; **cuarta ronda** `2.0.2-draft` 12/12 frente a `2.0.1-draft` 12/12. **No** certifican calidad visual, ejecución ni superioridad general; la revisión humana permanece pendiente.

Para probarla en uso, invócala con un encargo concreto y conserva los resultados reales y el feedback. Las mejoras se hacen en el canon `stack/skills/visual-director/`; los nuevos casos reutilizables en su `evals/`, y la evidencia de cada nueva ronda en este workspace, sin sobrescribir rondas anteriores.
