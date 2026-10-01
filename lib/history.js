/**
 * 从会话事件日志里摘出「用户请求 + 最终回答」的轮次。
 * 只取用户亲自输入的文字（source.kind === 'user'）与助手的文字块；
 * 工具调用、思考块、系统/开发者消息都不参与，命名模型看到的只是最少必要的摘录。
 */

const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    : ''

/**
 * @param {Iterable<any>} events 会话事件，按 seq 升序
 * @returns {{ seq: number, user: string, assistant: string }[]}
 */
export function collectTurns(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const user = textOf(event.data.content)
      if (user.trim() === '') continue
      current = { seq: event.seq, user, assistant: '' }
      turns.push(current)
    } else if (event.type === 'assistant/message' && current !== undefined) {
      const assistant = textOf(event.data?.message?.content)
      // 一轮里可能有多段助手消息（工具调用前后），以最后一段有文字的为最终回答。
      if (assistant.trim() !== '') current.assistant = assistant
    }
  }
  return turns
}
