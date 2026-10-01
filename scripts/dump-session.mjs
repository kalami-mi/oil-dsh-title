// 读取 Harness 的会话日志（zstd 分帧的 jsonl）并打印标题等关键事件，用来核对真实事件格式。
//   node scripts/dump-session.mjs <session.v4.jsonl.zstd 的路径>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const f = process.argv[2]
if (!f) throw new Error('用法：node scripts/dump-session.mjs <session.v4.jsonl.zstd>')
const b = readFileSync(f); const idx = []
for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) idx.push(i)
let raw = ''; idx.forEach((s, k) => { try { raw += zstdDecompressSync(b.subarray(s, idx[k + 1] ?? b.length)).toString('utf8') } catch {} })
const ev = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.seq !== undefined)
for (const e of ev) {
  if (/delivery|inbox|system\/message|request\/context|permission|sandbox|approval/.test(e.type)) continue
  const d = e.type === 'session/title' ? JSON.stringify(e.data) : e.type === 'turn/end' ? JSON.stringify(e.data) : ''
  console.log(e.seq, e.type, d.slice(0, 260))
}
