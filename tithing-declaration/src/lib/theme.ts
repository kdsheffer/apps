export type Theme = 'light' | 'dark'

// Kept in sync with the boot script in index.html, which applies the same class
// before React mounts so the page never flashes the wrong theme.
export const THEME_STORAGE_KEY = 'tithing-declaration:theme'

const systemQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

/** The saved choice, or null when the user has never picked one. */
export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    // Private-mode storage can throw on read; fall back to the system setting.
    return null
  }
}

export function systemTheme(): Theme {
  return systemQuery().matches ? 'dark' : 'light'
}

export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme()
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Not being able to remember the choice shouldn't break switching it.
  }
}

/** Fires while the user has no explicit choice, so the app follows the OS. */
export function onSystemThemeChange(listener: (theme: Theme) => void) {
  const query = systemQuery()
  const handler = (event: MediaQueryListEvent) => listener(event.matches ? 'dark' : 'light')
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}
