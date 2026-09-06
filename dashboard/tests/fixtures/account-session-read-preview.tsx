// Browser regression fixture. All requests are handled in memory: no Runtime,
// real provider account, credentials or messages are accessed or modified.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'
import { DashboardApiClient } from '../../src/api/client'
import { ConversationReadError } from '../../src/App'
import { ProvidersPage } from '../../src/pages/ProvidersPage'
import { RuntimeFailureDetails } from '../../src/components/RuntimeFailureDetails'

void i18n.changeLanguage(new URLSearchParams(location.search).get('language') ?? 'zh')
let enabled = true
let authenticated = true
let revision = 1
const api = new DashboardApiClient({
  baseUrl: 'http://fixture.invalid',
  fetchImpl: async (url, options) => {
    const path = new URL(String(url)).pathname
    let body: unknown
    if (options?.method === 'PATCH') {
      const action = JSON.parse(String(options.body)).action
      if (!['enable', 'disable'].includes(action)) throw new Error('Unexpected fixture action')
      enabled = action === 'enable'
      revision += 1
      body = { revision }
    } else if (options?.method === 'POST' && path.endsWith('/oauth/logout')) {
      authenticated = false
      body = { deleted: true }
    } else if (path.endsWith('/attempts')) body = []
    else if (path.endsWith('/oauth/services')) body = { services: [] }
    else if (path === '/api/runtime/providers') body = {
      generated_at: '', selected_model_alias: '', allowed_evaluation_models: [],
      permission_mode: '', reviewer: '', auth_adapters: [], provider_instances: {},
      model_routes: {}, discovered_models: [], auth_accounts: {
        'fixture-oauth': {
          config: { enabled: true, auth_adapter: 'antigravity-oauth', provider: 'antigravity-subscription', label: '回归测试账户', credential_ref: '' },
          effective_enabled: enabled, oauth: true, authenticated,
          state: { account_id: 'fixture-oauth', revision, status: authenticated ? (enabled ? 'ready' : 'disabled') : 'revoked' },
          oauth_metadata: authenticated ? { account_id: 'fixture-oauth', email: 'fixture@example.test', scopes: [] } : undefined,
        },
      },
    }
    else throw new Error(`Unexpected fixture path: ${path}`)
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  },
})

export function Preview() {
  const [failed, setFailed] = useState(true)
  const [retries, setRetries] = useState(0)
  return (
    <main className="page-shell" data-accent="cyan" data-color-mode="dark" style={{ height: '100vh', overflow: 'auto', padding: 24, color: 'var(--text)' }}>
      <h2>隔离回归：不连接真实服务</h2>
      <section aria-label="持久化模型错误">
        <p>模型请求失败，正在等待配置恢复。</p>
        <RuntimeFailureDetails payload={{ runtime_failure_error: "Agent 'default-agent' has no Provider Account binding; configure an account before evaluation" }} />
        <button type="button" onClick={() => setRetries(value => value + 1)}>模拟重试</button>
        <p>后续尝试：{retries}</p>
      </section>
      <section aria-label="会话读取回归">
        {failed ? <ConversationReadError message="HTTP 403 · 无权读取此会话，不是空会话。" onRetry={() => setFailed(false)} />
          : <p role="status">已重新加载：子任务的历史消息。</p>}
      </section>
      <ProvidersPage api={api} />
    </main>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
