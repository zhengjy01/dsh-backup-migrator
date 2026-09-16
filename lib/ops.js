/**
 * dsh-backup-migrator — core operations: scan, backup, verify, restore, list.
 *
 * Model: a DSH profile is a pnpm workspace at `~/.dsh/profiles/<name>/` whose
 * `package.json` lists plugin dependencies (`dependencies`) and the load
 * order (`dsh.profile.bundles`); its `cordis.patch.yml` is the user patch
 * layer. Plugin configs / credentials live at `~/.dsh/dsh-*.json` and
 * `~/.dsh/dsh-*` dirs (mode 0600).
 *
 * The backup repo (a normal git repo the user syncs to GitHub) looks like:
 *
 *   <backupDir>/
 *   ├── manifest.json              # machine + profile + plugin + config + aux index
 *   ├── README.md                  # human-readable summary of the latest backup
 *   ├── profiles/<name>/cordis.patch.yml   # user patch layer (if any)
 *   ├── profiles/<name>/packages/*.tgz     # locally-sourced plugins packed
 *   ├── configs/...                # dsh-*.json + dsh-* dirs (0600 preserved)
 *   └── aux/...                    # scripts + launchd plists outside the plugin system
 *
 * The `aux/` layer carries machine-level side-services that cannot be plugins
 * (a launchd timer must run while the GUI is closed). See `aux.js`.
 *
 * Plugin sources are classified from the dependency spec:
 *   npm:     "name" / "name@version"        -> reinstall from registry
 *   github:  "github:user/repo[#commit]"    -> reinstall as-is (pinned)
 *   link:    "link:/abs" | "link:./rel"     -> MUST be packed (npm pack)
 *   file:    "file:/abs/pkg.tgz"            -> copy the tarball
 *
 * @module dsh-backup-migrator/ops
 */

import { readFile, writeFile, copyFile, mkdir, readdir, stat, rm, chmod } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pnpmAdd, npmPack, isGitRoot, gitInit, gitCommit, gitPush, gitPull, gitClone, gitRemote, gitHead, gitLog } from './git.js'
import { AUX_FORMAT_VERSION, DEFAULT_AUX_ASSETS, collectAuxAssets, previewAuxRestore, restoreAuxAssets, auxSourcePath } from './aux.js'

/** Format version of manifest.json — bump when the layout changes. */
export const FORMAT_VERSION = 1

/** DSH home — honor `DSH_HOME` (launchers / rescue capsules move the home). */
export const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), '.dsh')
export const PROFILES_DIR = path.join(DSH_HOME, 'profiles')

/** Config files/dirs under ~/.dsh that are never part of a backup. */
const CONFIG_EXCLUDE = new Set([
  'dsh-browser',              // browser profile data, machine-specific, heavy
  'dsh-backup-migrator',      // our own config dir (circular otherwise)
  'dsh-backup-migrator.json', // our own config file
  'dsh-backup-migrator-state.json', // 定时备份的机器本地运行时状态（换机还原无意义，见 schedule.js）
])

/** Secret-looking file names (used to flag credentials). */
const SECRET_NAME_RE = /(secret|token|credential|auth|password|api[_-]?key)/i

/** Secret-looking key=value inside the file head. */
const SECRET_CONTENT_RE = /("(?:api[_-]?key|token|secret|password|client[_-]?secret)"\s*[:=]|^(?:api[_-]?key|token|secret|password)\s*[:=])/im

/** Strip a trailing slash so path joins are predictable. */
const dropSlash = (p) => String(p).replace(/[\\/]+$/, '')

/* ------------------------------------------------------------------ */
/* Source classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Classify one dependency spec. `profileDir` resolves relative `link:`/`file:`
 * paths. Returns { source, resolvedPath? } with source in
 * npm | github | link | file | workspace | other.
 */
export function classifySpec(name, spec, profileDir) {
  const s = String(spec || '').trim()
  if (s.startsWith('link:')) {
    let p = s.slice(5).trim()
    if (!path.isAbsolute(p)) p = path.resolve(profileDir || process.cwd(), p)
    return { source: 'link', resolvedPath: p, spec: s }
  }
  if (s.startsWith('file:')) {
    let p = s.slice(5).trim()
    if (!path.isAbsolute(p)) p = path.resolve(profileDir || process.cwd(), p)
    return { source: 'file', resolvedPath: p, spec: s }
  }
  if (s.startsWith('github:')) return { source: 'github', spec: s }
  if (s.startsWith('workspace:')) return { source: 'workspace', spec: s }
  if (s.includes(':')) return { source: 'other', spec: s }
  return { source: 'npm', spec: s }
}

/**
 * pnpm-add-able spec for restore:
 *   npm     -> name@version (registry lookup by name)
 *   github  -> the github: spec verbatim (commit pin preserved)
 *   link/file -> file:<abs tgz path> (from the backup tarball)
 */
export function addSpecFor(plugin, tgzPath) {
  if (plugin.source === 'npm') {
    const v = plugin.spec
    if (!v || v === '*' || v === 'latest') return plugin.name
    return `${plugin.name}@${v}`
  }
  if (plugin.source === 'link' || plugin.source === 'file') {
    return `file:${tgzPath}`
  }
  return plugin.spec // github / workspace / other -> verbatim
}

/* ------------------------------------------------------------------ */
/* Profile scanning                                                    */
/* ------------------------------------------------------------------ */

/** List profile names (dirs under a profiles dir that have a package.json). */
export async function listProfiles(profilesDir = PROFILES_DIR) {
  let entries = []
  try { entries = await readdir(profilesDir, { withFileTypes: true }) } catch (err) { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      await stat(path.join(profilesDir, e.name, 'package.json'))
      out.push(e.name)
    } catch (err) { /* not a profile */ }
  }
  return out.sort()
}

/**
 * Scan one profile: bundles (load order), plugin list derived from
 * `dependencies`, and whether a user patch layer exists.
 */
export async function scanProfile(name, log) {
  const dir = path.join(PROFILES_DIR, name)
  let pkg
  try {
    pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  } catch (err) {
    return { ok: false, name, error: `无法读取 ${dir}/package.json：${err && err.message || err}` }
  }
  const deps = pkg.dependencies || {}
  const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const plugins = Object.entries(deps).map(([depName, spec]) => {
    const cls = classifySpec(depName, spec, dir)
    return {
      name: depName,
      spec: cls.spec,
      source: cls.source,
      resolvedPath: cls.resolvedPath || null,
      inBundles: bundles.includes(depName),
    }
  })
  const userPatchFile = path.join(dir, 'cordis.patch.yml')
  let hasUserPatch = false
  try { hasUserPatch = (await stat(userPatchFile)).isFile() } catch (err) { hasUserPatch = false }
  if (log) log(`scanned profile ${name}: ${plugins.length} plugins, ${bundles.length} bundles${hasUserPatch ? ', user patch' : ''}`)
  return { ok: true, name, dir, pkg, bundles, plugins, hasUserPatch, userPatchFile }
}

/* ------------------------------------------------------------------ */
/* Config discovery                                                    */
/* ------------------------------------------------------------------ */

/** Is this config file likely to contain credentials? */
export async function looksSecret(absPath) {
  if (SECRET_NAME_RE.test(path.basename(absPath))) return true
  try {
    const fh = await import('node:fs/promises')
    const buf = Buffer.alloc(16 * 1024)
    const fd = await fh.open(absPath, 'r')
    try {
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      return SECRET_CONTENT_RE.test(buf.toString('utf8', 0, bytesRead))
    } finally {
      await fd.close()
    }
  } catch (err) {
    return false
  }
}

/**
 * Discover plugin config entries under ~/.dsh: `dsh-*.json` files plus
 * `dsh-*` directories. Each entry: { rel, abs, isDir, secret }.
 */
export async function findConfigEntries() {
  const out = []
  let entries = []
  try { entries = await readdir(DSH_HOME, { withFileTypes: true }) } catch (err) { return out }
  for (const e of entries) {
    if (CONFIG_EXCLUDE.has(e.name)) continue
    const abs = path.join(DSH_HOME, e.name)
    if (e.isDirectory() && e.name.startsWith('dsh-')) {
      out.push({ rel: e.name, abs, isDir: true, secret: false })
    } else if (e.isFile() && /^dsh-.*\.json$/.test(e.name)) {
      out.push({ rel: e.name, abs, isDir: false, secret: await looksSecret(abs) })
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

/** Remove previously generated artifacts so the repo stays clean. */
async function clearArtifacts(backupDir, log) {
  for (const name of ['manifest.json', 'README.md', 'profiles', 'configs', 'aux']) {
    try { await rm(path.join(backupDir, name), { recursive: true, force: true }) } catch (err) { /* ignore */ }
  }
  if (log) log(`cleared previous artifacts in ${backupDir}`)
}

/** Recursively copy a directory (config dirs like dsh-zhipin). */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true })
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else if (e.isFile()) await copyFile(s, d)
  }
}

/**
 * Build the backup tree inside `backupDir`. Returns a summary object with
 * per-profile plugin/package info, config stats and warnings. Does NOT touch
 * git — the caller (tool) commits and pushes.
 */
export async function buildBackup(cfg, { profiles, includeSecrets, includeAux, homeDir, dshHome, log = () => {} } = {}) {
  const backupDir = dropSlash((cfg && cfg.backupDir) || '')
  if (!backupDir) throw new Error('未配置 backupDir（备份仓库目录），请先运行 dshbackup_config 设置')
  const wanted = Array.isArray(profiles) && profiles.length ? profiles : null
  const all = await listProfiles()
  const names = wanted ? wanted.filter((n) => all.includes(n)) : all
  const missing = wanted ? wanted.filter((n) => !all.includes(n)) : []
  if (!names.length) throw new Error(`没有可备份的 profile（本机 profiles: ${all.join(', ') || '无'}）`)

  await mkdir(backupDir, { recursive: true })
  await clearArtifacts(backupDir, log)

  const profilesOut = {}
  const packages = []
  const warnings = []
  const createdAt = new Date().toISOString()

  for (const name of names) {
    const scan = await scanProfile(name, log)
    if (!scan.ok) { warnings.push(`profile ${name}: ${scan.error}`); continue }
    const profileBackupDir = path.join(backupDir, 'profiles', name)
    const packagesDir = path.join(profileBackupDir, 'packages')
    await mkdir(packagesDir, { recursive: true })

    const pluginEntries = []
    for (const p of scan.plugins) {
      const entry = {
        name: p.name,
        spec: p.spec,
        source: p.source,
        inBundles: p.inBundles,
        packageFile: null,
        originalPath: p.resolvedPath || null,
      }
      if (p.source === 'link' || p.source === 'file') {
        try {
          const st = await stat(p.resolvedPath)
          if (p.source === 'link') {
            if (st.isDirectory()) {
              const packed = await npmPack(p.resolvedPath, packagesDir, log)
              if (packed.ok) {
                entry.packageFile = path.posix.join('profiles', name, 'packages', packed.file)
                packages.push({ profile: name, plugin: p.name, file: entry.packageFile, size: 0, original: p.resolvedPath })
              } else {
                warnings.push(`profile ${name} · ${p.name}: ${packed.error}（跳过打包，恢复时该插件无法重装）`)
              }
            } else {
              warnings.push(`profile ${name} · ${p.name}: link 指向的不是目录（${p.resolvedPath}）`)
            }
          } else {
            // file: -> copy the tarball as-is
            const dest = path.join(packagesDir, path.basename(p.resolvedPath))
            await copyFile(p.resolvedPath, dest)
            entry.packageFile = path.posix.join('profiles', name, 'packages', path.basename(p.resolvedPath))
            packages.push({ profile: name, plugin: p.name, file: entry.packageFile, size: st.size, original: p.resolvedPath })
          }
        } catch (err) {
          warnings.push(`profile ${name} · ${p.name}: 本地源不存在（${p.resolvedPath}）`)
        }
      } else if (p.source === 'github' && !/#[0-9a-f]{7,}/i.test(p.spec)) {
        warnings.push(`profile ${name} · ${p.name}: github 源未钉 commit（${p.spec}），恢复时可能漂移`)
      } else if (p.source === 'other' || p.source === 'workspace') {
        warnings.push(`profile ${name} · ${p.name}: 来源 ${p.source}（${p.spec}）无法自动恢复`)
      }
      pluginEntries.push(entry)
    }

    if (scan.hasUserPatch) {
      await copyFile(scan.userPatchFile, path.join(profileBackupDir, 'cordis.patch.yml'))
    }
    profilesOut[name] = {
      bundles: scan.bundles,
      plugins: pluginEntries,
      hasUserPatch: scan.hasUserPatch,
    }
  }

  // configs
  const entries = await findConfigEntries()
  const include = includeSecrets !== false
  const configs = []
  const excludedSecrets = []
  for (const e of entries) {
    if (e.secret && !include) { excludedSecrets.push({ rel: e.rel, secret: true }); continue }
    const dest = path.join(backupDir, 'configs', e.rel)
    if (e.isDir) await copyDir(e.abs, dest)
    else {
      // clearArtifacts() removes configs/ before the rebuild, and the first config
      // entry can be a file (e.g. dsh-canva-mcp.json) — copyFile does not create
      // the parent dir, so it failed with ENOENT. mkdir the parent first.
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(e.abs, dest)
    }
    configs.push({ rel: e.rel, secret: e.secret, isDir: e.isDir })
  }
  if (configs.some((c) => c.secret)) {
    warnings.push(`configs 中含 ${configs.filter((c) => c.secret).length} 个敏感文件（token/密钥），请确保备份仓库是私有的`)
  }

  // aux: scripts + launchd plists that live outside the plugin system
  const wantAux = includeAux !== false && (cfg == null || cfg.includeAux !== false)
  let aux = { items: [], warnings: [], sourceHome: null, sourceDshHome: null }
  if (wantAux) {
    aux = await collectAuxAssets(backupDir, { homeDir, dshHome, log })
    warnings.push(...aux.warnings)
  } else if (log) {
    log('aux: skipped (includeAux=false)')
  }

  const manifest = {
    formatVersion: FORMAT_VERSION,
    createdAt,
    hostname: hostname(),
    profiles: profilesOut,
    configs,
    configsExcludedSecrets: excludedSecrets,
    aux: {
      formatVersion: AUX_FORMAT_VERSION,
      sourceHome: aux.sourceHome,
      sourceDshHome: aux.sourceDshHome,
      items: aux.items,
    },
  }
  await writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })

  // human-readable README (git history friendly)
  const readme = renderSummaryReadme(manifest, packages)
  await writeFile(path.join(backupDir, 'README.md'), readme)

  if (log) log(`backup built: ${names.length} profiles, ${configs.length} configs, ${packages.length} packages, ${aux.items.length} aux assets -> ${backupDir}`)
  return {
    ok: true,
    backupDir,
    manifestPath: path.join(backupDir, 'manifest.json'),
    createdAt,
    profiles: names,
    missingProfiles: missing,
    configs: { total: entries.length, included: configs.length, excludedSecrets: excludedSecrets.length },
    aux: {
      total: aux.items.length,
      items: aux.items.map((a) => ({ id: a.id, kind: a.kind, file: a.file, original: a.original })),
      warnings: aux.warnings,
    },
    packages,
    warnings,
  }
}

/** Render the human-readable README for the backup repo. */
export function renderSummaryReadme(manifest, packages) {
  const L = []
  L.push('# DSH 插件环境备份')
  L.push('')
  L.push(`> 由 dsh-backup-migrator 生成 · ${manifest.createdAt} · 机器 ${manifest.hostname}`)
  L.push('')
  L.push('## 插件清单')
  L.push('')
  for (const [name, p] of Object.entries(manifest.profiles || {})) {
    L.push(`### profile \`${name}\``)
    L.push('')
    L.push(`- 加载顺序（bundles）：${(p.bundles || []).length} 个`)
    L.push(`- 插件：${(p.plugins || []).length} 个（含本地源 ${(p.plugins || []).filter((x) => x.packageFile).length} 个已打包）`)
    L.push(`- 用户 patch 层：${p.hasUserPatch ? '有' : '无'}`)
    L.push('')
    for (const pl of p.plugins || []) {
      L.push(`- \`${pl.name}\`（${pl.source}${pl.packageFile ? '，已打包' : ''}） \`${pl.spec}\``)
    }
    L.push('')
  }
  L.push('## 配置')
  L.push('')
  L.push(`- 已备份 ${(manifest.configs || []).length} 个配置文件${(manifest.configs || []).filter((c) => c.secret).length ? `（其中 ${manifest.configs.filter((c) => c.secret).length} 个含敏感信息）` : ''}`)
  if ((manifest.configsExcludedSecrets || []).length) {
    L.push(`- 因关闭凭据备份被跳过：${manifest.configsExcludedSecrets.map((c) => c.rel).join('、')}`)
  }
  L.push('')
  L.push('## 本地源插件包')
  L.push('')
  if (packages.length) {
    for (const p of packages) L.push(`- ${p.file}（来自 ${p.original}）`)
  } else {
    L.push('- （无）')
  }
  L.push('')
  L.push('## 机器级附属资产（脚本 / launchd 定时器）')
  L.push('')
  const auxItems = (manifest.aux && manifest.aux.items) || []
  if (auxItems.length) {
    L.push(`源机器 home：\`${(manifest.aux && manifest.aux.sourceHome) || '?'}\`（恢复时自动重写为目标机器 home）`)
    L.push('')
    for (const a of auxItems) {
      L.push(`- \`${a.id}\`（${a.kind}）→ \`${a.file}\``)
      if (a.description) L.push(`  - ${a.description}`)
    }
  } else {
    L.push('- （无）')
  }
  L.push('')
  L.push('> 恢复：新机器上安装 dsh-backup-migrator 后运行 dshbackup_restore，或直接 git clone 本仓库。')
  return L.join('\n')
}

/* ------------------------------------------------------------------ */
/* Verify                                                              */
/* ------------------------------------------------------------------ */

/**
 * Preflight checks. Two contexts are detected automatically:
 *  - source machine (no manifest in backupDir): can every plugin be packed?
 *    git repo ready? secrets warning?
 *  - target machine (manifest present): are the tarballs there? do the
 *    target profiles exist? pnpm available?
 * Returns { ok, checks: [{level:'ok'|'warn'|'error', subject, message}] }.
 */
export async function verifyBackup(cfg, { profiles, homeDir, dshHome, log = () => {} } = {}) {
  const backupDir = dropSlash((cfg && cfg.backupDir) || '')
  const checks = []
  if (!backupDir) {
    checks.push({ level: 'error', subject: 'backupDir', message: '未配置备份目录，先运行 dshbackup_config 设置 backupDir' })
    return { ok: false, checks }
  }
  const mk = (level, subject, message) => checks.push({ level, subject, message })

  // git state
  const repo = await isGitRoot(backupDir).catch(() => false)
  mk(repo ? 'ok' : 'warn', 'git', repo ? '备份目录是独立的 git 仓库根' : '备份目录还不是独立的 git 仓库（备份时会自动 git init）')
  if (repo) {
    const remote = await gitRemote(backupDir)
    const head = await gitHead(backupDir)
    mk(remote ? 'ok' : 'warn', 'remote', remote ? `remote origin: ${remote}` : '没有配置 remote，备份只保存在本地（用 dshbackup_config 设置 repoUrl 后可 push 到 GitHub）')
    const repoUrl = (cfg && cfg.repoUrl || '').trim()
    if (remote && repoUrl && remote !== repoUrl) {
      mk('error', 'remote', `现有 remote（${remote}）与配置的 repoUrl（${repoUrl}）不一致，push 会被拒绝。请修正 repoUrl 或 git remote set-url origin`)
    }
    if (remote && /^https?:\/\/github\.com\//.test(remote)) {
      mk('warn', 'remote', `remote 是 GitHub HTTPS 地址（${remote}）。HTTPS push 需要凭据；也可用 git@ 形式的 SSH URL`)
    }
    mk(head ? 'ok' : 'warn', 'git', head ? `最新提交 ${head}` : '仓库还没有提交')
  }

  // is this a restore target (manifest already present)?
  let manifest = null
  try {
    manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'))
  } catch (err) { manifest = null }

  const pnpm = await pnpmAvailable()
  mk(pnpm ? 'ok' : 'error', 'pnpm', pnpm ? `pnpm ${pnpm}` : '找不到 pnpm，恢复插件需要 pnpm（dsh plugin 依赖它）')

  if (manifest) {
    mk('ok', 'manifest', `发现 manifest.json（${manifest.createdAt || '?'}，格式 v${manifest.formatVersion}），当前处于恢复侧`)
    const want = Array.isArray(profiles) && profiles.length ? profiles : Object.keys(manifest.profiles || {})
    const local = await listProfiles()
    for (const name of want) {
      const mp = manifest.profiles[name]
      if (!mp) { mk('error', `profile ${name}`, 'manifest 里没有这个 profile'); continue }
      if (!local.includes(name)) {
        mk('error', `profile ${name}`, `本机没有 ${name} profile（现有：${local.join(', ') || '无'}）。web/headless 首次启动会自动创建`)
        continue
      }
      mk('ok', `profile ${name}`, `本机存在 ${name} profile，共 ${mp.plugins.length} 个插件待恢复`)
      for (const pl of mp.plugins) {
        if (pl.packageFile) {
          const f = path.join(backupDir, pl.packageFile)
          const ok = await stat(f).then(() => true).catch(() => false)
          mk(ok ? 'ok' : 'error', `${name}/${pl.name}`, ok ? `本地源包存在（${pl.packageFile}）` : `本地源包缺失（${pl.packageFile}）`)
        } else {
          mk('ok', `${name}/${pl.name}`, `来源 ${pl.source}，将执行 pnpm add ${pl.source === 'npm' ? pl.name + (pl.spec ? '@' + pl.spec : '') : pl.spec}（需联网）`)
        }
      }
    }
  } else {
    mk('ok', 'manifest', 'manifest.json 不存在，当前处于备份侧')
    const want = Array.isArray(profiles) && profiles.length ? profiles : await listProfiles()
    for (const name of want) {
      const scan = await scanProfile(name, log)
      if (!scan.ok) { mk('error', `profile ${name}`, scan.error); continue }
      for (const p of scan.plugins) {
        if (p.source === 'link') {
          const ok = await stat(p.resolvedPath).then(() => true).catch(() => false)
          mk(ok ? 'ok' : 'error', `${name}/${p.name}`, ok ? `link 源存在（${p.resolvedPath}），将打包` : `link 源不存在（${p.resolvedPath}），恢复时无法重装`)
        } else if (p.source === 'file') {
          const ok = await stat(p.resolvedPath).then(() => true).catch(() => false)
          mk(ok ? 'ok' : 'error', `${name}/${p.name}`, ok ? `file 源存在（${p.resolvedPath}），将复制` : `file 源不存在（${p.resolvedPath}）`)
        } else if (p.source === 'github' && !/#[0-9a-f]{7,}/i.test(p.spec)) {
          mk('warn', `${name}/${p.name}`, `github 源未钉 commit（${p.spec}）`)
        } else if (p.source === 'other' || p.source === 'workspace') {
          mk('warn', `${name}/${p.name}`, `来源 ${p.source}（${p.spec}）无法自动恢复`)
        } else {
          mk('ok', `${name}/${p.name}`, `来源 ${p.source}，恢复时从远端重装`)
        }
      }
    }
  }

  // aux: scripts + launchd timers outside the plugin system
  if (manifest) {
    const auxItems = (manifest.aux && manifest.aux.items) || []
    if (!auxItems.length) {
      mk('warn', 'aux', '备份里没有 aux 区段（旧版备份）：延迟同步脚本 / launchd 定时器不会被恢复')
    } else {
      mk('ok', 'aux', `备份含 ${auxItems.length} 个机器级附属资产（源 home：${(manifest.aux && manifest.aux.sourceHome) || '?'}）`)
      for (const a of auxItems) {
        const f = path.join(backupDir, a.file)
        const ok = await stat(f).then((s) => s.isFile()).catch(() => false)
        if (!ok) { mk('error', `aux/${a.id}`, `备份里缺少 ${a.file}`); continue }
        if (a.kind === 'launchAgent' && process.platform !== 'darwin') {
          mk('warn', `aux/${a.id}`, '当前平台不是 macOS：脚本会恢复，launchd 定时器将跳过')
        } else {
          mk('ok', `aux/${a.id}`, `将恢复到 ${auxSourcePath(a, { homeDir, dshHome })}`)
        }
      }
    }
  } else {
    for (const item of DEFAULT_AUX_ASSETS) {
      const src = auxSourcePath(item, { homeDir, dshHome })
      const ok = await stat(src).then((s) => s.isFile()).catch(() => false)
      if (ok) mk('ok', `aux/${item.id}`, `将备份 ${src}`)
      else mk('warn', `aux/${item.id}`, `本机不存在 ${src}（未安装该能力，恢复时也不会有）`)
    }
  }

  // configs
  const entries = await findConfigEntries()
  const secrets = entries.filter((e) => e.secret)
  if (secrets.length) {
    mk('warn', 'configs', `本机 ${secrets.length} 个配置文件含敏感信息（${secrets.map((s) => s.rel).join('、')}）。includeSecrets=false 可排除，或确保备份仓库私有`)
  } else {
    mk('ok', 'configs', '未发现敏感配置文件')
  }

  const errors = checks.filter((c) => c.level === 'error').length
  return { ok: errors === 0, checks }
}

async function pnpmAvailable() {
  try {
    const { pnpmVersion } = await import('./git.js')
    return await pnpmVersion()
  } catch (err) { return null }
}

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

/** Update dsh.profile.bundles inside a profile package.json. */
async function writeBundles(profileDir, bundles, log) {
  const file = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(await readFile(file, 'utf8'))
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = bundles
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n')
  if (log) log(`wrote ${bundles.length} bundles into ${file}`)
}

/**
 * Restore a backup into this machine. Steps:
 *  1. obtain the backup tree (existing repo + pull, or clone from repoUrl)
 *  2. for each target profile: pnpm add every plugin (local sources from the
 *     packed tarballs), write back dsh.profile.bundles and cordis.patch.yml
 *  3. optionally restore ~/.dsh configs (0600)
 *  4. optionally restore aux assets (helper scripts + launchd timers) with
 *     machine-path rewriting and `launchctl load`
 * `dryRun` validates everything and reports the plan without writing.
 */
export async function restoreBackup(cfg, { profiles, withConfigs, withAux, loadAgents, dryRun, homeDir, dshHome, log = () => {}, profilesDir = PROFILES_DIR } = {}) {
  const backupDir = dropSlash((cfg && cfg.backupDir) || '')
  const repoUrl = (cfg && cfg.repoUrl || '').trim()
  if (!backupDir) throw new Error('未配置 backupDir，请先运行 dshbackup_config 设置（新机器上先 clone 备份仓库到这个目录）')

  // --- obtain the backup tree ---
  const gitSteps = []
  const exists = await stat(backupDir).then(() => true).catch(() => false)
  let localRepo = exists && await isGitRoot(backupDir).catch(() => false)
  if (!exists && repoUrl && !dryRun) {
    await mkdir(path.dirname(backupDir), { recursive: true })
    const clone = await gitClone(repoUrl, backupDir, log)
    if (!clone.cloned) throw new Error(clone.error)
    localRepo = true
    gitSteps.push(`git clone ${repoUrl}`)
  }
  if (!localRepo) {
    throw new Error(`备份目录不是 git 仓库：${backupDir}。配置 repoUrl 后可自动 clone，或手动 git clone <url> ${backupDir}`)
  }
  if (!dryRun) {
    const pull = await gitPull(backupDir, log)
    if (!pull.pulled && pull.error) gitSteps.push(`pull 失败（使用本地状态继续）：${pull.error}`)
    if (pull.pulled) gitSteps.push(`git pull ${pull.remote}`)
  }

  const manifestFile = path.join(backupDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (err) {
    throw new Error(`manifest.json 不可读（${manifestFile}），这不是有效的备份目录：${err && err.message || err}`)
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error(`备份格式 v${manifest.formatVersion} 与当前插件支持的 v${FORMAT_VERSION} 不一致，请升级 dsh-backup-migrator`)
  }

  const want = Array.isArray(profiles) && profiles.length ? profiles : Object.keys(manifest.profiles || {})
  const missingInManifest = want.filter((n) => !manifest.profiles[n])
  if (missingInManifest.length) throw new Error(`manifest 中不存在 profile：${missingInManifest.join(', ')}`)

  const restoredProfiles = []
  for (const name of want) {
    const mp = manifest.profiles[name]
    const targetDir = path.join(profilesDir, name)
    const targetExists = await stat(path.join(targetDir, 'package.json')).then(() => true).catch(() => false)
    if (!targetExists) {
      restoredProfiles.push({ name, ok: false, error: `本机没有 ${name} profile（现有：${(await listProfiles(profilesDir)).join(', ') || '无'}）。web/headless 首次启动会自动创建，创建后再恢复` })
      continue
    }
    const installs = []
    for (const pl of mp.plugins || []) {
      let tgzPath = null
      if (pl.packageFile) {
        tgzPath = path.join(backupDir, pl.packageFile)
        const ok = await stat(tgzPath).then(() => true).catch(() => false)
        if (!ok) {
          installs.push({ name: pl.name, source: pl.source, action: 'error', error: `本地源包缺失（${pl.packageFile}）` })
          continue
        }
      }
      const addSpec = addSpecFor(pl, tgzPath)
      installs.push({ name: pl.name, source: pl.source, action: 'install', addSpec, fromPackage: !!pl.packageFile })
    }
    const entry = { name, installs, bundles: mp.bundles || [], patch: 'pending' }
    restoredProfiles.push(entry)
    if (dryRun) { entry.ok = true; continue }

    // install
    const results = []
    for (const inst of installs) {
      if (inst.action === 'error') { results.push(inst); continue }
      const r = await pnpmAdd(targetDir, inst.addSpec, log)
      results.push({ ...inst, ok: r.ok, error: r.error || null })
    }
    // bundles + patch
    await writeBundles(targetDir, mp.bundles || [], log)
    const patchSrc = path.join(backupDir, 'profiles', name, 'cordis.patch.yml')
    const patchDst = path.join(targetDir, 'cordis.patch.yml')
    const patchOk = await stat(patchSrc).then(() => true).catch(() => false)
    if (mp.hasUserPatch && patchOk) {
      const existing = await stat(patchDst).then(() => true).catch(() => false)
      if (existing) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        await copyFile(patchDst, patchDst + '.bak-' + ts)
      }
      await copyFile(patchSrc, patchDst)
    }
    const failed = results.filter((r) => !r.ok)
    entry.ok = failed.length === 0
    entry.installs = results
    entry.patch = mp.hasUserPatch ? (patchOk ? 'restored' : 'missing-in-backup') : 'none'
    entry.errors = failed.map((f) => f.error).filter(Boolean)
  }

  // --- configs ---
  const targetDshHome = dshHome || DSH_HOME
  let configResult = { restored: 0, skipped: 0, entries: [] }
  if (withConfigs !== false && !dryRun) {
    const cfgDir = path.join(backupDir, 'configs')
    const entries = await readdir(cfgDir).catch(() => [])
    for (const rel of entries) {
      const src = path.join(cfgDir, rel)
      const dst = path.join(targetDshHome, rel)
      const st = await stat(src)
      if (st.isDirectory()) {
        await copyDir(src, dst)
      } else {
        await mkdir(path.dirname(dst), { recursive: true })
        await copyFile(src, dst)
        try { await chmod(dst, 0o600) } catch (err) { /* best effort */ }
      }
      configResult.restored++
      configResult.entries.push(rel)
    }
    if (log) log(`restored ${configResult.restored} config entries into ${targetDshHome}`)
  } else if (!dryRun) {
    configResult.skipped = 1
  }

  // --- aux (helper scripts + launchd timers outside the plugin system) ---
  let auxResult
  if (withAux === false) {
    auxResult = { restored: [], skipped: [{ id: '*', reason: 'withAux=false' }], warnings: [] }
  } else if (dryRun) {
    const preview = previewAuxRestore(manifest, { homeDir, dshHome })
    auxResult = {
      restored: [],
      skipped: [],
      warnings: preview.warnings,
      plan: preview.entries,
      sourceHome: preview.sourceHome,
      targetHome: preview.targetHome,
    }
  } else {
    auxResult = await restoreAuxAssets(backupDir, manifest, { homeDir, dshHome, loadAgents, log })
  }

  const failedProfiles = restoredProfiles.filter((p) => !p.ok)
  return {
    ok: failedProfiles.length === 0,
    backupDir,
    git: gitSteps,
    profiles: restoredProfiles,
    configs: configResult,
    aux: auxResult,
    dryRun: !!dryRun,
    reminder: '插件安装完成后请重启 DSH GUI（dsh web），让新 bundle 层生效；延迟同步这类 launchd 定时器已在恢复时自动加载，无需等 GUI。',
  }
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

/** Latest manifest + git history of the backup repo. */
export async function listBackup(cfg, log = () => {}) {
  const backupDir = dropSlash((cfg && cfg.backupDir) || '')
  if (!backupDir) throw new Error('未配置 backupDir')
  const repo = await isGitRoot(backupDir).catch(() => false)
  const commits = repo ? await gitLog(backupDir) : []
  let latest = null
  try {
    const m = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'))
    latest = {
      createdAt: m.createdAt,
      hostname: m.hostname,
      profiles: Object.entries(m.profiles || {}).map(([name, p]) => ({
        name,
        plugins: (p.plugins || []).length,
        bundles: (p.bundles || []).length,
        hasUserPatch: !!p.hasUserPatch,
      })),
      configs: (m.configs || []).length,
      configsExcludedSecrets: (m.configsExcludedSecrets || []).length,
      aux: ((m.aux && m.aux.items) || []).map((a) => ({ id: a.id, kind: a.kind, file: a.file })),
      auxSourceHome: (m.aux && m.aux.sourceHome) || null,
    }
  } catch (err) { latest = null }
  return {
    ok: true,
    backupDir,
    isRepo: repo,
    remote: repo ? await gitRemote(backupDir) : null,
    commits,
    latest,
  }
}

/* --- smoke-test exports (not part of the public plugin surface) --- */
export { FORMAT_VERSION as VERSION_FOR_TESTS }
export const __test = { classifySpec, addSpecFor }
