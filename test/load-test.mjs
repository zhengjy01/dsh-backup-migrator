/**
 * 模拟 boot 加载测试（插件开发检查清单第 2 条）：
 * 用假 ctx 完整跑一次 apply()，验证 5 个工具 schema 编译 + 注册 + 公告 section，
 * 不依赖真实 DSH 宿主。
 *
 * 运行：node test/load-test.mjs
 */

import { apply } from '../lib/index.js'

const tools = []
const sections = []
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
  console.log(`✅ 加载成功：${tools.length} 个工具、${sections.length} 个 section`)
} catch (e) {
  console.error('❌ 加载失败:', e.message)
  process.exit(1)
}
