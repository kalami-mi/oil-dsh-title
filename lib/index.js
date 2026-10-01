/**
 * oil-dsh-title：让 DeepSeek Harness 的会话标题跟上讨论内容。
 *
 * 接入方式：
 *   1. 向标题服务注册唯一的标题提供者（内置的 session-title-llm 由 bundle 补丁关闭）；
 *   2. 每轮正常结束（session/event 的 turn/end）后调用 sessionTitle.refresh，由提供者判断是否更新；
 *   3. 可选注册 /title 命令。
 * 标题只通过 sessionTitle 服务写入；用户手动改名会被服务固定，本插件不会覆盖。
 */
import { homedir } from 'node:os'
import { createTitleCommand } from './commands.js'
import { Namer, PROVIDER_ID } from './namer.js'
import { Store, resolveDataDir } from './store.js'

export const name = 'oil-dsh-title'
export const inject = ['sessionTitle', 'llm', 'sessions']

const DEFAULTS = Object.freeze({
  provider: '',
  model: '',
  recentTurns: 5,
  maxInputBytes: 16384,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  maxConfirmationSkips: 2,
})

const REGISTER_RETRY_MS = 250
const REGISTER_RETRIES = 40

const positiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) =>
  Number.isInteger(value) && value > 0 && value <= max ? value : fallback

/** 宽松归一化：未知键忽略，非法值退回默认，不因为一个错字段让整个插件起不来。 */
export function normalizeOptions(input) {
  // YAML 里写 `config:`（空值）得到 null，写成标量也可能；一律当作没填。
  const config = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  const paired = provider !== '' && model !== ''
  return {
    provider: paired ? provider : '',
    model: paired ? model : '',
    recentTurns: positiveInt(config.recentTurns, DEFAULTS.recentTurns, 20),
    maxInputBytes: positiveInt(config.maxInputBytes, DEFAULTS.maxInputBytes),
    maxOutputTokens: positiveInt(config.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: positiveInt(config.timeoutMs, DEFAULTS.timeoutMs, 2 ** 31 - 1),
    maxConfirmationSkips: Number.isInteger(config.maxConfirmationSkips) && config.maxConfirmationSkips >= 0
      ? config.maxConfirmationSkips
      : DEFAULTS.maxConfirmationSkips,
  }
}

/**
 * 插件入口。绝不向宿主抛出：启动期的同步异常在桌面端可能升级成“致命错误”，
 * 进而触发它的恢复流程（停用第三方组合包并备份、重置用户补丁）。标题只是锦上添花，
 * 出任何问题都应降级为“本插件不工作”（标题回退到宿主默认），而不是拖垮启动。
 */
export function apply(ctx, config) {
  try {
    mount(ctx, config)
  } catch (error) {
    ctx.logger.warn(`oil-dsh-title: 启动失败，本插件不会工作（标题回退为宿主默认）：${String(error?.stack ?? error)}`)
  }
}

function mount(ctx, config) {
  const options = normalizeOptions(config)
  if ((config?.provider || config?.model) && !options.provider) {
    ctx.logger.warn('oil-dsh-title: provider 与 model 必须同时填写，已忽略，改用会话当前的模型')
  }

  const dataDir = resolveDataDir()
  const store = new Store(dataDir)
  const namer = new Namer({
    llm: ctx.llm,
    sessionTitle: ctx.sessionTitle,
    store,
    options,
    logger: ctx.logger,
    homeDir: homedir(),
  })

  registerProvider(ctx, namer)

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'turn/end') return
      const kind = event.data?.reason?.kind
      if (kind !== 'completed' && kind !== 'max-tokens') return
      void namer.scheduleRefresh(session)
    } catch (error) {
      ctx.logger.warn(`oil-dsh-title: 处理轮次结束事件失败：${String(error?.message ?? error)}`)
    }
  })

  // commands 服务由 dsh-base 提供，但与本插件的挂载先后没有保证；用 inject 等它就绪，
  // 缺失时只是没有 /title，自动命名不受影响。
  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.effect(function* () {
        yield commandCtx.commands.register({
          name: 'title',
          description: '查看或调整本会话的自动标题',
          input: { hint: 'now | preview | set <标题> | lock | unlock | pause | resume | status' },
          recordInput: false,
          handler: createTitleCommand({ namer, sessionTitle: ctx.sessionTitle, store, dataDir }),
        })
      }, 'oil-dsh-title command')
    } catch (error) {
      ctx.logger.warn(`oil-dsh-title: /title 命令注册失败（自动命名不受影响）：${String(error?.message ?? error)}`)
    }
  })

  ctx.effect(() => async () => {
    await namer.dispose()
  }, 'oil-dsh-title lifecycle')
}

/**
 * 标题服务同一时刻只允许一个提供者。热重载时内置提供者可能还没卸载完，
 * 所以注册失败后短暂重试，而不是直接让插件启动失败。
 */
function registerProvider(ctx, namer) {
  const provider = {
    id: PROVIDER_ID,
    // 首条提示由服务自动触发；之后每轮由本插件在轮次结束时主动 refresh。
    automatic: 'first-prompt',
    generate: (request) => namer.generate(request),
  }
  let attempts = 0
  let timer
  const attempt = () => {
    timer = undefined
    try {
      ctx.sessionTitle.register(provider)
    } catch (error) {
      attempts += 1
      if (attempts > REGISTER_RETRIES) {
        ctx.logger.warn(`oil-dsh-title: 无法注册标题提供者（是否有另一个标题插件仍在运行？）：${String(error?.message ?? error)}`)
        return
      }
      timer = setTimeout(attempt, REGISTER_RETRY_MS)
    }
  }
  attempt()
  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
  }, 'oil-dsh-title register retry')
}
