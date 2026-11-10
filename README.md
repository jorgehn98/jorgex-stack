# JorgeX Stack

Shared configuration for **Claude Code, Codex CLI, OpenCode v2 and official Pi**: twenty-two local skills, no agents of its own and native integrations, applied through each runtime's own mechanisms. Stack does not install a second Pi runtime and keeps no private provider contracts or receipts.

## Quick start

You need **Node >= 22.5** and **pnpm**. Install the runtimes you want through their official channels first; Stack configures them, it does not install them.

### Run it (recommended)

```sh
pnpm dlx jorgex-stack@latest
```

This is the only command most people need. It downloads the latest published release into pnpm's temporary cache and opens the interactive menu. Nothing is installed globally and nothing is added to your `PATH`, so there is no old copy to update or remove later.

pnpm reuses that download for one day (`dlxCacheMaxAge`), so repeated runs start immediately and work offline. After a day, the next run checks the registry again and picks up a new release if there is one.

### Install it as a permanent command (optional)

```sh
pnpm add -g jorgex-stack@latest
```

This installs a global `jorgex-stack` command; run `jorgex-stack` to open the same menu. The copy stays at the version you installed: the menu's **Actualizar** action updates your runtimes' configuration, not Stack itself. To update Stack, run the same `pnpm add -g jorgex-stack@latest` again. To remove it, run `pnpm remove -g jorgex-stack`.

Use a single package manager. A second global copy installed with npm or another tool can come first in your `PATH` and run an older version without any warning.

### What opens

Both commands open the same menu, in Spanish. It takes no subcommands or flags (not even `--version` or `--yes`) and has no headless mode. Without an interactive terminal it changes no files and does not wait for input. The distribution version lives in `package.json` and in the registry, not in an installer alias.

| Menu entry | What it does |
| --- | --- |
| **Instalar / configurar** | Applies Stack's skills and configuration to the runtimes you select. |
| **Actualizar** | Updates runtime configuration through native channels and re-applies Stack's resources. |
| **Doctor** | Read-only check of the local configuration. |
| **Desinstalar** | Removes the managed resources you select, with confirmation and backup. |
| **Limpiar** | Removes leftovers from earlier versions and old backups ([details](#limpiar-cleanup)). |

The first four entries offer the sections Todo (everything), Skills compartidas (shared skills) and Configuración por runtime (per-runtime configuration). Limpiar chooses neither section nor runtime.

Pick a target and a unit, then **Aplicar**. Navigating or going back never runs an installation. A failure leaves the applied and pending units visible; there is no global rollback and no automatic retry.

**Installing skills by category.** In Todo and Skills compartidas, Instalar asks which categories to project; marking `engineering` also marks `productivity` and says so. Update never asks: it only touches the categories whose skills Stack already owns by file, and a category you unmark is neither updated nor removed (removing skills is only Desinstalar). The destination stays flat in `~/.agents/skills`.

Missing runtimes are not installed when you open a screen. Updating configuration uses native channels (`claude update`, `codex update`, `opencode upgrade`, `pi update --all` and the official package registry); updating only skills does not update tools. Doctor compares local configuration without installing, downloading, starting a browser or writing memories. It does not certify that a runtime actually loads the resources, has access to a model, or enforces permissions.

### Install individual skills

[skills.sh](https://skills.sh) can install these skills as plain folders, without the menu. Without `-g` the CLI installs into the current project instead of your user directories:

```sh
npx skills add jorgehn98/jorgex-stack -g
npx skills add jorgehn98/jorgex-stack -g --skill implementer
```

`engineering` requires `productivity`, because the orchestrator uses `to-spec`, `grilling` and `second-opinion`; the CLI has no per-category install, so add the whole repository, or the six `productivity` skills alongside the ones you choose. This route brings only the skill folders: no system prompt, Engram setup, hooks, MCP configuration or runtime files, and some skills rely on that context. It is a partial install, not a replacement for Stack. Do not mix both channels over the same skills: the CLI overwrites an existing copy in `~/.agents/skills` without warning, so each tool then reverts the other's version on its next run, and it replaces Claude Code's link with a copied directory, which Stack's Update will then reject (by reading the code; not run). See [skills.sh compatibility](docs/references/skills-sh.md).

## Shared canon

**Skills:** twenty-two local skills, grouped by category in `stack/skills/<category>/` and copied flat to `~/.agents/skills`: **engineering** (orchestrator, software-factory, implementer, analyst, reviewer, security-auditor, simplifier, xreview, diagnose, lean-code, project-architect), **productivity** (grilling, second-opinion, close, retro, what, to-spec), **marketing** (visual-director, landing-launch, organic-growth) and **agent-tooling** (skill-creator, mcp-builder). They are copied whole, with no updater for external repositories and no skill pins. Pi, Codex and OpenCode discover them natively; Claude uses one link per skill from its native path, not another copy. `engineering` requires `productivity`, because the orchestrator uses `to-spec`, `grilling` and `second-opinion`.

**Roles:** the five work roles are skills, not agents. The primary agent belongs to the runtime and loads `orchestrator`; when it delegates, it uses the runtime's general subagent and tells it which role skill to load. Stack projects no agent file and does not save models per agent. The orchestrator declares a level and effort per role, and the level-to-model ladder lives in your global instructions for each runtime: see [delegation](docs/references/delegation.md).

A single profile serves both human and programmatic use. Native APIs (SDK/CLI, Codex app-server, OpenCode v2 server, Pi RPC) allow structured operations according to each host, not a universal takeover of an open TTY. Herdr is neither installed nor configured: an existing personal integration is kept.

The canonical workflow is [orchestrator](stack/skills/engineering/orchestrator/SKILL.md) and is not duplicated here. Software Factory, Visual Director, retro, what and close keep their manual-invocation limits: `software-factory` only starts on an explicit request and stops at a draft PR, and `close` runs on `/close` or when the user says in their own words to close the session, never by the agent's own initiative. The [active Visual Director](stack/skills/marketing/visual-director/README.md) is portable; its [historical dossier](docs/research/visual-director/README.md) is not a runtime dependency and is not included in the npm package. Likewise, the [historical Landing Launch dossier](docs/research/landing-launch/README.md) is not a runtime dependency and is not packaged; it was built with material from Marketing Skills (MIT), whose notice ships in [stack/skills/marketing/landing-launch/NOTICE.md](stack/skills/marketing/landing-launch/NOTICE.md). The [historical Project Architect dossier](docs/research/project-architect/README.md) follows the same rule; its decision record template derives from MADR (`MIT OR CC0-1.0`), noted in [stack/skills/engineering/project-architect/NOTICE.md](stack/skills/engineering/project-architect/NOTICE.md). Several reference files in Landing Launch and Organic Growth adapt Marketing Skills (MIT) as well, enumerated in their notice files (the Landing Launch one above, [Organic Growth here](stack/skills/marketing/organic-growth/NOTICE.md)).

## Configuration and integrations

| Runtime | Stack resources and integration |
| --- | --- |
| Claude Code | Native subagents, skill links, `~/.agents/AGENTS.md` with a minimal bridge in `~/.claude/CLAUDE.md`, and fresh permissions; official Engram plugin/MCP. No additional browser. |
| Codex | Shared skills, global instructions and fresh permissions; official Engram plugin/hooks/MCP. No desktop browser added. |
| OpenCode v2 | Native permissions, server `opencode.json(c)`, client `cli.json`, local panel `./tui/subagents`; full official Engram setup and Browse. V1 is not supported. |
| Official Pi | Instructions, local header, MCP configuration, a fresh permission policy and the skills catalog visible to its general subagent; native extensions installed by Pi, including Engram and compact-tools. No imposed theme and no jorgex-pi installer. |

Effective paths respect each runtime's native configuration and environment variables. Context7 uses an empty placeholder so every user connects their own account; credentials are never distributed. The [writing style](docs/references/writing-style.md) is projected into all runtimes, with no programmatic overlay.

### Official Engram

Applying an installation or a configuration update resolves the **latest official stable release**. Stack verifies the live metadata of the published asset, its name and platform, size and SHA-256 before activating the binary. Without network or valid metadata it fails closed, with no static fallback. If the current binary is already up to date it is not downloaded again. An older binary is replaced only after explicit consent and a backup of the binary, without exporting memories (`engram export` remains available natively). It is installed in `~/.local/bin/engram` or the platform equivalent, without Brew or Go and without touching `~/.engram`.

Native steps (runtime updaters, package registry, Engram setup) are synchronous and can take a while. Each one is announced with a "Paso nativo en curso" line that shows only the binary, its subcommand and, when there is one, the package or plugin being processed; never paths, flags or subprocess output. In Claude Code, Engram's setup runs with `--protocol=slim` so the start hook does not repeat the protocol that the MCP instructions already deliver. If Engram already records a mode for Claude Code (`engram setup claude-code --protocol=full|slim`), Stack respects it. A fresh Claude Code `settings.json` also sets `ENGRAM_NUDGE_COOLDOWN_SECS=3600`, so the plugin's save reminder repeats at most once an hour; an existing `settings.json` is not modified.

Claude, Codex and OpenCode use the full official setup; Pi uses `gentle-engram` as native tools and hooks, not an additional Engram MCP. Stack does not patch the plugin, TypeBox or `<private>`. In OpenCode it removes, through configuration, the extra monitor `opencode-subagent-statusline` and uses its v2 panel; Engram's plugin, hooks and MCP stay intact. The upstream capture limitation with nested `<private>` is not considered fixed: [original report](https://github.com/Gentleman-Programming/engram/issues/1558#issuecomment-5896556683). Composition tests do not exercise the whole Memory Protocol or a personal Windows installation.

### Browser and delegation

**Browse** is available only in OpenCode and Pi, through the provider's official MCP and Chrome Web Store extension, and requires Node >= 22.19. It drives the user's real Chromium-family browser with explicit tab adoption and handoffs, and has no fallback to Playwright or DevTools outside it. Stack does not run the relay or attach profiles. See [limits and security](docs/references/browser-automation.md).

Delegation uses the runtime's general subagent with a role skill. The orchestrator declares each role's level (N1–N4) and effort; the ladder from level to model lives in your global instructions for that runtime, so Stack never pins provider model IDs or discovers catalogs. Without a ladder the child inherits the parent model. See [delegation](docs/references/delegation.md).

## Preservation and removal

### Backups

Before changing existing configuration, Stack writes a backup to `~/.jorgex-stack/backups`. Backups are not pruned automatically and can take growing space: they are kept until you choose Limpiar › Backups antiguos in the menu, which after confirmation keeps the 3 most recent snapshots of each label, or until you delete them by hand. Before deleting snapshots, check which originals they contain and which you need to recover changes; do not delete them during an active operation.

The original manifest is backed up once per operation, while ownership is persisted per unit to keep evidence of partial failures. Markdown markers and JSON/TOML upserts preserve content that is not Stack's; Stack's own files are recorded in a minimal local manifest. Existing permission configuration is not re-imposed; drift is reported without dumping content. An unreadable file, an invalid manifest, a linked path or an ownership conflict blocks the affected unit; it is never read as empty state.

The backup taken before Engram's setup (`engram-setup`) copies only the files that setup rewrites:

- Claude Code: `settings.json` and `.claude.json`.
- Codex: `config.toml`, `engram-instructions.md` and `engram-compact-prompt.md`.
- OpenCode: `opencode.json[c]`, `tui.json[c]` and `plugins/engram.ts`.

Versions up to 2.0.9 copied every top-level file of the runtime directory, including credentials (Codex's `auth.json`), history and logs. Review and delete by hand any old `*-engram-setup` snapshots you do not need.

### Uninstalling

Desinstalar removes only the selected managed resources, with confirmation and backup. Skills have a **shared global** scope, announced before applying. It keeps runtimes, shared tools, Engram by default, its database and memories, credentials, sessions, browser and profiles, and anything that is not Stack's. A file owned by Stack can be removed with a backup even if it was modified; a modified configuration entry is kept and released. The manifest does not authenticate ownership against tampering: if you suspect inconsistencies, review or restore its backup before any mutation.

### Files Stack did not record

A file that already exists at a path Stack projects (files of managed skills, the Pi header, OpenCode client resources) and that the manifest does not record is treated as someone else's, even if an earlier Stack version installed it. It is kept untouched, and both Aplicar and Doctor report whether it is "idéntico al canon" (identical to the canon) or "distinto del canon" (different from it).

To bring it back under management, apply the affected unit from Instalar / configurar or Actualizar. Stack asks file by file, defaulting to No. If you accept:

- A different file is backed up to an `adopt-<runtime>` snapshot, replaced by the canon and recorded as Stack's.
- An identical file is only recorded, with no write and no backup.

From then on Stack updates and removes it like any of its own resources. If you answer No, the file stays yours and the notice repeats; Doctor does not fail because of it. Symbolic links, directories and whole foreign skills are never offered for adoption.

There is no universal migrator for historical installations. The explicit removal of the jorgex-pi package and of Stack's own registered scripts and plugins does not migrate sessions or history. Backups can be recovered manually to their original paths after reviewing their content; there is no public Restore command.

### Leftovers from earlier versions

Earlier Stack versions left files and directories that the current version no longer reads. Doctor lists them once per run, with path, size, class and the step to remove them, and summarizes `~/.jorgex-stack/backups` with the number of snapshots and the total size. It is read-only: it deletes nothing, and its result does not change because of leftovers or backups. Detection is only by the existence of the path; each runtime's `updatedAt` in the manifest is renewed only when its row changes.

**Private**: they live in directories only Stack created. They are removed with Limpiar › Residuos de versiones anteriores.

| Base | Paths |
| --- | --- |
| `~/.jorgex-stack/` | `install-mode.json`, `model-map.json`, `primary-model.json`, `pi-receipt.json`, `pi-projection-receipt.json`, `playwright-cli.json`, `devtools-mcp.json`, `packages/`, `.browser-managed/` |
| Pi configuration | `stage-*` directories, `jorgex-pi/`, `npm/jorgex-pi-managed/` |

**In user configuration**: Stack lists them and never removes them, because without a manifest it cannot prove they are still its own. Check that you have not customized them before deleting them by hand.

| Base | Paths |
| --- | --- |
| OpenCode configuration | `plugins/stack-hooks.ts`, `commands/xreview.md` |
| Pi configuration | `prompts/lean-audit.md`, `extensions/jorgex-compact-tools/` |

### Limpiar (cleanup)

The Limpiar menu action has two units. It chooses neither section nor runtime, never runs on its own and deletes nothing without an explicit confirmation, which defaults to No and states how many items will be deleted and their total size. If there is nothing to do, it says so and does not ask.

- **Residuos de versiones anteriores** (leftovers from earlier versions): removes only the private leftovers in the table above. Files are first backed up to `~/.jorgex-stack/backups` under the `cleanup` label; directories are deleted without a backup, and the confirmation says so. A leftover that is a symbolic link is neither followed nor removed, and a path outside `~/.jorgex-stack` or the Pi configuration is skipped; both cases are reported. Pi leftovers are not removed while its `settings.json` still registers `jorgex-pi` or cannot be read: until the Pi configuration is applied they are code in use. Leftovers in user configuration are shown with their manual step and left untouched.
- **Backups antiguos** (old backups): keeps the 3 most recent snapshots of each label and every snapshot whose manifest is corrupt, and deletes the rest. It only deletes snapshot directories inside `~/.jorgex-stack/backups`. Deleted backups cannot be recovered.

Limpiar does not touch Engram, sessions, credentials or Stack's manifest.

**Values inside files**: Doctor does not detect them, because it does not inspect content. Review and remove them by hand:

- The `chrome-devtools` MCP server in the OpenCode and Codex configuration.
- `theme: "JorgeX"` in the Pi configuration.
- The `pi-mcp-adapter` dependency in Pi's `npm/package.json`.

## Development and CI

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/cli.test.ts
pnpm typecheck
pnpm build
pnpm test
pnpm cli
```

The development toolchain is declared in `package.json`; Actions use Node 24 and pnpm 11.1.1. There is no lint or `qa:quality`. See [testing](docs/references/testing.md). The package ships a single bin (`dist/cli.js`) and `stack/`, with licenses and notices; it does not export a quality verifier, private receipts or capabilities, or the research dossier. `Quality gate` runs the real typecheck, tests and build for each PR; publishing validates the candidate again.

### Publishing

The version is prepared in the PR; major and minor bumps require an explicit decision from Jorge. [publish.yml](.github/workflows/publish.yml) publishes a new version automatically on merge to `main`. A version that is already published and has a valid tag does not produce another release, even if code or documentation changed: there is no auto-patch and there are no version commits after the merge.

Validation runs with `contents:read`: immutable SHA of main, typecheck/tests/build and a single `pnpm pack`. That tarball, its package and version identity and its SHA-512 SRI are handed to publishing as an artifact. The OIDC job (`id-token:write`, no repository write access) publishes those bytes with `npm publish --ignore-scripts --provenance` and confirms `dist.integrity` on npm. Only then does a job with no checkout and no product execution use `contents:write` to create the immutable tag `v<version>` on the same SHA. There is no bump App and no additional GitHub release. Concurrency does not cancel active publications; do not cancel them manually either.

**Recovery:** `workflow_dispatch` on main requires a full `release_sha` (40 hex characters) that is an ancestor of main. An existing version can be recovered only if the rebuilt tarball matches its SRI; a version is never republished and a tag is never moved. An ordinary push with a published version but no tag requires that explicit recovery. Reruns of the publish job query npm again and skip publishing if the bytes already match; a tag rerun keeps the confirmed SHA. A new historical version or an obsolete candidate is blocked so `latest` never moves backwards. Historical revisions without this script and contract have no guaranteed compatibility.

Only a 404 means the version is absent: authentication, network or invalid-metadata errors fail closed. A rerun with the version still absent fails closed: wait for the metadata and clarify the previous result before starting another publication. After publishing, the readback polls npm every 15 s until it has waited 5 minutes in total, and only waits while the registry answers 404 because of propagation; any other result (authentication or non-OK HTTP, network, invalid metadata, different integrity) fails that attempt without retrying. If the limit runs out, the version is left without a tag. That does not authorize republishing: once npm lists it, `gh run rerun <id> --failed` skips publishing, verifies the SRI and creates the tag while the run's artifact is still retained (7 days); after that, use recovery with `release_sha`. If GitHub actually rejects the tag (for example with a 403), npm stays published and the failure is partial and recoverable with the exact SHA, without elevating tokens automatically. There is no preventive veto for mixing workflows and product, and no guarantee of permissions for any historical ref.

Trusted Publisher, former App resources and secrets, environments and rulesets remain under the owner's administration: removing their use from the code neither changes them nor proves external permissions. Do not use publishing as a probe, and do not modify historical packages or user data.

## References

Reference documents are written in Spanish.

- [Official Pi and extensions](docs/references/pi-runtime.md)
- [Browse](docs/references/browser-automation.md)
- [Delegation](docs/references/delegation.md)
- [Permissions](docs/references/permissions.md)
- [Claude limits](docs/references/claude-code-limits.md)
- [Writing style](docs/references/writing-style.md)
- [Testing](docs/references/testing.md)
- [skills.sh compatibility](docs/references/skills-sh.md)
- [Skill categories](docs/references/skill-categories.md)
- [Software Factory](docs/references/software-factory.md)
- [Workflow entry point](docs/references/sdd-workflow.md)
- [Historical research](docs/research/README.md)

## License

MIT for Stack. Preserve the licenses and attribution included with skills and third-party material. The dossier keeps the project's own historical research; the external material it analyzes is not part of the repository.
