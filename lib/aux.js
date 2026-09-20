/**
 * dsh-backup-migrator — machine-level "aux" assets.
 *
 * Some DSH side-services deliberately live OUTSIDE the plugin system: a launchd
 * timer keeps running while the DSH GUI is closed, so it cannot be a plugin
 * bundle. dsh-backup-migrator historically captured only the plugin manifest,
 * plugin configs and locally-sourced plugin tarballs — a machine migration
 * therefore silently dropped helper scripts (under the DSH home `scripts`
 * directory) and their launchd jobs (under `Library/LaunchAgents`).
 *
 * This module adds a small, explicit registry of those files:
 *   - collectAuxAssets(): copy them into `<backupDir>/aux/...` and describe them
 *   - restoreAuxAssets(): write them back, rewriting source-machine absolute
 *     paths (home dir, node interpreter) and (re)loading launchd jobs.
 *
 * Adding a new asset is one entry in DEFAULT_AUX_ASSETS.
 *
 * Since 0.4.0 the same registry also carries the USER CONTENT layer
 * (`group: 'user'`): skills, agent presets, adapters, the global AGENTS.md,
 * DSH settings, and the Mnemon runtime memory + distilled documents. Rationale:
 * restoring the plugin environment but not "you" is not a real migration — and
 * the previous bolt-on script (`user-sync.sh`, deliberately outside the plugin
 * system) proved the point by going stale for 19 days.
 *
 * Asset kinds:
 *   'script'       single executable file        -> aux/scripts/<basename>
 *   'launchAgent'  launchd plist (macOS only)    -> aux/launchagents/<basename>
 *   'file'         single text/data file         -> aux/files/<basename>
 *   'dir'          directory tree (mirrored)     -> aux/dirs/<id>/
 * Every entry is optional: a machine that lacks it only produces a warning.
 *
 * @module dsh-backup-migrator/aux
 */

import { readFile, writeFile, mkdir, chmod, copyFile, stat, readdir, rename } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { runCmd } from './git.js'

/** Format version of the `aux` section inside manifest.json. */
export const AUX_FORMAT_VERSION = 1

/**
 * Files that live outside the plugin system but are required for DSH
 * side-services. `root` picks the anchor:
 *   - 'dsh'  -> `<DSH_HOME>/<rel>`   (e.g. the DSH home `scripts` dir)
 *   - 'home' -> `<HOME>/<rel>`       (e.g. `Library/LaunchAgents/...`)
 *
 * The ticktick deferred-sync pair is the canonical example: the queue/config
 * file (`~/.dsh/dsh-ticktick-pending.json`) is already collected as a plugin
 * config, but the script and the launchd timer were not.
 *
 * The nightly daily-report pair is the same shape: `flomo-daily-report.mjs`
 * (+ its 22:20 timer) and `wechat-daily-report.mjs` (+ its 22:25 timer) run
 * while the GUI may be closed, so they are scripts + launchd jobs too.
 */
export const DEFAULT_AUX_ASSETS = [
  {
    id: 'ticktick-pending-script',
    kind: 'script',
    root: 'dsh',
    rel: 'scripts/ticktick-pending.mjs',
    mode: 0o755,
    description: '滴答清单延迟同步队列脚本（stage / flush / status / config）',
  },
  {
    id: 'ticktick-deferred-sync-agent',
    kind: 'launchAgent',
    root: 'home',
    rel: 'Library/LaunchAgents/com.dsh.ticktick-deferred-sync.plist',
    label: 'com.dsh.ticktick-deferred-sync',
    mode: 0o644,
    description: '每 2 分钟触发延迟同步 flush 的 launchd 定时器',
  },
  {
    id: 'flomo-daily-report-script',
    kind: 'script',
    root: 'dsh',
    rel: 'scripts/flomo-daily-report.mjs',
    mode: 0o755,
    description: 'flomo 日报唯一出口脚本（22:00 时间闸门 + 每日去重）',
  },
  {
    id: 'flomo-daily-report-agent',
    kind: 'launchAgent',
    root: 'home',
    rel: 'Library/LaunchAgents/com.dsh.flomo-daily-report.plist',
    label: 'com.dsh.flomo-daily-report',
    mode: 0o644,
    description: '每晚 22:20 兜底推 flomo 日报的 launchd 定时器',
  },
  {
    id: 'wechat-daily-report-script',
    kind: 'script',
    root: 'dsh',
    rel: 'scripts/wechat-daily-report.mjs',
    mode: 0o755,
    description: '微信日报同步脚本（经 ClawBot 网关，22:00 时间闸门 + 每日去重）',
  },
  {
    id: 'wechat-daily-report-agent',
    kind: 'launchAgent',
    root: 'home',
    rel: 'Library/LaunchAgents/com.dsh.wechat-daily-report.plist',
    label: 'com.dsh.wechat-daily-report',
    mode: 0o644,
    description: '每晚 22:25 兜底把日报推到微信（ClawBot 网关）的 launchd 定时器',
  },
  {
    id: 'wechat-notify-script',
    kind: 'script',
    root: 'dsh',
    rel: 'scripts/wechat-notify.mjs',
    mode: 0o755,
    description: '通用微信通知出口（任务完成 / 有产出 / 执行异常 → 经 ClawBot 网关推微信）',
  },

  /* ---- 博客同步（`com.dsh.blog-sync`）：机器级定时器 + 它的工具链 --------
   * 2026-09-19 会话「博客同步静默失效排查」把看板 cron 换成 launchd 后新建。
   * 之所以整条链都要登记：plist 只负责唤起 `after-blog-sync.sh`，真正的同步
   * /卡片刷新逻辑都在 `~/dsh-blog-sync/` 的脚本里——只带 plist 不带脚本，
   * 换机后定时器会照点开火但每次都报找不到文件（静默失效的另一种形态）。
   * 这一目录在 home 下、不在 `~/.dsh/scripts`，所以既不是插件也不是配置。 */
  {
    id: 'blog-sync-runner-script',
    kind: 'script',
    root: 'home',
    rel: 'dsh-blog-sync/after-blog-sync.sh',
    mode: 0o755,
    description: 'com.dsh.blog-sync 的入口脚本：文章同步（带重试）→ 刷新「最近在做什么」卡片',
  },
  {
    id: 'blog-sync-article-script',
    kind: 'script',
    root: 'home',
    rel: 'dsh-blog-sync/sync_blog_notion.mjs',
    mode: 0o755,
    description: '博客长文 → Notion 增量同步（现行 Node fetch 版，幂等键 date+title）',
  },
  {
    id: 'blog-sync-article-legacy-script',
    kind: 'script',
    root: 'home',
    rel: 'dsh-blog-sync/sync_blog_notion.py',
    mode: 0o755,
    description: '博客同步 Python urllib 旧版（保留作回滚参照；2026-09-19 起由 .mjs 取代）',
  },
  {
    id: 'blog-sync-now-script',
    kind: 'script',
    root: 'home',
    rel: 'dsh-blog-sync/sync_now.mjs',
    mode: 0o755,
    description: '刷新博客「最近在做什么」卡片数据（不碰 git，站点 ISR 自动重取）',
  },
  {
    id: 'blog-sync-now-config',
    kind: 'file',
    root: 'home',
    rel: 'dsh-blog-sync/now.config.json',
    mode: 0o600,
    description: '「最近在做什么」卡片配置（Notion 库 / 滴答清单 id 等）',
  },
  {
    id: 'blog-sync-agent',
    kind: 'launchAgent',
    root: 'home',
    rel: 'Library/LaunchAgents/com.dsh.blog-sync.plist',
    label: 'com.dsh.blog-sync',
    mode: 0o644,
    description: '博客同步机器级定时器（21:00 主 + 09:00 兜底 + RunAtLoad；睡眠唤醒后补跑）',
  },

  /* ---- 用户内容层（group: 'user'）---------------------------------------
   * 这一层的意义：换机后「插件环境」回来了但「你」没回来，等于白搬。
   * 全部按存在与否自动跳过——没装 mnemon、没有预设的机器只是少一项，不算失败。
   * 目录资产是「镜像」语义（恢复时先把你本机现有内容挪到 <dest>.bak-<时间戳>）。 */
  {
    id: 'user-skills',
    kind: 'dir',
    root: 'home',
    rel: '.agents/skills',
    group: 'user',
    description: '本机 skill 库（换机后 DSH 仍能直接发现）',
  },
  {
    id: 'user-agent-presets',
    kind: 'dir',
    root: 'dsh',
    rel: '.agent-presets',
    group: 'user',
    description: 'Agent 预设（新会话可选的预设）',
  },
  {
    id: 'user-adapters',
    kind: 'dir',
    root: 'dsh',
    rel: 'adapters',
    group: 'user',
    description: '自定义适配器（~/.dsh/adapters 下的 .mjs）',
  },
  {
    id: 'user-agents-md',
    kind: 'file',
    root: 'dsh',
    rel: 'AGENTS.md',
    group: 'user',
    mode: 0o600,
    description: '全局工作规则（AGENTS.md）——DSH 每轮都读它',
  },
  {
    id: 'user-settings',
    kind: 'file',
    root: 'dsh',
    rel: 'settings.yaml',
    group: 'user',
    mode: 0o600,
    description: 'DSH 设置（权限默认值 / 默认模型 / UI 开关）',
  },
  {
    id: 'mnemon-runtime',
    kind: 'dir',
    root: 'home',
    rel: '.mnemon/runtime',
    group: 'user',
    description: 'Mnemon 运行时记忆（USER.md / MEMORY.md / memories.json）；未装则自动跳过',
  },
  {
    id: 'mnemon-documents',
    kind: 'dir',
    root: 'home',
    rel: '.mnemon/documents',
    group: 'user',
    description: 'Mnemon 沉淀文档（对话里提炼出的项目/概念知识）；未装则自动跳过',
  },
]

/** Resolve the two anchors, allowing tests to point them at a sandbox. */
function anchors(env = {}) {
  const home = env.homeDir || homedir()
  // `launchd` jobs always live under the real user home; the DSH home honors
  // `DSH_HOME` (launchers / rescue capsules move it).
  const dsh = env.dshHome || (process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(home, '.dsh'))
  return { home, dsh }
}

/** Absolute path of one asset on the live machine. */
export function auxSourcePath(item, env) {
  const { home, dsh } = anchors(env)
  return path.join(item.root === 'dsh' ? dsh : home, item.rel)
}

/**
 * Path of one asset inside the backup repository.
 *   script -> aux/scripts/<basename> · launchAgent -> aux/launchagents/<basename>
 *   file   -> aux/files/<basename>   · dir         -> aux/dirs/<id>/
 * (directories use the asset `id`, not the basename: the name carries the meaning)
 */
export function auxBackupRel(item) {
  if (item.kind === 'dir') return path.posix.join('aux', 'dirs', item.id)
  const sub = item.kind === 'launchAgent' ? 'launchagents' : `${item.kind}s`
  return path.posix.join('aux', sub, path.basename(item.rel))
}

/**
 * Rewrite machine-specific absolute paths in a text asset so it survives a
 * migration: the source home directory becomes the target home directory, and
 * an absolute `node` binary that does not exist here becomes this process's
 * node. Non-plist text is handled the same way (harmless when nothing matches).
 */
export function rewriteAuxText(text, { sourceHome, targetHome, nodePath } = {}) {
  let out = String(text == null ? '' : text)
  if (sourceHome && targetHome && sourceHome !== targetHome) {
    out = out.split(sourceHome).join(targetHome)
  }
  if (nodePath) {
    // Only `<string>…/node</string>` (no whitespace/colon -> skips PATH values).
    out = out.replace(/(<string>)([^<>\s]*\/node)(<\/string>)/g, (whole, open, candidate, close) => {
      try {
        if (statSync(candidate).isFile()) return whole
      } catch {
        /* interpreter not present on this machine */
      }
      return `${open}${nodePath}${close}`
    })
  }
  return out
}

/** Names never worth carrying into a backup (noise / huge / VCS metadata). */
const SKIP_NAMES = new Set(['.DS_Store', 'node_modules', '.git'])

/** A directory asset above this only warns — never blocks a backup. */
export const DIR_ASSET_WARN_MB = 50

/** Recursively copy a directory tree, preserving modes; follows symlinks. */
async function copyTree(src, dest, log = () => {}) {
  let files = 0
  let bytes = 0
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    const st = await stat(s).catch(() => null) // stat (not lstat) follows symlinks
    if (!st) continue
    if (st.isDirectory()) {
      const sub = await copyTree(s, d, log)
      files += sub.files
      bytes += sub.bytes
    } else if (st.isFile()) {
      await copyFile(s, d)
      await chmod(d, st.mode & 0o777).catch(() => {})
      files += 1
      bytes += st.size
    }
  }
  return { files, bytes }
}

/** Plausible UTF-8 text? (binary assets must never be run through the rewriter) */
function looksText(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

/** Restore a directory tree, rewriting text files (home dir / node interpreter). */
async function restoreTree(src, dest, { sourceHome, targetHome, nodePath }) {
  let files = 0
  let bytes = 0
  let rewrittenCount = 0
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    const st = await stat(s).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) {
      const sub = await restoreTree(s, d, { sourceHome, targetHome, nodePath })
      files += sub.files
      bytes += sub.bytes
      rewrittenCount += sub.rewrittenCount
      continue
    }
    if (!st.isFile()) continue
    const buf = await readFile(s)
    let out = buf
    if (looksText(buf)) {
      const text = buf.toString('utf8')
      const next = rewriteAuxText(text, { sourceHome, targetHome, nodePath })
      if (next !== text) rewrittenCount += 1
      out = Buffer.from(next, 'utf8')
    }
    const mode = st.mode & 0o777
    await writeFile(d, out, { mode })
    await chmod(d, mode).catch(() => {})
    files += 1
    bytes += out.length
  }
  return { files, bytes, rewrittenCount }
}

/**
 * Copy the registered assets into `<backupDir>/aux/...`.
 * Missing assets only warn — a machine that never installed the timer is still
 * a perfectly valid backup source.
 */
export async function collectAuxAssets(backupDir, { assets = DEFAULT_AUX_ASSETS, homeDir, dshHome, includeUserContent = true, log = () => {} } = {}) {
  const { home, dsh } = anchors({ homeDir, dshHome })
  const items = []
  const warnings = []
  for (const item of assets) {
    if (item.group === 'user' && includeUserContent === false) continue
    const src = auxSourcePath(item, { homeDir: home, dshHome: dsh })
    const file = auxBackupRel(item)
    const dest = path.join(backupDir, file)
    const group = item.group || 'aux'

    // --- directory assets: mirror the tree ---
    if (item.kind === 'dir') {
      const st = await stat(src).catch(() => null)
      if (!st || !st.isDirectory()) {
        warnings.push(`aux ${item.id}：本机不存在目录 ${src}（该内容不会被备份）`)
        continue
      }
      const tree = await copyTree(src, dest, log)
      if (tree.bytes > DIR_ASSET_WARN_MB * 1024 * 1024) {
        warnings.push(`aux ${item.id}：目录 ${(tree.bytes / 1048576).toFixed(1)} MB 超过 ${DIR_ASSET_WARN_MB} MB 软上限，请确认是否真该纳入备份`)
      }
      items.push({
        id: item.id,
        kind: item.kind,
        group,
        root: item.root,
        rel: item.rel,
        file,
        original: src,
        files: tree.files,
        bytes: tree.bytes,
        description: item.description || '',
      })
      if (log) log(`aux: backed up dir ${item.id} (${tree.files} files, ${src})`)
      continue
    }

    // --- single-file assets: script / launchAgent / file ---
    const st = await stat(src).catch(() => null)
    if (!st || !st.isFile()) {
      warnings.push(`aux ${item.id}：本机不存在 ${src}（该内容不会被备份）`)
      continue
    }
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
    await chmod(dest, item.mode || 0o644).catch(() => {})
    items.push({
      id: item.id,
      kind: item.kind,
      group,
      label: item.label || null,
      root: item.root,
      rel: item.rel,
      file,
      original: src,
      mode: item.mode || 0o644,
      bytes: st.size,
      description: item.description || '',
    })
    if (log) log(`aux: backed up ${item.id} (${src})`)
  }
  return { items, warnings, sourceHome: home, sourceDshHome: dsh }
}

/** Describe where each manifest asset would land on this machine (dry run). */
export function previewAuxRestore(manifest, env = {}) {
  const { home, dsh } = anchors(env)
  const aux = manifest && manifest.aux
  if (!aux || !Array.isArray(aux.items)) return { entries: [], warnings: ['备份里没有 aux 区段（旧版备份）'] }
  const warnings = []
  const entries = aux.items.map((item) => {
    const dest = auxSourcePath(item, { homeDir: home, dshHome: dsh })
    const platformOk = item.kind !== 'launchAgent' || process.platform === 'darwin'
    if (!platformOk) warnings.push(`aux ${item.id}：当前平台不是 macOS，launchd 定时器将被跳过`)
    return {
      id: item.id,
      kind: item.kind,
      label: item.label || null,
      file: item.file,
      dest,
      from: item.original || null,
      files: item.files || null,
      willRestore: platformOk,
    }
  })
  return { entries, warnings, sourceHome: aux.sourceHome || null, targetHome: home }
}

/** Unload then load a launchd job so the timer actually starts on this machine. */
async function loadLaunchAgent(plistPath, log) {
  await runCmd('launchctl', ['unload', plistPath], { timeoutMs: 20_000 })
  const r = await runCmd('launchctl', ['load', '-w', plistPath], { timeoutMs: 20_000 })
  if (r.code === 0) return { ok: true, via: 'load -w' }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const b = await runCmd('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { timeoutMs: 20_000 })
  if (b.code === 0) return { ok: true, via: 'bootstrap' }
  const detail = (r.stderr || r.stdout || b.stderr || b.stdout || '').trim()
  if (log) log(`aux: launchctl load failed for ${plistPath}: ${detail}`)
  return { ok: false, error: detail || 'launchctl 返回非零' }
}

/**
 * Write the manifest's aux assets back to this machine.
 *  - text files are rewritten (source home -> target home, node interpreter)
 *  - scripts get mode 0755, plists 0644
 *  - launchd jobs are (re)loaded unless `loadAgents === false`
 * Returns { restored, skipped, warnings, sourceHome, targetHome }.
 */
export async function restoreAuxAssets(backupDir, manifest, { homeDir, dshHome, loadAgents = true, log = () => {} } = {}) {
  const { home, dsh } = anchors({ homeDir, dshHome })
  const aux = manifest && manifest.aux
  const result = {
    restored: [],
    skipped: [],
    warnings: [],
    sourceHome: (aux && aux.sourceHome) || null,
    targetHome: home,
  }
  if (!aux || !Array.isArray(aux.items)) {
    result.warnings.push('备份里没有 aux 区段（旧版备份），已跳过脚本 / launchd 恢复')
    return result
  }
  const sourceHome = aux.sourceHome || null
  const nodePath = process.execPath
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  for (const item of aux.items) {
    const src = path.join(backupDir, item.file)

    // --- directory assets（skill / 预设 / adapters / 记忆 / 沉淀文档）---
    if (item.kind === 'dir') {
      const dst = await stat(src).catch(() => null)
      if (!dst || !dst.isDirectory()) {
        result.warnings.push(`aux ${item.id}：备份里缺少目录 ${item.file}`)
        result.skipped.push({ id: item.id, reason: 'missing-in-backup' })
        continue
      }
      const dirDest = auxSourcePath(item, { homeDir: home, dshHome: dsh })
      await mkdir(path.dirname(dirDest), { recursive: true })
      // 覆盖前先把本机现有内容挪到一边：镜像是「替换」而不是「合并」，
      // 不能让它悄悄吃掉用户当前的内容。
      let movedAside = null
      if (await stat(dirDest).catch(() => null)) {
        movedAside = `${dirDest}.bak-${stamp}`
        await rename(dirDest, movedAside)
      }
      const tree = await restoreTree(src, dirDest, { sourceHome, targetHome: home, nodePath })
      result.restored.push({
        id: item.id,
        kind: item.kind,
        group: item.group || 'aux',
        dest: dirDest,
        files: tree.files,
        bytes: tree.bytes,
        pathRewritten: tree.rewrittenCount > 0,
        movedAside,
      })
      if (log) log(`aux: restored dir ${item.id} (${tree.files} files${movedAside ? `, 原内容已挪到 ${movedAside}` : ''})`)
      continue
    }

    // --- single-file assets（script / launchAgent / file）---
    const srcOk = await stat(src).then((s) => s.isFile()).catch(() => false)
    if (!srcOk) {
      result.warnings.push(`aux ${item.id}：备份里缺少 ${item.file}`)
      result.skipped.push({ id: item.id, reason: 'missing-in-backup' })
      continue
    }
    if (item.kind === 'launchAgent' && process.platform !== 'darwin') {
      result.skipped.push({ id: item.id, reason: 'platform-not-darwin' })
      result.warnings.push(`aux ${item.id}：当前平台不是 macOS，launchd 定时器未恢复（脚本已就位）`)
      continue
    }
    const dest = auxSourcePath(item, { homeDir: home, dshHome: dsh })
    await mkdir(path.dirname(dest), { recursive: true })
    const raw = await readFile(src, 'utf8')
    const rewritten = rewriteAuxText(raw, { sourceHome, targetHome: home, nodePath })
    const mode = item.mode || (item.kind === 'script' ? 0o755 : 0o644)
    await writeFile(dest, rewritten, { mode })
    await chmod(dest, mode).catch(() => {})
    const entry = {
      id: item.id,
      kind: item.kind,
      label: item.label || null,
      dest,
      mode,
      pathRewritten: !!(sourceHome && sourceHome !== home),
      loaded: null,
    }
    if (item.kind === 'launchAgent' && loadAgents) {
      const load = await loadLaunchAgent(dest, log)
      entry.loaded = load.ok
      entry.loadVia = load.via || null
      if (load.ok) {
        if (log) log(`aux: loaded launchd job ${item.label || item.id} (${load.via})`)
      } else {
        result.warnings.push(`aux ${item.id}：plist 已就位但 launchctl 加载失败（${load.error}）。可手动执行：launchctl load -w "${dest}"`)
      }
    }
    result.restored.push(entry)
  }
  return result
}

/* --- smoke-test exports (not part of the public plugin surface) --- */
export const __test = { anchors, loadLaunchAgent }
