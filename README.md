# JorgeX Stack

Portable multi-agent harness: one configuration source — 17 skills, hooks, persistent memory ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs, and system prompt — installable with one command in **Claude Code**, **Codex CLI**, **OpenCode**, and **Pi**.

> Inspired by [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), rebuilt for the JorgeX stack.

## Skills: release snapshot and supply chain

The current canon carries a fixed **17-skill snapshot**: **6 stack-owned** skills and **11 vendored** skills. Runtime adapters execute only the local copies committed under `stack/skills`; they do not fetch, install, or execute upstream content at runtime.

| Set | Skills |
| --- | --- |
| Stack-owned (6) | `agent-delegation`, `lean-code`, `orchestrator`, `work-audit`, `work-lifecycle`, `xreview` |
| Vendored (11) | `deploy-to-vercel`, `diagnose`, `find-skills`, `mcp-builder`, `react-doctor`, `skill-creator`, `supabase`, `supabase-postgres-best-practices`, `tdd`, `to-issues`, `to-prd` |

The supply-chain contract is deliberately explicit:

- **Snapshot:** the 17 directories above are the release input. A published package ships this snapshot instead of a live mirror of any upstream.
- **Per-skill pin:** `upstreams.json` records each vendored source/path and its accepted commit pin (plus package/binary pins where applicable). A pin identifies the last reviewed snapshot; it does not mean that later upstream changes were accepted.
- **Manual review:** only a maintainer running from a git clone may inspect and propose vendored-skill updates. The flow downloads to a temporary directory, shows a mandatory diff, requests confirmation, and re-pins only after deliberate review. Local changes marked `modified: true` receive an additional warning/confirmation.

For an installed package, skill checks are **discovery-only**: `update --check` reports that vendored skills are pinned to the stack version and does not query or execute their upstreams. The two Obsidian skills (`obsidian-cli` and `obsidian-markdown`) were retired because they are non-essential to the stack. Their cleanup is ownership-safe: only manifest-owned files may be removed and they are backed up first; paths outside the manifest are preserved. A modified manifest-owned copy is still removed after backup. No Obsidian vault or binary is touched.

### Portable SDD audit

`work-audit` adds two read-only workflow gates to the canonical orchestrator:

- **PRE**, after `PRD.md`, `plan.md`, and task specs exist: checks clarifications, unique `SC-*` criteria, task coverage, ownership, dependencies, and testing decisions before plan approval.
- **POST**, during VERIFY: checks implementation and evidence against the approved criteria and reports `converged` or actionable gaps.

The skill never edits artifacts or creates tasks. During audit remediation, the orchestrator is the only writer of active work artifacts and returns every gap to its owner; delegated writers still own their bounded code, test, and documentation tasks. Details: [docs/references/sdd-workflow.md](docs/references/sdd-workflow.md).

## Usage

Install and run via npm without cloning the repository:

```bash
# First installation
pnpm dlx jorgex-stack install

# Already installed: apply the latest published stack while keeping the existing model selection
pnpm dlx jorgex-stack sync
```

For a fresh Engram installation, always consult the current published Stack and bypass only the `pnpm dlx` cache:

```bash
pnpm --config.dlx-cache-max-age=0 dlx jorgex-stack@latest install --engram
```

`dlx-cache-max-age` is separate from the pnpm 11 dependency-age filter: it controls only the cached `dlx` package, while `minimumReleaseAgeExclude` applies only to the named package resolution. An explicit Stack version such as `@1.9.30` does not reuse the cache entry for another version. Pi `install`/`update` resolve the registry's observed published `latest` dist-tag to an exact version and verify the artifact before activation; they do not install a floating `latest` alias.

Other important commands:

```bash
pnpm dlx jorgex-stack doctor          # check Engram, config drift, hooks and keys
pnpm dlx jorgex-stack models          # change models by runtime, tier or subagent
pnpm dlx jorgex-stack update --check  # report stack/Engram updates and maintainer-only skill discovery
pnpm dlx jorgex-stack update          # interactively review and apply available updates
pnpm dlx jorgex-stack restore --list  # list automatic backups
pnpm dlx jorgex-stack restore <id>    # restore one backup
pnpm dlx jorgex-stack uninstall       # remove managed files; keep Engram data intact
```

For development from a clone, run the same commands through `pnpm cli <command>` (see [Development](#development)).

Every command supports `--dry-run`, `--yes`, and `--target-dir <dir>` for testing without touching the real config. Writes create automatic backups and verify idempotency; merges into user config are surgical (marked markdown sections, JSON/TOML upserts), so user-owned content is never touched. `--yes` does not authorize downloading missing Engram; use `--engram` for that explicit consent. The interactive install asks before installing it, while dry-run and target-dir never download it.

Runtime defaults are documented in [docs/references/permissions.md](docs/references/permissions.md) for permissions and [docs/references/models.md](docs/references/models.md) for the Sol primary default, field-level ownership and independent subagent routing. The quality policy and `jorgex.quality.receipt` contract are documented in [docs/references/quality-receipt.md](docs/references/quality-receipt.md). OpenCode remains provider-agnostic for subagents; its primary defaults to the OpenAI OAuth model `openai/gpt-5.6-sol` unless the user replaces it.

### Modes: Human and Programmatic

`install` and `sync` accept two mutually-exclusive installation modes. The choice is global (not per runtime) and is saved in `~/.jorgex-stack/install-mode.json` on first run; subsequent `sync` calls reuse it. Re-run `install` with `--mode` to switch.

| Mode | Audience | Final assistant response | Subagents |
|------|----------|--------------------------|-----------|
| `human` (default) | interactive users, TUI | natural language, in the user's language | today's behavior (parallel where safe) |
| `programmatic` | external orchestrators, CI, scripts, other agents | **strict JSON**, English | serial by default, parallel opt-in |

`human` is the recommended mode for humans. `programmatic` exists for agent/script consumers and low-resource headless machines; it is not a "better" mode for humans.

Flags:

```
--mode human|programmatic
--subagent-concurrency serial|parallel   # only valid with --mode programmatic
```

- Non-interactive / agent install:

  ```
  pnpm dlx jorgex-stack install --mode programmatic --subagent-concurrency serial --yes
  ```

  This installs into all detected runtimes. To be explicit, add `--agents opencode,claude-code,codex,pi` or a comma-separated subset. Always pass `--mode programmatic`; without `--mode`, `--yes` and non-TTY installs default to `human`.

  OpenCode also requires an existing selection in `~/.jorgex-stack/model-map.json`; run `pnpm dlx jorgex-stack models --agents opencode` interactively once before a headless install.

- `--mode human` cannot be combined with `--subagent-concurrency`.
- Without `--mode`, the first run asks interactively; `--yes`, non-TTY, and `--target-dir` default to `human`.
- `pnpm dlx jorgex-stack sync` reuses the saved mode; pass `--mode` to change and save the preference.

Programmatic mode guarantees:

- The final assistant response is **exactly one strict JSON object**, no Markdown fences or prose around it. Schema in `stack/modes/programmatic/final-output.schema.json` — required keys: `status`, `decision`, `confidence` (0..1), `summary`, `risks[]`, `next_steps[]`, `delegations[]`; `status` is `done|partial|blocked` and each `delegations[]` item uses `agent: work — paths — inputs`.
- English only, compact and direct.
- Subagents default to **serial** delegation (one at a time, no parallel). Pass `--subagent-concurrency parallel` to allow it.

Programmatic mode does **not** provide:

- An opt-out from Engram (Engram is always part of the install).
- Any special stdout streaming guarantee — the runtime's normal output rules apply.
- Telemetry, JSONL streams, or runtime token-budget enforcement.

### Pi runtime

El canon de Stack y el paquete Pi mantienen una snapshot de 17 árboles de skills con 89 archivos de skill. Para instalaciones deliberadas, Stack resuelve la versión publicada observada en npm y verifica el tarball y el stage; `src/lib/pi-runtime-pin.json` y el historial conservan identidades congeladas, no un selector para futuras instalaciones.

Pi combines the **snapshot v2** package with a Stack-owned shared projection. Package resolution, verification, receipt and recovery behavior are documented in [docs/references/pi-runtime.md](docs/references/pi-runtime.md); historical pins are not a promise that personal Pi installations have migrated.

En Pi nuevo, Stack gestiona `jorgex-pi` y sus seis companions locales, y prepara los providers oficiales `gentle-engram` y `pi-mcp-adapter` en stages Pi-native aislados. Cada `install` o `update` deliberado resuelve el `latest` publicado, verifica lock/SRI/árbol y promociona solo los dos directorios provider; conserva el enlace y receipt privados de `jorgex-pi`, el host Pi, las entradas npm ajenas y los datos de Engram. Con un receipt Stack válido, `install --agents pi` continúa por la actualización autenticada; el estado manual o ambiguo se bloquea. El [inventario de Pi](docs/references/pi-runtime.md#inventario-operativo-de-pi) distingue componentes obligatorios y opcionales.

The following command block is retained as historical reference for that transition:

```bash
pnpm dlx jorgex-stack@1.9.7 install --agents pi
pnpm dlx jorgex-stack@1.9.7 doctor --agents pi
pnpm dlx jorgex-stack@1.9.7 models --agents pi
pnpm dlx jorgex-stack@1.9.7 sync --agents pi
pnpm dlx jorgex-stack@1.9.7 uninstall --agents pi
```

For a deliberate managed install or update, Stack resolves the live published `latest` tag to an exact release, verifies its canonical tarball URL and SRI/bytes, and prepares it in an isolated stage before activation. The stage locks six direct dependencies, copies them byte-identically into the package-local runtime tree, and records those copies only in the tree inventory; the lock remains the verified lock, and the release id uses both lock and tree digests; it then runs the RPC smoke before and after promotion. Stack then backs up state and publishes only its owned package entry. Automatic restoration covers activation/verification failures; if projection or MCP configuration fails after the package is activated and verified, Stack blocks with the backup retained rather than claiming a full rollback. The schema 1 receipt records managed-package evidence for offline verification. `sync`, `models`, `doctor` and `uninstall` do not acquire a new version; they require an authenticated receipt/artifact, with explicit legacy recovery paths where applicable. `update --check` does not download. `--target-dir` neither downloads Pi nor touches the real HOME; with a previously verified candidate/stage injected, it can run isolated smoke/runner code inside the target. Direct Pi installation is separate and does not provide Stack's rollback guarantees. Do not use Pi's native `pi update --extensions` as a Stack repair path: it does not provide the managed receipt or Stack's activation/recovery guarantees. A Pi release is adopted only after its reader declaration, tarball and integrity pass the verified stage; no future version is pinned manually.

The artifact values in `src/lib/pi-runtime-pin.json` describe frozen historical/reference metadata, not the live install candidate; live artifact URL, version and integrity are resolved from the published registry.

Stack runs provider-owned `engram setup pi` before Pi package activation on a real managed install. It backs up and verifies Pi's `settings.json`, both possible MCP config paths (`mcp.json` and `mcp-adapter.json`) and the provider-owned `npm` tree, and restores the backup on setup failure; Pi is not activated unless setup and subsequent package lifecycle succeed. The effective MCP path comes from the installed `pi-mcp-adapter` metadata: major 2 reads `mcp.json`, while major 3+ reads `mcp-adapter.json`; missing metadata fails closed instead of falling back. A duplicate official Engram root in the legacy path is a conflict, not a healthy configuration. The runtime lifecycle remains authoritative in `src/lib/pi-runtime.ts`; the exact release evidence belongs to the verified receipt and tarball. Pi's own package-manager invocation is the narrow runtime exception to the repository's pnpm-only rule; the Stack lifecycle never launches npm directly. A managed install then runs provider setup, `package install → projection install → package sync`. Stack projects shared resources such as the system prompt, canonical skills and `lean-audit`; it does not inject `jorgex:engram-protocol`, project Engram tools, or filter provider tools. The behavioral `engram` role remains part of the Pi contract, while the official provider owns its setup and tools. Pi registers Context7 through an isolated in-memory HTTP bridge during bootstrap; `available` means configuration permits registration and does not imply an HTTP handshake. A conflict preserves the existing MCP file and blocks managed activation. No MCP credentials are written. For the file runtimes, Context7, Playwright and DevTools use independent managed sections. The managed Playwright tree belongs to Stack while Chromium’s cache is shared by the machine; `--playwright-runtimes` controls which runtime receives the guide. The published compatible Pi reader accepts a byte-bound Playwright v2 handoff; its v1 reader remains for historical receipts, not new opt-ins. Stack projects v2 only after its managed browser receipt and Pi package pass verification, including `contract/browser-handoffs.v1.json`; an older Pi without that declaration blocks new v2/v3 handoffs without a version-number guess. Package ownership is recorded separately in `~/.jorgex-stack/pi-receipt.json`; projection ownership is recorded in `~/.jorgex-stack/pi-projection-receipt.json`. Package receipts reject manual, duplicate, divergent, partial, corrupt, copied-to-another-scope, or unknown-history state. Projection cleanup requires an exact scope-bound ownership receipt; DevTools conflicts preserve the handoff for review.

The static `AGENTS.md` projected by Stack does not include Context7; Pi's native bootstrap adds that section after registering the isolated bridge. Pi never writes, owns or removes MCP files. In Claude Code, Codex and OpenCode, a compatible existing Context7 entry is preserved and removed only with explicit canonical Stack ownership. During package installation only, `initialization-diagnostics-v1` permits the exact pending `doctor` envelope described in [the Pi runtime reference](docs/references/pi-runtime.md); it is provisional and does not make Pi healthy. Projection and final `sync` must still complete, and every other unhealthy or malformed result remains blocked.

Pi 0.8.28 also seeds `theme=JorgeX`, `quietStartup=true`, and `hideThinkingBlock=true` only for missing fields during first initialization. User changes and deletions are preserved without reseeding. `hideThinkingBlock` changes presentation only; `defaultThinkingLevel` and reasoning remain unchanged. Pi owns only the fields it creates and records in its lifecycle receipt; pre-existing user settings remain unowned. The JorgeX header preserves builtin and custom commands. `Ctrl+O` remains Pi's native tool presentation, with `NO_COLOR` and `JORGEX_PI_MOTION` behavior unchanged; Stack adds no renderer.

Historically, the published Pi 0.8.0 direct-package snapshot added `work-audit`: the snapshot grew from **17 to 18 skill trees** (96 to 97 files), and the active runtime allowlist grew from **16 to 17 skills**. The historical Pi 0.8.5 snapshot reference records 18 skill trees and 98 files; it does not describe the adopted pin. Reference F2-A is included while the private F1 skills remain preserved. `playwright-cli` remains in the snapshot but inactive because browser automation is a separate opt-in integration.

The historical published artifact has two separate provenance anchors. The local size/SHA-256/SHA-512 checks bind the downloaded bytes to Stack's accepted artifact; they are checks within that checkout, not independent trust roots. npm's external provenance/attestation is outside Stack runtime verification, and `provenance.commit` is informative unless that external attestation is independently verified.

The historical `0.8.0` artifact records two distinct commit identities: the release checkout and tarball producer is `9f999747df3e335947a61d38e581555367973b09` (`main`, release `0.8.0`); and the Stack parity source is `11e7666ea4e40bde1de8bc434610747eb797ab9c`. Registry metadata has no `gitHead`; README does not invent a separate source identity, attestation or signature.

Install, sync and uninstall back up every managed file before changing it and are idempotent. `doctor` reports package and projection drift without repairing it. Uninstall removes only receipt-owned package/projection state, retains shared files also owned by another runtime, and preserves user content outside marked sections. Engram remains user-owned and is never removed; the receipts only carry the verified executable hand-off required by the package.

The package owns Pi's native primary-model projection: `openai-codex/gpt-5.6-sol`, with a local `contextWindow` request of 872K. It merges only missing compatible fields, records field ownership in `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`, and cleanup removes only still-owned canonical values. Stack does not duplicate that package-owned settings/models logic. The 872K value is local OAuth metadata until a real long-context smoke test confirms backend acceptance; it is not the API context limit.

Engram remains mandatory and user-owned. An existing binary is always preserved. When it is missing and the user authorizes installation, Stack resolves GitHub's current official latest stable release at runtime; GitHub's `releases/latest` endpoint excludes prereleases and drafts, and the installer never uses a branch. It matches the exact platform/architecture asset and validates its live metadata —published state, expected name, positive size and SHA-256— before publishing; missing network or metadata fails closed, with no static or offline fallback. Use `--engram` to authorize that download in non-interactive flows. The release installer writes only `~/.local/bin/engram` (or the platform equivalent) and does not use Brew or Go. `sync`, dry-run and `--target-dir` never download it. Update remains explicit and does not replace an existing binary implicitly. The database and memories are never updated or deleted, and uninstall preserves the official Engram artifacts and never removes the Engram binary. Under `--target-dir`, Stack accepts only `<target>/bin/engram`, isolates Pi/Home/XDG/AppData/temp/npm-cache paths inside the target, and never consults the host Engram or Pi configuration. This rolling channel does not mean that every upstream release was pre-reviewed by Stack.

Claude's official plugin still requires stable Engram 2.0.0 or newer: an existing binary below that minimum would make its setup write the obsolete `mcp/engram.json`, so the Claude preflight blocks it before setup. Stack never replaces an existing binary automatically; update it explicitly and rerun `install`. The official Claude plugin contributes hooks and its skill; `engram setup claude-code` registers a separate user-scoped MCP, not a bundled MCP. This integration does not claim an authenticated model-tool smoke.

### Integración oficial de Engram

En una instalación real, `install` delega Claude Code, Codex y OpenCode 1.x a `engram setup <runtime>` una vez por runtime durante esa instalación, y Pi ejecuta `engram setup pi` antes de activar el paquete. El comportamiento del provider oficial permanece sin cambios: Stack no proyecta el protocolo Engram ni filtra sus herramientas. No ejecuta ese setup durante `sync`, `dry-run`, `--target-dir`, `doctor` ni `uninstall`. Stack respalda los archivos afectados, verifica los artefactos oficiales y revierte el cambio si falla; para Pi incluye `settings.json`, `mcp.json` y el árbol `npm`. No modifica `~/.engram`, sus memorias ni reemplaza un binario existente. Los artefactos oficiales se conservan al desinstalar. El `stack/plugins/opencode/engram.ts` legado ya no se despliega y queda retirado por esta integración.

Para Codex, Engram 2.0 ignora `CODEX_HOME` y escribe siempre en `$HOME/.codex`; por eso el setup oficial real requiere ese destino predeterminado. Si `CODEX_HOME` apunta a otro directorio, `install` falla cerrado en el preflight, antes de escribir la configuración de Codex, y recomienda usar `$HOME/.codex`. `sync`, `dry-run` y `--target-dir` no invocan el setup oficial.

La política de complementos distingue estrategias `exact` y `provider-managed`. DevTools MCP y Playwright CLI son `provider-managed`: un `install`/`update` deliberado resuelve y verifica el candidato exacto antes de activarlo, y guarda versión/integridad observadas para reconciliar sin consultar al proveedor en `sync`. Las integraciones oficiales de Engram también son `provider-managed`/rolling, incluido Codex `main`, `pi-mcp-adapter` y el setup oficial de Pi sin pin en Stack. OpenCode 2 queda fuera de alcance y no bloquea esta integración.

Los receipts históricos, incluido `jorgex-pi@0.8.24`, son evidencia para recuperación/migración y no candidatos de instalación nuevos. La selección gestionada resuelve el `latest` publicado a una versión exacta y verifica el artefacto antes de activarlo. No edites receipts o hashes ni borres `HOME`, Engram o la proyección de otro runtime para forzar confianza. La migración y rollback están en [docs/references/pi-runtime.md](docs/references/pi-runtime.md).

Stack gestiona la selección dinámica y verificación de Pi en `install`/`update`; esto no significa que una instalación personal de Pi se haya migrado. La automatización Stack ↔ Pi es snapshot-only. La instalación directa de Pi no incluye la etapa aislada ni el rollback de Stack.

`update --agents pi` cambia versiones deliberadamente: resuelve y verifica el paquete Pi y los dos providers oficiales en stages aislados, aplica la promoción acotada y verifica la configuración MCP. No entra en el updater global de Stack, no actualiza el host Pi ni toca los datos de Engram. `sync --agents pi` reaplica la proyección a partir del paquete autenticado y comprueba el estado MCP existente; no resuelve versiones ni descarga providers. `update --check --agents pi` consulta el runner sin mutar Pi; `doctor --agents pi` diagnostica paquete y proyección. Uninstall respalda los settings y retira solo el paquete exacto acreditado por el receipt, verificando su ausencia y conservando companions y estado ajeno. Consulta los límites de recuperación en la [referencia Pi](docs/references/pi-runtime.md).

### Variante temporal del provider y recibo separado (candidato, devtool)

> **Candidato / devtool — todavía no publicado en npm.** Mientras la corrección upstream `#1567` de `gentle-engram` no se publique, `--engram-typebox-compat` está apilado sobre PR203 (`e2555b2`) y la integración con el caller nativo de la cohorte de CI pública sigue pendiente. Esta sección no declara Windows, MCP nativo, autorización personal ni adopción del release oficial corregido como verificados. La variante descrita es un artefacto local derivado —no es un fork ni un release npm— que aplica sólo el diff de `#1567` sobre bytes oficiales verificados, registra su procedencia en un recibo separado y se retira cuando el release oficial corregido se active como `registry`.

`--engram-typebox-compat` es un booleano explícito; cuando no se pasa, la propiedad queda **realmente ausente** (`undefined`) y no se conserva ninguna preferencia ni se añaden campos obligatorios a flags/fixtures. Sólo se acepta en `install` y `update` deliberados cuyo `--agents` incluya `pi` y **sin** combinar con `--dry-run` ni `--target-dir`; `update --check`, `--dry-run` y `--target-dir` (en `install` o `update`), `sync`, `models`, `doctor`, `uninstall` e `install` sin `pi` rechazan el flag antes de cualquier efecto. `--dry-run` y `--target-dir` siguen sin adquirir providers ni escribir estado personal. Stack registra la procedencia de `gentle-engram` y `pi-mcp-adapter` en `<home>/.jorgex-stack/pi-provider-receipt.json` (schemaVersion 1), un archivo distinto del `pi-receipt.json` del paquete JorgeX Pi y de la autoridad MCP. El campo `provenance` es **opcional** ligado a la adquisición `#1567`-compat: cuando el oficial ya viene corregido el builder devuelve `provenance.origin = "registry"`; mientras no, devuelve `provenance.origin = "derived"`; en ambos casos se descarta el `path` de stage y se conserva el payload original del manifiesto como `manifestBase64` (texto base64 que decodifica al manifiesto bounded —el límite aplica al payload decodificado, no al string literal) junto con su digest y la referencia del patch para verificación offline. Es procedencia local reproducible, no attestation independiente del publisher. `doctor` lee este recibo y diferencia `registry` vs `derived`; no consulta la red, no repara y nunca presenta un error como setup sano. Una `update` deliberada sobre derivado existente conserva la receta sin volver a requerir el flag, sólo si el recibo verificado lo permite; no se autosiembran preferencias y ningún otro comando propaga el opt-in. Las garantías de transacción (backup, idempotencia, rollback, detección de modificaciones ajenas con reporte de `recovery incomplete`), la retirada tras activación verificada del oficial corregido y la exclusión del updater nativo de Pi como vía segura —permaneciendo legacy hasta que la fase nativa del PR203 esté consolidada y un recibo nativo aún no publicado no debe presentarse como instalación nativa sana— están detalladas en [la referencia Pi](docs/references/pi-runtime.md#variante-temporal-del-provider-y-recibo-separado-candidato-devtool). La autoridad MCP nativo, el set nativo y la cardinalidad de la cohorte pública pertenecen a PR203; este contrato no los duplica ni los anticipa.

### Estilo global de escritura

Stack incluye un prompt genérico de estilo de escritura como parte de su canon. `install` y `sync` lo gestionan en `~/.jorgex-stack/writing-style.md`; en modo humano proyectan el contenido efectivo directamente en una sección independiente de las instrucciones globales de los runtimes seleccionados. El prompt se aplica a la prosa dirigida al usuario, sigue el idioma en el que escribe el usuario salvo que pida otro y conserva las instrucciones técnicas, los formatos de máquina, el código y la configuración nativa. El modo programático conserva la fuente local, pero omite la proyección de prosa.

La proyección contiene el canon directamente: Stack no añade un wrapper adicional ni una identidad personal. Si falta el archivo local o está vacío, Stack recrea el bloque gestionado. El corpus de mensajes y los informes privados de análisis no se distribuyen en el paquete. Consulta [configuración, prueba aislada, diagnóstico y límites](docs/references/writing-style.md).

El paquete Pi adoptado ya no inyecta un fallback propio con `Communication Style` en español; el estilo de escritura que recibe Pi procede de la proyección gestionada por Stack.

### Automatización de navegador

La automatización de navegador es opt-in. Stack retiene el release observado en un árbol privado, no en el directorio global de pnpm. Comprueba el tarball npm oficial y el cierre transitivo instalado en un stage aislado, promociona ese árbol con receipt y verifica launcher y árbol antes de las ejecuciones gestionadas. Un `playwright-cli` global o una invocación `pnpm dlx` **no** ofrecen esa garantía y nunca son fallback. La caché del navegador pertenece a Playwright; uninstall y update no borran perfiles, cookies, storage state, trazas ni capturas.

- **Playwright CLI** (recomendado): `install --playwright` selecciona el último release estable del proveedor en ese momento, verifica el árbol gestionado, descarga Chromium desde ese árbol y comprueba un arranque headless local de `about:blank` antes de guardar el opt-in. Úsalo mediante `jorgex-stack browser playwright <args>` (o el dispatcher empaquetado `jorgex-stack-playwright` para el handoff Pi confiable), no mediante un binario global. Usa una sesión `-s=<nombre>` propia, `snapshot`, comprueba resultados y cierra solo tu sesión.
- **Chrome DevTools MCP** (diagnóstico avanzado): desactivado por defecto y seleccionado por runtime. Stack usa launcher local verificado y conserva `--isolated --redact-network-headers --no-performance-crux --no-usage-statistics`. La redacción de cabeceras no cubre los cuerpos request/response; evita sesiones sensibles. Esta integración no descarga Chrome.
- **Pi**: el paquete compatible publicado acepta un handoff Playwright v2 con SHA del dispatcher Stack, launcher y árbol. Stack lo proyecta solo con receipt browser verificado, selección explícita y declaración `contract/browser-handoffs.v1.json` del Pi instalado; un Pi antiguo sin ella bloquea v2/v3 sin deducir soporte por versión. El lector v1 permanece para receipts antiguos, no como fallback nuevo. En Windows Pi ejecuta el `.js` autenticado con Node sin shell. DevTools v3 también es byte-bound.

```bash
# Interactivo: el cursor Playwright parte en No.
pnpm dlx jorgex-stack install
# Opt-in no interactivo explícito para los runtimes de archivo seleccionados.
pnpm dlx jorgex-stack install --yes --playwright --playwright-runtimes=opencode,claude-code
# Ejecución gestionada tras la activación.
jorgex-stack browser playwright -s=mi-tarea open --browser=chromium https://example.com
jorgex-stack browser playwright -s=mi-tarea snapshot
jorgex-stack browser playwright -s=mi-tarea close
# DevTools es independiente y opcional.
pnpm dlx jorgex-stack install --devtools
```

`sync` revalida el receipt local sin resolver ni descargar paquetes browser y retira la guía si el estado gestionado falla. `doctor` revisa receipt, versión, caché Chromium y arranque headless local sin reparar. `update --check` observa solo estado local; `install` o `update` interactivo deliberados pueden adquirir un nuevo release verificado. `uninstall` conserva por defecto el árbol gestionado y los datos del navegador; `--remove-playwright` desactiva preferencia y guía con backup, sin retirar un CLI global ajeno. Una preferencia ilegible bloquea mutaciones y `doctor` señala su ruta. Con `--target-dir` Stack no toca el estado browser del HOME real. Consulta [automatización de navegador](docs/references/browser-automation.md) para receipts, reparación y handoffs Pi.

### Update: Interactive Flow

`update` manages three sources for the end user, plus a maintainer-only one:

1. **Stack** (jorgex-stack): detects whether it is a git clone or a global install, then offers an update with confirmation.
2. **Engram** (binary): detects the installed version and offers an update through the **native channel** only with explicit confirmation. The database and memories are never touched, and Stack does not replace an existing binary as part of runtime setup.
3. **Playwright CLI** (solo si se habilitó explícitamente): compara el receipt local autenticado con la observación guardada, muestra el drift del proveedor en el selector interactivo y exige una segunda confirmación. Prepara y verifica el release seleccionado, promociona el árbol gestionado y comprueba Chromium; no actualiza ni elimina un CLI global.
4. **Vendored skills** (maintainer only): third-party skills ship **pinned** with the stack version, so the installed package never reaches out to their upstreams. Only when running from a git clone (`pnpm cli update`) does `update` scan the upstreams in `upstreams.json`, download to a temp directory, **show a mandatory diff**, and ask for confirmation. A moved upstream is only a candidate until that review is accepted and a deliberate re-pin is made for a future release; it is never treated as an accepted official update automatically. Skills with local changes (`modified: true`) warn and require double confirmation.

Usage:
- `update --check`: scans versions without applying changes.
- `update` (TTY, without `--yes`): interactive multiselect with visible diffs and step-by-step confirmations.
- `update --yes` or non-TTY: behaves like `--check` (report only).

GitHub authentication: requests use `GH_TOKEN`/`GITHUB_TOKEN` from the environment or, if unavailable, the token from your `gh` CLI session (`gh auth token` — local read only, never logged or persisted). Without a token, GitHub limits parallel requests and some upstreams may appear as "offline".

### OpenCode Goal Mode retirado

Goal Mode de OpenCode se ha retirado. Stack ya no instala su plugin ni el comando `/goal`; la continuidad de trabajo usa el lifecycle normal: `work/{name}/PRD.md` y `plan.md` permanecen durante los merges intermedios, `work/{name}/pr/{NN}` conserva cada checkpoint y `work/{name}/done` queda reservado para el cierre final.

La retirada no migra el historial. `sync` sólo puede retirar archivos gestionados cuando dispone de un manifest legible que registre esas rutas como gestionadas y un inventario completo, con backup previo; conserva los datos existentes en `~/.jorgex-stack/goals` y los plugins ajenos cuando el manifest del Stack está íntegro. El registro local no autentica la propiedad ni corrige una lista `owned` editada o inconsistente: si falta, no se puede parsear o el inventario es incompleto, no se borra el legacy. Ante sospecha sobre el manifest, no ejecutes `sync`; revísalo o restáuralo con backup. `--target-dir` no implica limpiar ese estado.

La continuidad entre checkpoints sigue requiriendo trabajo aprobado, capacidades disponibles y merge humano explícito. PiGoal conserva su propio lifecycle. No se afirma disponibilidad de una alternativa GoalV2 de OpenCode.

## Status

The CLI is complete and the real migration has been executed; the stack is the only configuration source. Versions are published automatically to [npm](https://www.npmjs.com/package/jorgex-stack) according to the flow described in [Publishing](#publishing).

## Publishing

Releases are triggered by push/merge to `main` and GitHub Actions; there is also a recovery `workflow_dispatch` on `main` with an optional `release_sha`. `validate` resolves the target SHA once and exposes it as `target_sha`; `bump` reuses that SHA. If you do not pass `release_sha`, `validate` pins `target_sha` to `origin/main` after `fetch`; if you do pass it, it must be a full 40-hex SHA that belongs to `main` or the workflow fails red with recovery instructions. Running without `release_sha` is only valid to publish `origin/main` when the version does not exist on npm yet; if the version already exists and the tag is missing, the workflow fails and requires `workflow_dispatch` with `release_sha=<published sha>`. If the diff mixes publishable changes with `.github/workflows/*`, a normal push remains eligible for the automatic patch bump when the current version already exists on npm and the commit is not a release bump; when that automatic path is not eligible, the workflow stops before direct publish/tag because GitHub may reject the tag push without workflow permissions. Split the release or use manual publish/tag with elevated permissions. `pnpm publish` is not used and npm login is not required. La política común de runtime y caché de Actions está en [docs/references/testing.md](docs/references/testing.md#runtime-y-caché-de-actions); aquí se mantiene solo el detalle específico del publish:

Antes de instalar cualquier dependencia, `validate` ejecuta un preflight sin dependencias con Node 24 después de resolver el checkout. En un push normal solo puede omitir los pasos de validación costosos y `bump` cuando existe un tag `v<package.version>` válido y alcanzable que proporciona la base acumulada, y ese diff no contiene rutas publicables. Si falta el tag, el commit es un bump de release o anti-loop, la ejecución es `workflow_dispatch` o se proporciona `release_sha`, se mantiene el flujo completo; las refs inválidas, un tag que no sea ancestro o un error de `git diff` fallan en rojo, sin omitir silenciosamente. El preflight compara contra el tag de release de la versión actual (`v<package.version>`), no solo contra el último commit; si ese tag falta, no recurre a otro tag para justificar el skip y mantiene el flujo completo. Un diff que mezcla `.github/workflows/*` con rutas publicables mantiene el flujo completo; cuando el auto-bump es elegible, sigue permitido, y en los demás casos se conserva la guarda existente de permisos del workflow.

El preflight condiciona únicamente la preparación de toolchain, la instalación de dependencias, typecheck/tests/build/upload y `bump`; las guardas existentes de registry, publicación y tag siguen siendo autoridad. `validate` y `bump` declaran `contents: read`; `bump` obtiene además un token temporal del release App para el único push del bump. `publish` conserva `contents: read` + `id-token: write` para trusted publishing de npm y `tag-release` usa `GITHUB_TOKEN` con `contents: write` para el tag. Los checkouts de solo lectura usan `persist-credentials: false`, `validate`, `bump` y `publish` tienen timeout de 10 min, `tag-release` de 5 min, y el grupo de concurrencia mantiene `cancel-in-progress: false` (no cancela una ejecución en curso; una pendiente sí puede ser reemplazada). Esto es una optimización interna de CI, no una política portable de testing ni una afirmación de ahorro de facturación medido.

- **Automatic patch**: if the push to `main` contains publishable changes and the current `package.json` version already exists on npm, the workflow finds the first free patch (`x+1`, `x+2`, ...), commits `chore(release): bump version to v...`, and publishes. If tag `v<package.version>` already exists, it uses that point as the accumulated base; otherwise, it falls back to `github.event.before`. Obsolete runs are aborted after `git fetch origin main --tags` if `origin/main` no longer matches `GITHUB_SHA`.
- **Automatic patch guard**: before committing or pushing an automatic bump, the workflow validates the real working-tree/index diff. Only the expected `version` change in the root `package.json` is allowed; unrelated tracked, staged or untracked files, other package metadata, or an unexpected version fail closed. The bot's automatic bump commit carries the single `[skip ci]` marker to prevent a recursive publish run; manual minor/major bumps do not use that marker. This guard does not create a second push and does not skip the real validation gate that produced the candidate.
- **Manual recovery**: a manual run on `main` with `release_sha` publishes that SHA if it does not exist on npm yet, without bumping again; if the version already exists on npm but tag `v<version>` is missing, the workflow fails and forces a rerun with `release_sha=<published sha>` to avoid tagging `origin/main`. `release_sha` must be a full 40-hex SHA and belong to `main`; mutable refs (`main`, tags, `main~1`) are rejected. If you do not pass `release_sha`, `validate` resolves `origin/main` once, exposes it as `target_sha`, and `bump` uses that validated SHA. Recovery does not bypass the `.github/workflows/*` guard: if the diff mixes workflows with publishable changes, split the release or perform the tag/publish manually with elevated permissions. If there is no reachable previous release tag to reconstruct the range, the workflow fails closed and requires manual intervention.
- **Rejected rerun recovery**: if a run is rejected because it is a rerun (GITHUB_RUN_ATTEMPT), do not rerun that execution. Start a new `workflow_dispatch` on `main` with `release_sha` set to the accepted/published SHA that still needs publication or tagging; the new workflow validates that immutable SHA before mutating anything.
- **No release**: changes only in `work/`, `worktrees/`, tests, or docs (`README.md`, `docs/`) do not create a release. The publishable set that does trigger one is `src/`, `stack/`, `upstreams.json`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and `tsup.config.ts`.
- **Manual minor and major**: explicit bump in `package.json` in the PR (the workflow detects that the next patch already exists on npm and requires the bump).
- **OIDC / trusted publishing**: the publishing job uses `id-token: write` and `setup-node` `registry-url`; it has no repository-write permission. The `bump` job mints a short-lived GitHub App token only for `jorgex-stack`, from the `stack-release` environment, with `contents: write`, and uses it for the checkout/push of the automatic bump; its job-level `GITHUB_TOKEN` remains read-only. `tag-release` uses the ordinary `GITHUB_TOKEN` with `contents: write` and does not use the App or OIDC. There is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` in any secret. `tag-release` only runs if `publish` was `success` or `skipped` with `tag_needed=true`, and keeps its SHA validation as the final defense. The only exception to the "always pnpm" rule is `npm pack --dry-run --ignore-scripts` and `npm publish --ignore-scripts --provenance` in the final step, for registry compatibility and hardening.

### Release App y smoke manual de acceso

El job `bump` usa la action oficial `actions/create-github-app-token` fijada a un commit (no `latest`), antes del checkout; los pasos Node del workflow usan Node 24. El token se solicita para el repositorio exacto y la operación de release solo admite `main`; no se usa ese token para tags. El entorno `stack-release` debe permitir únicamente despliegues desde la rama `main`, sin reglas para tags; el guard del workflow no sustituye esta barrera de acceso a secretos. Define la variable no sensible `STACK_RELEASE_APP_CLIENT_ID` y el secreto `STACK_RELEASE_APP_PRIVATE_KEY`; sus valores solo deben configurarse en ese entorno. No pongas valores, PEM, copias del secreto ni IDs de instalación en el repositorio, la documentación, el portapapeles o los logs. Una rotación de la clave requiere autorización específica nueva y debe cargarse desde un gestor seguro o por stdin fuera del checkout, retirando cualquier copia temporal conforme a esa autorización.

El workflow [`release-app-check.yml`](.github/workflows/release-app-check.yml) es un smoke manual de **autenticación y alcance**, no una publicación ni una prueba de escritura: solo se puede despachar sobre `main`, usa `stack-release`, crea el mismo token acotado a un repositorio y hace un `GET` de `/installation/repositories` con `gh api`; no hace checkout, instala dependencias, ejecuta tests/build, hace push, crea tags ni publica en npm. Tras incorporar el workflow a la rama por defecto, ejecútalo únicamente sobre `main`:

```text
gh workflow run release-app-check.yml --ref main
gh run watch <run-id> --exit-status
gh run view <run-id> --json event,headBranch,headSha,status,conclusion,jobs
```

En el resultado comprueba `event=workflow_dispatch`, `headBranch=main`, la lane única y el paso que confirma que el token expone exactamente el repositorio esperado. Ese readback comprueba el alcance del token emitido en esa ejecución; no certifica que una futura edición de la instalación conserve la misma lista de repositorios. No uses el `workflow_dispatch` de `publish.yml` como smoke de credenciales: ese flujo puede publicar o crear el tag. El entorno `stack-release` debe mantener el bypass de administradores desactivado (`can_admins_bypass: false`); esto no configura branch protection ni un **Quality gate** requerido. Cualquier activación debe hacerse aparte, con autorización específica y solo después de verificar el acceso del App y el check real.

La integración de este App pertenece al release del repositorio Stack. No concede acceso al repositorio Pi, no publica el paquete Pi ni sustituye su snapshot, paridad, procedencia o smoke nativo; esta pieza no modifica esos artefactos y por tanto no añade impacto de paridad Pi.

## Development

Requirements: Node >= 22.5 and pnpm (never npm).

pnpm 11 dependency resolution uses `minimumReleaseAge=1440` by default, with `minimumReleaseAgeExclude` for `jorgex-stack` and `jorgex-pi`. Keep that exclusion in the user-level pnpm config for `pnpm dlx` launched from HOME and in each repository workspace config for local commands; preserve every unrelated existing setting. This documents the maintainer environment and does not change other users' global configuration.

```
pnpm install
pnpm build        # tsup -> dist/
pnpm typecheck
pnpm test         # vitest
pnpm cli --help
```
