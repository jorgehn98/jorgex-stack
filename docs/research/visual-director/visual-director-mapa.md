# Visual Director: mapa actual y arquitectura propuesta

Revisión: 2 de octubre de 2026. Fuente: la skill `visual-director/` original. Este documento es un análisis y una propuesta; no modifica la skill ni constituye una dirección aprobada.

> **Aviso histórico (2026-10-03).** Este mapa conserva su cuerpo del 2 de octubre de 2026 como **vista histórica** del estado y de la propuesta abierta; no se ha reescrito. La **arquitectura mínima cerrada** del primer borrador vive en [`Docs/00-encargo-y-arquitectura.md`](Docs/00-encargo-y-arquitectura.md) (2026-10-03) y es la **fuente autorizada** vigente. Si algo de este mapa entra en conflicto con `Docs/00`, manda `Docs/00`. El `SKILL.md`, `references/`, `assets/` y `evals/evals.json` siguen intactos; este mapa no los modifica.

## 1. Cómo funciona actualmente

```text
Invocación explícita de visual-director
│
├─ Revisar contexto, marca, assets, documentación y restricciones
├─ Identificar situación: nuevo diseño / rediseño / continuación
├─ Identificar medio: FRONTEND / VIDEO / BOTH
│
├─ 1. Brief
│     Objetivo, público, mensaje, formato, percepción y éxito
│     Preguntar solo lo que cambia decisiones relevantes
│
├─ 2. Dirección creativa
│     Si está abierta: 2–3 alternativas y recomendación
│     Si está aprobada: continuar sin reabrirla
│     Rediseño: preservar / reinterpretar / resolver
│
├─ 3. Sistema visual
│     Color, tipografía, composición, imagen, materiales y movimiento
│     Web: responsive y movimiento reducido
│     Vídeo: encuadre, legibilidad y relación con audio
│
├─ 4. Tecnología mínima suficiente
│     Web → frontend-routing.md
│     Vídeo → video-routing.md
│     Según necesidad → motion-graphics.md / 3d-shaders.md
│     OpenDesign opcional → recursos seleccionados, no ejecución
│
├─ 5. Plan y prototipo característico
│     Hero / interacción / transición / secuencia breve
│     Definir qué demuestra y cuándo habría que cambiar el enfoque
│
└─ 6. Ejecución y evaluación dentro del alcance pedido
      Inspección visual real, pruebas pertinentes y límites declarados
      Corregir → volver a comprobar las partes afectadas
```

No es una cadena que se repita desde cero: una petición de ideación termina en una propuesta; una continuación entra en la etapa pendiente. Las referencias se cargan según la decisión, no todas a la vez.

### Responsabilidades de los archivos existentes

| Archivo | Responsabilidad |
| --- | --- |
| `SKILL.md` | Núcleo creativo, selección de referencias y flujo de seis etapas. |
| `references/discovery.md` | Resolver vacíos del brief. |
| `references/visual-direction.md` | Concepto específico, referencias, jerarquía y límites de rediseño. |
| `references/design-system.md` | Paleta, tipografía, composición y lenguaje de movimiento. |
| `references/design-record.md` | Mantener una fuente de decisiones sin duplicar documentos. |
| `references/frontend-routing.md` | Selección técnica para web e interfaces. |
| `references/video-routing.md` | Vídeo programático, capas visuales y determinismo. |
| `references/motion-graphics.md` | Función, ritmo y gramática del movimiento. |
| `references/3d-shaders.md` | 3D, materiales, render y efectos procedurales. |
| `references/opendesign.md` | Lectura de recursos y lint opcional de OpenDesign. |
| `references/toolbox.md` y `references/recipes.md` | Comparaciones y combinaciones técnicas de partida. |
| `references/official-docs.md` | Enlaces para verificar las tecnologías al usarlas. |
| `references/quality-bar.md` | Revisión visual y técnica según el medio. |
| `assets/` | Dos plantillas opcionales: brief y plan visual. |
| `evals/evals.json` | 16 prompts con resultados esperados; su presencia no acredita que se hayan ejecutado o superado. |

## 2. Qué cubre y qué falta

| Área | Estado actual |
| --- | --- |
| Web, landings y rediseños | Cobertura explícita. También contempla interfaces, dashboards y experiencias inmersivas. |
| Vídeo programático y motion design | Cobertura explícita, especialmente Remotion, HyperFrames y animación técnica. |
| Cine y producto 3D | Referencias a Blender y Unreal, sin convertirlos en requisitos. |
| Material audiovisual existente | Contemplado como tipo de vídeo y mediante FFmpeg; falta desarrollar una ruta de edición propia. |
| Generación de imagen y vídeo con IA | Falta una ruta de producción explícita. No confundir los efectos procedurales actuales con generación de medios mediante modelos. |
| Voz, música y efectos sonoros | Se define su relación creativa y revisión, pero no una ruta completa de obtención, generación y producción. |
| Gráfica estática, campañas y presentaciones | Principios reutilizables, pero sin rutas de entrega específicas. |
| Identidad visual | Permite definir un sistema para una pieza; no cubre todavía un proceso completo de identidad de marca. |

### OpenDesign: documentación frente a instalación

La integración existe y está limitada deliberadamente a consultar guías, sistemas visuales y assets existentes, además de lint HTML opcional. Excluye lanzar agentes, generación remota implícita y publicación. Esas restricciones no deben eliminarse por añadir una rama generativa: ampliar permisos sería una decisión independiente.

La referencia documenta una instalación Linux probada el 14 de septiembre de 2026. En el entorno de esta revisión no se encontró `opendesign` en PATH; únicamente apareció `/usr/bin/od`. Esto no prueba que OpenDesign esté instalado ni que no exista en otra ruta. No se buscó una instalación fuera de PATH, no se inició ningún servicio y no se instalaron herramientas.

## 3. Mapa mental propuesto

```text
VISUAL DIRECTOR — núcleo común de dirección artística
│
├─ ENTENDER
│  ├─ Objetivo, público, mensaje y entregables
│  ├─ Nueva pieza / rediseño / continuación
│  ├─ Marca, material disponible y referencias
│  └─ Presupuesto, plazo, derechos y capacidades reales
│
├─ IDEAR
│  ├─ Concepto y percepción buscada
│  ├─ Referencias → características → decisiones justificadas
│  ├─ Alternativas solo cuando la dirección esté abierta
│  └─ Sistema compartido: color, tipo, composición e imagen
│
├─ ADAPTAR AL MEDIO
│  │
│  ├─ WEB / INTERFACES
│  │  ├─ Marketing, editorial, portfolio o comercio
│  │  ├─ Producto, dashboard o aplicación
│  │  └─ Experiencia interactiva / inmersiva
│  │     → Jerarquía, estados, responsive y accesibilidad
│  │
│  ├─ VÍDEO / AUDIOVISUAL
│  │  ├─ Motion design / tipografía / UI / datos
│  │  ├─ Cinematográfico / narrativo / producto
│  │  ├─ Montaje de material existente
│  │  └─ Híbrido
│  │     → Guion, storyboard, planos, ritmo, voz y sonido
│  │
│  └─ GRÁFICA ESTÁTICA
│     ├─ Imágenes, ilustración, carteles y miniaturas
│     ├─ Piezas de campaña y redes
│     └─ Presentaciones y composición editorial
│        → Jerarquía, formatos, legibilidad y exportación
│
├─ ELEGIR CÓMO PRODUCIR
│  ├─ Material existente / captura
│  ├─ Diseño y animación mediante código
│  ├─ Creación y render 3D
│  ├─ Generación de imagen / vídeo / voz / música / SFX
│  └─ Combinación de métodos con responsabilidades claras
│
├─ PROBAR
│  ├─ Web: composición o interacción principal
│  ├─ Vídeo: plano o secuencia con su audio pertinente
│  └─ Gráfica: pieza representativa en tamaño de uso
│     → ¿Funciona creativamente y es viable producirlo?
│     → Si no: revisar concepto, método o restricciones
│
└─ PRODUCIR, REVISAR Y ENTREGAR
   ├─ Mantener la dirección entre piezas y formatos
   ├─ Revisar con criterios específicos del medio
   ├─ Corregir y volver a verificar lo afectado
   └─ Declarar resultados reales, límites y compromisos
```

El medio y el método de producción son ejes distintos. Una imagen generada puede servir a una web, un cartel o un vídeo. Un vídeo cinematográfico puede producirse con rodaje, material existente, generación, 3D o una mezcla. Una estética no selecciona automáticamente una tecnología.

## 4. Cómo se ramifica la selección técnica

Estas son rutas conceptuales, no validaciones actuales de APIs, instalaciones o capacidades comerciales.

### Web

```text
Tipo de experiencia + dirección + stack existente
→ Estructura, CSS y SVG como base
→ Interacción de componentes: evaluar Motion si encaja
→ Coreografía compleja: evaluar GSAP u otra herramienta adecuada
→ Datos, 2D o 3D: añadir solo la capa necesaria
→ Imagen/vídeo de apoyo: obtener o producir assets por la ruta común
→ Verificar navegadores, accesibilidad, rendimiento y fallback
```

### Vídeo

```text
Mensaje + estilo + guion + material de origen
→ Elegir método dominante antes de elegir el renderizador
   ├─ Programático: comparar Remotion / HyperFrames / Motion Canvas
   ├─ Montaje: ruta de edición y composición de material existente
   ├─ 3D: evaluar entorno de creación y render
   └─ Generativo: escoger proveedor por capacidades y restricciones
→ Crear/obtener planos y audio
→ Componer, sincronizar, mezclar y finalizar
→ Revisar reproducción completa, continuidad y entrega
```

El problema de la referencia actual no es que compare Remotion con HyperFrames, sino que esa comparación ocupa demasiado pronto el centro de una ruta denominada genéricamente «vídeo».

### Producción generativa compartida

```text
Necesidad concreta de asset
→ ¿Existe material válido y autorizado?
→ Si se necesita generación: imagen / vídeo / voz / música / SFX
→ Comprobar herramienta, derechos, privacidad, coste y autorización
→ Definir referencias, consistencia y controles realmente disponibles
→ Crear una muestra pequeña, no una producción completa a ciegas
→ Revisar fidelidad de producto, identidad, continuidad y artefactos
→ Incorporar los assets aprobados a la pieza del medio elegido
```

Esta ruta debe distinguir orientación y ejecución. Recomendar una plataforma no autoriza subir material, clonar voces, gastar créditos o publicar. Las funciones de cada proveedor se verificarían al seleccionarlo, no se prometerían desde un catálogo estático.

## 5. Una skill o varias

**Recomendación: una skill principal con referencias modulares; skills técnicas separadas solo cuando exista una ejecución especializada que lo justifique.**

- El núcleo posee el brief, concepto, coherencia visual, selección de rutas y revisión creativa.
- Las ramas por medio adaptan el concepto y sus criterios de entrega.
- Las referencias de producción resuelven selección de herramientas, preparación de assets y restricciones.
- Una skill técnica, cuando haga falta, posee el uso de un runtime o plataforma; no vuelve a hacer el brief ni redefine la marca.
- Preferir skills oficiales o ya existentes antes de duplicar instrucciones de implementación.

```text
visual-director/
├─ SKILL.md                   # Núcleo breve y reglas de entrada
├─ references/
│  ├─ discovery.md            # Brief común
│  ├─ visual-direction.md     # Concepto común
│  ├─ design-system.md        # Sistema visual
│  ├─ design-record.md        # Autoridad de las decisiones
│  ├─ web.md                  # Ruta del medio web
│  ├─ video.md                # Ruta del medio audiovisual
│  ├─ graphic-design.md       # Ruta de gráfica estática
│  ├─ production/
│  │  ├─ programmatic-video.md
│  │  ├─ editing-compositing.md
│  │  ├─ generative-media.md
│  │  ├─ audio.md
│  │  ├─ motion.md
│  │  └─ 3d.md
│  ├─ tools/                 # Recursos y notas por herramienta
│  │  └─ opendesign.md
│  └─ quality-bar.md          # Criterios comunes y por medio
├─ assets/                   # Plantillas opcionales
└─ evals/                    # Casos que comprueban el enrutamiento
```

La estructura es ilustrativa: no exige mover todos los archivos ni crear una ficha por cada biblioteca. La organización física solo debe crecer cuando el contenido lo necesite. Los detalles extensos de una tecnología se cargan al elegirla, no al iniciar cualquier trabajo visual.

## 6. Prioridades para mejorarla

1. **Ampliar el enrutamiento**, conservando el núcleo creativo existente: medio, fase y método de producción.
2. **Separar vídeo de vídeo programático**: guion y dirección primero; renderizador cuando corresponda.
3. **Añadir producción generativa y audio** como capacidades compartidas, con costes, permisos, derechos y pruebas de muestra.
4. **Añadir gráfica estática** como tercera rama. Web y vídeo siguen siendo las principales. Identidad completa, impresión avanzada, XR o juegos pueden esperar a un uso real.
5. **Mantener OpenDesign como recurso opcional**, verificando su instalación antes de usarlo. Cualquier ampliación a generación requiere un cambio de alcance explícito.
6. **Añadir casos de evaluación**: vídeo generativo cinematográfico, montaje de material existente, campaña web/vídeo/gráfica coherente, herramienta indisponible, generación sin permiso de gasto y continuación de una dirección aprobada.

### Decisión todavía abierta: activación

La versión actual es manual: solo se activa con invocación explícita, y sus evaluaciones comprueban ese comportamiento. Convertirla en el director habitual de trabajos visuales sustanciales supondría cambiar descripción y evaluaciones. No debería dispararse para cualquier padding, botón o ajuste rutinario. Se recomienda resolver esta decisión antes de editar la skill.

## 7. Resultado de esta revisión

Se revisaron el núcleo, las 13 referencias, ambas plantillas y los 16 prompts existentes. Se comprobó la presencia de ejecutables en PATH, sin instalar ni iniciar herramientas. No se ejecutaron evaluaciones de comportamiento ni producción visual. La skill original queda intacta; este mapa distingue lo observado de la propuesta.
