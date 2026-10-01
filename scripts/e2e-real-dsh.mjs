// 真实端到端验证：用桌面端自带的 dsh 启动器（真实运行时解析、真实 profile 合成、真实智能体循环、
// 真实会话存储与标题服务、真实 llm-pi-ai 适配器）跑本插件，只把模型换成本机的假 OpenAI 兼容服务。
//
//   node scripts/e2e-real-dsh.mjs [--dsh "D:\DeepSeek Harness"] [--keep]
//
// 全程在临时目录里：独立的 DSH_HOME、独立的数据目录，不碰你真实的 ~/.dsh。
// 首次运行会把桌面端的 app.asar 解开（约 1.2 万个文件，几十秒），缓存在临时目录里，之后复用。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.indexOf(name)
const dshApp = flag('--dsh') >= 0 ? argv[flag('--dsh') + 1] : process.env.DSH_APP ?? 'D:\\DeepSeek Harness'
const keep = flag('--keep') >= 0
const work = join(tmpdir(), 'oil-dsh-title-e2e')
const runtime = join(work, 'runtime', 'dsh')
const home = join(work, 'home')
const dataDir = join(work, 'data')
const pkgOut = join(work, 'pkg')
const dshBin = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const step = (text) => console.log(`\n▶ ${text}`)

// ---------------------------------------------------------------- 1. 解出桌面端运行时
function extractRuntime() {
  const marker = join(work, 'runtime', '.done')
  const version = readFileSync(join(dshApp, 'version'), 'utf8').trim()
  if (existsSync(marker) && readFileSync(marker, 'utf8') === version) return console.log('  复用已解出的运行时', version)
  rmSync(join(work, 'runtime'), { recursive: true, force: true })
  const asar = readFileSync(join(dshApp, 'resources', 'app.asar'))
  const headerLength = asar.readUInt32LE(12)
  const header = JSON.parse(asar.subarray(16, 16 + headerLength).toString('utf8'))
  const base = 16 + headerLength
  let count = 0
  const walk = (node, path) => {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const full = `${path}/${name}`
      if (meta.files) walk(meta, full)
      else if (!meta.unpacked && full.startsWith('/dsh/') && !full.includes('libreoffice')) {
        const target = join(work, 'runtime', full)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, asar.subarray(base + Number(meta.offset), base + Number(meta.offset) + meta.size))
        count += 1
      }
    }
  }
  walk(header, '')
  cpSync(join(dshApp, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'), join(runtime, 'node_modules'), { recursive: true })
  writeFileSync(marker, version)
  console.log(`  已解出 ${count} 个文件（桌面端 ${version}）`)
}

// ---------------------------------------------------------------- 2. 假的 OpenAI 兼容服务
const modelRequests = []
function startFakeLlm() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let request = {}
      try {
        request = JSON.parse(body)
      } catch {}
      const messages = request.messages ?? []
      const system = JSON.stringify(messages.find((m) => m.role === 'system')?.content ?? '')
      const isTitle = system.includes('会话标题编辑器')
      let content = '好的，已经处理好了。'
      if (isTitle) {
        const raw = String(messages.at(-1)?.content ?? '')
        let payload = {}
        try {
          payload = JSON.parse(raw.split('\n').slice(1).join('\n'))
        } catch {}
        const turns = payload.recent_turns ?? []
        const all = turns.map((turn) => turn.user).join(' ')
        const hasReply = turns.some((turn) => turn.assistant)
        const want = /Orion/u.test(all) ? '🎬 Orion 评测视频｜标题策划' : hasReply ? '🧩 邮箱注册｜验证码过期时间修复' : '🧩 邮箱注册｜验证码修复'
        const keepIt = payload.current_title_source === 'named' && payload.current_title === want
        content = JSON.stringify(keepIt ? { action: 'keep', title: want, reason: '保留' } : { action: 'rename', title: want, reason: '假模型' })
        modelRequests.push({ title: true, max_tokens: request.max_tokens ?? request.max_completion_tokens, model: request.model, payload })
      } else modelRequests.push({ title: false })
      const usage = { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, prompt_tokens_details: { cached_tokens: 100 } }
      const chunk = { id: 'x', object: 'chat.completion.chunk', created: 1, model: request.model }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

// ---------------------------------------------------------------- 3. 安装到隔离 profile
function sh(args, env, label) {
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', cwd: root })
  if (result.status !== 0) throw new Error(`${label} 失败（退出码 ${result.status}）\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function main() {
  console.log(`桌面端：${dshApp}\n工作目录：${work}`)
  mkdirSync(work, { recursive: true })
  step('解出桌面端自带运行时')
  extractRuntime()

  step('打包并按绝对路径安装到隔离 profile（与桌面端“添加插件”同一套操作，pnpm 用桌面端自带的）')
  rmSync(home, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  sh([join(root, 'scripts', 'pack.mjs'), '--out', pkgOut], process.env, 'pack')
  const shim = join(work, 'shim')
  mkdirSync(shim, { recursive: true })
  const pnpmEntry = join(dshApp, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  writeFileSync(join(shim, 'pnpm.cmd'), `@echo off\r\nnode "${pnpmEntry}" %*\r\n`)
  writeFileSync(join(shim, 'pnpm'), `#!/bin/sh\nexec node "${pnpmEntry}" "$@"\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${shim}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, DSH_HOME: home, FAKE_KEY: 'x', OIL_DSH_TITLE_DATA: dataDir }
  sh([dshBin, '--profile', 'e2e', '--from-default-profile', 'sdk', '--dump-default-config'], env, '创建 profile')
  sh([dshBin, 'plugin', '--profile', 'e2e', 'add', join(pkgOut, 'oil-dsh-title')], env, '安装插件')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'e2e', 'package.json'), 'utf8'))
  check(manifest.dsh.profile.bundles.includes('oil-dsh-title'), '插件已被选为组合包', JSON.stringify(manifest.dsh.profile.bundles))

  const server = await startFakeLlm()
  const port = server.address().port
  writeFileSync(
    join(home, 'profiles', 'e2e', 'cordis.patch.yml'),
    `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: fake, model: fake-model }
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      fake:
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        models:
          - { id: fake-model, name: Fake, contextWindow: 100000 }
`,
  )

  step('真实合成：bundle 补丁生效')
  const dump = sh([dshBin, '--profile', 'e2e', '--dump-config'], env, '--dump-config')
  check(/- id: session-title-llm[\s\S]*?disabled: true/u.test(dump), '内置 session-title-llm 被关闭')
  check(/- id: oil-dsh-title\s+name: oil-dsh-title/u.test(dump), '本插件条目出现在真实组合里')
  const schema = spawnSync(process.execPath, [dshBin, '--profile', 'e2e', '--dump-config-schema'], { env, encoding: 'utf8', cwd: root, maxBuffer: 1 << 28 })
  check(schema.status === 0, '真实运行时解析下能导入本插件（--dump-config-schema）', schema.stderr.slice(0, 300))

  step('真实多轮对话（dsh sdk 进程 + 假模型）')
  const turns = ['帮我修复邮箱注册的验证码过期问题', '再补一个过期边界的测试', '好的', '收到', '先不做这个了，我想给 Orion 评测视频想几个标题', '谢谢']
  const child = spawn(process.execPath, [dshBin, '--profile', 'e2e'], { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const pending = new Map()
  const events = []
  let idle = []
  let buffer = ''
  let nextId = 0
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && !message.method) pending.get(message.id)?.(message)
      else if (message.method === 'session.event') events.push(message.params.event ?? message.params)
      else if (message.method === 'session.status' && (message.params.status === 'idle' || message.params.state === 'idle')) {
        idle.forEach((fn) => fn())
        idle = []
      }
    }
  })
  const call = (method, params) =>
    new Promise((done) => {
      const id = (nextId += 1)
      pending.set(id, done)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const init = await call('initialize', { cwd: root, provider: 'fake', model: 'fake-model' })
  check(Boolean(init.result), '真实 sdk 进程初始化成功', JSON.stringify(init.error))
  for (const text of turns) {
    const settled = new Promise((done) => idle.push(done))
    const reply = await call('session/prompt', { sessionId: 'e2e', contentBlocks: [{ type: 'text', text }] })
    if (reply.error) throw new Error(`prompt 失败：${JSON.stringify(reply.error)}`)
    await Promise.race([settled, sleep(20000)])
    await sleep(1500) // 命名是后台异步的：给它写完日志的时间
  }
  await call('shutdown', {})
  await sleep(300)
  child.kill()
  server.close()

  step('核对')
  const titleEvents = events.filter((event) => event.type === 'session/title').map((event) => event.data)
  const sequence = titleEvents.map((data) => `${data.source.kind}:${data.title}`)
  console.log('  标题序列：', sequence)
  check(titleEvents[0]?.source.kind === 'fallback', '先是宿主的占位标题（取自首条消息）')
  check(titleEvents.at(-1)?.title === '🎬 Orion 评测视频｜标题策划' && titleEvents.at(-1)?.source.provider === 'oil-dsh-title', '转向新主题后，最终标题由本插件更新为 Orion')
  check(titleEvents.some((data) => data.title === '🧩 邮箱注册｜验证码过期时间修复'), '首轮结束时带着回答重新判断过一次（早期标题只看过首条消息）')

  const titleCalls = modelRequests.filter((request) => request.title)
  const logFile = join(dataDir, 'logs', 'e2e.jsonl')
  const ledger = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  check(titleCalls.length > 0 && titleCalls.every((request) => request.max_tokens === 4096), '命名请求使用独立的输出上限（4096，给带思考的模型留空间）')
  check(titleCalls.every((request) => request.model === 'fake-model'), '命名请求沿用会话当前的模型路由（取自真实请求头）')
  check(ledger.filter((entry) => entry.model_called).length === titleCalls.length, `账实相符：假服务收到 ${titleCalls.length} 次命名请求，日志 model_called 也是 ${ledger.filter((entry) => entry.model_called).length} 次（含被取代而中止的）`)
  check(ledger.filter((entry) => entry.status === 'confirmation_skipped').length >= 3, '“好的/收到/谢谢”三次纯确认免调用', JSON.stringify(ledger.map((entry) => entry.status)))
  check(titleCalls.length <= 4, `6 轮对话只发了 ${titleCalls.length} 次命名请求（不是每轮一次）`)
  const finalized = ledger.find((entry) => entry.status === 'renamed' && entry.usage)
  check(finalized?.usage?.inputTokens === 800 && finalized.usage.cacheReadTokens === 100, '用量口径：prompt 900 含缓存 100 → 输入 800（未缓存）+ 缓存 100，与宿主一致', JSON.stringify(finalized?.usage))
  check(!/oil-dsh-title/u.test(stderr), '没有来自本插件的告警', stderr.slice(0, 400))
  const secretish = JSON.stringify(titleCalls.map((request) => request.payload))
  check(!secretish.includes(root.replaceAll('\\', '\\\\')), '发给模型的摘录里没有完整工作目录路径')

  // 解出的运行时是缓存（重解很慢），保留；本次的 profile、数据与打包产物清掉，除非 --keep。
  if (!keep) for (const dir of [home, dataDir, pkgOut]) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  else console.log(`\n已保留：${work}`)
  console.log(failures.length === 0 ? '\n全部通过' : `\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
