import { useTranslation } from 'react-i18next'

export function RuntimeFailureDetails({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useTranslation()
  const error = typeof payload.runtime_failure_error === 'string' ? payload.runtime_failure_error.trim() : ''
  // Terminal notices can already include the original error in their body.
  if (!error || (typeof payload.text === 'string' && payload.text.includes(error))) return null
  return (
    <details className="runtime-failure-details" open>
      <summary>{t('conversation.failureDetails')}</summary>
      <pre>{error}</pre>
    </details>
  )
}
