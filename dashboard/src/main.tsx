import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import './index.css'
import App from './App.tsx'
import { DashboardAuthGate } from './DashboardAuthGate.tsx'
import { DASHBOARD_BASE_PATH } from './api/deployment.ts'
import { installDashboardViewportGuard } from './app/dashboardViewport.ts'

const disposeDashboardViewportGuard = installDashboardViewportGuard()

if (import.meta.hot) {
  import.meta.hot.dispose(disposeDashboardViewportGuard)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={DASHBOARD_BASE_PATH}>
      <DashboardAuthGate>
        <App />
      </DashboardAuthGate>
    </BrowserRouter>
  </StrictMode>,
)
