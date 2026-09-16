/**
 * dsh-backup-migrator — 备份与迁移 DeepSeek Harness 插件环境（GitHub 云端）。
 *
 * 用法与 VSCode 设置同步一致：本机把「插件清单 + 插件配置 + 本地源码插件」
 * 打包进一个 git 备份仓库并 push 到 GitHub；新机器上 clone 同一仓库后一键
 * restore，按来源自动重装插件（npm / github 联网重装，link:/file: 本地源
 * 用仓库里已打包的 tgz 离线安装）并写回配置。
 *
 * Tools:
 *   - dshbackup_config  — 查看/修改配置（backupDir 备份仓库目录、repoUrl
 *                          GitHub 仓库地址、includeSecrets 是否包含凭据）。
 *   - dshbackup_backup  — 扫描全部/指定 profile → 生成 manifest + 配置 +
 *                          本地插件 tgz → git commit → push 到远端。
 *   - dshbackup_verify  — 预检：插件源可恢复性、git remote、敏感配置提示；
 *                          备份前或恢复前各跑一次。
 *   - dshbackup_restore — 拉取备份仓库 → 按 profile 逐个 pnpm add 重装 →
 *                          写回 dsh.profile.bundles / cordis.patch.yml / 配置。
 *   - dshbackup_list    — 备份历史（git log）+ 最新一次备份的内容摘要。
 *
 * 还支持**内置定时备份**：配置 autoBackup=true 后，插件在宿主进程内按
 * backupIntervalMinutes（默认一天）自动执行与手动完全等价的备份；状态写
 * ~/.dsh/dsh-backup-migrator-state.json（机器本地，不参与备份）。
 *
 * 配置存 ~/.dsh/dsh-backup-migrator.json（权限 0600）。
 *
 * @module dsh-backup-migrator
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { buildBackup, verifyBackup, restoreBackup, listBackup, listProfiles } from './ops.js'
import { isGitRoot, gitInit, gitCommit, gitPush, gitRemote } from './git.js'
import { readState, defaultStatePath, scheduleStatus, startScheduler, normalizeInterval, normalizeRetry } from './schedule.js'

/** Stable cordis plugin name. */
export const name = 'backup-migrator'

/** Package metadata (version reported by the liveness probe). */
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  } catch (err) {
    return {}
  }
})()

/** Services required before the plugin can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** DSH home (honors DSH_HOME, same rule as ops.js). */
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh')

/** Config file location (machine-wide, mode 0600; honors DSH_HOME). */
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-backup-migrator.json')

/**
 * Runtime state for the built-in scheduler (last attempt/success, failure count).
 * Machine-local, NOT a user config — excluded from backups (see ops.js CONFIG_EXCLUDE).
 */
const STATE_FILE = defaultStatePath(DSH_HOME)

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 165

const DEFAULTS = {
  backupDir: '',        // 备份仓库本地目录（git 仓库，会 push 到 repoUrl）
  repoUrl: '',          // GitHub 仓库地址（如 git@github.com:user/dsh-backup.git）；留空=仅本地备份
  includeSecrets: true, // 是否把含 token/密钥的插件配置文件一起备份（私有仓库建议 true）
  includeAux: true,     // 是否备份机器级附属资产（helper 脚本 + launchd 定时器，如延迟同步）
  autoBackup: false,    // 内置定时备份总开关（默认关，开了才会自动跑）
  backupIntervalMinutes: 1440, // 定时备份间隔（分钟，最小 15；默认一天一次）
  backupRetryMinutes: 30,      // 失败后的重试间隔（分钟，最小 5；成功则回到上面的间隔）
  autoBackupPush: true, // 定时备份是否 push 到远端（false=只留本地提交）
}

/** Model-facing announcement: plugin presence, capabilities, and conventions. */
export const BACKUP_GUIDANCE =
  '本机已安装 dsh-backup-migrator 插件（DSH 插件环境备份/迁移，VSCode 设置同步式）：一键把本机各 profile 的插件清单（dependencies + bundles 加载顺序）、' +
  '插件配置（~/.dsh/dsh-*.json，0600）、本地源码插件（link:/file: 源，自动打包成 tgz）以及机器级附属资产（~/.dsh/scripts 下的 helper 脚本 + ~/Library/LaunchAgents 下 com.dsh.*.plist 定时器，如滴答清单延迟同步）' +
  '备份进一个 git 仓库并 push 到 GitHub；' +
  '新机器 clone 同一仓库后 dshbackup_restore 一键还原（npm/github 源联网重装，本地源用已打包的 tgz 离线安装，' +
  '脚本/plist 写回并把源机器 home 路径重写为目标机器 home、node 解释器重写为本机 node，plist 自动 launchctl load）。' +
  '工具：dshbackup_backup（备份并 push）、dshbackup_restore（拉取并重装）、dshbackup_verify（备份前/恢复前预检）、dshbackup_list（备份历史）、dshbackup_config（配置 backupDir / repoUrl / includeSecrets / includeAux / autoBackup / backupIntervalMinutes / backupRetryMinutes / autoBackupPush）。' +
  '支持内置定时备份：dshbackup_config 设 autoBackup=true 后，插件在宿主进程内按 backupIntervalMinutes（默认 1440 分钟，最小 15）自动执行与手动等价的备份；失败后按 backupRetryMinutes（默认 30 分钟，最小 5）重试，成功才回到正常间隔；' +
  '睡眠/重启错过的窗口会在下次唤醒或启动后自动补跑，运行状态（上次尝试/上次成功/连续失败次数/下次预计时间）记录在 dshbackup_config 与 /status 里。' +
  '用户提到「备份插件 / 迁移插件 / 换新电脑 / 同步插件环境 / 换机后定时任务丢了 / 自动备份」时即指本插件，请据此协作。配置存 ~/.dsh/dsh-backup-migrator.json（权限 0600）。'

/* ------------------------------------------------------------------ */
/* Config store                                                        */
/* ------------------------------------------------------------------ */

class BackupStore {
  constructor() { this.config = null }

  async load() {
    if (this.config) return this.config
    let saved = {}
    try {
      saved = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    this.config = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
    return this.config
  }

  async save(next) {
    this.config = next
    await mkdir(path.dirname(CONFIG_FILE), { recursive: true })
    await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  }

  async patch(patch) {
    const next = { ...(await this.load()), ...patch }
    await this.save(next)
    return next
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** The configure tool. */
export function backupConfigTool(ctx, store, log) {
  return defineTool({
    name: 'dshbackup_config',
    description:
      '查看或修改 dsh-backup-migrator 备份/迁移配置。参数：backupDir（备份仓库本地目录的绝对路径，会作为 git 仓库 push 到 GitHub，新机器上先 clone 到同一目录）、' +
      'repoUrl（GitHub 仓库地址，如 git@github.com:user/dsh-backup.git 或 https://…，留空=仅本地备份）、includeSecrets（是否备份含 token/密钥的插件配置文件，默认 true）、' +
      'includeAux（是否备份机器级附属资产：~/.dsh/scripts 下 helper 脚本 + ~/Library/LaunchAgents 下 com.dsh.*.plist，默认 true）、' +
      'profiles（要备份的 profile 名列表，留空=全部）、' +
      'autoBackup（是否开启内置定时备份，默认 false）、backupIntervalMinutes（定时备份间隔分钟数，最小 15，默认 1440=一天一次）、' +
      'backupRetryMinutes（失败后的重试间隔分钟数，最小 5，默认 30；成功则回到 backupIntervalMinutes）、autoBackupPush（定时备份是否 push 到远端，默认 true；false=只留本地提交）。' +
      '不带参数时返回当前配置、本机 profile 列表与定时备份状态（上次尝试/上次成功/连续失败/下次预计时间）。配置持久化到 ~/.dsh/dsh-backup-migrator.json。',
    parameters: {
      backupDir: { type: 'string', description: '备份仓库本地目录（绝对路径）' },
      repoUrl: { type: 'string', description: 'GitHub 仓库地址（留空清除 remote 配置）' },
      includeSecrets: { type: 'boolean', description: '是否备份含凭据的配置文件（默认 true）' },
      includeAux: { type: 'boolean', description: '是否备份 helper 脚本 + launchd 定时器（默认 true）' },
      profiles: { type: 'array', items: { type: 'string' }, description: '要备份的 profile 名列表（留空=全部）' },
      autoBackup: { type: 'boolean', description: '是否开启内置定时备份（默认 false）' },
      backupIntervalMinutes: { type: 'number', description: '定时备份间隔分钟数（最小 15，默认 1440）' },
      backupRetryMinutes: { type: 'number', description: '失败后的重试间隔分钟数（最小 5，默认 30）' },
      autoBackupPush: { type: 'boolean', description: '定时备份是否 push 到远端（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          config: { type: 'object', additionalProperties: true },
          configPath: { type: 'string' },
          profilesFound: { type: 'array', items: { type: 'string' } },
          schedule: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              intervalMinutes: { type: 'number' },
              retryMinutes: { type: 'number' },
              push: { type: 'boolean' },
              due: { type: 'boolean' },
              lastAttemptAt: { type: 'string' },
              lastSuccessAt: { type: 'string' },
              nextRunAt: { type: 'string' },
              consecutiveFailures: { type: 'number' },
              lastResult: { type: 'object', additionalProperties: true },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: '[failed] ' + (value.error || '读取配置失败') }]
        const c = value.config || {}
        const summary =
          '备份目录 ' + (c.backupDir || '（未设置）') +
          ' · 远端 ' + (c.repoUrl || '（未设置，仅本地备份）') +
          ' · 含凭据 ' + (c.includeSecrets !== false ? '是' : '否') +
          ' · 含脚本/定时器 ' + (c.includeAux !== false ? '是' : '否') +
          ' · 本机 profile ' + ((value.profilesFound || []).join(', ') || '无')
        const s = value.schedule
        const lines = [summary + '。配置保存于 ' + (value.configPath || CONFIG_FILE)]
        if (s) {
          lines.push('', '## 定时备份')
          if (!s.enabled) {
            lines.push('- 未开启（autoBackup=false）。开启：dshbackup_config autoBackup=true（可配 backupIntervalMinutes / backupRetryMinutes / autoBackupPush）')
          } else {
            const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')
            lines.push(`- 已开启：每 ${s.intervalMinutes} 分钟一次${s.push ? '，自动 push 到远端' : '，只留本地提交'}${s.consecutiveFailures > 0 ? `（失败后每 ${s.retryMinutes} 分钟重试）` : ''}`)
            lines.push(`- 上次尝试：${fmt(s.lastAttemptAt)} · 上次成功：${fmt(s.lastSuccessAt)}`)
            lines.push(`- 下次预计：${fmt(s.nextRunAt)}${s.due ? '（已到期，下一个检查点执行）' : ''}`)
            if (s.consecutiveFailures > 0) lines.push(`- ⚠️ 连续失败 ${s.consecutiveFailures} 次${s.lastResult && s.lastResult.error ? '：' + s.lastResult.error : ''}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const a = args || {}
      const patch = {}
      if (typeof a.backupDir === 'string') patch.backupDir = a.backupDir.trim()
      if (typeof a.repoUrl === 'string') patch.repoUrl = a.repoUrl.trim()
      if (typeof a.includeSecrets === 'boolean') patch.includeSecrets = a.includeSecrets
      if (typeof a.includeAux === 'boolean') patch.includeAux = a.includeAux
      if (Array.isArray(a.profiles)) patch.profiles = a.profiles.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      if (typeof a.autoBackup === 'boolean') patch.autoBackup = a.autoBackup
      if (typeof a.autoBackupPush === 'boolean') patch.autoBackupPush = a.autoBackupPush
      if (a.backupIntervalMinutes !== undefined) {
        const n = Number(a.backupIntervalMinutes)
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'backupIntervalMinutes 必须是 >= 0 的数字' }
        patch.backupIntervalMinutes = normalizeInterval(n)
      }
      if (a.backupRetryMinutes !== undefined) {
        const n = Number(a.backupRetryMinutes)
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'backupRetryMinutes 必须是 >= 0 的数字' }
        patch.backupRetryMinutes = normalizeRetry(n)
      }
      const cfg = Object.keys(patch).length ? await store.patch(patch) : await store.load()
      const state = await readState(STATE_FILE)
      return { ok: true, config: cfg, configPath: CONFIG_FILE, profilesFound: await listProfiles(), schedule: scheduleStatus(cfg, state) }
    },
  })
}

/* ------------------------------------------------------------------ */
/* Backup pass (shared by the manual tool and the built-in scheduler)   */
/* ------------------------------------------------------------------ */

/**
 * Run one full backup pass: build the tree → git init/commit → push.
 * Shared by `dshbackup_backup` and the built-in scheduler so a scheduled run
 * is byte-for-byte the same operation as a manual one.
 * @param {object} cfg - store config (backupDir/repoUrl/includeSecrets/includeAux).
 * @param {object} [opts] - profiles / includeSecrets / includeAux / push / message.
 * @param {(msg: string) => void} [log]
 * @returns {Promise<object>} `{ ok, ...buildBackup summary, git }` or `{ ok: false, error }`.
 */
export async function runBackupOnce(cfg, opts = {}, log) {
  try {
    const o = opts || {}
    const includeSecrets = typeof o.includeSecrets === 'boolean' ? o.includeSecrets : cfg.includeSecrets
    const includeAux = typeof o.includeAux === 'boolean' ? o.includeAux : cfg.includeAux
    const res = await buildBackup(cfg, { profiles: o.profiles, includeSecrets, includeAux, log })
    if (!res.ok) return { ok: false, error: res.error || '备份失败' }

    // git: init if needed, commit, push
    let gitState = { repo: false }
    if (await isGitRoot(res.backupDir)) {
      gitState = { ...gitState, repo: true }
    } else {
      const init = await gitInit(res.backupDir)
      if (init.code !== 0) return { ok: false, error: 'git init 失败：' + (init.stderr || '').trim(), ...res }
      gitState = { ...gitState, repo: true }
    }
    const msg = (o.message && String(o.message).trim()) || `dsh backup ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
    const commit = await gitCommit(res.backupDir, msg, log)
    gitState.committed = !!commit.committed
    gitState.skipped = !!commit.skipped
    gitState.hash = commit.hash || null
    if (commit.error) gitState.error = commit.error

    if (o.push !== false) {
      const push = await gitPush(res.backupDir, (cfg.repoUrl || '').trim(), log)
      gitState.pushed = !!push.pushed
      gitState.branch = push.branch || null
      gitState.remote = push.remote || null
      if (push.error && !gitState.error) gitState.error = push.error
    }
    return { ok: true, ...res, git: gitState }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** The backup tool: build the backup tree, commit, push. */
export function backupTool(ctx, store, log) {
  return defineTool({
    name: 'dshbackup_backup',
    description:
      '执行一次插件环境备份：扫描本机 profile（默认全部）→ 生成 manifest.json（插件清单与来源）+ configs/（插件配置）+ profiles/<name>/packages/（本地源插件打包的 tgz）+ aux/（helper 脚本与 launchd 定时器）→ git commit → push 到配置的 GitHub 仓库。' +
      '参数：profiles（只备份指定 profile）、includeSecrets（覆盖配置，是否含凭据）、includeAux（覆盖配置，是否含脚本/定时器）、push（默认 true，push 到远端；false 只提交本地）、message（自定义 commit 信息）。' +
      '返回备份摘要与 git 结果；本地源插件（link:/file:）会自动打包、延迟同步这类插件体系外的脚本+plist 会进 aux/，这是换机器可恢复的关键。',
    parameters: {
      profiles: { type: 'array', items: { type: 'string' }, description: '只备份这些 profile（留空=全部）' },
      includeSecrets: { type: 'boolean', description: '是否备份含凭据的配置（默认取配置 includeSecrets）' },
      includeAux: { type: 'boolean', description: '是否备份脚本/定时器（默认取配置 includeAux）' },
      push: { type: 'boolean', description: '是否 push 到远端（默认 true，无 remote 时跳过）' },
      message: { type: 'string', description: '自定义 commit 信息（默认 dsh backup <时间>）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          backupDir: { type: 'string' },
          manifestPath: { type: 'string' },
          createdAt: { type: 'string' },
          profiles: { type: 'array', items: { type: 'string' } },
          missingProfiles: { type: 'array', items: { type: 'string' } },
          configs: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              included: { type: 'number' },
              excludedSecrets: { type: 'number' },
            },
          },
          packages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                profile: { type: 'string' },
                plugin: { type: 'string' },
                file: { type: 'string' },
                size: { type: 'number' },
                original: { type: 'string' },
              },
            },
          },
          aux: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    file: { type: 'string' },
                    original: { type: 'string' },
                  },
                },
              },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          git: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repo: { type: 'boolean' },
              committed: { type: 'boolean' },
              skipped: { type: 'boolean' },
              hash: { type: 'string' },
              pushed: { type: 'boolean' },
              branch: { type: 'string' },
              remote: { type: 'string' },
              error: { type: 'string' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: '[failed] ' + (value.error || '备份失败') }]
        const g = value.git || {}
        const lines = []
        lines.push(`# 备份完成 → ${value.backupDir}`)
        lines.push('')
        lines.push(`- profiles：${(value.profiles || []).join(', ') || '无'}`)
        lines.push(`- 配置：${value.configs ? value.configs.included : 0} 个（含凭据 ${(value.configs || {}).excludedSecrets ? '已排除 ' + value.configs.excludedSecrets + ' 个' : '是'}`)
        lines.push(`- 本地源插件包：${(value.packages || []).length} 个`)
        if (value.aux) lines.push(`- 脚本/定时器（aux）：${value.aux.total || 0} 个${(value.aux.items || []).length ? '（' + value.aux.items.map((a) => a.id).join('、') + '）' : ''}`)
        if (g.committed) lines.push(`- git：已提交 ${g.hash || ''}${g.pushed ? '，已 push 到 ' + (g.remote || '远端') : g.skipped ? '（无变更，跳过提交）' : '（未 push）'}`)
        if (g.error) lines.push(`- ⚠️ git：${g.error}`)
        if ((value.warnings || []).length) lines.push('', '## 警告', '', ...value.warnings.map((w) => '- ⚠️ ' + w))
        if ((value.missingProfiles || []).length) lines.push('', '以下 profile 不存在，已跳过：' + value.missingProfiles.join(', '))
        lines.push('', '> 换新机器：安装 dsh-backup-migrator 后配置 backupDir 并 dshbackup_restore 即可还原。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const a = args || {}
      const cfg = await store.load()
      return runBackupOnce(cfg, {
        profiles: a.profiles,
        includeSecrets: a.includeSecrets,
        includeAux: a.includeAux,
        push: a.push,
        message: a.message,
      }, log)
    },
  })
}

/** The verify tool: preflight before backup or restore. */
export function verifyTool(ctx, store, log) {
  return defineTool({
    name: 'dshbackup_verify',
    description:
      '预检备份/恢复环境：检查备份目录 git 状态与 remote、pnpm 可用性、每个插件的来源可恢复性（link/file 源是否存在、github 是否钉 commit）、敏感配置文件提示。' +
      '自动识别当前处于备份侧（backupDir 没有 manifest）还是恢复侧（有 manifest 时检查 tgz 是否齐全、目标 profile 是否存在）。参数 profiles 限定检查范围。',
    parameters: {
      profiles: { type: 'array', items: { type: 'string' }, description: '只检查这些 profile（留空=全部）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string' },
                subject: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok && !value.checks) return [{ type: 'text', text: '[failed] ' + (value.error || '预检失败') }]
        const lines = ['# 预检结果', '']
        for (const c of value.checks || []) {
          const icon = c.level === 'error' ? '❌' : c.level === 'warn' ? '⚠️' : '✅'
          lines.push(`- ${icon} **${c.subject}** — ${c.message}`)
        }
        const errs = (value.checks || []).filter((c) => c.level === 'error').length
        const warns = (value.checks || []).filter((c) => c.level === 'warn').length
        lines.push('', `共 ${errs} 个错误、${warns} 个警告${value.ok ? '，可以继续' : '，请先解决错误'}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      try {
        const cfg = await store.load()
        const res = await verifyBackup(cfg, { profiles: args && args.profiles, log })
        return { ok: res.ok, checks: res.checks }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    },
  })
}

/** The restore tool: pull the backup and reinstall everything. */
export function restoreTool(ctx, store, log) {
  return defineTool({
    name: 'dshbackup_restore',
    description:
      '在新机器上还原插件环境：拉取备份仓库（已有目录则 git pull，没有则按 repoUrl clone）→ 读取 manifest → 对每个 profile 逐个 pnpm add 重装插件（npm/github 源联网安装，link/file 本地源用仓库里的 tgz 离线安装）→ ' +
      '写回 dsh.profile.bundles 加载顺序与 cordis.patch.yml 用户 patch 层 → 把 configs/ 配置写回 ~/.dsh（0600）→ 把 aux/ 的 helper 脚本与 launchd plist 写回本机（源机器 home 路径与 node 解释器自动重写，plist 自动 launchctl load）。' +
      '参数：profiles（只恢复指定 profile，默认全部）、withConfigs（默认 true，是否恢复配置）、withAux（默认 true，是否恢复脚本/定时器）、loadAgents（默认 true，是否 launchctl load）、dryRun（只输出计划不执行）。完成后需重启 DSH GUI 生效，launchd 定时器无需等 GUI。',
    parameters: {
      profiles: { type: 'array', items: { type: 'string' }, description: '只恢复这些 profile（留空=全部）' },
      withConfigs: { type: 'boolean', description: '是否恢复 ~/.dsh 下的插件配置（默认 true）' },
      withAux: { type: 'boolean', description: '是否恢复 helper 脚本 + launchd 定时器（默认 true）' },
      loadAgents: { type: 'boolean', description: '恢复 plist 后是否自动 launchctl load（默认 true）' },
      dryRun: { type: 'boolean', description: '只检查并输出恢复计划，不写任何文件（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          backupDir: { type: 'string' },
          git: { type: 'array', items: { type: 'string' } },
          profiles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                ok: { type: 'boolean' },
                installs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      source: { type: 'string' },
                      action: { type: 'string' },
                      addSpec: { type: 'string' },
                      fromPackage: { type: 'boolean' },
                      ok: { type: 'boolean' },
                      error: { type: 'string' },
                    },
                  },
                },
                bundles: { type: 'array', items: { type: 'string' } },
                patch: { type: 'string' },
                errors: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
          },
          configs: {
            type: 'object',
            additionalProperties: false,
            properties: {
              restored: { type: 'number' },
              skipped: { type: 'number' },
              entries: { type: 'array', items: { type: 'string' } },
            },
          },
          aux: {
            type: 'object',
            additionalProperties: false,
            properties: {
              restored: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    label: { type: 'string' },
                    dest: { type: 'string' },
                    mode: { type: 'number' },
                    pathRewritten: { type: 'boolean' },
                    loaded: { type: 'boolean' },
                    loadVia: { type: 'string' },
                  },
                },
              },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
              warnings: { type: 'array', items: { type: 'string' } },
              plan: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    kind: { type: 'string' },
                    label: { type: 'string' },
                    file: { type: 'string' },
                    dest: { type: 'string' },
                    from: { type: 'string' },
                    willRestore: { type: 'boolean' },
                  },
                },
              },
              sourceHome: { type: 'string' },
              targetHome: { type: 'string' },
            },
          },
          dryRun: { type: 'boolean' },
          reminder: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok && !value.profiles) return [{ type: 'text', text: '[failed] ' + (value.error || '恢复失败') }]
        const lines = [`# 恢复${value.dryRun ? '计划（dryRun，未执行）' : '完成'} ← ${value.backupDir}`, '']
        for (const g of value.git || []) lines.push(`- git：${g}`)
        for (const p of value.profiles || []) {
          if (p.error) { lines.push(`- ❌ **${p.name}** — ${p.error}`); continue }
          lines.push(`- ${p.ok ? '✅' : '⚠️'} **${p.name}**：${(p.installs || []).length} 个插件`)
          for (const i of p.installs || []) {
            if (i.ok === false || i.action === 'error') lines.push(`  - ❌ ${i.name}（${i.source}）：${i.error || '失败'}`)
            else if (value.dryRun) lines.push(`  - ▶ ${i.name}（${i.source}）→ pnpm add ${i.addSpec}`)
          }
          if (p.bundles && p.bundles.length) lines.push(`  - bundles 加载顺序：${p.bundles.length} 个${p.patch === 'restored' ? '，patch 层已恢复' : p.patch === 'none' ? '' : '，patch：' + p.patch}`)
          if (p.errors && p.errors.length) lines.push(`  - 错误：${p.errors.join('；')}`)
        }
        if (value.configs) lines.push(`- 配置：${value.dryRun ? '（dryRun 不恢复）' : '恢复 ' + value.configs.restored + ' 个' + (value.configs.skipped ? '，跳过' : '')}`)
        const aux = value.aux
        if (aux) {
          if (value.dryRun && aux.plan) {
            lines.push(`- 脚本/定时器（aux）：${aux.plan.length} 个待恢复${aux.sourceHome ? `（路径 ${aux.sourceHome} → ${aux.targetHome}）` : ''}`)
            for (const p of aux.plan) lines.push(`  - ▶ ${p.id}${p.willRestore ? '' : '（当前平台跳过）'} → ${p.dest}`)
          } else {
            lines.push(`- 脚本/定时器（aux）：恢复 ${(aux.restored || []).length} 个${(aux.skipped || []).length ? '，跳过 ' + aux.skipped.length + ' 个' : ''}`)
            for (const a of aux.restored || []) {
              lines.push(`  - ✅ ${a.id}${a.pathRewritten ? '（路径已重写）' : ''}${a.kind === 'launchAgent' ? (a.loaded ? ' · launchctl 已加载' : ' · ⚠️ launchctl 未加载') : ''} → ${a.dest}`)
            }
          }
          if ((aux.warnings || []).length) lines.push(`  - 提示：${aux.warnings.join('；')}`)
        }
        if (!value.dryRun && value.reminder) lines.push('', `> ${value.reminder}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const a = args || {}
      try {
        const cfg = await store.load()
        const res = await restoreBackup(cfg, {
          profiles: a.profiles,
          withConfigs: typeof a.withConfigs === 'boolean' ? a.withConfigs : true,
          withAux: typeof a.withAux === 'boolean' ? a.withAux : true,
          loadAgents: typeof a.loadAgents === 'boolean' ? a.loadAgents : true,
          dryRun: a.dryRun === true,
          log,
        })
        return res
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    },
  })
}

/** The list tool: backup history + latest manifest summary. */
export function listTool(ctx, store, log) {
  return defineTool({
    name: 'dshbackup_list',
    description:
      '查看备份状态：备份目录的 git 历史（每次 backup 一个提交，可回滚）、remote 地址，以及最新一次备份的内容摘要（profile、插件数、配置数）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          backupDir: { type: 'string' },
          isRepo: { type: 'boolean' },
          remote: { type: 'string' },
          commits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hash: { type: 'string' },
                date: { type: 'number' },
                message: { type: 'string' },
              },
            },
          },
          latest: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: '[failed] ' + (value.error || '读取失败') }]
        const lines = [`# 备份状态 → ${value.backupDir}`, '']
        lines.push(`- git 仓库：${value.isRepo ? '是' : '否'} · remote：${value.remote || '未配置'}`)
        if (value.latest) {
          const l = value.latest
          lines.push(`- 最新备份：${l.createdAt || '?'}（机器 ${l.hostname || '?'}）`)
          for (const p of l.profiles || []) {
            lines.push(`  - ${p.name}：${p.plugins} 个插件 / ${p.bundles} 个 bundles${p.hasUserPatch ? ' / 有 patch' : ''}`)
          }
          lines.push(`  - 配置 ${l.configs} 个${l.configsExcludedSecrets ? `（排除凭据 ${l.configsExcludedSecrets} 个）` : ''}`)
          lines.push(`  - 脚本/定时器 ${(l.aux || []).length} 个${(l.aux || []).length ? '（' + l.aux.map((a) => a.id).join('、') + '）' : ''}${l.auxSourceHome ? ` · 源 home ${l.auxSourceHome}` : ''}`)
        } else {
          lines.push('- 还没有备份（manifest.json 不存在）')
        }
        if ((value.commits || []).length) {
          lines.push('', '## 备份历史')
          for (const c of value.commits) {
            const d = c.date ? new Date(c.date).toLocaleString('zh-CN', { hour12: false }) : '?'
            lines.push(`- \`${c.hash}\` ${d} — ${c.message}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      try {
        const cfg = await store.load()
        return await listBackup(cfg, log)
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    },
  })
}

/* ------------------------------------------------------------------ */
/* Loopback HTTP surface (liveness probe + read-only status)           */
/* ------------------------------------------------------------------ */

/** Route prefix — matches the package id so the portability kit can probe it. */
export const API_PREFIX = '/api/dsh-backup-migrator'

/** True only for loopback callers (same guard as the other DSH plugins). */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch (err) {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch (err) {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/**
 * Build the plugin's HTTP routes (exact paths, loopback-only, GET).
 *  - `/api/dsh-backup-migrator/probe`  liveness for the portability kit
 *  - `/api/dsh-backup-migrator/status` config + latest backup summary + schedule state
 * This plugin is otherwise tool-only; the probe exists so external agents and
 * the release kit can confirm the host actually loaded it.
 */
export function backupRoutes(store, log) {
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false }
    if ((req.method ?? 'GET') !== method) { writeJson(res, 405, { error: `method not allowed: ${req.method}` }); return false }
    return true
  }
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/probe`,
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { ok: true, plugin: 'dsh-backup-migrator', version: PKG.version || null })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const cfg = await store.load()
          const latest = await listBackup(cfg, log)
          const state = await readState(STATE_FILE)
          writeJson(res, 200, { ok: true, config: cfg, latest: latest.latest, schedule: scheduleStatus(cfg, state) })
        } catch (err) {
          writeJson(res, 500, { ok: false, error: String(err && err.message || err) })
        }
      },
    },
  ]
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Plugin entry: register the tools, the announcement section and the
 * loopback HTTP routes.
 * @param ctx - host plugin context.
 * @param config - plugin configuration from the composition row.
 */
export function apply(ctx, config = {}) {
  const announceToAgent = config.announceToAgent !== false
  const enabled = config.enabled !== false
  const store = new BackupStore()
  const log = (message) => {
    if (ctx.logger?.info) ctx.logger.info(`[dsh-backup-migrator] ${message}`)
    else console.log(`[dsh-backup-migrator] ${message}`)
  }

  let disposeTools
  let disposeSection
  let disposeRoutes
  let disposeSchedule

  const sync = () => {
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeSchedule !== undefined) { disposeSchedule(); disposeSchedule = undefined }
    if (!enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = [
          backupConfigTool(ctx, store, log),
          backupTool(ctx, store, log),
          verifyTool(ctx, store, log),
          restoreTool(ctx, store, log),
          listTool(ctx, store, log),
        ].map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-backup-migrator: tools',
    )
    if (ctx.webServer?.register) {
      disposeRoutes = ctx.effect(
        () => {
          const disposers = backupRoutes(store, log).map((route) => ctx.webServer.register(route))
          return () => { for (const dispose of disposers) dispose() }
        },
        'dsh-backup-migrator: routes',
      )
    }
    // 内置定时备份：宿主进程内的调度循环（默认关闭；开启后与手动备份完全等价）
    disposeSchedule = ctx.effect(
      () => {
        const sched = startScheduler({
          readConfig: () => store.load(),
          runOnce: (cfg) => runBackupOnce(cfg, {
            push: cfg.autoBackupPush !== false,
            message: `dsh backup (scheduled) ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
          }, log),
          stateFile: STATE_FILE,
          log,
        })
        return () => sched.dispose()
      },
      'dsh-backup-migrator: schedule',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-backup-migrator',
        order: SECTION_ORDER,
        text: BACKUP_GUIDANCE,
      })
    }
  }

  sync()
}

/* --- smoke-test exports (not part of the public plugin surface) --- */
export { BackupStore, CONFIG_FILE, STATE_FILE, isLoopbackRequest }
