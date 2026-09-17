/**
 * git 传输层健壮性测试（lib/git.js）。
 *
 * 背景（2026-09-17 实测）：某台机器的 `git push` 连续 5 次死在传输层
 * （`RPC failed; curl 55 / SSL_ERROR_SYSCALL / HTTP2 framing layer`），
 * 而同样的 push 加上 `-c http.version=HTTP/1.1` 一次就成功；更坑的是 git
 * 在这些失败上还会打印误导性的 "Everything up-to-date"。
 *
 * 本测试做两件事（全部离线，用本地 bare 仓库当 remote，不依赖 GitHub）：
 *   1. 断言重试阶梯确实带 HTTP/1.1 兜底
 *   2. 端到端跑通 commit → push → push（第二次）→ pull → clone
 *
 * 运行：node test/git-net.mjs
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCmd } from '../lib/git.js'
import { isGitRoot, gitInit, gitCommit, gitPush, gitPull, gitClone, GIT_NET_ATTEMPTS } from '../lib/git.js'

const fail = (m) => { console.error('❌', m); process.exitCode = 1 }
const ok = (m) => console.log('✅', m)

const root = await mkdtemp(path.join(tmpdir(), 'dsh-gitnet-'))
const bare = path.join(root, 'remote.git')
const work = path.join(root, 'work')
const clone = path.join(root, 'clone')

try {
  /* ---------------- 1. 重试阶梯 ---------------- */
  const labels = GIT_NET_ATTEMPTS.map((a) => a.label)
  const hasHttp11 = GIT_NET_ATTEMPTS.some((a) => a.args.join(' ').includes('http.version=HTTP/1.1'))
  if (!hasHttp11 || GIT_NET_ATTEMPTS.length < 2) fail(`重试阶梯缺少 HTTP/1.1 兜底：${JSON.stringify(labels)}`)
  else ok(`重试阶梯：${labels.join(' → ')}`)
  if (GIT_NET_ATTEMPTS[0].args.length !== 0) fail('第一条应当是「默认参数」原样尝试')
  else ok('首次尝试保持默认参数（不为所有用户强行改协议）')

  /* ---------------- 2. 环境 ---------------- */
  await mkdir(work, { recursive: true })
  const bareInit = await runCmd('git', ['init', '--bare', bare], { timeoutMs: 30_000 })
  if (bareInit.code !== 0) fail('创建 bare 远端失败：' + (bareInit.stderr || '').trim())
  else ok(`已创建本地 bare 远端（不经过网络）：${path.basename(bare)}`)

  if (!(await isGitRoot(work))) {
    const init = await gitInit(work)
    if (init.code !== 0) fail('git init 失败')
  }
  await writeFile(path.join(work, 'a.txt'), 'one\n')

  const c1 = await gitCommit(work, 'test: first', () => {})
  if (!c1.committed) fail(`首次提交失败：${JSON.stringify(c1)}`)
  else ok(`提交成功 ${c1.hash}`)

  /* ---------------- 3. push（首次会补 remote）---------------- */
  const p1 = await gitPush(work, bare, () => {})
  if (!p1.pushed) fail(`push 失败：${p1.error}`)
  else ok(`push 成功（${p1.branch} → ${path.basename(bare)}）`)

  /* ---------------- 4. 第二次 push（增量）---------------- */
  await writeFile(path.join(work, 'b.txt'), 'two\n')
  const c2 = await gitCommit(work, 'test: second', () => {})
  if (!c2.committed) fail('第二次提交失败')
  const p2 = await gitPush(work, bare, () => {})
  if (!p2.pushed) fail(`第二次 push 失败：${p2.error}`)
  else ok('第二次 push 成功（增量提交）')

  /* ---------------- 5. pull ---------------- */
  const pulled = await gitPull(work, () => {})
  if (pulled.error) fail(`pull 报错：${pulled.error}`)
  else ok('pull 正常（--ff-only）')

  /* ---------------- 6. clone（新机器首步）---------------- */
  const cl = await gitClone(bare, clone, () => {})
  if (!cl.cloned) fail(`clone 失败：${cl.error}`)
  else {
    const b = await readFile(path.join(clone, 'b.txt'), 'utf8').catch(() => null)
    if (b !== 'two\n') fail('clone 出来的仓库内容不对')
    else ok('clone 成功且内容完整（新机器第一步可用）')
  }

  /* ---------------- 7. 失败也要如实上报（不靠输出文字判定）---------------- */
  const bogus = path.join(root, 'does-not-exist.git')
  const bad = await gitPush(work, bogus, () => {})
  if (bad.pushed) fail('指向不存在的远端竟然报成功——绝不能只信输出文字')
  else ok('远端不可用时不误报成功（信退出码，不信 "Everything up-to-date" 这类文字）')
} finally {
  await rm(root, { recursive: true, force: true })
}

if (process.exitCode) console.log('\n❌ 有用例失败')
else console.log('\n✅ 全部通过：git 传输层重试与基本链路正常')
