import { Brain, Check, ChevronDown, CircleDot, Clock3, Filter, GitBranch, KeyRound, Layers3, LoaderCircle, Pause, Play, Radio, Square, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { LiveModelAttempt } from '../modelStream'
import type {
  ApprovalDecision,
  ApprovalRecord,
  ScheduleRecord,
  SchedulerActivationSnapshot,
  SchedulerJobSnapshot,
  SchedulerThreadSnapshot,
  ThreadDetailResponse,
  ThreadRecord,
} from '../scheduler/types'
import { formatTime, shortId, statusLabel, summarizeToolCall, threadKindLabel } from '../app/presentation'
import { canSteerThread, threadAssignment } from '../app/steering'
import { copyTextToClipboard } from '../utils/clipboard'

function modelAttemptActivationId(event: ThreadDetailResponse['model_attempt_events'][number]) {
  return typeof event.payload.activation_id === 'string' ? event.payload.activation_id : ''
}

function executionJobHasObjectiveApprovalScope(request: unknown) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false
  return typeof (request as Record<string, unknown>)._morphz_capability_lease_objective_id === 'string'
}

function executionJobRequestedApprovalScope(request: unknown) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'thread'
  const scope = (request as Record<string, unknown>).approval_scope
  return scope === 'once' || scope === 'objective' || scope === 'session' ? scope : 'thread'
}

function executionJobAllowsReusableApproval(request: unknown) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return true
  return (request as Record<string, unknown>).approval_scope !== 'once'
}

function ModelAttemptList({
  events,
  liveAttempts,
  t,
  locale,
}: {
  events: ThreadDetailResponse['model_attempt_events']
  liveAttempts: LiveModelAttempt[]
  t: TFunction
  locale: string
}) {
  if (events.length === 0 && liveAttempts.length === 0) return null
  return (
    <section className="thread-model-attempts">
      <header>
        <Brain size={13} />
        <strong>{t('work.causal.modelAttempts')}</strong>
        <small>{t('work.causal.modelAttemptsCount', { count: events.length + liveAttempts.length })}</small>
      </header>
      <div>
        {liveAttempts.map(attempt => (
          <article className="thread-model-attempt live" key={`live-${attempt.attemptId}`}>
            <span className={`status-pill ${attempt.runtimeState}`}>{statusLabel(attempt.runtimeState, t)}</span>
            <code>{shortId(attempt.attemptId, 22)}</code>
            <time>{formatTime(attempt.startedAt, locale)}</time>
            {(attempt.reasoningSummary || attempt.text || attempt.error) && (
              <p>{attempt.error || attempt.reasoningSummary || attempt.text}</p>
            )}
          </article>
        ))}
        {events.map(event => {
          const attemptId = typeof event.payload.attempt_id === 'string' ? event.payload.attempt_id : event.id
          const state = typeof event.payload.state === 'string' ? event.payload.state : 'reasoning_summary'
          const detail = typeof event.payload.detail === 'string'
            ? event.payload.detail
            : typeof event.payload.text === 'string'
              ? event.payload.text
              : ''
          return (
            <article className="thread-model-attempt" key={event.id}>
              <span className={`status-pill ${state}`}>{statusLabel(state, t)}</span>
              <code>{shortId(attemptId, 22)}</code>
              <time>{formatTime(event.timestamp, locale)}</time>
              {detail && <p>{detail}</p>}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function ExecutionJobRow({
  snapshot,
  t,
  locale,
  decidingApprovalId,
  onApproval,
}: {
  snapshot: SchedulerJobSnapshot
  t: TFunction
  locale: string
  decidingApprovalId: string
  onApproval: (approval: ApprovalRecord, decision: ApprovalDecision) => void
}) {
  const { job, approval, result } = snapshot
  const summary = summarizeToolCall(job.tool_name, JSON.stringify(job.request), t)
  const failed = job.status === 'failed' || job.status === 'lost'
  return (
    <details className={`causal-job ${failed ? 'failed' : job.status}`} open={job.status === 'running' || job.status === 'waiting_approval'}>
      <summary>
        <i>{job.status === 'running' ? <LoaderCircle size={13} /> : failed ? '!' : job.status === 'succeeded' ? '✓' : <CircleDot size={12} />}</i>
        <span><strong>{summary.title}</strong><small>{summary.target}</small></span>
        <code>{job.status} · {shortId(job.id, 18)}</code>
        <time>{formatTime(job.updated_at, locale)}</time>
        <ChevronDown size={13} />
      </summary>
      <div className="causal-job-detail">
        <section><header>{t('work.causal.request')}</header><pre>{JSON.stringify(job.request, null, 2)}</pre></section>
        <dl>
          <div><dt>{t('work.causal.target')}</dt><dd>{job.target_id}</dd></div>
          <div><dt>{t('work.causal.retrySafety')}</dt><dd>{job.retry_safety}</dd></div>
          <div><dt>{t('work.causal.revision')}</dt><dd>r{job.revision}</dd></div>
          {job.checkpoint_generation != null && <div><dt>{t('work.causal.checkpointGeneration')}</dt><dd>g{job.checkpoint_generation}</dd></div>}
          {job.checkpoint_due_at && <div><dt>{t('work.causal.checkpointDueAt')}</dt><dd>{formatTime(job.checkpoint_due_at, locale)}</dd></div>}
          {job.claimed_by && <div><dt>{t('work.causal.worker')}</dt><dd>{job.claimed_by}</dd></div>}
        </dl>
        {approval && (
          <section className={`inline-approval ${approval.status}`}>
            <header><span>{t('work.approvals.title')}</span><b>{statusLabel(approval.status, t)}</b></header>
            <p>{approval.justification}</p>
            <details><summary>{t('work.approvals.capability')}</summary><pre>{JSON.stringify({ action: approval.action, requested: approval.requested, approval_scope: executionJobRequestedApprovalScope(job.request) }, null, 2)}</pre></details>
            {approval.risk_tags.length > 0 && <small>{approval.risk_tags.join(' · ')}</small>}
            {approval.status === 'pending_human' && (
              <div className="approval-actions">
                <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => onApproval(approval, 'allow_once')}><Check size={13} /> {t('work.approvals.allowOnce')}</button>
                {job.initiating_principal_id && executionJobAllowsReusableApproval(job.request) && <>
                  <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => onApproval(approval, 'allow_thread')}><GitBranch size={13} /> {t('work.approvals.allowThread')}</button>
                  {executionJobHasObjectiveApprovalScope(job.request) && <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => onApproval(approval, 'allow_objective')}><Layers3 size={13} /> {t('work.approvals.allowObjective')}</button>}
                  <button disabled={decidingApprovalId === approval.id} className="session-rule" type="button" onClick={() => onApproval(approval, 'allow_session')}><KeyRound size={13} /> {t('work.approvals.allowSession')}</button>
                </>}
                <button disabled={decidingApprovalId === approval.id} className="danger" type="button" onClick={() => onApproval(approval, 'deny')}><Square size={12} /> {t('work.approvals.deny')}</button>
              </div>
            )}
          </section>
        )}
        {result && (
          <section className={`job-result ${result.status}`}>
            <header>{t('work.causal.result')} · {statusLabel(result.status, t)}</header>
            {result.error && <p>{result.error}</p>}
            {result.exit_code !== undefined && <small>{t('work.causal.exitCode', { code: result.exit_code })}</small>}
            {result.refs.length > 0 && <ul>{result.refs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul>}
            {result.event_id && <code>{shortId(result.event_id, 30)}</code>}
          </section>
        )}
      </div>
    </details>
  )
}

function ActivationGroup({
  snapshot,
  modelAttemptEvents,
  liveModelAttempts,
  t,
  locale,
  decidingApprovalId,
  onApproval,
}: {
  snapshot: SchedulerActivationSnapshot
  modelAttemptEvents: ThreadDetailResponse['model_attempt_events']
  liveModelAttempts: LiveModelAttempt[]
  t: TFunction
  locale: string
  decidingApprovalId: string
  onApproval: (approval: ApprovalRecord, decision: ApprovalDecision) => void
}) {
  return (
    <section className="causal-activation">
      <header>
        <span className={`status-pill ${snapshot.activation.status}`}>{statusLabel(snapshot.activation.status, t)}</span>
        <strong>{t('work.causal.activation')}</strong>
        <code>{shortId(snapshot.activation.id, 22)}</code>
        <small>{snapshot.activation.trigger_kind}</small>
      </header>
      {snapshot.signals.map(signal => (
        <div className="causal-signal" key={signal.id}>
          <Radio size={12} /><span>{signal.kind}</span><code>#{signal.sequence} · {shortId(signal.event_id, 18)}</code>
        </div>
      ))}
      <ModelAttemptList events={modelAttemptEvents} liveAttempts={liveModelAttempts} t={t} locale={locale} />
      <div className="causal-jobs">
        {snapshot.jobs.map(job => (
          <ExecutionJobRow
            key={job.job.id}
            snapshot={job}
            t={t}
            locale={locale}
            decidingApprovalId={decidingApprovalId}
            onApproval={onApproval}
          />
        ))}
        {snapshot.jobs.length === 0 && <div className="small-empty">{t('work.causal.noJobs')}</div>}
      </div>
    </section>
  )
}

export function ThreadCausalCard({
  snapshot,
  modelAttemptEvents = [],
  liveModelAttempts = [],
  t,
  locale,
  decidingApprovalId,
  mutatingScheduleId,
  mutatingThreadId,
  onApproval,
  onSchedule,
  onThreadControl,
  onSteer,
  selectedSupervisorId,
  onSupervisorFilter,
  onInspect,
}: {
  snapshot: SchedulerThreadSnapshot
  modelAttemptEvents?: ThreadDetailResponse['model_attempt_events']
  liveModelAttempts?: LiveModelAttempt[]
  t: TFunction
  locale: string
  decidingApprovalId: string
  mutatingScheduleId: string
  mutatingThreadId: string
  onApproval: (approval: ApprovalRecord, decision: ApprovalDecision) => void
  onSchedule: (schedule: ScheduleRecord, action: 'pause' | 'resume' | 'reschedule' | 'cancel') => void
  onThreadControl: (thread: ThreadRecord, action: 'pause' | 'resume' | 'cancel') => void
  onSteer?: (snapshot: SchedulerThreadSnapshot) => void
  selectedSupervisorId?: string
  onSupervisorFilter?: (supervisorId: string) => void
  onInspect?: (threadId: string) => void
}) {
  const { thread } = snapshot
  // `open` is a semantic lifecycle (the Thread may accept a later Signal),
  // not evidence of physical activity. Only the Scheduler projection decides
  // whether this aggregate is currently runnable/running/waiting.
  const displayPhase = thread.control_state === 'paused' ? 'paused' : snapshot.phase
  const active = displayPhase !== 'idle'
  const nextWake = (() => {
    if (thread.lifecycle !== 'open') return t('work.causal.nextWakeValues.terminal')
    if (thread.control_state === 'paused') return t('work.causal.nextWakeValues.paused')
    const signal = snapshot.pending_signals[0]
    if (signal) return t('work.causal.nextWakeValues.signal', { kind: signal.kind })
    const schedule = snapshot.schedules.find(item => item.status === 'queued' || item.status === 'paused')
    if (schedule) return t('work.causal.nextWakeValues.schedule', { intent: schedule.intent })
    if (thread.supervision.thread_group_id) return t('work.causal.nextWakeValues.group')
    return t(`work.causal.nextWakeValues.${displayPhase}`)
  })()
  const activationIds = new Set(snapshot.activations.map(item => item.activation.id))
  const unattachedModelAttemptEvents = modelAttemptEvents.filter(event => {
    const activationId = modelAttemptActivationId(event)
    return !activationId || !activationIds.has(activationId)
  })
  const unattachedLiveModelAttempts = liveModelAttempts.filter(attempt => !activationIds.has(attempt.activationId))
  return (
    <details className={`causal-thread ${displayPhase}`} open={active}>
      <summary>
        <span className={`status-pill ${displayPhase}`}>{statusLabel(displayPhase, t)}</span>
        <div>
          <strong>{threadKindLabel(thread.kind, t)}</strong>
          <span className="thread-assignment" title={threadAssignment(snapshot)}>{threadAssignment(snapshot) ?? t('steering.intentUnknown')}</span>
          <small>{shortId(thread.id, 30)} · {t('header.session')} {shortId(thread.session_id, 18)} · {t('work.causal.executor')} {thread.executor_kind}{thread.executor_id ? `/${shortId(thread.executor_id, 16)}` : ''}</small>
          <small className="thread-supervision-summary">
            {t(`work.causal.lifetimeValues.${thread.supervision.lifetime}`)}
            {' · '}
            {t('work.causal.supervisedBy', {
              kind: t(`work.causal.supervisorValues.${thread.supervision.supervisor_kind}`),
              id: thread.supervision.supervisor_id ? shortId(thread.supervision.supervisor_id, 18) : t('work.causal.none'),
            })}
            {thread.supervision.thread_group_id ? ` · ${t('work.causal.group')} ${shortId(thread.supervision.thread_group_id, 18)}` : ''}
          </small>
        </div>
        <span className="causal-counts">{snapshot.activations.length}A · {snapshot.activations.reduce((sum, item) => sum + item.jobs.length, 0)}J</span>
        <em>{statusLabel(thread.delivery_status, t)}</em>
        <ChevronDown size={14} />
      </summary>
      <div className="causal-thread-body">
        <section className="thread-supervision-panel">
          <div><span>{t('work.causal.lifetime')}</span><strong>{t(`work.causal.lifetimeValues.${thread.supervision.lifetime}`)}</strong></div>
          <div><span>{t('work.causal.supervisor')}</span><strong>{t(`work.causal.supervisorValues.${thread.supervision.supervisor_kind}`)}{thread.supervision.supervisor_id ? ` · ${shortId(thread.supervision.supervisor_id, 24)}` : ''}</strong></div>
          <div><span>{t('work.causal.generation')}</span><strong>g{thread.supervision.generation}</strong></div>
          <div><span>{t('work.causal.group')}</span><strong>{thread.supervision.thread_group_id ? shortId(thread.supervision.thread_group_id, 26) : t('work.causal.none')}</strong></div>
          <div className="thread-next-wake"><span>{t('work.causal.nextWake')}</span><strong>{nextWake}</strong></div>
          <details>
            <summary>{t('work.causal.completionContract')}</summary>
            <pre>{JSON.stringify(thread.supervision.completion_contract ?? {}, null, 2)}</pre>
          </details>
        </section>
        <div className="causal-thread-actions">
          <button type="button" title={thread.id} onClick={() => { void copyTextToClipboard(thread.id).catch(() => window.prompt(t('steering.copyId'), thread.id)) }}>{t('steering.copyId')}</button>
          {onSteer && canSteerThread(snapshot) && <button type="button" onClick={() => onSteer(snapshot)}>{t('steering.intervene')}</button>}
          {onInspect && <button type="button" onClick={() => onInspect(thread.id)}>{t('work.causal.inspect')}</button>}
          {onSupervisorFilter && thread.supervision.supervisor_id && (
            <button
              type="button"
              onClick={() => onSupervisorFilter(thread.supervision.supervisor_id ?? '')}
            >
              <Filter size={12} /> {selectedSupervisorId === thread.supervision.supervisor_id
                ? t('work.causal.clearSupervisorFilter')
                : t('work.causal.filterSupervisor')}
            </button>
          )}
          {thread.lifecycle === 'open' && thread.control_state === 'active' && (
            <button disabled={mutatingThreadId === thread.id} type="button" title={t('work.causal.pauseThreadHint')} onClick={() => onThreadControl(thread, 'pause')}><Pause size={12} /> {t('work.causal.pauseThread')}</button>
          )}
          {thread.lifecycle === 'open' && thread.control_state === 'paused' && (
            <button disabled={mutatingThreadId === thread.id} type="button" onClick={() => onThreadControl(thread, 'resume')}><Play size={12} /> {t('work.causal.resumeThread')}</button>
          )}
          {thread.lifecycle === 'open' && (
            <button disabled={mutatingThreadId === thread.id} className="danger" type="button" onClick={() => onThreadControl(thread, 'cancel')}><X size={12} /> {t('work.causal.cancelThread')}</button>
          )}
        </div>
        {snapshot.pending_signals.map(signal => (
          <div className="causal-signal pending" key={signal.id}>
            <Radio size={12} /><span>{signal.kind}</span><code>#{signal.sequence} · {shortId(signal.event_id, 20)}</code>
          </div>
        ))}
        <ModelAttemptList events={unattachedModelAttemptEvents} liveAttempts={unattachedLiveModelAttempts} t={t} locale={locale} />
        {snapshot.activations.map(activation => (
          <ActivationGroup
            key={activation.activation.id}
            snapshot={activation}
            modelAttemptEvents={modelAttemptEvents.filter(event => modelAttemptActivationId(event) === activation.activation.id)}
            liveModelAttempts={liveModelAttempts.filter(attempt => attempt.activationId === activation.activation.id)}
            t={t}
            locale={locale}
            decidingApprovalId={decidingApprovalId}
            onApproval={onApproval}
          />
        ))}
        {snapshot.schedules.map(schedule => (
          <article className="inline-schedule" key={schedule.id}>
            <Clock3 size={14} />
            <div><strong>{schedule.intent}</strong><small>{schedule.not_before ? new Date(schedule.not_before).toLocaleString(locale) : t('work.scheduler.immediate')} · r{schedule.revision}</small></div>
            <span className={`status-pill ${schedule.status}`}>{statusLabel(schedule.status, t)}</span>
            <div className="schedule-actions">
              {schedule.status === 'queued' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'pause')}>{t('work.schedules.pause')}</button>}
              {schedule.status === 'paused' && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'resume')}>{t('work.schedules.resume')}</button>}
              {!['completed', 'cancelled', 'dispatched'].includes(schedule.status) && <button disabled={mutatingScheduleId === schedule.id} type="button" onClick={() => onSchedule(schedule, 'reschedule')}>{t('work.schedules.reschedule')}</button>}
              {!['completed', 'cancelled'].includes(schedule.status) && <button disabled={mutatingScheduleId === schedule.id} className="danger" type="button" onClick={() => onSchedule(schedule, 'cancel')}>{t('work.schedules.cancel')}</button>}
            </div>
          </article>
        ))}
        <footer className={`delivery-state ${thread.delivery_status}`}>
          <span>{t('work.causal.delivery')}</span><b>{statusLabel(thread.delivery_status, t)}</b>
          {thread.result_text && <p>{thread.result_text}</p>}
        </footer>
        {snapshot.outcome && (
          <section className={`thread-outcome ${snapshot.outcome.terminal_kind}`}>
            <header>
              <strong>{t('work.causal.outcome')}</strong>
              <span className={`status-pill ${snapshot.outcome.terminal_kind}`}>{statusLabel(snapshot.outcome.terminal_kind, t)}</span>
              <code>g{snapshot.outcome.thread_generation}</code>
            </header>
            {snapshot.outcome.summary && <p>{snapshot.outcome.summary}</p>}
            {(snapshot.outcome.artifact_refs.length > 0 || snapshot.outcome.evidence_refs.length > 0) && (
              <small>{t('work.causal.outcomeRefs', {
                artifacts: snapshot.outcome.artifact_refs.length,
                evidence: snapshot.outcome.evidence_refs.length,
              })}</small>
            )}
            {snapshot.outcome.unresolved_failures.length > 0 && (
              <ul>{snapshot.outcome.unresolved_failures.map(failure => <li key={failure}>{failure}</li>)}</ul>
            )}
            <details>
              <summary>{t('work.causal.checkResults')}</summary>
              <pre>{JSON.stringify(snapshot.outcome.check_results ?? {}, null, 2)}</pre>
            </details>
          </section>
        )}
      </div>
    </details>
  )
}
