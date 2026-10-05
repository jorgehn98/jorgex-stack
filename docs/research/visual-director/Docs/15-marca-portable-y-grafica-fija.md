# 15 — Marca portable y gráfica fija

> Investigación y propuesta. 2026-10-02. Cubre cómo se conserva el estilo de un resultado final aprobado como **marca portable** (un dueño por dato) y cómo se entrega la rama de **gráfica fija** (cartel, miniatura, banner, ilustración, diapositiva). No ejecuta; documenta capacidades estimadas. La cobertura del tema está en [18](18-cobertura-del-encargo.md). Fuentes en [fuentes.md](fuentes.md) (BK01–BK05, M05, TS01, E01, E04, LP01, LP02).

## 1. Marca portable: del resultado final aprobado al kit reutilizable

La marca portable **no** se construye desde la idea inicial del brief; se construye desde el **resultado final aprobado por el usuario** (o por delegación explícita). El kit se construye extrayendo lo **realmente aplicado y aprobado** en el resultado, tanto si la dirección final coincide con la dirección inicial del brief como si el usuario aprobó un cambio de dirección sobre esa misma pieza. El kit es el **índice de lo que la skill realmente aplicó y aprobó**, no una guía de estilo externa ni un derivado de catálogo. No se exige que el resultado difiera materialmente del brief para abrir el kit; lo que se exige es que el resultado esté aprobado y que lo extraído refleje lo aplicado, no un ideal previo.

**Cuándo se abre el kit**: cuando el usuario aprueba un resultado final, independientemente de si la dirección final coincide con la inicial o diverge; el kit refleja lo aplicado y aprobado (ver [09 §5](09-brand-kit-evolutivo.md)).

**Cuándo el kit se mantiene estable**: cuando la dirección vigente no cambia; las variantes de campaña se producen **dentro** del kit, no lo redefinen.

## 2. Un dueño por dato, no un archivo para todo

El kit tiene **un único dueño** en el proyecto, pero los **datos** que contiene proceden de fuentes distintas. **No** se replica la paleta en muchos documentos: se referencia desde el kit, que a su vez referencia al registro. Cada campo tiene **un dueño** en el código o en el archivo maestro:

- **Valores exactos** (códigos de tokens, hex, tamaños, animaciones): proceden de un sistema de tokens propio del proyecto (BK01 DTCG, BK02 Style Dictionary, BK03 Tokens Studio) o de los assets aprobados. Cada valor tiene un dueño en el código o en el archivo maestro; los **screenshot de apariencia no son prueba de valor** (color-space sRGB/Rec 709 no garantiza hex exacto; fps 25/30 con 400 ms ilustra duración pero no es default de token).
- **Intención**: vive en el `DESIGN.md` del proyecto (o equivalente). Se registra como `declarado` o `aprobado` con la razón de la decisión. **No** se infiere del screenshot.
- **Assets originales y derechos**: cada asset con su archivo fuente y su licencia. Si no hay archivo fuente, **no** se asume origen. "Del banco" o "del estilo de la marca" sin archivo es **no declarado**.
- **Versión vigente del master**: el render o export aprobado más reciente, con su ruta y su fecha. El "color del screenshot" no es prueba de valor hex; el hash del render sí permite identificar el archivo concreto, pero los **valores exactos de color y tipografía** se leen de su **fuente autorizada de tokens, código o metadatos pertinentes**: una captura o un hash del render **no demuestra** el valor hex de un token ni el tamaño exacto de un tipo.

## 3. Sistemas de tokens (BK01, BK02, BK03)

| Código | Herramienta | Forma | Licencia | Lo que sí | Lo que no |
| --- | --- | --- | --- | --- | --- |
| **BK01** | DTCG (Design Tokens Community Group) | `typed $value / $aliases / $description / $deprecated / $extensions`; `groups` no infieren purpose/type; resolver: orden de aliases resuelto después | W3C Software Document (per LICENSE.md del repo). **Final Community Group Report, NO W3C Standard** (normativo vs no-normativo) | Formato de token portable, contrato de `$value` y aliases | Derechos sobre assets; permisos de copia sustancial |
| **BK02** | Style Dictionary | Transformaciones; `docs/.../Hooks/Transforms/index.md` | Apache 2 | Transformaciones aisladas por plataforma, mismo origen, sin influencia cruzada | Equivalencia real roundtrip entre plataformas (no probado por el dossier) |
| **BK03** | Tokens Studio (Figma plugin) | Themes combinan sets; PRO vs all-feature-free/license (repo product free) | MIT | Themes como combinación de sets; flujo Figma→tokens | Roundtrip equivalence con Resolver (no testeado en este dossier) |

**Conclusión sobre los sistemas de tokens**: la elección del sistema es del proyecto, no de la skill. **La skill no impone** un sistema; documenta dónde están los valores y cómo se mantiene cada uno. Los **permisos de copia sustancial** se verifican en [fuentes.md](fuentes.md) (LP01, LP02): Taste MIT permite preservación de copyright + notice; Remotion skills no tiene LICENSE en el tree (404 en `LICENSE` raíz, sin `LICENSE`/`LICENSING`/`COPYING`/`COPYRIGHT`/`NOTICE`), por lo que cualquier copia sustancial queda **pendiente de verificación**.

## 4. Casos públicos (BK04, BK05)

- **BK04 — IBM (animation + typography)**: [`/design/language/animation/overview/`](https://www.ibm.com/design/language/animation/overview/) distingue **animación de UI productiva** (eficiencia) de **película de marca expresiva** (emoción); el mismo recurso sirve a una u otra intención. [`/animation/tips-and-techniques/`](https://www.ibm.com/design/language/animation/tips-and-techniques/) documenta `its>=24fps` como **brand policy**, **no** como regla universal — el valor numérico es ilustrativo, no default de token. [`/typography/type-basics/`](https://www.ibm.com/design/language/typography/type-basics/) cubre alineación, jerarquía, line length, spacing. **No** hay garantía de licencia de assets ni de resultados medidos en este dossier.
- **BK05 — Mastercard (sonic brand 2019)**: press release que describe un motif sonic (físico, digital, voice illustrative). **No** es plantilla. Lo que se cita es la **intención pública** de un caso, no la implementación reproducible. No se afirma haber escuchado el audio real, ni la efectividad, ni la disponibilidad de música con licencia.

**Conclusión sobre casos públicos**: la skill cita casos como **contexto de la industria**, no como referencia operativa. **No** se transcriben substantialmente; se resumen y se enlaza al permalink.

## 5. Diferencias entre piezas: del caso real al kit

La diferencia entre **pieza de UI productiva** (animación funcional, fps por defecto) y **película de marca** (emoción, duración de plano) **no** se resuelve con un parámetro fijo: se resuelve con la **intención declarada** y los **deltas** aprobados. Por eso `its>=24fps` no es token default; por eso 400 ms "10 f @ 25 fps / 12 f @ 30 fps" es **ilustrativo** y no se promueve a regla.

**Imagen estática vs motion**: una imagen quieta y un frame elegido **no** son el mismo recurso. La elección de "el mejor frame" se hace por intención (atención, timing, jerarquía espacial), no por defecto técnico. Un frame intermedio en un motion denso **no** se promueve a "frame elegido".

## 6. Gráfica fija: el entregable

La rama de **gráfica fija** (cartel, miniatura, banner, ilustración, diapositiva) sigue un pipeline:

1. **Concepto y mensaje** (del brief, sin asumir).
2. **Variaciones compositivas** (2–3 caminos, justificados).
3. **Muestras a tamaño real** (los formatos destino del entregable, no mockups).
4. **Aprobación** del usuario sobre la muestra a tamaño real.
5. **Export y entrega** con brief de entrega (dimensiones, formatos, perfil de color, alpha, fuentes, derechos, master version, editable si se pidió).

**Lo que se entrega** (cuando el usuario pide editable): archivo editable (Figma, Affinity, Illustrator, PSD), fuentes con licencia, assets con su origen, master version. **No** se entrega `.otio` o `.mp4` como "editable completo" (ver [16](16-acabado-audiovisual-y-entrega-editable.md) §4).

**3 ejemplos** (no son plantilla, ilustran el flujo):

- **Title** (hero / cover): la fuente se elige por **rol** (display, cuerpo, mono) y se documenta con su **licencia**. **No** se asume "48 px copy" como default; la jerarquía se decide por intención.
- **Web responsive→vertical video→static 1080×1350**: la pieza se adapta a **tres destinos** con foco en tiempo de lectura y atención por viewport. El formato ilustrativo es **1080×1350**; **no** es default universal.
- **Reveal precise** (microstate / reduced motion → vídeo explicativo → graphic steps): la transición entre medios se decide por la **intención del mensaje**; **no** se impone "todo en microstate" ni "todo en vídeo".

## 7. Audio + imagen + aprobación

**No** se entrega una pieza de marca con audio enmascarado por voz no aprobada, ni con visuales que no tengan derechos. La aprobación cubre **audio, imagen y tipografía** explícitamente. Si la pieza tiene voz, la voz está aprobada; si tiene música, la música tiene licencia; si tiene visuales, los visuales tienen archivo fuente y derechos.

## 8. Referencias a herramientas opcionales (1–2 frases, sin setup forzado)

Si el proyecto ya usa un sistema de tokens o un editor, la skill lo respeta y se limita a documentar el rol. Si no, la skill **no introduce** un sistema nuevo: se limita a registrar valores en el `DESIGN.md` del proyecto. La referencia breve a un sistema opcional sigue el patrón de [05](05-herramientas-y-conectores.md) §5: 1–2 frases, función, disponibilidad, setup condicional, sin receta.

## 9. Pendientes

- Verificar, en cada proyecto, la **aprobación** (usuario o delegación explícita) que abre la actualización del kit.
- Confirmar, en cada sistema de tokens, los **derechos de uso** del esquema y de los assets; las licencias se declaran en [fuentes.md](fuentes.md) (LP01, LP02).
- Mantener la separación entre **provisional y canónico** en el registro del proyecto, no solo en este documento.
- **Real evidence pendiente**: el kit no se ha probado con un caso real en esta fase; los ejemplos de §6 son ilustrativos, no casos validados.
