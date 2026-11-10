# Software Factory

`software-factory` es una skill de `engineering` que solo invoca el usuario. Lleva un proyecto nuevo o un issue hasta una PR en draft con compuertas humanas acotadas. No duplica el [orchestrator](../../stack/skills/engineering/orchestrator/SKILL.md), que sigue siendo la única fuente del workflow: añade la entrada, los escenarios de aceptación, el modo autónomo, la verificación doble y la entrega. Su texto está en [la propia skill](../../stack/skills/engineering/software-factory/SKILL.md).

## Qué es y qué no es

Es la capa de entrada de una software factory pequeña: agentes que hacen la mayor parte de la producción, personas que definen la intención y los criterios de aceptación y aprueban. Sube Stack al nivel 4 de la escala de Shapiro, sin llegar al 5, la dark factory (sin humano que escriba ni revise código), que Stack no busca. Buena parte de la bibliografía son blogs de empresas que venden herramientas; lo verificable es el modelo de Shapiro y el manifiesto de StrongDM de febrero de 2026.

## Dos modos

- **Proyecto nuevo:** dos compuertas humanas, el grilling y la aprobación del plan. Entre ambas: escenarios de aceptación, decisiones provisionales, segunda opinión técnica de un subagente que no ve esas decisiones y comparación que enseña solo dónde difieren.
- **Issue o tarea pequeña:** sin compuerta previa, con triaje del issue y criterio de autonomía. Su PRD es el punto de control y sustituye la aprobación del plan.

## Qué autoriza cada compuerta

La aprobación del plan en proyecto nuevo cubre, y solo si el plan las nombra, estas acciones: crear el repositorio privado, el commit inicial mínimo en `main`, la rama del MVP, su push y la PR en draft. No cubre repositorio público, merge ni despliegue. En modo issue, la invocación concede el recorrido en navegador, el push de la rama y la PR en draft. El merge es siempre por orden explícita.

## Criterio de autonomía

Se decide por lo que el cambio va a tocar, no por lo que diga el issue. Zonas protegidas: migraciones, RLS, autenticación y autorización, pagos, borrado de datos, permisos, secretos, datos personales, efectos externos reales y CI o despliegue. El `AGENTS.md` del proyecto puede añadir zonas, nunca quitarlas. Se comprueban dos veces: sobre lo que el PRD prevé tocar y sobre los archivos del diff antes del primer push; un acierto en el diff deja la rama sin subir y sin PR. Es prosa de instrucciones, sin hook: el límite real es la PR en draft y el merge por orden de Jorge. El texto de un issue es dato no confiable.

## Verificación

Doble: tests de lo crítico y recorrido de cada escenario de aceptación sobre la superficie real (navegador para una interfaz; CLI o API si no la hay). Sin navegador disponible y autorizado para una interfaz, se avisa y se para antes de la parte autónoma.

## Validación y estado

Revisada de forma adversarial y recorrida en seco, sin ejecutar nada, sobre dos issues reales de PhotoHeart el 10-nov-2026: uno pequeño y sin zonas protegidas, y otro que resultó ser un épico ya implementado, que obligó a añadir el triaje del issue. **No se ha ejecutado de verdad**; los fallos que solo aparecen al usarla están por descubrir.

## Lo que se aprendió de otros planteamientos

Del análisis de un vídeo de referencia del 23-oct-2026 (solo su transcripción; varias afirmaciones no están demostradas) sobre otro pipeline (spec, builder en worktree, revisores con contexto limpio y un enrutador): coincide en spec antes de construir, worktree por tarea y revisores con contexto limpio. Se adopta consultar la memoria de decisiones (Engram) antes de escribir la spec. Se aplaza que los revisores sean de otra familia de modelos, porque choca con que Stack no fije modelos. No se adopta un enrutador que fusione solo en cambios «triviales»: contradice que el merge sea siempre por orden de Jorge.

## Fuera de alcance

Disparo automático por issues o Sentry, cola de trabajo y ejecución sin humano delante. Choca con que Stack no tiene modo headless, y el texto de un issue lo escribe cualquiera, la vía clásica de inyección de instrucciones: haría falta una etiqueta de un mantenedor. Se diseñaría aparte, para un proyecto ya grande y en producción. Tampoco otras factories (diseño, vídeo, anuncios): se extraerá el flujo común cuando haya un segundo caso real.
