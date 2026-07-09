# Permisos por defecto del stack

Lo que `pnpm dlx jorgex-stack install` (o `sync`) escribe en la config de cada
runtime cuando el usuario **no** tiene ya la clave correspondiente. Si el
usuario tiene su propia config, el stack la respeta: no la toca ni la
re-impone. Revisado y aceptado el 2026-07-09 tras el commit
`feat(config): allow external read defaults`.

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

Cada adapter escribe **solo** si la clave no existe ya en ese archivo. Una
vez escrita, esa sección pasa a ser **config del usuario**: quitarla o
editarla a mano es seguro, y el próximo `sync` ya no la sobrescribirá
porque ya existe. Esta es la regla "casi todo allow, lo destructivo ask/deny"
del briefing del repo.

---

## 2. OpenCode — `permission`

Bloque escrito bajo la clave `permission`:

```jsonc
{
  "edit": "allow",
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
    "*": "allow",
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
- **`external_directory` amplio**: rutas fuera del cwd no preguntan.

**Limitación documentada — los edits externos también pasan.** En OpenCode,
`external_directory` no es una puerta solo de lectura: aplica a `read`,
`edit`, `glob`, `grep` y a muchos comandos `bash`. No existe (en la doc
actual de OpenCode) un camino cwd-independiente que diga "todo lo externo es
legible, nada editable" mientras se conservan los edits dentro del
workspace. Por eso el default trae `external_directory: * = allow` **y**
`edit: allow`: la consecuencia honesta es que el agente **puede escribir
fuera del cwd**. Quien no lo quiera debe cambiar `edit` a `ask` o `deny` a
mano — el stack no lo sobreescribirá después, porque ya no es la clave
ausente.

**Migración desde el default anterior.** El default viejo era `read: "allow"`
(string plano, sin denies) y carecía de `external_directory`. El adapter
reemplaza el bloque entero solo cuando coincide **exactamente** con ese
legacy (helper `deepEqual` en `src/lib/deep-equal.ts`, invocado por el
adapter de OpenCode). Config personalizada → se preserva intacta.

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
  través de discos, no solo del cwd). El default viejo era
  `Read(./.env)` / `Read(./.env.*)` (relativo al cwd); el adapter reemplaza
  el bloque solo si coincide exactamente con ese legacy (comparación
  estricta en el adapter de Claude Code).
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

**Migración desde el default anterior.** Si tu `permissions` coincide
exactamente con el legacy (allow sin Read/Grep/Glob, deny con
`Read(./.env*)`), el adapter lo reemplaza por el nuevo bloque. Cualquier
configuración personalizada se preserva.

---

## 4. Codex CLI — permission profile `jorgex-read-anywhere`

Codex no usa `permissions` top-level para esto: usa **permission profiles**
(beta). El adapter escribe, **si y solo si** la config del usuario no tiene
ya `default_permissions` ni ninguna sección `[permissions.*]`:

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
defines ambos, uno gana de forma no especificada. Por eso el adapter **no
escribe `sandbox_mode`** cuando va a usar el perfil. Si tu `config.toml`
trae el viejo `sandbox_mode = "workspace-write"` del default anterior **y**
no trae `default_permissions` ni `[permissions.*]`, el adapter lo retira y
añade el perfil. Si tienes tu propio `sandbox_mode` o tu propio
`[permissions.*]`, **no** se toca nada en esta zona.

**Guard de `default_permissions`.** Si tu `config.toml` ya tiene
`default_permissions = "..."` o cualquier sección `[permissions.*]`
(incluido un `[permissions.custom]` de un proyecto), el adapter no añade
ni `default_permissions` ni el perfil — interpreta que ya gestionas
permisos a tu manera y deja tu config aislada (predicado
`hasCustomPermissions` y rama de migración del adapter de Codex).

**Migración desde el default anterior.** El default viejo era
`approval_policy = "on-request"` + `sandbox_mode = "workspace-write"`. Si tu
`config.toml` tiene solo eso (sin `default_permissions`, sin
`[permissions.*]`), el adapter retira `sandbox_mode` y añade el perfil.
Cualquier otra combinación se respeta.

---

## 5. Cuándo NO migra (y qué hacer)

El adapter **no** migra cuando la config existente difiere del legacy
exacto en **cualquier** clave. Esto es deliberado: perder una config
personalizada por asumir que coincide con el default sería un bug de
seguridad, no una mejora.

Si tienes una config custom que querrías alinear al nuevo default:

1. Compara tu bloque actual con el legacy correspondiente en
   `stack/config/defaults.json` (cualquier commit anterior a
   `feat(config): allow external read defaults`).
2. Si difiere, edita a mano — el adapter no va a tocar tu config.
3. Como alternativa nuclear: borra la clave entera (`permission`,
   `permissions`, o las secciones `[permissions.*]` de Codex) y re-ejecuta
   `sync`; el adapter verá "ausente" y escribirá el default nuevo. Haz
   backup antes (cada `sync` ya hace backup automático de los archivos que
   toca; `uninstall` también restaura, ver README §Usage).

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