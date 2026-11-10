# Compatibilidad con skills.sh

`skills.sh` es la CLI (y el catálogo) de skills individuales de [skills.sh](https://skills.sh). Stack publica en su propio repositorio el archivo `skills.sh.json` para que la página del repositorio agrupe las veintiuna skills por categoría y la ruta de búsqueda quede explícita, sin crear un segundo repositorio ni un canal de instalación propio.

## Hechos verificados

Comprobados el 10-nov-2026 con `skills@1.8.0`, HOME aislado, sin telemetría y contra un clon local del repositorio:

- `skills add <repo> --list` encuentra las **21 skills** en `stack/skills/<categoría>/<skill>` por su búsqueda recursiva, sin configuración.
- El esquema oficial (`https://skills.sh/schemas/skills.sh.schema.json`) admite en `skills.sh.json`:
  - `paths`: carpetas contenedoras dentro del repositorio, con prefijo `./`.
  - `groupings`: `title`, `description` opcional y `skills` (nombres).
  - `notGrouped`: `top` o `bottom`.
  - Se exige al menos `groupings` o `paths`; `additionalProperties: false`.
- Comportamiento de la CLI (documentación del paquete, no del esquema): busca en las carpetas de `paths` hasta tres niveles y, si dos skills comparten nombre, solo conserva la primera.
- Sin `-g`, la CLI instala en el proyecto actual, no en el HOME.
- No existe instalar por categoría: la CLI instala el repositorio entero o skills sueltas con `--skill`.

## Solapamiento con una instalación de Stack

Los dos canales **no deben mezclarse sobre las mismas skills**. Comprobado con una instalación de Stack simulada (copia en `~/.agents/skills/orchestrator` con una edición local y, para Claude, un enlace simbólico en `~/.claude/skills`):

- `skills add -g -a codex -s orchestrator -y` (agente que lee `~/.agents/skills`) **sobrescribió** la copia de Stack sin avisar; la edición local desapareció. La CLI registra la skill en `~/.agents/.skill-lock.json`.
- `skills add -g -a claude-code -s orchestrator -y` **sustituyó el enlace simbólico de Stack por un directorio copiado** en `~/.claude/skills/orchestrator` ("overwrites: Claude Code") y no tocó `~/.agents/skills`.

### Inferencia por lectura del código (no ejecutada)

- Copia compartida: el directorio sigue siendo propiedad de Stack, así que su Actualizar vuelve a copiar el canon encima (con backup) y revierte lo que instaló la CLI; la CLI haría lo mismo en sentido contrario y su registro quedaría desfasado.
- Enlace de Claude: si Stack lo tiene registrado como propio y ya no es un enlace a su destino, `planSkills` lanza `Enlace de skill gestionado en conflicto` y falla la proyección de ese runtime hasta retirar el directorio. Si no lo tuviera registrado, solo avisaría «Se conserva enlace/directorio ajeno». La simulación no comprobó cuál de los dos casos se daba.

Quien instala Stack no debería volver a instalar las mismas skills con la CLI. Al revés, si ya hay skills de la CLI, Instalar de Stack conserva las ajenas y avisa, que es el comportamiento existente.

## Decisiones

- **Mismo repositorio.** `skills.sh.json` vive en la raíz y apunta a `./stack/skills`: no hay espejo, copia de skills ni repositorio paralelo que mantener.
- **Stack no escribe en el registro de la CLI.** `~/.agents/.skill-lock.json` pertenece a `skills.sh`; Stack no lo lee, no lo modifica y no lo usa para decidir propiedad.
- **Sin instalar ni mantener skills ajenas.** Stack conserva las que ya existan y avisa; no las adopta ni las actualiza.
- **La vía de skills.sh es parcial.** Instala carpetas de skills, no el system prompt, Engram, los hooks, la configuración MCP ni los archivos por runtime. Varias skills asumen ese contexto.

## Límite conocido

Que los grupos aparezcan en la web de skills.sh depende de la telemetría de la CLI al ejecutarse contra GitHub. Este repositorio solo garantiza que el archivo describe las carpetas reales; no se promete que la lista pública se vea antes de que alguien ejecute la CLI.

Esa correspondencia la protege `tests/skills-sh.test.ts`: cada skill de `stack/skills/<categoría>/` aparece exactamente en el grupo de su categoría, no hay nombres inexistentes y `paths` apunta a una carpeta existente.
