import { inspectIoMessage } from '../app/sessionIo'

export function SessionIoMessage({ payload }: { payload: Record<string, unknown> }) {
  const message = inspectIoMessage(payload)
  if (!message) return null
  return <section className="session-io-message" aria-label={message.format}>
    <small>{message.format} · {message.encoding}</small>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '28rem', overflow: 'auto' }}>{message.text}</pre>
  </section>
}
