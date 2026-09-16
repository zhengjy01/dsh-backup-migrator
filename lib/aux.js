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
 * @module dsh-backup-migrator/aux
 */

import { readFile, writeFile, mkdir, chmod, copyFile, stat } from 'node:fs/promises'
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

/** Path of one asset inside the backup repository. */
export function auxBackupRel(item) {
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

/**
 * Copy the registered assets into `<backupDir>/aux/...`.
 * Missing assets only warn — a machine that never installed the timer is still
 * a perfectly valid backup source.
 */
export async function collectAuxAssets(backupDir, { assets = DEFAULT_AUX_ASSETS, homeDir, dshHome, log = () => {} } = {}) {
  const { home, dsh } = anchors({ homeDir, dshHome })
  const items = []
  const warnings = []
  for (const item of assets) {
    const src = auxSourcePath(item, { homeDir: home, dshHome: dsh })
    try {
      const st = await stat(src)
      if (!st.isFile()) {
        warnings.push(`aux ${item.id}：${src} 不是普通文件，已跳过`)
        continue
      }
    } catch {
      warnings.push(`aux ${item.id}：本机不存在 ${src}（该能力不会被备份）`)
      continue
    }
    const file = auxBackupRel(item)
    const dest = path.join(backupDir, file)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(src, dest)
    await chmod(dest, item.mode || 0o644).catch(() => {})
    items.push({
      id: item.id,
      kind: item.kind,
      label: item.label || null,
      root: item.root,
      rel: item.rel,
      file,
      original: src,
      mode: item.mode || 0o644,
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
  for (const item of aux.items) {
    const src = path.join(backupDir, item.file)
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
