# 14 — Remotion, Hyperframes, transcripción y límites

> Investigación y propuesta. 2026-10-02. Cubre los métodos de runtime de Remotion (`@remotion/install-whisper-cpp`, `@remotion/whisper-web`) e Hyperframes (CLI `transcribe`/`snapshot`, wrappers `media-use` y `embedded-captions`) para la pipeline de [08](08-edicion-y-transcripcion.md) y [11](11-skills-externas-aportes-y-limites.md). No ejecuta; describe la superficie y los límites. Sin grabaciones de muestra. Fuentes en [fuentes.md](fuentes.md) (RT01–RT09).

## 1. Alcance

Runtime específico para transcripción, silencio y snapshot, distinto de los skills declarativos (M/R/H/TS en [11](11-skills-externas-aportes-y-limites.md)). Este capítulo documenta capacidades del runtime; la futura skill operativa solo referenciará contratos cortos (ver RT09), no tutoriales de API. No se asume que las herramientas estén instaladas; el usuario declara su entorno.

## 2. Remotion native (RT01)

- **URL pinned 2026-10-02** (Remotion runtime `f229094de9c8ca80565d9928a1191ccd39aea931`): `https://github.com/remotion-dev/remotion/blob/f229094de9c8ca80565d9928a1191ccd39aea931/packages/docs/docs/install-whisper-cpp/transcribe.mdx` y `.../install-whisper-cpp/install-whisper-cpp.mdx`.
- **Ejemplo FFmpeg en docs**: `npx remotion ffmpeg -i input.mp4 -ar 16000 output.wav -y`. **No** se ejecuta; el `-y` destructivo se omite en la pipeline.
- **Requisito**: WAV 16 bit 16 kHz, modelo binary compatible, `tokenLevelTimestamps: true`, `toCaptions` (`.../install-whisper-cpp/src/to-captions.ts`).
- **Salida**: offsets `startMs`/`endMs`; `timestampMs = t_dtw * 10` (o `null`); **DTW a nivel de token, no de palabra**, no es alineamiento forzado de texto corregido.
- **Modelo**: multilingual small/medium, `language: "es"` (opción distinta del default del modelo). `translateToEnglish` es una **opción aparte**, distinta de `language`; su valor por defecto es `false`, lo que **desactiva la traducción**. Los modelos `.en` (inglés) **no** traducen automáticamente: producen salida en inglés cuando se les da audio no-inglés o producen el comportamiento del modelo inglés.
- **CPU/GPU**: depende del build instalado; `pkg != CUDA` por defecto.
- **Caption**: `{text, startMs, endMs, timestampMs, confidence}` en milisegundos; **sin** campo `speaker` estándar.

## 3. Remotion browser (RT02)

- **URL pinned**: `.../packages/whisper-web/src/transcribe.ts`, `.../can-use-whisper-web.ts`, `.../resample-to-16khz.ts`.
- **Stack**: WASM multithread Whisper.cpp. **No** usa GPU; **no** es lo mismo que `whisper-webgpu` (backend separado).
- **Flujo**: `canUseWhisperWeb` → `downloadWhisperModel` → `resampleTo16Khz` → `transcribe({language: "es"})`.
- **Aislamiento**: `crossOriginIsolated`, `SharedArrayBuffer`, `IndexedDB`, formatos de storage. `resampler` usa solo channel 0; **no** mezcla multicanal; conversaciones multicanal requieren downmix explícito.
- **Corrección sobre 08**: la versión previa del dossier mencionaba "Whisper WebGPU" como universal; **no** es exacto. Whisper WebGPU es un backend distinto, no la misma API. La doc de `@remotion/whisper-web` confirma WASM/CPU.

## 4. Hyperframes CLI (RT03)

- **URL pinned 2026-10-02** (HF `f16e509832d4fa02bbc9a5f81b59ff78f9d466af`): `https://github.com/heygen-com/hyperframes/blob/f16e509832d4fa02bbc9a5f81b59ff78f9d466af/packages/cli/src/whisper/transcribe.ts` y `.../docs/packages/cli.mdx`.
- **Comando documentado**: `npx hyperframes transcribe video.mp4 --engine whisper --model small --language es`. **No** se ejecuta; el `npx` puede descargar/ejecutar y requiere permiso del usuario.
- **Pipeline interna**: Whisper extrae 16 kHz mono WAV completo, DTW produce JSON con `offsets/1000`, `token join`, `interpolate repair`. `onset` metadata **no** recorta automáticamente.
- **Auto selección de motor**: HF prefiere `sherpa-onnx Parakeet` instalado CPU → `MLX Apple` → `Whisper` según idioma. **No** asume NVIDIA; el orden de fallback cambia según la máquina.
- **Snapshot**: `npx hyperframes snapshot my-project --at 1.5,4.3 --against ref.mp4` captura pares composición+ref **en un proyecto Hyperframes**; no es extractor genérico independiente. `--describe false` opcional para evitar análisis facturable externo.

## 5. Hyperframes media-use wrapper (RT04)

- **URL**: `.../skills/media-use/scripts/transcribe.mjs`.
- **Comportamiento**: prefiere `parakeet-mlx`; si no, CLI.
- **Diferencia de contrato**: `--model` se aplica solo a MLX (no se reenvía a CLI); **no** soporta `--language` desde este wrapper. La salida JSON MLX tiene `{text, words}`; la salida CLI es flat array. **Contratos distintos** entre backends; la pipeline inspecciona la salida real.

## 6. Hyperframes embedded wrapper (RT05)

- **URL**: `.../skills/embedded-captions/scripts/transcribe.cjs`.
- **Comportamiento declarado (riesgos)**: a pesar del nombre "native", prefiere `uvx WhisperX 3.8.6` CPU int8 + w2v2 alignment, y luego puede caer a HF CLI o a `parakeet`. Descarga modelos implícitamente.
- **Idioma**: `language_code` por defecto `"en"`, **no** autodetección fiable multilingual; **no** hay diarización.
- **Riesgos detectados por lectura estática en `embedded-captions/scripts/transcribe.cjs`**: la comprobación `silence_end > lastStart` puede tratar un cierre de silencio al llegar a EOF como silencio ya cerrado y pasar por alto la cola silenciosa. Además, el chequeo de volumen intenta usar el `audio.mp3` después de borrarlo. **No** se han reproducido estos comportamientos.

## 7. Silence detect (RT06, RT07)

- **RT06 — Remotion adaptive silence detect guide**: `.../packages/codex-plugin/skills/remotion-best-practices/remotion-markup/silence-detection.md`. Cadena `loudnorm` → `silencedetect` (segs) → `frame trims` con `floor startfps`/`ceil endfps`. **Reglas, no thresholds universales**.
- **RT07 — HF cut-silence**: heurística de gaps de palabra > threshold con 150 ms cada lado. **No** es prueba acústica; no diferencia speech, breath, sfx, music. `transcript-cut.mjs` y `cutlist.mjs` miden el último word con riesgo de truncar cola, incluso con `--keep`; `<200 ms` segmentos se dropean. `normal recode cuts` (herramienta de re-encode con frame/timebase concreto) **no** es lo mismo que `--copy` (keyframe, sin re-encode); sus desviaciones exactas dependen de la combinación frame/timebase. **Devuelven segments, no actualizan el mapping de subtítulos** — los subtítulos hay que **actualizarlos a posteriori aplicando un mapa temporal de captions** (no es lo mismo que regenerarlos): se itera por los **segmentos retenidos** y se ajustan sus `in`/`out` con la fórmula `t_final = t_dest + (t_source - source_in) / rate`. **Reglas de aplicación del mapa**: (a) **eliminar** las palabras cuyo audio fue eliminado por el corte; (b) **dividir o reagrupar** los captions que atraviesan empalmes; (c) **revisar acústicamente** los cortes que atraviesan una palabra antes de aceptarlos; (d) **no** mover texto eliminado a un audio diferente. La **re-transcripción final** es una alternativa de contraste — puede introducir nuevos errores ASR — y **no** es obligatoria ni reemplaza el mapping.

## 8. Snapshot methods (RT08)

- **RT08a — HF snapshot**: solo dentro de un proyecto Hyperframes (`my-project`); no extrae frames de un vídeo arbitrario.
- **RT08b — Remotion still frame composition**: **no** se compone automáticamente desde un source video; requiere assets ya disponibles.
- **RT08c — Native extract source frames**: se eligen herramientas existentes autorizadas; FFmpeg opcional. **No** se introduce nuevo script. `fractional fps` con time base racional, **no** redondeado.

## 9. Contrato raíz para futura skill operativa (RT09, Propuesta)

La futura skill **no** debería absorber este capítulo como tutorial. El **contrato raíz** que la skill operativa expone es la **información mínima útil** que el experto necesita para auditar y reproducir la operación, según el encargo y el backend elegido. **No** es un schema fijo ni obligatorio para todos los casos. A título indicativo:

- `fuente` con `id`, ruta y, cuando esté disponible, `hash` (el hash y los metadatos de reproducibilidad son **útiles pero opcionales** — se incluyen cuando aportan, no como campo obligatorio de ledger universal).
- `range` y `mapping` entre fuente y destino, en el `timebase` declarado (CFR/VFR con PTS por frame, no `avg_frame_rate`).
- `evidence` por palabra: `method` (ASR directo / interpolado / missing) y, cuando exista, `confidence`.
- Lista ordenada de métodos (RT0X) con sus inputs/outputs.
- Si el backend lo expone, `integrity` con el SHA final del destino.

La forma concreta del contrato se determina **en el flujo del proyecto**, según el backend elegido (Remotion, Hyperframes, otros); este capítulo no fuerza un ledger universal por palabra ni una base de datos fija. Los detalles viven en la documentación oficial, **no** en la skill. La sección 5 de [05](05-herramientas-y-conectores.md) sigue siendo el patrón de referencia breve.

## 10. Lo que este capítulo evita

- No instala ni corre nada; las URLs y SHAs son snapshots, no instalaciones reales.
- No afirma paridad entre backends. MLX y CLI no comparten `--model`; WhisperX y HF CLI tienen contratos distintos.
- No declara "GPU universal" para Whisper Web; es WASM/CPU. (La frase "Whisper WebGPU" que pudo aparecer en 08 §7 se corrige aquí.)
- No sube material del usuario.

## 11. Pendientes

- Validar el contrato RT09 con una muestra en español autorizada por el usuario; **no** se ejecuta aquí.
- Decidir el motor por defecto del proyecto cuando llegue el caso; el dossier no lo hace.
- Mantener la matriz actualizada si los SHAs del runtime cambian.
