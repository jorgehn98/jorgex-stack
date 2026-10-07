# 13 — Edición multimodal y flujos reales

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó y no hubo grabaciones de muestra. Detalle de editores para el flujo de [08](08-edicion-y-transcripcion.md): editores de plataforma (ED01, ED02), OSS (ED03, ED04, ED05), un testimonio histórico individual (ED06) y un contrato propuesto (ED07). Fuentes: [fuentes.md](fuentes.md) (ED01–ED07).

## 1. Alcance

Editores que la pipeline de 08 puede invocar para cortes, reorden, rate, captions, mezcla y export. Las capacidades se declaran por la documentación oficial, no por runtime. La selección la hace el usuario. La lista no es ranking de uso; es la matriz de fuentes que el dossier estudió.

## 2. Editores de plataforma

### ED01 — Descript

- **URLs snapshot 2026-10-02**: `https://help.descript.com/script-editing/delete-vs-ignore` y `https://help.descript.com/export-and-share/timeline-exports`.
- **Delete vs ignore**: `delete` elimina el medio subyacente; `ignore` aplica strikethrough recuperable. Son operaciones distintas; la pipeline debe distinguirlas.
- **Export por destino**: XML Premiere/Resolve, FCPXML, AAF, SESX, EDL Reaper. No todos los formatos son equivalentes: efectos, transiciones, títulos, imágenes, automatización de audio, rate no se garantizan en todos los destinos.
- **Captions**: Final Cut y Resolve sí; Premiere no (matriz fuente-documentada). La export de SRT está documentada; los parámetros exactos requieren inspección.
- **Límite**: la corrección textual no es nuevo audio; la regeneración de voz del usuario (clonación) requiere consentimiento explícito.

### ED02 — Adobe Premiere (text-based editing)

- **URLs snapshot 2026-10-02** (acceso por search y extractos; varias URLs devolvieron 403 al fetch directo; se cita el path canónico, no la página completa):
  - `https://helpx.adobe.com/ca/premiere/desktop/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html`
  - `https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-transcripts.html`
  - `https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html`
- **Edición por texto**: editar la transcripción modifica los clips con sus timecodes. La corrección ortográfica no es cambio de lo pronunciado; la transcripción editada como prosa sin timecodes **pierde la identidad de proyecto** (el edit por texto solo tiene sentido con timecodes enlazados).
- **Export de transcript**: TXT y CSV; no es export del proyecto.
- **FCPXML y CMX3600 EDL**: tienen **límites**; no se declara fidelidad rica completa. La inspección de un export real es necesaria antes de prometer roundtrip.

## 3. Editores OSS

### ED03 — Auto-Editor

- **SHA pinned 2026-10-02**: `6512833d6cebc41f7ef45bd4e311e51be08c116b` (commit 2 oct 2026).
- **URLs**: `https://github.com/WyattBlue/auto-editor/blob/6512833d6cebc41f7ef45bd4e311e51be08c116b/README.md` y `https://auto-editor.com/ref/edit`.
- **Señales**: audio threshold `0.04` amplitud, motion `0.02` grayscale blur frame compare, caption matching (líneas, intervalos — no palabras exactas).
- **Límites**: margins min duration calibration no es semántica narrativa; music continuous previene silencios de baja amplitud; camera movement retiene movimiento irrelevante.
- **Export**: XML FCP7 Premiere, FCPXML Final Cut/Resolve, Shotcut, Kdenlive; timeline adjustable verificado en docs. No hay pipeline de cámara todo-ajustado.

### ED04 — LosslessCut

- **SHA pinned 2026-10-02**: `70f2663a7a7c995903701acd2f616d057f4fdc2f` (commit 30 sep 2026).
- **URLs**: `https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/README.md` y `src/renderer/src/edlFormats.ts`.
- **Pipeline**: cutlist segment CSV + FFmpeg fast stream cuts; key frame packets; Smart Cut experimental.
- **Límites verificados**: no hace mix/ducking/B-roll compose; import CMX EDL/XML/subset OTIO con `source_range` en segundos (no timeline gaps/transitions full roundtrip).
- **Bugs activos**: fixes recientes sobre pérdida de audio packets iniciales; no se declara end-to-end verificado.

### ED05 — charlesbrandt/transcript (personal)

- **SHA pinned 2026-10-02**: `be5a6e6a8d377f0b41452b6af0ad49a8ebb9b35e` (commit 28 sep 2026).
- **URL**: `https://github.com/charlesbrandt/transcript/blob/be5a6e6a8d377f0b41452b6af0ad49a8ebb9b35e/transcript_editor/editor.py`.
- **Pipeline**: word metadata → editable Markdown → SequenceMatcher → mantener source intervals + padding → ffmpeg `trim atrim reset concat`.
- **Riesgos documentados**: insertions se ignoran y reorders se ordenan cronológicamente; `--keep` CLI no está cableado a diff/render (bug de source); `dry run` print comentado; duración `original` desde first/last palabra no desde el media completo (peligro de truncar cola). **Sin madurez o adopción acreditada en revisión**: el código se inspecciona, no se ejecuta, y no se certifica como probado.

## 4. ED06 — Testimonio histórico (individual, no benchmark)

- **URL snapshot 2019-12-14**: `https://gist.github.com/esa1975/46ca1151f2a2ee2725aa20b61fe3e67a/055db1d463c3eb411a04e700b4f3ba88e294afa9`.
- **Contenido**: de 43 min a 31 min con jump cutter, **deja** repeticiones semánticas y requiere pasada manual; márgenes, consonantes y FPS como preocupación.
- **Carácter**: **histórico e individual**. No es benchmark de Auto-Editor ni recomendación de jump cutter actual. Se cita como antecedente, no como evidencia de calidad presente.

## 5. Contrato propuesto (ED07, Propuesta)

No se asume que un editor entienda los timestamps de otro. Para que cualquier editor (plataforma u OSS) encaje en la pipeline, el material se documenta explícitamente con:

- `source_id` + `hash` (origen y verificación).
- `in`/`out` source en tiempo fuente; `timeline_in`/`timeline_out` en tiempo destino.
- `timebase` (CFR/VFR): `timebase` es formato del reloj del archivo; **VFR se trabaja con PTS por frame** (no se promedia con `avg_frame_rate`, que sería un redondeo inexacto). Si el material se conforma a CFR para edición, la copia CFR preserva el master y se documenta el mapa de correspondencia entre PTS source y frames CFR.
- `order`, `rate`, `linked_tracks` (cápsulas, música, b-roll).
- Reglas: `[in, out)` semi-abierto; offsets de archivo vs timecodes vs tiempo final se distinguen.
- Segmentos retenidos: rate constante `t_final = t_dest + (t_source - source_in) / rate` con `source_in` y `source_out` declarados.
- **Ripple**: tracks vinculados (captions, música, b-roll) se mueven juntos; no se manejan overlap ni duración total a ciegas.
- **Drift A/V**: verificar al inicio, mitad y final; no asumir sincronía perfecta.
- **Inventario**: duración total, offset de audio, canales, rotación, CFR/VFR, **tail** (cola no-speech).
- **VFR tail no es last word**: la cola final puede ser no-speech (ASR/AS06) y no debe contarse como palabra alineable.
- **Contact sheet**: timestamps del material completo + densos antes/después/punto de corte y acción. Imágenes estáticas pierden motion; transcript pierde prosody/música; secuencias cortas reproducen el playback real (si la herramienta lo soporta o humano).
- **Capacidades efectivas, no incapacidad universal**: la modalidad del modelo (ver, oír, leer, inferir) depende del modelo, la interfaz y las herramientas disponibles — el acceso a un archivo no implica que el modelo lo vea o lo oiga. Si la pipeline solo tiene transcript + frames + medida acústica, **no se afirma que el modelo perciba lo que falta**; los componentes no percibidos (motion continua, prosody, inteligibilidad musical, dinámica audiovisual) quedan como **límites explícitos** y se cubren con **revisión humana** de la pieza final cuando el caso lo pida.

## 6. Pendientes

- Confirmar, con una muestra en español autorizada, qué editor (o combinación) cumple el contrato ED07.
- Definir el preset de export por destino (Premiere/Resolve/FCP/Reaper) cuando el caso lo pida.
- Medir el drift A/V real con material del usuario.
