/**
 * 内置定时备份（lib/schedule.js）的行为测试：
 *  - 到期判定的纯函数边界（含时钟回拨、间隔下限钳制）
 *  - 状态文件读写（0600）
 *  - 调度循环：只跑一次、失败不刷屏、并发互斥、dispose 后彻底停
 *
 * 全部用手动 tick()，不依赖真实等待；tickMs / kickoffDelayMs 都设得极大。
 * 运行：node test/schedule-test.mjs
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  isDue, normalizeInterval, normalizeRetry, scheduleStatus, readState, writeState, startScheduler,
  DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, DEFAULT_RETRY_MINUTES, MIN_RETRY_MINUTES,
} from '../lib/schedule.js'

const failures = []
function check(name, cond, detail) {
  if (cond) { console.log('  ✅', name); return }
  console.log('  ❌', name, detail === undefined ? '' : `→ ${detail}`)
  failures.push(name)
}

const NOW = Date.parse('2026-09-17T10:00:00.000Z')
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString()
// 调度循环内部用真实 Date.now()，所以循环相关的状态必须按真实时间造，不能用上面的假 NOW
const realHoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()

/* ---------------- 1. 纯函数：到期判定 ---------------- */
console.log('\n[1] isDue / normalizeInterval')
check('未开启 → 永不到期', isDue({ enabled: false, lastAttemptAt: null, intervalMinutes: 1440, now: NOW }) === false)
check('开启且从未跑过 → 到期', isDue({ enabled: true, lastAttemptAt: null, intervalMinutes: 1440, now: NOW }) === true)
check('一天前跑过、间隔一天 → 到期', isDue({ enabled: true, lastAttemptAt: hoursAgo(24), intervalMinutes: 1440, now: NOW }) === true)
check('10 小时前成功跑过、间隔一天 → 未到期', isDue({ enabled: true, lastAttemptAt: hoursAgo(10), lastSuccessAt: hoursAgo(10), intervalMinutes: 1440, now: NOW }) === false)
check('有尝试但从未成功 → 按重试窗口，不再等满一天', isDue({ enabled: true, lastAttemptAt: hoursAgo(10), intervalMinutes: 1440, retryMinutes: 30, now: NOW }) === true)
check('时间戳损坏 → 到期（不卡死）', isDue({ enabled: true, lastAttemptAt: 'not-a-date', intervalMinutes: 1440, now: NOW }) === true)
check('时钟回拨（上次时间在未来）→ 到期', isDue({ enabled: true, lastAttemptAt: hoursAgo(-3), intervalMinutes: 1440, now: NOW }) === true)
check('间隔低于下限被钳到 15 分钟', normalizeInterval(1) === MIN_INTERVAL_MINUTES, String(normalizeInterval(1)))
check('间隔缺省 = 1440', normalizeInterval(undefined) === DEFAULT_INTERVAL_MINUTES, String(normalizeInterval(undefined)))
check('间隔为 0 / 负数 / 乱码 → 回落默认', normalizeInterval(0) === DEFAULT_INTERVAL_MINUTES && normalizeInterval(-5) === DEFAULT_INTERVAL_MINUTES && normalizeInterval('x') === DEFAULT_INTERVAL_MINUTES)
check('15 分钟间隔：16 分钟前 → 到期', isDue({ enabled: true, lastAttemptAt: hoursAgo(16 / 60), intervalMinutes: 15, now: NOW }) === true)
check('重试间隔下限 5 / 默认 30', normalizeRetry(1) === MIN_RETRY_MINUTES && normalizeRetry(undefined) === DEFAULT_RETRY_MINUTES)
check('失败连击、已过重试窗口 → 到期',
  isDue({ enabled: true, lastAttemptAt: hoursAgo(1), lastSuccessAt: hoursAgo(48), intervalMinutes: 1440, retryMinutes: 30, now: NOW }) === true)
check('失败连击、未到重试窗口 → 不到期',
  isDue({ enabled: true, lastAttemptAt: hoursAgo(0.25), lastSuccessAt: hoursAgo(48), intervalMinutes: 1440, retryMinutes: 30, now: NOW }) === false)
check('上一轮成功 → 即便过了重试窗口也等满 interval',
  isDue({ enabled: true, lastAttemptAt: hoursAgo(1), lastSuccessAt: hoursAgo(1), intervalMinutes: 1440, retryMinutes: 30, now: NOW }) === false)

/* ---------------- 2. 纯函数：scheduleStatus ---------------- */
console.log('\n[2] scheduleStatus')
const st = scheduleStatus({ autoBackup: false }, {}, NOW)
check('未开启时不报下次时间', st.enabled === false && st.nextRunAt === null && st.intervalMinutes === DEFAULT_INTERVAL_MINUTES)
const st2 = scheduleStatus({ autoBackup: true, backupIntervalMinutes: 1440, autoBackupPush: false }, { lastAttemptAt: hoursAgo(10), lastSuccessAt: hoursAgo(10) }, NOW)
check('未到期 → 下次时间 = 上次 + 间隔',
  st2.nextRunAt === new Date(NOW - 10 * 3_600_000 + 1440 * 60_000).toISOString(), String(st2.nextRunAt))
check('autoBackupPush=false 透传为 push=false', st2.push === false)
const st3 = scheduleStatus({ autoBackup: true }, { lastAttemptAt: hoursAgo(48), consecutiveFailures: 2 }, NOW)
check('已到期 → due=true 且下次时间 = 现在', st3.due === true && st3.nextRunAt === new Date(NOW).toISOString())
check('连续失败次数透传', st3.consecutiveFailures === 2)
const st4 = scheduleStatus({ autoBackup: true, backupIntervalMinutes: 1440, backupRetryMinutes: 30 }, { lastAttemptAt: hoursAgo(0.25), lastSuccessAt: hoursAgo(48) }, NOW)
check('失败连击未到窗口 → due=false 且 nextRunAt = 上次尝试 + 重试窗口', st4.due === false && st4.nextRunAt === new Date(NOW - 0.25 * 3_600_000 + 30 * 60_000).toISOString(), JSON.stringify({due:st4.due,next:st4.nextRunAt}))
check('retryMinutes 透传', st4.retryMinutes === 30)

/* ---------------- 3. 状态文件 ---------------- */
console.log('\n[3] 状态文件读写')
const dir = await mkdtemp(path.join(tmpdir(), 'dsh-backup-sched-'))
const stateFile = path.join(dir, 'state.json')
check('不存在的状态文件 → {}', JSON.stringify(await readState(stateFile)) === '{}')
await writeState(stateFile, { lastAttemptAt: 'X', consecutiveFailures: 1 })
const round = await readState(stateFile)
check('写读往返一致', round.lastAttemptAt === 'X' && round.consecutiveFailures === 1)
const mode = (await stat(stateFile)).mode & 0o777
check('状态文件权限 0600', mode === 0o600, mode.toString(8))
await writeState(stateFile, 'not json at all')
check('损坏内容不抛错 → {}', JSON.stringify(await readState(stateFile)) === '{}')

/* ---------------- 4. 调度循环 ---------------- */
console.log('\n[4] startScheduler')
const HUGE = 3_600_000
const mkSched = (cfgRef, runOnce, log = () => {}) => startScheduler({
  readConfig: async () => cfgRef.value,
  runOnce,
  stateFile,
  log,
  tickMs: HUGE,
  kickoffDelayMs: HUGE,
})

// 4.1 关闭时不跑
await writeState(stateFile, {})
let calls = 0
let sched = mkSched({ value: { autoBackup: false } }, async () => { calls++; return { ok: true } })
await sched.tick(); await sched.tick()
check('autoBackup=false → 一次都不跑', calls === 0, String(calls))
sched.dispose()

// 4.2 开启后跑一次，间隔内不再跑第二次
await writeState(stateFile, {})
calls = 0
sched = mkSched({ value: { autoBackup: true, backupIntervalMinutes: 1440, autoBackupPush: false } },
  async () => { calls++; return { ok: true, git: { committed: true, pushed: false, hash: 'abc1234' } } })
await sched.tick()
check('开启且从未跑过 → 跑一次', calls === 1, String(calls))
await sched.tick()
check('间隔内再 tick → 不重复跑', calls === 1, String(calls))
let stAfter = await readState(stateFile)
check('记录 lastAttemptAt / lastSuccessAt', !!stAfter.lastAttemptAt && !!stAfter.lastSuccessAt)
check('记录 lastResult（含 hash 与 push 结果）',
  stAfter.lastResult && stAfter.lastResult.ok === true && stAfter.lastResult.hash === 'abc1234' && stAfter.lastResult.pushed === false,
  JSON.stringify(stAfter.lastResult))
check('成功后 consecutiveFailures 归零', stAfter.consecutiveFailures === 0)
sched.dispose()

// 4.3 失败：计数递增、保留上次成功时间、不刷屏
await writeState(stateFile, { lastAttemptAt: hoursAgo(48), lastSuccessAt: hoursAgo(48), consecutiveFailures: 0 })
calls = 0
const logs = []
sched = mkSched({ value: { autoBackup: true, backupIntervalMinutes: 1440 } },
  async () => { calls++; return { ok: false, error: 'boom' } }, (m) => logs.push(m))
await sched.tick()
stAfter = await readState(stateFile)
check('失败后 consecutiveFailures=1', stAfter.consecutiveFailures === 1, String(stAfter.consecutiveFailures))
check('失败不抹掉 lastSuccessAt', stAfter.lastSuccessAt === hoursAgo(48))
check('失败也更新 lastAttemptAt（不会每 tick 重试）', stAfter.lastAttemptAt !== hoursAgo(48))
await sched.tick()
check('失败后同一间隔内不再重试', calls === 1, String(calls))
check('失败写了日志', logs.some((m) => m.includes('定时备份失败')), JSON.stringify(logs))
sched.dispose()

// 4.4 runOnce 抛异常也要被吞住并落状态
await writeState(stateFile, {})
sched = mkSched({ value: { autoBackup: true } }, async () => { throw new Error('network down') })
await sched.tick()
stAfter = await readState(stateFile)
check('runOnce 抛错被捕获并记为失败', stAfter.lastResult && stAfter.lastResult.ok === false && stAfter.lastResult.error === 'network down',
  JSON.stringify(stAfter.lastResult))
sched.dispose()

// 4.5 并发互斥：慢备份期间的 tick 全部跳过
await writeState(stateFile, {})
let slowCalls = 0
sched = mkSched({ value: { autoBackup: true } }, async () => {
  slowCalls++
  await new Promise((r) => setTimeout(r, 60))
  return { ok: true, git: {} }
})
await Promise.all([sched.tick(), sched.tick(), sched.tick()])
check('并发 tick 只跑一次', slowCalls === 1, String(slowCalls))
sched.dispose()

// 4.6 dispose 后不再跑
await writeState(stateFile, {})
let afterDispose = 0
sched = mkSched({ value: { autoBackup: true } }, async () => { afterDispose++; return { ok: true } })
sched.dispose()
await sched.tick()
check('dispose 后 tick 不再执行', afterDispose === 0, String(afterDispose))

// 4.7 push 失败必须算「失败」——否则等于静默丢备份（2026-09-17 首次真实运行就踩到）
await writeState(stateFile, {})
sched = mkSched({ value: { autoBackup: true, backupIntervalMinutes: 1440 } },
  async () => ({ ok: true, git: { committed: true, pushed: false, hash: 'aaa1111', error: 'git push 失败：SSL_ERROR_SYSCALL' } }))
await sched.tick()
stAfter = await readState(stateFile)
check('push 失败 → lastResult.ok=false', stAfter.lastResult && stAfter.lastResult.ok === false, JSON.stringify(stAfter.lastResult))
check('push 失败 → consecutiveFailures=1', stAfter.consecutiveFailures === 1, String(stAfter.consecutiveFailures))
check('push 失败 → 不写 lastSuccessAt', !stAfter.lastSuccessAt)
check('push 失败 → error 保留原文', String(stAfter.lastResult.error).includes('SSL_ERROR_SYSCALL'))
sched.dispose()

// 4.8 失败连击过了重试窗口 → 不必等满一整天，立刻再试
await writeState(stateFile, { lastAttemptAt: realHoursAgo(1), lastSuccessAt: realHoursAgo(48), consecutiveFailures: 1 })
calls = 0
sched = mkSched({ value: { autoBackup: true, backupIntervalMinutes: 1440, backupRetryMinutes: 30 } },
  async () => { calls++; return { ok: true, git: {} } })
await sched.tick()
check('失败连击过窗口 → 再跑一次', calls === 1, String(calls))
check('成功后 consecutiveFailures 归零', (await readState(stateFile)).consecutiveFailures === 0)
sched.dispose()

// 4.9 失败连击未到窗口 → 不跑（不刷屏）
await writeState(stateFile, { lastAttemptAt: realHoursAgo(0.25), lastSuccessAt: realHoursAgo(48), consecutiveFailures: 1 })
calls = 0
sched = mkSched({ value: { autoBackup: true, backupIntervalMinutes: 1440, backupRetryMinutes: 30 } },
  async () => { calls++; return { ok: true, git: {} } })
await sched.tick()
check('失败连击未到窗口 → 不跑', calls === 0, String(calls))
sched.dispose()

await rm(dir, { recursive: true, force: true })

/* ---------------- 汇总 ---------------- */
if (failures.length) {
  console.error(`\n❌ 定时备份测试失败 ${failures.length} 项：${failures.join('、')}`)
  process.exit(1)
}
console.log('\n✅ 定时备份全部通过')
