import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { KeyRound, LoaderCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { DashboardApiError } from './api/client'
import { CORE_HTTP_URL } from './api/deployment'
import { DASHBOARD_API, updateDashboardToken } from './api/runtime'

export function DashboardAuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [authenticationRequired, setAuthenticationRequired] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [credentialError, setCredentialError] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [attempt, setAttempt] = useState(0)
  const tokenInputRef = useRef<HTMLInputElement>(null)

  const requireAuthentication = useCallback((error: DashboardApiError) => {
    setReady(false)
    setChecking(false)
    setConnectionError('')
    setCredentialError(DASHBOARD_API.currentToken() ? error.message : '')
    setAuthenticationRequired(true)
  }, [])

  useEffect(() => {
    DASHBOARD_API.setUnauthorizedHandler(requireAuthentication)
    return () => DASHBOARD_API.setUnauthorizedHandler(undefined)
  }, [requireAuthentication])

  useEffect(() => {
    let cancelled = false
    void DASHBOARD_API.get('/api/status').then(() => {
      if (cancelled) return
      setReady(true)
      setAuthenticationRequired(false)
      setCredentialError('')
    }).catch(reason => {
      if (cancelled) return
      if (reason instanceof DashboardApiError && reason.status === 401) {
        requireAuthentication(reason)
        return
      }
      setReady(false)
      setChecking(false)
      setConnectionError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setChecking(false)
    })
    return () => { cancelled = true }
  }, [attempt, requireAuthentication])

  useEffect(() => {
    if (authenticationRequired) tokenInputRef.current?.focus()
  }, [authenticationRequired])

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = tokenDraft.trim()
    if (!token) return
    updateDashboardToken(token)
    setTokenDraft('')
    setCredentialError('')
    setAuthenticationRequired(false)
    setChecking(true)
    setConnectionError('')
    setAttempt(current => current + 1)
  }

  const retryConnection = () => {
    setChecking(true)
    setConnectionError('')
    setAttempt(current => current + 1)
  }

  if (ready) return children

  return (
    <main className="dashboard-auth-shell">
      <section className="dashboard-auth-card" aria-live="polite">
        <span className="dashboard-auth-mark"><KeyRound size={22} /></span>
        <small>MORPHZ</small>
        <h1>{t('authentication.title')}</h1>
        {checking ? (
          <div className="dashboard-auth-progress" role="status">
            <LoaderCircle size={16} />
            <span>{t('authentication.connecting')}</span>
          </div>
        ) : authenticationRequired ? (
          <form onSubmit={submitToken}>
            <p>{t('authentication.description')}</p>
            <label>
              <span>{t('authentication.tokenLabel')}</span>
              <input
                ref={tokenInputRef}
                autoComplete="current-password"
                name="morphz-dashboard-token"
                placeholder={t('authentication.tokenPlaceholder')}
                type="password"
                value={tokenDraft}
                onChange={event => setTokenDraft(event.target.value)}
              />
            </label>
            {credentialError && <p className="dashboard-auth-error" role="alert">{t('authentication.invalidToken')}</p>}
            <button className="primary" disabled={!tokenDraft.trim()} type="submit">
              {t('authentication.connect')}
            </button>
            <small className="dashboard-auth-endpoint">{CORE_HTTP_URL}</small>
          </form>
        ) : (
          <div className="dashboard-auth-failure" role="alert">
            <p>{t('authentication.connectionFailed')}</p>
            {connectionError && <code>{connectionError}</code>}
            <button type="button" onClick={retryConnection}>
              <RefreshCw size={14} /> {t('authentication.retry')}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
