/**
 * 集成测试脚手架：真实的 cordis Context、SessionStore、SessionProjectionRegistry、
 * SessionTitleService、CommandRuntime，只把 LLM 服务换成可编排的假实现。
 * 需要先运行 scripts/extract-runtime.py 把 Harness 自带的运行时解到 node_modules。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import * as commandsModule from '@deepseek-ai/dsh-commands'
import * as plugin from '../lib/index.js'

export const ROUTE = { provider: 'test-provider', model: 'test-model' }
export const CWD = resolve(tmpdir(), 'Maple')

const chunksFor = (text) => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 可编排的 LLM：responses 里的每一项是字符串、返回字符串的函数，或 Error。 */
export class FakeLlm extends Service {
  calls = []
  script = []
  delayMs = 0
  constructor(ctx) {
    super(ctx, 'llm')
  }

  async *stream(options) {
    const call = { options, text: options.messages[0].content.map((block) => block.text).join('') }
    this.calls.push(call)
    // 请求发起时就取走对应的答复：延迟再长，也按发起顺序对应。
    let next = this.script.length > 0 ? this.script.shift() : '{"action":"keep","title":"","reason":"默认"}'
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs)
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(options.signal.reason)
        }, { once: true })
      })
    }
    options.signal.throwIfAborted()
    if (typeof next === 'function') next = next(call)
    if (next instanceof Error) throw next
    if (next && typeof next === 'object' && next.chunks) {
      yield* next.chunks
      return
    }
    yield* chunksFor(typeof next === 'string' ? next : JSON.stringify(next))
  }

  /** 编排：依次返回这些决策。 */
  reply(...items) {
    this.script.push(...items)
  }
}

export const decision = (action, title, reason = '测试') => JSON.stringify({ action, title, reason })

/** 建一个完整的宿主组合并挂上被测插件。 */
export async function createRig({ pluginConfig = { ...ROUTE }, mountPlugin = true, withCommands = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'oil-dsh-title-it-'))
  process.env.OIL_DSH_TITLE_DATA = dataDir
  const ctx = new Context()
  const warnings = []
  ctx.on('internal/warning', () => {})
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SessionStore)
  ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  ctx.plugin(FakeLlm)
  if (withCommands) ctx.plugin(commandsModule.default ?? commandsModule.CommandRuntime)
  await settle()
  // 收集 warn 日志，测试里断言没有意外告警。
  const loggerWarn = ctx.logger.warn.bind(ctx.logger)
  const proto = Object.getPrototypeOf(ctx.logger)
  if (proto && typeof proto.warn === 'function') {
    ctx.logger.warn = (...args) => {
      warnings.push(args.join(' '))
      return loggerWarn(...args)
    }
  }
  let fiber
  if (mountPlugin) {
    fiber = ctx.plugin(plugin, pluginConfig)
    await settle()
  }

  let turn = 0
  const rig = {
    ctx,
    dataDir,
    warnings,
    llm: ctx.llm,
    fiber,
    /** 挂载（或重新挂载）被测插件，返回它的 fiber。 */
    async mount(config = { ...ROUTE }) {
      rig.fiber = ctx.plugin(plugin, config)
      await settle()
      return rig.fiber
    },
    async dispose() {
      await ctx.stop?.()
      rmSync(dataDir, { recursive: true, force: true })
      delete process.env.OIL_DSH_TITLE_DATA
    },
    newSession(id = 'session-1', cwd = CWD) {
      return ctx.sessions.create(id, { meta: { cwd } })
    },
    /** 一整轮：用户消息 → 助手回答 → 轮次正常结束。 */
    async runTurn(session, userText, assistantText = '好的，已处理。', { end = 'completed' } = {}) {
      turn += 1
      appendUser(session, userText)
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      if (assistantText !== null) appendAssistant(session, turn, assistantText)
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: end } })
      await settle()
    },
  }
  return rig
}

export function appendUser(session, text, kind = 'user') {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind } }), { surfaceOp: 'append' })
}

export function appendAssistant(session, turn, text) {
  const accumulator = new AssistantStreamAccumulator()
  const assembler = new BlockAssembler()
  for (const chunk of chunksFor(text)) {
    const timed = accumulator.push({ time: Date.now(), chunk })
    assembler.push(timed.chunk)
  }
  return session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({ content: assembler.blocks(), source: { ...ROUTE } }),
      usage: assembler.usage,
      stream: accumulator.snapshot(),
    },
    { surfaceOp: 'append' },
  )
}

/** 让 Promise 微任务与定时器排空；命名是后台异步的。 */
export async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

/** 等待条件成立（后台命名完成），超时抛错。 */
export async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 通过真实的命令运行时执行一行斜杠命令，返回 { kind, text }。 */
export async function runCommand(rig, session, line) {
  const agent = { id: 'agent-1', session }
  const executed = await rig.ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (executed === undefined) throw new Error(`命令未被解析：${line}`)
  return executed.result
}
