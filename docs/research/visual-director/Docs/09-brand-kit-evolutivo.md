# 09 — Brand kit evolutivo

> Investigación y propuesta. 2026-10-02. Define cómo se conserva y se reutiliza el estilo de un resultado final aprobado, separado de la dirección provisional durante la producción. El detalle por fuente de dato está en [15-marca-portable-y-grafica-fija.md](15-marca-portable-y-grafica-fija.md) §2 y la cobertura del tema en [18-cobertura-del-encargo.md](18-cobertura-del-encargo.md). Fuentes en [fuentes.md](fuentes.md) (M01, M05, H05, H06, H07, TS01, E01, E04, BK01–BK03, FN01, LP01, LP02).
>
> **Aviso de autoridad (2026-10-03).** Este capítulo se redactó bajo la arquitectura abierta del 2 de octubre. La **arquitectura mínima cerrada** del primer borrador vive en [`00-encargo-y-arquitectura.md`](00-encargo-y-arquitectura.md) (especialmente §10 "one home per dato", que confirma que el brand kit es del proyecto, no de la skill, y que una aprobación editorial no equivale a verificación técnica); la separación provisional/canónico descrita aquí se mantiene alineada con `00`.

## 1. Qué es y qué no es

El brand kit que interesa es el **estilo reutilizable del resultado final aprobado por el usuario** (o por una decisión explícitamente delegada). No es:

- La idea inicial del brief, que puede haber cambiado durante la producción.
- La dirección provisional durante el trabajo, que es de iteración, no canónica.
- Una paleta o tipografía de catálogo copiada sin relación con lo aplicado.
- Una guía de estilo de marca (style guide) externa; el brand kit es el **índice de lo que la skill realmente aplicó y aprobó** en un proyecto.

## 2. Single owner (un dueño por dato, no un archivo para todo)

El brand kit tiene **un único dueño** en el proyecto, pero los **datos** que contiene proceden de fuentes distintas. **No** se replica la paleta en muchos documentos: se referencia desde el brand kit, que a su vez referencia al registro. La separación de responsabilidades sigue lo descrito en [04-conversacion-autonomia-y-revision.md](04-conversacion-autonomia-y-revision.md) §2.1:

- **PRD**: objetivos, alcance, criterios de negocio. No contiene el brand kit.
- **Registro de diseño (`DESIGN.md` o equivalente del proyecto)**: decisiones visuales, razones, referencias. Aquí vive el brand kit, si el proyecto lo tiene.
- **Plan de tareas**: estados, dependencias, gates. No contiene el brand kit.

**Fuentes de cada dato del brand kit** (ver detalle en [15-marca-portable-y-grafica-fija.md](15-marca-portable-y-grafica-fija.md) §2):

- **Valores exactos** (códigos de tokens, hex, tamaños): proceden de un sistema de tokens propio del proyecto (BK01 DTCG, BK02 Style Dictionary, BK03 Tokens Studio) o de los assets aprobados; cada valor tiene **un dueño** en el código o en el archivo maestro.
- **Intención**: vive en el `DESIGN.md` del proyecto (o equivalente). Se registra como `declarado` o `aprobado` con la razón de la decisión.
- **Assets originales y derechos**: cada asset con su archivo fuente y su licencia; no se asume "del banco" o "del estilo de la marca" sin archivo.
- **Versión vigente del master**: el render o export aprobado más reciente, con su ruta y su fecha.

El brand kit **no** se referencia a sí mismo en bucle: cada campo tiene una fuente fuera del propio brand kit.

## 3. Provisional vs canónico

Durante la producción hay tokens de trabajo, decisiones parciales y direcciones provisionales. **Esos materiales no entran al brand kit**. Se mantienen donde corresponde (en el registro del proyecto, en el material de iteración) hasta que:

- El usuario aprueba el resultado final de la pieza.
- O el usuario delega explícitamente la decisión de aprobación (por ejemplo, "esta variante sirve como referencia de marca para próximos encargos").

Cuando el usuario aprueba el resultado final y pide que el master sirva como **referencia para próximos encargos** (kit reutilizable), el resultado entra al brand kit del proyecto como **ejemplo aprobado** de forma automática con la aceptación, **sin** una autorización ceremonial adicional. Esta entrada cubre el master específico: **no** convierte la excepción de campaña en **norma de identidad**. La promoción a norma de identidad (es decir, que el ejemplo se promulgue como regla general del kit) requiere una **autorización expresa o delegada**; esa autorización puede ser **la misma aprobación del usuario** si este la pidió como cambio de marca al aceptar el master. En ausencia de esa autorización adicional, el ejemplo queda registrado como aprobado con su alcance, sin sustituir las reglas generales. Solo entonces se extrae lo realmente aplicado y se incorpora al brand kit canónico, como **referencia aprobada** (no como directriz absoluta).

## 4. Qué guarda el brand kit

El brand kit guarda, en la medida en que aplique al proyecto:

- **Versión, fecha y aprobación**: qué versión se aprobó, cuándo y por quién.
- **Master del resultado**: dónde está el render final o el export aceptado.
- **Assets originales y derechos**: archivos fuente (vectores, fuentes, modelos 3D, audio) con su licencia y atribución.
- **Paleta por rol**: colores por rol semántico (no lista plana), con su valor y token si existe.
- **Tipografía por rol**: familia, peso, uso (display, cuerpo, mono, microtype), fallback.
- **Principios de composición**: jerarquía, ritmo, contraste, márgenes, alineación, densidad.
- **Imagen y voz visual**: tratamiento de fotografía, ilustración, materiales, dirección de arte.
- **Motion, cámara y audio**: lenguaje de movimiento, transiciones, ritmo, microinteracciones cuando aplique; encuadre, profundidad, grano; voice-over, música, SFX si la marca los define.
- **Ejemplos aprobados y excepciones**: casos concretos que el usuario aceptó y casos donde se apartó de la norma con justificación.
- **Estado antes de provisional** (opcional): si el usuario quiere evitar repetir una versión rechazada, el contexto se documenta como **enlace opcional** al registro del proyecto; **no** es parte del brand kit canónico ni ocupa lugar en la lista de campos activos.

## 5. Lo que el brand kit no hace

- **No impone formato de frontmatter de un vendor concreto**: el brand kit usa los campos que el proyecto necesita, no una plantilla externa.
- **No se sobrescribe con feedback provisional** ni con una nueva exploración que aún no ha sido aprobada. Si el feedback provisional propone una **nueva dirección autorizada** (diferente a la que produjo el canónico), el feedback provisional puede crear **una nueva pieza provisional** sin sobrescribir el canónico. La aprobación de la pieza provisional **no** equivale a la aprobación de un cambio de marca: una variante de campaña aprobada se registra como **ejemplo aprobado con su alcance**; **no** sustituye las reglas generales de identidad salvo que ese cambio también esté autorizado. Una dirección nueva autorizada puede aplicarse a la pieza aunque el kit vigente siga protegido.
- **Guardar el resultado final aceptado como ejemplo aprobado** es legítimo cuando el usuario lo pide para reutilización ("este master sirve como referencia para próximos encargos"). En ese caso el resultado aceptado entra al brand kit del proyecto como **ejemplo aprobado reutilizable**, de forma automática con la aceptación del master, **sin** una autorización ceremonial adicional. Esta entrada **no** convierte la excepción de campaña en **norma de identidad**; la promoción a norma de identidad requiere una autorización expresa o delegada, que puede ser la misma aprobación del usuario si este pide el cambio de marca al aceptar el master.
- **Nueva dirección creativa** que el usuario autoriza **no** hace que el canónico derrote la intención actualizada del usuario. El canónico vigente permanece **persistente sin cambios** hasta que un resultado real sea **promocionado** al kit. La nueva dirección produce piezas provisionales; la promoción al canónico es un paso separado.
- **Actualización del canónico** requiere una de dos: (a) aprobación explícita del usuario de un cambio de marca, o (b) delegación explícita ("esta variante sirve como referencia de marca para próximos encargos"). Sin delegación, el brand kit canónico permanece y la sugerencia se documenta en el registro del proyecto con su estado (sugerida, no aprobada). La aceptación del resultado final **no** equivale por sí sola a delegación para promover la excepción a norma de identidad: la entrada al kit como ejemplo aprobado es automática con la aceptación, pero la promoción a regla general necesita la autorización adicional descrita arriba.
- **Una variante de campaña no es un cambio de marca**. Una pieza para una promoción usa el brand kit; no lo redefine. Si la variante necesita un cambio real, pasa por el flujo de aprobación y produce una nueva versión del brand kit, no una edición silenciosa.
- **No guarda preferencia de proveedor** (Remotion, HyperFrames, etc.). El brand kit describe estilo; el proveedor se elige por capacidad y permiso en cada pieza.

## 6. Evolutivo: cómo se actualiza

Cuando el usuario aprueba un nuevo resultado que cambia algo del brand kit:

1. **Qué cambió**: el campo concreto (paleta, tipografía, motion, etc.) y el valor anterior y nuevo.
2. **Por qué**: la razón breve de la aprobación (resultado mejoró X, antes no existía Y).
3. **Estado**: provisional, en revisión, aprobado, sustituido.
4. **Aprobación**: quién aprobó y cuándo.
5. **Versión afectada**: el número de versión que entra y el que sale.
6. **Ejemplos nuevos**: el render o export que motivó el cambio, referenciado.

Se actualiza el canónico con esos datos. La historia queda en el registro del proyecto; el brand kit expone solo la versión vigente y un puntero a la historia (M01, M05, H05, H06).

## 7. Reutilización futura

Cuando la skill vuelve a un proyecto con brand kit:

1. Lee la **versión vigente** del brand kit, no un snapshot antiguo.
2. Pregunta solo por **deltas**: ¿algo cambió fuera de la skill? ¿se añadió o quitó un asset, una licencia, una restricción?
3. Actualiza las **dependencias y los exportes derivados** que apuntaban a la versión anterior.
4. Distingue entre **fuente maestro** (los assets originales) e **input style** (la versión del brand kit que se aplica) y **export final** (la pieza entregada). El brand kit es input style; el export final no retroalimenta al brand kit directamente sin pasar por aprobación.

## 8. Sin sobreescritura silenciosa

Si un comentario provisional o una nueva exploración sugieren un cambio, la skill:

- No reemplaza el canónico automáticamente.
- **Nueva pieza con nueva dirección autorizada**: si el usuario autoriza una nueva dirección provisional distinta a la que produjo el canónico, esa pieza es provisional; el canónico no cambia.
- **Rechazo histórico**: la historia de versiones rechazadas se documenta como **enlace opcional** al registro del proyecto; **no** es parte del brand kit canónico ni se enumera en la lista de campos activos. El brand kit expone solo la versión vigente y un puntero a la historia en el registro. El enlace a la historia rechazada **no** se trata como referencia de estilo actual: refleja decisiones anteriores del proyecto, no el estilo canónico vigente.
- Solo cuando el usuario aprueba el resultado final (con la dirección nueva), se actualiza el canónico con la nueva entrada. La **aceptación del resultado final** puede abrir dos puertas: (a) entrada automática al kit como **ejemplo aprobado** cuando el usuario la pidió como referencia para próximos encargos; (b) **promoción a norma de identidad** solo si la aprobación fue explícitamente un cambio de marca o vino con delegación para ello. La aceptación por sí sola, sin esa autorización, registra el ejemplo con su alcance pero no modifica las reglas generales de identidad.

## 9. Pendientes

- Decidir el formato concreto del brand kit por proyecto; el capítulo describe el contenido, no una plantilla fija.
- Confirmar, en cada proyecto, si la aprobación se hace por el usuario o si hay delegación explícita.
- Mantener la separación entre provisional y canónico en el registro del proyecto, no solo en este documento.
