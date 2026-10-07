# 07 — Validación futura y decisiones pendientes

> Investigación y propuesta. 2026-10-02. Propone cómo se evaluaría la futura skill sin ejecutarla ahora. No modifica `evals/evals.json` ni introduce backlog de producción. Distingue fuentes, decisiones y pendientes.

## 1. Lo que se propone validar, no ejecutar

La futura skill debe evaluarse con casos que cubran la **combinación de métodos**, la **disciplina de conversación/autonomía/revisión** y los nuevos capítulos de edición, brand kit y criterio artístico. Estas son **propuestas**; la implementación y el momento dependen del usuario y del entorno.

| Caso | Qué demuestra |
| --- | --- |
| Combinación IA + programático + audio | Que un mismo plano suma capas sin perder determinismo donde corresponde |
| Web con vídeo / motion y fallback | Que la versión sin motion sigue funcionando y la accesibilidad no se rompe |
| Contaminación por proxy 3D | Que la pipeline detecta y trata el proxy antes de usarlo como referencia |
| Entregable estático (cartel, banner) | Que la rama de gráfica fija propuesta tiene ruta propia y criterio de revisión |
| Idea definida vs idea abierta | Que la conversación escala sin interrogatorio innecesario |
| Cambio posterior que conserva contexto | Que el feedback no rompe la fuente de verdad operativa |
| Bucle de revisión nulo o fuera de presupuesto | Que la skill se detiene, documenta el motivo y pide decisión |
| Herramienta ausente | Que la skill justifica, pide permiso y propone comando vigente |
| Instalación vs gasto | Que la skill separa disponibilidad, autorización y coste |
| Feedback humano que cambia un subconjunto | Que la skill ajusta solo el alcance afectado, no reinicia |
| **Word timeline coherente tras cuts / reorden / rate** | Que la pipeline actualiza el mapping de subtítulos con un mapa temporal sobre los segmentos retenidos; re-transcripción/re-alineación son opcionales y se aplican solo cuando aportan valor, hay incertidumbre, o se quiere verificar (no son obligatorias en cada edición) (08 §8, 12 §4, 14 §7) |
| **No "silencio" detectado léxicamente** | Que la skill no trata huecos de transcript como silencio acústico ni elimina pausas narrativas sin decisión editorial (08 §3.5, §4) |
| **Brand kit: provisional vs canónico** | Que el feedback provisional y una nueva exploración no sobrescriben el brand kit; solo un resultado final aprobado actualiza el canónico (09 §3, §8). Un resultado final aprobado se trata como **ejemplo aprobado dentro de su alcance**, **no** como nueva norma de marca; **no** se interpreta ninguna aprobación de entrega como actualización automática del brand canónico — la promoción a canónico requiere un alcance explícito aprobado según 09 |
| **Taste estático del brand: sin bans, sin cuotas, sin provider** | Que el registro de estilo no impone fuentes, colores, layouts, motion obligatoria, ni preferencia de proveedor; los ejemplos se admiten atados a la intención (10 §6, §8) |
| **Permisos correctos sobre assets y voces** | Que la skill verifica consentimiento y licencia antes de clonar voz, reusar assets de terceros o subir grabación a un servicio (08 §7, 09 §4) |
| **Word timeline en VFR** | Que la pipeline maneja `timebase` VFR con PTS (no `avg_frame_rate`) y verifica drift A/V al inicio, mitad y final (12 §4, 13 §5, 14 §1) |
| **Tail handling en cutlist** | Que la cola final sin habla (ASR + `silencedetect`) no se cuenta como palabra alineable; `t_final` se calcula por el mapa temporal sobre segmentos retenidos; re-transcripción tras cut mayor es opcional (12 §4 paso 1 inventario + paso 4 alineación condicional, 14 §7 RT07) |
| **Versión y capabilities declaradas** | Que la skill documenta motor ASR (AS01/AS02/AS03/AS04) y versión exacta; no asume runtime ni capacidades; mantiene `tail` no-speech fuera del word-boundary; word-timestamps se tratan como estimación, no como precisión verificada (12 §2, 12 §5) |
| **Prototipo adaptado a incógnita** (CR01–CR05, [19](19-direccion-creativa-prototipos-y-critica.md)) | Que la dirección responde a un brief con huecos declarados (CR02), **no** rellena con gusto personal; el prototipo se construye para responder una pregunta, no como preview; la crítica aplica los lentes `problem / solution / implementation` (CR03) y el focus genericity test (CR01). **No** se ejecutan dos subagentes como panel, ni Nielsen proporcional como métrica universal, ni usuarios simulados; **no** se fuerza una sola pasada de revisión |
| **State vs backend fake-success + focus UX** (UX01–UX05, [21](21-web-interfaces-estados-y-experiencia.md)) | Que un componente con datos simulados (ej. tabla de Carbon) **no** se confunde con datos live (UX02); el foco vuelve al cerrar popover; `Escape` cancela drag sin target válido (UX03); el estado empty / no-results / loading / error no se mezcla (UX02, UX05); la acción de recuperación no es decorativa. `prefers-reduced-motion` se verifica por pieza (UX01) |
| **Imagen como condición ≠ motion input — check por checkpoint** (GN01–GN10, [20](20-generacion-controlada-y-referencias.md)) | Que `image` en una pipeline **no** se trata como input de motion; `conditioning_scale` (GN02) y `pose_video` / `face_video` pre-procesados (GN04) y `control_camera_txt` (GN07, GN08) se verifican **por checkpoint**, **no** por nombre de modelo; first-last frame (GN03) **no** garantiza identidad de historia; condicionar **no** es copiar geometría/píxeles; la continuidad queda **desconocida** y se cubren huecos con referencias aprobadas repetidas |
| **Recomposition readability / crop semantic en gráfica fija** (GF01–GF06, [22](22-grafica-composicion-y-assets.md)) | Que el crop preserva el contexto (no distorsiona); la recomposición se prueba en el target real, no en abstracto; el `alt` se elige por función, no por descripción de forma (GF05, GF06); las licencias del software (SVG.js MIT, Rough.js MIT) **no** se transfieren a los assets copiados (GF03, GF04); las tipografías declaradas por defecto **no** se asumen libres (GF01) |
| **Intención marketing vs demo/tutorial** (caso declarado 23) | Que la pipeline pregunte la intención **solo si existe ambigüedad**; si el usuario ya declara marketing, no se fuerza una segunda entrevista. Que el criterio de revisión cambie con la intención (un MP4 válido no implica marketing); **no** se extrapole el stack V2 como receta universal; **no** se dé por aprobada la pieza por estar bien renderizada. La marca "Editorial" se trata como **nombre de opción de presentación** en PhotoHeart, no como dirección editorial genérica (caso 23 §2) |
| **Render real fps vs duplicación de frames** (caso declarado 23) | Que el framecount del archivo final **no** se deduzca solo por aritmética (`duración × fps_target`); se verifica con `ffprobe` (o equivalente) el framecount real y la coherencia con el fps declarado. **El framecount y los metadatos de decodificación no bastan** para detectar duplicados: se comprueba la **cadencia real en tramos de animación** contra el movimiento esperado y contra los timings de captura del source; los **segmentos estáticos con repetición intencional** se permiten (no todo fotograma repetido es fallo). Métrica de framecount/decodificación ≠ verificación de movimiento fluido |
| **Separación fuente editable / entregable final según convención del proyecto** (caso declarado 23) | Que el proyecto editable (proyecto, fuentes, assets, scripts) y el MP4 final permanezcan **claramente distinguibles**, respetando el árbol de directorios del proyecto y la convención existente del brief; **no** se impone por defecto una carpeta separada cuando la jerarquía del proyecto los mantiene juntos; **no** se centraliza el entregable en un depósito único. Unicode: nombres de archivo y carpetas admiten tildes y eñes sin romperse. Los permisos sobre assets/modelos/voz se referencian al caso existente de **permisos correctos** (fila 15), no se duplican |

## 2. Cómo se evaluaría

- **Objetiva** sobre outputs y decisiones: ¿se siguió el brief? ¿se respetó el alcance? ¿se documentaron las paradas? Métrica: cumplimiento, trazabilidad, paradas justificadas.
- **Rúbrica humana** sobre arte y técnica: ¿la dirección se sostiene? ¿la pieza funciona en su contexto de consumo? Métrica: una rúbrica corta por medio, con criterios visibles antes de la prueba.
- **Baseline** contra la versión anterior de la skill y contra contextos frescos. No se ejecuta ahora.
- **Sin puntuación ficticia**: los casos no se puntúan hasta que se ejecutan. Los `evals/evals.json` existentes no se certifican como aprobados.

## 3. Lo que no es un pendiente

- No se introducen **nuevas tareas de producción** (renders, publicaciones, gastos) en este dossier.
- No se reabre la activación: la skill sigue siendo **manual**; eso es decisión del usuario, no algo a automatizar.
- No se imponen herramientas para "aprobar" los casos propuestos. Cada caso admite rutas alternativas.

## 4. Pendientes reales (no backlog simulado)

1. Comprobar la pipeline con una **muestra autorizada** en el entorno elegido (no en abstracto). Cuando llegue el caso, ejecutar las nuevas pruebas de word timeline, silencio y brand kit provisional vs canónico.
2. Inspeccionar el **vídeo final y el audio** del caso CLODYSSEY cuando estén disponibles, según el método descrito en el cap. 08 del paquete.
3. Confirmar **capacidades, permisos y presupuesto** por proyecto antes de invocar proveedores generativos, y aplicar la disciplina de autonomía dentro de lote preacordado (05 §6).
4. Validar la **futura rama de gráfica fija** (cartel, miniatura, banner, ilustración, diapositiva) cuando haya un encargo real.
5. Cerrar la **arquitectura definitiva** de la skill cuando las decisiones de activation (manual resuelta por el usuario), presupuesto y grafo de referencias estén tomadas.
6. **Brand final format**: definir el formato concreto del brand kit por proyecto cuando se aplique el flujo de [09](09-brand-kit-evolutivo.md) §2–§4.
7. **Verificación de LICENSE** de los repos R y TS antes de cualquier copia sustancial (ver [11](11-skills-externas-aportes-y-limites.md) §4 y §6): LP01 Taste MIT copyright 2026 ya verificada con copyright + notice preservados, **no** se asume permiso sobre los assets visuales referenciados por el código; LP02 Remotion skills **no** declara LICENSE en el tree 2026-10-02 (snapshot sin `LICENSE`/`README` permission field ni `package.json` permission), por lo que el **permiso para copiar sustancialmente queda pendiente** hasta que el repo declare una licencia o se obtenga autorización expresa.

## 5. Registro de fuentes

- Cada fuente se identifica con un código (V, W, T, SK, C, MAPA, M, R, H, TS, E, AS, ED, RT, BK, FN, LP, WC, CR, GN, UX, GF) en [fuentes.md](fuentes.md). La lista vigente y su descripción vive en [fuentes.md](fuentes.md); este capítulo **no** la replica como cifra cerrada.
- Para cada fuente: enlace, fecha de consulta, qué evidencia aporta y qué **no** aporta. Las fuentes M, R, H, TS, AS, ED, RT, CR, GN, UX y GF llevan el **SHA pinned** al commit concreto (cuando aplica) y declaran lo verificado por lectura del archivo frente a lo declarado por metadatos; las E (profesionales) y las CR03/CR04/CR05/GF01/GF02 son publicaciones externas sin SHA pinned.
- Las fechas de publicación solo se incluyen cuando se conocen; no se inventan.
- **Doc de proveedor** ≠ **marketing** ≠ **norma UX** ≠ **propuesta de integración no certificada** ≠ **fuente profesional como contexto** ≠ **Propuesta del dossier**. Las entradas AS05, AS07, ED07 y RT09 son Propuestas del dossier (no atribución upstream); AS06 es doc oficial de ffmpeg; las URLs son snapshots, no instalaciones reales.
- Distinción de namespaces: **R** son skills Remotion (capítulos 08, 11), **RT** son runtime Remotion/Hyperframes (capítulos 08, 14). **H** son skills Hyperframes (capítulos 08, 11), **RT** (RT03–RT05, RT07, RT08) son runtime Hyperframes. **TS** es el skill de Taste (capítulos 10, 11). No se mezclan.

## 6. Lo que este capítulo evita

- No presenta "tendencias medidas" como si fueran datos: las métricas de uso se evitan cuando no proceden de fuentes verificadas.
- No promete resultados CRO, de lipsync, de calidad de imagen ni de audio; cada resultado se reporta con su prueba real, no como "OK".
- No convierte el dossier en un roadmap de commits; las tareas de código son trabajo de la skill, no de este dossier.

## 7. Cierre del dossier

Este dossier se cierra como **investigación y propuesta**. La skill original queda intacta. La futura skill, su arquitectura definitiva y sus casos de evaluación se construyen con el usuario cuando las decisiones pendientes estén tomadas y el cierre futuro esté aprobado. Hasta entonces, este dossier no se elimina y se complementa, no se sustituye, por los materiales que se vayan entregando.
