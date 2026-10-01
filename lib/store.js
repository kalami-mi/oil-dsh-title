/**
 * 数据目录：配置、每会话状态与简短日志。全部同步小文件，任何失败都只吞掉——
 * 记账写不进去不能影响命名，更不能影响对话。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_MAX_BYTES = 96 * 1024
const LOG_KEEP_LINES = 200

/** 解析数据目录：OIL_DSH_TITLE_DATA > $DSH_HOME/oil-dsh-title > ~/.dsh/oil-dsh-title（空白的 DSH_HOME 与宿主一样视为未设置）。 */
export function resolveDataDir(env = process.env, home = homedir()) {
  if (env.OIL_DSH_TITLE_DATA) return env.OIL_DSH_TITLE_DATA
  const dshHome = env.DSH_HOME?.trim()
  return join(dshHome ? dshHome : join(home, '.dsh'), 'oil-dsh-title')
}

/** 会话 id 直接做文件名；不安全的 id 退回哈希，避免路径穿越。 */
export function safeName(id) {
  return /^[\w.-]{1,120}$/u.test(id) && !id.includes('..') ? id : createHash('sha256').update(id).digest('hex').slice(0, 32)
}

const DEFAULT_CONFIG = Object.freeze({ enabled: true })

export class Store {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir
  }

  #ensure(sub) {
    const target = sub ? join(this.dir, sub) : this.dir
    mkdirSync(target, { recursive: true })
    return target
  }

  #writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }

  /** 读取配置；文件缺失或损坏时用默认值，未知字段原样保留。 */
  readConfig() {
    try {
      const value = JSON.parse(readFileSync(join(this.dir, 'config.json'), 'utf8'))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ...DEFAULT_CONFIG, ...value }
    } catch {
      // 缺失即默认。
    }
    return { ...DEFAULT_CONFIG }
  }

  /** @returns {boolean} 是否写入成功 */
  writeConfig(patch) {
    try {
      const next = { ...this.readConfig(), ...patch }
      this.#ensure()
      this.#writeAtomic(join(this.dir, 'config.json'), `${JSON.stringify(next, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  }

  readState(sessionId) {
    try {
      const value = JSON.parse(readFileSync(join(this.dir, 'sessions', `${safeName(sessionId)}.json`), 'utf8'))
      if (value !== null && typeof value === 'object') return value
    } catch {
      // 首次接触。
    }
    return {}
  }

  writeState(sessionId, state) {
    try {
      const dir = this.#ensure('sessions')
      this.#writeAtomic(join(dir, `${safeName(sessionId)}.json`), `${JSON.stringify(state, null, 2)}\n`)
    } catch {
      // 状态写不进去时，下一轮会重新评估，代价是多一次模型调用，不影响正确性。
    }
  }

  /** 追加一条日志；只记状态、标题、简短理由与用量，不记对话原文。 */
  log(sessionId, record) {
    try {
      const dir = this.#ensure('logs')
      const file = join(dir, `${safeName(sessionId)}.jsonl`)
      appendFileSync(file, `${JSON.stringify({ time: Math.floor(Date.now() / 1000), ...record })}\n`, 'utf8')
      if (statSync(file).size > LOG_MAX_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        this.#writeAtomic(file, `${lines.slice(-LOG_KEEP_LINES).join('\n')}\n`)
      }
    } catch {
      // 日志是诊断辅助。
    }
  }

  /** 最近一条日志，供 /title status 展示。 */
  lastLog(sessionId) {
    try {
      const lines = readFileSync(join(this.dir, 'logs', `${safeName(sessionId)}.jsonl`), 'utf8').split('\n').filter(Boolean)
      return JSON.parse(lines[lines.length - 1])
    } catch {
      return undefined
    }
  }

  /** 汇总所有日志里的模型用量。口径同宿主：inputTokens 是未缓存输入，cacheReadTokens 另计，不含在输入内。 */
  usageSummary() {
    const total = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, unknown: 0, skippedByFilter: 0 }
    let files = []
    try {
      files = readdirSync(join(this.dir, 'logs'))
    } catch {
      return total
    }
    for (const name of files) {
      let lines = []
      try {
        lines = readFileSync(join(this.dir, 'logs', name), 'utf8').split('\n').filter(Boolean)
      } catch {
        continue
      }
      for (const line of lines) {
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.status === 'confirmation_skipped') total.skippedByFilter += 1
        if (!entry.model_called) continue
        total.calls += 1
        if (entry.usage && typeof entry.usage.inputTokens === 'number') {
          total.inputTokens += entry.usage.inputTokens
          total.outputTokens += entry.usage.outputTokens ?? 0
          total.cacheReadTokens += entry.usage.cacheReadTokens ?? 0
        } else {
          total.unknown += 1
        }
      }
    }
    return total
  }
}
