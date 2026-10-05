# 01 — Métodos y pipelines de vídeo

> Investigación y propuesta. 2026-10-02. Cubre cómo se decide el método, qué pipelines canónicos existen y qué se sabe sobre su determinismo. No incluye instalación, generación ni prueba en esta fase. Fuentes en [fuentes.md](fuentes.md) (V01–V15).

## 1. Principio rector: control explícito vs condicionamiento generativo

La selección del método responde a dos ejes ortogonales: **qué se controla** (cámara, motion, audio, geometría) y **quién lo decide** (humano y código vs modelo entrenado). No son excluyentes: dentro de un mismo plano pueden combinarse. La elección depende del riesgo del plano y de la economía de reintentos, no del catálogo de herramientas.

- **Control explícito** (3D, código, motion graphics): el resultado se puede describir y revisar antes de gastar; reproducible si los inputs y la versión del motor están fijos.
- **Condicionamiento generativo** (I2V, V2V, edición por instrucciones): la salida es una muestra condicionada; el control se ejerce por señales (depth, pose, canny, primer/último frame, identidad por referencia).
- **Material existente** (rodaje, archivo, captura): el control es total si los permisos lo permiten; suele ser el camino más barato por frame si el material está disponible.

## 2. Taxonomía de métodos combinables

Métodos que se pueden mezclar en un mismo plano o entre planos. La combinación se justifica por la unidad representativa, no por estética.

- **Previz y blocking 3D** (Blender u otra herramienta 3D): cámara, duración, geometría básica. Aporta el plano antes de gastar.
- **Lookdev y primer/último frame**: define luz, atmósfera y anclajes temporales del plano.
- **Image-to-video (I2V)**: una imagen inicial aprobada sirve de anclaje; el modelo rellena movimiento.
- **Video-to-video (V2V) y edición**: transformación parcial de un clip ya existente (estilo, máscara, recolor, outpaint, inpaint).
- **Identidad y actuación**: voz separada, referencias de cara/personaje cuando el modelo y los términos lo permiten.
- **Señales estructurales** (pose, depth, canny): condicionan movimiento manteniendo pose o estructura.
- **Motion por código**: timelines, partículas, simulaciones. Aporta determinismo y reproducibilidad exactos.
- **Edición y compositing**: capa de código sobre el material generado (FFmpeg, nodos, NLE).
- **Audio**: voz (TTS, captura, banco), música (composición, banco, generación), SFX (captura, banco, generación). El audio manda sobre cortes, duraciones y lipsync.

## 3. Pipelines canónicos

Esquemas. Cada uno se justifica con el brief y la unidad representativa, no por defecto.

### A. Generativo con control 3D

```text
Brief y dirección
   ↓
Blender: cámaras, blocking, previz
   ↓
Aprobación: cámaras + primer frame realista
   ↓
Generación:
  ├─ Aleph Edit Studio: vídeo + imagen editada, o
  └─ LTX Union Control: depth/pose/canny + imagen inicial
   ↓
Selección por unidad representativa
   ↓
Remotion o HyperFrames: títulos y datos exactos
   ↓
Audio aprobado
   ↓
Acabado y master
```

- Veo3.1 acepta primeras/últimas imágenes y referencias propias; **no** transferir arbitrariamente el proxy de Blender ni usar la extensión con clips que no sean Veo (V11).
- LTX Union Control con IC-LoRA heredado 2.3 opera con depth/canny/pose; depende de ComfyUI con GPU, nodos y pesos; la licencia comunitaria puede condicionarse a facturación (V12, V13).
- Aleph Edit Studio está documentado para single edit de imagen seleccionada → metraje; multi-edit/expand aparece marcado como próximo en la UI documentada; no asumir paridad de API (V09, V10).

### B. Motion graphics con insertos IA

```text
Guion → voz en off aprobada
   ↓
Motion Canvas o Remotion (motion graphics, datos, títulos)
   ↓
Insertos IA donde aporten (concepto, atajo visual, comparativa)
   ↓
Composición y master
```

Útil cuando la mayoría de la pieza es explicativa y los insertos son puntuales.

### C. Material existente con control de edición

```text
Footage autorizado
   ↓
Keyframe editado (recorte, reencuadre, color)
   ↓
Aleph (edición) o control por capa
   ↓
Postproducción
```

Aplica cuando el material base ya cumple la dirección y se busca economía.

### D. Web como medio de vídeo

```text
HTML/React/JS/SVG/Canvas/WebGL seekable
   ↓
Escenas reproducibles por URL o tiempo
   ↓
Variantes por estado o dato
   ↓
Render local o headless
   ↓
Ensamblaje con FFmpeg
```

Encaja cuando la pieza es interactiva en origen (demo, simulador, gráfico dinámico) y la versión vídeo es un derivado.

### E. Referencias compartidas entre planos

```text
Referencias visuales y de motion aprobadas
   ↓
Keyframes por plano
   ↓
Generación por plano
   ↓
Selección
   ↓
Audio y motion graphics comunes
```

Reduce deriva entre planos manteniendo economía por unidad.

## 4. Prototipo representativo antes del lote

Ninguna pipeline se aplica a toda la pieza sin un **prototipo representativo** que demuestre la dificultad central. Si el prototipo falla, se cambia el método o las restricciones, no se regenera todo con otro texto. Regenerar por cambio de prompt no diagnostica por sí solo.

## 5. Notas críticas sobre determinismo y reproducibilidad

- **Veo3.1**: el seed no garantiza determinismo entre runs. La extensión se aplica sobre vídeos Veo, no sobre material arbitrario (V11).
- **Remotion**: la animación es función del frame; misma versión de `@remotion/*` y mismas dependencias producen el mismo render si no se introduce aleatoriedad no fijada (V03, V04).
- **HyperFrames**: documentación indica seek-safe y composición determinista sobre assets fijados; **no se documenta igualdad binaria garantizada** entre workers; una pipeline reproducible exige fijar assets y comandos (V05, V06).
- **FFmpeg**: concat, amix, loudnorm y filtros similares son infraestructura; no son motor creativo (V14).
- **Lipsync**: la medida por cross-correlación o equivalente es preferible a la inspección visual; si el modelo diverge, se corta o se regenera, no se pinta a mano.

Los assets aprobados, una vez fijados, dan un **montaje reproducible**; no garantizan una **generación idéntica** si se vuelve a llamar al modelo generativo.

## 6. Lo que este capítulo evita

- No recomienda Veo, Aleph, LTX, Remotion o HyperFrames por defecto. Cada uno entra cuando el caso lo pide.
- No asume que una herramienta ofrezca un control que su documentación vigente no respalda.
- No mezcla audio y vídeo en una sola decisión; el audio manda sobre el corte.
- No promete paridad de API entre single edit y multi-edit cuando la documentación UI marca multi-edit/expand como próximo.

## 7. Pendientes

- Confirmar capacidades vigentes (audio input, multi-image conditioning, durations) en el momento de elegir proveedor, no en abstracto.
- Verificar el entorno de ejecución para LTX Union Control (GPU, ComfyUI, pesos, licencia) antes de planificar.
- Documentar el prototipo representativo aprobado como referencia para la producción por lote.
