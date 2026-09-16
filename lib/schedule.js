/**
 * 内置定时备份：到期判定 + 状态持久化 + 调度循环。
 *
 * 设计取舍（为什么长这样）：
 *  - 用「周期 tick 循环」而不是「一次性 setTimeout 到下次到期」：配置改了即时生效，
 *    Mac 睡眠/DSH 重启错过的窗口会在下一个 tick 自动补上，也无需到处重排定时器。
 *  - 到期判定用 lastAttemptAt 而不是 lastSuccessAt：失败后也等满一个完整间隔再试，
 *    避免网络/凭据出问题时每个 tick 都重试，把 git 历史打爆。
 *  - 所有定时器 unref()：不阻止宿主进程正常退出；dispose() 能干净停掉（插件热重载必需）。
 *  - 单实例互斥：上一次还在跑就跳过本次 tick，绝不并发备份。
 *
 * 状态文件是**机器本地运行时状态**（不是用户配置），默认不参与备份（见 ops.js CONFIG_EXCLUDE）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 循环醒来的周期；顺带决定「睡眠/重启后多久补跑」。 */
export const TICK_MS = 60_000

/** 启动后首次检查的延迟，避开宿主 boot 高峰。 */
export const KICKOFF_DELAY_MS = 30_000

/** 间隔下限：定时备份永远不该变成热点循环。 */
export const MIN_INTERVAL_MINUTES = 15

/** 间隔默认值：一天一次。 */
export const DEFAULT_INTERVAL_MINUTES = 1440

/** 状态文件路径（机器本地，随 DSH_HOME 走）。 */
export function defaultStatePath(dshHome) {
  return path.join(dshHome, 'dsh-backup-migrator-state.json')
}

/** 把任意输入规整成合法间隔分钟数。 */
export function normalizeInterval(minutes) {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES
  return Math.max(MIN_INTERVAL_MINUTES, Math.round(n))
}

/**
 * 纯函数：此刻是否该跑一次定时备份？
 * @param {object} o
 * @param {boolean} o.enabled         是否开启定时备份
 * @param {string} [o.lastAttemptAt]  上次尝试的 ISO 时间（失败也算）
 * @param {number} [o.intervalMinutes] 间隔分钟数
 * @param {number} [o.now]            当前时间戳（便于测试）
 */
export function isDue({ enabled, lastAttemptAt, intervalMinutes, now = Date.now() }) {
  if (!enabled) return false
  if (!lastAttemptAt) return true
  const last = Date.parse(lastAttemptAt)
  // 从未跑过 / 时间戳解析不了 / 机器时钟被往回调过 → 一律视为到期
  if (!Number.isFinite(last)) return true
  if (last > now) return true
  return now - last >= normalizeInterval(intervalMinutes) * 60_000
}

/**
 * 纯函数：给状态/配置算一个可展示的调度快照（配置工具与 /status 共用）。
 * @returns {{ enabled: boolean, intervalMinutes: number, push: boolean,
 *             due: boolean, lastAttemptAt: string|null, lastSuccessAt: string|null,
 *             nextRunAt: string|null, consecutiveFailures: number, lastResult: object|null }}
 */
export function scheduleStatus(cfg, state, now = Date.now()) {
  const c = cfg || {}
  const s = state || {}
  const enabled = c.autoBackup === true
  const intervalMinutes = normalizeInterval(c.backupIntervalMinutes)
  const lastAttemptAt = typeof s.lastAttemptAt === 'string' ? s.lastAttemptAt : null
  const due = isDue({ enabled, lastAttemptAt, intervalMinutes, now })
  let nextRunAt = null
  if (enabled) {
    if (due) nextRunAt = new Date(now).toISOString()
    else nextRunAt = new Date(Date.parse(lastAttemptAt) + intervalMinutes * 60_000).toISOString()
  }
  return {
    enabled,
    intervalMinutes,
    push: c.autoBackupPush !== false,
    due,
    lastAttemptAt,
    lastSuccessAt: typeof s.lastSuccessAt === 'string' ? s.lastSuccessAt : null,
    nextRunAt,
    consecutiveFailures: Number(s.consecutiveFailures) || 0,
    lastResult: s.lastResult && typeof s.lastResult === 'object' ? s.lastResult : null,
  }
}

/** 读状态文件；不存在或损坏都返回 {}（定时备份不该因为状态文件坏掉而瘫掉）。 */
export async function readState(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    return {}
  }
}

/** 写状态文件（0600）。 */
export async function writeState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

/**
 * 启动调度循环。
 * @param {object} o
 * @param {() => Promise<object>} o.readConfig  每次 tick 重新读配置（改配置即时生效）
 * @param {(cfg: object) => Promise<object>} o.runOnce  真正跑一次备份，返回 { ok, git?, error? }
 * @param {string} o.stateFile                  状态文件路径
 * @param {(msg: string) => void} [o.log]
 * @param {number} [o.tickMs]
 * @param {number} [o.kickoffDelayMs]
 * @returns {{ dispose: () => void, tick: () => Promise<void> }} tick 暴露出来便于测试
 */
export function startScheduler({ readConfig, runOnce, stateFile, log = () => {}, tickMs = TICK_MS, kickoffDelayMs = KICKOFF_DELAY_MS }) {
  let disposed = false
  let running = false

  async function tick() {
    // 互斥必须在任何 await 之前同步置位：否则并发 tick 会一起越过闸门各跑一次备份
    if (disposed || running) return
    running = true
    try {
      let cfg
      try {
        cfg = await readConfig()
      } catch (err) {
        log(`定时备份：读取配置失败，跳过本次 tick：${String(err && err.message || err)}`)
        return
      }
      // 关掉定时备份时连状态文件都不读：循环保持「零成本空转」
      if (cfg.autoBackup !== true) return
      const state = await readState(stateFile)
      if (!isDue({
        enabled: true,
        lastAttemptAt: state.lastAttemptAt,
        intervalMinutes: cfg.backupIntervalMinutes,
      })) return

      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      const next = { lastAttemptAt: startedAt, consecutiveFailures: (Number(state.consecutiveFailures) || 0) + 1, lastResult: null }
      try {
        const res = await runOnce(cfg)
        const git = res && res.git ? res.git : {}
        const ok = !!(res && res.ok)
        if (ok) next.consecutiveFailures = 0
        next.lastResult = {
          ok,
          committed: !!git.committed,
          skipped: !!git.skipped,
          pushed: !!git.pushed,
          hash: git.hash || null,
          error: (res && res.error) || git.error || null,
          durationMs: Date.now() - startedMs,
        }
        if (ok) next.lastSuccessAt = new Date().toISOString()
        log(ok
          ? `定时备份完成：${next.lastResult.pushed ? '已 push' : next.lastResult.committed ? '已本地提交（未 push）' : '无变更'}${git.hash ? ' ' + git.hash : ''}`
          : `定时备份失败：${next.lastResult.error || '未知错误'}`)
        if (next.consecutiveFailures >= 3) log(`定时备份已连续失败 ${next.consecutiveFailures} 次，请检查 backupDir / 网络 / 凭据`)
      } catch (err) {
        const message = String(err && err.message || err)
        next.lastResult = { ok: false, committed: false, skipped: false, pushed: false, hash: null, error: message, durationMs: Date.now() - startedMs }
        log(`定时备份异常：${message}`)
      } finally {
        // 保留上一次的成功时间，避免失败把「上次成功」抹掉
        if (state.lastSuccessAt && !next.lastSuccessAt) next.lastSuccessAt = state.lastSuccessAt
        try {
          await writeState(stateFile, next)
        } catch (err) {
          log(`定时备份：写状态文件失败：${String(err && err.message || err)}`)
        }
      }
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => { void tick() }, tickMs)
  if (typeof interval.unref === 'function') interval.unref()
  // 启动后先查一次：补上「DSH 关着 / 机器睡过」而错过的窗口
  const kickoff = setTimeout(() => { void tick() }, kickoffDelayMs)
  if (typeof kickoff.unref === 'function') kickoff.unref()

  return {
    dispose() {
      disposed = true
      clearInterval(interval)
      clearTimeout(kickoff)
    },
    tick,
  }
}
