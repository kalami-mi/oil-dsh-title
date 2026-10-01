/**
 * bundle 装配测试：用 Harness 自带的 profile 装配器（dsh-app-boot）加载一个与桌面端同构的 profile
 * （dsh-base + dsh-web-app + 本插件），验证补丁语法、兼容性检查和最终组合。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeEntries, evaluatePluginCompatibility, getDshRuntimeVersion, loadProfileDirectory, readProfileManifest } from '@deepseek-ai/dsh-app-boot'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8'))

let profileDir
const install = (dir) => {
  // 和 scripts/pack.mjs 一样，只放 package.json 的 files 字段列出的内容。
  const target = join(dir, 'node_modules', manifest.name)
  mkdirSync(target, { recursive: true })
  for (const entry of ['package.json', ...manifest.files]) cpSync(join(root, entry), join(target, entry), { recursive: true })
}

before(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'oil-dsh-title-profile-'))
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name] } },
    }),
  )
  install(profileDir)
})
after(() => rmSync(profileDir, { recursive: true, force: true }))

const load = () => loadProfileDirectory('test', profileDir, join(root, 'package.json'), { userLayer: false })
const compose = (extra = []) => {
  const profile = load()
  const warnings = []
  const entries = composeEntries([...profile.layers.flatMap((layer) => layer.patches), ...extra], (line) => warnings.push(line))
  return { profile, entries, warnings }
}
const rowById = (entries, id) => entries.find((entry) => entry.id === id)

describe('bundle 装配（真实 profile 装配器）', () => {
  test('三个 bundle 全部加载，没有被跳过', () => {
    const profile = load()
    assert.deepEqual(profile.skippedBundles, [])
    assert.deepEqual(profile.layers.map((layer) => layer.packageName), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name])
  })

  test('兼容性检查通过：对 dsh 运行时版本没有不兼容的对等依赖', () => {
    const bundleManifest = readProfileManifest('test', join(profileDir, 'node_modules', manifest.name))
    assert.equal(evaluatePluginCompatibility(bundleManifest, {}), undefined)
    assert.match(getDshRuntimeVersion(), /^0\.2\./u)
  })

  test('内置的首条提示标题提供者被关闭，本插件条目被插入，且没有补丁警告', () => {
    const { entries, warnings } = compose()
    assert.deepEqual(warnings, [])
    const builtIn = rowById(entries, 'session-title-llm')
    assert.equal(builtIn.name, '@deepseek-ai/dsh-session-title-first-prompt-llm')
    assert.equal(builtIn.disabled, true)

    const ours = rowById(entries, 'oil-dsh-title')
    assert.equal(ours.name, 'oil-dsh-title')
    assert.notEqual(ours.disabled, true)
    assert.deepEqual(ours.config, {
      provider: '',
      model: '',
      recentTurns: 5,
      maxInputBytes: 16384,
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      maxConfirmationSkips: 2,
    })
  })

  test('标题服务本身仍启用；同一组合里只有一个未禁用的标题提供者', () => {
    const { entries } = compose()
    assert.notEqual(rowById(entries, 'session-title').disabled, true)
    const providers = entries.filter((entry) => /session-title.*(llm|provider)|oil-dsh-title/u.test(`${entry.id} ${entry.name}`) && entry.id !== 'session-title' && entry.disabled !== true)
    assert.deepEqual(providers.map((entry) => entry.id), ['oil-dsh-title'])
  })

  test('本插件在组合里排在标题服务之后（服务先于提供者出现）', () => {
    const { entries } = compose()
    assert.ok(entries.findIndex((entry) => entry.id === 'session-title') < entries.findIndex((entry) => entry.id === 'oil-dsh-title'))
  })

  test('用户自己的补丁层可以按 id 覆盖配置（整体替换 config，需重述保留的字段）', () => {
    const { entries } = compose([{ id: 'oil-dsh-title', config: { provider: 'r4-coder', model: 'deepseek-v4.1-flash', recentTurns: 3 } }])
    assert.deepEqual(rowById(entries, 'oil-dsh-title').config, { provider: 'r4-coder', model: 'deepseek-v4.1-flash', recentTurns: 3 })
  })

  test('用户可以用 disabled: true 一键停用本插件；此时应重新启用内置提供者', () => {
    const { entries } = compose([{ id: 'oil-dsh-title', disabled: true }, { id: 'session-title-llm', disabled: false }])
    assert.equal(rowById(entries, 'oil-dsh-title').disabled, true)
    assert.equal(rowById(entries, 'session-title-llm').disabled, false)
  })

  test('包内容干净：只带 files 字段列出的文件', async () => {
    const { readdirSync } = await import('node:fs')
    const names = readdirSync(join(profileDir, 'node_modules', manifest.name)).sort()
    assert.deepEqual(names, ['LICENSE', 'README.md', 'cordis.patch.yml', 'lib', 'package.json'])
  })
})
