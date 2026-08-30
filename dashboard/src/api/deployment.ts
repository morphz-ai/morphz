/**
 * Deployment paths are supplied by the document's `<base>` element. The
 * embedded Runtime rewrites that element from MORPHZ_DASHBOARD_BASE_PATH, so
 * one Dashboard artifact can run at `/`, `/console/`, or behind a deeper
 * reverse-proxy prefix without a cloud-specific rebuild.
 */
export function normalizeDashboardBasePath(pathname: string | null | undefined): string {
  const trimmed = pathname?.trim() ?? ''
  if (!trimmed || trimmed === '.' || trimmed === './' || trimmed === '/') return '/'

  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const collapsed = prefixed.replace(/\/{2,}/g, '/')
  const withoutTrailingSlash = collapsed.replace(/\/+$/, '')
  return withoutTrailingSlash || '/'
}

export function dashboardBasePathFromUri(baseUri: string): string {
  return normalizeDashboardBasePath(new URL(baseUri).pathname)
}

export function dashboardHttpBaseUrl(origin: string, basePath: string): string {
  const normalizedOrigin = origin.replace(/\/+$/, '')
  const normalizedBasePath = normalizeDashboardBasePath(basePath)
  return normalizedBasePath === '/'
    ? normalizedOrigin
    : `${normalizedOrigin}${normalizedBasePath}`
}

export function dashboardWebSocketUrl(httpBaseUrl: string): string {
  const url = new URL(`${httpBaseUrl.replace(/\/+$/, '')}/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString().replace(/\/$/, '')
}

const moduleEnvironment = (import.meta as ImportMeta & {
  env?: Record<string, string | undefined>
}).env
const configuredHttpUrl = moduleEnvironment?.VITE_MORPHZ_HTTP_URL
const configuredWsUrl = moduleEnvironment?.VITE_MORPHZ_WS_URL
const browserBaseUri = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
const browserOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin

export const DASHBOARD_BASE_PATH = dashboardBasePathFromUri(browserBaseUri)
export const CORE_HTTP_URL = configuredHttpUrl?.replace(/\/+$/, '')
  ?? dashboardHttpBaseUrl(browserOrigin, DASHBOARD_BASE_PATH)
export const CORE_WS_URL = configuredWsUrl?.replace(/\/+$/, '')
  ?? dashboardWebSocketUrl(CORE_HTTP_URL)
