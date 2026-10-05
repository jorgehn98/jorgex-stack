# 20 — Generación controlada y referencias

> Investigación y propuesta. 2026-10-02. Sintetiza los **3 rutas de generación controlada** investigadas como read-only, sus interfaces verificadas, sus limitaciones reportadas y los puntos de control para evitar claims de capacidad no probada. **No** ejecuta, **no** instala, **no** clona, **no** descarga pesos. Las fuentes viven en [fuentes.md](fuentes.md) (GN01–GN10).

## 1. Lo que se transfiere y lo que no

- **GN01 VACE (UserGuide.md + repo)** — `repo` pinned en [`ali-vilab/VACE`](https://github.com/ali-vilab/VACE/tree/48eb44f1c4be87cc65a98bff985a26976841e9f3); [`UserGuide.md`](https://raw.githubusercontent.com/ali-vilab/VACE/48eb44f1c4be87cc65a98bff985a26976841e9f3/UserGuide.md) raw pinned. Tareas documentadas: `firstframe`, `lastframe`, `firstlastframe`, `firstclip`, `firstlastclip`. Entrada: `prompt` + `src_video` + `src_mask` + `src_ref_images`; control de vídeo (pose/depth/flow/scribble/layout) **vs** appearance de image-ref (subject/content/style, **no** style-only). Imagen compuesta con pose documentada. Env snapshot registrado por el informe: `Python 3.10.13` + `CUDA 12.4` + `Torch ≥ 2.5.1`; **no** se afirma como mínimo universal ni fuerza instalación futura.
- **GN02 Diffusers Wan VACE pipeline (`pipeline_wan_vace.py`)** — entrada `video` + `mask` + `reference_images` + `conditioning_scale`; **no** existen parámetros separados `style_reference`/`motion_reference`.
- **GN03 Diffusers Wan — FLF2V** — pipeline `WanImageToVideoPipeline` con `image` + `last_image`; atado al checkpoint `Wan2.1-FLF2V-14B-720P-diffusers`; **no** aplica a cualquier I2V con `last_image`.
- **GN04 Diffusers Wan — Animate** — `WanAnimatePipeline` con `image` + `pose_video` + `face_video` pre-procesados (**no** RGB crudo); modo animate sobre `Wan2.2-Animate14B`; `segment_frame_length` singular en código, discrepancia con doc; frames previos (1 ó 5) como conditioning, **no** memoria persistente.
- **GN05 ATI** — `repo` pinned en [`bytedance/ATI`](https://github.com/bytedance/ATI/tree/1a002caf7bb55cfb016dcc670c357bd803af3a0d) (SHA `1a002caf7bb55cfb016dcc670c357bd803af3a0d`); [`examples/test.yaml`](https://github.com/bytedance/ATI/blob/1a002caf7bb55cfb016dcc670c357bd803af3a0d/examples/test.yaml) y [`tools/get_track_from_videos.py`](https://github.com/bytedance/ATI/blob/1a002caf7bb55cfb016dcc670c357bd803af3a0d/tools/get_track_from_videos.py). Model card [`bytedance-research/ATI`](https://huggingface.co/bytedance-research/ATI/raw/main/README.md) opcional si se citan capacidades o licencia. Checkpoint `ATI Wan2.1 I2V 14B 480P`: imagen inicial + texto + tracks (extraídos de vídeo proxy o dibujados a mano); point correspondence en frame aprobado encuadra cambios geométricos, **no** es control de cámara 3D; el estilo es ortogonal.
- **GN06 ATI paper (arXiv 2505.22944v1)** — métricas `Acc@0.05 = 55.9`, `Acc@0.01 = 34.7`, `AppearanceRate = 65.5` reportadas sobre **100 pares image/trajectory**, en el **DIAG** (fracción de frames con error de track ≤ 5% / ≤ 1%); **no** son tasa de éxito sobre todos los vídeos.
- **GN07 VideoX-Fun — predict_v2v_control_camera.py + videox_fun/data/utils.py** — `start_image` + `control_camera_txt` → `control_camera_video`; intrinsics y poses relativas → rayos Plücker en proceso; el ejemplo ramifica `camera` **o** `control_video`, **no** demuestra ambos combinados aunque la firma común lo permita.
- **GN08 Wan2.2-Fun-A14B-Control-Camera (weights README + Comfy tutorial)** — `WanCameraEmbedding` con move/speed/resolution/length; **no** importa una cámara de Blender automáticamente; la conversión desde Blender es **propuesta** y necesita verificar coordinate frames, timebase y formato de poses.
- **GN09 VACE paper (arXiv 2503.07598v1)** — C1 declara identidad y composed control **incompletos**; VBench/MOS **no** certifican geometría tipo Blender ni continuidad narrativa.
- **GN10 Diffusers — reusing seeds** — misma `seed` **no** garantiza reproducibilidad cross-platform/version; el `generator` se consume y su reuse difiere entre versiones.

Se conservan URLs concretas, SHAs de código cuando se obtuvieron y fecha de consulta. Las páginas dinámicas y papers se identifican por su URL y versión disponible. **No** se leyeron repos remotos en esta pasada; los datos se integran desde los informes READ-ONLY recibidos. Lo verificado por lectura se distingue de lo declarado por metadatos (ver [fuentes.md](fuentes.md)).

## 2. Limitaciones reportadas que se preservan

- **VACE paper (GN09, arXiv 2503.07598v1)** — C1 declara identidad y composed control **incompletos**; VBench/MOS **no** certifican geometría tipo Blender ni continuidad narrativa.
- **ATI** — limitaciones de investigación: movimientos rápidos → desintegración; cámara que evade el tracking → pérdida; pan/zoom 2D plano **no** equivale a geometría 3D.
- **VideoX-Fun-Camera** — la conversión desde Blender es propuesta, no probada; coordinate frames y timebase por verificar.
- **Diffusers reusing seeds (GN10)** — misma `seed` **no** garantiza reproducibilidad cross-platform/version; el `generator` se consume y su reuse difiere; registrar **sólo** cuando el caso exige reproducibilidad (versión de checkpoint, inputs, outputs, env), **no** como framework universal.
- **VACE env snapshot** — `Python 3.10.13` + `CUDA 12.4` + `Torch ≥ 2.5.1`; **no** fuerza instalación, **no** declara mínimo universal.
- **Wan2.2-Fun-Camera metadata** — 3 checkpoints principales listados como públicos, **no** gated; **no** blanket "Apache 2" sobre todo el contrato ni garantía de assets; ejemplo de 24 GB VRAM **no** es mínimo universal; CPU offload **no** es CPU-only.

## 3. Las 3 rutas compatibles (propuesta)

Las tres rutas son **propuestas**; la elección depende del caso y del permiso del usuario.

### 3.1 Ruta A — VACE (peso, control + referencia)

- **Entrada**: para esta combinación: prompt, vídeo de control preparado e imágenes de referencia; máscara si la tarea la requiere. Traducir a los campos de la interfaz elegida (GN01, GN02). **No** se asume que toda tarea requiera todos los inputs.
- **Función**: appearance desde image-ref; control de vídeo con pose/depth/flow/scribble/layout.
- **Cuándo encaja**: cuando hay un vídeo proxy con estructura y se quiere appearance nuevo con control.
- **Punto de control**: condicionar **no** es copiar geometría/píxeles; la continuidad queda **desconocida**; las referencias se repiten a partir de originales aprobados para evitar drift de last-frame indefinido.

### 3.2 Ruta B — ATI (peso, tracks)

- **Entrada**: imagen inicial + texto + tracks (extraídos de vídeo proxy o dibujados a mano).
- **Función**: appearance + movimiento por correspondencia de puntos.
- **Cuándo encaja**: motion simple, **no** control de cámara 3D; tracks nuevos por frame aprobado para encuadrar cambios geométricos.
- **Punto de control**: desintegración con movimientos rápidos; evasión de cámara del tracking; pan/zoom 2D **no** es 3D.

### 3.3 Ruta C — Wan2.2-Fun-Camera (peso, cámara numérica)

- **Entrada**: `start_image` + `control_camera_txt` (intrinsecs + poses relativas).
- **Función**: appearance + cámara con `move`/`speed`/`resolution`/`length`; rayos Plücker derivados.
- **Cuándo encaja**: cuando se necesita control de cámara explícito y la conversión desde Blender se ha verificado para el caso.
- **Punto de control**: ejemplo ramifica `camera` **o** `control_video`; conversión desde Blender por verificar; coordinate frames y timebase por confirmar.

## 4. Imagen y movimiento: condición vs input

- **`image`** como condición **≠** **`image`** como input de motion. El primer-frame y el last-frame **no** garantizan identidad de historia.
- **Verificación por checkpoint** (no por nombre de modelo): cada pipeline expone un punto de control concreto (`conditioning_scale`, `pose_video` pre-procesada, `face_video` pre-procesada, `control_camera_txt`); **no** se asume que un nombre de modelo implique todos los controles.
- **Conditioning vs memoria persistente**: las tareas `firstclip` y `firstlastclip` documentadas por VACE (GN01) existen con semántica propia; la regla de subsample/truncate a ≈ 5 s preserva el contexto de la fuente, **no** es duración universal para todos los modelos ni para todo `clip`; `firstclip` en cadena **no** es identidad multiángulo.

## 5. UI, logos, etiquetas, medidas de producto

- **No** se generan a partir de imagen estática o motion model salvo permiso explícito del usuario; aunque el modelo lo soporte, la legibilidad exige **QA real** posterior.
- **Web/statics con misma composición** → pasar por appearance → generación → revisión, **no** ir directo a 3D + vídeo obligatorio.

## 6. Reproducibilidad y entorno

- **Semilla**: registrar sólo cuando la finalidad exige reproducibilidad; **no** como marco universal cross-platform/version.
- **Versión de checkpoint + inputs + outputs + env**: se documentan **cuando** el caso los necesita, no por defecto.
- **VRAM/ejecución**: el ejemplo de 24 GB **no** es mínimo universal; CPU offload **no** es CPU-only.

## 7. Lo que el capítulo no promete

- **No** afirma `image→3D Blender geometry → vídeo` libre; las 3 rutas investigadas cubren appearance + control limitado.
- **No** afirma identidad de personaje entre clips; la continuidad es desconocida.
- **No** afirma lipsync, audio world model ni calidad de audio; la verificación de audio es trabajo de [12](12-transcripcion-precision-y-silencios.md) y [16](16-acabado-audiovisual-y-entrega-editable.md), **no** de este capítulo.
- **No** introduce SKILL.md ni modificaciones a la skill existente.

## 8. Conexión con los demás capítulos

- [01-video-metodos-y-pipelines.md](01-video-metodos-y-pipelines.md) — los 5 pipelines canónicos se anclan a estas 3 rutas, **no** al revés.
- [02-video-herramientas-y-evidencia.md](02-video-herramientas-y-evidencia.md) — la disponibilidad real de cada peso se documenta por checkpoint, **no** por nombre de modelo.
- [12-transcripcion-precision-y-silencios.md](12-transcripcion-precision-y-silencios.md) y [16](16-acabado-audiovisual-y-entrega-editable.md) — audio y subtítulos tienen su propio método; este capítulo **no** los duplica.
- [07-validacion-y-decisiones-pendientes.md](07-validacion-y-decisiones-pendientes.md) — el caso "imagen como condición ≠ motion input" verifica este capítulo.
