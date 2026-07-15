# JorgeX Stack

Portable multi-agent harness: one configuration source — 15 agents, 19 skills, hooks, persistent memory ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs, and system prompt — installable with one command in **Claude Code**, **Codex CLI**, and **OpenCode**.

> Inspired by [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), rebuilt for the JorgeX stack.

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
pnpm dlx jorgex-stack update --check  # report available stack, Engram and skill updates
pnpm dlx jorgex-stack update          # interactively review and apply available updates
pnpm dlx jorgex-stack restore --list  # list automatic backups
pnpm dlx jorgex-stack restore <id>    # restore one backup
pnpm dlx jorgex-stack uninstall       # remove managed files; keep Engram data intact
```

For development from a clone, run the same commands through `pnpm cli <command>` (see [Development](#development)).

Every command supports `--dry-run`, `--yes`, and `--target-dir <dir>` for testing without touching the real config. Writes create automatic backups and verify idempotency; merges into user config are surgical (marked markdown sections, JSON/TOML upserts), so user-owned content is never touched.

Runtime defaults are documented in [docs/references/permissions.md](docs/references/permissions.md) for permissions and [docs/references/models.md](docs/references/models.md) for provider-aware model selection, Codex tiers, and orchestrator inheritance. OpenCode has no provider defaults.

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

  This installs into all detected runtimes. To be explicit, add `--agents opencode,claude-code,codex` or a comma-separated subset. Always pass `--mode programmatic`; without `--mode`, `--yes` and non-TTY installs default to `human`.

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

### Browser automation

Browser automation is opt-in and explicit. The legacy `agent-browser` integration has been removed; rely on the two surfaces below.

- **Playwright CLI** (recommended): `@playwright/cli@0.1.17` plus a vendored skill that ships pinned with the stack. The skill is loaded on demand, contributes no permanent MCP schemas, and declares `allowed-tools: Bash(playwright-cli:*)` only (no `Bash(pnpm:*)`). This is the skill's declaration, not a security boundary: effective permissions still come from the adapter/runtime, and OpenCode/full-bash may expose broader Bash or other capabilities. See [docs/references/browser-automation.md](docs/references/browser-automation.md) for the full lifecycle, the security profile and troubleshooting.
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

Under the hood, `--playwright` runs two `pnpm` argv-only plans back to back: `pnpm add --global @playwright/cli@0.1.17` (the package) and then `pnpm dlx @playwright/cli@0.1.17 install-browser` (the browser binary cache). Removal is `pnpm remove --global @playwright/cli` (no version suffix). If installation fails, the error identifies the failed phase — global package, browser download, or preference persistence — and recommends `jorgex-stack install --playwright`; the preference is not marked enabled unless the complete plan succeeds.

Daily operation:

- `sync` reconciles configuration without installing global tools or browsers; if Playwright is enabled but the binary or browser cache is `missing`, it warns and points to `install --playwright`; if the cache is `unreadable`, the warning includes its resolved path and filesystem error code. The cache probe retains the path for both states and an error code when the filesystem provides one. Under `--target-dir`, `sync`/`install`/`uninstall` never read or write the real browser state (`~/.jorgex-stack/playwright-cli.json` and `~/.jorgex-stack/devtools-mcp.json` are untouched, `detectPlaywrightCli()` is not called, no MCP ownership is persisted).
- `doctor` reports the Playwright CLI state (`disabled`, `healthy`, `missing:package`, `missing:browser`, `unreadable`, `broken`, `outdated`) without opening sites or repairing state. An `unreadable` browser cache includes its exact path and filesystem error code so permissions or another local cause can be investigated. If either preference file is corrupt, doctor prints the exact path and the remedy (`Corrige o borra ese archivo antes de reintentar`) before any other browser check; in that case `install`/`uninstall`/`update`/`update --check` will abort with exit 1 until the file is fixed, so the corruption cannot be reconciled destructively.
- `update --check` only inspects Playwright CLI when its preference is `enabled` (a binary appearing in `PATH` is not consent). It compares the installed version against the approved pin `0.1.17` — it does not consult npm latest, and a Playwright CLI binary-only update does not require `sync` afterwards.
- `uninstall` preserves the global `@playwright/cli` package and all browser data by default; `--remove-playwright` removes the package only (never the browser cache, profiles, cookies, storage state, traces, screenshots or videos). If `pnpm remove --global @playwright/cli` exits non-zero, `uninstall` reports the failure instead of a success outro. For DevTools MCP, ownership is released only after the corresponding unmerge is applied; if no unmerge action is written, the ownership marker is preserved for a later retry.
- `install`/`sync` also inject (and `disable`/`uninstall` remove) a marked section `<!-- jorgex:browser -->` in `AGENTS.md` (OpenCode, Codex) or `CLAUDE.md` (Claude Code): the section only contains Playwright guidance when its setup succeeded, and DevTools guidance only in the runtimes that selected it; the rest of the file outside the markers is preserved. `--target-dir` never reads the real preferences, so by default no section is emitted in target-dir runs — but explicit flags like `--devtools` simulate the MCP entry (and the corresponding DevTools block of the section) inside the temp target without touching the real global state, and `install --dry-run --playwright` projects the Playwright section into the plan preview without installing anything. If the post-setup reconciliation of the system prompt leaves the section in a partial state, the CLI exits non-zero and recommends `jorgex-stack sync` to repair it; the package and the preference stay installed. See [docs/references/browser-automation.md](docs/references/browser-automation.md) §2.7 for the full lifecycle.

### Update: Interactive Flow

`update` manages three sources for the end user, plus a maintainer-only one:

1. **Stack** (jorgex-stack): detects whether it is a git clone or a global install, then offers an update with confirmation.
2. **Engram** (binary): detects the installed version and offers an update through the **native channel** (brew -> `go install` -> release URL). Nothing needs to be stopped: as in upstream macOS/Linux, live processes keep using the old version until clients restart; on Windows, the in-use `.exe` is rotated by rename before installation. **Automatic DB backup before updating**. The database and memories are never touched.
3. **Playwright CLI** (only when explicitly enabled): compares the detected binary with the approved bundle pin and offers to realign it with explicit confirmation. The realignment re-applies **both** plans — `pnpm add --global @playwright/cli@0.1.17` (package) and `pnpm dlx @playwright/cli@0.1.17 install-browser` (browser cache) — and fails closed if either step returns non-zero. The error identifies whether the package-update or browser-download phase failed and recommends `jorgex-stack install --playwright` to retry both; a Playwright update does not require `sync`.
4. **Vendored skills** (maintainer only): third-party skills ship **pinned** with the stack version, so the installed package never reaches out to their upstreams. Only when running from a git clone (`pnpm cli update`) does `update` scan the upstreams in `upstreams.json`, download to a temp directory, **show a mandatory diff**, and ask for confirmation — so the review and re-pin persist in the repo and get published. Skills with local changes (`modified: true`) warn and require double confirmation.

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

Releases are triggered by push/merge to `main` and GitHub Actions; there is also a recovery `workflow_dispatch` on `main` with an optional `release_sha`. `validate` resolves the target SHA once and exposes it as `target_sha`; `bump` reuses that SHA. If you do not pass `release_sha`, `validate` pins `target_sha` to `origin/main` after `fetch`; if you do pass it, it must be a full 40-hex SHA that belongs to `main` or the workflow fails red with recovery instructions. Running without `release_sha` is only valid to publish `origin/main` when the version does not exist on npm yet; if the version already exists and the tag is missing, the workflow fails and requires `workflow_dispatch` with `release_sha=<published sha>`. If the diff mixes publishable changes with `.github/workflows/*`, auto-release stops before bump/publish because GitHub may reject the tag push without workflow permissions; split the release or use manual publish/tag with elevated permissions. `pnpm publish` is not used and npm login is not required:

- **Automatic patch**: if the push to `main` contains publishable changes and the current `package.json` version already exists on npm, the workflow finds the first free patch (`x+1`, `x+2`, ...), commits `chore(release): bump version to v...`, and publishes. If tag `v<package.version>` already exists, it uses that point as the accumulated base; otherwise, it falls back to `github.event.before`. Obsolete runs are aborted after `git fetch origin main --tags` if `origin/main` no longer matches `GITHUB_SHA`.
- **Manual recovery**: a manual run on `main` with `release_sha` publishes that SHA if it does not exist on npm yet, without bumping again; if the version already exists on npm but tag `v<version>` is missing, the workflow fails and forces a rerun with `release_sha=<published sha>` to avoid tagging `origin/main`. `release_sha` must be a full 40-hex SHA and belong to `main`; mutable refs (`main`, tags, `main~1`) are rejected. If you do not pass `release_sha`, `validate` resolves `origin/main` once, exposes it as `target_sha`, and `bump` uses that validated SHA. Recovery does not bypass the `.github/workflows/*` guard: if the diff mixes workflows with publishable changes, split the release or perform the tag/publish manually with elevated permissions. If there is no reachable previous release tag to reconstruct the range, the workflow fails closed and requires manual intervention.
- **No release**: changes only in `work/`, `worktrees/`, tests, or docs (`README.md`, `docs/`) do not create a release. The publishable set that does trigger one is `src/`, `stack/`, `upstreams.json`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and `tsup.config.ts`.
- **Manual minor and major**: explicit bump in `package.json` in the PR (the workflow detects that the next patch already exists on npm and requires the bump).
- **OIDC / trusted publishing**: the publishing job uses `id-token: write` and `setup-node` `registry-url`; the bump/push job only has `contents: write`; `tag-release` only writes `contents` and does not use OIDC. There is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` in any secret. `tag-release` only runs if `publish` was `success` or `skipped` with `tag_needed=true`, and keeps its SHA validation as the final defense. The only exception to the "always pnpm" rule is `npm pack --dry-run --ignore-scripts` and `npm publish --ignore-scripts --provenance` in the final step, for registry compatibility and hardening.

## Development

Requirements: Node >= 22.5 and pnpm (never npm). Goal Mode uses `node:sqlite` in tests/Node CLI and OpenCode uses `bun:sqlite` at runtime.

```
pnpm install
pnpm build        # tsup -> dist/
pnpm typecheck
pnpm test         # vitest
pnpm cli --help
```
