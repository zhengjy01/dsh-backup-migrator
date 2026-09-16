[**English**](README.md) | **中文**

# dsh-backup-migrator

把 DeepSeek Harness 的插件环境备份/迁移到 GitHub 云端——VSCode 设置同步同款体验。

- **一条命令备份**：扫描本机各 profile 的插件清单（dependencies + bundles 加载顺序）、`~/.dsh/dsh-*.json` 插件配置（0600）、**本地开发的插件**（`link:`/`file:` 源，自动 `npm pack` 成 tgz 一起带走，换机器不会丢），以及**插件体系之外的机器级附属资产**（`~/.dsh/scripts` 下的 helper 脚本 + `~/Library/LaunchAgents/com.dsh.*.plist` 定时器，如滴答清单延迟同步）→ `git commit` + `git push`。
- **一条命令恢复**：新机器 clone 同一仓库 → 按来源自动重装（npm/github 源联网重装，本地源用仓库里的 tgz 离线安装）→ 写回 `dsh.profile.bundles`、用户 patch 层 `cordis.patch.yml` 和配置文件 → 脚本 / plist 落位（源机器 home 路径与 node 解释器自动重写，plist 自动 `launchctl load`）。
- 备份历史 = git 历史，哪天都能回滚。

## 为什么本地插件要打包？

DSH 插件有四种来源：npm registry、`github:user/repo#commit`、`link:<本地路径>`、`file:<tgz>`。换机器后 `link:`/`file:` 的本地路径不存在，不打包就会丢。本插件自动识别并逐个 `npm pack` 进备份仓库。

## 为什么还要备份「脚本 + launchd 定时器」？

有些 DSH 副作用服务**故意不在插件体系内**——例如滴答清单的延迟同步：它的 launchd 定时器必须在 DSH GUI 关闭时照常把暂存队列写进滴答，所以不能做成插件 bundle。这类资产散落在：

- `~/.dsh/scripts/ticktick-pending.mjs`（脚本，插件清单看不到）
- `~/Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist`（定时器，在 home 目录）
- `~/.dsh/dsh-ticktick-pending.json`（队列 + 阈值配置，**本来就作为 `dsh-*.json` 配置被备份**）

早先只备份插件环境时，换机会静默丢掉脚本和定时器。现在它们进入备份仓库的 `aux/` 目录：恢复时按记录的源 home 重写路径（`/Users/alice` → `/Users/bob`）、把 node 解释器换成本机的 node、写回原位置，并自动 `launchctl load -w`。


## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），并已在 **0.1.5-rc.1** 上实测通过。本构建包含 DSH 0.1.5 的适配：工具结果的严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 必须返回 `ContentBlock[]`），以及不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。

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
| `dshbackup_backup` | 扫描 profile → 生成 manifest + 配置 + 本地插件包 + aux（脚本/定时器）→ commit → push |
| `dshbackup_restore` | 拉取备份仓库 → 重装全部插件 → 恢复配置与脚本/定时器 |
| `dshbackup_verify` | 备份前/恢复前预检（源可恢复性、git remote、敏感配置、aux 是否齐备） |
| `dshbackup_list` | 备份历史（git log）+ 最新备份摘要 |
| `dshbackup_config` | 查看/修改 backupDir、repoUrl、includeSecrets、includeAux |

配置存 `~/.dsh/dsh-backup-migrator.json`（0600）。

### HTTP 接口（loopback-only，供外部 Agent / 验证工具探活）

- `GET /api/dsh-backup-migrator/probe` —— 存活探针，返回 `{ ok, plugin, version }`
- `GET /api/dsh-backup-migrator/status` —— 只读：当前配置 + 最新备份摘要（含 aux 清单）

### 备份仓库结构

```
<backupDir>/
├── manifest.json                # 机器 + profile + 插件 + 配置 + aux 索引
├── README.md                    # 人读摘要（自动生成）
├── profiles/<name>/cordis.patch.yml   # 用户 patch 层（如有）
├── profiles/<name>/packages/*.tgz     # 本地源插件（npm pack）
├── configs/...                  # ~/.dsh/dsh-*.json + dsh-* 目录（0600）
└── aux/                         # scripts/（helper 脚本）+ launchagents/（com.dsh.*.plist）
```

### 新机器恢复

```text
1. 装好 DSH，先启动一次（web/headless profile 会自动创建）
2. 安装本插件后：
   dshbackup_config backupDir: <同一目录>
   dshbackup_config repoUrl: <同一仓库>
   dshbackup_restore        # clone + 重装 + 恢复配置 + 落脚本/定时器
3. 重启 GUI（launchd 定时器不用等，restore 时已 launchctl load）
```

### 换机 5 分钟恢复「滴答清单延迟同步」

前提：备份仓库里已有 `aux/` 段（本机跑过一次新版 `dshbackup_backup`）。

```sh
# 1) 新机器装 DSH 与本插件，然后一条命令还原
dshbackup_config backupDir: ~/dsh-backup
dshbackup_config repoUrl:   https://github.com/<you>/dsh-backup.git
dshbackup_restore                 # 自动 clone → 重装插件 → 恢复配置 → 落脚本/plist → launchctl load

# 2) 验证（10 秒）
node ~/.dsh/scripts/ticktick-pending.mjs status     # 能打印队列/阈值/静默时间 = 脚本 OK
launchctl list | grep com.dsh.ticktick-deferred-sync  # 有输出 = 定时器已加载

# 3) 真实暂存一次，确认链路
node ~/.dsh/scripts/ticktick-pending.mjs stage --by "换机验证" \
  --json '[{"title":"换机验证","content":"来源：换机恢复；背景：验证延迟同步；完成标准：status 可见"}]'
node ~/.dsh/scripts/ticktick-pending.mjs status
```

若第 1 步的 `dshbackup_restore` 报告 `launchctl` 加载失败（例如被 sandbox/权限拦），手动补一条即可：

```sh
launchctl load -w ~/Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist
```

> 队列/阈值配置文件 `~/.dsh/dsh-ticktick-pending.json` 属于 configs，会被一并还原；凭据 `~/.dsh/dsh-ticktick.json` 也在 configs 里（需要 `includeSecrets: true` + 私有仓库），否则定时器能跑但写入滴答会因缺凭据跳过。


## 安全

- 插件配置常含 API key/token（flomo、ticktick、npm……）。`includeSecrets` 默认 `true`——**请使用私有备份仓库**，或设 `includeSecrets: false` 排除敏感文件；`dshbackup_verify` 会列出哪些文件被标记为敏感。
- 配置文件保持 0600 权限。

## License

MIT
