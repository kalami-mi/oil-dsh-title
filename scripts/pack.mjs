// 生成干净的安装目录：只含 package.json 的 files 字段列出的内容，不带开发用的 node_modules。
// 默认输出到 dist/oil-dsh-title；可用 --out <目录> 指定父目录（会在其下创建 oil-dsh-title）。
// Harness 的插件管理器按绝对路径安装这个目录，安装结果是指向它的链接（pnpm link:），
// 所以安装后不要移动或删除它；重新打包会原地更新，重启桌面端后生效。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outIndex = process.argv.indexOf('--out')
const base = outIndex > 0 ? resolve(process.argv[outIndex + 1] ?? '') : join(root, 'dist')
if (outIndex > 0 && !process.argv[outIndex + 1]) throw new Error('--out 需要一个目录')
const target = join(base, manifest.name)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

for (const entry of ['package.json', ...manifest.files]) {
  const from = join(root, entry)
  if (!existsSync(from)) throw new Error(`package.json 的 files 列出了不存在的 ${entry}`)
  cpSync(from, join(target, entry), { recursive: true })
}

console.log(`已生成安装目录（${manifest.name}@${manifest.version}）：`)
console.log(target)
