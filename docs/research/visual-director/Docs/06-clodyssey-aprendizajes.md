# 06 — CLODYSSEY: aprendizajes transferibles

> Síntesis documental. 2026-10-02. Lee los análisis del making-of CLODYSSEY para extraer prácticas que pueden trasladarse a vídeos de otros estilos. No imita la estética ni reproduce el pipeline. El material fuente analizado no forma parte de este repositorio.

## 1. Lo que el paquete documenta y lo que no

El making-of describe la producción: brief, dirección, generación, edición y postproducción. Lo que **no** contiene en el momento de este dossier es el vídeo final, las tomas intermedias ni los archivos musicales independientes. Eso limita la evaluación del resultado audiovisual pero no la del proceso. El capítulo 00 del análisis fija ese alcance y separa observado, declarado, inferencia y propuesta.

## 2. Cinco movimientos del proceso

Secuencia que el making-of documenta como flujo, no como plantilla:

1. **Dirección y acción**: convertir la idea en acciones concretas (no en adjetivos).
2. **Imagen y consistencia**: producir y mantener identidad de personajes y mundo entre planos.
3. **Actuación**: animar la acción, no la pose.
4. **Audio real elegido**: voz, música y SFX con su propio criterio; el audio manda sobre cortes y lipsync.
5. **Composición JS y control de tiempo**: letras, type tucks, rotoscopia, sincronía con los eventos del audio; QA narrativa.

Este orden no es obligatorio. Es la secuencia que el making-of presenta y la que el capítulo 07 del análisis señala como transferible.

## 3. Eventos por plano

El **análisis cap. 04** del paquete define un plano por su estructura: estado inicial, estímulo, acción, reacción y estado final. Los **timestamps** del audio son intención, no garantía: si la canción se edita, los cortes derivados se invalidan y hay que rehacer el mapa. Cambiar una palabra en la letra cambia el sync (cap. 02: cierre narrativo vs cierre temporal).

## 4. Composición: máscaras y depth 2.5D

La composición posterior a la generación usa **máscaras y mapas de profundidad** para tuck de tipografía y movimiento 2.5D. No es geometría 3D completa. Cuando la base cambia (una placa se corrige, un clip se rehace), los derivados se invalidan. La pipeline debe poder regenerar los derivados desde la nueva base sin pintarlos a mano (cap. 05 del paquete).

## 5. Blender previz/proxy: workflow documentado, no éxito probado

Blender se usó para **previz, cámara y bloqueos**; también para generar un **proxy o pases** que sirviera de referencia para la generación. El workflow se detuvo parcialmente y el proxy **contaminó el aspecto** de tres tomas, que se retiraron. La documentación de este tropiezo no demuestra que la pipeline Blender→generación IA esté probada como éxito; demuestra que **el proxy hay que tratarlo antes de usarlo como referencia final**. Citas: orchestration §343–370, cap. 04 §45–51, cap. 05 §45–51.

## 6. Fallos operacionales con cifras

Lo que el making-of documenta como costes y modos de fallo:

- **830 créditos** de un provider consumidos por prompts automáticos antes de que el director los leyera; gasto previo a la revisión (orchestration §832–855).
- Revisión vacía leída como "OK" cuando era un estado de uso agotado (orchestration §897–907).
- Cola de GPU con ~20 h de espera; 67 cancelaciones y 15 plates derivados de takes viejos (orchestration §886–895).
- Solo **1 de los capítulos alcanzó el umbral de aceptación** humana en la primera vuelta (orchestration §915–924; análisis cap. 13 §102–113).

Estas cifras no descalifican el trabajo; describen el **coste real de iterar** y refuerzan la regla de prototipo representativo antes del lote. (Cifras tomadas del `orchestration.md` y del **análisis cap. 13** del paquete.)

## 7. Aportación a 04 (conversación, autonomía, revisión)

Los capítulos 11 y 13 del análisis contienen la lectura de la conversación y del bucle autónomo. Aportan a [04-conversacion-autonomia-y-revision.md](04-conversacion-autonomia-y-revision.md) tres ideas:

- **Una fuente de verdad operativa** con identificador, archivos de entrada, manifiest de jobs, selección de takes y log de runs. La conversación no es el único lugar donde viven las decisiones.
- **Reparto de autoridad**: el director fija intención y aprueba; el agente principal coordina, integra y corrige; los agentes de capítulo producen dentro de contrato; los revisores juzgan sin editar; los submitters envían lotes ya preparados. Cada rol tiene un límite y un archivo bajo su propiedad.
- **El prototipo representativo precede al lote**: el bucle **animar → revisar → corregir** opera sobre una unidad que demuestra la dificultad del proyecto, no sobre la pieza entera.

## 8. Lo que esta síntesis evita

- No afirma que el lipsync, el sonido final o las transiciones estén validados; esa parte del resultado **no se ha inspeccionado** en esta fase.
- No reanaliza las 644 imágenes, los 161 prompts ni las 36 hojas de contacto; el análisis previo ya los comprobó (cap. 00 del paquete).
- Esta síntesis no expone identificadores ni valores sensibles de logs. El material fuente analizado no forma parte de este repositorio.

## 9. Pendientes y límites registrados

- **Adjuntos referenciados pero ausentes del paquete**: algunos capítulos del análisis mencionan materiales que el paquete original no incluye como archivos sueltos. Se documentan aquí como límite, no se inventan rutas para suplirlos.
- Inspeccionar el vídeo final y un conjunto pequeño de canciones y tomas comparables cuando estén disponibles, siguiendo el método del capítulo 08 del análisis.
- Verificar el lipsync y la sincronía de audio con el master cuando los materiales lo permitan.
- Decidir qué elementos del proceso documentado entran en la futura skill como referencia breve y cuáles quedan como antecedente.
