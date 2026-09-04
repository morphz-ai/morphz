import { useState } from 'react'
import { GitBranch, Info, Target, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { shortId } from '../app/presentation'
import type { InputSelection } from '../app/steering'

/** A destination is composer metadata, not another message or card heading. */
export function SteeringTarget({ selection, onClear }: {
  selection: InputSelection
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [showHint, setShowHint] = useState(false)
  const thread = selection.destination.kind === 'thread'
  const id = selection.destination.kind === 'thread'
    ? selection.destination.thread_id : selection.destination.objective_id
  const compactId = shortId(id)
  const tooltip = `${selection.label}\n${id}`
  return <div className="composer-steering" role="status">
    <span className="composer-steering-chip" title={tooltip}>
      {thread ? <GitBranch size={12} aria-hidden="true" /> : <Target size={12} aria-hidden="true" />}
      <code>@{compactId}</code>
      <button type="button" title={t('steering.clear')} aria-label={t('steering.clear')} onClick={onClear}><X size={12} /></button>
    </span>
    <button className="composer-steering-info" type="button" title={t('steering.safeBoundary')}
      aria-label={t('steering.safeBoundary')} aria-expanded={showHint}
      onClick={() => setShowHint(value => !value)}><Info size={13} /></button>
    {showHint && <small className="composer-steering-hint">{t('steering.safeBoundary')}</small>}
  </div>
}
