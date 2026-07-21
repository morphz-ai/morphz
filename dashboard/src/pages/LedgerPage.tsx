import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Database, RefreshCw, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface LedgerEventView {
  id: string
  sequence?: number
  timestamp: string
  timeLabel: string
  actor: string
  type: string
  topic: string
  payload: Record<string, unknown>
}

export interface LedgerFilters {
  sessionId: string
  principalId: string
  threadId: string
  activationId: string
  actor: string
  topic: string
  search: string
  afterSequence: string
  startTime: string
  endTime: string
}

interface LedgerPageProps {
  contextTitle: string
  sessionTitle: string
  events: LedgerEventView[]
  scannedCount: number
  scanExhaustive: boolean
  pageNumber: number
  canLoadNewer: boolean
  canLoadOlder: boolean
  sessions: Array<{ id: string, title: string }>
  filters: LedgerFilters
  canRefresh: boolean
  onRefresh: () => void
  onApplyFilters: (filters: LedgerFilters) => void
  onLoadNewer: () => void
  onLoadOlder: () => void
  onOpenThread: (id: string) => void
  onOpenSession: (id: string) => void
  onOpenFrame: (id: string) => void
}

function shortId(value: string, size = 28) {
  return value.length <= size ? value : `…${value.slice(-(size - 1))}`
}

function payloadReference(payload: Record<string, unknown>, key: string): string | undefined {
  const direct = payload[key]
  if (typeof direct === 'string') return direct
  const route = payload.route
  if (route && typeof route === 'object') {
    const nested = (route as Record<string, unknown>)[key]
    if (typeof nested === 'string') return nested
  }
  return undefined
}

export function LedgerPage({ contextTitle, sessionTitle, events, scannedCount, scanExhaustive, pageNumber, canLoadNewer, canLoadOlder, sessions, filters, canRefresh, onRefresh, onApplyFilters, onLoadNewer, onLoadOlder, onOpenThread, onOpenSession, onOpenFrame }: LedgerPageProps) {
  const { t, i18n } = useTranslation()
  const orderedEvents = [...events].reverse()
  const [draft, setDraft] = useState(filters)

  return (
    <section className="ledger-view">
      <header className="workspace-heading">
        <div><span>{t('ledger.eyebrow').toUpperCase()}</span><h1>{t('ledger.heading')}</h1><p>{t('ledger.description')}</p></div>
        <button type="button" onClick={onRefresh} disabled={!canRefresh}><RefreshCw size={14} /> {t('ledger.refresh')}</button>
      </header>
      <div className="ledger-scope">
        <span><small>{t('header.context').toUpperCase()}</small><strong>{contextTitle}</strong></span>
        <span><small>{t('header.session').toUpperCase()}</small><strong>{sessionTitle}</strong></span>
        <span><small>{t('ledger.sequence').toUpperCase()}</small><strong>{events.length > 0 ? `${events[0]?.sequence ?? '—'}–${events.at(-1)?.sequence ?? '—'}` : '—'}</strong></span>
        <em>{t('ledger.queryNotice', { count: scannedCount, exhaustive: scanExhaustive ? t('ledger.exhaustive') : t('ledger.bounded') })}</em>
      </div>
      <form className="ledger-filters" onSubmit={event => { event.preventDefault(); onApplyFilters(draft) }}>
        <label><span>{t('ledger.filters.session')}</span><select value={draft.sessionId} onChange={event => setDraft(current => ({ ...current, sessionId: event.target.value }))}><option value="">{t('ledger.allSessions')}</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {shortId(session.id, 18)}</option>)}</select></label>
        <label><span>{t('ledger.filters.principal')}</span><input value={draft.principalId} onChange={event => setDraft(current => ({ ...current, principalId: event.target.value }))} placeholder="principal-…" /></label>
        <label><span>{t('ledger.filters.thread')}</span><input value={draft.threadId} onChange={event => setDraft(current => ({ ...current, threadId: event.target.value }))} placeholder="thread-…" /></label>
        <label><span>{t('ledger.filters.activation')}</span><input value={draft.activationId} onChange={event => setDraft(current => ({ ...current, activationId: event.target.value }))} placeholder="activation-…" /></label>
        <label><span>{t('ledger.filters.actor')}</span><input value={draft.actor} onChange={event => setDraft(current => ({ ...current, actor: event.target.value }))} placeholder={t('ledger.filters.actorPlaceholder')} /></label>
        <label><span>{t('ledger.filters.topic')}</span><input value={draft.topic} onChange={event => setDraft(current => ({ ...current, topic: event.target.value }))} placeholder="runtime/…" /></label>
        <label><span>{t('ledger.filters.afterSequence')}</span><input inputMode="numeric" value={draft.afterSequence} onChange={event => setDraft(current => ({ ...current, afterSequence: event.target.value }))} placeholder="#" /></label>
        <label><span>{t('ledger.filters.startTime')}</span><input type="datetime-local" value={draft.startTime} onChange={event => setDraft(current => ({ ...current, startTime: event.target.value }))} /></label>
        <label><span>{t('ledger.filters.endTime')}</span><input type="datetime-local" value={draft.endTime} onChange={event => setDraft(current => ({ ...current, endTime: event.target.value }))} /></label>
        <label className="ledger-search"><span>{t('ledger.filters.search')}</span><input value={draft.search} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} placeholder={t('ledger.filters.searchPlaceholder')} /></label>
        <button type="submit"><Search size={13} /> {t('ledger.filters.apply')}</button>
        <button type="button" className="secondary" onClick={() => { const empty = { sessionId: '', principalId: '', threadId: '', activationId: '', actor: '', topic: '', search: '', afterSequence: '', startTime: '', endTime: '' }; setDraft(empty); onApplyFilters(empty) }}><X size={13} /> {t('ledger.filters.clear')}</button>
      </form>
      <div className="ledger-event-list">
        {orderedEvents.map(event => (
          <details className="ledger-event" key={event.id}>
            <summary>
              <code>{event.sequence ?? '—'}</code>
              <span><strong>{event.topic}</strong><small>{event.actor} · {event.type}</small></span>
              <em>{shortId(event.id)}</em>
              <time>{event.timeLabel}</time>
              <ChevronDown size={13} />
            </summary>
            <div>
              <dl>
                <dt>{t('ledger.eventId')}</dt><dd><code>{event.id}</code></dd>
                <dt>{t('ledger.timestamp')}</dt><dd title={event.timestamp}>{new Date(event.timestamp).toLocaleString(i18n.language)}</dd>
                <dt>{t('ledger.actor')}</dt><dd>{event.actor}</dd>
                <dt>{t('ledger.topic')}</dt><dd>{event.topic}</dd>
              </dl>
              <section className="ledger-payload">
                <nav>
                  {payloadReference(event.payload, 'thread_id') && <button type="button" onClick={() => onOpenThread(payloadReference(event.payload, 'thread_id')!)}>{t('ledger.openThread')}</button>}
                  {payloadReference(event.payload, 'session_id') && <button type="button" onClick={() => onOpenSession(payloadReference(event.payload, 'session_id')!)}>{t('ledger.openSession')}</button>}
                  {payloadReference(event.payload, 'frame_id') && <button type="button" onClick={() => onOpenFrame(payloadReference(event.payload, 'frame_id')!)}>{t('ledger.openFrame')}</button>}
                </nav>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </section>
            </div>
          </details>
        ))}
        {events.length === 0 && <div className="cognition-empty-panel"><Database size={20} /><strong>{t('ledger.emptyTitle')}</strong><span>{t('ledger.emptyDescription')}</span></div>}
      </div>
      <nav className="ledger-pagination" aria-label={t('ledger.pagination.label')}>
        <button type="button" onClick={onLoadNewer} disabled={!canLoadNewer}><ChevronLeft size={13} /> {t('ledger.pagination.newer')}</button>
        <span>{t('ledger.pagination.page', { page: pageNumber })}</span>
        <button type="button" onClick={onLoadOlder} disabled={!canLoadOlder}>{t('ledger.pagination.older')} <ChevronRight size={13} /></button>
      </nav>
    </section>
  )
}
