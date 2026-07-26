export const DASHBOARD_TOKEN_STORAGE_KEY = 'morphz.dashboard.auth-token'

export interface DashboardLocationLike {
  search: string
  hash: string
}

export interface DashboardTokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export interface DashboardTokenStores {
  /** Survives a browser/tab process restart for the same origin. */
  persistent?: DashboardTokenStorage
  /** Previous storage scope and fallback for restricted browsers. */
  session?: DashboardTokenStorage
}

function nonEmptyToken(value: string | null | undefined): string | undefined {
  const token = value?.trim()
  return token ? token : undefined
}

/** Read launch credentials from both supported URL forms.
 *
 * `?token=...` is used by the embedded Dashboard launcher.  The hash form is
 * retained for direct/static deployments and accepts both `#token=...` and a
 * routed `#/path?token=...` fragment.
 */
export function dashboardTokenFromLocation(location: DashboardLocationLike): string | undefined {
  const queryToken = nonEmptyToken(new URLSearchParams(location.search).get('token'))
  if (queryToken) return queryToken

  const hash = location.hash.replace(/^#/, '')
  const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash
  return nonEmptyToken(new URLSearchParams(hashQuery).get('token'))
}

function tokenFromStorage(storage: DashboardTokenStorage | undefined): string | undefined {
  try {
    return nonEmptyToken(storage?.getItem(DASHBOARD_TOKEN_STORAGE_KEY))
  } catch {
    return undefined
  }
}

function persistDashboardToken(token: string, stores: DashboardTokenStores): void {
  try {
    if (stores.persistent) {
      stores.persistent.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token)
      try {
        stores.session?.removeItem?.(DASHBOARD_TOKEN_STORAGE_KEY)
      } catch {
        // The persistent copy is authoritative; stale session data is harmless.
      }
      return
    }
  } catch {
    // Some privacy-restricted documents deny localStorage. Keep this tab usable.
  }

  try {
    stores.session?.setItem(DASHBOARD_TOKEN_STORAGE_KEY, token)
  } catch {
    // The current page can still use a token delivered in its URL.
  }
}

/** Resolve one stable credential for HTTP and WebSocket transports.
 *
 * A launch URL is only a credential hand-off.  React Router replaces its
 * query string as users navigate, so the token is copied into origin-scoped
 * persistent storage. This also survives mobile browsers discarding a
 * background tab and later recreating its page session. The old
 * sessionStorage value is accepted once and promoted during upgrades.
 */
export function resolveDashboardToken(
  location: DashboardLocationLike,
  stores: DashboardTokenStores,
  configuredToken?: string,
): string | undefined {
  const launchToken = dashboardTokenFromLocation(location)
  if (launchToken) {
    persistDashboardToken(launchToken, stores)
    return launchToken
  }

  const persistentToken = tokenFromStorage(stores.persistent)
  if (persistentToken) return persistentToken

  const sessionToken = tokenFromStorage(stores.session)
  if (sessionToken) {
    persistDashboardToken(sessionToken, stores)
    return sessionToken
  }

  return nonEmptyToken(configuredToken)
}
