# 08-registro-y-esqueleto — borrador

Fuente: informes/arq-registro-y-esqueleto.md (Nygard 2011, MADR 4.0.0, Fowler, documentación oficial de GitHub y Twelve-Factor; sin material de terceros adaptado salvo plantillas con licencia `MIT OR CC0-1.0`, que permiten reutilizarlas). Estado: borrador pendiente de revisión.
Naturaleza de la fase: es **el entregable de la skill**. Las fases 01-07 producen decisiones; esta las deja escritas en un único sitio para que las lean después Visual Director, landing-launch y cualquier agente que implemente. **Siempre aplica**, aunque sea en su forma más pequeña (una landing: brief, un registro de stack y hosting, y la lista de fases saltadas).

## Entrada
Las decisiones de 01-07, las fases saltadas con su motivo y los asuntos pendientes.

## Qué se escribe y dónde
Carpeta `docs/decisions/` (o la que el proyecto ya use para decisiones). Un archivo por decisión, `NNNN-titulo-con-guiones.md`, numeración secuencial que no se reutiliza, y un índice `docs/decisions/README.md` con una línea por registro (número, título, estado) y una lista "Pendientes". El brief de 01 es `00-brief.md`.
Se registra una decisión cuando es difícil de revertir, tiene alternativas reales, afecta a estructura, calidad, interfaces o coste, o su porqué se perdería. No se registran preferencias menores, decisiones temporales o de una sola persona, ni lo ya cubierto por una norma. Sin registros de relleno.
Tres tipos de entrada, con la misma plantilla:
1. **Decisión tomada** (estado `accepted`).
2. **Fase o tema saltado deliberadamente** (estado `accepted`, título "Se omite X" o "No decidir X todavía"): contexto (por qué ahora no), condición de revisión y consecuencia (qué se asume mientras tanto). El modo revisar lo reconoce como deliberado y no como olvido. Adaptación propia: ninguna fuente lo define.
3. **Asunto pendiente** (estado `proposed`): opciones ya conocidas y criterio para cerrarlo; al decidir pasa a `accepted` o `rejected`. Adaptación propia.

## Plantilla (base MADR 4.0.0 mínima + estado y consecuencias de Nygard)
Los campos marcados [propio] son adaptación de esta skill.
```
---
status: proposed | accepted | rejected | deprecated | superseded by NNNN
date: AAAA-MM-DD
decision-makers: [nombres o roles]
supersedes: NNNN              # [propio] solo si sustituye a otra
revisit-if: [condición]       # [propio] qué cambio de contexto obliga a reevaluar
---
# NNNN. Título corto: problema y solución elegida

## Contexto y planteamiento del problema
Fuerzas en juego, en frases completas y neutras. Requisitos del brief que la justifican.

## Opciones consideradas
* Opción A
* Opción B

## Resultado de la decisión
Opción elegida: "A", porque … (una razón verificable).

### Consecuencias
* Bueno: …  * Malo: …  * Neutro: …

## Más información (opcional)
Enlaces y evidencia con fecha de lectura; `[NEED: …]` o `[NEED: revisión legal]` si procede.
```
Reglas: un registro aceptado no se reescribe, se sustituye. Para sustituir, crear un registro nuevo con número nuevo que diga `supersedes`, y en el viejo cambiar solo el estado a `superseded by NNNN` (único cambio permitido). Nunca borrar ni renumerar. Los datos volátiles llevan enlace y fecha de lectura, y "revisit-if" indica cuándo hay que releerlos. Las decisiones se escriben en pirámide invertida (lo importante primero), con alternativas serias y su nivel de confianza.
Cuánto se escribe: el modelo de registro de una landing cabe en dos o tres entradas; un SaaS tendrá una entrada por decisión de 02-07. Se usa la plantilla mínima por defecto y la completa (con pros y contras por opción) solo cuando hay opciones reales que comparar.

## Contenido esperado del registro, por fase
01 brief (`00-brief.md`); 02 tipo y plataforma, modelo de renderizado por zona, estilo de arquitectura; 03 lenguaje, framework y tokens de innovación gastados, versión y fin de soporte; 04 datos y su operación, RPO y RTO, política de copias, mapa de datos con retención y ubicación; 05 servicios, construir o integrar, decisiones caras de revertir (ID de usuario, organizaciones, modelo de sesión); 06 alojamiento, entornos, CI/CD y reversión, región, coste y alertas, nivel de observabilidad; 07 nivel de rigor de seguridad, amenazas principales, lista "antes de lanzar", canal de reporte. Las fases saltadas figuran como entradas tipo 2.

## Traspaso a las siguientes skills
El registro es lo único que leen las demás skills; ninguna le pregunta al usuario lo que ya está escrito.
- **Visual Director:** lee tipo de proyecto, plataforma, renderizado y framework (para elegir tecnología visual dentro del stack decidido).
- **landing-launch:** lee hosting y cabeceras (05, 08 y 11), formularios y servicios (07), analítica y, en su fase legal, el **mapa de datos** de 04 para decidir documentos y consentimientos; no se hace análisis legal en esta skill.
- Si no existe registro, esas skills siguen funcionando con el stack existente, como hasta ahora.

## Esqueleto mínimo del proyecto (paso opcional; no usa `orchestrator`)
Solo con el visto bueno del usuario y una vez decidido el stack. No genera código de negocio ni pantallas; deja un proyecto que arranca y se puede desplegar, para que Visual Director y landing-launch empiecen sobre algo que compila. Contenido:
1. README con cómo arrancar (requisitos, instalar, ejecutar, probar, construir, variables necesarias).
2. `.gitignore` para el stack elegido (partiendo de las plantillas oficiales), commiteado antes del primer `install`, con `.env` y salidas de build.
3. Archivo de ejemplo de variables con nombres y valores de marcador, nunca reales (práctica común; solo Laravel lo documenta oficialmente); los secretos van por despliegue.
4. Gestor de paquetes decidido y su lockfile commiteado (verificado solo para npm; para otros gestores, comprobar su documentación).
5. Comandos de instalar, construir y probar definidos y documentados con lo que ya trae el stack.
6. CI mínimo con pruebas y build en push y PR.
7. Política de rama y de despliegue en una o dos líneas (rama principal, si hay PR obligatorio y comprobaciones requeridas, de dónde y cómo se despliega), ajustada a lo que permita el plan del proveedor.
8. Licencia o aviso del repositorio decidido por el titular; SECURITY, CONTRIBUTING y CODE_OF_CONDUCT solo si el repositorio es público o admite colaboradores. No copiar plantillas legales sin decidir que aplican.
9. `docs/decisions/` con la plantilla y los primeros registros de las decisiones ya tomadas.
No hacer: código de negocio, instalar dependencias antes de decidir gestor y versión, crear carpetas o archivos vacíos por ceremonia, commitear `.env` o secretos reales.
Si la implementación del esqueleto es más que esto (varios paquetes, monorepo, infraestructura), se deja para el flujo normal de planificación (`to-spec` y `orchestrator`), fuera de esta skill.

## Entregable
`docs/decisions/` con `00-brief.md`, los registros, el índice con estado y pendientes, y, si se aceptó, el esqueleto.

## Verificación
- Cada fase del triage está cubierta por un registro o por una entrada "se omite" con motivo.
- Cada registro enlaza con un requisito del brief y lleva estado, fecha y `revisit-if`.
- Ningún secreto ni valor real en el repositorio; el ejemplo de variables sin valores reales.
- El esqueleto, si existe, arranca, construye y pasa la prueba mínima con los comandos documentados.
- Datos volátiles con enlace y fecha.

## Auditoría (modo revisar)
Comprobar: ausencia de `docs/decisions/` en un proyecto con decisiones no triviales (media; alta si hay varios contribuyentes), registros sin estado o reescritos tras aceptarse, decisiones sustituidas sin enlace, fases saltadas sin motivo, `.env` o secretos commiteados (bloqueante), sin lockfile, sin README de arranque, sin CI ni política de rama, índice desactualizado, registros de relleno, decisiones volátiles sin fecha ni condición de revisión. Cuando no hay registro, reconstruirlo desde el repositorio y confirmarlo con el usuario.

## Puerta
La skill termina cuando existe el registro (con el brief y las decisiones, o con "se omite" y motivo), el índice con los pendientes, las decisiones volátiles fechadas, y el esqueleto si el usuario lo pidió. Siguiente paso recomendado: Visual Director (diseño) y después landing-launch (páginas principales).

## No verificado / pendiente
- Lockfiles de pnpm, yarn, bun, composer y pip; consecuencia de no tener licencia (la página de GitHub no la explica); límites de ramas protegidas en repositorios privados personales.
- Plantilla completa de MADR 4.0.0 solo como estructura; la mínima literal, con el inicio de su front matter truncado.
- La guía de cuándo no escribir un registro viene de un repositorio comunitario (Joel Parker Henderson), no de Nygard, MADR ni Fowler. Las decisiones saltadas, los asuntos pendientes, `revisit-if`, `supersedes` y el índice son adaptaciones propias.
- Ubicación: MADR usa `docs/decisions`, Fowler `doc/adr` y Nygard `doc/arch`; se usa la primera, que coincide con la estructura de documentación del autor.
- WebFetch devuelve resúmenes de un modelo: reabrir las páginas antes de entrecomillar. Ninguna página traía instrucciones para asistentes de IA (solo enlaces a `llms.txt` en la navegación, ignorados).

## Enlaces oficiales a incluir (verificar al redactar)
Nygard, "Documenting Architecture Decisions" (2011); adr.github.io y su página de plantillas; MADR (adr.github.io/madr y repositorio adr/madr); Fowler, "Architecture Decision Record"; docs.github.com (archivos de salud de la comunidad, `.gitignore`, ramas protegidas, Actions); 12factor.net/config; documentación de Laravel (`.env.example`) y de npm (`package-lock.json`).
