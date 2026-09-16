> **English** | [**中文**](README.zh.md)

# dsh-backup-migrator

Backup and migrate your DeepSeek Harness plugin environment via a git repository on GitHub — VSCode settings-sync style.

- **One command backup**: scan every profile's installed plugins (manifest + load order), plugin configs under `~/.dsh/dsh-*.json` (0600), **locally-developed plugins** (`link:`/`file:` sources — the local ones are automatically packed into tarballs so they survive on another machine), and **machine-level aux assets outside the plugin system** (helper scripts under `~/.dsh/scripts` + `com.dsh.*.plist` launchd timers under `~/Library/LaunchAgents`, e.g. TickTick deferred sync) — then `git commit` + `git push`.
- **One command restore**: on a new machine, pull/clone the same repo, reinstall every plugin by source (npm/github reinstall online; local sources install offline from the packed tarballs), write back `dsh.profile.bundles`, the user patch layer `cordis.patch.yml` and the config files, then drop the scripts/plists back in place (source-machine home paths and the node interpreter are rewritten, and plists are `launchctl load`ed automatically).
- **Optional built-in scheduler**: switch on `autoBackup` and backups run on an interval (daily by default) — no manual button and no external launchd job; windows missed while the machine slept are caught up on the next start.
- Backup history = git history (rollback any day).

## Why tarballs for local plugins?

DSH plugins come from four sources: npm registry, `github:user/repo#commit`, `link:<local path>` and `file:<tgz>`. On a new machine the `link:`/`file:` local paths do not exist — without packing them, those plugins would be lost. This plugin detects them and `npm pack`s each into the backup repo.

## Why also back up "scripts + launchd timers"?

Some DSH side-services deliberately live outside the plugin system — TickTick deferred sync is the canonical example: its launchd timer must keep flushing the staged queue into TickTick while the DSH GUI is closed, so it cannot be a plugin bundle. Those files are scattered:

- `~/.dsh/scripts/ticktick-pending.mjs` (script — invisible to the plugin manifest)
- `~/Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist` (timer — under the home dir)
- `~/.dsh/dsh-ticktick-pending.json` (queue + threshold config — already captured as a `dsh-*.json` config)

A plugin-environment-only backup silently dropped the script and the timer on migration. They now travel in the repo's `aux/` directory: on restore the recorded source home is rewritten to the target home (`/Users/alice` → `/Users/bob`), the node interpreter falls back to this machine's node when the recorded one is absent, files land at their original locations, and plists are `launchctl load -w`ed.


## Compatibility

Requires **DeepSeek Harness ≥ 0.1.5-rc.1** (declared as `dsh.engines.dsh` in the package manifest, so the DSH plugin marketplace can report it) and is verified against **0.1.5-rc.1**. This build carries the DSH 0.1.5 adaptations: the strict tool-result contract (lossless-JSON snapshot, `additionalProperties: false` schema validation, and `output.render` returning `ContentBlock[]`) plus executable resolution that survives a launchd-started host whose `PATH` is only `/usr/bin:/bin`.

## Install

```sh
dsh plugin --profile web add github:zhengjy01/dsh-backup-migrator
# or local dev:
# from npm (published package)
dsh plugin --profile web add dsh-backup-migrator

# or local development
dsh plugin --profile web add link:/path/to/dsh-backup-migrator
```

Restart the GUI (`dsh web`) to load the plugin.

## Setup (one time)

1. Create an empty (private recommended) repo on GitHub.
2. Configure via `dshbackup_config`:

```text
dshbackup_config backupDir: ~/Documents/DSH-Backup   # local git repo dir (clone it on new machines)
dshbackup_config repoUrl: git@github.com:user/dsh-backup.git
```

## Usage

| Tool | Purpose |
|---|---|
| `dshbackup_backup` | scan profiles → build manifest + configs + packed local plugins + aux (scripts/timers) → commit → push |
| `dshbackup_restore` | pull/clone the backup repo → reinstall all plugins → restore configs + scripts/timers |
| `dshbackup_verify` | preflight before backup or restore (source reachability, git remote, secrets, aux presence) |
| `dshbackup_list` | backup history (git log) + latest manifest summary |
| `dshbackup_config` | view/change backupDir, repoUrl, includeSecrets, includeAux, autoBackup, backupIntervalMinutes, autoBackupPush; also reports scheduler state when called without arguments |

Config is stored at `~/.dsh/dsh-backup-migrator.json` (mode 0600).

### Built-in scheduled backup

No button to remember and no external launchd job needed: turn the switch on and the plugin runs a backup **identical to the manual one** (same code path) from inside the host process, on an interval.

```text
dshbackup_config autoBackup: true                 # master switch (off by default)
dshbackup_config backupIntervalMinutes: 1440      # minutes, minimum 15, default 1440 (daily)
dshbackup_config autoBackupPush: false            # optional: local commits only, never push
```

- **Missed windows are caught up**: due-ness is computed from "last attempt + interval", so after the machine slept or DSH was closed the next check on startup/wake runs the missed backup (the loop wakes about once a minute).
- **Config changes apply immediately** — the switch and interval are re-read on every check; no GUI restart.
- **Failures do not hammer**: a failed run also waits a full interval before retrying, consecutive failures are counted, and 3 in a row get called out in the log.
- **Never concurrent**: if a backup is still running, the check is skipped.
- **Observable**: `dshbackup_config` (no args) and `GET /status` both report last attempt / last success / consecutive failures / next expected run. State lives in `~/.dsh/dsh-backup-migrator-state.json` (machine-local runtime state, **never backed up**).

> A scheduled run pushes the credentials it finds in your configs (when `includeSecrets: true`). Make sure the backup repo is **private**; if unsure, set `autoBackupPush: false` first so runs only commit locally.

### HTTP surface (loopback-only, for external agents / verification tooling)

- `GET /api/dsh-backup-migrator/probe` — liveness probe returning `{ ok, plugin, version }`
- `GET /api/dsh-backup-migrator/status` — read-only: current config + latest backup summary (incl. the aux list) + scheduler state

### Backup repo layout

```
<backupDir>/
├── manifest.json                # machine + profile + plugin + config + aux index
├── README.md                    # human-readable summary (auto-generated)
├── profiles/<name>/cordis.patch.yml   # user patch layer (if any)
├── profiles/<name>/packages/*.tgz     # locally-sourced plugins (npm pack)
├── configs/...                  # ~/.dsh/dsh-*.json + dsh-* dirs (0600)
└── aux/                         # scripts/ (helper scripts) + launchagents/ (com.dsh.*.plist)
```

### On a new machine

```text
1. install DSH, launch once (web/headless profiles are auto-created)
2. install this plugin, then:
   dshbackup_config backupDir: <same local dir>
   dshbackup_config repoUrl: <same repo url>
   dshbackup_restore        # clone + reinstall + configs + scripts/timers
3. restart the GUI (launchd timers need no restart — restore already loaded them)
```

### 5-minute restore of TickTick deferred sync

Prerequisite: the backup repo already has an `aux/` section (one new-version `dshbackup_backup` run on the old machine).

```sh
# 1) on the new machine, install DSH + this plugin, then one command
dshbackup_config backupDir: ~/dsh-backup
dshbackup_config repoUrl:   https://github.com/<you>/dsh-backup.git
dshbackup_restore                 # clone → reinstall plugins → configs → scripts/plist → launchctl load

# 2) verify (10 seconds)
node ~/.dsh/scripts/ticktick-pending.mjs status       # prints queue/threshold/idle = script OK
launchctl list | grep com.dsh.ticktick-deferred-sync   # any output = timer loaded

# 3) stage once for real
node ~/.dsh/scripts/ticktick-pending.mjs stage --by "migration-check" \
  --json '[{"title":"migration check","content":"source: migration; why: verify deferred sync; done: visible in status"}]'
node ~/.dsh/scripts/ticktick-pending.mjs status
```

If step 1 reports a `launchctl` load failure (e.g. blocked by a sandbox), add it manually:

```sh
launchctl load -w ~/Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist
```

> The queue/threshold config `~/.dsh/dsh-ticktick-pending.json` and credentials `~/.dsh/dsh-ticktick.json` are restored as configs (needs `includeSecrets: true` + a private repo). Without credentials the timer still runs but skips writing to TickTick.


## Security

- Plugin configs often contain API keys/tokens (flomo, ticktick, npm...). `includeSecrets` defaults to `true` — **use a private backup repo**, or set `includeSecrets: false` to exclude secret-flagged files. `dshbackup_verify` lists which files are secret-flagged.
- Config files keep mode 0600.

## License

MIT
