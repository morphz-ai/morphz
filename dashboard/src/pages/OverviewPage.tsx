import { Brain, Check, Clock3, GitBranch, Layers3, MessageSquare, Radio, RefreshCw, Send, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { DashboardView } from '../app/routes'

export interface OverviewActivity {
  id: string
  displayId: string
  kind: string
  phase: string
  phaseLabel: string
  executor: string
  updatedAgo: string
}

interface OverviewPageProps {
  contextTitle?: string
  sessionTitle?: string
  sessionCount: number
  mindRevision: number
  frames: { active: number; retiring: number; retired: number }
  scheduling: { openThreads: number; pendingSignals: number; activeSchedules: number }
  execution: { activeJobs: number; activeActivations: number; pendingApprovals: number }
  attention: { approvals: number; failedJobs: number; failedDeliveries: number; inactiveObjectives: number }
  activities: OverviewActivity[]
  canRefresh: boolean
  onRefresh: () => void
  onNavigate: (view: DashboardView) => void
  onOpenMind: () => void
}

export function OverviewPage({
  contextTitle,
  sessionTitle,
  sessionCount,
  mindRevision,
  frames,
  scheduling,
  execution,
  attention,
  activities,
  canRefresh,
  onRefresh,
  onNavigate,
  onOpenMind,
}: OverviewPageProps) {
  const { t } = useTranslation()
  const attentionCount = attention.approvals
    + attention.failedJobs
    + attention.failedDeliveries
    + attention.inactiveObjectives

  return (
    <section className="overview-view">
      <header className="workspace-heading overview-heading">
        <div>
          <span>{t('overview.eyebrow').toUpperCase()}</span>
          <h1>{contextTitle ?? t('overview.heading')}</h1>
          <p>{t('overview.description')}</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={!canRefresh}>
          <RefreshCw size={14} /> {t('overview.refresh')}
        </button>
      </header>

      {attentionCount > 0 ? (
        <section className="overview-attention">
          <header><span>{t('overview.attention.title').toUpperCase()}</span><b>{attentionCount}</b><small>{t('overview.attention.subtitle')}</small></header>
          <div className="overview-attention-grid">
            {attention.approvals > 0 && <button type="button" onClick={() => onNavigate('scheduler')}><Clock3 size={17} /><span><strong>{t('overview.attention.approvals', { count: attention.approvals })}</strong><small>{t('overview.attention.approvalsHint')}</small></span></button>}
            {attention.failedJobs > 0 && <button type="button" onClick={() => onNavigate('scheduler')}><Square size={17} /><span><strong>{t('overview.attention.failedJobs', { count: attention.failedJobs })}</strong><small>{t('overview.attention.failedJobsHint')}</small></span></button>}
            {attention.failedDeliveries > 0 && <button type="button" onClick={() => onNavigate('scheduler')}><Send size={17} /><span><strong>{t('overview.attention.deliveries', { count: attention.failedDeliveries })}</strong><small>{t('overview.attention.deliveriesHint')}</small></span></button>}
            {attention.inactiveObjectives > 0 && <button type="button" onClick={() => onNavigate('scheduler')}><Layers3 size={17} /><span><strong>{t('overview.attention.objectives', { count: attention.inactiveObjectives })}</strong><small>{t('overview.attention.objectivesHint')}</small></span></button>}
          </div>
        </section>
      ) : (
        <div className="overview-clear"><Check size={16} /><span><strong>{t('overview.attention.clear')}</strong><small>{t('overview.attention.clearHint')}</small></span></div>
      )}

      <div className="overview-planes">
        <button type="button" onClick={() => onNavigate('dialogue')}>
          <MessageSquare size={18} />
          <span><small>{t('overview.planes.interaction').toUpperCase()}</small><strong>{sessionCount}</strong><em>{t('overview.planes.sessions')}</em></span>
          <p>{sessionTitle ?? t('header.noSession')}</p>
        </button>
        <button type="button" onClick={onOpenMind}>
          <Brain size={18} />
          <span><small>{t('overview.planes.cognition').toUpperCase()}</small><strong>r{mindRevision}</strong><em>{t('overview.planes.mindRevision')}</em></span>
          <p>{t('overview.planes.frames', frames)}</p>
        </button>
        <button type="button" onClick={() => onNavigate('scheduler')}>
          <GitBranch size={18} />
          <span><small>{t('overview.planes.scheduling').toUpperCase()}</small><strong>{scheduling.openThreads}</strong><em>{t('overview.planes.threads')}</em></span>
          <p>{t('overview.planes.schedulerDetail', { signals: scheduling.pendingSignals, schedules: scheduling.activeSchedules })}</p>
        </button>
        <button type="button" onClick={() => onNavigate('scheduler')}>
          <Radio size={18} />
          <span><small>{t('overview.planes.execution').toUpperCase()}</small><strong>{execution.activeJobs}</strong><em>{t('overview.planes.jobs')}</em></span>
          <p>{t('overview.planes.executionDetail', { activations: execution.activeActivations, approvals: execution.pendingApprovals })}</p>
        </button>
      </div>

      <section className="overview-activity">
        <header><span>{t('overview.activity.title').toUpperCase()}</span><small>{t('overview.activity.subtitle')}</small><button type="button" onClick={() => onNavigate('scheduler')}>{t('overview.activity.openScheduler')}</button></header>
        <div>
          {activities.map(activity => (
            <button key={activity.id} type="button" onClick={() => onNavigate('scheduler')}>
              <i className={`phase-${activity.phase}`} />
              <span><strong>{activity.kind}</strong><small>{activity.displayId} · {activity.executor}</small></span>
              <em>{activity.phaseLabel}</em>
              <time>{activity.updatedAgo}</time>
            </button>
          ))}
          {activities.length === 0 && <div className="small-empty">{t('overview.activity.empty')}</div>}
        </div>
      </section>
    </section>
  )
}
