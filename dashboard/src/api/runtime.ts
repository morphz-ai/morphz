import { DashboardApiClient } from './client'
import {
  persistDashboardToken,
  resolveDashboardToken,
  type DashboardTokenStores,
} from './auth'
import { CORE_HTTP_URL } from './deployment'

function browserTokenStores(): DashboardTokenStores {
  let persistent: Storage | undefined
  let session: Storage | undefined
  try {
    persistent = window.localStorage
  } catch {
    // Privacy-restricted documents can deny localStorage.
  }
  try {
    session = window.sessionStorage
  } catch {
    // The in-memory client token still keeps this page usable.
  }
  return { persistent, session }
}

const tokenStores = browserTokenStores()
const configuredToken = import.meta.env.VITE_MORPHZ_TOKEN as string | undefined
const initialToken = resolveDashboardToken(window.location, tokenStores, configuredToken)

export const DASHBOARD_API = new DashboardApiClient({
  baseUrl: CORE_HTTP_URL,
  token: initialToken,
})

export function getDashboardToken(): string | undefined {
  return DASHBOARD_API.currentToken()
}

export function updateDashboardToken(token: string): void {
  const normalized = token.trim()
  persistDashboardToken(normalized, tokenStores)
  DASHBOARD_API.setToken(normalized)
}
