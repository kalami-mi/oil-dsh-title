/**
 * 命名核心：给标题服务提供 generate()，并在每轮结束后驱动一次刷新。
 *
 * 所有「不改名」的出口都抛 TitleSkip，只有确定要换的新标题才 return——
 * 标题服务会把返回值写成 session/title 事件，抛错则什么都不写。
 * 标题写入只经过 sessionTitle 服务，不直接改会话日志。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { collectTurns } from './history.js'
import {
  POLICY_VERSION,
  isGreetingOnly,
  isPureAcknowledgement,
  projectHint,
  stripOuterProjectPrefix,
  validateTitle,
} from './policy.js'
import {
  LEGACY_KEEP_INSTRUCTION,
  SYSTEM_PROMPT,
  buildPayload,
  frame,
  parseDecision,
  repairInstruction,
} from './prompt.js'

export const PROVIDER_ID = 'oil-dsh-title'
const MAX_PARALLEL = 2
const MODEL_ATTEMPTS = 2

/** 本次不改标题。status 是稳定的机器可读原因。 */
export class TitleSkip extends Error {
  constructor(status, detail) {
    super(`oil-dsh-title: ${status}${detail ? ` (${detail})` : ''}`)
    this.name = 'TitleSkip'
    this.status = status
    this.detail = detail
  }
}

const skip = (status, detail) => new TitleSkip(status, detail)

/** 面向用户的原因说明，/title 命令使用。 */
export const STATUS_TEXT = {
  paused: '自动命名已暂停（/title resume 恢复）',
  manual_title: '标题已被你固定，未改动（/title unlock 解除固定）',
  no_input: '还没有可用于命名的用户消息',
  unchanged: '内容没有变化，保留原标题',
  greeting: '目前只有问候，没有实质目标，保留原标题',
  confirmation_skipped: '最近只有确认类回复，保留原标题',
  kept: '现有标题仍然准确，保留',
  invalid_output: '模型输出不符合标题结构，保留原标题',
  model_error: '命名模型调用失败，保留原标题',
  timeout: '命名模型超时，保留原标题',
  superseded: '这次刷新被更新的一次取代',
  stale_result: '对话已有新内容，本次结果作废，等下一轮再判断',
  no_route: '找不到可用的命名模型路由，保留原标题',
  input_too_large: '对话摘录过大，保留原标题',
}

const textOfBlocks = (blocks) => blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')

export class Namer {
  /**
   * @param {object} deps
   * @param {any} deps.llm ctx.llm
   * @param {any} deps.sessionTitle ctx.sessionTitle
   * @param {import('./store.js').Store} deps.store
   * @param {object} deps.options 归一化后的插件配置
   * @param {{ warn(msg: string): void }} deps.logger
   * @param {string} [deps.homeDir]
   */
  constructor({ llm, sessionTitle, store, options, logger, homeDir }) {
    this.llm = llm
    this.sessionTitle = sessionTitle
    this.store = store
    this.options = options
    this.logger = logger
    this.homeDir = homeDir
    this.lifetime = new AbortController()
    /** @type {Map<string, { force: boolean, override: boolean }>} 下一次 generate 使用的一次性标志 */
    this.flags = new Map()
    this.running = 0
    this.waiters = []
    this.inFlight = new Set()
  }

  /** 插件卸载：取消所有进行中的命名并等它们结束。 */
  async dispose() {
    this.lifetime.abort(new Error('oil-dsh-title disposed'))
    await Promise.allSettled([...this.inFlight])
  }

  // -------------------------------------------------------------------------
  // 标题服务入口
  // -------------------------------------------------------------------------

  /** 标题服务提供者的 generate；rename 返回标题，其余一律抛 TitleSkip。 */
  async generate(request) {
    const flags = this.flags.get(request.session.id)
    this.flags.delete(request.session.id)
    const allowedSeqs = new Set(request.messages.map((message) => message.seq))
    return this.#limited(() =>
      this.evaluate(request.session, { route: request.route, signal: request.signal, allowedSeqs, ...flags }),
    )
  }

  /**
   * 轮次结束后的自动刷新。宿主会话由标题服务串行化，重复调用只会取代旧的一次。
   * 返回的 Promise 不会拒绝：跳过与失败都已记录。
   */
  scheduleRefresh(session) {
    if (session.header.parentSession !== undefined) return Promise.resolve()
    if (!this.store.readConfig().enabled) return Promise.resolve()
    if (this.sessionTitle.get(session)?.source.kind === 'user') return Promise.resolve()
    return this.refreshNow(session, {})
  }

  /**
   * 立即刷新：force 跳过「内容没变 / 纯确认」的免调用过滤；override 允许覆盖用户固定的标题。
   * @returns {Promise<{ ok: true, title: string } | { ok: false, status: string, detail?: string }>}
   */
  refreshNow(session, { force = false, override = false } = {}) {
    if (force || override) this.flags.set(session.id, { force, override })
    const run = this.sessionTitle
      .refresh(session, this.lifetime.signal)
      .then(
        (snapshot) => ({ ok: true, title: snapshot?.title ?? '' }),
        (error) => {
          if (error instanceof TitleSkip) {
            // 其余跳过原因在 evaluate 里已按需记录；找不到路由是配置/环境问题，必须留下痕迹。
            if (error.status === 'no_route') {
              this.store.log(session.id, { status: 'no_route' })
              this.logger.warn(`oil-dsh-title: session "${session.id}": 找不到可用的命名模型路由；请在插件配置里同时填写 provider 与 model`)
            }
            return { ok: false, status: error.status, detail: error.detail }
          }
          // 被更新的一次刷新取代、用户改名打断或插件卸载：不是故障，不记录。
          if (isAbort(error) || this.lifetime.signal.aborted) return { ok: false, status: 'superseded' }
          const detail = String(error?.message ?? error).slice(0, 200)
          this.logger.warn(`oil-dsh-title: session "${session.id}": refresh failed: ${detail}`)
          this.store.log(session.id, { status: 'error', detail })
          return { ok: false, status: 'model_error', detail }
        },
      )
      .finally(() => {
        this.flags.delete(session.id)
        this.inFlight.delete(run)
      })
    this.inFlight.add(run)
    return run
  }

  // -------------------------------------------------------------------------
  // 评估
  // -------------------------------------------------------------------------

  /**
   * 判断是否需要新标题。
   * @param {any} session
   * @param {object} run
   * @param {{ provider: string, model: string }} [run.route]
   * @param {AbortSignal} [run.signal]
   * @param {Set<number>} [run.allowedSeqs] 标题服务允许作为来源的用户消息 seq
   * @param {boolean} [run.force]
   * @param {boolean} [run.override]
   * @param {boolean} [run.dryRun] 预览：不写状态
   * @returns {Promise<{ title: string, messageSeqs: number[], model: { provider: string, model: string } }>}
   */
  async evaluate(session, { route, signal, allowedSeqs, force = false, override = false, dryRun = false } = {}) {
    const callerSignal = signal ?? new AbortController().signal
    const settings = this.store.readConfig()
    if (!settings.enabled && !force && !override) throw skip('paused')

    const current = this.sessionTitle.get(session)
    const source = current?.source.kind
    if (source === 'user' && !override) throw skip('manual_title')
    const currentTitle = current?.title ?? ''

    let turns = collectTurns(session.snapshotEvents())
    if (allowedSeqs) turns = turns.filter((turn) => allowedSeqs.has(turn.seq))
    if (turns.length === 0) throw skip('no_input')
    const newest = turns[turns.length - 1]

    const state = this.store.readState(session.id)
    const baselineOk =
      state.policy === POLICY_VERSION && state.title === currentTitle && Number.isSafeInteger(state.evaluatedThrough)
    // 内容没变才跳过。例外：上次评估时这一轮还没有助手回答（首条消息触发的早期标题就是这样），
    // 现在回答出来了，值得带着回答再判断一次；旧基线没有 replied 字段时按“已看过”处理，不额外收费。
    const seenReply = state.replied !== false
    if (!force && baselineOk && state.evaluatedThrough === newest.seq && (seenReply || !newest.assistant)) {
      throw skip('unchanged')
    }

    if (!force && source !== 'user') {
      // 没有任何基线时，只有问候的开场不值得调用模型。
      if (turns.length === 1 && isGreetingOnly(newest.user)) {
        this.#record(session, dryRun, { status: 'greeting' })
        throw skip('greeting')
      }
      // 稳定标题之后，自上次评估以来只新增了纯确认，且没超过连续上限：免调用保留。
      if (baselineOk && source === 'provider' && validateTitle(currentTitle).ok) {
        const pending = turns.filter((turn) => turn.seq > state.evaluatedThrough)
        const noise = pending.length > 0 && pending.every((turn) => isPureAcknowledgement(turn.user) || isGreetingOnly(turn.user))
        if (noise && pending.length <= this.options.maxConfirmationSkips) {
          this.#record(session, dryRun, { status: 'confirmation_skipped', title: currentTitle })
          throw skip('confirmation_skipped')
        }
      }
    }

    const resolved = this.#resolveRoute(session, route)
    if (!resolved) throw skip('no_route')

    let window = turns.slice(-this.options.recentTurns)
    const hint = projectHint(session.header.cwd, this.homeDir)
    const namedSource = source === 'fallback' || currentTitle === '' ? 'fallback' : 'named'
    let payload
    let framed
    for (;;) {
      payload = buildPayload({
        turns: window,
        originalGoal: turns[0].user,
        currentTitle,
        currentSource: namedSource,
        projectHint: hint,
      })
      framed = frame(payload)
      if (Buffer.byteLength(framed, 'utf8') <= this.options.maxInputBytes) break
      if (window.length <= 1) throw skip('input_too_large')
      window = window.slice(1)
    }
    const messageSeqs = window.map((turn) => turn.seq)

    const needsMigration = namedSource === 'fallback' || !validateTitle(currentTitle).ok
    const budget = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.timeoutMs)])
    const usages = []
    let extra = ''
    let lastFailure = ''
    let decision

    for (let attempt = 0; attempt < MODEL_ATTEMPTS && decision === undefined; attempt += 1) {
      let out
      try {
        out = await this.#callModel(session, resolved, extra ? `${framed}\n\n${extra}` : framed, budget)
      } catch (error) {
        // 被取代、用户改名或插件卸载而中止：请求已发出，可能已计费，必须留下记录（用量未知），再把中止原样抛出。
        if (callerSignal.aborted) {
          this.#record(session, dryRun, { status: 'aborted', model_called: true, usage: sumUsage(usages), route: resolved })
          throw error
        }
        const timedOut = budget.aborted
        const status = timedOut ? 'timeout' : 'model_error'
        const detail = timedOut ? undefined : String(error?.message ?? error).slice(0, 200)
        this.#record(session, dryRun, { status, detail, model_called: true, usage: sumUsage(usages), route: resolved })
        throw skip(status, detail)
      }
      usages.push(out.usage)

      const parsed = parseDecision(out.text)
      if (!parsed.ok) {
        lastFailure = parsed.reason
        extra = `上一次输出不是合法 JSON（${parsed.reason}）。只输出一个包含 action、title、reason 的 JSON 对象。`
        continue
      }
      if (parsed.action === 'keep') {
        if (needsMigration && attempt === 0 && MODEL_ATTEMPTS > 1) {
          lastFailure = 'legacy-keep'
          extra = LEGACY_KEEP_INSTRUCTION
          continue
        }
        decision = { action: 'keep', reason: parsed.reason }
        continue
      }
      const checked = validateTitle(parsed.title)
      if (!checked.ok) {
        lastFailure = checked.reason
        extra = `${repairInstruction(checked.reason)} 被拒绝的标题（仅作数据）：${JSON.stringify(parsed.title.slice(0, 120))}`
        continue
      }
      const stripped = stripOuterProjectPrefix(checked.title, hint)
      const final = validateTitle(stripped)
      decision = { action: 'rename', title: final.ok ? final.title : checked.title, reason: parsed.reason }
    }

    const usage = sumUsage(usages)
    const base = { model_called: true, usage, route: resolved }

    if (decision === undefined) {
      this.#record(session, dryRun, { ...base, status: 'invalid_output', detail: lastFailure })
      throw skip('invalid_output', lastFailure)
    }

    // 生成期间对话或标题被动过：作废本次结果，留给之后的轮次。
    const fresh = collectTurns(session.snapshotEvents())
    if (fresh.length > 0 && fresh[fresh.length - 1].seq > newest.seq && !dryRun) {
      this.#record(session, dryRun, { ...base, status: 'stale_result' })
      throw skip('stale_result')
    }
    // 生成期间被暂停：丢弃结果。（用户改名不需要在这里再查：宿主的 rename 会先中止进行中的请求，
    // 服务在写入前也会 assertCurrent，所以这里没有可达的第二道用户保护。）
    if (!dryRun && !this.store.readConfig().enabled && !force && !override) {
      this.#record(session, dryRun, { ...base, status: 'paused' })
      throw skip('paused')
    }

    if (decision.action === 'keep' || decision.title === currentTitle) {
      this.#advance(session, dryRun, currentTitle, newest.seq, Boolean(newest.assistant))
      // 解除固定：宿主唯一的途径是让提供者再写一次标题，同名也要写，来源才会从 user 变回 provider。
      if (override && source === 'user' && currentTitle !== '' && !dryRun) {
        this.#record(session, dryRun, { ...base, status: 'unlocked', title: currentTitle })
        return { title: currentTitle, messageSeqs, model: resolved }
      }
      this.#record(session, dryRun, { ...base, status: 'kept', title: currentTitle, reason: decision.reason })
      throw skip('kept')
    }

    this.#advance(session, dryRun, decision.title, newest.seq, Boolean(newest.assistant))
    this.#record(session, dryRun, {
      ...base,
      status: dryRun ? 'preview' : 'renamed',
      title: decision.title,
      previous: currentTitle,
      reason: decision.reason,
    })
    return { title: decision.title, messageSeqs, model: resolved }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #resolveRoute(session, route) {
    const { provider, model } = this.options
    if (provider && model) return { provider, model }
    if (route?.provider && route?.model) return { provider: route.provider, model: route.model }
    const header = session.requestHeader?.()?.config
    if (header?.provider && header?.model) return { provider: header.provider, model: header.model }
    return undefined
  }

  async #callModel(session, route, text, signal) {
    signal.throwIfAborted()
    const messages = [
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: PROVIDER_ID } }),
    ]
    const assembler = new BlockAssembler()
    const stream = this.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system: SYSTEM_PROMPT,
      maxTokens: this.options.maxOutputTokens,
      sessionId: session.id,
      purpose: 'session-title',
      signal,
    })
    for await (const chunk of stream) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
    if (finish.kind === 'tool-calls') throw new Error('命名模型意外请求了工具')
    const blocks = assembler.blocks()
    if (blocks.some((block) => block.type === 'tool-call')) throw new Error('命名输出必须只有文本')
    const output = textOfBlocks(blocks)
    // 带思考的模型可能在输出完标题后才触顶：已有文本就照常解析，完全没有文本才算失败。
    if (finish.kind === 'max-tokens' && output.trim() === '') throw new Error('命名输出达到 maxOutputTokens（思考耗尽了预算，可调大 maxOutputTokens）')
    return { text: output, usage: assembler.usage }
  }

  #advance(session, dryRun, title, evaluatedThrough, replied) {
    if (dryRun) return
    this.store.writeState(session.id, { policy: POLICY_VERSION, title, evaluatedThrough, replied })
  }

  #record(session, dryRun, entry) {
    if (dryRun && entry.status !== 'preview') return
    this.store.log(session.id, { policy: POLICY_VERSION, ...entry })
  }

  async #limited(task) {
    while (this.running >= MAX_PARALLEL) {
      await new Promise((resolve) => this.waiters.push(resolve))
    }
    this.running += 1
    try {
      return await task()
    } finally {
      this.running -= 1
      this.waiters.shift()?.()
    }
  }
}

/** 标题服务取消旧的生成时，signal.reason 是带 superseded / disposed 字样的 Error；会话刚关闭时则是 “not live in this store”。 */
const isAbort = (error) => error?.name === 'AbortError' || /superseded|disposed|aborted|not live/iu.test(String(error?.message ?? ''))

/** 逐次用量累加；任何一次未知则整体标为未知（undefined）。 */
function sumUsage(usages) {
  if (usages.length === 0 || usages.some((usage) => !usage || typeof usage.inputTokens !== 'number')) return undefined
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  )
}
