# Permisos por defecto del stack

Esta referencia describe los defaults que `pnpm dlx jorgex-stack install` (o
`pnpm cli install` desde un clon de desarrollo) siembra en una configuración
fresca o vacía. `sync` ya no es un comando público; `install` reconcilia el
canon internamente. La política común es semántica: el trabajo ordinario se
permite, las operaciones legítimas pero sensible o irreversibles piden
aprobación, y los secretos y la destrucción evidente se deniegan. En OpenCode
v2 fresco el array nativo no tiene regla global ni `ask` para git/shell
ordinarios; lo que el array no declara se queda al default del host v2 (no se
afirma que ese default sea universal `allow` para todas las herramientas: el
runtime del host decide qué hace con cada `action` no listada, y el array
puede convivir con reglas destructivas del propio host). En Claude Code y
Codex, lo no listado sigue pidiendo aprobación.

La regla fresh-only sigue siendo el default: una configuración existente
se conserva completa y el stack no reimpone ni migra sus permisos solo. La
única excepción es el opt-in explícito `install
--upgrade-permissions`, que reemplaza el bloque gestionado entero cuando
difiere del default, con backup automático previo en instalaciones reales. Sin ese flag, una config
existente que difiera solo avisa (warn-only-by-default); una config al día
queda en silencio.

> Fuente canónica: `stack/config/defaults.json`. Los detalles de la limitación
> posicional del matching de `Bash` en Claude Code viven en
> `docs/references/claude-code-limits.md`.

---

## 1. Dónde vive cada cosa

| Runtime      | Archivo de usuario               | Clave gestionada                                        |
| ------------ | -------------------------------- | ------------------------------------------------------- |
| OpenCode v2  | `~/.config/opencode/opencode.json` o `opencode.jsonc` (raíz efectiva: `OPENCODE_CONFIG_DIR` si está definido, si no `$XDG_CONFIG_HOME/opencode` o HOME) | `permissions` (server) y `session.verbosity` en `cli.json` |
| Claude Code  | `~/.claude/settings.json`        | `permissions`                                           |
| Codex CLI    | `~/.codex/config.toml`           | `approval_policy` + `default_permissions` + perfil      |

Pi mantiene una política separada en `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`, con receipt en `PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json` y backups en `PI_CODING_AGENT_DIR/jorgex-pi/permissions-backups`. Pi solo posee la copia de configuración que creó y cuyo ownership registra en su receipt y backups; una configuración ajena no pasa a ser propiedad de Pi y Stack nunca la reclama. Por defecto Stack es solo-diagnóstico con Pi: `install` siembra solo si la configuración está ausente (seed-only) y nunca reescribe, retira ni reimpone su estado. Con `install --upgrade-permissions`, Stack reenvía el flag al comando `upgrade` del paquete Pi, pero solo si el candidato adoptado anuncia la capability `permissions-upgrade-v1`; sin esa capability se continúa en modo seed-only. El `upgrade` del paquete reemplaza únicamente la copia gestionada receipt-owned que difiera del default, con backup previo, y siembra si está ausente; una configuración ajena, inválida o editada por el usuario se conserva (la edición libera ownership) y nunca se fusiona ni repara. Una política existente sin receipt se conserva y `doctor` la marca como aviso (warn-only); un JSON legible pero inválido o un estado ilegible se conserva y `doctor` lo marca como error. `cleanup` solo retira una copia exacta que el receipt identifique como creada por Pi. Ante contención (el runner devuelve salida 1 con `CONFIG_LOCKED`), Stack reintenta el `upgrade` hasta dos veces y luego falla de forma visible; ninguna otra señal se reintenta. Tras liberar ownership (edición del usuario o fichero owned ausente, sin resembrado), el siguiente `upgrade` es no-op (`changed: false` sin acciones).

Cada adapter siembra su bloque en config fresca o vacía (el archivo de
usuario no existe o está vacío). Una config existente — sea custom o
coincidente con el legacy exacto — se preserva byte a byte por defecto;
el adapter no la toca sin el opt-in. Una vez escrita (en la primera
instalación), esa sección pasa a ser **config del usuario**: quitarla o
editarla a mano es seguro, y el próximo `install` sin
`--upgrade-permissions` no la sobrescribirá porque ya no es "fresca".
Esta es la regla fresh-only: el default se siembra en un archivo fresco
y las decisiones posteriores quedan bajo control del usuario, salvo el
opt-in explícito del §5.

> **"Fresco o vacío" se evalúa sobre el archivo entero, no sobre la
> clave.** `isFreshConfig` significa que `~/.config/opencode/opencode.json`
> / `~/.claude/settings.json` / `~/.codex/config.toml` no existe o está
> vacío. Si ya tienes ese archivo con tus propias claves (mcp, hooks,
> atajos, etc.) y solo borras la sub-clave `permission` / `permissions`
> / las secciones `[permissions.*]`, el archivo **sigue no estando
> fresco**: el adapter respeta tu archivo y no siembra el default. Para
> alinear el bloque con el default, edita a mano o usa
> `--upgrade-permissions` (ver §5); vaciar el archivo entero antes del
> Vaciar el archivo entero antes de `install` sigue siendo una migración puntual válida pero ya no es la vía
> recomendada.

**Aviso en config fresca.** Cuando el adapter siembra el bloque en
instalación fresca, además de escribirlo deja constancia en
`ctx.warnings` (visible al final de `install`). Los mensajes son:

- OpenCode v2 → `OpenCode v2: fresh permissions allow ordinary reads, edits
  and external_directory; bash inherits the host default and protected
  paths (secrets, sensitive keys) are denied on read/edit. Native
  matching is not a universal filesystem sandbox.`
- Claude Code → `Claude Code: fresh config enables read-anywhere via
  Read/Grep/Glob allow rules; shell, writes and web egress remain
  approval-gated, but broad local reads can expose secrets not covered
  by deny rules.`
- Codex → `Codex: fresh config enables read-anywhere via the
  jorgex-read-anywhere permission profile; broad local reads can expose
  secrets not covered by deny rules.`

Los mensajes de siembra **no** aparecen en configs existentes. En una
config existente cuyo bloque difiera del default canónico, el adapter en
cambio emite un aviso stale (uno por runtime, solo-si-difiere, sin
volcar el contenido del bloque):

- OpenCode v2 → `OpenCode: permissions block differs from the stack
  default and was left untouched; re-run with --upgrade-permissions to
  replace it (a backup is created first), or edit it by hand.`
- Claude Code → `Claude Code: permissions block differs from the stack
  default and was left untouched; re-run with --upgrade-permissions to
  replace it (a backup is created first), or edit it by hand.`
- Codex → `Codex: permission profile differs from the stack default and
  was left untouched; re-run with --upgrade-permissions to replace it (a
  backup is created first), or edit it by hand.`

Una config existente ya al día no emite ningún aviso de permisos. Con
`--upgrade-permissions`, el bloque que difiera se reemplaza entero por
el canon (OpenCode v2: clave `permissions`; Claude Code: clave
`permissions` vía el hooks-path, nunca vía main-config; Codex: claves
root `approval_policy` + `default_permissions` y secciones del perfil,
dejando intactos `sandbox_mode`, `model`, MCP y secciones ajenas),
preservando el resto del archivo; en instalaciones reales el pipeline crea
el backup automático antes de escribir (`restore --list` / `restore <id>`
para revertir). En `--dry-run` no se escribe nada ni se crean backups. `doctor` reemite el
mismo aviso stale sin volcar el bloque y con el remedio exacto:
`jorgex-stack install --upgrade-permissions --dry-run` para previsualizar.

---

## 2. OpenCode v2 — `permissions`

Bloque canónico escrito bajo la clave `permissions` **solo en config fresca
o vacía** del server config (`opencode.json` o, si solo existe ese archivo,
`opencode.jsonc`); si ambos coexisten el archivo efectivo es ambiguo y se
falla cerrado. El server config vive en la raíz efectiva del host:
`OPENCODE_CONFIG_DIR` si está definido, si no `$XDG_CONFIG_HOME/opencode` o
el default de HOME según la fuente oficial v2. El JSON reconoce JSONC
(comentarios y comas finales) y se edita con upsert quirúrgico: comentarios
y claves ajenas se conservan. El archivo compacto `cli.json` vive junto al
server config y siembra `session.verbosity: "low"` solo si falta, como
ajuste de presentación del TUI, no de modelo.

El overlay v2 es un array ordenado de tuplas `action/resource/effect`. Sin
regla global ni asks para git/shell ordinarios; `external_directory` se
permite, los denies de secretos se aplican solo a `read`/`edit` y
`*.env.example` se re-permite al final para ganar la última coincidencia.
El canon compartido en `stack/config/defaults.json` conserva el bloque
`opencode.permission` legacy de v1, que el adapter OpenCode v2 usa solo
para reconocer configs v1 exactas (migración owned) y como referencia
del bloque `permissions` que ya no se reescribe por defecto. OpenCode v2
proyecta su array nativo desde el adapter (`src/adapters/opencode.ts`),
no desde `defaults.json`. Ejemplo canónico:

```jsonc
{
  "permissions": [
    { "action": "external_directory", "resource": "*", "effect": "allow" },
    { "action": "read", "resource": "*.env", "effect": "deny" },
    { "action": "read", "resource": "*.env.*", "effect": "deny" },
    { "action": "read", "resource": "*.ssh/*", "effect": "deny" },
    { "action": "read", "resource": "*.aws/credentials", "effect": "deny" },
    { "action": "read", "resource": "*.npmrc", "effect": "deny" },
    { "action": "read", "resource": "*.git-credentials", "effect": "deny" },
    { "action": "read", "resource": "*id_rsa*", "effect": "deny" },
    { "action": "read", "resource": "*id_ed25519*", "effect": "deny" },
    { "action": "read", "resource": "*.pem", "effect": "deny" },
    { "action": "read", "resource": "*.key", "effect": "deny" },
    { "action": "read", "resource": "*.env.example", "effect": "allow" },
    { "action": "edit", "resource": "*.env", "effect": "deny" },
    { "action": "edit", "resource": "*.env.*", "effect": "deny" },
    { "action": "edit", "resource": "*.ssh/*", "effect": "deny" },
    { "action": "edit", "resource": "*.aws/credentials", "effect": "deny" },
    { "action": "edit", "resource": "*.npmrc", "effect": "deny" },
    { "action": "edit", "resource": "*.git-credentials", "effect": "deny" },
    { "action": "edit", "resource": "*id_rsa*", "effect": "deny" },
    { "action": "edit", "resource": "*id_ed25519*", "effect": "deny" },
    { "action": "edit", "resource": "*.pem", "effect": "deny" },
    { "action": "edit", "resource": "*.key", "effect": "deny" },
    { "action": "edit", "resource": "*.env.example", "effect": "allow" }
  ]
}
```

- **Sin regla global `"*"`**: no hay fallback a `ask`. Las herramientas o
  formas sin regla específica se quedan al default del host v2 (no se
  afirma que ese default sea universal `allow` para todas las
  herramientas). El array nativo v2 no importa asks de otros runtimes
  ni reescribe reglas que ya estén declaradas; los patrones
  `secret-pattern` y los `ask` que el propio host aplique fuera del
  array se mantienen intactos y siguen decidiendo el comportamiento
  real del matching nativo.
- **Trabajo ordinario**: `read`, `edit`, `external_directory` y todas las
  herramientas sin entrada explícita quedan en `allow`. `git commit` y
  `git push` (incluido `--force`) también quedan permitidos por ausencia
  de deny: no hay gate humano para el git cotidiano en el canon v2.
- **`read` y `edit` con deny de secretos**: el array deniega `*.env`,
  `*.env.*`, `*.ssh/*`, `*.aws/credentials`, `*.npmrc`,
  `*.git-credentials`, `*id_rsa*`, `*id_ed25519*`, `*.pem` y `*.key`
  (capa best-effort sobre los nombres comunes — ver §6).
  `*.env.example` se re-permite al final del array para ganar la última
  coincidencia y servir como fixture.
- **Los denies de secretos viven SOLO en `read` y `edit`**: el array v2
  no añade denies sobre bash ni sobre filesystem completos. Un `cat .env`
  por shell queda en `allow` por diseño; la red es read/edit, no un
  sandbox del filesystem — ver §6.
- **`external_directory: * = allow`**: las lecturas y búsquedas fuera del
  cwd se permiten; la escritura sigue las reglas de `edit` y el matching
  nativo de la herramienta.
- **Sin reglas para herramientas anti-bucle**: el array v2 no declara
  control sobre `doom_loop` ni equivalentes; el comportamiento ante
  bucles no lo define Stack y queda al arbitrio del runtime del host
  (no se arrastran claims v1 que el código fuente no acredita).

**MCP: sin allowlist, todo cae al nativo.** En la configuración fresca no hay
claves `engram_*`, `context7_*` ni de ningún otro servidor: cualquier
herramienta MCP (Engram, Context7, chrome-devtools, futuros) funciona sin
prompts por herramienta porque lo no listado usa el default nativo
(`allow`). Stack no filtra las herramientas del provider oficial de Engram; no
hay nada que mantener cuando aparece un servidor nuevo.

**Por qué las reglas específicas importan.** OpenCode evalúa sus reglas de
matching según la semántica nativa del runtime; sin regla global, cada
`ask` o `deny` específico expresa una excepción deliberada sobre el
default nativo. La política no es un sandbox universal del sistema de
   archivos. Quien quiera endurecerla puede editarla a mano; sin
   `--upgrade-permissions` el stack no sobrescribirá esa decisión.

**Reconocimiento de capabilities.** El informe local de capabilities
(namespace `jorgex.quality.capabilities`, ver
[quality-receipt.md](quality-receipt.md)) trata los permisos v2 canónicos
como `tool-approval: unavailable`, con una razón que reconoce la política
aprobada (sin gate humano por diseño) y no un estado `manual`. El adapter
devuelve `manual` solo cuando reconoce declaraciones explícitas de
aprobación pendientes. Configuraciones ajenas, modificadas o ilegibles
conservan una razón distinta y conservadora.

**El adapter no migra solo.** El default anterior era la matriz v1 con
clave `permission` (`"*": "ask"` global, `ask` para intérpretes,
`pnpm exec/dlx`, decenas de formas git, denies de secretos y rutas de
sistema en `bash`, allowlist histórica `engram_*`/`context7_*`). Si tu
`opencode.json` o `opencode.jsonc` ya trae un `permission` o `permissions`
(custom o coincidente con el legacy exacto), el adapter la deja intacta
por defecto y emite el aviso stale (solo-si-difiere, sin volcar el
bloque). Para subir al nuevo default, edita a mano o usa `sync
--upgrade-permissions` (ver §5). Una migración automática desde el canon
v1 solo aplica cuando la propiedad exacta coincide y el canon actual v2
puede acreditar el reemplazo sin pisar configuración ajena; cualquier
estado ambiguo de campos se preserva con backup y se bloquea con
remedio.

Para los recursos estáticos gestionados (plugins/scripts), la regla de
identidad física reemplaza el camino conservador previo. La tabla única
de owned/unowned × current/legacy/unknown × install/update/uninstall,
las garantías del generador y las limitaciones explícitas viven en
[opencode-static-resources.md](opencode-static-resources.md); aquí no
se duplican. La fila "current" se deriva de los bytes que la proyección
va a escribir (helper `projectedBytesByTarget(actions)`), no del JSON
canónico congelado; el JSON acredita el canon legacy v1 publicado. El
índice se regenera solo con `python3 scripts/regenerate-opencode-static-resources.py`
desde un clon git (herramienta de mantenimiento, nunca parte de
`install`/`sync`/`doctor`/`uninstall`).

---

## 3. Claude Code — `permissions`

Bloque escrito bajo la clave `permissions` **solo en config fresca o vacía**:

```jsonc
{
  "allow": ["Read", "Grep", "Glob"],
  "ask":  ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(git push --force:*)"],
  "deny": [
    "Bash(format:*)", "Bash(mkfs:*)", "Bash(dd:*)", "Bash(shred:*)",
    "Read(//**/.env)", "Read(//**/.env.*)",
    "Read(//**/.ssh/**)", "Read(//**/.aws/credentials)",
    "Read(//**/.npmrc)", "Read(//**/.git-credentials)",
    "Read(//**/id_rsa)", "Read(//**/id_ed25519)",
    "Read(//**/*.pem)", "Read(//**/*.key)"
  ]
}
```

- **`Read` / `Grep` / `Glob` allow**: quitan los prompts de cada
  búsqueda/listado. `Bash`, `Edit`, `Write`, `WebFetch` y `WebSearch`
  pasan a `ask`: sin eso, Claude no estaría en postura read-anywhere sino
  en shell/write-anywhere con egress web. Las reglas
  `Read(...)` cubren best-effort el contenido que `Grep` y `Glob` acaban
  mostrando, pero no sustituyen la aprobación de shell.
- **Denies `Read(//**/.env)` y `Read(//**/.env.*)`**: sintaxis POSIX
  absoluta (`//**/` es la raíz virtual de Claude Code en Windows; casa a
  través de discos, no solo del cwd). El default viejo usaba patrones
  relativos al cwd (`Read(./.env)` / `Read(./.env.*)`), que no cubrían
  rutas absolutas. Las denies adicionales (`.ssh`, `.aws/credentials`,
  `.npmrc`, `.git-credentials`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`)
  son la capa best-effort complementaria — ver §6.
- **`Bash(git push --force:*)` sigue siendo `ask` y sigue siendo
  posicional**. Ver `docs/references/claude-code-limits.md` §1: no captura
  `git push origin main --force` con `--force` al final. Esos casos caen en
  el `ask` genérico de `Bash`, que sí los cubre como pregunta. Desde la
  decisión #153 (2026-09-17) los subagentes full-bash ya no llevan el hook
  `PreToolUse` de bloqueo: el git destructivo pide aprobación explícita en
  vez de bloquearse, con el prompt del subagente como refuerzo ("ask
  before destructive git").

**Restricción de matching — distinta por herramienta.**
- Las reglas de `Bash` casan por **prefijo posicional**
  (`Bash(<prefijo>:*)`): solo capturan lo que empieza por ese prefijo.
  `--force` al final de un comando escapa a `Bash(git push --force:*)`.
  Ver `docs/references/claude-code-limits.md` §1.
- Las reglas de `Read` (y de los file-globs en general) usan patrones
  tipo gitignore con `*` (un segmento) y `**` (recursivo), según la doc
  oficial. `Read(//**/.env.*)` casa cualquier ruta que termine en
  `.env.<algo>` (p. ej. `.env.local`, `.env.production`, `.env.local.bak`),
  pero **no** nombres sin esa forma (`prod.env`, `secrets.json`, `id_rsa`,
  `.envrc`).

La solución correcta es añadir manualmente la entrada que falte — sin
`--upgrade-permissions` el stack no va a "rellenar" lo que el usuario
haya decidido no declarar (con el flag se reemplaza el bloque entero,
no se fusionan entradas sueltas).

**El adapter no migra solo.** El default viejo era `allow` sin
`Read`/`Grep`/`Glob` y `deny` con `Read(./.env*)`. Si tu `settings.json`
ya trae una `permissions` (custom o exactamente igual a ese legacy), el
adapter la deja intacta por defecto y emite el aviso stale
(solo-si-difiere, sin volcar el bloque). Para subir al nuevo default,
edita a mano o usa `install --upgrade-permissions` (ver §5).

---

## 4. Codex CLI — permission profile `jorgex-read-anywhere`

Codex no usa `permissions` top-level para esto: usa **permission profiles**
(beta). El adapter escribe el siguiente bloque **solo en `config.toml`
fresco o vacío** (archivo ausente o vacío):

```toml
approval_policy = "on-request"
default_permissions = "jorgex-read-anywhere"

[permissions.jorgex-read-anywhere]
extends = ":workspace"

[permissions.jorgex-read-anywhere.filesystem]
":root" = "read"
"*.env" = "deny"
"*.env.*" = "deny"
"~/.ssh/**" = "deny"
"~/.aws/credentials" = "deny"
"~/.npmrc" = "deny"
"~/.git-credentials" = "deny"
"**/id_rsa" = "deny"
"**/id_ed25519" = "deny"
"**/*.pem" = "deny"
"**/*.key" = "deny"

[permissions.jorgex-read-anywhere.filesystem.":workspace_roots"]
"." = "write"
"*.env" = "deny"
"*.env.*" = "deny"
".ssh/**" = "deny"
".aws/credentials" = "deny"
".npmrc" = "deny"
".git-credentials" = "deny"
"**/id_rsa" = "deny"
"**/id_ed25519" = "deny"
"**/*.pem" = "deny"
"**/*.key" = "deny"
```

- **`":root" = "read"`**: filesystem completo legible (el "read-anywhere").
- **`":workspace_roots" = "write"`**: el workspace sigue escribible.
- **Denies `.env*`, `.ssh/**`, `.aws/credentials`, `.npmrc`, `.git-credentials`,
  `id_rsa`, `id_ed25519`, `*.pem`, `*.key`** en `":root"` y en
  `":workspace_roots"`: secretos bloqueados en ambos puntos. Las denies
  son la capa best-effort complementaria — ver §6.

**Limitación — los profiles no se mezclan con `sandbox_mode`.** La doc de
Codex indica que un perfil de permisos y `sandbox_mode` no componen: si
defines ambos, uno gana de forma no especificada. Por eso el adapter, en
instalación fresca, escribe `default_permissions` + perfil y **no**
escribe `sandbox_mode` (lo deja ausente, que es el comportamiento neutro
de Codex).

**`config.toml` existente se preserva por defecto.** Si tu `config.toml`
existe y el bloque gestionado difiere del canon, el adapter no lo
modifica sin el opt-in y emite el aviso stale (solo-si-difiere, sin
volcar el bloque). Con `--upgrade-permissions` reemplaza entero el
bloque gestionado (claves root del perfil + secciones
`[permissions.*]` del perfil) y deja intactos `sandbox_mode`, `model`,
MCP y secciones ajenas. En particular:

- Si ya tienes `default_permissions = "..."` o cualquier sección
  `[permissions.*]` (incluido un `[permissions.custom]` de un proyecto),
  el adapter sin flag no añade ni `default_permissions` ni el perfil
  `jorgex-read-anywhere` — interpreta que ya gestionas permisos a tu
  manera y deja tu config aislada (avisando solo-si-difiere).
- Si ya tienes `sandbox_mode = "..."` (`"workspace-write"`,
  `"read-only"`, `"danger-full-access"`, …) con o sin comentario inline,
  el adapter respeta ese valor incluso con el flag. **No** se sustituye
  por el perfil `jorgex-read-anywhere` ni se reescribe `sandbox_mode`.

El matching de `sandbox_mode` es por línea e ignora un `# comentario`
final: `sandbox_mode = "workspace-write" # por qué` se reconoce igual que
la versión sin comentario. Esto es deliberado: una línea de sandbox con
comentario es una línea de sandbox, no un default ausente.

---

## 5. Cómo subirte al nuevo default

El adapter **nunca** migra una config existente por sí solo (custom o
coincidente con el legacy exacto). Esto es deliberado: reescribir
permisos a espaldas del usuario sería un bug de seguridad, no una
mejora. La regla fresh-only es el default y solo se atenúa con tu
opt-in explícito: sin flag la config existente que difiera se preserva
y solo avisa; con flag se reemplaza el bloque entero.

> **Borrar solo la sub-clave NO basta para el sembrado fresco.**
> `isFreshConfig` se evalúa sobre el archivo entero: o el archivo no
> existe, o está vacío. Si tienes `~/.claude/settings.json` con tus
> propios atajos, hooks o mcp y borras solo `permissions`, el archivo
> sigue sin estar vacío y el adapter respeta tu config — no siembra el
> nuevo default. Lo mismo aplica a `permissions` en OpenCode v2 y a las
> secciones `[permissions.*]` en Codex: si tu `config.toml` tiene
> `mcp_servers`, `model`, atajos, etc., quitar
> `[permissions.jorgex-read-anywhere]` deja un archivo perfectamente
> formado, pero no vacío. Para ese caso usa la opción 2.

Si quieres alinear tu `permission` / `permissions` / `config.toml` al
nuevo default, las opciones son:

1. **Editar a mano.** Compara tu bloque actual con el default canónico
   en `stack/config/defaults.json` y ajusta lo que difiera. El adapter
   no va a sembrar el bloque mientras el archivo exista y no esté vacío.
2. **`install --upgrade-permissions` (opt-in explícito, vía
   recomendada).** Reemplaza entero cualquier bloque gestionado que
   difiera del canon, preservando el resto del archivo (claves ajenas en
   OpenCode/Claude; `sandbox_mode`, `model`, MCP y secciones ajenas en
   Codex). En instalaciones reales el pipeline crea el backup automático
   antes de escribir; revísalo con `restore --list` y revierte con
   `restore <id>` si hace falta. El aviso stale nunca vuelca el contenido
   del bloque. Para previsualizar sin escribir: `jorgex-stack install
   --upgrade-permissions --dry-run` (no escribe ni crea backups). `doctor`
   apunta a ese mismo comando cuando detecta el bloque stale.
3. **Dejar el archivo ausente o vacío antes del `install`.** Esto solo es
   razonable en una migración puntual (no en una sesión de trabajo):
   vacía el archivo (p. ej. redirige `> ~/.claude/settings.json`),
   ejecuta `install`, restaura lo tuyo desde el backup automático que
   `install` deja en `~/.jorgex-stack/backups/`. Cada `install` real ya hace
   backup automático de los archivos que toca; `uninstall` también
   restaura desde backup (ver README §Usage). Excepción: las corridas
   aisladas con `--target-dir` escriben sin manifest ni backup por diseño
   preexistente, no como regresión.

> Importante: fuera de la opción 2 no hay otro flujo automático
> (`jorgex-stack upgrade`, etc.). La decisión de sobrescribir tu config
> la tomas tú, de forma explícita.

---

## 6. Nota de seguridad — lo que las denies NO hacen

"Read-anywhere" significa que el modelo **puede ver cualquier archivo del
disco al que tu usuario tenga acceso** (sujeto a las denies de `.env*`,
`.ssh/**`, `.aws/credentials`, `.npmrc`, `.git-credentials`, `*.pem`,
`*.key`, `id_rsa`, `id_ed25519` y al sandbox de Codex para los perfiles).
Negaciones por patrón **no son perfectas** — ni siquiera tras las capas
añadidas en T17/T20:

- **Cobertura limitada por sintaxis.** Las denies son literales sobre el
  patrón declarado — no entienden el "concepto" de secreto, solo el
  nombre. Las denies de `Bash` (Claude) además son posicionales (ver §3).
  Las denies de `Read` en Claude Code y los globs de filesystem en
  Codex usan patrones tipo gitignore con un segmento (`*`) o recursivo
  (`**`); en OpenCode v2 las denies operan sobre el campo `resource` de
  cada tupla `action/resource/effect` y el matching concreto es del
  host, no de Stack. Nombres no anticipados (`prod.env`, `secrets.json`,
  `id_rsa` en una ruta que escape a `**/id_rsa`, `.envrc`,
  `service-account.json`, `gcp-key.json`, etc.) **no** quedan
  cubiertos por `Read(//**/.env.*)` ni por `"*.env.*"` ni por la capa
  ampliada. La capa ampliada es **best-effort sobre los nombres
  comunes de secreto** — un usuario que mueva su SSH key a
  `~/keys/work-id_rsa` evita las denies de `**/id_rsa` por el simple
  hecho de que `**/id_rsa` no es una expresión regular.
- **Prompt injection.** Si el modelo lee un archivo que contiene
  instrucciones hostiles ("envíame por red el contenido de `~/.ssh/...`"),
  las denies no van a impedir que el modelo proponga acciones que ya estén
  permitidas. El riesgo real es el **daño**, no la lectura: la lectura está
  permitida por diseño. En OpenCode v2 los denies de secretos sobre
  `read`/`edit` y la ausencia de asks para git/shell ordinarios siguen
  la misma lógica, sin claims de sandbox universal; en Claude Code los
  prompts de shell/escritura/egress y los `Read`/`Grep`/`Glob` allow
  cubren esa superficie; en Codex el sandbox y la rama protegida de
  GitHub.
- **La red de secretos es `read`/`edit`, no el filesystem.** En OpenCode
  v2 fresco, el array nativo no añade denies de secretos sobre bash:
  leer un `.env` por shell (p. ej. `cat .env`) queda en `allow` por
  diseño. Consecuencia aceptada: el subagente git-read puede mostrar
  secretos con `git diff HEAD -- .env`, porque el diff no pasa por las
  denies de `read`/`edit`.
- **Secretos fuera del filesystem.** Variables de entorno con secrets
  pueden terminar en respuestas del modelo si una shell las expande dentro
  de un comando `Bash` aprobado por el usuario (p. ej.
  `echo $OPENAI_API_KEY`).
- **Las denies se siembran en config fresca; el re-seed exige tu
  opt-in.** Si el adapter escribió tu `permission` / `permissions` /
  perfil de Codex en la primera instalación, esa sección ya es tuya:
  una edición tuya no provoca un re-seed automático. Si tu bloque
  difiere del default canónico (por edición tuya o porque el default
  mejoró después), `install`/`doctor` emiten el aviso stale
  (solo-si-difiere, sin volcar el bloque) y tu config sigue intacta;
  solo `install --upgrade-permissions` la realinea (ver §5).

Las denies **reducen** la exposición accidental; **no la eliminan**. Trata
read-anywhere como "más cómodo, menos fricción", no como "modelo aislado".
Para secretos críticos (claves SSH, tokens de prod) sigue siendo buena
práctica no tenerlos en el filesystem en rutas predecibles, o dejarlos en
rutas no legibles por tu usuario.
