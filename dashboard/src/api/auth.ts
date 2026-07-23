export const DASHBOARD_TOKEN_STORAGE_KEY = 'morphz.dashboard.auth-token'

export interface DashboardLocationLike {
  search: string
  hash: string
}

export interface DashboardTokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
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

/** Resolve one stable credential for HTTP and WebSocket transports.
 *
 * A launch URL is only a credential hand-off.  React Router replaces its
 * query string as users navigate, so the token is copied into sessionStorage
 * immediately and survives route changes and refreshes in this tab.  It is
 * intentionally not stored in localStorage, which would extend a generated
 * bearer token beyond the browser session that received it.
 */
export function resolveDashboardToken(
  location: DashboardLocationLike,
  storage: DashboardTokenStorage | undefined,
  configuredToken?: string,
): string | undefined {
  const launchToken = dashboardTokenFromLocation(location)
  if (launchToken) {
    try {
      storage?.setItem(DASHBOARD_TOKEN_STORAGE_KEY, launchToken)
    } catch {
      // Storage can be disabled; the current page can still use the URL token.
    }
    return launchToken
  }

  try {
    const saved = nonEmptyToken(storage?.getItem(DASHBOARD_TOKEN_STORAGE_KEY))
    if (saved) return saved
  } catch {
    // Fall through to a build-time credential when storage is unavailable.
  }
  return nonEmptyToken(configuredToken)
}
