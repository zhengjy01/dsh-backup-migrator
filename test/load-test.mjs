/**
 * 模拟 boot 加载测试（插件开发检查清单第 2 条）：
 * 用假 ctx 完整跑一次 apply()，验证 5 个工具 schema 编译 + 注册 + 公告 section
 * + loopback HTTP 路由注册，不依赖真实 DSH 宿主。
 *
 * 运行：node test/load-test.mjs
 */

import { apply } from '../lib/index.js'

const tools = []
const sections = []
const routes = []
const effects = []

const ctx = {
  get: () => null,
  logger: { info: (m) => console.log('[log]', m) },
  tools: {
    register: (t) => {
      tools.push(t.name)
      console.log('[tools]', t.name)
      return () => {}
    },
  },
  systemPrompt: {
    section: (s) => {
      sections.push(s.name)
      console.log('[section]', s.name)
      return () => {}
    },
  },
  webServer: {
    register: (r) => {
      routes.push(r.path)
      console.log('[route]', r.path)
      return () => {}
    },
  },
  effect: (fn) => {
    const d = fn()
    effects.push(d)
    return () => (typeof d === 'function' ? d() : undefined)
  },
}

try {
  apply(ctx, {})
  const expected = ['dshbackup_config', 'dshbackup_backup', 'dshbackup_verify', 'dshbackup_restore', 'dshbackup_list']
  const missing = expected.filter((n) => !tools.includes(n))
  if (missing.length) throw new Error('缺少工具: ' + missing.join(', '))
  if (sections.length !== 1) throw new Error('公告 section 数量不对: ' + sections.length)
  const expectedRoutes = ['/api/dsh-backup-migrator/probe', '/api/dsh-backup-migrator/status']
  const missingRoutes = expectedRoutes.filter((p) => !routes.includes(p))
  if (missingRoutes.length) throw new Error('缺少路由: ' + missingRoutes.join(', '))
  console.log(`✅ 加载成功：${tools.length} 个工具、${sections.length} 个 section、${routes.length} 条路由`)
} catch (e) {
  console.error('❌ 加载失败:', e.message)
  process.exit(1)
}

