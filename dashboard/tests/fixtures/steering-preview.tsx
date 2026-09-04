// Isolated browser fixture: synthetic work only; sends never reach a Runtime.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'
import { Composer } from '../../src/App'
import { ThreadCausalCard } from '../../src/pages/ThreadCausalCard'
import type { SchedulerThreadSnapshot } from '../../src/scheduler/types'
import { threadDestination, type InputSelection } from '../../src/app/steering'

const snapshot: SchedulerThreadSnapshot = {
  intent: '实现解析器：支持中文路径，并为并发写入增加回归测试。', phase: 'running',
  thread: { id: 'thread_0123456789abcdef0123456789abcdef', revision: 1, generation: 1,
    agent_id: 'fixture', context_id: 'fixture', session_id: 'fixture', root_turn_id: 'fixture-root',
    kind: 'execution', lifecycle: 'open', control_state: 'active', executor_kind: 'self', delivery_status: 'none',
    supervision: { lifetime: 'durable', supervisor_kind: 'none', generation: 1 },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, pending_signals: [], activations: [], schedules: [],
}

export function Preview() {
  const { t, i18n } = useTranslation()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [request, setRequest] = useState<InputSelection | null>(null)
  const [receipt, setReceipt] = useState('')
  const selection = { destination: threadDestination(snapshot), label: `${snapshot.thread.id} · 解析器`, sessionId: 'fixture' }
  return <main style={{ maxWidth: 920, margin: 'auto', padding: 16 }}>
    <h1>Steering UI fixture</h1><p>仅测试界面，不连接运行时。</p>
    <ThreadCausalCard snapshot={snapshot} t={t} locale={i18n.language} decidingApprovalId="" mutatingScheduleId="" mutatingThreadId="" onApproval={() => {}} onSchedule={() => {}} onThreadControl={() => {}} onSteer={() => setRequest(selection)} />
    <Composer inputRef={inputRef} principalId="fixture" selectedSessionId="fixture" sending={false} readOnly={false} quotes={[]} activeQuoteId="" t={t} onActiveQuoteIdChange={() => {}} onRemoveQuote={() => {}} onUpdateQuoteComment={() => {}} onError={setReceipt} sessionCandidates={[]} currentAgentId="fixture" currentContextId="fixture" selectionRequest={request} onSelectionRequestHandled={() => setRequest(null)} directedCandidates={[selection]} onSend={async (text, _attachments, _references, _mode, _id, destination) => { setReceipt(JSON.stringify({ text, input_destination: destination })); return true }} />
    <output>{receipt}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
