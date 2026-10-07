# Visual Director — dossier preparatorio

> Investigación y propuesta. No es una skill implementada ni una dirección pieza-por-pieza aprobada.
> **Fecha**: pasada de investigación y propuesta 2026-10-02; pasada de cierre de arquitectura mínima 2026-10-03.
> **Nota**: los capítulos suplementarios 23–25 y el material fuente analizado no forman parte de este repositorio. El estado vivo del dossier vive en el [README raíz del dossier](../README.md); este README de `Docs/` es la vista histórica de la preparación.
> La **arquitectura mínima del primer borrador** queda **cerrada** en [`00-encargo-y-arquitectura.md`](00-encargo-y-arquitectura.md) (2026-10-03) como fuente autorizada; este README y los capítulos 01–22 son investigación comparativa y soporte, **no** instrucciones de runtime concurrentes. La **nueva versión** conforme a esta arquitectura **aún no está implementada**; la skill original `visual-director/` **existe** y permanece intacta, y el usuario puede seguir invocándola como hasta ahora. La activación de esa skill operativa es **manual** por decisión del usuario; este dossier define la dirección de la próxima versión, no sustituye a la actual.

Este dossier analiza la skill `visual-director/` y propone su evolución sin tocarla ni instalar nada. La activación de la skill es **manual** por decisión del usuario. La investigación aplicada (CLODYSSEY, web, vídeo, herramientas y conectores, edición y transcripción, brand kit evolutivo, criterio artístico, skills externas, marca portable, acabado y entrega, cobertura del encargo) está consolidada. El material fuente de CLODYSSEY analizado no forma parte de este repositorio.

## Documentos del dossier

- [00-encargo-y-arquitectura.md](00-encargo-y-arquitectura.md) — **fuente autorizada de la arquitectura mínima** del primer borrador (cerrada 2026-10-03): una skill raíz, tres rutas (web / audiovisual / gráfica fija), fases 0–6, brief lógico, métodos compartidos, referencias con dueño, propiedad y fronteras, "one home per dato". Reemplaza la propuesta abierta del 2 de octubre; los capítulos 01–22 siguen siendo investigación comparativa, no compiten como runtime.
- [01-video-metodos-y-pipelines.md](01-video-metodos-y-pipelines.md) — control explícito vs condicionamiento generativo, taxonomía, cinco pipelines canónicos, prototipo antes del lote, notas de determinismo.
- [02-video-herramientas-y-evidencia.md](02-video-herramientas-y-evidencia.md) — nueve características representativas con función, disponibilidad, restricciones, licencia y evidencia.
- [03-web-narrativa-cro-y-motion.md](03-web-narrativa-cro-y-motion.md) — mensaje, dos velocidades, CRO como hipótesis, patrones de motion con contraindicaciones, WCAG 2.2 y Core Web Vitals.
- [04-conversacion-autonomia-y-revision.md](04-conversacion-autonomia-y-revision.md) — descubrimiento conversacional, dueños de registro (work owner plan / visual decision record / evidence checkpoint), autonomía dentro del alcance, bucle de revisión con dos ejes.
- [05-herramientas-y-conectores.md](05-herramientas-y-conectores.md) — referencia breve para herramientas externas, revisión local antes de actuar, onboarding neutral de plataforma generativa o MCP.
- [06-clodyssey-aprendizajes.md](06-clodyssey-aprendizajes.md) — síntesis transferible del proceso CLODYSSEY: cinco movimientos, eventos por plano, composición, tropiezo del proxy 3D, fallos operacionales, aportación a 04.
- [07-validacion-y-decisiones-pendientes.md](07-validacion-y-decisiones-pendientes.md) — casos propuestos (base histórica **22** = 10 originales + 5 + 3 + 4 por riesgo distinto; +**3** tests derivados del caso 23 = **25** total), rúbrica objetiva y humana, pendientes reales sin backlog simulado.
- [08-edicion-y-transcripcion.md](08-edicion-y-transcripcion.md) — pipeline overview para grabaciones del usuario; el detalle de herramientas vive en 12/13/14.
- [09-brand-kit-evolutivo.md](09-brand-kit-evolutivo.md) — single owner, provisional vs canónico, qué guarda, versionado, reutilización futura; el detalle por fuente de dato vive en 15.
- [10-criterio-artistico-y-taste.md](10-criterio-artistico-y-taste.md) — sin paradigma anti-IA ni prohibiciones, 8 principios comunes atribuidos, evaluación artística y funcional.
- [11-skills-externas-aportes-y-limites.md](11-skills-externas-aportes-y-limites.md) — matriz 4 repos + 4 fuentes, SHA pinned, adopt/adapt/reject; 08–10 citan por código.
- [12-transcripcion-precision-y-silencios.md](12-transcripcion-precision-y-silencios.md) — ASR (AS01–AS04), `silencedetect` (AS06), pipeline propuesta (AS05), evaluación (AS07); sin grabaciones de muestra, capacidades estimadas.
- [13-edicion-multimodal-y-flujos-reales.md](13-edicion-multimodal-y-flujos-reales.md) — plataformas (ED01, ED02), OSS (ED03–ED05), testimonio histórico (ED06), contrato propuesto (ED07).
- [14-remotion-hyperframes-transcripcion-y-limites.md](14-remotion-hyperframes-transcripcion-y-limites.md) — runtime Remotion (RT01, RT02), Hyperframes (RT03–RT05), silencio (RT06, RT07), snapshot (RT08), contrato raíz (RT09).
- [15-marca-portable-y-grafica-fija.md](15-marca-portable-y-grafica-fija.md) — marca portable del resultado final aprobado; fuentes de token (DTCG, Style Dictionary, Tokens Studio); gráfica fija con pipeline concept→variations→samples→approval→export.
- [16-acabado-audiovisual-y-entrega-editable.md](16-acabado-audiovisual-y-entrega-editable.md) — finishing (OTIO, MLT, FFmpeg, EBU R128, BBC subs); paquete entregable; QA real.
- [17-casos-web-narrativos-y-cro.md](17-casos-web-narrativos-y-cro.md) — casos web narrativos y CRO observados (Scrollama, Pockets, Essential Words, GOVUK, HomeOffice); ficha creativa propuesta; 3 tests sugeridos.
- [18-cobertura-del-encargo.md](18-cobertura-del-encargo.md) — single home coverage assessment: matriz 16 requisitos→doc→cubierto/parcial→qué falta.
- [19-direccion-creativa-prototipos-y-critica.md](19-direccion-creativa-prototipos-y-critica.md) — método de dirección, prototipo como pregunta, crítica con lentes separadas; fuentes CR.
- [20-generacion-controlada-y-referencias.md](20-generacion-controlada-y-referencias.md) — 3 rutas compatibles (VACE, ATI, Wan2.2-Fun-Camera), condicionamiento vs input, límites reportados; fuentes GN.
- [21-web-interfaces-estados-y-experiencia.md](21-web-interfaces-estados-y-experiencia.md) — estados, foco, error, drag cancelado, role/contraste/anchura 320; componentes como contrato observado, **no** accesibilidad auto-certificada; fuentes UX.
- [22-grafica-composicion-y-assets.md](22-grafica-composicion-y-assets.md) — composición para póster/miniatura/diapositiva/ilustración, 3 pipelines por tipo de pieza, 6 insights procedimentales; fuentes GF.
- [fuentes.md](fuentes.md) — registro de fuentes con código, enlace, fecha de consulta, SHA pinned donde aplica, qué evidencia y qué no.

## Investigación consolidada (alcance consultado, no exhaustivo)

- **Núcleo común** — encargo, conversación/autonomía, criterio artístico, brand kit, registro de fuentes: 00, 04, 09, 10, 11, 15, 18. **Métodos compartidos**: tokens, motion con sentido, composición por relación, edición no destructiva, evaluación por lente.
- **Web e interfaces** — narrativa, CRO, motion, accesibilidad, estados y foco: 03, 17, 21 (con W01–W14, WC01–WC06, UX01–UX06 en [fuentes.md](fuentes.md)).
- **Producción audiovisual** — métodos y herramientas, edición, transcripción, acabado, entrega editable, generación controlada: 01, 02, 08, 12, 13, 14, 16, 20 (con V01–V15, AS01–AS07, ED01–ED07, RT01–RT09, FN01–FN05, GN01–GN10 en [fuentes.md](fuentes.md)).
- **Gráfica fija** — composición para póster/miniatura/diapositiva/ilustración, marca portable, gráfica fija con pipeline: 15, 22 (con BK01–BK05, GF01–GF06 en [fuentes.md](fuentes.md)).
- **Dirección creativa, prototipos y crítica** — método, prototipo como pregunta, crítica con lentes separadas, 6 principios operativos: 19 (con CR01–CR05 en [fuentes.md](fuentes.md)).
- **CLODYSSEY (Superpersuasion)/** — análisis aplicado integrado en [06](06-clodyssey-aprendizajes.md). El material fuente analizado no forma parte de este repositorio. El vídeo final y el audio del paquete **no** se han inspeccionado en esta fase; el método para hacerlo cuando estén disponibles está en 06 y en 12.
- **Investigación web** — consolidada en [03](03-web-narrativa-cro-y-motion.md) y registrada en [fuentes.md](fuentes.md) (W01–W14).
- **Investigación vídeo** — consolidada en [01](01-video-metodos-y-pipelines.md) y [02](02-video-herramientas-y-evidencia.md) y registrada en [fuentes.md](fuentes.md) (V01–V15).
- **Onboarding de herramientas** — registrada en [fuentes.md](fuentes.md) (T01–T08) y operativizada en [05](05-herramientas-y-conectores.md).
- **Edición y transcripción** — pipeline overview en [08](08-edicion-y-transcripcion.md); detalle ASR/editor/runtime en [12](12-transcripcion-precision-y-silencios.md), [13](13-edicion-multimodal-y-flujos-reales.md), [14](14-remotion-hyperframes-transcripcion-y-limites.md); fuentes AS, ED, RT en [fuentes.md](fuentes.md).
- **Brand kit evolutivo** — single owner, provisional vs canónico, versionado en [09](09-brand-kit-evolutivo.md); el detalle por fuente de dato vive en [15](15-marca-portable-y-grafica-fija.md).
- **Criterio artístico y taste** — sin paradigma anti-IA ni prohibiciones, 8 principios comunes atribuidos en [10](10-criterio-artistico-y-taste.md).
- **Skills externas y fuentes profesionales** — 4 repos con SHA pinned y 4 fuentes profesionales en [11](11-skills-externas-aportes-y-limites.md); códigos M, R, H, TS, E en [fuentes.md](fuentes.md).
- **Marca portable y gráfica fija** — DTCG, Style Dictionary, Tokens Studio, casos IBM y Mastercard, pipeline estática en [15](15-marca-portable-y-grafica-fija.md); fuentes BK en [fuentes.md](fuentes.md).
- **Acabado y entrega editable** — OTIO, MLT, FFmpeg, EBU R128, BBC subs en [16](16-acabado-audiovisual-y-entrega-editable.md); fuentes FN en [fuentes.md](fuentes.md).
- **Casos web narrativos y CRO** — Scrollama, Pockets, Essential Words, GOVUK, HomeOffice en [17](17-casos-web-narrativos-y-cro.md); fuentes WC en [fuentes.md](fuentes.md).
- **Cobertura del encargo** — single home coverage assessment en [18](18-cobertura-del-encargo.md).

## Estado y límites

- **Fechas**: pasada de investigación y propuesta 2026-10-02; pasada de cierre de arquitectura mínima 2026-10-03.
- **Estado de la arquitectura**: **cerrada** para el primer borrador en [`00`](00-encargo-y-arquitectura.md) §3 (decisiones) + §4 (fases) + §7 (referencias con 14 archivos) + §9 (fronteras) + §10 (one home per dato). La **nueva versión** conforme a esta arquitectura **aún no está implementada**; la skill original `visual-director/` **existe y sigue siendo invocable** por el usuario como hasta ahora. No se ha editado su `SKILL.md`, no se ha creado `references/graphic-routing.md` / `generative-media.md` / `audio.md`, no se ha fusionado `toolbox.md` ni `recipes.md`. La materialización de esos cambios es una pasada posterior autorizada, no de este dossier.
- **Estado de la skill**: la skill original no se ha modificado; no se ha instalado nada; no se ha ejecutado ninguna evaluación.
- **Activación**: la skill es **manual** por decisión del usuario. El dossier no propone automatizarla. Esta decisión está **resuelta**, no es un pendiente.
- **Diferencia entre este dossier y la skill**: aquí se analiza y se propone. `visual-director/SKILL.md` y `references/*` describen el comportamiento de la herramienta cuando se invoca. Este dossier no es un borrador de SKILL ni debe sustituir a la documentación de uso. `Docs/` no debe copiarse entero dentro de `SKILL.md` ni pre-cargarse en cada invocación.
- **Cobertura**: la matriz en [18](18-cobertura-del-encargo.md) refleja la evidencia revisada en esta pasada; no es exhaustiva ni exige nuevas tareas. El dossier se compone de los capítulos listados arriba (00–22); el caso read-only baseline 23 no forma parte de este repositorio; el conteo exacto se mantiene en este índice, **no** en [18](18-cobertura-del-encargo.md).
- **Casos de prueba en 07**: los casos propuestos (base histórica **22** = 10 originales + 5 + 3 + 4 por riesgo distinto no cubierto, +**3** tests derivados del caso 23 = **25** total; ver detalle en 07) siguen pendientes de ejecución autorizada; no se ejecutan ni se puntúan ahora. `evals/evals.json` tampoco se ha ejecutado ni verificado.
- **Material de CLODYSSEY**: El material fuente analizado no forma parte de este repositorio. Vídeo final y audio siguen sin inspeccionarse.
- **PhotoHeart V3**: aprobada por el usuario, **no** verificada por esta revisión. **No** se reabre su polish sin objetivo nuevo; **no** se usa como benchmark de la arquitectura.
- **Cierre de este dossier**: la carpeta `Docs/` se eliminará solo cuando exista una migración útil y un cierre futuro aprobado por el usuario. Esa aprobación no se ha producido.

## Cómo leer este dossier

- Cada documento declara fecha, estado y qué es propuesta frente a observación.
- Cuando un dato viene de la skill existente, se cita el archivo concreto de `visual-director/`.
- Cuando es propuesta, se marca explícitamente.
- No se inventan URLs, IDs de evaluación, resultados no realizados ni cifras de coste o tiempo.
- Las fechas de publicación solo aparecen cuando se conocen.
- Las afirmaciones sobre repos externos llevan **SHA pinned** o URL de documentación oficial y declaran lo que la auditoría verificó y lo que no.
- Las licencias se declaran en [fuentes.md](fuentes.md) (LP01, LP02); las copias sustanciales de repos externos se hacen tras verificación de licencia.
