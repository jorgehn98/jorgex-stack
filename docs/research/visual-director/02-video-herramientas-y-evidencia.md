# 02 — Herramientas de vídeo y evidencia

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó. Fuentes: [fuentes.md](fuentes.md) (V01–V15, T01–T04).

## 1. Nueve características representativas, no una lista cerrada

Estas herramientas aparecen en los pipelines del capítulo 01. No son obligatorias; son las que la evidencia permite caracterizar con sus límites. Cualquier otra herramienta se evalúa con el mismo patrón: función, disponibilidad, restricciones, licencia, evidencia.

El «vídeo» no es un medio único: motion graphics, explainer, narrativo, demo, lyric video y motion design de producto son ramas con criterios diferentes.

### 1.1 Blender (previz, cámara, pases)

- **Función**: previz, planteamiento de cámara, blocking; pases de profundidad, normales y motion vector para condicionar generación o para composición.
- **Disponibilidad**: instalable en Windows, macOS y Linux. Documentación oficial (V01, V02).
- **Restricciones**: no todos los modelos 3D aceptan todos los pases; la exportación a proxies depende del viewport (Workbench, EEVEE) y del motor de render.
- **Licencia**: GPL; comprobable en la documentación oficial.
- **Evidencia**: oficial de Blender Foundation.
- **No implica**: que Blender produzca el render final; la previz contamina el aspecto si se usa como clip final sin tratar.

### 1.2 Remotion (vídeo programático React)

- **Función**: orquestación de vídeo programático en React; cada frame es una función del tiempo.
- **Disponibilidad**: paquete npm `@remotion/cli` y `remotion`; scaffolding `npx create-video@latest` para proyecto nuevo; para app existente, `npm install remotion @remotion/cli` con PM y versiones compatibles (T01, T02).
- **Restricciones**: la licencia principal del repositorio es la del proyecto (V04); el paquete puede tener términos distintos; las versiones y términos de v5 figuran marcados como upcoming en la documentación leída.
- **Licencia**: comprobar por paquete en el momento; la fuente raw leída (V03) describe el troubleshooting de animaciones CSS.
- **Evidencia**: documentación oficial Remotion y repositorio raw.
- **No implica**: que un proyecto existente acepte `npx create-video@latest` como add; ese comando scaffoldea un proyecto nuevo, no añade dependencias a una app.

### 1.3 HyperFrames (vídeo HTML+JS seekable)

- **Función**: producción de vídeo a partir de HTML, JS y assets; composición determinista con adaptadores documentados.
- **Disponibilidad**: CLI npm; instalación global opcional `npm install -g hyperframes` con permiso explícito del usuario; requiere Node ≥ 22 y FFmpeg; `npx` puede descargar y ejecutar el binario (T03).
- **Restricciones**: no es un wrapper de cualquier web real-time; es una pipeline de composición con adaptadores específicos.
- **Licencia**: la documentación del repositorio (V06) declara Apache 2.0 para los adaptadores; comprobar el resto de componentes.
- **Evidencia**: documentación oficial Heygen (V05) y repositorio (V06).
- **No implica**: que el scaffold `init` sea inocuo; actualiza skills globales además de scaffold; existe flag documentado `HYPERFRAMES_SKIP_SKILLS=1` para CI/tests (T04).
- **No garantiza**: igualdad binaria entre renders; seek-safe no equivale a bit-idéntico.

### 1.4 Motion Canvas (motion graphics en TypeScript)

- **Función**: animaciones técnicas mediante generadores TS; orientada a motion graphics precisos, voice-over y datos.
- **Disponibilidad**: instalable vía npm; documentación oficial (V07, V08).
- **Licencia**: MIT según documentación; comprobar versión y paquete.
- **Evidencia**: documentación oficial Motion Canvas.
- **No es**: un editor NLE universal; no sustituye a una suite de edición cuando se requiere edición de vídeo tradicional.

### 1.5 Runway Edit Studio — Aleph 2 (edición generativa)

- **Función**: edición de vídeo por instrucciones; **single edit** documentado (imagen seleccionada → metraje).
- **Disponibilidad**: Runway Edit Studio; los términos exactos de la API requieren verificación en el momento de uso.
- **Restricciones documentadas en UI**: clips entre 2 y 30 segundos, 480–1080p, 24–30 fps, hasta 10 cortes; multi-edit/expand aparece marcado como "coming soon" en la UI documentada (V09).
- **Licencia**: sujeta a la cuenta y al plan; las condiciones comerciales se consultan en el contrato vigente.
- **Evidencia**: documentación oficial de Runway y docs.dev (V09, V10).
- **No implica**: que la API pública de Aleph 2 ofrezca los mismos controles que la UI; la calidad de salida no está garantizada por la herramienta.

### 1.6 Veo 3.1 (generación vídeo, preview)

- **Función**: generación de vídeo a partir de texto, con soporte de primer/último frame, audio y extensión sobre vídeos Veo.
- **Disponibilidad**: API Gemini con plan y cuotas propios.
- **Restricciones**: el seed no garantiza determinismo; la extensión se aplica sobre vídeos generados por Veo, no sobre material arbitrario; las capacidades combinables se verifican en la documentación vigente (V11).
- **Licencia**: sujeta a los términos de Google AI Studio / Gemini API; las condiciones de uso comercial se consultan en el contrato vigente.
- **Evidencia**: documentación oficial Google AI.
- **No transfiere**: un proxy de Blender como entrada arbitraria; el condicionamiento es por imágenes y por vídeos Veo.

### 1.7 LTX 2.5 Union Control (IC-LoRA 2.3)

- **Función**: control estructural (depth, canny, pose) para generación de vídeo.
- **Disponibilidad**: integraciones tipo ComfyUI; requiere GPU compatible, nodos y pesos.
- **Restricciones**: la IC-LoRA documentada como "heredada de 2.3" opera con el modelo 2.5; la licencia comunitaria puede condicionarse a facturación; conviene revalidar la licencia exacta antes de uso comercial (V12, V13).
- **Evidencia**: documentación oficial LTX.
- **No implica**: que LTX 2.5 funcione sin infraestructura; ComfyUI, GPU y pesos son requisitos.

### 1.8 FFmpeg (infraestructura)

- **Función**: concat, amix, loudnorm, reencuadre, filtros; infraestructura de ensamblaje y postproceso.
- **Disponibilidad**: binario oficial multiplataforma.
- **Licencia**: LGPL/GPL según componentes.
- **Evidencia**: documentación oficial FFmpeg (V14).
- **No es**: un motor creativo; no decide dirección.

### 1.9 ElevenLabs TTS (voz)

- **Función**: text-to-speech con catálogo de voces y clonación.
- **Disponibilidad**: producto comercial con plan y cuotas.
- **Restricciones**: la clonación de voz requiere consentimiento y una licencia comercial explícita; el modelo no es determinista por defecto (mismo texto, mismo motor, voces distintas entre runs) (V15).
- **Licencia**: comercial, ligada al plan y al uso; las condiciones se consultan en el contrato vigente.
- **Evidencia**: documentación oficial ElevenLabs.
- **No implica**: que una voz clonada pueda usarse fuera del ámbito autorizado.

## 2. Tarifas y licencias como datos fechados

Tarifas, planes y términos son **datos fechados**: cambian sin aviso y se rigen por el contrato vigente del proveedor en el momento del uso. Este dossier evita fijar precios y enlaza a la documentación oficial y a los términos contractuales del proveedor.

## 3. Tendencias verificables, no ranking

Las tendencias que la documentación y los casos revisados permiten nombrar sin inflar:

- Edición de footage con condicionamiento estructural.
- Vídeo-código (motion graphics sobre material generado).
- Audio integrado en la pipeline desde el inicio.
- Aumento de conditioning multimodal (depth, pose, canny, identidad).

No se publica un ranking de "más usados" ni una cuota de calidad promedio. Las estrellas, demos y materiales de marketing no son evidencia de capacidad estable ni de idoneidad para un proyecto concreto.

## 4. Pendientes

- Confirmar licencia de Remotion y de los adaptadores HyperFrames en la versión que se vaya a usar.
