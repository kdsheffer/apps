import { useEffect, useState } from 'react'
import {
  applyTheme,
  onSystemThemeChange,
  resolveTheme,
  saveTheme,
  storedTheme,
  type Theme,
} from '../lib/theme'

// The toggle can appear on more than one header at a time, so every hook
// instance reads and writes the same value instead of keeping its own.
const subscribers = new Set<(theme: Theme) => void>()

function publish(theme: Theme) {
  applyTheme(theme)
  subscribers.forEach((notify) => notify(theme))
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveTheme)

  useEffect(() => {
    subscribers.add(setTheme)
    return () => {
      subscribers.delete(setTheme)
    }
  }, [])

  useEffect(() => {
    // Until the user picks a side, follow the OS if it changes mid-session.
    return onSystemThemeChange((next) => {
      if (!storedTheme()) publish(next)
    })
  }, [])

  return {
    theme,
    toggleTheme: () => {
      const next: Theme = theme === 'dark' ? 'light' : 'dark'
      saveTheme(next)
      publish(next)
    },
  }
}
