import { Brain, Check, ChevronDown, CircleDot, Clock3, LoaderCircle, Radio, Square } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { LiveModelAttempt } from '../modelStream'
import type {
  ApprovalRecord,
  ScheduleRecord,
  SchedulerActivationSnapshot,
  SchedulerJobSnapshot,
  SchedulerThreadSnapshot,
  ThreadDetailResponse,
} from '../scheduler/types'
import { formatTime, shortId, statusLabel, summarizeToolCall, threadKindLabel } from '../app/presentation'

function modelAttemptActivationId(event: ThreadDetailResponse['model_attempt_events'][number]) {
  return typeof event.payload.activation_id === 'string' ? event.payload.activation_id : ''
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
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
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
          {job.claimed_by && <div><dt>{t('work.causal.worker')}</dt><dd>{job.claimed_by}</dd></div>}
        </dl>
        {approval && (
          <section className={`inline-approval ${approval.status}`}>
            <header><span>{t('work.approvals.title')}</span><b>{statusLabel(approval.status, t)}</b></header>
            <p>{approval.justification}</p>
            <details><summary>{t('work.approvals.capability')}</summary><pre>{JSON.stringify({ action: approval.action, requested: approval.requested }, null, 2)}</pre></details>
            {approval.risk_tags.length > 0 && <small>{approval.risk_tags.join(' · ')}</small>}
            {approval.status === 'pending_human' && (
              <div className="approval-actions">
                <button disabled={decidingApprovalId === approval.id} type="button" onClick={() => onApproval(approval, 'allow_once')}><Check size={13} /> {t('work.approvals.allowOnce')}</button>
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
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
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
  onApproval,
  onSchedule,
  onInspect,
}: {
  snapshot: SchedulerThreadSnapshot
  modelAttemptEvents?: ThreadDetailResponse['model_attempt_events']
  liveModelAttempts?: LiveModelAttempt[]
  t: TFunction
  locale: string
  decidingApprovalId: string
  mutatingScheduleId: string
  onApproval: (approval: ApprovalRecord, decision: 'allow_once' | 'deny') => void
  onSchedule: (schedule: ScheduleRecord, action: 'pause' | 'resume' | 'reschedule' | 'cancel') => void
  onInspect?: (threadId: string) => void
}) {
  const { thread } = snapshot
  // `open` is a semantic lifecycle (the Thread may accept a later Signal),
  // not evidence of physical activity. Only the Scheduler projection decides
  // whether this aggregate is currently runnable/running/waiting.
  const active = snapshot.phase !== 'idle'
  const activationIds = new Set(snapshot.activations.map(item => item.activation.id))
  const unattachedModelAttemptEvents = modelAttemptEvents.filter(event => {
    const activationId = modelAttemptActivationId(event)
    return !activationId || !activationIds.has(activationId)
  })
  const unattachedLiveModelAttempts = liveModelAttempts.filter(attempt => !activationIds.has(attempt.activationId))
  return (
    <details className={`causal-thread ${snapshot.phase}`} open={active}>
      <summary>
        <span className={`status-pill ${snapshot.phase}`}>{statusLabel(snapshot.phase, t)}</span>
        <div><strong>{threadKindLabel(thread.kind, t)}</strong><small>{shortId(thread.id, 30)} · {t('header.session')} {shortId(thread.session_id, 18)} · {t('work.causal.executor')} {thread.executor_kind}{thread.executor_id ? `/${shortId(thread.executor_id, 16)}` : ''}</small></div>
        <span className="causal-counts">{snapshot.activations.length}A · {snapshot.activations.reduce((sum, item) => sum + item.jobs.length, 0)}J</span>
        <em>{statusLabel(thread.delivery_status, t)}</em>
        <ChevronDown size={14} />
      </summary>
      <div className="causal-thread-body">
        {onInspect && (
          <div className="causal-thread-actions">
            <button type="button" onClick={() => onInspect(thread.id)}>{t('work.causal.inspect')}</button>
          </div>
        )}
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
      </div>
    </details>
  )
}
