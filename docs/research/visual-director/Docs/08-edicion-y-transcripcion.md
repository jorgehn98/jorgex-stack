# 08 — Edición y transcripción de grabaciones del usuario

> Investigación y propuesta. 2026-10-02. Cubre el flujo cuando el usuario graba contenido (YouTube, Instagram u otro) y la skill actúa como editor: cortes, silencios, repeticiones, subtítulos, animación, b-roll y audio. No ejecuta; documenta el patrón. Los **detalles de herramientas** (ASR, editores, runtime) viven en [12](12-transcripcion-precision-y-silencios.md), [13](13-edicion-multimodal-y-flujos-reales.md) y [14](14-remotion-hyperframes-transcripcion-y-limites.md). Este capítulo es la **vista de pipeline**; 12/13/14 son los capítulos de detalle. Fuentes en [fuentes.md](fuentes.md) (M03, M04, M05, R03, R04, R05, H02, H05, H06, E02, E04, AS01–AS07, ED01–ED07, RT01–RT09).

## 1. Alcance

Este capítulo aplica a **grabaciones del propio usuario** (voz, cara, pantalla, b-roll grabado por el usuario). No es la ruta de producción audiovisual de Clodyssey ni un motion design largo; es el caso "tengo una grabación, quiero una versión editada". La skill pregunta primero el grado de intervención; nunca asume cuánto quiere editar el usuario.

## 2. Preguntas iniciales antes de tocar la grabación

Antes de invocar cualquier herramienta, la skill aclara con el usuario:

- **Grado de montaje**: solo subtítulos; cortes de silencios y tropiezos; reordenación; rate change. Cada nivel incluye el anterior o se declara explícitamente.
- **Subtítulos**: sí/no; formato (quemado en el vídeo, SRT, VTT o todos); idioma; estilo (case, posición, color).
- **Animación y b-roll**: ¿se añaden elementos gráficos, overlays, insertos? ¿De dónde sale el b-roll (propio, banco, generación)?
- **Audio**: ¿se reemplaza la pista? ¿se añade música? ¿hay silencios que respetar para respiración narrativa (E02)?
- **Privacidad y consentimiento**: ¿la grabación se queda local o se sube a un servicio? Si hay voz clonada o de terceros, ¿hay autorización y licencia explícitas?
- **Salida final**: plataforma destino, duración objetivo, resolución y mobile safe areas. **VFR vs CFR** y `tail` (cola no-speech) se documentan en el inventario de reloj (ver 12 §4 paso 1 y 13 §5).

Cada respuesta reduce el espacio de trabajo. (Propuesta: la skill no re-pregunta lo que el usuario ya aportó al brief; M05 describe una estructura de briefing análoga.)

## 3. Pipeline funcional (overview)

```text
intake (consentimiento, privacidad, grado, salida, inventario reloj)
   ↓
ASR (motor declarado, ver 12)
   ↓
revisión humana del transcript (nombres, negaciones, cifras)
   ↓
forced alignment del transcript revisado al audio (si la corrección es grande)
   ↓
edición: cortes, reorden, rate (contrato ED07, ver 13)
   ↓
revisión de captions (grouping, legibilidad, timing, sin speaker field estándar)
   ↓
silencedetect / VAD independiente (ver 12 §3 y 14 RT06/RT07)
   ↓
QA reproducción completa con audio y subs
```

Los detalles de cada bloque viven en los capítulos referenciados:

- **ASR y transcript (§3.1, §3.2)**: capacidades declaradas, probabilidades, alineación forzada, gate de 80 ms, y la diferencia entre hueco de transcript y silencio acústico → [12](12-transcripcion-precision-y-silencios.md) §2–§3.
- **Cortes, reorden y rate (§3.3)**: contrato con `t_final = t_dest + (t_source - source_in) / rate`, ripple, drift A/V → [13](13-edicion-multimodal-y-flujos-reales.md) §5.
- **Captions (§3.4)**: contrato Remotion `install-whisper-cpp` y `whisper-web` (WASM/CPU) → [14](14-remotion-hyperframes-transcripcion-y-limites.md) §2–§3.

### 3.5 Repeticiones (decisión editorial, no detector)

La eliminación de repeticiones **no** es un detector léxico (H05, AS03 stable-ts). Una palabra repetida puede ser intencional (énfasis, muletilla funcional, construcción narrativa) o no. La decisión es editorial:

- Revisar el **significado y el contexto**: ¿la repetición añade énfasis o es ruido?
- Si es ruido, marcar el rango y dejar que el editor humano decida el corte, no automatizar.
- Si la repetición se extiende en varios segundos, considerar re-transcribir el segmento tras el corte.

## 4. Audio: lo que el transcript no cuenta

El transcript tiene **huecos donde no hay habla**, pero los huecos no equivalen a silencio acústico (AS06 ffmpeg `silencedetect`, H05, H06, E02). El audio real incluye respiración audible, ruido ambiente, colas de reverberación, música o SFX que pueden no estar en el transcript. La **duración final del audio editado incluye esas colas**; los captions y el timeline deben respetarlas. La skill documenta la duración real al cerrar la edición, **no** la duración del transcript. El **VAD puede llamar "no-speech" a música, SFX o respiración**, así que un gap de transcript es solo **indicio**, no verdad. Detalle: [12](12-transcripcion-precision-y-silencios.md) §3.

## 5. QA antes de entregar

Antes de declarar el vídeo editado listo, la skill reproduce y verifica:

- Reproducción completa sin cortes de audio ni de vídeo; **drift A/V** al inicio, mitad y final.
- Audio y subtítulos sincronizados en la versión final; `tail` no-speech no contado como palabra alineable.
- Cortes coherentes con la decisión editorial; **inventario reloj** (duración, offset, canales, rotación, CFR/VFR) registrado.
- Mobile safe areas: subtítulos y overlays no quedan cortados en pantallas pequeñas.
- Privacidad: la grabación no termina en un servicio no autorizado.

Si no se puede reproducir la versión editada (entorno sin render, sin player), se registra como **pendiente**, no como aprobado. (M03 describe la disciplina de analizar referencia real — útil como base conceptual; la regla "no aprobado sin reproducción" es nuestra, no de M.)

## 6. Combinable con otros métodos

La edición de grabación es **combinable** con la pipeline principal de la skill (generation, motion, 3D, Remotion, HyperFrames) **sin que sea obligatorio un backend específico**. Por ejemplo, después de editar la grabación se puede:

- Insertar un overlay de motion graphics en Remotion o HyperFrames (R02, R03, H02).
- Reemplazar el fondo con una escena 3D.
- Añadir un b-roll generado o de banco, con autorización.

La combinación se justifica por el brief, no por defecto.

## 7. Privacidad y permisos

- **Grabaciones personales**: si el usuario sube su propia grabación a un servicio, debe autorizarlo; la skill no sube nada por su cuenta.
- **Voz de terceros**: clonada o de otro hablante, requiere consentimiento y licencia comercial explícita.
- **STT local vs remoto**: la decisión se toma por **capacidad y permiso** del usuario, no por preferencia de proveedor. STT local (RT02 `@remotion/whisper-web` WASM/CPU; AS01 faster-whisper CPU int8; AS04 Parakeet CPU) evita subir el audio. STT remoto envía el audio fuera del entorno local, lo que exige revisar permisos del proveedor, tratamiento de datos y cláusulas del servicio; **la responsabilidad sobre el contenido y sobre el cumplimiento de permisos sigue siendo del usuario, no se transfiere al proveedor**. La skill no asume un proveedor concreto. Detalle de motores: [12](12-transcripcion-precision-y-silencios.md) §2; de runtime: [14](14-remotion-hyperframes-transcripcion-y-limites.md).
- **Datos personales en el transcript**: el transcript puede contener nombres, ubicaciones, datos sensibles. La skill los trata como el resto de la información personal: no se exponen en la síntesis, no se publican, no se suben.

## 8. Muestra antes de producción masiva

La skill puede preparar una **cutlist** o una **muestra corta** (por ejemplo, los primeros 30 segundos editados) antes de procesar la grabación completa. Esto reduce riesgo: si el estilo o el criterio de corte no convence, se ajusta sobre un tramo corto, no sobre el vídeo entero. La muestra se entrega con sus captions, su duración y la decisión de cada corte documentada (H05). El cutlist del runtime HF (RT07) **devuelve segments, no remapa captions**; el mapping de subtítulos se actualiza aplicando un **mapa temporal** sobre los segmentos retenidos (ver [14](14-remotion-hyperframes-transcripcion-y-limites.md) §7). La re-transcripción o re-alineación son **opcionales**: se aplican cuando aportan valor, cuando hay incertidumbre, o cuando el usuario pide verificar — no son obligatorias en cada edición.

## 9. Pendientes

- Confirmar, en cada encargo, el grado de intervención deseado y los permisos de subida y STT antes de tocar el archivo.
- Documentar, en el registro del proyecto, los criterios de corte y reorden usados, no solo el resultado, **incluyendo motor ASR, versión, timebase y tail**.
- Decidir si la futura skill operativa lleva un script genérico de preflight para esta pipeline; el usuario prefiere referencias breves, no un nuevo tooling (ver [11](11-skills-externas-aportes-y-limites.md) §4).
- Medir con una muestra en español autorizada: ASR chosen + alineación + cutlist + export; no se ejecuta aquí.
