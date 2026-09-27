/**
 * 配置收集的「运行时目录排除」语义测试。
 *
 * 背景：findConfigEntries() 原先把 `~/.dsh/dsh-*` 目录整体当插件配置收集，
 * 于是 dsh-runtimes（完整 Python+Node+pnpm 运行时，约 360 MB）每轮都被拷进
 * 备份，在宿主进程里搬几百 MB → Web 界面卡死；且它早已被 .gitignore 排除，
 * 属「白拷」。修复后：运行时目录只保留其中体积很小的顶层配置 JSON。
 *
 * 断言：
 *   1. 名单内的运行时目录 → 只留小 json，token/子目录不入备份（reason=runtime）
 *   2. 名单外的超限目录 → 同样处置，并带上体积（reason=too-large）——防止
 *      新装的遥测类插件（如 dsh-usage-hud）再次把备份撑大
 *   3. 小配置目录 / `dsh-*.json` 文件照旧整体收集
 *   4. CONFIG_EXCLUDE（dsh-browser / dsh-backup-migrator*）永不出现
 *   5. buildBackup 真的按上述规则落盘（configs/ 树的端到端校验）
 *
 * 运行：node test/config-entries.mjs
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let pass = 0
let failed = 0
const ok = (m) => { pass++; console.log('✅', m) }
const fail = (m) => { failed++; console.error('❌', m); process.exitCode = 1 }
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad))

const root = await mkdtemp(path.join(tmpdir(), 'dsh-config-entries-'))
const home = path.join(root, 'home')
const dsh = path.join(home, '.dsh')
const backupDir = path.join(root, 'backup')

// DSH_HOME 必须在 import 之前设好：ops.js 在模块加载时解析它。
process.env.DSH_HOME = dsh

const MB = 1024 * 1024
await mkdir(path.join(dsh, 'dsh-updater', 'logs'), { recursive: true })
await writeFile(path.join(dsh, 'dsh-updater', 'config.json'), '{"channel":"latest"}')
await writeFile(path.join(dsh, 'dsh-updater', 'status.json'), Buffer.alloc(8 * MB))
await writeFile(path.join(dsh, 'dsh-updater', 'logs', 'run.log'), Buffer.alloc(2 * MB))
await writeFile(path.join(dsh, 'dsh-updater', 'token'), 'super-secret-token')

await mkdir(path.join(dsh, 'dsh-unknown-fat', 'reports'), { recursive: true })
await writeFile(path.join(dsh, 'dsh-unknown-fat', 'ui.json'), '{"theme":"dark"}')
await writeFile(path.join(dsh, 'dsh-unknown-fat', 'reports', 'r.html'), Buffer.alloc(5 * MB))

await mkdir(path.join(dsh, 'dsh-task-dispatcher'), { recursive: true })
await writeFile(path.join(dsh, 'dsh-task-dispatcher', 'today-tasks.md'), '# tasks')
await writeFile(path.join(dsh, 'dsh-task-dispatcher.json'), '{}')

await mkdir(path.join(dsh, 'dsh-browser'), { recursive: true })
await writeFile(path.join(dsh, 'dsh-browser', 'cache.bin'), 'x')
await writeFile(path.join(dsh, 'dsh-backup-migrator.json'), '{}')

const { findConfigEntries, CONFIG_DIR_MAX_BYTES, buildBackup, DSH_HOME } = await import('../lib/ops.js')

check(DSH_HOME === dsh, 'DSH_HOME 跟随临时目录', `DSH_HOME 没跟随 env：${DSH_HOME}`)

const skipped = []
const entries = await findConfigEntries({ onSkip: (s) => skipped.push(s) })
const rels = entries.map((e) => e.rel)
const byRel = Object.fromEntries(entries.map((e) => [e.rel, e]))

/* ---------------- 1 & 3 & 4：条目集合 ---------------- */
check(rels.includes('dsh-task-dispatcher') && rels.includes('dsh-task-dispatcher.json'),
  '小配置目录与 dsh-*.json 照旧收集',
  `小配置条目缺失：${rels.join(', ')}`)
check(!rels.includes('dsh-browser') && !rels.includes('dsh-backup-migrator.json'),
  'CONFIG_EXCLUDE 名单永不进入备份',
  `CONFIG_EXCLUDE 泄漏：${rels.join(', ')}`)
check(rels.includes('dsh-updater') && rels.includes('dsh-unknown-fat'),
  '运行时目录仍保留其小配置（不整目录丢弃）',
  `运行时目录的小配置丢了：${rels.join(', ')}`)

/* ---------------- 1：名单内运行时目录 ---------------- */
const upd = byRel['dsh-updater']
check(upd && upd.runtime === true && upd.isDir === true, 'dsh-updater 标记为 runtime 条目', 'dsh-updater 未标记 runtime')
check(JSON.stringify(upd?.keep?.map((k) => k.rel)) === JSON.stringify(['config.json']),
  'dsh-updater 仅保留 config.json（token / status.json / logs 被排除）',
  `dsh-updater keep 不符：${JSON.stringify(upd?.keep?.map((k) => k.rel))}`)
check(upd?.size === 20, `dsh-updater 记录的体积是「保留部分」20 B（实际 ${upd?.size}）`, `dsh-updater size 应为 20，实际 ${upd?.size}`)

/* ---------------- 2：名单外超限目录 ---------------- */
const fat = byRel['dsh-unknown-fat']
check(fat?.runtime === true && JSON.stringify(fat?.keep?.map((k) => k.rel)) === JSON.stringify(['ui.json']),
  '名单外的超限目录同样只留小配置（新插件不会再撑大备份）',
  `dsh-unknown-fat 处置不符：${JSON.stringify(fat?.keep?.map((k) => k.rel))}`)
const fatSkip = skipped.find((s) => s.rel === 'dsh-unknown-fat')
check(fatSkip?.reason === 'too-large' && fatSkip.size > CONFIG_DIR_MAX_BYTES,
  `超限目录以 too-large 上报且带真实体积（> ${CONFIG_DIR_MAX_BYTES / MB} MB）`,
  `超限上报不符：${JSON.stringify(fatSkip)}`)
check(skipped.find((s) => s.rel === 'dsh-updater')?.reason === 'runtime',
  '运行时目录以 runtime 上报（便于 verify 输出区分原因）',
  'dsh-updater 未以 runtime 上报')

/* ---------------- 5：buildBackup 端到端 ---------------- */
await mkdir(path.join(dsh, 'profiles', 'demo'), { recursive: true })
await writeFile(path.join(dsh, 'profiles', 'demo', 'package.json'), JSON.stringify({
  name: 'demo', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } },
}))
await mkdir(backupDir, { recursive: true })

const built = await buildBackup(
  { backupDir, includeSecrets: true, includeAux: false },
  { homeDir: home, dshHome: dsh, log: () => {} },
)
const cfgDir = path.join(backupDir, 'configs')
const exists = (p) => stat(p).then(() => true).catch(() => false)

check(await exists(path.join(cfgDir, 'dsh-updater', 'config.json')), '落盘：运行时目录的小配置进了 configs/', '落盘缺少 dsh-updater/config.json')
check(!(await exists(path.join(cfgDir, 'dsh-updater', 'token'))), '落盘：token 未进备份', '落盘把 token 也备份了！')
check(!(await exists(path.join(cfgDir, 'dsh-updater', 'status.json'))), '落盘：status.json 未进备份', '落盘把 status.json 也备份了')
check(!(await exists(path.join(cfgDir, 'dsh-updater', 'logs'))), '落盘：logs/ 目录未进备份', '落盘把 logs/ 也备份了')
check(!(await exists(path.join(cfgDir, 'dsh-unknown-fat', 'reports'))), '落盘：超限目录的 reports/ 未进备份', '落盘把 reports/ 也备份了')
check(await exists(path.join(cfgDir, 'dsh-task-dispatcher', 'today-tasks.md')), '落盘：小配置目录整体保留', '落盘缺少 dsh-task-dispatcher/today-tasks.md')
check(!(await exists(path.join(cfgDir, 'dsh-browser'))), '落盘：dsh-browser 未进备份', '落盘把 dsh-browser 也备份了')

const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'))
const runtimeEntry = (manifest.configs || []).find((c) => c.rel === 'dsh-updater')
check(runtimeEntry?.runtime === true && runtimeEntry?.kept?.includes('config.json'),
  'manifest 记录了「运行时目录 + 只保留了哪些配置」',
  `manifest 缺少 runtime/kept 说明：${JSON.stringify(runtimeEntry)}`)
check((built.warnings || []).some((w) => w.includes('dsh-updater') && w.includes('运行时目录')),
  'buildBackup 对跳过行为发出 warning（不静默）',
  `warnings 未提及 dsh-updater：${JSON.stringify(built.warnings)}`)

/* ---------------- 汇总 ---------------- */
await rm(root, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项，失败 ${failed} 项`)
if (failed) process.exitCode = 1
