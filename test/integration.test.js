import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { CWD, ROUTE, appendUser, createRig, decision, runCommand, settle, waitFor } from './harness.js'

const rigs = []
const make = async (options) => {
  const rig = await createRig(options)
  rigs.push(rig)
  return rig
}
afterEach(async () => {
  while (rigs.length > 0) await rigs.pop().dispose()
})

const titleOf = (rig, session) => rig.ctx.sessionTitle.get(session)
const titleEvents = (session) => session.snapshotEvents().filter((event) => event.type === 'session/title')
const logOf = (rig, id = 'session-1') =>
  readFileSync(join(rig.dataDir, 'logs', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

describe('每轮结束后的自动命名', () => {
  test('第一轮结束：占位标题被替换为「emoji 对象｜目标」，来源记为本插件', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题', '已经修复了过期时间的计算。')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider', { label: '标题写入' })

    const title = titleOf(rig, session)
    assert.equal(title.title, '🧩 邮箱注册｜验证码修复')
    assert.deepEqual(title.source, { kind: 'provider', provider: 'oil-dsh-title', model: ROUTE })
    assert.equal(rig.llm.calls.length, 1)
    assert.deepEqual(rig.warnings, [])
  })

  test('模型请求：只含摘录数据，助手回答作为上下文，使用命名专用的 purpose 与 system', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题', '已经修复了过期时间的计算。')
    await waitFor(() => rig.llm.calls.length === 1)

    const { options, text } = rig.llm.calls[0]
    assert.equal(options.purpose, 'session-title')
    assert.equal(options.sessionId, 'session-1')
    assert.deepEqual([options.provider, options.model], [ROUTE.provider, ROUTE.model])
    assert.equal(options.maxTokens, 4096)
    assert.ok(options.system.includes('会话标题编辑器'))
    const payload = JSON.parse(text.slice(text.indexOf('\n') + 1))
    assert.equal(payload.current_title_source, 'fallback')
    assert.equal(payload.recent_turns.length, 1)
    assert.equal(payload.recent_turns[0].user, '帮我修复邮箱注册的验证码过期问题')
    assert.equal(payload.recent_turns[0].assistant, '已经修复了过期时间的计算。')
    assert.equal(payload.project_hint, 'Maple')
    // 不发送完整路径。
    assert.ok(!text.includes(CWD))
  })

  test('标题稳定后模型说 keep：不写新事件，只推进基线', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'), decision('keep', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    const eventsBefore = titleEvents(session).length

    await rig.runTurn(session, '再补一个边界测试', '已补充。')
    await waitFor(() => rig.llm.calls.length === 2)
    await settle(20)
    assert.equal(titleEvents(session).length, eventsBefore)
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    assert.equal(logOf(rig).at(-1).status, 'kept')
  })

  test('明确转向新工作：更新标题；请求里带上最近几轮并标出当前标题', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'), decision('rename', '🎬 Orion 评测视频｜标题策划'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')

    await rig.runTurn(session, '先不做这个了，我想给 Orion 评测视频想几个标题', '可以从三个角度切入……')
    await waitFor(() => titleOf(rig, session)?.title === '🎬 Orion 评测视频｜标题策划')

    const payload = JSON.parse(rig.llm.calls[1].text.slice(rig.llm.calls[1].text.indexOf('\n') + 1))
    assert.equal(payload.current_title, '🧩 邮箱注册｜验证码修复')
    assert.equal(payload.current_title_source, 'named')
    assert.equal(payload.recent_turns.length, 2)
    assert.equal(payload.original_goal, '帮我修复邮箱注册的验证码过期问题')
  })

  test('只看最近 recentTurns 轮', async () => {
    const rig = await make({ pluginConfig: { ...ROUTE, recentTurns: 2 } })
    const session = rig.newSession()
    rig.llm.reply(decision('keep', ''))
    for (const text of ['第一件事情', '第二件事情', '第三件事情']) appendUser(session, text)
    // 直接触发一次刷新，避免逐轮调用干扰断言。
    await rig.ctx.sessionTitle.refresh(session).catch(() => {})
    const payload = JSON.parse(rig.llm.calls[0].text.slice(rig.llm.calls[0].text.indexOf('\n') + 1))
    assert.deepEqual(payload.recent_turns.map((turn) => turn.user), ['第二件事情', '第三件事情'])
    assert.equal(payload.original_goal, '第一件事情')
  })

  test('外层项目名（工作目录末级）重复出现在标题开头时被去掉', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 Maple 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修一下 Maple 的邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
  })
})

describe('首条消息：标题服务自动触发', () => {
  const requestHeader = (session) => session.append('request/header', { header: { config: { ...ROUTE } }, reason: 'initial' })

  test('主请求的请求头写入后启动提供者：早期标题只基于首条消息；首轮回答出来后带着回答再判断一次，之后不再重复', async () => {
    const rig = await make({ pluginConfig: {} })
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'), decision('rename', '🧩 邮箱注册｜验证码过期时间修复'))

    appendUser(session, '帮我修复邮箱注册的验证码过期问题')
    requestHeader(session)
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider', { label: '首条消息触发的早期标题' })
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    assert.equal(rig.llm.calls.length, 1)
    // 路由取自刚写入的请求头。
    assert.deepEqual([rig.llm.calls[0].options.provider, rig.llm.calls[0].options.model], [ROUTE.provider, ROUTE.model])
    const early = JSON.parse(rig.llm.calls[0].text.slice(rig.llm.calls[0].text.indexOf('\n') + 1))
    assert.equal('assistant' in early.recent_turns[0], false, '早期标题时助手还没有回答')

    // 回答出来、轮次结束：带着回答再判断一次。
    const { appendAssistant } = await import('./harness.js')
    session.append('turn/start', { turn: 1 })
    appendAssistant(session, 1, '已经把验证码过期时间的计算修好了。')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await waitFor(() => titleOf(rig, session)?.title === '🧩 邮箱注册｜验证码过期时间修复', { label: '轮次结束后的二次判断' })
    assert.equal(rig.llm.calls.length, 2)
    const later = JSON.parse(rig.llm.calls[1].text.slice(rig.llm.calls[1].text.indexOf('\n') + 1))
    assert.equal(later.recent_turns[0].assistant, '已经把验证码过期时间的计算修好了。')
    assert.equal(later.current_title_source, 'named')

    // 内容没再变：不会无限重复。
    const outcome = await rig.ctx.sessionTitle.refresh(session).then(() => 'renamed', (error) => error.status)
    assert.equal(outcome, 'unchanged')
    assert.equal(rig.llm.calls.length, 2)
    assert.deepEqual(logOf(rig).map((entry) => entry.status), ['renamed', 'renamed'])
    assert.deepEqual(rig.warnings, [])
  })

  test('首条只有问候：零调用，标题服务会在自己的日志里记一条 greeting 告警（已知、无害）', async () => {
    const rig = await make({ pluginConfig: {} })
    const session = rig.newSession()
    appendUser(session, '你好')
    requestHeader(session)
    await waitFor(() => rig.warnings.length > 0, { label: '服务的跳过告警' })
    assert.equal(rig.llm.calls.length, 0)
    assert.ok(rig.warnings[0].includes('greeting'))
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
  })
})

describe('不该调用模型的时候不调用', () => {
  test('内容没有变化：再次刷新是零调用', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(rig.llm.calls.length, 1)

    const result = await rig.ctx.sessionTitle.refresh(session).then(() => 'ok', (error) => error.status)
    assert.equal(result, 'unchanged')
    assert.equal(rig.llm.calls.length, 1)
  })

  test('稳定标题后的纯确认免调用，最多连续 2 轮，第 3 轮重新判断', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'), decision('keep', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')

    await rig.runTurn(session, '好的')
    await rig.runTurn(session, '收到！')
    await settle(20)
    assert.equal(rig.llm.calls.length, 1, '两轮确认不应调用模型')

    await rig.runTurn(session, 'ok')
    await waitFor(() => rig.llm.calls.length === 2, { label: '第三轮确认重新判断' })
    assert.deepEqual(logOf(rig).map((entry) => entry.status), ['renamed', 'confirmation_skipped', 'confirmation_skipped', 'kept'])
  })

  test('确认前漏处理了实质轮次：不能被确认过滤器绕过', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'), decision('rename', '🧩 邮箱注册｜验证码与登录修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')

    // 一轮实质需求没有触发评估（例如当时暂停了），随后来了一句确认。
    rig.ctx.get('sessionTitle')
    const state = JSON.parse(readFileSync(join(rig.dataDir, 'sessions', 'session-1.json'), 'utf8'))
    appendUser(session, '顺便把登录也一起改了')
    appendUser(session, '好的')
    const outcome = await rig.ctx.sessionTitle.refresh(session).then(() => 'renamed', (error) => error.status)
    assert.equal(outcome, 'renamed')
    assert.equal(rig.llm.calls.length, 2)
    assert.equal(state.evaluatedThrough < session.snapshotEvents().at(-1).seq, true)
  })

  test('只有问候的开场：零调用', async () => {
    const rig = await make()
    const session = rig.newSession()
    await rig.runTurn(session, '你好', '你好，有什么可以帮你？')
    await settle(20)
    assert.equal(rig.llm.calls.length, 0)
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
    assert.equal(logOf(rig).at(-1).status, 'greeting')
  })

  test('子会话（subagent）与非正常结束的轮次：零调用', async () => {
    const rig = await make()
    const child = rig.ctx.sessions.create('child-1', { meta: { cwd: CWD, parentSession: 'session-1' } })
    await rig.runTurn(child, '子任务：读取所有测试文件')
    await settle(20)
    assert.equal(rig.llm.calls.length, 0)

    const session = rig.newSession()
    await rig.runTurn(session, '修复验证码', '（中断）', { end: 'aborted' })
    await rig.runTurn(session, '修复验证码2', '（出错）', { end: 'error' })
    await settle(20)
    assert.equal(rig.llm.calls.length, 0)
  })
})

describe('手动标题保护（宿主的 user 来源）', () => {
  test('用户改名后，之后的每一轮都不会被覆盖，也不调用模型', async () => {
    const rig = await make()
    const session = rig.newSession()
    await rig.runTurn(session, '你好')
    rig.ctx.sessionTitle.rename(session, '我的专属标题')
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))

    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题', '好。')
    await rig.runTurn(session, '再来一个需求', '好。')
    await settle(30)
    assert.equal(rig.llm.calls.length, 0)
    assert.equal(titleOf(rig, session).title, '我的专属标题')
    assert.equal(titleOf(rig, session).source.kind, 'user')
  })

  test('任何调用方直接调用宿主的 refresh 也不能覆盖固定的标题：零调用', async () => {
    const rig = await make()
    const session = rig.newSession()
    await rig.runTurn(session, '你好')
    rig.ctx.sessionTitle.rename(session, '我的专属标题')
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    appendUser(session, '帮我修复邮箱注册的验证码过期问题')

    const outcome = await rig.ctx.sessionTitle.refresh(session).then(() => 'renamed', (error) => error.status)
    assert.equal(outcome, 'manual_title')
    assert.equal(rig.llm.calls.length, 0)
    assert.equal(titleOf(rig, session).title, '我的专属标题')
    assert.equal(titleOf(rig, session).source.kind, 'user')
  })

  test('生成期间被 /title pause 暂停：结果作废', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.delayMs = 500
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题')
    await waitFor(() => rig.llm.calls.length === 1)
    assert.equal((await runCommand(rig, session, '/title pause')).kind, 'success')
    await waitFor(() => existsLog(rig, 'paused'), { timeoutMs: 3000, label: '作废日志 paused' })
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
  })

  test('在途的命名被更新的一次取代：记账为 aborted（调用过、用量未知），统计里计入未知而不是消失', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.delayMs = 400
    rig.llm.reply(decision('rename', '🧩 旧｜被取代'), decision('rename', '🧩 邮箱注册｜验证码修复'))
    appendUser(session, '修复邮箱注册验证码')
    const first = rig.ctx.sessionTitle.refresh(session).catch(() => {})
    await waitFor(() => rig.llm.calls.length === 1)
    rig.llm.delayMs = 0
    // 更新的一次刷新取代在途的那次。
    await rig.ctx.sessionTitle.refresh(session)
    await first
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    assert.deepEqual(logOf(rig).map((entry) => entry.status).sort(), ['aborted', 'renamed'])
    const { Store } = await import('../lib/store.js')
    const summary = new Store(rig.dataDir).usageSummary()
    assert.equal(summary.calls, 2)
    assert.equal(summary.unknown, 1)
  })

  test('生成期间用户改了名：结果作废', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.delayMs = 500
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '帮我修复邮箱注册的验证码过期问题')
    await waitFor(() => rig.llm.calls.length === 1)
    rig.ctx.sessionTitle.rename(session, '用户抢先改的名')
    // 宿主在用户改名时会先中止进行中的命名请求：既保护了标题，也省下了这次调用的 token。
    assert.equal(rig.llm.calls[0].options.signal.aborted, true, '用户改名应立即中止进行中的命名请求')
    // 等到原本模型会返回的时间之后，确认没有任何写入或错误记录。
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(titleOf(rig, session).title, '用户抢先改的名')
    assert.equal(titleOf(rig, session).source.kind, 'user')
    assert.equal(titleEvents(session).filter((event) => event.data.source.kind === 'provider').length, 0)
    assert.equal(existsLog(rig, 'renamed'), false)
    assert.equal(existsLog(rig, 'error'), false)
    assert.deepEqual(rig.warnings, [])
    // 请求已经发出、可能已计费：必须记账为“调用过、用量未知”，而不是凭空消失。
    const aborted = logOf(rig).filter((entry) => entry.status === 'aborted')
    assert.equal(aborted.length, 1)
    assert.equal(aborted[0].model_called, true)
    assert.equal(aborted[0].usage, undefined)
  })
})

describe('模型输出不合规', () => {
  test('结构错误：带原因追问一次，第二次合规则采用', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册验证码修复'), decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    assert.equal(rig.llm.calls.length, 2)
    assert.ok(rig.llm.calls[1].text.includes('必须包含全角分隔符'))
  })

  test('两次都不合规：保留原标题、记录 invalid_output，不再继续付费', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '没有emoji也没有分隔符'), decision('rename', '🧩 还是没有分隔符'), decision('rename', '🧩 第三次｜不该被请求'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => logOf(rig).some((entry) => entry.status === 'invalid_output'))
    assert.equal(rig.llm.calls.length, 2)
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
    assert.equal(titleEvents(session).length, 1)
  })

  test('不是 JSON 的输出：追问一次', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply('我觉得标题可以叫邮箱注册', decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(rig.llm.calls.length, 2)
  })

  test('对占位标题说 keep：追问一次要求给出正式标题', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('keep', ''), decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(rig.llm.calls.length, 2)
    assert.ok(rig.llm.calls[1].text.includes('占位标题'))
  })

  test('标题里出现邮箱等私人信息：视为不合规', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 me@example.com｜验证码'), decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
  })
})

describe('故障：保留原标题，不影响对话', () => {
  test('模型报错：记录 model_error，标题不变，无未处理拒绝', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(new Error('上游 502'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => existsLog(rig, 'model_error'))
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
    assert.equal(logOf(rig).at(-1).detail, '上游 502')
  })

  test('带思考的模型触顶：思考吃光预算（无文本）算失败并提示调大上限；已有完整文本则照常采用', async () => {
    const truncated = (blocks) => ({
      chunks: [
        ...blocks,
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 4096 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    })
    const thinking = [
      { type: 'reasoning-delta', index: 0, text: '思考……' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考……' } },
    ]
    const answer = (text) => [
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
    ]

    const rig = await make()
    const session = rig.newSession()
    rig.llm.reply(truncated(thinking))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => existsLog(rig, 'model_error'))
    assert.ok(logOf(rig).at(-1).detail.includes('maxOutputTokens'))
    assert.equal(titleOf(rig, session).source.kind, 'fallback')

    rig.llm.reply(truncated([...thinking, ...answer(decision('rename', '🧩 邮箱注册｜验证码修复'))]))
    await rig.runTurn(session, '再补一条要求', '好。')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
  })

  test('超时：记录 timeout，标题不变', async () => {
    const rig = await make({ pluginConfig: { ...ROUTE, timeoutMs: 30 } })
    const session = rig.newSession()
    rig.llm.delayMs = 500
    rig.llm.reply(decision('rename', '🧩 不该采用｜迟到的结果'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => existsLog(rig, 'timeout'), { timeoutMs: 2000 })
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
  })

  test('生成期间又来了新的用户消息：本次结果作废，等下一轮', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.delayMs = 500
    rig.llm.reply(decision('rename', '🧩 旧主线｜不该被采用'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => rig.llm.calls.length === 1)
    appendUser(session, '换个话题，聊聊部署')
    await waitFor(() => existsLog(rig, 'stale_result'), { timeoutMs: 3000, label: '作废日志 stale_result' })
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
  })

  test('插件卸载时取消进行中的命名：不写标题、不告警', async () => {
    const rig = await make()
    const session = rig.newSession()
    rig.llm.delayMs = 600
    rig.llm.reply(decision('rename', '🧩 不该写入｜卸载后'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => rig.llm.calls.length === 1)
    rig.fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
    assert.deepEqual(rig.warnings, [])
  })

  test('没有可用路由：写日志并告警，而不是静默', async () => {
    const rig = await make({ pluginConfig: {} })
    const session = rig.newSession()
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => existsLog(rig, 'no_route'))
    assert.ok(rig.warnings.some((line) => line.includes('命名模型路由')))
    assert.equal(rig.llm.calls.length, 0)
  })

  test('路由取自会话最近一次请求头（配置留空时）', async () => {
    const rig = await make({ pluginConfig: {} })
    const session = rig.newSession()
    session.append('request/header', { header: { config: { provider: 'from-header', model: 'header-model' } }, reason: 'initial' })
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.deepEqual([rig.llm.calls[0].options.provider, rig.llm.calls[0].options.model], ['from-header', 'header-model'])
  })
})

describe('永不拖垮宿主启动', () => {
  const fakeLogger = () => {
    const warnings = []
    return { warnings, warn: (message) => warnings.push(String(message)) }
  }

  test('依赖服务缺失或损坏时，apply 不抛出，只告警', async () => {
    const { apply } = await import('../lib/index.js')
    const logger = fakeLogger()
    const broken = {
      logger,
      get llm() { throw new Error('llm 服务炸了') },
      get sessionTitle() { throw new Error('sessionTitle 服务炸了') },
      on: () => { throw new Error('on 炸了') },
      inject: () => {},
      effect: () => {},
    }
    assert.doesNotThrow(() => apply(broken, { ...ROUTE }))
    assert.equal(logger.warnings.length, 1)
    assert.ok(logger.warnings[0].includes('启动失败'))
  })

  test('配置是垃圾值也不抛出，退回默认', async () => {
    const { normalizeOptions } = await import('../lib/index.js')
    for (const config of [undefined, null, 7, 'x', [], { recentTurns: -1, timeoutMs: 'x', maxOutputTokens: 1.5, provider: 5, model: {} }]) {
      assert.doesNotThrow(() => normalizeOptions(config), String(config))
    }
    const options = normalizeOptions({ recentTurns: -1, timeoutMs: 'x', maxOutputTokens: 1.5, provider: 'only-provider' })
    assert.equal(options.recentTurns, 5)
    assert.equal(options.timeoutMs, 60000)
    assert.equal(options.maxOutputTokens, 4096)
    assert.equal(options.provider, '')
  })

  test('轮次结束处理器遇到畸形会话或事件也不抛出', async () => {
    const { apply } = await import('../lib/index.js')
    const logger = fakeLogger()
    let handler
    const ctx = {
      logger,
      llm: {},
      sessionTitle: { register: () => {}, get: () => { throw new Error('读标题炸了') } },
      on: (name, fn) => { if (name === 'session/event') handler = fn },
      inject: () => {},
      effect: () => {},
    }
    apply(ctx, { ...ROUTE })
    assert.equal(typeof handler, 'function')
    assert.doesNotThrow(() => handler({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } }))
    assert.doesNotThrow(() => handler(undefined, { type: 'turn/end' }))
    assert.doesNotThrow(() => handler({ header: {} }, { type: 'user/message' }))
    await settle(10)
  })

  test('/title 命令注册失败只告警，自动命名照常工作', async () => {
    const rig = await make({ mountPlugin: false })
    const original = rig.ctx.commands.register.bind(rig.ctx.commands)
    rig.ctx.commands.register = () => { throw new Error('命名冲突') }
    await rig.mount()
    rig.ctx.commands.register = original
    assert.ok(rig.warnings.some((line) => line.includes('/title 命令注册失败')))

    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
  })
})

describe('热重载与挂载顺序', () => {
  test('卸载后干净：提供者与 /title 都被注销；再次挂载可以正常工作', async () => {
    const rig = await make()
    const session = rig.newSession()
    assert.ok(rig.ctx.sessionTitle.registration)
    assert.deepEqual(rig.ctx.commands.list({ id: 'a', session }).map((command) => command.name), ['title'])

    rig.fiber.dispose()
    await settle(20)
    assert.equal(rig.ctx.sessionTitle.registration, undefined)
    assert.deepEqual(rig.ctx.commands.list({ id: 'a', session }).map((command) => command.name), [])

    await rig.mount()
    assert.deepEqual(rig.ctx.commands.list({ id: 'a', session }).map((command) => command.name), ['title'])
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.deepEqual(rig.warnings, [])
  })

  test('内置提供者还没卸载完时注册被拒：稍后自动重试成功，期间不告警、不崩溃', async () => {
    const rig = await make({ mountPlugin: false })
    const releaseBuiltIn = rig.ctx.sessionTitle.register({ id: 'session-title-first-prompt-llm', automatic: 'first-prompt', generate: async () => { throw new Error('内置提供者不该被调用') } })
    await rig.mount()
    assert.equal(rig.ctx.sessionTitle.registration.provider.id, 'session-title-first-prompt-llm')
    assert.deepEqual(rig.warnings, [])

    releaseBuiltIn()
    await waitFor(() => rig.ctx.sessionTitle.registration?.provider.id === 'oil-dsh-title', { timeoutMs: 3000, label: '重试后注册成功' })

    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.deepEqual(rig.warnings, [])
  })
})

const existsLog = (rig, status) => {
  try {
    return logOf(rig).some((entry) => entry.status === status)
  } catch {
    return false
  }
}
