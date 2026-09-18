// Isolated replay fixture: inject persisted or synthetic Events before loading.
// The actual dialogue card renderer is used; no requests reach a Runtime.
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'
import { ExecutionToolCalls } from '../../src/App'
import { assistantToolCalls } from '../../src/app/presentation'
import { buildToolTimeline, type ToolTimelineEvent } from '../../src/app/executionTools'

const events = (window as Window & { __toolTimelineEvents?: ToolTimelineEvent[] }).__toolTimelineEvents ?? []
const timeline = new Map(buildToolTimeline(events).map(call => [call.id, call]))

export function Preview() {
  const { t, i18n } = useTranslation()
  return <main className="page-shell" data-accent="cyan" data-color-mode="dark" style={{ maxWidth: 1120, margin: 'auto', padding: 24, color: 'var(--text)' }}>
    <h1>Context transaction 回执回放</h1>
    <p>只读历史数据，不连接运行时。</p>
    {events.filter(event => event.topic === 'chat/assistant_call').map((event, index) => {
      const calls = assistantToolCalls(event.payload).map(call => timeline.get(call.id) ?? {
        ...call, timestamp: event.timestamp, status: 'running',
      })
      return <ExecutionToolCalls key={index} calls={calls} targetLabels={new Map()} locale={i18n.language} t={t} />
    })}
  </main>
}

const root = createRoot(document.getElementById('root')!)
root.render(<Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
