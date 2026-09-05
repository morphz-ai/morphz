// Isolated visual fixture: real brand/auth components and styles, no Runtime.
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { BrandMark } from '../../src/BrandMark'
import '../../src/i18n'
import '../../src/index.css'
import '../../src/App.css'

window.fetch = async () => new Response(JSON.stringify({
  error: { code: 'unauthorized', message: '' },
}), { status: 401, headers: { 'Content-Type': 'application/json' } })
// The API client captures fetch on import; install the fixture transport first.
const { DashboardAuthGate } = await import('../../src/DashboardAuthGate')

export function BrandPreview() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'dark' | 'light'>('dark')
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Preview both production theme selectors without saving user preferences.
    const authShell = rootRef.current?.querySelector<HTMLElement>('.dashboard-auth-shell')
    if (authShell) authShell.dataset.colorMode = mode
  }, [mode])
  return (
    <div ref={rootRef} className="brand-preview page-shell" data-accent="cyan" data-color-mode={mode}>
      <style>{`
        .brand-preview { height: 100%; overflow: auto; padding: 20px; color: var(--text); background: var(--bg); }
        .brand-preview .preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
        .brand-preview .preview-toolbar button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; }
        .brand-preview .preview-brand { display: flex; align-items: center; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
        .brand-preview .preview-sizes { display: flex; align-items: end; gap: 24px; margin: 24px 0; }
        .brand-preview .preview-sizes figure { display: grid; gap: 12px; justify-items: center; margin: 0; font: 11px var(--mono); }
        .brand-preview .dashboard-auth-shell { min-height: 500px; height: auto; padding: 0; }
        .brand-preview .dashboard-auth-frame { width: 100%; max-width: 880px; }
        .brand-preview[data-color-mode="light"] .dashboard-auth-shell { color-scheme: light; }
        @media (max-width: 640px) { .brand-preview { padding: 12px; } }
      `}</style>
      <div className="preview-toolbar">
        <span>品牌图标预览 · 不连接运行时</span>
        <button onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>{mode === 'dark' ? '浅色' : '深色'}</button>
      </div>
      <header className="preview-brand">
        <button className="brand" type="button">
          <BrandMark />
          <span><strong>Morphz</strong><small>{t('header.machineTagline')}</small></span>
        </button>
      </header>
      <section className="preview-sizes" aria-label="小尺寸图标">
        {[16, 20, 24, 32].map(size => (
          <figure key={size}>
            <img src="./favicon.svg?brand=cyan-butterfly" alt="Morphz" width={size} height={size} />
            <figcaption>{size}px</figcaption>
          </figure>
        ))}
      </section>
      <DashboardAuthGate><span /></DashboardAuthGate>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<BrandPreview />)
