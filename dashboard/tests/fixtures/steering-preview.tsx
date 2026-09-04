// Isolated browser fixture: synthetic work only; sends never reach a Runtime.
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'
import { Composer, MessageThreadReference, DialogueActivityDock, type ObjectiveRecord } from '../../src/App'
import { ObjectiveSteeringButton } from '../../src/pages/ObjectiveSteeringButton'
import { shortId } from '../../src/app/presentation'
import { ThreadCausalCard } from '../../src/pages/ThreadCausalCard'
import type { SchedulerThreadSnapshot } from '../../src/scheduler/types'
import { objectiveReplyDestination, threadDestination, type InputSelection } from '../../src/app/steering'

const snapshot: SchedulerThreadSnapshot = {
  intent: '你再起一个线程去分析一下，我现在要测试一下，对线程干预的功能。随后检查并发写入与中文路径，并补齐所有相关回归。', phase: 'running',
  thread: { id: 'thread_0123456789abcdef0123456789abcdef', revision: 1, generation: 1,
    agent_id: 'fixture', context_id: 'fixture', session_id: 'fixture', root_turn_id: 'fixture-root',
    kind: 'execution', lifecycle: 'open', control_state: 'active', executor_kind: 'self', delivery_status: 'none',
    supervision: { lifetime: 'durable', supervisor_kind: 'none', generation: 1 },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, pending_signals: [], activations: [], schedules: [],
}

const objectiveFixtures: ObjectiveRecord[] = ['active', 'waiting', 'paused', 'completed'].map(state => ({
  id: `objective-fixture-${state}`, generation: 7, revision: 12, context_id: 'fixture',
  coordinator_session_id: 'objective-fixture', delivery_session_id: 'objective-fixture',
  stated_objective: `${state === 'waiting' ? '确认验收范围：' : ''}对两个代码库开展多阶段系统架构与工程质量评估：审查进程间通信、凭据生命周期、并发模型、锁竞争与长连接，并补齐可复现的回归。`,
  status: state === 'waiting' ? 'active' : state,
  wait_condition: state === 'waiting' ? { kind: 'user_input', request_id: 'fixture-question-1' } : undefined,
  tokens_used: 0, time_used_seconds: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}))

export function Preview() {
  const { t, i18n } = useTranslation()
  const params = new URLSearchParams(window.location.search)
  const showObjectives = params.has('objectives')
  const fixtureLanguage = params.get('language')
  useEffect(() => {
    if (fixtureLanguage === 'en' || fixtureLanguage === 'zh') void i18n.changeLanguage(fixtureLanguage)
  }, [fixtureLanguage, i18n])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const selection = { destination: threadDestination(snapshot), label: `${shortId(snapshot.thread.id)} · ${snapshot.intent}`, sessionId: 'fixture' }
  const [request, setRequest] = useState<InputSelection | null>(() => new URLSearchParams(window.location.search).has('selected') ? selection : null)
  const [receipt, setReceipt] = useState('')
  const [expandedObjectives, setExpandedObjectives] = useState(new Set<string>())
  const selectObjective = (objective: ObjectiveRecord) => {
    const destination = objectiveReplyDestination(objective)
    setRequest({ destination, label: objective.stated_objective, sessionId: 'objective-fixture' })
    setReceipt(JSON.stringify({ selected_destination: destination }))
  }
  const noOp = () => {}
  return <main className="steering-preview page-shell" data-accent="cyan" data-color-mode={params.get('appearance') ?? 'dark'} style={{ maxWidth: 1120, height: '100%', overflow: 'auto', margin: 'auto', padding: 16, color: 'var(--text)' }}>
    <style>{`.steering-preview .preview-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; margin-bottom: 20px; }
    .steering-preview .dialogue-activity-dock { position: static; width: 100%; height: 350px; }
    .steering-preview .composer { position: relative; }
    .steering-preview .fixture-receipt { display: block; overflow-wrap: anywhere; margin-top: 12px; font: 10px/1.5 monospace; }
    @media (max-width: 700px) { .steering-preview .preview-grid { grid-template-columns: minmax(0, 1fr); }
    .steering-preview .dialogue-activity-dock { max-width: 280px; margin-left: auto; } }`}</style>
    <h1>{showObjectives ? (i18n.language === 'en' ? 'Objective steering preview' : '目标干预预览') : 'Steering UI fixture'}</h1><p>{i18n.language === 'en' ? 'UI fixture only; no Runtime requests.' : '仅测试界面，不连接运行时。'}</p>
    <div className="preview-grid">
      {showObjectives ? <section>
        {objectiveFixtures.slice(0, 2).map(objective => <article className="work-card objective-work-card" key={objective.id}>
          <h2 title={objective.stated_objective}>{objective.stated_objective}</h2>
          <div className="objective-work-input"><ObjectiveSteeringButton objective={objective} t={t} onClick={() => selectObjective(objective)} /></div>
        </article>)}
        <article className="attention-card user-input">
          <h2>{t('work.attention.waitingUser')}</h2>
          <div className="attention-actions"><ObjectiveSteeringButton objective={objectiveFixtures[1]} t={t} onClick={() => selectObjective(objectiveFixtures[1])} /></div>
        </article>
      </section> : <MessageThreadReference snapshot={snapshot} objectiveIds={[]} tintStyleFor={() => undefined} onOpen={() => setRequest(selection)} t={t} />}
      <DialogueActivityDock open visible objectives={showObjectives ? objectiveFixtures : []} threads={showObjectives ? [] : [snapshot]} historyThreads={[]} delegations={[]} currentSessionId={showObjectives ? 'objective-fixture' : 'fixture'} expandedThreadId="" threadDetail={null} liveModelAttempts={[]} showReasoningSummary={false} expandedObjectiveIds={expandedObjectives} selectedObjectiveId="" currentSessionOnly objectiveTintEnabled={false} tintDimension="thread" tintStyleFor={() => undefined} objectiveIdsByThread={new Map()} pausingObjectiveId="" resumingObjectiveId="" editingObjectiveId="" deletingObjectiveId="" mutatingThreadId="" t={t} onSteerThread={() => setRequest(selection)} onSteerObjective={selectObjective} onOpenChange={noOp} onVisibleChange={noOp} onThreadToggle={noOp} onReasoningOpenChange={noOp} onInspectThread={noOp} onObjectiveToggle={id => setExpandedObjectives(current => current.has(id) ? new Set([...current].filter(value => value !== id)) : new Set([...current, id]))} onObjectiveFilterChange={noOp} onCurrentSessionOnlyChange={noOp} onObjectiveTintChange={noOp} onTintDimensionChange={noOp} onPauseObjective={noOp} onResumeObjective={noOp} onEditObjective={noOp} onDeleteObjective={noOp} onThreadControl={noOp} onOpenDelegationContext={noOp} />
    </div>
    {!showObjectives && <ThreadCausalCard snapshot={snapshot} t={t} locale={i18n.language} decidingApprovalId="" mutatingScheduleId="" mutatingThreadId="" onApproval={() => {}} onSchedule={() => {}} onThreadControl={() => {}} onSteer={() => setRequest(selection)} />}
    <Composer inputRef={inputRef} principalId="fixture" selectedSessionId={showObjectives ? 'objective-fixture' : 'fixture'} sending={false} readOnly={false} quotes={[]} activeQuoteId="" t={t} onActiveQuoteIdChange={() => {}} onRemoveQuote={() => {}} onUpdateQuoteComment={() => {}} onError={setReceipt} sessionCandidates={[]} currentAgentId="fixture" currentContextId="fixture" selectionRequest={request} onSelectionRequestHandled={() => setRequest(null)} directedCandidates={[selection]} onSend={async (text, _attachments, _references, _mode, _id, destination) => { setReceipt(JSON.stringify({ text, input_destination: destination })); return true }} />
    <output className="fixture-receipt">{receipt}</output>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
