export type AccentTheme = 'iris' | 'cyan' | 'coral' | 'mono'
export type AppearanceMode = 'system' | 'dark' | 'light'
export type ResolvedAppearanceMode = Exclude<AppearanceMode, 'system'>

export const accentThemes: Array<{ id: AccentTheme; labelKey: string; descKey: string }> = [
  { id: 'cyan', labelKey: 'theme.cyan.label', descKey: 'theme.cyan.description' },
  { id: 'iris', labelKey: 'theme.iris.label', descKey: 'theme.iris.description' },
  { id: 'coral', labelKey: 'theme.coral.label', descKey: 'theme.coral.description' },
  { id: 'mono', labelKey: 'theme.mono.label', descKey: 'theme.mono.description' },
]

export function initialAccentTheme(): AccentTheme {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.accent')
    if (accentThemes.some(theme => theme.id === saved)) return saved as AccentTheme
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'cyan'
}

export function initialAppearanceMode(): AppearanceMode {
  try {
    const saved = window.localStorage.getItem('morphz.dashboard.appearance')
    if (saved === 'system' || saved === 'dark' || saved === 'light') return saved
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'system'
}

export function initialSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

export function resolveAppearanceMode(
  appearanceMode: AppearanceMode,
  systemPrefersDark: boolean,
): ResolvedAppearanceMode {
  return appearanceMode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : appearanceMode
}
