[**English**](README.md) | **中文**

# dsh-backup-migrator

把 DeepSeek Harness 的插件环境备份/迁移到 GitHub 云端——VSCode 设置同步同款体验。

- **一条命令备份**：扫描本机各 profile 的插件清单（dependencies + bundles 加载顺序）、`~/.dsh/dsh-*.json` 插件配置（0600），以及**本地开发的插件**（`link:`/`file:` 源，自动 `npm pack` 成 tgz 一起带走，换机器不会丢）→ `git commit` + `git push`。
- **一条命令恢复**：新机器 clone 同一仓库 → 按来源自动重装（npm/github 源联网重装，本地源用仓库里的 tgz 离线安装）→ 写回 `dsh.profile.bundles`、用户 patch 层 `cordis.patch.yml` 和配置文件。
- 备份历史 = git 历史，哪天都能回滚。

## 为什么本地插件要打包？

DSH 插件有四种来源：npm registry、`github:user/repo#commit`、`link:<本地路径>`、`file:<tgz>`。换机器后 `link:`/`file:` 的本地路径不存在，不打包就会丢。本插件自动识别并逐个 `npm pack` 进备份仓库。

## 安装

```sh
dsh plugin --profile web add github:zhengjy01/dsh-backup-migrator
# 或本地开发：
# from npm (published package)
dsh plugin --profile web add dsh-backup-migrator

# or local development
dsh plugin --profile web add link:/path/to/dsh-backup-migrator
```

重启 GUI（`dsh web`）后生效。

## 一次性配置

1. 在 GitHub 建一个**空仓库**（建议私有）。
2. 用 `dshbackup_config` 配置：

```text
dshbackup_config backupDir: ~/Documents/DSH-Backup   # 备份仓库本地目录（新机器 clone 到同一目录）
dshbackup_config repoUrl: git@github.com:user/dsh-backup.git
```

## 使用

| 工具 | 用途 |
|---|---|
| `dshbackup_backup` | 扫描 profile → 生成 manifest + 配置 + 本地插件包 → commit → push |
| `dshbackup_restore` | 拉取备份仓库 → 重装全部插件 → 恢复配置 |
| `dshbackup_verify` | 备份前/恢复前预检（源可恢复性、git remote、敏感配置提示） |
| `dshbackup_list` | 备份历史（git log）+ 最新备份摘要 |
| `dshbackup_config` | 查看/修改 backupDir、repoUrl、includeSecrets |

配置存 `~/.dsh/dsh-backup-migrator.json`（0600）。

### 备份仓库结构

```
<backupDir>/
├── manifest.json                # 机器 + profile + 插件 + 配置索引
├── README.md                    # 人读摘要（自动生成）
├── profiles/<name>/cordis.patch.yml   # 用户 patch 层（如有）
├── profiles/<name>/packages/*.tgz     # 本地源插件（npm pack）
└── configs/...                  # ~/.dsh/dsh-*.json + dsh-* 目录（0600）
```

### 新机器恢复

```text
1. 装好 DSH，先启动一次（web/headless profile 会自动创建）
2. 安装本插件后：
   dshbackup_config backupDir: <同一目录>
   dshbackup_config repoUrl: <同一仓库>
   dshbackup_restore        # clone + 重装 + 恢复配置
3. 重启 GUI
```

## 安全

- 插件配置常含 API key/token（flomo、ticktick、npm……）。`includeSecrets` 默认 `true`——**请使用私有备份仓库**，或设 `includeSecrets: false` 排除敏感文件；`dshbackup_verify` 会列出哪些文件被标记为敏感。
- 配置文件保持 0600 权限。

## License

MIT
