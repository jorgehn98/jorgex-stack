# Categorías de skills

Las skills de Stack viven en origen agrupadas por categoría (`stack/skills/<categoría>/<skill>`) y se instalan siempre planas en `~/.agents/skills/<skill>`. El catálogo completo está en el [README](../../README.md#shared-canon); este documento recoge las decisiones y sus límites.

## Categorías

- **engineering:** flujo de trabajo, roles de delegación, revisión, diagnóstico y arquitectura, y `software-factory`.
- **productivity:** aclarar, especificar, cerrar y explicar (`grilling`, `second-opinion`, `to-spec`, `close`, `retro`, `what`).
- **marketing:** dirección visual, páginas de conversión y crecimiento orgánico. Una sola categoría para marketing y creativo porque se usan encadenadas. `visual-director` es el límite: también sirve a interfaces de producto.
- **agent-tooling:** crear skills y servidores MCP.

No hay una categoría `core`: con veintidós skills sería una abstracción de más, y `productivity` cumple ese papel.

## Decisiones

- **Destino plano.** No se comprobó que cada runtime descubra skills anidadas, así que no se arriesga. La instalación plana además permite reorganizar categorías sin romper a nadie: skills.sh y los usuarios se refieren a las skills por nombre y solo cambian el manifiesto `skills.sh.json` y la selección del instalador.
- **`engineering` requiere `productivity`:** el orchestrator usa `to-spec`, `grilling` y `second-opinion`. Marcar `engineering` en Instalar marca `productivity` y lo avisa. Las referencias a `marketing` desde otras categorías dicen «si está instalada»; las de `engineering` a `productivity` son incondicionales, y por eso existe el arrastre.
- **Instalar elige, Actualizar no pregunta.** Instalar (en Todo y en Skills compartidas) muestra un multiselect de categorías. Actualizar y Doctor usan las categorías cuyas skills Stack ya posee por archivo; añadir una categoría nueva se hace con Instalar. No hay estado nuevo en el manifest.
- **Desmarcar no retira.** En esa ejecución de Instalar, lo no marcado no se toca ni se retira, enlaces de Claude incluidos. Sigue registrado como propiedad de Stack, así que Actualizar y Doctor lo siguen tratando como propio. Quitar skills es solo Desinstalar. Se mantienen la propiedad por archivo, los backups y la preservación de skills ajenas.
- **Nombres únicos.** Un nombre repetido entre categorías no cabe en el destino plano y bloquea la instalación.

## Un fallo que merece recordarse

La primera versión retiraba como huérfanos los enlaces de Claude (`~/.claude/skills/<skill>`) de las categorías desmarcadas: el enlace es la raíz misma de la skill y la comprobación de contención no cubría la igualdad de ruta. Lo detectaron dos revisiones independientes durante la PR #284 y lo protege un test con el adaptador de Claude Code. Cualquier cambio en el retiro de huérfanos debe conservar ese caso.

## Límites conocidos

- El arrastre `engineering → productivity` solo ocurre en el menú, no en una llamada programática a `runInstall`.
- Doctor no detecta skills ausentes si no hay ninguna categoría poseída; las demás comprobaciones siguen aplicando.

## Añadir una skill o una categoría

1. Crear la carpeta en su categoría; una categoría nueva es una carpeta nueva en `stack/skills/`. No se crean carpetas vacías por anticipado.
2. Añadirla al grupo de su categoría en `skills.sh.json`; un test falla si el archivo y las carpetas no coinciden (ver [skills.sh](skills-sh.md)).
3. Actualizar el conteo y el catálogo en el `AGENTS.md`, el README y [skills.sh](skills-sh.md).
