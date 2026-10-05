# 16 — Acabado audiovisual y entrega editable

> Investigación y propuesta. 2026-10-02. Cubre el **acabado audiovisual** (continuidad, J/L cuts, edición frente a cambio de tiempo, mezcla, loudness) y la **entrega editable** (qué se entrega, qué no, dependencias de aprobación desde [15](15-marca-portable-y-grafica-fija.md)). No ejecuta; documenta capacidades estimadas. La cobertura del tema está en [18](18-cobertura-del-encargo.md). Fuentes en [fuentes.md](fuentes.md) (FN01–FN05, AS06, AS05, RT03, ED07, LP01, LP02).

## 1. Por qué el cambio temporal no es trivial

Un cambio de **duración total** o de **orden de pistas** (incluso manteniendo duración total) puede afectar:

- **Cues y subtítulos** (sus tiempos y su orden de aparición).
- **Cortes y transiciones** (la frontera entre planos cambia).
- **Música y SFX** (sus hits y su relación con la imagen).
- **Aprobación de marca** si la pieza lleva VO o sonic brand (ver [15 §7](15-marca-portable-y-grafica-fija.md)): el VO aprobado se bloquea con el tiempo real. Un **cambio temporal** (duración total u orden de pistas) **reabre la revisión de los cues y resultados afectados**, dentro del alcance y la autonomía acordados. **Solo si el cambio también altera una regla de identidad** (nuevo claim, nuevo motivo, nueva paleta de marca) se revisa esa regla; un cambio de tiempo **no** implica reaprobación automática de toda la marca.

Por eso **ganancia de nivel** (audio gain) **no** es ajuste de tiempo: ajustar el nivel no restaura el timing original. Si se recorta una frase a la misma duración total que el master, los cues afectados quedan pendientes; el cambio de tiempo no es gratis.

## 2. Edición y orden narrativo

- **Narration-led** (la voz guía la pieza): los cortes respetan las pausas narrativas (respiración, énfasis). El VO aprobado define la **duración** y los **cues**; el resto se ajusta a esa rejilla.
- **Image-led / ficción** (la imagen guía la pieza): el orden narrativo puede preceder a una VO nueva. El VO se graba o clona después, **no** primero.

**J/L cuts**: imagen y voz cruzan el corte en momentos distintos; **no** siempre van juntos, y **no** siempre se ripplean. La regla es **intención por toma**: si la imagen y la voz cuentan cosas distintas en el corte, no se mueven juntas; si cuentan lo mismo, se mueven. La skill documenta cada J/L por toma, no asume un comportamiento global.

## 3. Mezcla y loudness

- **EBU R128 v5.0 (2023)**: define la medición de loudness. **No** es regla universal de LUFS para todo destino (broadcast, web, sala, cine tienen specs distintas). La **ficha técnica** del doc se cita como referencia, no se hace auditoría completa del PDF.
- **`loudnorm` de FFmpeg (FN03)**: aplica EBU R128 a una pista o mezcla. **No** garantiza inteligibilidad ni estética: pasa el loudness, no el oído.
- **Sidechain / ducking**: la cadena `loudnorm` → `sidechaincompress` o su equivalente en NLE protege la inteligibilidad de la voz respecto a la música; los parámetros (attack, release) **protegen frases y respiraciones** y **evitan pumping** en silencios dramáticos. Los defaults **no** son universales; se ajustan por mezcla.
- **`amix` de FFmpeg (FN03)**: normalización implícita al mezclar (duración, pesos). El **balance final** es la mezcla editada, no un re-encode automático; el loudness **post-mezcla** se mide sobre el master, no sobre las pistas individuales.

## 4. Entrega editable: qué se entrega, qué no

**Lo que se entrega cuando el usuario pide editable**:

- **Proyecto nativo** del editor (NLE): `.prproj`, `.drp`, `.kdenlive`, `.mlt` con el árbol de assets linkeados, no embebidos. El archivo solo **no** es suficiente: la versión del editor y la ruta de los assets importan. **OTIO** (ver [§4.1](16-acabado-audiovisual-y-entrega-editable.md) abajo) es un formato de **intercambio** JSON, **no** un proyecto nativo universal: describe la estructura editorial pero depende del adapter de cada NLE; el roundtrip con el proyecto nativo del editor (Premiere/Resolve/Final Cut/DaVinci Resolve/Shotcut/Kdenlive) **no** está garantizado y debe probarse en el adapter real.
- **Versión del editor** y **fecha de exportación** del proyecto.
- **Media y recursos** (videos, audio, fuentes, imágenes, motion) en una ruta coherente con la que el editor espera; si los assets son externos (banco, generación, archivo del cliente), **no** se incluyen por defecto: se documenta la fuente y la licencia.
- **Export final** en el formato del destino (`.mp4`, `.mov`, `.webm`, `.gif`, `.png`, `.jpg`, `.svg`, `.pdf`, `.wav` según el caso), con perfil de color y profundidad de bit declarados.
- **Subtítulos** quemados o como sidecar (`.srt`/`.vtt`), con su lista de voces o su speaker ID si los tiene.
- **Stems** si se pidieron: audio separado (voz, música, SFX, ambiente) en su propia pista, con su duración coherente con el master.

**Lo que NO se entrega como editable completo**:

- Un `.otio` **no** es un proyecto editable completo: es un **formato de intercambio JSON** que describe la estructura editorial pero depende del adapter de cada NLE (Premiere, Resolve, Final Cut, DaVinci Resolve, Shotcut, Kdenlive); el roundtrip con el proyecto nativo del editor **no** está garantizado y debe probarse en el adapter real (FN01).
- Un `.mp4` **no** es editable: es un export final.
- Un screenshot **no** prueba calidad: un frame seleccionado no representa la pieza completa.

**Sobre la marca** (vinculación con [15](15-marca-portable-y-grafica-fija.md)): si la entrega lleva VO o música aprobada, el master version de la aprobación **debe** referenciarse. Un **cambio temporal** (duración total u orden de pistas) **reabre la revisión de los cues y resultados afectados**, dentro del alcance y la autonomía acordados. **Solo si el cambio también altera una regla de identidad** (nuevo claim, nuevo motivo, nueva paleta de marca) se revisa esa regla; un cambio de tiempo **no** implica reaprobación automática de toda la marca.

### 4.1 OTIO como intercambio, no como proyecto nativo

OTIO (`.otio`) es un **formato de intercambio JSON** que describe la estructura editorial —clips, tracks, transiciones, marcadores— pero **no** equivale al proyecto nativo del editor. Su fidelidad depende del adapter de cada NLE. El paquete entregable **no** debe confundir el `.otio` exportado con el proyecto editable real: el `.otio` sirve para **intercambio y auditoría**, mientras que el proyecto editable del usuario vive en su editor nativo (Shotcut MLT, Kdenlive XML, Premiere `.prproj`, DaVinci Resolve `.drp`, Final Cut FCPXML) con la versión del editor y la ruta de los assets documentadas. Un `.mp4` **no** es editable: es el export final. La regla práctica: si el destinatario necesita editar, recibe el **proyecto nativo + media + versión del editor**; el `.otio` se añade cuando aporta valor de intercambio o auditoría, no como sustituto.

## 5. Subtítulos y accesibilidad (FN05 BBC subs + WCAG)

- **Subtítulos de accesibilidad**: la edición sigue las **whole phrases** reales del habla, no resúmenes; el corte del subtítulo **no** cae dentro de una frase; el agrupamiento refleja la **reading plane** del espectador. La sincronía se verifica contra el audio escuchado, no contra el corte visual.
- **SRT/VTT** cuando el destino lo requiera: el archivo se genera desde el transcript final aprobado, **no** desde el transcript de draft.
- **No esenciales**: los **subtítulos y captions de accesibilidad** representan habla y, cuando corresponde, información sonora relevante; **no** se convierten automáticamente en decoración porque la imagen sea comprensible. Los rótulos promocionales son otra capa separada. La presencia o no de captions se decide por el **brief, el objetivo de accesibilidad y el destino** de la pieza, no por una cuota. La guía BBC (FN05) y WCAG sirven como **contexto**, no como política universal: cada caso decide su nivel de caption en función de su objetivo y su audiencia. La distinción entre captions de accesibilidad y rótulos promocionales se documenta en el visual decision record.
- **Safe areas** y colisiones con UI/captions: el layout final se prueba en los dispositivos destino, **no** solo en un viewport de referencia. El frame perfecto en el editor **no** garantiza que el subtítulo no se solape con un botón o con un overlay.

## 6. Continuity, transiciones y color

- **Continuidad** (acción, mirada, movimiento, ambiente, exposición, color): la pieza se revisa con la lista de continuity **antes** del conform final. Errores de continuity **no** se arreglan con cortes adicionales sin revisar la toma; un error de exposición se corrige en color, no con un fade.
- **Transiciones**: la skill documenta la transición y su intención; **no** asume "disolver" como default. Un corte directo entre dos planos con mirada continua **no** se convierte en cross-dissolve por defecto.
- **B-roll** y decoraciones: **no** se añaden hechos falsos (un letrero que no estaba, una ciudad que no era). El b-roll documenta o ambienta; **no** inventa.

## 7. Flujo convencional y su adaptación

Flujo de referencia (no obligatorio en cada caso):

```text
brief y destino
  ↓
NLE rough cut (o agente + NLE híbrido)
  ↓
aprobación de timing y continuidad
  ↓
mezcla editable
  ↓
subtítulos y gráficos finales
  ↓
conform export
  ↓
revisión humana con audio escuchado
  ↓
paquete entregable con master + editable
```

**Híbrido agente + herramientas**: el agente hace cortes, cues, y subtítulos; **FFmpeg** (FN03) procesa mezcla, loudness, export; **NLE** se usa cuando aporta valor (continuidad visual, transiciones manuales, color); **OTIO** (FN01) se usa cuando aporta valor (intercambio, estructura recurrente, auditoría). **No** se impone el stack completo.

## 8. QA antes de entrega

La QA **escucha** el master (no describe lo que debería sonar) y **mide** la mezcla editada (loudness range, true peak). Se revisa:

- **Habla débil** (volumen bajo, ruido, sibilancia) sobre mezcla densa.
- **Pausas dramáticas** (no se eliminan) y **SFX** (no se enmascaran).
- **J/L transitions**: la imagen y la voz cruzan correctamente.
- **Subtítulos y b-roll**: timing, colisión con UI, intención del b-roll.
- **Mono / dispositivo**: ¿se escucha igual en mono? ¿en el dispositivo destino?
- **Loudness range y true peak** sobre la mezcla completa (no sobre las pistas individuales).
- **Editabilidad real**: ¿puede el destinatario abrir el proyecto, relinkar los assets, y editar un clip? ¿Está documentada la versión del editor?

## 9. Paquete entregable (resumen)

Cuando el usuario pide editable, el paquete incluye:

- **Proyecto nativo** + versión del editor.
- **Media y recursos** (con su origen y licencia).
- **Export final** + perfiles declarados.
- **Subtítulos** quemados o sidecar.
- **Stems** si se pidieron.
- **Apuntes** sobre continuidad, color, transiciones, y cambios pendientes de aprobación.
- **Master version** referenciada (si hay aprobación de marca previa, se cita; si la aprobación es para esta versión, se documenta).

**Real evidence pendiente**: el paquete **no** se ha probado con un caso real en esta fase; los defaults de la pipeline (`.prproj` con assets linkeados, `.mp4` con perfil HD Rec 709, SRT whole phrase) son **ilustrativos** de la práctica del sector, no son afirmaciones sobre la salida de esta pasada.

## 10. Lo que este capítulo evita

- **No** afirma roundtrip perfecto entre formatos; cada adapter tiene su propio subconjunto.
- **No** mide loudness con un destino concreto; el master se mide con la herramienta que el usuario indique, no con un destino asumido.
- **No** impone un NLE; el flujo es **referencia**, no receta.
- **No** mezcla evidencia con propuesta: los apartados que son **Propuesta** se marcan; las capacidades **estimadas** se declaran como tales.
- **No** copia código fuente de los repos externos; solo se resumen y se enlaza al permalink. LP01 y LP02 declaran el estado de la licencia.

## 11. Pendientes

- Confirmar, en cada proyecto, el **formato de entrega** y el **nivel de editabilidad** (master version, editable, stems, subtítulos sidecar).
- Decidir, en cada proyecto, la **estrategia de loudness** según el destino (broadcast, web, sala, cine).
- **No** introducir un stack de acabado obligatorio; el agente usa las herramientas que el usuario ya tiene, con permiso.
- **Real evidence pendiente**: el flujo y los defaults de §7–§9 son **ilustrativos**; no se han probado con un caso real.
