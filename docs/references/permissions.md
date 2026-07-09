# Permisos por defecto del stack

Lo que `pnpm dlx jorgex-stack install` (o `sync`) escribe en la config de cada
runtime cuando el usuario **no** tiene config previa. Si el usuario ya
tiene su propia config, el stack la respeta: no la toca, no la re-impone
y no la migra — ni siquiera si coincide exactamente con el default
anterior. Revisado y aceptado el 2026-07-09 tras el commit
`feat(config): allow external read defaults`, endurecido tras T13/T14
para retirar la auto-migración de legacy exacto y endurecer el default
fresco de OpenCode contra write-anywhere silencioso, y endurecido una
segunda vez tras T17 (`fix(config): harden read permission defaults`)
para ampliar la capa best-effort de denies de secretos (`.ssh`,
`.aws/credentials`, `.npmrc`, `.git-credentials`, `*.pem`, `*.key`,
`id_rsa`, `id_ed25519`) y emitir un aviso en `ctx.warnings` cada vez
que se siembra un default fresco con read-anywhere. Endurecido de nuevo
tras T20 para pasar `Bash`/`Edit`/`Write` de Claude a `ask`, quitar el
allow de `git diff*` en OpenCode y hacer recursiva la deny de `.ssh` en
Codex. Endurecido una vez más para pasar también el egress web
(`WebFetch`/`WebSearch`, `webfetch`/`websearch`) a `ask`.

> Fuente canónica: `stack/config/defaults.json`. Los detalles de la limitación
> posicional del matching de `Bash` en Claude Code viven en
> `docs/references/claude-code-limits.md`.

---

## 1. Dónde vive cada cosa

| Runtime      | Archivo de usuario               | Clave gestionada                                        |
| ------------ | -------------------------------- | ------------------------------------------------------- |
| OpenCode     | `~/.config/opencode/opencode.json` | `permission`                                            |
| Claude Code  | `~/.claude/settings.json`        | `permissions`                                           |
| Codex CLI    | `~/.codex/config.toml`           | `approval_policy` + `default_permissions` + perfil      |

Cada adapter escribe su bloque **solo** en config fresca o vacía (el
archivo de usuario no existe o está vacío). Una config existente — sea
custom o coincidente con el legacy exacto — se preserva tal cual; el
adapter no la toca, no la re-impone y no la migra automáticamente. Una
vez escrita (en la primera instalación), esa sección pasa a ser
**config del usuario**: quitarla o editarla a mano es seguro, y el
próximo `sync` ya no la sobrescribirá porque ya no es "fresca". Esta
es la regla "read-anywhere fresco, escritura externa no silenciosa" del
briefing del repo.

> **"Fresco o vacío" se evalúa sobre el archivo entero, no sobre la
> clave.** `isFreshConfig` significa que `~/.config/opencode/opencode.json`
> / `~/.claude/settings.json` / `~/.codex/config.toml` no existe o está
> vacío. Si ya tienes ese archivo con tus propias claves (mcp, hooks,
> atajos, etc.) y solo borras la sub-clave `permission` / `permissions`
> / las secciones `[permissions.*]`, el archivo **sigue no estando
> fresco**: el adapter respeta tu archivo y no siembra el default. Para
> forzar el default hace falta o bien editar el bloque a mano, o bien
> dejar el archivo ausente/vacío antes del `sync`. Ver §5.

**Aviso en config fresca.** Cuando el adapter siembra el bloque en
instalación fresca, además de escribirlo deja constancia en
`ctx.warnings` (visible al final de `install`/`sync`). Los mensajes son:

- OpenCode → `OpenCode: fresh config enables read-anywhere via
  external_directory:*; edits, web egress and arbitrary bash remain
  approval-gated, but broad local reads can expose secrets not covered
  by deny rules.`
- Claude Code → `Claude Code: fresh config enables read-anywhere via
  Read/Grep/Glob allow rules; shell, writes and web egress remain
  approval-gated, but broad local reads can expose secrets not covered
  by deny rules.`
- Codex → `Codex: fresh config enables read-anywhere via the
  jorgex-read-anywhere permission profile; broad local reads can expose
  secrets not covered by deny rules.`

Estos mensajes **no** aparecen en configs existentes — son parte del
"acto de siembra", no del respeto a la config del usuario.

---

## 2. OpenCode — `permission`

Bloque escrito bajo la clave `permission` **solo en config fresca o vacía**:

```jsonc
{
  "edit": "ask",
  "read": {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
    "*/.ssh/*": "deny",
    "*/.aws/credentials": "deny",
    "*/.npmrc": "deny",
    "*/.git-credentials": "deny",
    "*/id_rsa": "deny",
    "*/id_ed25519": "deny",
    "*.pem": "deny",
    "*.key": "deny"
  },
  "external_directory": { "*": "allow" },
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "lsp": "allow",
  "webfetch": "ask",
  "websearch": "ask",
  "bash": {
    "*": "ask",
    "git diff*": "ask",
    "git log*": "allow",
    "git status*": "allow",
    "rm *": "ask",
    "del *": "ask",
    "rmdir *": "ask",
    "git push --force*": "ask",
    "format *": "deny",
    "mkfs *": "deny",
    "dd *": "deny",
    "shred *": "deny"
  }
}
```

- **`read` como objeto**: `* = allow` quita el prompt para cualquier ruta;
  `*.env` y `*.env.*` niegan secretos locales; `*.env.example` se permite
  como fixture. El resto de denies (`*/.ssh/*`, `*/.aws/credentials`,
  `*/.npmrc`, `*/.git-credentials`, `*/id_rsa`, `*/id_ed25519`,
  `*.pem`, `*.key`) son una capa best-effort sobre los nombres de secretos
  más comunes — ver §6.
- **`external_directory: * = allow`**: rutas fuera del cwd no preguntan
  para lecturas (`read`/`glob`/`grep`). Es la pieza que habilita el
  read-anywhere.
- **`edit: ask`**: ningún edit (interno ni externo) corre sin aprobación
  explícita del usuario. Endurecimiento T14: el default fresco ya no
  concede `edit: allow`.
- **`webfetch` / `websearch`: `ask`**: leer cualquier fichero local y
  llamar a red sin aprobación es una vía de exfiltración. El default fresco
  no auto-aprueba egress web.
- **`bash: { "*": "ask", ... }`**: cualquier comando arbitrario pide
  aprobación. `git diff*` también queda en `ask`, porque `git diff
  --no-index <secreto> <otro>` puede volcar contenido arbitrario a stdout
  y saltarse las denies de `read`. Solo `git log*` y `git status*` van con
  `allow`.

**Por qué `external_directory: * = allow` no implica write-anywhere
silencioso.** `external_directory` aplica a `read`/`glob`/`grep` y a
algunos comandos `bash`, pero los `edit` y el resto de `bash` se rigen
por sus propias claves — que en este default están en `ask`. La
combinación es: leer sin prompt, escribir con prompt. Quien quiera
endurecer más puede bajar `external_directory: *` a `ask` o `deny` a
mano — el stack no lo sobreescribirá después, porque ya no es la clave
de una config fresca/vacía.

**El adapter no migra.** El default viejo era `read: "allow"` (string
plano) y `bash: { "*": "allow", ... }`, sin `external_directory`. Si tu
`opencode.json` ya trae una `permission` (custom o exactamente igual a
ese legacy), el adapter la deja intacta: no la reemplaza, no la expande,
no emite warning. Para subir al nuevo default manualmente, edita a mano
o deja el archivo ausente/vacío antes del `sync` (ver §5).

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
  `git push origin main --force` con `--force` al final. La cobertura real
  para los subagentes full-bash es el hook `PreToolUse`
  `stack/scripts/block-destructive-git.cjs`.

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

La solución correcta es añadir manualmente la entrada que falte — el stack
no va a "rellenar" lo que el usuario haya decidido no declarar.

**El adapter no migra.** El default viejo era `allow` sin
`Read`/`Grep`/`Glob` y `deny` con `Read(./.env*)`. Si tu `settings.json`
ya trae una `permissions` (custom o exactamente igual a ese legacy), el
adapter la deja intacta: no la reemplaza, no la expande, no emite
warning. Para subir al nuevo default manualmente, edita a mano o deja el
archivo ausente/vacío antes del `sync` (ver §5).

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

**`config.toml` existente se preserva tal cual.** Si tu `config.toml`
existe, el adapter no lo modifica. En particular:

- Si ya tienes `default_permissions = "..."` o cualquier sección
  `[permissions.*]` (incluido un `[permissions.custom]` de un proyecto),
  el adapter no añade ni `default_permissions` ni el perfil
  `jorgex-read-anywhere` — interpreta que ya gestionas permisos a tu
  manera y deja tu config aislada.
- Si ya tienes `sandbox_mode = "..."` (`"workspace-write"`,
  `"read-only"`, `"danger-full-access"`, …) con o sin comentario inline,
  el adapter respeta ese valor. **No** se sustituye por el perfil
  `jorgex-read-anywhere` ni se reescribe `default_permissions`.

El matching de `sandbox_mode` es por línea e ignora un `# comentario`
final: `sandbox_mode = "workspace-write" # por qué` se reconoce igual que
la versión sin comentario. Esto es deliberado: una línea de sandbox con
comentario es una línea de sandbox, no un default ausente.

---

## 5. Cómo subirte al nuevo default manualmente

El adapter **nunca** migra una config existente (custom o coincidente
con el legacy exacto). Esto es deliberado: reescribir permisos a espaldas
del usuario sería un bug de seguridad, no una mejora. La regla "config
existente gana" es absoluta y no se atenúa con avisos.

> **Borrar solo la sub-clave NO basta.** `isFreshConfig` se evalúa sobre
> el archivo entero: o el archivo no existe, o está vacío. Si tienes
> `~/.claude/settings.json` con tus propios atajos, hooks o mcp y
> borras solo `permissions`, el archivo sigue sin estar vacío y el
> adapter respeta tu config — no siembra el nuevo default. Lo mismo
> aplica a `permission` en OpenCode y a las secciones `[permissions.*]`
> en Codex: si tu `config.toml` tiene `mcp_servers`, `model`, atajos,
> etc., quitar `[permissions.jorgex-read-anywhere]` deja un archivo
> perfectamente formado, pero no vacío.

Si quieres alinear tu `permission` / `permissions` / `config.toml` al
nuevo default, las opciones son:

1. **Editar a mano.** Compara tu bloque actual con el default canónico
   en `stack/config/defaults.json` y ajusta lo que difiera. El adapter
   no va a sembrar el bloque mientras el archivo exista y no esté vacío.
2. **Dejar el archivo ausente o vacío antes del `sync`.** Esto solo es
   razonable en una migración puntual (no en una sesión de trabajo):
   vacía el archivo (p. ej. redirige `> ~/.claude/settings.json`),
   ejecuta `sync`, restaura lo tuyo desde el backup automático que
   `sync` deja en `~/.jorgex-stack/backups/`. Cada `sync` ya hace
   backup automático de los archivos que toca; `uninstall` también
   restaura desde backup (ver README §Usage).

> Importante: ninguna de las dos opciones se ofrece como flujo
> automático (`jorgex-stack upgrade`, etc.). La decisión de
> sobrescribir tu config la tomas tú, de forma explícita.

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
  nombre. Las denies de `Bash` (Claude) además son posicionales (ver §3);
  las denies de `Read` (Claude) y los globs de filesystem (Codex y
  OpenCode `*/…`) usan patrones tipo gitignore con un segmento (`*`) o
  recursivo (`**`). Nombres no anticipados (`prod.env`, `secrets.json`,
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
  permitida por diseño. Las capas que mitigan el daño son los prompts para
  egress web/shell/escritura, los hooks/bloqueos de `Bash` destructivo, el
  sandbox de Codex y la rama protegida de GitHub.
- **Secretos fuera del filesystem.** Variables de entorno con secrets
  pueden terminar en respuestas del modelo si una shell las expande dentro
  de un comando `Bash` aprobado por el usuario (p. ej.
  `echo $OPENAI_API_KEY`).
- **Las denies se siembran una vez, en config fresca.** Si el adapter
  escribió tu `permission` / `permissions` / perfil de Codex en la
  primera instalación, esa sección ya es tuya: una edición tuya no
  provoca un re-seed ni un warning. Lo mismo en sentido contrario: si
  el día de mañana se añaden denies mejores al default, tu config ya
  no se actualizará sola (ver §5).

Las denies **reducen** la exposición accidental; **no la eliminan**. Trata
read-anywhere como "más cómodo, menos fricción", no como "modelo aislado".
Para secretos críticos (claves SSH, tokens de prod) sigue siendo buena
práctica no tenerlos en el filesystem en rutas predecibles, o dejarlos en
rutas no legibles por tu usuario.
