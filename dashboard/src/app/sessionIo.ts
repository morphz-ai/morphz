// Persisted domain numbers are lexemes, not JavaScript floating-point values.
type Data = { type: string; value?: unknown }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function formatIoData(value: unknown, depth = 0): string {
  if (depth > 40) throw new Error('IO data nesting limit exceeded')
  const data = record(value) as Data | null
  if (!data) throw new Error('Invalid persisted IO data')
  switch (data.type) {
    case 'null': return 'null'
    case 'boolean': if (typeof data.value === 'boolean') return String(data.value); break
    case 'number': if (typeof data.value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(data.value)) return data.value; break
    case 'string': if (typeof data.value === 'string') return JSON.stringify(data.value); break
    case 'array': if (Array.isArray(data.value)) return `[${data.value.map(value => formatIoData(value, depth + 1)).join(', ')}]`; break
    case 'object': {
      const object = record(data.value)
      if (object) {
        const pad = '  '.repeat(depth + 1)
        const entries = Object.entries(object).map(([key, value]) => `${pad}${JSON.stringify(key)}: ${formatIoData(value, depth + 1)}`)
        return entries.length ? `{\n${entries.join(',\n')}\n${'  '.repeat(depth)}}` : '{}'
      }
      break
    }
  }
  throw new Error('Invalid persisted IO data')
}
export function inspectIoMessage(payload: Record<string, unknown>): { format: string; encoding: string; text: string; chat: boolean } | null {
  const input = record(payload.session_io)
  const request = record(input?.request)
  const message = record(request?.message ?? payload.io_message)
  if (!message) return null
  const format = record(message.format)
  const content = record(message.content)
  if (!format || !content) return { format: 'Invalid message', encoding: 'unknown', text: 'The persisted message cannot be decoded.', chat: false }
  const label = `${String(format.id)}@${String(format.version)}`
  const chat = format.id === 'morphz.chat' && format.version === '1'
  if (content.encoding === 'utf8' && typeof content.value === 'string') return {format: label, encoding: 'utf8', text: content.value, chat}
  if (content.encoding === 'resource' && typeof content.resource_id === 'string') {
    const binding = record(input?.binding)
    const resources = Array.isArray(binding?.resources) ? binding.resources : Array.isArray(payload.io_resources) ? payload.io_resources : []
    const metadata = resources.map(record).find(item => item?.original_resource_id === content.resource_id || item?.resource_id === content.resource_id)
    return { format: label, encoding: 'resource', text: JSON.stringify({resource_id:content.resource_id,...(metadata ?? {})},null,2), chat: false }
  }
  try {
    if (content.encoding === 'json') {
      if (chat) {
        const data = record(content.value)
        const text = record(record(data?.value)?.text)
        if (text?.type === 'string' && typeof text.value === 'string') return {format: label, encoding: 'json', text: text.value, chat: true}
      }
      return {format: label, encoding: 'json', text: formatIoData(content.value), chat: false}
    }
  } catch { return {format: label, encoding: 'json', text: 'The persisted message cannot be decoded.', chat: false} }
  return {format: label, encoding: String(content.encoding), text: 'This representation is not supported by this inspector.', chat: false}
}
