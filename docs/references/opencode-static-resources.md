# Recursos estáticos proyectados a OpenCode

OpenCode v2 carga plugins y scripts desde la raíz efectiva del host
(`OPENCODE_CONFIG_DIR` si está definido, si no `$XDG_CONFIG_HOME/opencode`
o HOME). Stack proyecta cuatro recursos gestionados. Su origen canónico
vive en el propio repo Stack y su huella canónica se declara en
`src/lib/opencode-static-resources.json`; ese archivo acredita
**únicamente el canon legacy v1 publicado** (no el hash canónico
actual), por lo que la coincidencia de digest nunca crea ownership por
sí sola. El ownership sigue viniendo del manifest coherente de la
instalación (configDir + inventario). La fila "current" que el runtime
compara se deriva de los bytes que la proyección **realmente va a
escribir** (helper `projectedBytesByTarget(actions)` en
`src/lib/opencode-static-resources.ts`), no del JSON congelado.

## Tabla canónica

| Origen (`stack/...`) | Destino (`<configDir>/...`) |
| --- | --- |
| `stack/plugins/opencode/hooks.ts` | `plugins/hooks.ts` |
| `stack/plugins/opencode/worktree.ts` | `plugins/worktree.ts` |
| `stack/scripts/post-pr-review.cjs` | `scripts/post-pr-review.cjs` |
| `stack/scripts/repair-worktree-config.cjs` | `scripts/repair-worktree-config.cjs` |

El índice completo (tamaño + `sha256`) y la provenance del canon
(`package`, `version`, `commit`, `sri`) viven en
`src/lib/opencode-static-resources.json`; se trata como evidencia del
canon legacy v1 verificado (no como prueba externa). `package.json`
(`stack/plugins/opencode/package.json`) se verifica contra el canon
como evidencia y nunca se proyecta como recurso estático.

## Reglas de operación sobre los cuatro recursos

El runtime autentica cada recurso contra sus bytes observados
(`authenticateStaticResource`, en `src/lib/opencode-static-resources.ts`)
y deriva un `verdict` ∈ `{ absent, current, legacy, unknown, symlink,
not-regular, unreadable, escaping }`. La proyección usa
`staticResourceBlockReason(auth)` para decidir si la operación puede
proceder. La tabla siguiente es la única fuente de verdad:

| Estado observado | Owned | Verdict | `install` / `sync` / `update` | `uninstall` |
| --- | --- | --- | --- | --- |
| Bytes del archivo = bytes actuales que produce el plan de proyección (`projectedBytesByTarget`) | sí | `current` | noOp (sin claim adicional) | puede borrar con backup |
| Bytes actuales = canon legacy v1 (`legacy`) | sí | `legacy` | puede **actualizar** al actual con backup previo | puede borrar con backup |
| Bytes distintos del canon (modified/unknown) | sí | `unknown` | **bloquea antes de cualquier backup, escritura o borrado** | preserva byte a byte |
| Bytes del archivo = bytes actuales que produce el plan de proyección (`projectedBytesByTarget`) | no | `current` | noOp, **no** se reclama | omite |
| Bytes = canon legacy v1 (`legacy`) | no | `legacy` | **bloquea** el install | omite y preserva |
| Bytes distintos (modified/unknown) | no | `unknown` | **bloquea** el install | omite y preserva |
| Leaf ausente dentro del configDir autorizado | n/a | `absent` | puede **crear** y reclamar | n/a |
| Leaf ausente sin ancestro resoluble o fuera del configDir | n/a | `escaping` / `unreadable` | **fail-closed** | **fail-closed** |
| `O_NOFOLLOW` + `fstat` detecta symlink o nlink > 1 | n/a | `symlink` / `not-regular` | preserva | preserva |

**Notas operativas:**

- **El bloque precede a cualquier mutación**: cuando el verdict es
  `unknown`/`legacy`-unowned/`symlink`/`not-regular`/`unreadable`/
  `escaping`, ni el backup ni el borrado ni la escritura se ejecutan; la
  acción es preservar el estado actual con backup previo solo cuando la
  columna "`uninstall`" lo autoriza explícitamente.
- **Pre-flight físico**: la apertura usa `fs.openSync(target,
  O_RDONLY | O_NOFOLLOW)` cuando el SO lo soporta, valida `fstat`
  (`isFile()` + `nlink ≤ 1` + `dev`/`ino`/`size`/`nlink` estables) y
  lee como máximo `row.size + 1` (o `currentBytes.length + 1`); un
  symlink intermedio, un ancestor escapado o un cambio de descriptor
  entre la apertura y la lectura no acredita identidad y devuelve
  `symlink` o `unknown` → preserva.
- **No es sandbox universal**: un root malicioso con acceso al paquete
  del instalador puede alterar el binario antes de que el loader del
  host lo lea. La verificación por bytes no protege contra esa clase de
  ataque.
- **Límite operativo — carrera del filesystem**: el helper físico
  acredita el leaf con `lstat` + `fstat` (`dev`/`ino`/`size`/`nlink`)
  y vuelve a comprobar el `realpath` de `root` y `target` después
  de abrir y antes de leer. El caller repite la autenticación antes de
  los efectos destructivos; cada comprobación vincula la identidad
  inicial del archivo con el descriptor abierto y vuelve a acreditar
  el confinamiento físico. Si la revalidación detecta un cambio
  (descriptor, ruta física o ascendencia escapada), la operación
  aborta con remedio en lugar de continuar. Esto **no** equivale a
  una escritura o borrado atómico portable condicional por inode:
  Node no ofrece esa garantía. Otro proceso del mismo UID que
  manipule deliberadamente el filesystem entre la comprobación y la
  mutación por ruta puede superar estos controles. `install`/
  `uninstall` permanecen operativos sobre los casos legítimos sin
  nuevas dependencias ni backends nativos; no se afirma resistencia
  universal ni atomicidad condicional por inode. Esta limitación
  convive con la anterior (root que altera el paquete) y no la
  sustituye: ambas describen techos distintos del mismo modelo de
  amenazas.
- **No es atestación externa**: el digest en bruto no se publica como
  prueba fuera del bundle; el runtime no usa el hash del JSON para
  acreditar nada más allá del contenido que proyecta.
- **No es migración automática de versiones históricas**: el índice
  reconoce el canon actual y rechaza caminos cuyo origen no pueda
  acreditar contra el commit congelado. Una versión previa no se
  reconstruye sola.
- **No es fallback de runtime**: no hay segunda store ni SDK v1
  paralelo. Si el canon actual no puede acreditar un recurso, la
  operación falla cerrado; no se reconstruye un binario desde otra
  fuente.

## Recursos current-only del cliente v2 (panel y audio)

El cliente v2 añade cuatro recursos **current-only** (los dos WAV y los
dos archivos del panel TUI) que se proyectan mediante el hook adicional
`planAdditionalResources` del adapter —**distinto** de `planPlugins`,
`planMainConfig` y `planHooks` del server config—, por lo que viven
fuera del árbol de plugins del servidor y **no** se auto-cargan como
plugin ni relajan el filtro de árbol de los componentes.

Su autenticación física reusa el helper existente
(`authenticateStaticResource` en `src/lib/opencode-static-resources.ts`)
con fila histórica `null` para estos assets; al carecer de fila legacy
nunca devuelve `legacy` y dimensiona la lectura acotada contra los
bytes actuales que la proyección va a escribir. **No** se añade fila v1
ficticia al índice legacy (`src/lib/opencode-static-resources.json`) y
`package.json` no se proyecta como recurso estático. El contrato del
generador estático (`scripts/regenerate-opencode-static-resources.py`)
queda intacto: sigue emitiendo solo los cuatro recursos históricos y
rechaza duplicados.

| Origen (`stack/...`) | Destino (`<configDir>/...`) |
| --- | --- |
| `stack/assets/opencode/sounds/done.wav` | `sounds/done.wav` |
| `stack/assets/opencode/sounds/silent.wav` | `sounds/silent.wav` |
| `stack/assets/opencode/tui/subagents/tui.tsx` | `tui/subagents/tui.tsx` |
| `stack/assets/opencode/tui/subagents/state.mjs` | `tui/subagents/state.mjs` |

**Auth (qué autentica y cuándo bloquea).** El helper abre el **target**
en disco con `O_NOFOLLOW` + `fstat`, confina su `realpath` dentro del
configDir y compara sus bytes contra los bytes actuales del plan
(`currentBytes`); **no** autentica la identidad física del propio canon
fuente, solo acredita que el archivo en disco coincide con lo que la
proyección va a escribir. Distinga tres casos:

- **Canon fuente ausente/ilegible** (`sourcePath` no se puede leer o
  `currentBytes === null`): verdict `unreadable`, se falla cerrado
  **antes** de cualquier backup, escritura o mutación — **nunca** se
  omite en silencio ni se asume ausencia del target.
- **Target ausente en install fresh** (raíz y ancestro resolubles
  dentro del configDir físico): verdict `absent`, se crea y se
  reclama. Es la única vía de proyección legítima, no un fallo.
- **Target con bytes distintos del canon actual** (incluye copia
  manual ajena o modificada): verdict `unknown`, se preserva el
  archivo byte-a-byte, **sin backup y sin reemplazo**. Una copia
  manual idéntica al canon actual devuelve `current` y se considera
  no-op sin claim; una entrada ajena bloquea antes de cualquier
  mutación. Para `legacy` (fila histórica) solo procede con backup si
  el recurso es owned; unowned se conserva sin claim.

**Límite current-only.** Si el canon cambia en una versión futura
**sin** una versión previa autenticable, los bytes anteriores
distintos del nuevo canon bloquearán el preflight en lugar de
sobrescribirse a ciegas. No hay store paralelo ni ledger nuevo; el
mismo `authenticateStaticResource` decide con la fila nullable y la
lectura acotada. El índice histórico de cuatro recursos y sus reglas
de backup/uninstall quedan vigentes — este límite no introduce
remedios nuevos ni historial artificial al índice generado.

## Audio (defaults ausentes, no reemplazo)

- **`done.wav`** es el **único** sonido audible del cliente. El evento
  nativo `done` también se dispara en `interrupted` y **no** marca
  final de roadmap; los cinco eventos restantes (`subagent_done`,
  `question`, `permission`, `error`, `default`) apuntan todos a un
  único `silent.wav` propio PCM16 mono con muestras cero no vacías.
  Este silencioso evita el fallback builtin cuando el override nativo
  falta o es ilegible; **no** evita el builtin si el propio
  `silent.wav` falla al cargar o reproducirse (en ese caso el host
  puede recurrir al builtin).
- Plugins con audio directo (p. ej. Herdr u otros) **no** quedan
  cubiertos por estos overrides y siguen sonando lo suyo. Stack no los
  modifica ni sus notificaciones visuales, ni cambia `attention.volume`
  (canónico `0.1`) ni `attention.notifications`/`attention.sound`.
- El contrato cubre defaults ausentes y **no** borra un override
  manual del usuario ni un `silent.wav` adicional que este haya
  declarado; no se afirma reproducción audible verificada, ni que el
  motor de audio del host esté apagado, ni que se ejecute una audición
  universal como prerrequisito.

## Panel TUI

`tui.tsx` y `state.mjs` son el panel propio (id `jorgex.subagents`).
Se registran como entrada local `./tui/subagents` en `cli.json.plugins`
mediante `editJsoncArray` (inserción indexada, remoción indexada o
prune del contenedor vacío), preservando comentarios JSONC,
objetos-opción y disable directives ajenos en `cli.json.plugins`. Una
entrada manual preexistente igual (string o `{ "package":
"./tui/subagents", …opciones }`) no se duplica ni se reclama; una
disable directive (`-./tui/subagents`, `-jorgex.subagents` o `-*`) que
alcance el panel se preserva y no se neutraliza añadiendo un override
posterior. El autoload de plugins del server config queda intacto.
La guía pública de UX (plegado, `/subagents`, contadores, filas
activas, navegación, cleanup) vive en el
[README](../../README.md#opencode-v2-un-solo-runtime-soportado), que
es la única fuente de UI; aquí solo se documenta el registro y su
auth.

## Mantenimiento del índice (herramienta de mantenimiento, no runtime)

La regeneración del índice frozen vive en
`scripts/regenerate-opencode-static-resources.py`. Es **herramienta
de mantenimiento** y nunca se ejecuta desde `install`/`sync`/`doctor`/
`uninstall` ni desde el runtime; solo corre cuando un mantenedor la
invoca explícitamente desde un clon git del repo. La procedencia del
canon (`jorgex-stack@1.9.67`, commit `6a54caf512125d53ef8c98e137710a4cf8c2a480`,
SRI `sha512-238nlRoeq/FZ0TUhWkp9d7xT4mYly6N2Z5kSXhx2tPIpv3oqo375LvpVp11N58SNPi42Kf7XuYMh72St45CwNg==`)
queda fija en el propio script y se compara contra la metadata del
registry npm antes de cualquier escritura.

```bash
# Verificar sin escribir
python3 scripts/regenerate-opencode-static-resources.py --check

# Regenerar y escribir el mismo snapshot histórico (no introducir
# ningún nuevo selector de release).
python3 scripts/regenerate-opencode-static-resources.py
```

Garantías que el script aplica antes de escribir nada:

- **Identidad de metadata oficial**: nombre (`jorgex-stack`), versión
  (`1.9.67`), `gitHead` y SRI del `dist.integrity` leídos del registry
  deben coincidir con los valores cerrados en el propio script.
- **SRI del tarball**: el payload descargado se hashea con SHA-512 y se
  compara contra el canon; cualquier mismatch aborta.
- **Caps antes de procesar**: `MAX_DOWNLOAD_BYTES = 16 MiB`,
  `MAX_DECOMPRESSED_BYTES = 64 MiB`, `MAX_METADATA_BYTES = 2 MiB`; el
  lector acotado evita materializar el árbol completo antes del cap
  (defensa contra bombas de descompresión).
- **Integridad del tar**: cada miembro pasa por `_safe_member_path`
  (prefijo `package/`, sin segmentos vacíos ni `..`, sin separadores
  `\`), es regular, único. El generador compara byte a byte únicamente
  los cuatro recursos proyectados y el `package.json` usado como
  evidencia con sus blobs del commit inmutable; los demás miembros se
  validan por rutas, duplicados y tipo, pero no se comparan contra Git.
  No extrae archivos al sistema de archivos ni ejecuta su contenido.
- **Verificación byte-exact contra el commit inmutable**: cada recurso
  proyectado se compara con `git cat-file blob <commit>:<source>` desde
  el clon git antes de aceptar su digest; cualquier mismatch aborta.
- **Determinismo**: las filas se ordenan por `target`; el JSON se
  serializa con `json.dumps(index, indent=2, ensure_ascii=False)` y
  `"\n"` final. Dos ejecuciones consecutivas (incluido `--check`) sobre
  la misma metadata histórica y el mismo commit generan el mismo
  output; no se introduce ningún selector de release futuro y los
  SHA-256 canon legacy v1 no se tocan.
- **Fila exacta**: el índice emite exactamente cuatro recursos (uno por
  par origen/destino) y rechaza duplicados; `package.json` se trata
  como evidencia y nunca entra en `resources`.
