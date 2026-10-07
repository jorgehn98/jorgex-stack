# 12 — Transcripción, precisión y silencios

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó y no hubo grabaciones de muestra. Detalle de transcripción y silencios para el flujo de [08](08-edicion-y-transcripcion.md): herramientas ASR (AS01–AS04), filtro `silencedetect` de ffmpeg (AS06), pipeline propuesta (AS05) y esquema de evaluación (AS07). Fuentes: [fuentes.md](fuentes.md) (AS01–AS07).

## 1. Alcance

Este capítulo describe las herramientas y el contrato de transcripción y silencios para la pipeline de 08. Las capacidades se declaran **estimadas** a partir de la documentación oficial, no probadas en runtime. Las marcas de tiempo por palabra son **precisión declarada por el modelo**, no precisión verificada contra el audio. La selección de motor la hace el usuario según capacidad y permiso (ver [05](05-herramientas-y-conectores.md) §4).

## 2. Herramientas ASR comparadas (AS01–AS04)

Ninguna se impone por defecto. La lista no es ranking de uso; es la matriz de fuentes que el dossier estudió.

| Código | Herramienta | Backend | Idioma | Word timestamps | Notas |
| --- | --- | --- | --- | --- | --- |
| **AS01** | faster-whisper | CTranslate2; CPU int8 o NVIDIA CUDA cuDNN; PyAV | Multilingual, **Spanish** incluido | `Word(start, end, word, probability)` con `word_timestamps=True`; atención DTW interna, **sin alineador externo**; resolución interna ~20 ms; probabilidad con 2 decimales — no es confianza de frontera | VAD interno configurable (`min_silence_duration_ms=2000` por defecto, `speech_pad_ms=400`); el modo batched usa `vad_min_silence_duration=160` (no es default editorial); VAD **restaura los tiempos originales internamente**, no duplica offset |
| **AS02** | WhisperX | Torch/torchaudio/Transformers/FFmpeg/NLTK; CPU o GPU; pesos descargados | Multilingual; **Spanish usa VOXPOPULI_ASR_BASE_10K_ES** (vigente, no universal) | `word_segments(word, start, end, score)` en segundos | ASR + CTC aligner. Wildcard + interpolación para caracteres no alineables (contrario a README); `XLSR` no garantiza compatibilidad automática con el CTC español; **3 decimales ≠ precisión 1 ms**. Riesgos: alternancia de código, acentos, solapamiento musical. `model_cache_only` protege HF; `torchaudio` y `NLTK punkt_tab` siguen descargando. Paper `arxiv.org/html/2303.00747v2` mide 200 ms collar en inglés AMI/Switchboard, no garantiza precisión de palabra en español |
| **AS03** | stable-ts | whisper/torch/FFmpeg; opcional faster-whisper o silero VAD; CPU/GPU | Whisper original | `WordTiming(word, start, end, probability, tokens)` en segundos; alineación con texto corregido, constraint por segmento | **README (snapshot 2026-10-02) marca `DEVELOPMENT PAUSED INDEFINITELY`**: estado de mantenimiento a esa fecha; el estado puede cambiar. Riesgo para producción crítica. Licencia del repo: MIT |
| **AS04** | Parakeet v3 (`parakeet-tdt-0.6b-v3`, model card pinned `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`) | NVIDIA NeMo; **rutas GPU o CPU separadas** (no cross-runtime compat) | v3 multilingual 25 idiomas incl. **Spanish**; v2 English only | Timestamps a nivel de word, segment y char en segundos | WER español documentado ≠ word-timing boundary calibration; no hay promesa de frontera exacta |

La licencia del repositorio no es la del modelo: cada modelo declara la suya en su model card.

## 3. ffmpeg `silencedetect` (AS06)

- **URL snapshot 2026-10-02**: `https://ffmpeg.org/ffmpeg-filters.html#silencedetect`.
- **Función**: detector de baja amplitud por debajo de un umbral durante una duración configurable; opera por canal; **independiente del ASR**.
- **Qué prueba**: gaps de baja energía en la señal de audio.
- **Qué NO prueba**: pausas narrativas, respiraciones, música, SFX, voz tenue. Un hueco de transcript no es silencio acústico.
- **VAD ≠ silencio**: el VAD puede llamar "no-speech" a música, SFX o respiración. Un gap de transcript es solo **indicio**, no verdad.

## 4. Pipeline propuesta (AS05, Propuesta)

Pensada para no inventar fronteras de palabra y no romper el material canónico:

1. **Preservar master** e inventario de reloj: duración total, offset de audio, canales, rotación, CFR/VFR, tail (cola no-speech).
2. **ASR** (AS01–AS04) para texto y timestamps estimados.
3. **Corrección humana** del transcript: nombres propios, negaciones, cifras. Lo pronunciado no es lo escrito; lo escrito puede no ser lo pronunciado. La corrección no inventa pronunciación.
4. **Alineación** (AS02 WhisperX o similar) solo si la corrección es grande; si es menor, el mapping previo se mantiene, con posible re-transcripción.
5. **VAD / `silencedetect` (AS06) independiente** del transcript: gaps de baja energía y duraciones.
6. **Evidencia de incertidumbre** por palabra: `method` (ASR directo / interpolado / missing) y `confidence` si el campo existe. Sin confianza, marcar `missing`.
7. **Cutlist protegida por contexto**: cada candidato a corte lleva `in`/`out` en tiempo fuente y un guard band contra fonemas circundantes.
8. **Fronteras auditivas**: si la frontera cae dentro de una palabra o la respira el transcript, no se corta; se re-evalúa o se acepta la pausa.
9. **Diarización ≠ separación acústica**: la diarización no garantiza separación de hablantes solapados; no se asume.

## 5. Evaluación propuesta (AS07, Propuesta)

- **WER norm declarado** sobre muestras en español; comparación con línea base.
- **Bias de `start`/`end` por percentiles** sobre waveform y onset/offset acústico; **tolerancia acordada** antes de medir.
- **Truncated phonemes** y **prosody drift** se reportan como fallidos; no se promedian.
- **No se publica benchmark de timing**: "precisión X ms" no se afirma sin reproducir la prueba; "modelo declara X" sí se documenta.

## 6. Pendientes

- Medir la pipeline con una muestra en español autorizada por el usuario.
- Verificar la licencia exacta de cada ASR/modelo en el momento de uso (WhisperX MIT, Parakeet CC-BY-4.0 según model card, faster-whisper MIT, stable-ts MIT en repo con mantenimiento pausado).
