# 19 — Dirección creativa, prototipos y crítica

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó. Fuentes: [fuentes.md](fuentes.md) (CR01–CR05).

## 1. Lo que se transfiere y lo que no

- **CR01 Impeccable (SKILL.src.md + reference/critique.md + LICENSE)** — vocabulario de "refine" (preserva identidad; el rediseño reemplaza el mundo, no el contenido/función/verdad del original) y de "critique" (focus genericity test: otro producto podría usar el diseño sin cambios ⇒ señal de genericidad).
- **CR02 Anthropic frontend-design (SKILL.md + LICENSE.txt del directorio)** — tema, material y lengua del encargo **mandan** sobre advertencias genéricas; el rechazo del cliché se asume desde la historia del cliente, no desde una regla universal; "un único hero con característica dominante" como disposición, no como ley que obligue a una sola apuesta por pieza.
- **CR03 Google design review** — lentes `problem / solution / implementation` como separación; no prescribe un diagrama largo obligatorio ni exige unificar las tres lentes.
- **CR04 IDEO — 7 principles to guide your prototyping (18 jul 2024)** — ejemplo real (masaje) donde el prototipo ergonómico precede a la UI durante meses; la fidelidad correcta **depende** del caso (no siempre wireframe, no siempre acabado premium, no siempre cientos de variantes); un prototipo impreso roto filmado en vídeo muestra la función previa, no un objeto roto entregado.
- **CR05 Disney Animation — layout process (all rights reserved visible)** — storyboard → layout (cámara + acting aproximados) que puede **apartarse** del board para servir claridad/emoción; verificación de lens, POV, cámara y shot cut; la propuesta cruza medios (página editorial, pieza) en su contexto, no aislada.

El método se sintetiza a partir de fuentes profesionales y de skill; la pasada que produjo este capítulo no leyó repos remotos. Cada fuente se cita con su SHA pinned y la URL exacta por archivo; lo verificado por lectura se distingue de lo declarado por metadatos (ver [fuentes.md](fuentes.md)).

## 2. Seis principios operativos de la dirección

- **Brief con frontera**: el alcance, los límites del dominio y la decisión sobre lo incierto se declaran antes de prototipar; el prototipo no sustituye al brief, lo verifica.
- **Específico del dominio**: el método se elige por medio (página editorial, animación, vídeo, interactivo, infografía); no se aplica un patrón único.
- **Decisión sobre incertidumbre**: ante huecos no resueltos, el prototipo decide con un alcance explícito, no rellena con un gusto personal.
- **Referencias en la decisión y durante la ejecución**: las referencias ayudan a decidir y pueden consultarse durante la ejecución y revisión. Se contrastan con el brief y las decisiones vigentes; no sustituyen el alcance aprobado.
- **Storyboard no congela**: el storyboard orienta cámara y acting; el layout puede apartarse para servir emoción o claridad.
- **Lentes arte + técnica + humano, recuperables**: la entrega deja espacio para corregir sin reescritura total; el registro de decisiones y el handoff breve recuperable no limita ni sustituye el entregable solicitado.

## 3. Roles distintos, no intercambiables

- **Intención** ≠ **aprobación** ≠ **delegación** ≠ **evidencia**. La elección del usuario no certifica el resultado en runtime; la aprobación del usuario no es un permiso de gasto, subida o publicación; la delegación no exime de la prueba.
- **Permiso creativo ≠ dinero, subida o publicación**: la ejecución continúa en la fase y dentro del alcance ya autorizados, incluidos prototipo o producción cuando procedan. La aprobación creativa no amplía por sí sola permisos de gasto, subida de material o publicación; no se exige otra aprobación ceremonial para producción ya autorizada.

## 4. Flujo de trabajo propuesto

```
orient (contexto existente + preguntas + material)
  → propone 2–3 direcciones reales (sólo si la intención está abierta)
  → decide una dirección concreta
  → prueba lo relevante (no todo)
  → crítica/corrige sólo lo que cambió
  → cierra contra el brief
```

- **Orient**: revisar el contexto existente, las preguntas abiertas y el material disponible; no inventar contexto.
- **Propone 2–3**: sólo si la intención sigue abierta; cada dirección debe ser **real** (no seudo-opciones).
- **Decide**: una dirección concreta, no tres a la vez.
- **Prueba lo relevante**: el prototipo responde a una pregunta, no a todas.
- **Crítica/corrige**: aplicar el focus genericity test (CR01) y los lentes `problem/solution/implementation` (CR03); corregir sólo lo que cambió.
- **Cierre**: comprobar contra el brief; archivar la decisión y el material que la sostiene.

## 5. Prototipo como pregunta, no como preview

- **Ergonomía antes que UI** (CR04): si la duda es de agarre, presión, distancia o tamaño, el prototipo se construye y se prueba antes de la UI.
- **Fidelidad dependiente**: low-fi cuando se duda del flujo; high-fi cuando se duda del acabado visual; no se sube la fidelidad para "vender mejor".
- **Iteración limitada, no infinita**: si aparece un defecto material, se añade una pasada de verificación; el método no se convierte en "una sola pasada para siempre".
- **Storyboard como herramienta de cámara, no como plan congelado** (CR05): el storyboard sirve para verificar lens, POV y shot cut; el layout se aparta cuando lo pide la emoción o la claridad.

## 6. Crítica: separar diseño del detector

- **Diseño de la crítica** (qué preguntar) **≠** detector (qué medir automáticamente). El detector reduce el anclaje; no decide.
- **Focus genericity test** (CR01): que la composición pueda servir a otro producto es una señal para revisar su especificidad, no una prueba automática de falta de identidad. Contrastar con el brief, la función y las convenciones del medio: patrones compartidos pueden estar justificados.
- **Lentes** (CR03): revisar la pieza con cada lente por separado, no mezclarlas.
- **No adoptar**:
  - Dos subagentes obligatorios como panel.
  - Nielsen proporcional como métrica universal.
  - Usuarios simulados por personas ficticias en lugar de usuarios reales.
  - Una sola pasada de revisión como práctica fija.

## 7. Lo que el método no promete

- No afirma creatividad superior a una persona concreta; el método reduce ruido, no produce genio.
- No sustituye a la decisión del usuario; el método estructura la conversación, no la cierra.
- No generaliza patrones únicos a todo medio; cada medio conserva su especificidad.
