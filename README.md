# JorgeX Stack

Portable multi-agent harness: one configuration source — 15 agents, 17 skills, hooks, persistent memory ([Engram](https://github.com/Gentleman-Programming/engram)), MCPs, and system prompt — installable with one command in **Claude Code**, **Codex CLI**, and **OpenCode**.

> Inspired by [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), rebuilt for the JorgeX stack.

## Usage

Install and run via npm without cloning the repository:

```
pnpm dlx jorgex-stack install    # apply config to your runtimes (interactive pick; idempotent, removes orphans)
pnpm dlx jorgex-stack models     # model picker by runtime and tier (strong/standard/cheap)
pnpm dlx jorgex-stack sync       # alias of install (same idempotent apply)
pnpm dlx jorgex-stack doctor     # checks that everything is healthy (Engram, drift, hooks, keys)
pnpm dlx jorgex-stack update     # interactive: scans stack + Engram, multiselect, diff/confirm
                                 # With --check: report only, no changes
                                 # With --yes: batch mode (report only)
pnpm dlx jorgex-stack restore    # restores a backup
pnpm dlx jorgex-stack uninstall  # uninstalls our files and keeps user data (Engram intact)
```

For development from a clone, run the same commands through `pnpm cli <command>` (see [Development](#development)).

Every command supports `--dry-run`, `--yes`, and `--target-dir <dir>` for testing without touching the real config. Writes create automatic backups and verify idempotency; merges into user config are surgical (marked markdown sections, JSON/TOML upserts), so user-owned content is never touched.

Runtime defaults are documented in [docs/references/permissions.md](docs/references/permissions.md) for permissions and [docs/references/models.md](docs/references/models.md) for model selection, GPT-5.6 subagent tiers, and orchestrator inheritance.

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

### Update: Interactive Flow

`update` manages two sources for the end user, plus a maintainer-only one:

1. **Stack** (jorgex-stack): detects whether it is a git clone or a global install, then offers an update with confirmation.
2. **Engram** (binary): detects the installed version and offers an update through the **native channel** (brew -> `go install` -> release URL). Nothing needs to be stopped: as in upstream macOS/Linux, live processes keep using the old version until clients restart; on Windows, the in-use `.exe` is rotated by rename before installation. **Automatic DB backup before updating**. The database and memories are never touched.
3. **Vendored skills** (maintainer only): third-party skills ship **pinned** with the stack version, so the installed package never reaches out to their upstreams. Only when running from a git clone (`pnpm cli update`) does `update` scan the upstreams in `upstreams.json`, download to a temp directory, **show a mandatory diff**, and ask for confirmation — so the review and re-pin persist in the repo and get published. Skills with local changes (`modified: true`) warn and require double confirmation.

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
