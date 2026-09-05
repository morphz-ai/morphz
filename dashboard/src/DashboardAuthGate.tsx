import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Globe, KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BrandMark } from './BrandMark'

import { DashboardApiError } from './api/client'
import { CORE_HTTP_URL } from './api/deployment'
import { DASHBOARD_API, updateDashboardToken } from './api/runtime'
import {
  initialAccentTheme,
  initialAppearanceMode,
  initialSystemPrefersDark,
  resolveAppearanceMode,
} from './app/themePreferences'
import { nextDashboardLanguage, persistDashboardLanguage } from './i18n/language'

export function DashboardAuthGate({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation()
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [authenticationRequired, setAuthenticationRequired] = useState(false)
  const [credentialError, setCredentialError] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [accentTheme] = useState(initialAccentTheme)
  const [appearanceMode] = useState(initialAppearanceMode)
  const [systemPrefersDark, setSystemPrefersDark] = useState(initialSystemPrefersDark)
  const tokenInputRef = useRef<HTMLInputElement>(null)
  const resolvedAppearanceMode = resolveAppearanceMode(appearanceMode, systemPrefersDark)
  const currentLanguageCode = i18n.language?.startsWith('zh') ? 'ZH' : 'EN'

  const requireAuthentication = useCallback((error: DashboardApiError) => {
    setReady(false)
    setChecking(false)
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
    }).finally(() => {
      if (!cancelled) setChecking(false)
    })
    return () => { cancelled = true }
  }, [attempt, requireAuthentication])

  useEffect(() => {
    if (authenticationRequired) tokenInputRef.current?.focus()
  }, [authenticationRequired])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.colorMode = resolvedAppearanceMode
    document.documentElement.style.colorScheme = resolvedAppearanceMode
  }, [resolvedAppearanceMode])

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = tokenDraft.trim()
    if (!token) return
    updateDashboardToken(token)
    setTokenDraft('')
    setCredentialError('')
    setAuthenticationRequired(false)
    setChecking(true)
    setAttempt(current => current + 1)
  }

  const retryConnection = () => {
    setChecking(true)
    setAttempt(current => current + 1)
  }

  if (ready) return children

  return (
    <main
      className="page-shell dashboard-auth-shell"
      data-accent={accentTheme}
      data-color-mode={resolvedAppearanceMode}
    >
      <section className="dashboard-auth-frame">
        <header className="dashboard-auth-header">
          <span className="dashboard-auth-brand">
            <BrandMark />
            <span><strong>Morphz</strong><small>{t('header.machineTagline')}</small></span>
          </span>
          <span className="dashboard-auth-actions">
            <span className="dashboard-auth-plane"><ShieldCheck size={13} />{t('authentication.operatorPlane')}</span>
            <button
              aria-label={t('language.toggle')}
              className="dashboard-auth-language"
              title={t('language.toggle')}
              type="button"
              onClick={() => {
                const language = nextDashboardLanguage(i18n.language)
                persistDashboardLanguage(language)
                void i18n.changeLanguage(language)
              }}
            >
              <Globe size={13} />
              <span>{currentLanguageCode}</span>
            </button>
          </span>
        </header>
        <div className="dashboard-auth-stage">
          <section className="dashboard-auth-card" aria-live="polite">
            <header>
              <span className="dashboard-auth-mark"><KeyRound size={19} /></span>
              <span><small>{t('authentication.eyebrow')}</small><h1>{t('authentication.title')}</h1></span>
            </header>
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
                <footer>
                  <small className="dashboard-auth-endpoint">{CORE_HTTP_URL}</small>
                  <button className="primary" disabled={!tokenDraft.trim()} type="submit">
                    {t('authentication.connect')}
                  </button>
                </footer>
              </form>
            ) : (
              <div className="dashboard-auth-failure" role="alert">
                <p>{t('authentication.connectionFailed')}</p>
                <small className="dashboard-auth-endpoint">{CORE_HTTP_URL}</small>
                <button type="button" onClick={retryConnection}>
                  <RefreshCw size={14} /> {t('authentication.retry')}
                </button>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}
