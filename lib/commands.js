/**
 * /title 斜杠命令：预览、立即更新、固定、暂停等日常控制。
 * 固定与解除固定完全借用宿主语义：rename() 写入 user 来源即固定，
 * 自动命名永远不会覆盖它；解除固定则让提供者再写一次标题。
 */
import { STATUS_TEXT, TitleSkip } from './namer.js'

export const USAGE = [
  '用法：/title [子命令]',
  '  （空）/ now      立即按最近对话检查并更新标题',
  '  preview          只预览候选标题，不写入',
  '  set <标题>       手动设置并固定标题',
  '  lock / unlock    固定当前标题 / 恢复自动命名',
  '  pause / resume   暂停 / 恢复所有会话的自动命名',
  '  status           查看状态与模型用量',
].join('\n')

const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })
const SOURCE_TEXT = { fallback: '占位（取自首条消息）', provider: '自动命名', user: '已固定（手动）' }
const HARD_FAILURES = new Set(['model_error', 'timeout', 'invalid_output', 'no_route', 'input_too_large'])

const explain = (status, detail) => `${STATUS_TEXT[status] ?? status}${detail ? `：${detail}` : ''}`

/**
 * @param {{ namer: import('./namer.js').Namer, sessionTitle: any, store: import('./store.js').Store, dataDir: string }} deps
 */
export function createTitleCommand({ namer, sessionTitle, store, dataDir }) {
  return async function handler(invocation) {
    const session = invocation.agent.session
    const raw = invocation.rawInput.trim()
    const space = raw.search(/\s/u)
    const sub = (space < 0 ? raw : raw.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : raw.slice(space + 1).trim()
    const current = sessionTitle.get(session)

    switch (sub) {
      case '':
      case 'now':
      case 'refresh': {
        if (current?.source.kind === 'user') return fail(STATUS_TEXT.manual_title)
        const result = await namer.refreshNow(session, { force: true })
        if (result.ok) return ok(`标题已更新：${result.title}`)
        const text = explain(result.status, result.detail)
        return HARD_FAILURES.has(result.status) ? fail(text) : ok(`${text}${current ? `\n当前：${current.title}` : ''}`)
      }
      case 'preview': {
        try {
          const candidate = await namer.evaluate(session, { signal: invocation.signal, force: true, dryRun: true })
          return ok(`候选标题：${candidate.title}\n当前：${current?.title ?? '（无）'}\n确认后执行 /title now 写入。`)
        } catch (error) {
          if (!(error instanceof TitleSkip)) throw error
          const text = explain(error.status, error.detail)
          return HARD_FAILURES.has(error.status) ? fail(text) : ok(`${text}${current ? `\n当前：${current.title}` : ''}`)
        }
      }
      case 'set': {
        if (rest === '') return fail('用法：/title set <标题>')
        try {
          return ok(`已固定标题：${sessionTitle.rename(session, rest).title}`)
        } catch (error) {
          return fail(`无法设置标题：${error.message}`)
        }
      }
      case 'lock': {
        if (!current) return fail('这个会话还没有标题可以固定')
        if (current.source.kind === 'user') return ok(`标题已经是固定状态：${current.title}`)
        return ok(`已固定标题：${sessionTitle.rename(session, current.title).title}`)
      }
      case 'unlock': {
        if (current?.source.kind !== 'user') return ok('标题没有被固定，自动命名一直有效')
        const result = await namer.refreshNow(session, { force: true, override: true })
        if (result.ok) return ok(`已恢复自动命名，当前标题：${result.title}`)
        return fail(`解除固定失败：${explain(result.status, result.detail)}`)
      }
      case 'pause':
        return store.writeConfig({ enabled: false }) ? ok('已暂停自动命名（所有会话）。/title resume 恢复。') : fail('无法写入配置文件')
      case 'resume':
        return store.writeConfig({ enabled: true }) ? ok('已恢复自动命名。') : fail('无法写入配置文件')
      case 'status': {
        const config = store.readConfig()
        const last = store.lastLog(session.id)
        const usage = store.usageSummary()
        const lines = [
          `自动命名：${config.enabled ? '开启' : '已暂停'}`,
          `当前标题：${current?.title ?? '（无）'}${current ? `〔${SOURCE_TEXT[current.source.kind] ?? current.source.kind}〕` : ''}`,
          `本会话最近一次：${last ? `${last.status}${last.title ? `｜${last.title}` : ''}` : '（暂无记录）'}`,
          `累计模型调用：${usage.calls} 次，输入 ${usage.inputTokens}（未缓存）+ 缓存命中 ${usage.cacheReadTokens} / 输出 ${usage.outputTokens} tokens` +
            `（${usage.unknown} 次用量未知）`,
          `免调用的确认跳过：${usage.skippedByFilter} 次`,
          `数据目录：${dataDir}`,
        ]
        return ok(lines.join('\n'))
      }
      default:
        return fail(`未知子命令「${sub}」\n${USAGE}`)
    }
  }
}
