# JorgeX Stack

Portable multi-agent harness: one configuration source — 15 agents, 18 skills, hooks, persistent memory ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs, and system prompt — installable with one command in **Claude Code**, **Codex CLI**, **OpenCode**, and **Pi**.

> Inspired by [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), rebuilt for the JorgeX stack.

## Skills: release snapshot and supply chain

The 1.9.2 release carries a fixed **18-skill snapshot**: **6 stack-owned** skills and **12 vendored** skills. Runtime adapters execute only the local copies committed under `stack/skills`; they do not fetch, install, or execute upstream content at runtime.

| Set | Skills |
| --- | --- |
| Stack-owned (6) | `agent-delegation`, `lean-code`, `orchestrator`, `work-audit`, `work-lifecycle`, `xreview` |
| Vendored (12) | `deploy-to-vercel`, `diagnose`, `find-skills`, `mcp-builder`, `playwright-cli`, `react-doctor`, `skill-creator`, `supabase`, `supabase-postgres-best-practices`, `tdd`, `to-issues`, `to-prd` |

The supply-chain contract is deliberately explicit:

- **Snapshot:** the 18 directories above are the release input. A published package ships this snapshot instead of a live mirror of any upstream.
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

Every command supports `--dry-run`, `--yes`, and `--target-dir <dir>` for testing without touching the real config. Writes create automatic backups and verify idempotency; merges into user config are surgical (marked markdown sections, JSON/TOML upserts), so user-owned content is never touched.

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

Pi combines the frozen **snapshot v2** package with a Stack-owned shared projection. The published Stack `1.9.5` recognizes the exact package **`jorgex-pi@0.8.3`**. The Stack `1.9.6` candidate prepares adoption of the published package **`jorgex-pi@0.8.4`**, but `1.9.6` is not published yet.

The current published command set uses Stack `1.9.5` with Pi `0.8.3`:

```bash
pnpm dlx jorgex-stack@1.9.5 install --agents pi
pnpm dlx jorgex-stack@1.9.5 doctor --agents pi
pnpm dlx jorgex-stack@1.9.5 models --agents pi
pnpm dlx jorgex-stack@1.9.5 sync --agents pi
pnpm dlx jorgex-stack@1.9.5 uninstall --agents pi
```

Stack downloads the frozen registry tarball, verifies its exact size plus SHA-256/SHA-512, backs up Pi's `settings.json`, and only then asks Pi to install that local file. The historical `0.8.0` tarball was `89128340` bytes; the exact current artifact and integrity values are authoritative in `src/lib/pi-runtime.ts`. Pi's own package-manager invocation is the narrow runtime exception to the repository's pnpm-only rule; the Stack lifecycle never launches npm directly. After the package is healthy, Stack projects the shared resources into Pi: marked `jorgex:system-prompt` and `jorgex:engram-protocol` sections in `~/.pi/agent/AGENTS.md`, canonical skills under `~/.agents/skills`, and `~/.pi/agent/prompts/lean-audit.md`. When the managed Playwright preference is active, the projection also adds or removes the marked `jorgex:browser` section dynamically. The Pi-only `install --agents pi --playwright` flow installs and persists that Playwright capability just like the other harnesses. Chrome DevTools MCP and Context7 remain outside the Pi scope. The published `1.9.5` entry remains `{ "source": "npm:jorgex-pi@0.8.3", "skills": [], "prompts": [] }`; the `1.9.6` candidate changes that entry to `{ "source": "npm:jorgex-pi@0.8.4", "skills": [], "prompts": [] }`. Its code already recognizes the 0.8.4 receipt, while published-channel commands must wait for Stack 1.9.6 to be published. Filters are applied only after this projection exists, so the package does not duplicate shared resources. Package ownership is recorded separately in `~/.jorgex-stack/pi-receipt.json`; projection ownership is recorded in `~/.jorgex-stack/pi-projection-receipt.json`. Both receipts are scope-bound and fail closed for manual, duplicate, divergent, partial, corrupt, copied-to-another-scope, or unknown-history state.

Historically, the published Pi 0.8.0 direct-package snapshot added `work-audit`: the snapshot grew from **17 to 18 skill trees** (96 to 97 files), and the active runtime allowlist grew from **16 to 17 skills**. `playwright-cli` remains in the snapshot but inactive because browser automation is a separate opt-in integration. The published 0.8.3 package preserves that work-audit introduction.

The historical published artifact has two separate provenance anchors. The local size/SHA-256/SHA-512 checks bind the downloaded bytes to Stack's accepted artifact; they are checks within that checkout, not independent trust roots. npm's external provenance/attestation is outside Stack runtime verification, and `provenance.commit` is informative unless that external attestation is independently verified.

The historical `0.8.0` artifact records two distinct commit identities: the release checkout and tarball producer is `9f999747df3e335947a61d38e581555367973b09` (`main`, release `0.8.0`); and the Stack parity source is `11e7666ea4e40bde1de8bc434610747eb797ab9c`. Registry metadata has no `gitHead`; README does not invent a separate source identity, attestation or signature.

Install, sync and uninstall back up every managed file before changing it and are idempotent. `doctor` reports package and projection drift without repairing it. Uninstall removes only receipt-owned package/projection state, retains shared files also owned by another runtime, and preserves user content outside marked sections. Engram remains user-owned and is never removed; the receipts only carry the verified executable hand-off required by the package.

The package owns Pi's native primary-model projection: `openai-codex/gpt-5.6-sol`, with a local `contextWindow` request of 872K. It merges only missing compatible fields, records field ownership in `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`, and cleanup removes only still-owned canonical values. Stack does not duplicate that package-owned settings/models logic. The 872K value is local OAuth metadata until a real long-context smoke test confirms backend acceptance; it is not the API context limit.

Engram remains mandatory and user-owned. An existing binary is preserved. Interactive install may offer the native `brew`/`go`/release channel with explicit confirmation; `--yes` and non-TTY installs fail with a remedy when Engram is absent. The database and memories are never updated or deleted, and uninstall never deletes the Engram binary. Under `--target-dir`, Stack accepts only `<target>/bin/engram`, isolates Pi/Home/XDG/AppData/temp/npm-cache paths inside the target, and never consults the host Engram or Pi configuration.

The published Stack `1.9.5` recognizes the exact Pi receipt `npm:jorgex-pi@0.8.3`. The Stack `1.9.6` candidate code already recognizes `npm:jorgex-pi@0.8.4`; consuming that pairing through the published channel waits until Stack `1.9.6` is published. Use exact versions, never `latest`, and never edit receipts or hashes or delete `HOME`, Engram, or another runtime's projection to force trust. The transition and rollback commands are in [docs/references/pi-runtime.md](docs/references/pi-runtime.md).

Stack 1.9.5 → Pi 0.8.3 is the current published pairing. Stack 1.9.6 → Pi 0.8.4 is only a candidate until Stack 1.9.6 is published. The 24-hour managed-consumption maturity rule applies only to real installation or consumption of the new Pi package; development, PR validation, merge and Stack publication may proceed immediately. Installing it on a real user scope before the maturity window requires Jorge's explicit exception.

`update --agents pi` only runs the Pi package lifecycle; it does not enter the global Stack updater. `update --check --agents pi` is a read-only Pi doctor. Uninstall runs package cleanup, backs up Pi's settings before removal, removes only the exact receipt-owned package after verifying absence, and preserves all companion/user state. Full behavior, failure states and troubleshooting are in [docs/references/pi-runtime.md](docs/references/pi-runtime.md).

### Browser automation

Browser automation is opt-in and explicit. The legacy `agent-browser` integration has been removed; rely on the two surfaces below.

- **Playwright CLI** (recommended): `@playwright/cli@0.1.18` plus a vendored skill that ships pinned with the stack. The skill is loaded on demand, contributes no permanent MCP schemas, and declares `allowed-tools: Bash(playwright-cli:*)` only (no `Bash(pnpm:*)`). This is the skill's declaration, not a security boundary: effective permissions still come from the adapter/runtime, and OpenCode/full-bash may expose broader Bash or other capabilities. See [docs/references/browser-automation.md](docs/references/browser-automation.md) for the full lifecycle, the security profile and troubleshooting.
- **Chrome DevTools MCP** (advanced diagnostics, opt-in): exposes ~29 tools and ~5,800–7,700 tokens of schemas in full mode. Disabled by default, selected per runtime, version-pinned, and launched with a fixed argv `pnpm dlx chrome-devtools-mcp@1.6.0 --isolated --redact-network-headers --no-performance-crux --no-usage-statistics`. `--isolated` starts Chrome with an ephemeral, isolated profile that is deleted when Chrome closes (no persistent dedicated profile, no shared cookies/extensions/sessions with your personal Chrome); `--redact-network-headers` redacts sensitive headers in captured network traffic, but not request/response bodies, which may contain tokens or PII. Avoid authenticated sessions or sensitive data, or disable network capture manually outside the stack when needed. `--no-performance-crux` disables CrUX reporting; `--no-usage-statistics` disables telemetry. `--slim` and Playwright MCP are intentionally excluded.

Setup that respects the zero-secrets, pnpm-only and explicit-consent rules:

```bash
# Interactive (TTY): the install prompt suggests Playwright CLI but defaults to "No" (opt-in consent). Press `y` to install.
pnpm dlx jorgex-stack install

# Non-interactive / agent: --playwright authorizes the global install.
pnpm dlx jorgex-stack install --yes --playwright

# Enable Chrome DevTools MCP explicitly per runtime.
pnpm dlx jorgex-stack install --devtools
pnpm dlx jorgex-stack install --no-devtools
```

Under the hood, `--playwright` runs two `pnpm` argv-only plans back to back: `pnpm add --global @playwright/cli@0.1.18` (the package) and then `pnpm dlx @playwright/cli@0.1.18 install-browser` (the browser binary cache). Removal is `pnpm remove --global @playwright/cli` (no version suffix). If installation fails, the error identifies the failed phase — global package, browser download, or preference persistence — and recommends `jorgex-stack install --playwright`; the preference is not marked enabled unless the complete plan succeeds.

Daily operation:

- `sync` reconciles configuration without installing global tools or browsers; if Playwright is enabled but the binary or browser cache is `missing`, it warns and points to `install --playwright`; if the cache is `unreadable`, the warning includes its resolved path and filesystem error code. The cache probe retains the path for both states and an error code when the filesystem provides one. Under `--target-dir`, `sync`/`install`/`uninstall` never read or write the real browser state (`~/.jorgex-stack/playwright-cli.json` and `~/.jorgex-stack/devtools-mcp.json` are untouched, `detectPlaywrightCli()` is not called, no MCP ownership is persisted).
- `doctor` reports the Playwright CLI state (`disabled`, `healthy`, `missing:package`, `missing:browser`, `unreadable`, `broken`, `outdated`) without opening sites or repairing state. An `unreadable` browser cache includes its exact path and filesystem error code so permissions or another local cause can be investigated. If either preference file is corrupt, doctor prints the exact path and the remedy (`Corrige o borra ese archivo antes de reintentar`) before any other browser check; in that case `install`/`uninstall`/`update`/`update --check` will abort with exit 1 until the file is fixed, so the corruption cannot be reconciled destructively.
- `update --check` only inspects Playwright CLI when its preference is `enabled` (a binary appearing in `PATH` is not consent). It compares the installed version against the approved pin `0.1.18` — it does not consult npm latest, and a Playwright CLI binary-only update does not require `sync` afterwards.
- `uninstall` preserves the global `@playwright/cli` package and all browser data by default; `--remove-playwright` removes the package only (never the browser cache, profiles, cookies, storage state, traces, screenshots or videos). If `pnpm remove --global @playwright/cli` exits non-zero, `uninstall` reports the failure instead of a success outro. For DevTools MCP, ownership is released only after the corresponding unmerge is applied; if no unmerge action is written, the ownership marker is preserved for a later retry.
- `install`/`sync` also inject (and `disable`/`uninstall` remove) a marked section `<!-- jorgex:browser -->` in `AGENTS.md` (OpenCode, Codex) or `CLAUDE.md` (Claude Code): the section only contains Playwright guidance when its setup succeeded, and DevTools guidance only in the runtimes that selected it; the rest of the file outside the markers is preserved. `--target-dir` never reads the real preferences, so by default no section is emitted in target-dir runs — but explicit flags like `--devtools` simulate the MCP entry (and the corresponding DevTools block of the section) inside the temp target without touching the real global state, and `install --dry-run --playwright` projects the Playwright section into the plan preview without installing anything. If the post-setup reconciliation of the system prompt leaves the section in a partial state, the CLI exits non-zero and recommends `jorgex-stack sync` to repair it; the package and the preference stay installed. See [docs/references/browser-automation.md](docs/references/browser-automation.md) §2.7 for the full lifecycle.

### Update: Interactive Flow

`update` manages three sources for the end user, plus a maintainer-only one:

1. **Stack** (jorgex-stack): detects whether it is a git clone or a global install, then offers an update with confirmation.
2. **Engram** (binary): detects the installed version and offers an update through the **native channel** (brew -> `go install` -> release URL). Nothing needs to be stopped: as in upstream macOS/Linux, live processes keep using the old version until clients restart; on Windows, the in-use `.exe` is rotated by rename before installation. **Automatic DB backup before updating**. The database and memories are never touched.
3. **Playwright CLI** (only when explicitly enabled): compares the detected binary with the approved bundle pin and offers to realign it with explicit confirmation. The realignment re-applies **both** plans — `pnpm add --global @playwright/cli@0.1.18` (package) and `pnpm dlx @playwright/cli@0.1.18 install-browser` (browser cache) — and fails closed if either step returns non-zero. The error identifies whether the package-update or browser-download phase failed and recommends `jorgex-stack install --playwright` to retry both; a Playwright update does not require `sync`.
4. **Vendored skills** (maintainer only): third-party skills ship **pinned** with the stack version, so the installed package never reaches out to their upstreams. Only when running from a git clone (`pnpm cli update`) does `update` scan the upstreams in `upstreams.json`, download to a temp directory, **show a mandatory diff**, and ask for confirmation. A moved upstream is only a candidate until that review is accepted and a deliberate re-pin is made for a future release; it is never treated as an accepted official update automatically. Skills with local changes (`modified: true`) warn and require double confirmation.

Usage:
- `update --check`: scans versions without applying changes.
- `update` (TTY, without `--yes`): interactive multiselect with visible diffs and step-by-step confirmations.
- `update --yes` or non-TTY: behaves like `--check` (report only).

GitHub authentication: requests use `GH_TOKEN`/`GITHUB_TOKEN` from the environment or, if unavailable, the token from your `gh` CLI session (`gh auth token` — local read only, never logged or persisted). Without a token, GitHub limits parallel requests and some upstreams may appear as "offline".

### OpenCode Goal Mode

The normal work-lifecycle already supports multi-PR plans: `work/{name}/PRD.md` and `plan.md` stay alive across intermediate merges, `work/{name}/pr/{NN}` stores each checkpoint, and `work/{name}/done` is reserved for the final close. Goal Mode is separate: an OpenCode plugin for long-running goals, multiple sessions, multiple slices, multiple worktrees, and, when needed, multiple PRs. It is not meant for short tasks. If the change fits without extended autonomy, do not use `/goal`.

It only exists in OpenCode. Claude Code and Codex do not receive it.

Available commands:

- `/goal <goal>` — creates a persistent goal.
- `/goal status` — shows status and next action.
- `/goal plan` — shows the goal's master plan / PRD.
- `/goal history` — lists events and transitions.
- `/goal pause` — pauses the goal.
- `/goal resume` — resumes the goal.
- `/goal merged [commit]` — signals that the pending external PR has been merged.
- `/goal cancel` — cancels the goal.

What does not exist:

- `/goal quick`
- `/goal work`

Operational state:

- Separate SQLite database by default at `~/.jorgex-stack/goals/goals.sqlite`.
- Optional override with `JORGEX_GOAL_DB`, but always inside `~/.jorgex-stack/goals/`.
- Engram is not the goal's operational store: it remains memory/protocol, not the state database.
- Goal Mode does not perform automatic merges; when it must wait for an external merge, the state becomes `waiting_for_merge`.
- The integration uses experimental OpenCode hooks (`experimental.chat.system.transform` and `experimental.session.compacting`), so that surface may change.

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

Requirements: Node >= 22.5 and pnpm (never npm). Goal Mode uses `node:sqlite` in tests/Node CLI and OpenCode uses `bun:sqlite` at runtime.

```
pnpm install
pnpm build        # tsup -> dist/
pnpm typecheck
pnpm test         # vitest
pnpm cli --help
```
