# 01-brief — borrador

Estado: borrador propio (sin fuente de terceros). Pendiente de revisión de Jorge.

## Objetivo de la fase
Entender qué es el proyecto y fijar las restricciones reales antes de proponer tecnología. Es el contexto que leen todas las demás fases y, después, Visual Director y landing-launch.

## Entrada: proyecto nuevo o existente
Primero se establece cuál de los dos casos es; define qué se inspecciona.
- **Proyecto nuevo (greenfield)**: no hay repositorio ni stack que leer. La entrada es lo que diga el usuario más lo que ya tiene alrededor: dominio, cuentas de hosting o de servicios, herramientas y lenguajes que ya domina, otros proyectos suyos con los que quiera compartir infraestructura, documentación o ideas previas. No se inventa un stack existente: se registra "ninguno" y se pasa a decidir.
- **Proyecto existente**: se inspecciona antes de preguntar. Repositorio, lockfiles, configuración, CI, contenedores, documentación previa, dominio y hosting en uso. Se detecta el stack real y se reutiliza salvo que el objetivo lo impida.
- **Mixto** (hay código parcial, un prototipo o una landing ya hecha que va a crecer): se trata como existente en lo que haya y como nuevo en lo que falte.
Aun en un proyecto nuevo, mirar la carpeta de trabajo y los hábitos del usuario (herramientas instaladas, convenciones de sus otros proyectos) evita proponer algo que no va a mantener.

## Pregunta de arranque (una sola, abierta)
"¿De qué trata el proyecto y qué debe conseguir?" A partir de la respuesta se deciden las demás preguntas; no se hace un cuestionario fijo.

## Qué hay que saber (preguntar solo lo que falte y cambie decisiones)
1. **Tipo y propósito**: sitio informativo o de marketing, aplicación con cuentas, herramienta interna, API/servicio, tienda, contenido editorial, prototipo.
2. **Usuarios y volumen realista**: quién lo usa, cuántos, picos previstos. Diseñar para la escala esperada a 12-18 meses, no para la imaginada.
3. **Datos**: qué se guarda, si hay datos personales o sensibles (salud, menores, pagos), quién escribe y quién lee, cuánto dura la información.
4. **Funcionalidad que fuerza arquitectura**: cuentas y permisos, pagos, tiempo real, archivos pesados, búsqueda, IA, offline, móvil nativo, integraciones obligatorias.
5. **Visibilidad**: público e indexable (SEO) o detrás de login; idiomas y regiones.
6. **Restricciones**: presupuesto mensual máximo, plazo, tolerancia a la dependencia de un proveedor, requisitos de residencia de datos o cumplimiento.
7. **Equipo y mantenimiento**: quién lo construye, quién lo mantiene, qué sabe ya esa persona o equipo, quién edita el contenido.
8. **Longevidad**: prototipo desechable, producto a validar o sistema de larga vida.
9. **Lo que ya existe**: en un proyecto existente, repositorio, stack, dominio, hosting y servicios; en uno nuevo, lo que el usuario ya tiene o domina (dominio, cuentas, herramientas, otros proyectos). Regla: reutilizar salvo que el objetivo lo impida.
10. **Jurisdicción/mercado**: si hay datos personales o ventas, a qué mercado apunta (enlaza con la fase legal de landing-launch).

## Cómo preguntar
- Agrupar preguntas independientes; dejar las dependientes para después.
- Cada pregunta con una recomendación y su coste. Separar hechos que se investigan de decisiones que son del usuario.
- Si queda ambigüedad material, usar `grilling`.
- Parar cuando se entienden objetivo, límites y riesgos; las preferencias de implementación no son otra entrevista.

## Triage: la skill decide qué fases hacen falta
La skill NO recorre todas las fases en cada proyecto. Tras el brief, decide qué fases aplican, cuáles se resuelven en una línea y cuáles se saltan, lo dice al usuario con su motivo y lo registra en el brief. El usuario puede añadir o quitar fases.
Matriz orientativa (no es una receta; manda el brief):
| Tipo de proyecto | Fases que aplican | Se reducen o se saltan |
|---|---|---|
| Landing o web estática informativa | 1, 2, 3 (ligera), 6, 7 (ligera), 8 | 4 y 5 salvo servicio de formularios o analítica de terceros; sin base de datos ni cuentas |
| Sitio con contenido gestionado (CMS) | 1, 2, 3, 4 (dónde vive el contenido), 5 (parcial), 6, 7, 8 | Identidad solo para los editores |
| Tienda online | 1, 2, 5 (pagos y correo), 6, 7, 8 | 3 y 4 casi nulas si se usa plataforma de comercio |
| Aplicación con cuentas (SaaS) | Todas | Ninguna |
| Herramienta interna | 1, 2, 3, 4, 5 (identidad), 6, 7, 8 | Visibilidad pública y SEO |
| API o servicio sin interfaz | 1, 2, 3, 4, 5, 6, 7, 8 | Renderizado |
| Aplicación móvil | Todas, más requisitos de tienda | |
| Extensión o automatización | 1, 2, 3, 6 (ligera), 8 | 4, 5 y 7 salvo que haya datos o credenciales |
Reglas: la fase 8 (registro de decisiones) siempre aplica; una fase "ligera" se resuelve con una pregunta y una línea en el registro; cada fase saltada queda anotada con el motivo ("sin base de datos: contenido en archivos") para que el modo revisar sepa que fue deliberado y no un olvido. Si durante el trabajo aparece un requisito que reactiva una fase saltada (por ejemplo, un formulario que ahora guarda datos), se vuelve a ella.
Preferencias del usuario: el brief pregunta por proveedores o herramientas que el usuario ya usa o prefiere (hosting, base de datos, auth, pagos). Se tratan como criterio de peso (conocimiento y mantenimiento del equipo), no como imposición: se comprueban contra los requisitos del proyecto y la skill avisa si sobran o no encajan, sin descartarlas por defecto. No se almacenan dentro de la skill; se leen de la conversación, de las instrucciones del usuario o del proyecto.

## Entregable
`docs/decisions/00-brief.md` (o la carpeta de documentación que ya use el proyecto): propósito en una frase, tipo, usuarios y escala esperada, datos y sensibilidad, funcionalidades que condicionan, restricciones, equipo y mantenimiento, longevidad, lo existente, lista de desconocidos con responsable y fases que aplican. Los datos que falten se marcan `[NEED: …]`, no se inventan.

## Verificación
- Proyecto existente: stack detectado leyendo el repositorio (lockfiles, configuración, CI, contenedores), no asumido. Proyecto nuevo: confirmado con el usuario que no hay nada que reutilizar, y registradas sus herramientas y conocimientos reales.
- Cifras de escala y presupuesto confirmadas por el usuario, no estimadas por la skill.

## Auditoría (modo revisar)
Solo aplica a proyectos existentes. Comprobar que existe un brief y que el sistema actual encaja con él: ¿el tipo de proyecto, la escala y las restricciones coinciden con lo construido? Si no hay brief, reconstruirlo desde el repositorio y confirmarlo. Fallos típicos: tecnología elegida antes de definir el problema; escala imaginada; restricciones de presupuesto o de mantenimiento ignoradas.

## Puerta
No se pasa a la fase 2 sin: propósito en una frase, tipo de proyecto, restricciones principales, stack existente detectado, o confirmado que el proyecto es nuevo, y desconocidos críticos resueltos o asignados.

## Antipatrones a señalar
Elegir tecnología antes del problema; diseñar para una escala hipotética; elegir por moda o por currículum del desarrollador; ignorar quién mantendrá el sistema.
