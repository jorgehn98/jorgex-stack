# Pi runtime

JorgeX Stack integrates Pi as a package-managed runtime. The supported candidate is fixed to the published package `jorgex-pi@0.3.0`; it is not translated through the file adapters, shared component manifest, or model map.

## Install and integrity

For a real install, Stack downloads `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.3.0.tgz` into its managed cache. Before Pi sees the file, Stack verifies all three frozen properties: byte length, SHA-256 and SHA-512, then creates an automatic backup of Pi's `settings.json`. A mismatch blocks the operation before the backup or any Pi mutation. The verified local file is passed to Pi as an argv-only `npm:jorgex-pi@file:<absolute-tarball>` source with `--no-approve`; after installation, Stack normalizes the single settings entry to the exact package object `{ "source": "npm:jorgex-pi@0.3.0", "skills": [] }` and validates the package-local `doctor --json` runner. The empty `skills` list disables the package's bundled skill resources because the canonical shared skills are already discovered from `~/.agents/skills`.

Pi invokes its supported package manager internally. This is the only npm-side exception: Stack development, builds, tests and its own global tools continue to use pnpm.

The install journal is written before Pi runs and promoted to `installed` only after the runner reports healthy. The schema v1 receipt consumed by `jorgex-pi@0.3.0` records the complete candidate evidence, its scope, and the verified Engram executable in `engram.binary`:

- real scope: `~/.jorgex-stack/pi-receipt.json` and the resolved `PI_CODING_AGENT_DIR`;
- test scope: `<target>/state/pi-receipt.json` and `<target>/pi-agent`.

A receipt copied between scopes, an unrecognised historical candidate, duplicate/source-divergent settings, corrupt JSON, or an interrupted `installing` journal blocks mutation. A matching package installed manually is reported as manual state and is not silently adopted.

## Primary model owned by Pi

`jorgex-pi@0.3.0` owns the Pi-native model projection; Stack only invokes the package lifecycle. On compatible missing fields, Pi requests:

- provider `openai-codex` and model `gpt-5.6-sol` in `settings.json`;
- `contextWindow: 872000` for that model in `models.json`.

Pi records field, container and file ownership in `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`. Sync preserves foreign halves and user replacements. Cleanup removes only exact canonical values still recorded as package-owned, prunes only containers it created when they become empty, and leaves unrelated settings intact.

The 872K figure is local requested metadata for the subscription/OAuth route. It does not prove that the backend accepts the full window and must not be conflated with the API's context limit. Validate it with a real long-context smoke test before relying on the entire range.

## Engram

Engram is required for the managed Pi package and remains outside Stack ownership. Existing binaries, `~/.engram`, databases and memories are preserved.

- Interactive install with no detected Engram offers the native update/install channels and defaults to No.
- `--yes` or a non-TTY install does not download Engram implicitly; it fails with a remedy.
- `--target-dir` checks only `<target>/bin/engram`. It never falls back to the host.
- Sync, models, doctor, update and uninstall never install, update or delete Engram. Uninstall remains available if the binary has already disappeared.

## Commands

| Stack command | Pi behavior |
| --- | --- |
| `install --agents pi` | Verify tgz, install local alias, normalize source, run doctor, commit receipt. |
| `sync --agents pi` | Run the package JSON `sync`; it must report `changed:false`. |
| `models --agents pi` | Return Pi's `inherit-session` routing policy; no Stack model-map entry is written. |
| `doctor --agents pi` | Validate exact receipt/source/scope and the package-local JSON doctor. |
| `update --check --agents pi` | Read-only Pi doctor; skips the global Stack updater. |
| `update --agents pi` | Run only the managed Pi update lifecycle. The frozen same-version candidate is a no-op; a future cross-version candidate stays blocked until both replacement and rollback tgz files have verified evidence. |
| `uninstall --agents pi` | Run package cleanup, back up Pi settings, remove the exact owned source, verify package absence, then delete the receipt. |

`--dry-run` does not run Pi or write a receipt.

## Target isolation

With `--target-dir <target>`, child processes receive target-contained values for `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, XDG config/data/cache, `TEMP`, `TMP`, `TMPDIR`, npm cache and `PI_CODING_AGENT_DIR`. `ENGRAM_BIN` must also point inside the target. The environment excludes provider tokens, npm credentials and `PI_PACKAGE_DIR`; lifecycle scripts and update notifications are disabled.

## Troubleshooting

| Result | Meaning / remedy |
| --- | --- |
| `tarball-integrity` | Downloaded bytes do not match the frozen candidate. Do not bypass it; retry from a trusted network/registry. |
| `unsupported-pi-version` | Install the Pi version supported by the frozen `jorgex-pi@0.3.0` candidate. |
| `engram-required` / `engram-missing-target` | Install/configure Engram explicitly; target tests need `<target>/bin/engram`. |
| `manual-existing` | The exact package exists without a Stack receipt. Preserve it or remove it explicitly before asking Stack to own a reinstall. |
| `duplicate-package` / `source-divergent` | Keep one canonical `npm:jorgex-pi@0.3.0` entry with `skills: []` and retry. |
| `receipt-corrupt` / `receipt-untrusted` / `partial-state` | Do not delete the journal blindly. Inspect settings and receipt scope/candidate, then repair or restore deliberately. |
| `receipt-upgrade-required` | The receipt predates the Engram binding and is not adopted automatically. Use the previous Stack release to remove it, then reinstall deliberately with the current release. |
| `runner-output` / `runner-unhealthy` | The installed package did not produce the expected single bounded JSON record. Reinstall only after checking package integrity and Engram. |
| `verified-update-required` | Stack refuses a cross-version registry install without verified replacement and rollback tarballs. Upgrade support must ship with the new frozen candidate. |

The authoritative verification keeps two seams separate. With `JORGEX_PI_TARBALL` it checks the exact published `jorgex-pi@0.3.0` artifact against the frozen byte length, SHA-256, SHA-512 and bundled/native inventory. With `JORGEX_PI_DIR` it packs the explicit checkout as a lifecycle fixture, installs it with checkout-local Pi `0.84.2`, validates doctor, and removes only the managed package while preserving foreign settings; checkout bytes are never used as registry-integrity evidence.
