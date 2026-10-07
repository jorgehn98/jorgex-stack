# Documentación de Visual Director Skill

La fuente activa de **Visual Director** se mantiene en `stack/skills/visual-director/` de este repo; Stack instala su copia compartida en `~/.agents/skills/visual-director/`. Este dossier reúne la investigación y el mapa; no es una dependencia de la skill instalada.

## Cómo usarla

> Usa @visual-director para [encargo].

La versión interna del paquete instalado es `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`); el nombre ya no lleva V2. La carga es solo explícita: El metadato original `metadata.opencode/autoinvoke: false` se conserva; no acredita el mismo enforcement en todos los hosts. Si una sesión anterior no reconoce el nuevo nombre, abre una sesión nueva. Para un agente con acceso a archivos también sirve pedirle que lea `~/.agents/skills/visual-director/SKILL.md`.

Instalar la skill no instala herramientas, conecta servicios ni autoriza gastos o publicaciones. Las instrucciones conservan autonomía dentro del encargo autorizado; las pruebas realizadas no limitan todos los futuros encargos a propuestas.

## Índice

| Contenido | Entrada |
| --- | --- |
| Investigación y arquitectura de preparación | [Índice del dossier](Docs/README.md) |
| Arquitectura mínima acordada | [Encargo y arquitectura](Docs/00-encargo-y-arquitectura.md) |
| Registro de fuentes | [Fuentes](Docs/fuentes.md) |
| Mapa histórico | [Mapa](visual-director-mapa.md) |

El material fuente analizado, los capítulos suplementarios 23–25 y el material de evaluación de las rondas de prueba no forman parte de este repositorio.

## Estado y siguientes pruebas

La versión interna del paquete instalado es `2.0.2-draft` (anteriormente `2.0.1-draft` y `2.0.0-draft`). Las evaluaciones fueron de planificación: primera ronda V2 20/20 frente a original 16/20; segunda ronda 20/20 en ambas; repetición focalizada 3/3 en ambas; **tercera ronda** `2.0.1-draft` 15/15 frente a `2.0.0-draft` 14/15; **cuarta ronda** `2.0.2-draft` 12/12 frente a `2.0.1-draft` 12/12. **No** certifican calidad visual, ejecución ni superioridad general; la revisión humana permanece pendiente.

Para probarla en uso, invócala con un encargo concreto y conserva los resultados reales y el feedback. Las mejoras se hacen en el canon `stack/skills/visual-director/` y los nuevos casos reutilizables en su `evals/`.
