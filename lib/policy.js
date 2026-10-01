/**
 * 命名策略里可以确定性判断的部分：标题结构校验、纯确认过滤、外层项目名去重。
 * 语义判断（主线是否变化、用哪种语言）交给命名模型，这里不猜。
 */

/** 策略版本。提示词或校验规则的语义变化时递增，让下次正常检查重新判断，但不批量改历史会话。 */
export const POLICY_VERSION = 1

/** 固定的类别 emoji；⚙️ 带变体选择符，比较时统一去掉。 */
export const CATEGORY_EMOJI = ['🎬', '🧩', '🔎', '📝', '📅', '🎨', '⚙️', '💬']

export const SEPARATOR = '｜'
export const MAX_TITLE_CHARS = 48

const VS16 = /️/g
const bareEmoji = (emoji) => emoji.replace(VS16, '')
const EMOJI_BY_BARE = new Map(CATEGORY_EMOJI.map((emoji) => [bareEmoji(emoji), emoji]))

/** 按 Unicode 码点计数，emoji 与汉字各算一个。 */
export const charLength = (text) => [...text].length

/**
 * 校验并规整「类别 emoji + 空格 + 对象｜目标」。
 * @returns {{ ok: true, title: string, emoji: string, object: string, goal: string } | { ok: false, reason: string }}
 */
export function validateTitle(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-string' }
  // 变体选择符只影响 ⚙️ 的显示，统一去掉后再按前缀比较，输出时用规范写法。
  const flat = input.replace(/\s+/gu, ' ').replace(VS16, '').trim()
  if (flat.length === 0) return { ok: false, reason: 'empty' }
  if (charLength(flat) > MAX_TITLE_CHARS) return { ok: false, reason: 'too-long' }

  const bare = [...EMOJI_BY_BARE.keys()].find((key) => flat.startsWith(key))
  if (bare === undefined) return { ok: false, reason: 'bad-emoji' }
  const emoji = EMOJI_BY_BARE.get(bare)
  const rest = flat.slice(bare.length)
  if (!rest.startsWith(' ')) return { ok: false, reason: 'missing-space' }
  const body = rest.slice(1)

  if (body.includes('|')) return { ok: false, reason: 'ascii-separator' }
  const parts = body.split(SEPARATOR)
  if (parts.length < 2) return { ok: false, reason: 'missing-separator' }
  if (parts.length > 2) return { ok: false, reason: 'many-separators' }
  const [object, goal] = parts
  if (object.length === 0 || goal.length === 0) return { ok: false, reason: 'empty-part' }
  if (/^\s|\s$/u.test(object) || /^\s|\s$/u.test(goal)) return { ok: false, reason: 'spaces-around-separator' }
  if (EMOJI_PATTERN.test(object) || EMOJI_PATTERN.test(goal)) return { ok: false, reason: 'extra-emoji' }
  if (SENSITIVE_PATTERN.test(body)) return { ok: false, reason: 'sensitive' }
  return { ok: true, title: `${emoji} ${object}${SEPARATOR}${goal}`, emoji, object, goal }
}

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u
/** 邮箱、链接、盘符/UNC 路径、长数字串（电话、密钥片段）不应进入标题。 */
const SENSITIVE_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/|[A-Za-z]:[\\/]|\\\\|\b\d{9,}\b|\bsk-[A-Za-z0-9]{8,}/u

// ---------------------------------------------------------------------------
// 纯确认 / 问候
// ---------------------------------------------------------------------------

const ACK_WORDS = [
  '好', '好的', '好吧', '好嘞', '行', '可以', '可以了', '嗯', '嗯嗯', '哦', '哦哦', '对', '对的', '是', '是的', '没问题',
  '收到', '明白', '了解', '知道了', '懂了', '继续', '接着', '然后呢', '下一步', '谢谢', '多谢', '感谢', '辛苦了', '搞定', '完成',
  'ok', 'okay', 'k', 'kk', 'yes', 'yep', 'yeah', 'sure', 'right', 'got it', 'gotcha', 'roger', 'continue', 'go on', 'go ahead',
  'next', 'thanks', 'thank you', 'thx', 'ty', 'great', 'cool', 'nice', 'perfect', 'done', 'lgtm',
]
const GREETING_WORDS = [
  '你好', '您好', '嗨', '哈喽', '在吗', '在不在', '早', '早上好', '晚上好', '下午好', 'hi', 'hello', 'hey', 'yo', 'good morning', 'good evening',
]
const ACK_SET = new Set(ACK_WORDS)
const GREETING_SET = new Set(GREETING_WORDS)

/** 去掉首尾标点、空白与表情，转小写，便于精确匹配。 */
function canonicalShort(text) {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim()
}

/** 整句只有确认（可叠加语气词、标点、表情）。任何多出来的实质内容都不算确认。 */
export function isPureAcknowledgement(text) {
  if (typeof text !== 'string') return false
  const stripped = text.trim()
  if (stripped.length === 0) return false
  if (charLength(stripped) > 24) return false
  if (/^[\p{Extended_Pictographic}\s\p{P}\p{S}]+$/u.test(stripped)) return true // 👍 / ...
  const key = canonicalShort(stripped)
  if (key.length === 0) return true
  return ACK_SET.has(key) || ACK_SET.has(key.replace(/ /g, ''))
}

export function isGreetingOnly(text) {
  if (typeof text !== 'string') return false
  const stripped = text.trim()
  if (stripped.length === 0 || charLength(stripped) > 24) return false
  const key = canonicalShort(stripped)
  return GREETING_SET.has(key) || GREETING_SET.has(key.replace(/ /g, ''))
}

// ---------------------------------------------------------------------------
// 外层项目名
// ---------------------------------------------------------------------------

const GENERIC_DIRS = new Set([
  'documents', 'document', '文档', 'desktop', '桌面', 'downloads', 'download', '下载', 'home', 'users', 'user', 'workspace',
  'default-workspace', 'default_workspace', 'projects', 'project', 'code', 'src', 'repos', 'repo', 'work', 'tmp', 'temp',
  'deepseek-harness', 'deepseek harness',
])

/**
 * 工作目录末级名称作为弱线索；用户主目录、通用存放目录不算项目名。不发送完整路径。
 * @param {string | undefined} cwd
 * @param {string | undefined} homeDir
 */
export function projectHint(cwd, homeDir) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const normalized = cwd.replace(/[\\/]+$/u, '')
  if (homeDir && normalized.toLowerCase() === homeDir.replace(/[\\/]+$/u, '').toLowerCase()) return ''
  const name = normalized.split(/[\\/]/u).pop() ?? ''
  if (name === '' || /^[a-z]:$/iu.test(name)) return ''
  if (GENERIC_DIRS.has(name.toLowerCase())) return ''
  return name
}

const foldName = (text) => text.toLowerCase().replace(/[\s\-_]+/gu, '')

/**
 * 新标题若以外层目录的精确等价名称开头（忽略空格、连字符、下划线与大小写）就去掉它。
 * 只处理完整词边界：MaplePay 不会被 Maple 截断；剥掉后对象为空则保持原样。
 */
export function stripOuterProjectPrefix(title, hint) {
  if (!hint) return title
  const checked = validateTitle(title)
  if (!checked.ok) return title
  const target = foldName(hint)
  if (target.length === 0) return title
  const object = checked.object
  const chars = [...object]
  let consumed = ''
  for (let i = 0; i < chars.length; i += 1) {
    consumed += chars[i]
    if (foldName(consumed) !== target) continue
    const next = chars[i + 1]
    if (next !== undefined && /[\p{L}\p{N}]/u.test(next) && /[A-Za-z0-9]/u.test(chars[i])) continue
    const remainder = chars.slice(i + 1).join('').replace(/^[\s\-_·:：/／]+/u, '')
    if (remainder.length === 0) return title
    return `${checked.emoji} ${remainder}${SEPARATOR}${checked.goal}`
  }
  return title
}

/** 头尾保留的截断，让长粘贴不淹没请求本身。 */
export function clip(text, max) {
  const chars = [...text]
  if (chars.length <= max) return text
  const head = Math.ceil(max * 0.7)
  const tail = max - head
  return `${chars.slice(0, head).join('')} … ${chars.slice(chars.length - tail).join('')}`
}
