import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { ROUTE, createRig, decision, runCommand, settle, waitFor } from './harness.js'

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

/** 有一轮已完成对话、且已被自动命名的会话。 */
async function namedSession(rig) {
  const session = rig.newSession()
  rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
  await rig.runTurn(session, '修复邮箱注册验证码', '已修复。')
  await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
  return session
}

describe('/title 命令', () => {
  test('注册成功且出现在命令列表；组合里没有 commands 服务时插件仍可用', async () => {
    const rig = await make()
    const session = rig.newSession()
    assert.deepEqual(rig.ctx.commands.list({ id: 'a', session }).map((command) => command.name), ['title'])

    const bare = await make({ withCommands: false })
    const other = bare.newSession()
    bare.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await bare.runTurn(other, '修复邮箱注册验证码')
    await waitFor(() => titleOf(bare, other)?.source.kind === 'provider')
    assert.deepEqual(bare.warnings, [])
  })

  test('preview：给出候选但不写入、不推进状态，之后 now 仍会真正调用', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    const before = session.snapshotEvents().length
    rig.llm.reply(decision('rename', '🎬 Orion 评测视频｜标题策划'))
    const preview = await runCommand(rig, session, '/title preview')
    assert.equal(preview.kind, 'success')
    assert.ok(preview.text.includes('候选标题：🎬 Orion 评测视频｜标题策划'))
    assert.ok(preview.text.includes('当前：🧩 邮箱注册｜验证码修复'))
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    // 预览不写标题事件（命令自身的 run/done 生命周期事件除外）。
    const titleEvents = session.snapshotEvents().filter((event) => event.type === 'session/title')
    assert.equal(titleEvents.length, 2)
    assert.ok(session.snapshotEvents().length >= before)

    rig.llm.reply(decision('rename', '🎬 Orion 评测视频｜标题策划'))
    const now = await runCommand(rig, session, '/title now')
    assert.equal(now.kind, 'success')
    assert.equal(titleOf(rig, session).title, '🎬 Orion 评测视频｜标题策划')
  })

  test('now：内容没变也强制重新判断；模型认为准确则如实说明', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    const callsBefore = rig.llm.calls.length
    rig.llm.reply(decision('keep', '🧩 邮箱注册｜验证码修复'))
    const result = await runCommand(rig, session, '/title')
    assert.equal(rig.llm.calls.length, callsBefore + 1)
    assert.equal(result.kind, 'success')
    assert.ok(result.text.includes('仍然准确'))
  })

  test('now：模型故障用 error 结果报告，标题不变', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    rig.llm.reply(new Error('上游 502'))
    const result = await runCommand(rig, session, '/title now')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('失败'))
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
  })

  test('set：手动设置即固定，此后的自动命名不会覆盖', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    const result = await runCommand(rig, session, '/title set 我的季度复盘')
    assert.equal(result.kind, 'success')
    assert.equal(titleOf(rig, session).title, '我的季度复盘')
    assert.equal(titleOf(rig, session).source.kind, 'user')

    const callsBefore = rig.llm.calls.length
    rig.llm.reply(decision('rename', '🎬 不该覆盖｜手动标题'))
    await rig.runTurn(session, '一个全新的话题：给视频想标题', '好的。')
    await settle(30)
    assert.equal(rig.llm.calls.length, callsBefore)
    assert.equal(titleOf(rig, session).title, '我的季度复盘')

    const refused = await runCommand(rig, session, '/title now')
    assert.equal(refused.kind, 'error')
    assert.ok(refused.text.includes('固定'))
    assert.equal((await runCommand(rig, session, '/title set')).kind, 'error')
  })

  test('lock / unlock：固定当前自动标题；解除后恢复自动命名，即使模型认为无需更改也真正解除', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    assert.equal((await runCommand(rig, session, '/title lock')).kind, 'success')
    assert.equal(titleOf(rig, session).source.kind, 'user')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')
    assert.ok((await runCommand(rig, session, '/title lock')).text.includes('已经是固定'))

    rig.llm.reply(decision('keep', '🧩 邮箱注册｜验证码修复'))
    const unlocked = await runCommand(rig, session, '/title unlock')
    assert.equal(unlocked.kind, 'success', unlocked.text)
    assert.equal(titleOf(rig, session).source.kind, 'provider')
    assert.equal(titleOf(rig, session).title, '🧩 邮箱注册｜验证码修复')

    // 解除后，新的话题转向可以再次触发自动更新。
    rig.llm.reply(decision('rename', '🎬 Orion 评测视频｜标题策划'))
    await rig.runTurn(session, '换个话题：给 Orion 评测视频想标题', '好。')
    await waitFor(() => titleOf(rig, session).title === '🎬 Orion 评测视频｜标题策划')

    assert.ok((await runCommand(rig, session, '/title unlock')).text.includes('没有被固定'))
  })

  test('pause / resume：暂停后所有会话零调用；恢复后继续', async () => {
    const rig = await make()
    const session = rig.newSession()
    assert.equal((await runCommand(rig, session, '/title pause')).kind, 'success')

    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await settle(30)
    assert.equal(rig.llm.calls.length, 0)
    assert.equal(titleOf(rig, session).source.kind, 'fallback')
    assert.ok((await runCommand(rig, session, '/title status')).text.includes('已暂停'))

    assert.equal((await runCommand(rig, session, '/title resume')).kind, 'success')
    await rig.runTurn(session, '再补充一点：还要覆盖过期边界', '好。')
    await waitFor(() => titleOf(rig, session)?.source.kind === 'provider')
    assert.equal(rig.llm.calls.length, 1)
  })

  test('status：显示标题来源、最近一次结果与用量（缓存命中与未缓存输入分开列示）', async () => {
    const rig = await make()
    const session = await namedSession(rig)
    const status = await runCommand(rig, session, '/title status')
    assert.equal(status.kind, 'success')
    assert.ok(status.text.includes('🧩 邮箱注册｜验证码修复〔自动命名〕'))
    assert.ok(status.text.includes('renamed'))
    assert.ok(status.text.includes('累计模型调用：1 次，输入 120（未缓存）+ 缓存命中 40 / 输出 30 tokens'))
  })

  test('未知子命令给出用法', async () => {
    const rig = await make()
    const session = rig.newSession()
    const result = await runCommand(rig, session, '/title frobnicate')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('用法：/title'))
  })

  test('命名使用配置的模型，而不是硬编码', async () => {
    const rig = await make({ pluginConfig: { provider: 'r4-coder', model: 'deepseek-v4.1-flash' } })
    const session = rig.newSession()
    rig.llm.reply(decision('rename', '🧩 邮箱注册｜验证码修复'))
    await rig.runTurn(session, '修复邮箱注册验证码')
    await waitFor(() => rig.llm.calls.length === 1)
    assert.deepEqual([rig.llm.calls[0].options.provider, rig.llm.calls[0].options.model], ['r4-coder', 'deepseek-v4.1-flash'])
    assert.notEqual(rig.llm.calls[0].options.provider, ROUTE.provider)
  })
})
