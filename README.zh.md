[**English**](README.md) | **中文**

# dsh-backup-migrator

把 DeepSeek Harness 的插件环境备份/迁移到 GitHub 云端——VSCode 设置同步同款体验。

- **一条命令备份 · 环境 + 你**：①**插件环境**——各 profile 的插件清单（dependencies + bundles 加载顺序）、`~/.dsh/dsh-*.json` 插件配置（0600）、**本地开发的插件**（`link:`/`file:` 源，自动 `npm pack` 成 tgz，换机器不会丢）；②**插件体系外的资产**——`~/.dsh/scripts` 下的 helper 脚本 + `~/Library/LaunchAgents/com.dsh.*.plist` 定时器；③**用户内容层**——`~/.agents/skills`（skill 库）、`~/.dsh/.agent-presets`（Agent 预设）、`~/.dsh/adapters`（自定义适配器）、`~/.dsh/AGENTS.md`（全局规则）、`~/.dsh/settings.yaml`（设置）、`~/.mnemon/runtime`（记忆）与 `~/.mnemon/documents`（沉淀文档）→ `git commit` + `git push`。**不存在的项自动跳过**，所以别人的机器也能直接用。
- **一条命令恢复**：新机器 clone 同一仓库 → 按来源自动重装（npm/github 源联网重装，本地源用仓库里的 tgz 离线安装）→ 写回 `dsh.profile.bundles`、用户 patch 层 `cordis.patch.yml` 和配置文件 → 脚本 / plist 落位（源机器 home 路径与 node 解释器自动重写，plist 自动 `launchctl load`）。
- **可选的内置定时备份**：打开 `autoBackup` 后按间隔自动备份（默认一天一次），睡过/关过的窗口会在下次启动时补跑，不再靠手动或外挂 launchd。
- 备份历史 = git 历史，哪天都能回滚。

## 为什么本地插件要打包？

DSH 插件有四种来源：npm registry、`github:user/repo#commit`、`link:<本地路径>`、`file:<tgz>`。换机器后 `link:`/`file:` 的本地路径不存在，不打包就会丢。本插件自动识别并逐个 `npm pack` 进备份仓库。

## 为什么连「你」也要备份？

只备份插件环境，换机后得到的是一个**能跑但不像你**的 DSH：skill 没有、预设没有、全局规则还是默认的、记忆归零——环境回来了，"你"没回来。

所以这一层和脚本/定时器一样进同一张资产注册表（`lib/aux.js` 的 `DEFAULT_AUX_ASSETS`）：**每一项都是可选的**，本机不存在就只记一条警告、跳过，不会让备份失败。用 `includeUserContent: false` 可以整体关掉（比如你不想把记忆推进仓库）。

目录类资产（skill / 预设 / 记忆 / 沉淀文档）是**镜像**语义：恢复时若目标目录已存在，会先把它整体挪到 `<目录>.bak-<时间戳>` 再写入，**不会静默吃掉你当前的内容**。文本文件里的源机器 home 路径与 node 解释器会被自动重写；二进制文件（如 skill 里的图片）原样搬运，不经过文本重写。

## 为什么还要备份「脚本 + launchd 定时器」？

有些 DSH 副作用服务**故意不在插件体系内**——例如滴答清单的延迟同步：它的 launchd 定时器必须在 DSH GUI 关闭时照常把暂存队列写进滴答，所以不能做成插件 bundle。这类资产散落在：

- `~/.dsh/scripts/ticktick-pending.mjs`（脚本，插件清单看不到）
- `~/Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist`（定时器，在 home 目录）
- `~/.dsh/dsh-ticktick-pending.json`（队列 + 阈值配置，**本来就作为 `dsh-*.json` 配置被备份**）

早先只备份插件环境时，换机会静默丢掉脚本和定时器。现在它们进入备份仓库的 `aux/` 目录：恢复时按记录的源 home 重写路径（`/Users/alice` → `/Users/bob`）、把 node 解释器换成本机的 node、写回原位置，并自动 `launchctl load -w`。

同一张表还纳入了 **博客同步**（2026-09-19 会话「博客同步静默失效排查」新建，看板 cron 不可靠后改挂 launchd）：

- `~/Library/LaunchAgents/com.dsh.blog-sync.plist`（21:00 主 + 09:00 兜底 + `RunAtLoad`；睡眠唤醒后补跑）
- `~/dsh-blog-sync/after-blog-sync.sh`（plist 的真正入口：文章同步带重试 → 刷新卡片）
- `~/dsh-blog-sync/sync_blog_notion.mjs`（现行 Node fetch 同步）、`sync_blog_notion.py`（旧版，保留作回滚）
- `~/dsh-blog-sync/sync_now.mjs` + `now.config.json`（刷新「最近在做什么」卡片）

> **plist 与脚本必须成对备份**：只带定时器不带脚本，换机后定时器会照点唤起却每次报找不到文件——那是另一种形态的静默失效。


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
| `dshbackup_config` | 查看/修改 backupDir、repoUrl、includeSecrets、includeAux、autoBackup、backupIntervalMinutes、backupRetryMinutes、autoBackupPush；不带参数时同时显示定时备份状态 |

配置存 `~/.dsh/dsh-backup-migrator.json`（0600）。

### 内置定时备份

不用自己按按钮，也不用外挂 launchd：打开开关后，插件在宿主进程内按时自动执行**与手动完全等价**的备份（同一个代码路径）。

```text
dshbackup_config autoBackup: true                 # 总开关（默认关）
dshbackup_config backupIntervalMinutes: 1440      # 间隔分钟数，最小 15，默认 1440（一天）
dshbackup_config backupRetryMinutes: 30           # 失败后的重试间隔，最小 5，默认 30（成功则回到上面的间隔）
dshbackup_config autoBackupPush: false            # 可选：只留本地提交，不自动 push
```

- **错过的窗口会补跑**：判定基于「上次尝试时间 + 间隔」，所以机器睡过、DSH 关过之后，**下次启动或唤醒的第一个检查点**就会补上（周期 tick，约每分钟检查一次）。
- **改配置即时生效**：间隔与开关每个检查点重新读取，不需要重启 GUI。
- **失败会重试、且不会被当成成功**：一轮里只要没落定（构建失败、git 提交失败、**或 push 失败**）就算失败 → 按 `backupRetryMinutes`（默认 30 分钟）再试，成功后才回到正常间隔。一次网络抖动不会把备份拖到第二天，连续失败 3 次也会在日志里点名提示。（最初版本把「push 失败」记成 `ok: true` 并清零失败计数——等于静默丢备份，已修。）
- **绝不并发**：上一次备份还在跑时，本次检查直接跳过。
- **状态可查**：`dshbackup_config`（不带参数）与 `GET /status` 都会返回上次尝试 / 上次成功 / 连续失败 / 下次预计时间；状态写 `~/.dsh/dsh-backup-migrator-state.json`（机器本地运行时状态，**不参与备份**）。

> 定时备份会把配置里的凭据一并推送到远端（`includeSecrets: true` 时）——请确认备份仓库是**私有**的；不放心就先设 `autoBackupPush: false`，让它只留本地提交。

### HTTP 接口（loopback-only，供外部 Agent / 验证工具探活）

- `GET /api/dsh-backup-migrator/probe` —— 存活探针，返回 `{ ok, plugin, version }`
- `GET /api/dsh-backup-migrator/status` —— 只读：当前配置 + 最新备份摘要（含 aux 清单）+ 定时备份状态

### 备份仓库结构

```
<backupDir>/
├── manifest.json                # 机器 + profile + 插件 + 配置 + aux 索引
├── README.md                    # 人读摘要（自动生成）
├── profiles/<name>/cordis.patch.yml   # 用户 patch 层（如有）
├── profiles/<name>/packages/*.tgz     # 本地源插件（npm pack）
├── configs/...                  # ~/.dsh/dsh-*.json + dsh-* 目录（0600）
└── aux/                         # 插件体系外的资产，按类型分层：
    ├── scripts/                 #   helper 脚本（0755）
    ├── launchagents/            #   com.dsh.*.plist 定时器（macOS）
    ├── files/                   #   单文件用户内容（AGENTS.md、settings.yaml）
    └── dirs/<id>/               #   目录树（skills、agent-presets、adapters、记忆、沉淀文档）
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
