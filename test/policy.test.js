import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  charLength,
  clip,
  isGreetingOnly,
  isPureAcknowledgement,
  projectHint,
  stripOuterProjectPrefix,
  validateTitle,
} from '../lib/policy.js'

test('合规标题原样通过，并规整空白', () => {
  for (const title of ['🧩 邮箱验证码｜过期排查', '🎬 图像模型评测｜视频策划', '🎨 登录表单｜布局优化', '🧩 Email verification｜Fix expiry']) {
    const result = validateTitle(title)
    assert.equal(result.ok, true, title)
    assert.equal(result.title, title)
  }
  assert.equal(validateTitle('  🧩   邮箱验证码｜过期排查  ').title, '🧩 邮箱验证码｜过期排查')
})

test('⚙️ 有无变体选择符都接受，输出规范写法', () => {
  const withSelector = validateTitle('⚙️ Node 环境｜安装配置')
  const bare = validateTitle('⚙ Node 环境｜安装配置')
  assert.equal(withSelector.ok, true)
  assert.equal(bare.ok, true)
  assert.equal(withSelector.title, bare.title)
  assert.ok(withSelector.title.startsWith('⚙️ '))
})

test('结构违规逐项拒绝', () => {
  const cases = {
    '邮箱验证码｜过期排查': 'bad-emoji',
    '🛠️ 邮箱注册修复': 'bad-emoji',
    '🧩邮箱验证码｜过期排查': 'missing-space',
    '🧩 邮箱验证码过期排查': 'missing-separator',
    '🧩 邮箱验证码|过期排查': 'ascii-separator',
    '🧩 邮箱｜验证码｜过期': 'many-separators',
    '🧩 ｜过期排查': 'empty-part',
    '🧩 邮箱验证码｜': 'empty-part',
    '🧩 邮箱验证码 ｜过期排查': 'spaces-around-separator',
    '🧩 邮箱验证码｜ 过期排查': 'spaces-around-separator',
    '🧩 邮箱🎬验证码｜过期排查': 'extra-emoji',
    '': 'empty',
  }
  for (const [title, reason] of Object.entries(cases)) {
    const result = validateTitle(title)
    assert.equal(result.ok, false, title)
    assert.equal(result.reason, reason, title)
  }
  assert.equal(validateTitle(undefined).reason, 'not-string')
})

test('超过 48 个字符拒绝，按码点而不是 UTF-16 单元计数', () => {
  const ok = `🧩 ${'字'.repeat(20)}｜${'目'.repeat(20)}` // 2 + 20 + 1 + 20 = 43
  assert.equal(validateTitle(ok).ok, true)
  assert.equal(charLength('🧩 字'), 3)
  const tooLong = `🧩 ${'字'.repeat(30)}｜${'目'.repeat(20)}`
  assert.equal(validateTitle(tooLong).reason, 'too-long')
})

test('邮箱、链接、路径、长数字串不允许出现在标题里', () => {
  for (const title of [
    '🧩 admin@example.com｜验证码',
    '🔎 https://example.com｜调研',
    '🧩 C:\\Users\\me｜路径整理',
    '🧩 订单 13800138000｜排查',
    '⚙️ sk-abcdefgh12345｜密钥配置',
  ]) {
    assert.equal(validateTitle(title).reason, 'sensitive', title)
  }
})

test('纯确认：只有确认词（可带语气词、标点、表情）才算', () => {
  for (const text of ['好的', '好的。', '收到！', 'OK', 'ok?', 'Thanks!', 'thank you', '继续', '👍', '嗯嗯', 'Got it', '  好  ']) {
    assert.equal(isPureAcknowledgement(text), true, text)
  }
  for (const text of ['好的，再把登录页也改一下', '继续修复验证码过期的问题', '推送', '提交', 'ok but add tests', '', '   ', '为什么']) {
    assert.equal(isPureAcknowledgement(text), false, text)
  }
})

test('“推送”“修复”等动作词不会被当成确认', () => {
  for (const text of ['推送', '提交一下', '修复', 'push it']) assert.equal(isPureAcknowledgement(text), false, text)
})

test('问候', () => {
  for (const text of ['你好', '你好！', 'Hello', 'hi', '在吗?']) assert.equal(isGreetingOnly(text), true, text)
  for (const text of ['你好，帮我看一下这个报错', 'hello world 程序怎么写']) assert.equal(isGreetingOnly(text), false, text)
})

test('外层项目名：工作目录末级为弱线索，通用目录与主目录不算', () => {
  assert.equal(projectHint('C:\\Users\\me\\Documents\\Maple', 'C:\\Users\\me'), 'Maple')
  assert.equal(projectHint('/home/me/code/maple-pay/', '/home/me'), 'maple-pay')
  assert.equal(projectHint('C:\\Users\\me', 'C:\\Users\\me'), '')
  assert.equal(projectHint('C:\\Users\\me\\Documents', 'C:\\Users\\me'), '')
  assert.equal(projectHint('C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace', 'C:\\Users\\me'), '')
  assert.equal(projectHint('C:\\', undefined), '')
  assert.equal(projectHint(undefined, undefined), '')
})

test('去掉重复的外层项目前缀：只处理完整词，不截断不同名字', () => {
  assert.equal(stripOuterProjectPrefix('🧩 Maple 邮箱注册｜验证码修复', 'Maple'), '🧩 邮箱注册｜验证码修复')
  assert.equal(stripOuterProjectPrefix('🧩 maple-邮箱注册｜验证码修复', 'Maple'), '🧩 邮箱注册｜验证码修复')
  assert.equal(stripOuterProjectPrefix('🧩 MaplePay 回调｜重复发货修复', 'Maple'), '🧩 MaplePay 回调｜重复发货修复')
  // 剥掉后对象为空时保持原样。
  assert.equal(stripOuterProjectPrefix('🧩 Maple｜整体重构', 'Maple'), '🧩 Maple｜整体重构')
  // 没有线索或标题不合规时原样返回。
  assert.equal(stripOuterProjectPrefix('🧩 邮箱注册｜修复', ''), '🧩 邮箱注册｜修复')
  assert.equal(stripOuterProjectPrefix('随便什么', 'Maple'), '随便什么')
})

test('clip 头尾保留，长度受控', () => {
  assert.equal(clip('短文本', 10), '短文本')
  const clipped = clip('开头'.repeat(50) + '中间'.repeat(500) + '结尾'.repeat(50), 100)
  assert.ok(charLength(clipped) <= 104)
  assert.ok(clipped.startsWith('开头'))
  assert.ok(clipped.endsWith('结尾'))
})
