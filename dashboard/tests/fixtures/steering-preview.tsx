// Isolated browser fixture: synthetic work only; sends never reach a Runtime.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'
import { Composer, MessageThreadReference, DialogueActivityDock } from '../../src/App'
import { shortId } from '../../src/app/presentation'
import { ThreadCausalCard } from '../../src/pages/ThreadCausalCard'
import type { SchedulerThreadSnapshot } from '../../src/scheduler/types'
import { threadDestination, type InputSelection } from '../../src/app/steering'

const snapshot: SchedulerThreadSnapshot = {
  intent: '你再起一个线程去分析一下，我现在要测试一下，对线程干预的功能。随后检查并发写入与中文路径，并补齐所有相关回归。', phase: 'running',
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
  const selection = { destination: threadDestination(snapshot), label: `${shortId(snapshot.thread.id)} · ${snapshot.intent}`, sessionId: 'fixture' }
  const [request, setRequest] = useState<InputSelection | null>(() => new URLSearchParams(window.location.search).has('selected') ? selection : null)
  const [receipt, setReceipt] = useState('')
  const noOp = () => {}
  return <main className="steering-preview page-shell" data-accent="cyan" style={{ maxWidth: 1120, height: '100%', overflow: 'auto', margin: 'auto', padding: 16 }}>
    <style>{`.steering-preview .preview-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; margin-bottom: 20px; }
    .steering-preview .dialogue-activity-dock { position: static; width: 100%; height: 350px; }
    .steering-preview .composer { position: relative; }
    @media (max-width: 700px) { .steering-preview .preview-grid { grid-template-columns: minmax(0, 1fr); } }`}</style>
    <h1>Steering UI fixture</h1><p>仅测试界面，不连接运行时。</p>
    <div className="preview-grid">
      <MessageThreadReference snapshot={snapshot} objectiveIds={[]} tintStyleFor={() => undefined} onOpen={() => setRequest(selection)} t={t} />
      <DialogueActivityDock open visible objectives={[]} threads={[snapshot]} historyThreads={[]} delegations={[]} currentSessionId="fixture" expandedThreadId="" threadDetail={null} liveModelAttempts={[]} showReasoningSummary={false} expandedObjectiveIds={new Set()} selectedObjectiveId="" currentSessionOnly objectiveTintEnabled={false} tintDimension="thread" tintStyleFor={() => undefined} objectiveIdsByThread={new Map()} pausingObjectiveId="" resumingObjectiveId="" editingObjectiveId="" deletingObjectiveId="" mutatingThreadId="" t={t} onSteerThread={() => setRequest(selection)} onSteerObjective={noOp} onOpenChange={noOp} onVisibleChange={noOp} onThreadToggle={noOp} onReasoningOpenChange={noOp} onInspectThread={noOp} onObjectiveToggle={noOp} onObjectiveFilterChange={noOp} onCurrentSessionOnlyChange={noOp} onObjectiveTintChange={noOp} onTintDimensionChange={noOp} onPauseObjective={noOp} onResumeObjective={noOp} onEditObjective={noOp} onDeleteObjective={noOp} onThreadControl={noOp} onOpenDelegationContext={noOp} />
    </div>
    <ThreadCausalCard snapshot={snapshot} t={t} locale={i18n.language} decidingApprovalId="" mutatingScheduleId="" mutatingThreadId="" onApproval={() => {}} onSchedule={() => {}} onThreadControl={() => {}} onSteer={() => setRequest(selection)} />
    <Composer inputRef={inputRef} principalId="fixture" selectedSessionId="fixture" sending={false} readOnly={false} quotes={[]} activeQuoteId="" t={t} onActiveQuoteIdChange={() => {}} onRemoveQuote={() => {}} onUpdateQuoteComment={() => {}} onError={setReceipt} sessionCandidates={[]} currentAgentId="fixture" currentContextId="fixture" selectionRequest={request} onSelectionRequestHandled={() => setRequest(null)} directedCandidates={[selection]} onSend={async (text, _attachments, _references, _mode, _id, destination) => { setReceipt(JSON.stringify({ text, input_destination: destination })); return true }} />
    <output>{receipt}</output>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
