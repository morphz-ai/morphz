import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import './index.css'
import App from './App.tsx'
import { DashboardAuthGate } from './DashboardAuthGate.tsx'
import { DASHBOARD_BASE_PATH } from './api/deployment.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={DASHBOARD_BASE_PATH}>
      <DashboardAuthGate>
        <App />
      </DashboardAuthGate>
    </BrowserRouter>
  </StrictMode>,
)
