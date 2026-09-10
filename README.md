> **English** | [**中文**](README.zh.md)

# dsh-backup-migrator

Backup and migrate your DeepSeek Harness plugin environment via a git repository on GitHub — VSCode settings-sync style.

- **One command backup**: scan every profile's installed plugins (manifest + load order), plugin configs under `~/.dsh/dsh-*.json` (0600), and **locally-developed plugins** (`link:`/`file:` sources) — the local ones are automatically packed into tarballs so they survive on another machine — then `git commit` + `git push`.
- **One command restore**: on a new machine, pull/clone the same repo, reinstall every plugin by source (npm/github reinstall online; local sources install offline from the packed tarballs), write back `dsh.profile.bundles`, the user patch layer `cordis.patch.yml` and the config files.
- Backup history = git history (rollback any day).

## Why tarballs for local plugins?

DSH plugins come from four sources: npm registry, `github:user/repo#commit`, `link:<local path>` and `file:<tgz>`. On a new machine the `link:`/`file:` local paths do not exist — without packing them, those plugins would be lost. This plugin detects them and `npm pack`s each into the backup repo.

## Install

```sh
dsh plugin --profile web add github:zhengjy01/dsh-backup-migrator
# or local dev:
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
| `dshbackup_backup` | scan profiles → build manifest + configs + packed local plugins → commit → push |
| `dshbackup_restore` | pull/clone the backup repo → reinstall all plugins → restore configs |
| `dshbackup_verify` | preflight before backup or restore (source reachability, git remote, secrets warning) |
| `dshbackup_list` | backup history (git log) + latest manifest summary |
| `dshbackup_config` | view/change backupDir, repoUrl, includeSecrets |

Config is stored at `~/.dsh/dsh-backup-migrator.json` (mode 0600).

### Backup repo layout

```
<backupDir>/
├── manifest.json                # machine + profile + plugin + config index
├── README.md                    # human-readable summary (auto-generated)
├── profiles/<name>/cordis.patch.yml   # user patch layer (if any)
├── profiles/<name>/packages/*.tgz     # locally-sourced plugins (npm pack)
└── configs/...                  # ~/.dsh/dsh-*.json + dsh-* dirs (0600)
```

### On a new machine

```text
1. install DSH, launch once (web/headless profiles are auto-created)
2. install this plugin, then:
   dshbackup_config backupDir: <same local dir>
   dshbackup_config repoUrl: <same repo url>
   dshbackup_restore        # clone + reinstall + restore configs
3. restart the GUI
```

## Security

- Plugin configs often contain API keys/tokens (flomo, ticktick, npm...). `includeSecrets` defaults to `true` — **use a private backup repo**, or set `includeSecrets: false` to exclude secret-flagged files. `dshbackup_verify` lists which files are secret-flagged.
- Config files keep mode 0600.

## License

MIT
