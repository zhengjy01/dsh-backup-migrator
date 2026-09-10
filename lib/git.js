/**
 * dsh-backup-migrator — git / pnpm subprocess helpers.
 *
 * All spawns are bounded (timeout), collect stdout/stderr, and never inherit
 * the parent's stdout so long-running installs cannot interleave with the
 * host's logs. `git` runs with `-c core.quotepath=false` so Chinese file
 * names show up readable in status output.
 *
 * @module dsh-backup-migrator/git
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_TIMEOUT = 120_000

/**
 * Directories that commonly hold a globally installed CLI on this machine.
 * DSH can be started by launchd (the shipped `com.dsh.web` service), whose
 * PATH is only `/usr/bin:/bin` — `pnpm` and `npm` live elsewhere, so a bare
 * name fails with ENOENT even though the tool is installed.
 */
function extraBinDirs() {
  const home = homedir()
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
    '/bin',
  ]
  for (const manager of ['.nvm/versions/node', '.local/share/fnm/node-versions', '.asdf/installs/nodejs']) {
    const root = path.join(home, manager)
    try {
      for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, 'bin'))
    } catch (e) { /* manager not installed — nothing to add */ }
  }
  return dirs
}

/**
 * Resolve an executable name to an absolute path, falling back to the bare
 * name so the OS still performs its own lookup and reports a clear error.
 * @param {string} name - bare executable name.
 * @returns {string} absolute path when found, otherwise `name`.
 */
export function resolveExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const seen = new Set()
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), ...extraBinDirs()]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return name
}

/** Run a command, resolving with { code, stdout, stderr, timedOut }. */
export function runCmd(cmd, args = [], { cwd, timeoutMs = DEFAULT_TIMEOUT, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(resolveExecutable(cmd), args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (e) { /* already gone */ }
      resolve({ code: -1, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(killer)
      resolve({ code: -1, stdout, stderr: String(err && err.message || err), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut: false })
    })
  })
}

/** Run git inside `dir`. */
export function git(dir, args, opts = {}) {
  return runCmd('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, ...opts })
}

const trim = (s) => s.trim()
const firstLine = (s) => s.split(/\r?\n/).map(trim).filter(Boolean)[0] || ''

/**
 * Is `dir` itself the root of a git work tree?
 *
 * Strict check on purpose: many users keep their HOME directory as a git
 * repo (dotfiles). `git rev-parse --is-inside-work-tree` would return true
 * for ANY subdirectory of such a repo, and running `git add -A` there would
 * stage the user's entire home tree. We therefore require the toplevel to
 * BE `dir` (compared via realpath).
 */
export async function isGitRoot(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) return false
  const top = trim(r.stdout)
  if (!top) return false
  const { realpath } = await import('node:fs/promises')
  try {
    const a = await realpath(top)
    const b = await realpath(dir)
    return a === b
  } catch (err) {
    return false
  }
}

/** HEAD commit hash, or null when there are no commits yet. */
export async function gitHead(dir) {
  const r = await git(dir, ['rev-parse', '--short=12', 'HEAD'])
  return r.code === 0 ? firstLine(r.stdout) || null : null
}

/** Current branch name (empty string when unborn). */
export async function gitBranch(dir) {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.code === 0 ? firstLine(r.stdout) : ''
}

/** Remote URL of `origin` (or null). */
export async function gitRemote(dir) {
  const r = await git(dir, ['remote', 'get-url', 'origin'])
  return r.code === 0 ? firstLine(r.stdout) || null : null
}

/** Number of modified / untracked files (0 = clean). */
export async function gitDirtyCount(dir) {
  const r = await git(dir, ['status', '--porcelain'])
  if (r.code !== 0) return -1
  return r.stdout.split(/\r?\n/).filter((l) => l.trim()).length
}

/** Initialize a fresh repo with branch `main`. */
export async function gitInit(dir) {
  return git(dir, ['init', '-b', 'main'])
}

/** Add all changes and commit; skips the commit when nothing changed. */
export async function gitCommit(dir, message, log) {
  const add = await git(dir, ['add', '-A'])
  if (add.code !== 0) return { committed: false, error: 'git add 失败：' + trim(add.stderr) }
  const dirty = await gitDirtyCount(dir)
  if (dirty === 0) return { committed: false, skipped: true }
  const r = await git(dir, ['commit', '-m', message])
  if (r.code !== 0) return { committed: false, error: 'git commit 失败：' + trim(r.stderr) }
  const head = await gitHead(dir)
  if (log) log(`committed ${head}: ${message}`)
  return { committed: true, hash: head }
}

/** Add `origin` remote and push the current branch (with upstream). */
export async function gitPush(dir, repoUrl, log) {
  const remote = await gitRemote(dir)
  if (!remote && repoUrl) {
    const add = await git(dir, ['remote', 'add', 'origin', repoUrl])
    if (add.code !== 0) return { pushed: false, error: '添加 remote 失败：' + trim(add.stderr) }
  }
  const remoteNow = await gitRemote(dir)
  if (!remoteNow) return { pushed: false, error: '没有配置 remote（backup 已保存在本地，push 被跳过）' }
  if (repoUrl && remoteNow !== repoUrl) {
    return { pushed: false, error: `现有 remote（${remoteNow}）与配置的 repoUrl（${repoUrl}）不一致，已拒绝 push。请用 dshbackup_config 修正 repoUrl，或手动 git remote set-url origin <正确的仓库>` }
  }
  const branch = (await gitBranch(dir)) || 'main'
  const r = await git(dir, ['push', '-u', 'origin', branch], { timeoutMs: 180_000 })
  if (r.code !== 0) return { pushed: false, error: 'git push 失败：' + trim(r.stderr) }
  if (log) log(`pushed to ${remoteNow} (${branch})`)
  return { pushed: true, branch, remote: remoteNow }
}

/** Pull with fast-forward only (safe for a backup repo). */
export async function gitPull(dir, log) {
  const remote = await gitRemote(dir)
  if (!remote) return { pulled: false, skipped: true }
  const r = await git(dir, ['pull', '--ff-only'], { timeoutMs: 180_000 })
  if (r.code !== 0) return { pulled: false, error: 'git pull 失败：' + trim(r.stderr) }
  if (log) log(`pulled from ${remote}`)
  return { pulled: true, remote }
}

/** Clone a remote backup repo into `dest` (dest must not exist). */
export async function gitClone(repoUrl, dest, log) {
  const r = await runCmd('git', ['clone', repoUrl, dest], { timeoutMs: 300_000 })
  if (r.code !== 0) return { cloned: false, error: 'git clone 失败：' + trim(r.stderr) }
  if (log) log(`cloned ${repoUrl} -> ${dest}`)
  return { cloned: true }
}

/** Recent commit list [{ hash, date, message }]. */
export async function gitLog(dir, limit = 20) {
  const r = await git(dir, ['log', '--pretty=%H%x1f%ct%x1f%s', `-n${limit}`])
  if (r.code !== 0) return []
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, ct, message] = line.split('\x1f')
    return { hash: (hash || '').slice(0, 12), date: Number(ct) * 1000 || 0, message: message || '' }
  })
}

/** pnpm availability + version. */
export async function pnpmVersion() {
  const r = await runCmd('pnpm', ['--version'])
  return r.code === 0 ? trim(r.stdout) : null
}

/**
 * pnpm add of one spec inside a profile dir. The profile is a pnpm workspace
 * (`dsh plugin --profile X add ...` forwards to pnpm the same way).
 * Retries once on transient failures (pnpm store lock / network).
 */
export async function pnpmAdd(profileDir, spec, log) {
  const maxAttempts = 3 // cloudflared 等 postinstall 会下载二进制，网络间歇失败常见
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runCmd('pnpm', ['add', spec], { cwd: profileDir, timeoutMs: 300_000 })
    if (r.code === 0) {
      if (log) log(`pnpm add ${spec} -> ok`)
      return { ok: true }
    }
    const stderrTail = r.stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')
    const stdoutTail = r.stdout.split(/\r?\n/).filter((l) => !l.startsWith('Progress:')).filter(Boolean).slice(-4).join(' | ')
    const detail = [stderrTail, stdoutTail].filter(Boolean).join(' | ') || '未知错误'
    if (attempt === 1) {
      if (log) log(`pnpm add ${spec} 失败（第 1 次），重试…：${detail}`)
      continue
    }
    return { ok: false, error: `pnpm add ${spec} 失败：${detail}` }
  }
  return { ok: false, error: `pnpm add ${spec} 失败` }
}

/**
 * `npm pack` a local plugin directory into `destDir` (respects the package's
 * `files` field; ignores lifecycle scripts). Returns { ok, file } where
 * `file` is the tarball basename, or { ok:false, error }.
 */
export async function npmPack(dir, destDir, log) {
  const r = await runCmd('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destDir], {
    cwd: dir,
    timeoutMs: 120_000,
  })
  if (r.code !== 0) {
    return { ok: false, error: `npm pack 失败（${dir}）：${trim(r.stderr) || trim(r.stdout) || '未知错误'}` }
  }
  try {
    const parsed = JSON.parse(r.stdout)
    const item = Array.isArray(parsed) ? parsed[0] : parsed
    const file = item && item.filename
    if (file) {
      if (log) log(`packed ${file} from ${dir}`)
      return { ok: true, file }
    }
  } catch (err) { /* fall through */ }
  return { ok: false, error: `npm pack 输出无法解析（${dir}）` }
}
