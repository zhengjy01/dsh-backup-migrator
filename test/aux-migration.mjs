/**
 * aux（机器级附属资产）换机迁移端到端测试。
 *
 * 验证目标（对应「把延迟同步脚本纳入备份与换机迁移链路」的完成标准）：
 *   1. 备份侧：真实扫描本机 → manifest.aux 记录脚本 + plist（含源 home）
 *   2. 恢复侧：在隔离的临时 HOME / DSH_HOME 里 restore → 脚本与 plist 落位，
 *      源机器 home 路径被重写为目标 home、node 解释器重写成本机 node
 *   3. 能力：恢复出来的脚本能 stage / status（延迟同步的「暂存」链路）
 *   4. 定时：恢复出来的 plist 能被 launchctl 接受（用唯一 Label 的副本测试，
 *      不动本机真实 com.dsh.ticktick-deferred-sync 任务）
 *   5. 真实备份链路：buildBackup 的产物里确实带 aux/
 *
 * 运行：node test/aux-migration.mjs
 * 说明：默认不做 profiles 的 pnpm 重装（manifest.profiles 置空），只验证
 *       configs + aux 这条链路；临时目录测完自动删除。
 */

import { mkdtemp, mkdir, rm, readFile, writeFile, stat, cp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { buildBackup, restoreBackup, verifyBackup } from '../lib/ops.js'
import { gitInit } from '../lib/git.js'
import { collectAuxAssets, DEFAULT_AUX_ASSETS, rewriteAuxText } from '../lib/aux.js'

const exec = promisify(execFile)
const log = (m) => console.log('[aux-migration]', m)
const fail = (m) => { console.error('❌', m); process.exitCode = 1 }
const ok = (m) => console.log('✅', m)

const sourceHome = homedir()
const root = await mkdtemp(path.join(tmpdir(), 'dsh-aux-test-'))
const backupDir = path.join(root, 'backup')
const restoreDir = path.join(root, 'restore-src')
const sandboxHome = path.join(root, 'home')
const sandboxDsh = path.join(sandboxHome, '.dsh')

let auxCount = 0
try {
  /* ---------------- 1. 真实备份（含 aux） ---------------- */
  log(`sandbox: ${root}`)
  await mkdir(backupDir, { recursive: true })
  const built = await buildBackup(
    { backupDir, includeSecrets: false, includeAux: true },
    { log },
  )
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'))
  auxCount = (manifest.aux && manifest.aux.items || []).length
  log(`buildBackup: profiles=${built.profiles.length} configs=${built.configs.included} aux=${auxCount}`)
  if (auxCount < DEFAULT_AUX_ASSETS.length) fail(`manifest.aux 只有 ${auxCount} 项，期望 ${DEFAULT_AUX_ASSETS.length}`)
  else ok(`manifest.aux 含 ${auxCount} 项（sourceHome=${manifest.aux.sourceHome}）`)
  if (manifest.aux.sourceHome !== sourceHome) fail(`sourceHome 记录错误：${manifest.aux.sourceHome}`)
  for (const a of manifest.aux.items) {
    const f = path.join(backupDir, a.file)
    if (!(await stat(f).then((s) => s.isFile()).catch(() => false))) fail(`备份缺少 ${a.file}`)
  }

  /* ---------------- 2. 准备隔离的恢复源 + 干净 HOME ---------------- */
  // 只保留 manifest / configs / aux，清空 profiles：本测试聚焦 aux 链路，
  // 不触发 20+ 插件的联网 pnpm add。
  await cp(backupDir, restoreDir, { recursive: true })
  const rManifestPath = path.join(restoreDir, 'manifest.json')
  const rManifest = JSON.parse(await readFile(rManifestPath, 'utf8'))
  rManifest.profiles = {}
  await writeFile(rManifestPath, JSON.stringify(rManifest, null, 2) + '\n')
  await rm(path.join(restoreDir, 'profiles'), { recursive: true, force: true })
  await gitInit(restoreDir)
  await mkdir(sandboxDsh, { recursive: true })

  /* ---------------- 3. 隔离恢复 ---------------- */
  const res = await restoreBackup(
    { backupDir: restoreDir, repoUrl: '', includeSecrets: true, includeAux: true },
    {
      profiles: [],
      withConfigs: true,
      withAux: true,
      loadAgents: false, // 定时器加载另行用唯一 Label 验证，避免动真实任务
      homeDir: sandboxHome,
      dshHome: sandboxDsh,
      profilesDir: path.join(sandboxDsh, 'profiles'),
      log,
    },
  )
  const restoredIds = (res.aux.restored || []).map((a) => a.id)
  if (restoredIds.length !== auxCount) fail(`恢复 ${restoredIds.length} 项，期望 ${auxCount}：${JSON.stringify(res.aux)}`)
  else ok(`aux 全部恢复：${restoredIds.join('、')}`)

  const scriptDest = path.join(sandboxDsh, 'scripts', 'ticktick-pending.mjs')
  const plistDest = path.join(sandboxHome, 'Library', 'LaunchAgents', 'com.dsh.ticktick-deferred-sync.plist')
  const scriptStat = await stat(scriptDest)
  if (!(scriptStat.mode & 0o111)) fail('恢复的脚本没有可执行位')
  else ok(`脚本落位且可执行（mode ${(scriptStat.mode & 0o777).toString(8)}）`)

  const scriptText = await readFile(scriptDest, 'utf8')
  if (scriptText.includes(sourceHome)) fail('脚本里仍残留源机器 home 路径')
  else ok('脚本无源机器 home 残留')

  const plistText = await readFile(plistDest, 'utf8')
  if (plistText.includes(sourceHome)) fail('plist 里仍残留源机器 home 路径')
  else ok('plist 路径已重写为目标 home')
  if (!plistText.includes(scriptDest)) fail(`plist 未指向恢复后的脚本（${scriptDest}）`)
  else ok('plist 指向恢复后的脚本')
  const nodeArg = (plistText.match(/<key>ProgramArguments<\/key>[\s\S]*?<array>\s*<string>([^<]+)<\/string>/) || [])[1]
  // 恢复策略：本机已存在该解释器就保留；不存在才换成 process.execPath。
  // 同机恢复时 /opt/homebrew/bin/node 存在，因此保留是正确行为。
  const nodeExists = await stat(nodeArg || '').then((s) => s.isFile()).catch(() => false)
  if (nodeArg !== process.execPath && !nodeExists) fail(`plist 的 node 解释器既不是本机 node 也不存在：${nodeArg}`)
  else ok(`plist 的 node 解释器可用：${nodeArg}${nodeArg === process.execPath ? '（已重写为本机 node）' : '（本机已存在，保留）'}`)

  // 直接单测解释器重写：给一个不存在的路径，必须换成 process.execPath
  const fakePlist = '<array><string>/nonexistent/dir/node</string><string>/tmp/x.mjs</string></array>'
  const rewrittenFake = rewriteAuxText(fakePlist, { sourceHome: '/Users/old', targetHome: '/Users/new', nodePath: process.execPath })
  if (!rewrittenFake.includes(process.execPath)) fail(`不存在的 node 解释器没有被重写：${rewrittenFake}`)
  else ok('解释器重写：不存在的 node 路径 → 本机 process.execPath')
  const homeRewritten = rewriteAuxText('<string>/Users/old/.dsh/scripts/x.mjs</string>', { sourceHome: '/Users/old', targetHome: '/Users/new' })
  if (!homeRewritten.includes('/Users/new/.dsh/scripts/x.mjs')) fail(`home 路径重写失败：${homeRewritten}`)
  else ok('home 重写：源 home → 目标 home')

  /* ---------------- 4. 恢复出来的脚本能 stage ---------------- */
  const env = { ...process.env, HOME: sandboxHome, DSH_HOME: sandboxDsh }
  // 恢复出来的队列**不是空的**：`~/.dsh/dsh-ticktick-pending.json` 匹配 `dsh-*.json`
  // 会被当插件配置一起备份/恢复，所以沙箱队列里带着**源机器当时的待同步任务**。
  // 因此断言必须是「stage 后比 stage 前多 1 条」，不能写死 `待同步任务 : 1`
  //（写死只在源机器队列恰好为空时通过——在别人电脑上会假失败）。
  const pendingCount = (out) => {
    const m = /待同步任务\s*:\s*(\d+)/.exec(out || '')
    return m ? Number(m[1]) : NaN
  }
  const before = await exec(process.execPath, [scriptDest, 'status'], { env })
  const beforeCount = pendingCount(before.stdout + before.stderr)
  if (!Number.isFinite(beforeCount)) fail(`stage 前无法解析待同步数：\n${before.stdout}${before.stderr}`)
  else ok(`恢复出的队列已带源机器的待同步任务：${beforeCount} 条（断言按增量比较）`)

  const staged = await exec(process.execPath, [
    scriptDest, 'stage', '--by', 'aux-migration-test',
    '--json', JSON.stringify([{ title: '换机验证任务', content: '来源：aux-migration 测试；背景：验证恢复后的延迟同步能 stage；完成标准：status 能看到它' }]),
  ], { env })
  const status = await exec(process.execPath, [scriptDest, 'status'], { env })
  const statusOut = status.stdout + status.stderr
  const afterCount = pendingCount(statusOut)
  if (afterCount !== beforeCount + 1) fail(`stage 后待同步数应为 ${beforeCount + 1}，实际 ${afterCount}：\n${statusOut}`)
  else ok(`恢复后的脚本 stage + status 通过（${beforeCount} → ${afterCount}，延迟同步「暂存」链路可用）`)

  // flush 在无凭据时安全跳过（证明定时器调用的命令能跑通、不会崩）
  const flush = await exec(process.execPath, [scriptDest, 'flush'], { env }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }))
  const flushOut = (flush.stdout || '') + (flush.stderr || '')
  if (!/队列|跳过同步|同步完成/.test(flushOut)) fail(`flush 输出异常：${flushOut}`)
  else ok('恢复后的脚本 flush 命令可运行（无凭据时安全跳过）')

  /* ---------------- 5. plist 语法 + launchctl 可加载（唯一 Label） ---------------- */
  const lint = await exec('/usr/bin/plutil', ['-lint', plistDest]).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }))
  if (!/OK/.test((lint.stdout || '') + (lint.stderr || ''))) fail(`plutil 校验失败：${lint.stdout}${lint.stderr}`)
  else ok('plist 语法校验通过（plutil -lint OK）')

  const testLabel = `com.dsh.ticktick-deferred-sync.aux-test-${process.pid}`
  const testPlist = path.join(root, `${testLabel}.plist`)
  await writeFile(testPlist, plistText.replace(
    '<string>com.dsh.ticktick-deferred-sync</string>',
    `<string>${testLabel}</string>`,
  ))
  try {
    await exec('/bin/launchctl', ['load', '-w', testPlist])
    const list = await exec('/bin/launchctl', ['list'])
    if (!list.stdout.includes(testLabel)) fail('launchctl 已 load 但 list 里没有该任务')
    else ok(`launchctl 成功加载恢复出的 plist（临时 Label ${testLabel}，RunAtLoad=false，不会真跑）`)
  } catch (e) {
    fail(`launchctl load 失败：${(e.stderr || e.message || '').trim()}`)
  } finally {
    await exec('/bin/launchctl', ['unload', testPlist]).catch(() => {})
  }

  // 真实定时器不受影响，仍在
  const realList = await exec('/bin/launchctl', ['list']).catch(() => ({ stdout: '' }))
  if (realList.stdout.includes('com.dsh.ticktick-deferred-sync')) ok('本机真实延迟同步定时器未受影响，仍在 launchctl 列表里')
  else log('（提示：本机真实 com.dsh.ticktick-deferred-sync 当前未加载）')

  /* ---------------- 6. 预检也识别 aux ---------------- */
  const vBackup = await verifyBackup({ backupDir }, { log })
  if (!vBackup.checks.some((c) => c.subject.startsWith('aux/'))) fail('备份侧预检没有 aux 检查项')
  else ok('预检（备份侧）包含 aux 检查')
  const vRestore = await verifyBackup({ backupDir: restoreDir }, { homeDir: sandboxHome, dshHome: sandboxDsh })
  const auxErrors = vRestore.checks.filter((c) => c.subject.startsWith('aux/') && c.level === 'error')
  if (auxErrors.length) fail(`恢复侧 aux 预检有错误：${JSON.stringify(auxErrors)}`)
  else ok('预检（恢复侧）aux 无错误')

  console.log('\n===== 结果 =====')
  console.log(`aux 项数：${auxCount}`)
  console.log(`源 home：${sourceHome} → 目标 home：${sandboxHome}`)
  if (process.exitCode) console.log('❌ 有用例失败')
  else console.log('✅ 全部通过：换机后「stage + 定时写入」链路完整恢复')
} catch (e) {
  fail(`异常：${e && e.stack || e}`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
  // collectAuxAssets 的导出只是给外部调试留的引用，避免 tree-shake 误报
  void collectAuxAssets
}
