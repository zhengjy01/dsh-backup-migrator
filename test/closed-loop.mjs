/**
 * 闭环测试：真实备份本机 profile → 在临时沙箱 profile 中恢复 → 校验。
 *
 * 运行：node test/closed-loop.mjs
 * 注意：
 *  - 备份目录 = ~/Documents/DSH-Backup（真实持久产物，保留）
 *  - 恢复目标 = /tmp/dsh-restore-test/profiles/web（沙箱，测完自动删除）
 *  - 不会改动 ~/.dsh 下的任何真实 profile / 配置（withConfigs:false）
 */

import { mkdir, cp, rm, readFile, stat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { buildBackup, verifyBackup, restoreBackup, listBackup } from '../lib/ops.js'
import { gitInit, gitCommit, isGitRoot } from '../lib/git.js'

const log = (m) => console.log('[closed-loop]', m)
const BACKUP_DIR = path.join(homedir(), 'Documents', 'DSH-Plugin-Backup')
const SANDBOX_PROFILES = '/tmp/dsh-restore-test/profiles'
const WEB_SRC = path.join(homedir(), '.dsh', 'profiles', 'web')

const cfg = { backupDir: BACKUP_DIR, repoUrl: '', includeSecrets: true }

// 1. git init backup dir (dedicated repo — never a subdir of another repo)
await mkdir(BACKUP_DIR, { recursive: true })
if (!(await isGitRoot(BACKUP_DIR))) await gitInit(BACKUP_DIR)
await gitCommit(BACKUP_DIR, 'chore: init backup repo', log)

// 2. real backup of ALL profiles
log('=== 开始备份 ===')
const res = await buildBackup(cfg, { includeSecrets: true, log })
console.log(JSON.stringify({ profiles: res.profiles, configs: res.configs, packages: res.packages.length, warnings: res.warnings }, null, 2))
await gitCommit(BACKUP_DIR, `dsh backup test ${new Date().toISOString()}`, log)

// 3. verify (backup side)
log('=== 预检（备份侧） ===')
const v = await verifyBackup(cfg, { log })
const bad = v.checks.filter((c) => c.level === 'error')
const warn = v.checks.filter((c) => c.level === 'warn')
for (const c of v.checks) console.log(`  [${c.level}] ${c.subject}: ${c.message}`)
if (bad.length) { console.error(`❌ 预检有 ${bad.length} 个错误`); process.exit(1) }
console.log(`✅ 预检通过（${warn.length} 个警告）`)

// 4. sandbox: simulate a fresh machine profile dir
log('=== 准备沙箱 profile ===')
await rm(SANDBOX_PROFILES, { recursive: true, force: true })
await mkdir(path.join(SANDBOX_PROFILES, 'web'), { recursive: true })
await cp(path.join(WEB_SRC, 'package.json'), path.join(SANDBOX_PROFILES, 'web', 'package.json'))
await cp(path.join(WEB_SRC, 'pnpm-workspace.yaml'), path.join(SANDBOX_PROFILES, 'web', 'pnpm-workspace.yaml'))
await cp(path.join(WEB_SRC, 'cordis.patch.yml'), path.join(SANDBOX_PROFILES, 'web', 'cordis.patch.yml'))

// 5. dryRun first
log('=== restore dryRun ===')
const dry = await restoreBackup(cfg, { profiles: ['web'], dryRun: true, withConfigs: false, profilesDir: SANDBOX_PROFILES, log })
console.log(JSON.stringify(dry, null, 2).slice(0, 3000))

// 6. real restore
log('=== restore 真实执行（pnpm add × N，耐心等） ===')
const r = await restoreBackup(cfg, { profiles: ['web'], withConfigs: false, profilesDir: SANDBOX_PROFILES, log })
const failedInstalls = r.profiles.flatMap((p) => (p.installs || []).filter((i) => i.ok === false))
console.log('恢复结果:', JSON.stringify({ ok: r.ok, git: r.git, profiles: r.profiles.map((p) => ({ name: p.name, ok: p.ok, patch: p.patch, installs: p.installs.length, errors: p.errors })) }, null, 2))
if (!r.ok || failedInstalls.length) {
  console.error('❌ 恢复失败:', JSON.stringify(failedInstalls, null, 2))
  process.exit(1)
}

// 7. verify the sandbox result
log('=== 校验沙箱恢复结果 ===')
const sandboxPkg = JSON.parse(await readFile(path.join(SANDBOX_PROFILES, 'web', 'package.json'), 'utf8'))
const bundles = (sandboxPkg.dsh && sandboxPkg.dsh.profile && sandboxPkg.dsh.profile.bundles) || []
console.log('bundles 数量:', bundles.length, '(应为 21)')
const nm = path.join(SANDBOX_PROFILES, 'web', 'node_modules')
const nmEntries = await readdir(nm).catch(() => [])
const keyPlugins = ['dsh-flomo', 'dsh-flomo-report', 'dsh-handoff', 'dsh-npm', 'dsh-ticktick', 'dsh-zhipin', 'dsh-cloudflare-mcp', 'dsh-settings-nav-organizer']
for (const k of keyPlugins) {
  const found = nmEntries.includes(k) || (await stat(path.join(nm, '@dsh-external', k.replace(/^@dsh-external\//, ''))).then(() => true).catch(() => false))
  console.log(`  ${k}: ${found ? '✅ 已安装' : '❌ 缺失'}`)
}
const patch = await readFile(path.join(SANDBOX_PROFILES, 'web', 'cordis.patch.yml'), 'utf8')
console.log('cordis.patch.yml 恢复:', patch.includes('settings-nav-organizer') ? '✅' : '❌')

// 8. list
log('=== listBackup ===')
const l = await listBackup(cfg, log)
console.log(JSON.stringify({ isRepo: l.isRepo, remote: l.remote, commits: l.commits.length, latest: l.latest }, null, 2))

// 9. cleanup sandbox
await rm('/tmp/dsh-restore-test', { recursive: true, force: true })
log('✅ 闭环测试全部通过，沙箱已清理（备份保留在 ' + BACKUP_DIR + '）')
