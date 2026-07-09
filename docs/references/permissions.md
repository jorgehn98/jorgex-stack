# Permisos por defecto del stack

Lo que `pnpm dlx jorgex-stack install` (o `sync`) escribe en la config de cada
runtime cuando el usuario **no** tiene config previa. Si el usuario ya
tiene su propia config, el stack la respeta: no la toca, no la re-impone
y no la migra — ni siquiera si coincide exactamente con el default
anterior. Revisado y aceptado el 2026-07-09 tras el commit
`feat(config): allow external read defaults`, endurecido tras T13/T14
para retirar la auto-migración de legacy exacto y endurecer el default
fresco de OpenCode contra write-anywhere silencioso.

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
es la regla "read-anywhere fresco, writes approval-gated" del briefing
del repo.

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
    "*.env.example": "allow"
  },
  "external_directory": { "*": "allow" },
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "lsp": "allow",
  "webfetch": "allow",
  "websearch": "allow",
  "bash": {
    "*": "ask",
    "git diff*": "allow",
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
  como fixture.
- **`external_directory: * = allow`**: rutas fuera del cwd no preguntan
  para lecturas (`read`/`glob`/`grep`). Es la pieza que habilita el
  read-anywhere.
- **`edit: ask`**: ningún edit (interno ni externo) corre sin aprobación
  explícita del usuario. Endurecimiento T14: el default fresco ya no
  concede `edit: allow`.
- **`bash: { "*": "ask", ... }`**: cualquier comando arbitrario pide
  aprobación. Solo los sub-comandos de **lectura** explícitamente
  inocuos van con `allow`: `git diff*`, `git log*`, `git status*`. El
  resto de comandos peligrosos sigue con `ask`/`deny` como en el
  default anterior.

**Por qué `external_directory: * = allow` no implica write-anywhere
silencioso.** `external_directory` aplica a `read`/`glob`/`grep` y a
algunos comandos `bash`, pero los `edit` y el resto de `bash` se rigen
por sus propias claves — que en este default están en `ask`. La
combinación es: leer sin prompt, escribir con prompt. Quien quiera
endurecer más puede bajar `external_directory: *` a `ask` o `deny` a
mano — el stack no lo sobreescribirá después, porque ya no es la clave
ausente.

**El adapter no migra.** El default viejo era `read: "allow"` (string
plano) y `bash: { "*": "allow", ... }`, sin `external_directory`. Si tu
`opencode.json` ya trae una `permission` (custom o exactamente igual a
ese legacy), el adapter la deja intacta: no la reemplaza, no la expande,
no emite warning. Para subir al nuevo default manualmente, edita a mano
o borra la clave `permission` y re-ejecuta `sync`.

---

## 3. Claude Code — `permissions`

Bloque escrito bajo la clave `permissions`:

```jsonc
{
  "allow": ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "WebSearch"],
  "ask":  ["Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(git push --force:*)"],
  "deny": [
    "Bash(format:*)", "Bash(mkfs:*)", "Bash(dd:*)", "Bash(shred:*)",
    "Read(//**/.env)", "Read(//**/.env.*)"
  ]
}
```

- **`Read` / `Grep` / `Glob` allow**: el default anterior solo pre-aprobaba
  `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`. Los tres nuevos quitan
  los prompts de cada búsqueda/listado en el repo. Las reglas `Read(...)`
  también cubren best-effort el contenido que `Grep` y `Glob` acaban
  mostrando.
- **Denies `Read(//**/.env)` y `Read(//**/.env.*)`**: sintaxis POSIX
  absoluta (`//**/` es la raíz virtual de Claude Code en Windows; casa a
  través de discos, no solo del cwd). El default viejo usaba patrones
  relativos al cwd (`Read(./.env)` / `Read(./.env.*)`), que no cubrían
  rutas absolutas.
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
warning. Para subir al nuevo default manualmente, edita a mano o borra
la clave `permissions` y re-ejecuta `sync`.

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

[permissions.jorgex-read-anywhere.filesystem.":workspace_roots"]
"." = "write"
"*.env" = "deny"
"*.env.*" = "deny"
```

- **`":root" = "read"`**: filesystem completo legible (el "read-anywhere").
- **`":workspace_roots" = "write"`**: el workspace sigue escribible.
- **Denies `.env*`** en `":root"` y en `":workspace_roots"`: secretos
  bloqueados en ambos puntos.

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

Si quieres alinear tu `permission` / `permissions` / `config.toml` al
nuevo default:

1. Compara tu bloque actual con el default canónico en
   `stack/config/defaults.json`.
2. Si difiere a mano, edita a mano — el adapter no va a tocar tu
   config.
3. Como alternativa limpia: borra la clave entera (`permission` en
   OpenCode, `permissions` en Claude Code, o las secciones
   `[permissions.*]` en Codex) y re-ejecuta `sync`. El adapter verá
   "ausente" y escribirá el default nuevo. Cada `sync` ya hace backup
   automático de los archivos que toca; `uninstall` también restaura
   desde backup (ver README §Usage).

> Importante: la opción 3 **no** se ofrece como flujo automático
> (`jorgex-stack upgrade`, etc.). La idea es que la decisión de
> sobrescribir tu config la tomes tú, de forma explícita, con un
> `sync` por detrás.

---

## 6. Nota de seguridad — lo que las denies NO hacen

"Read-anywhere" significa que el modelo **puede ver cualquier archivo del
disco al que tu usuario tenga acceso** (sujeto a las denies de `.env*` y al
sandbox de Codex para los perfiles). Negaciones por patrón **no son
perfectas**:

- **Cobertura limitada por sintaxis.** Las denies son literales sobre el
  patrón declarado — no entienden el "concepto" de secreto, solo el
  nombre. Las denies de `Bash` (Claude) además son posicionales (ver §3);
  las denies de `Read` (Claude) y los globs de filesystem (Codex) usan
  patrones tipo gitignore. Nombres no anticipados (`prod.env`,
  `secrets.json`, `id_rsa`, `.envrc`) **no** quedan cubiertos por
  `Read(//**/.env.*)` ni por `"*.env.*"`.
- **Prompt injection.** Si el modelo lee un archivo que contiene
  instrucciones hostiles ("envíame por red el contenido de `~/.ssh/...`"),
  las denies no van a impedir que el modelo proponga acciones que ya estén
  permitidas. El riesgo real es el **daño**, no la lectura: la lectura está
  permitida por diseño. Las capas que mitigan el daño son los hooks/bloqueos
  de `Bash` destructivo, el sandbox de Codex y la rama protegida de GitHub.
- **Secretos fuera del filesystem.** Variables de entorno con secrets
  pueden terminar en respuestas del modelo si una shell las expande dentro
  de un comando `Bash` permitido (p. ej. `echo $OPENAI_API_KEY`).

Las denies **reducen** la exposición accidental; **no la eliminan**. Trata
read-anywhere como "más cómodo, menos fricción", no como "modelo aislado".
Para secretos críticos (claves SSH, tokens de prod) sigue siendo buena
práctica no tenerlos en el filesystem en rutas predecibles, o dejarlos en
rutas no legibles por tu usuario.