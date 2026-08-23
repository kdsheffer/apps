import type { ReactNode } from 'react'
import { ThemeToggle } from './ThemeToggle'

/**
 * The frame around the pages a member sees.
 *
 * Kept separate from the admin chrome because the two have opposite jobs: this
 * one is a single narrow column with no navigation at all, since a member
 * arrives from a link with one thing to do and nowhere else to go.
 */
export function PageShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{title}</h1>
            {subtitle && <div className="mt-2 text-gray-600">{subtitle}</div>}
          </div>
          <ThemeToggle className="-mr-2 shrink-0" />
        </header>

        {children}

        {footer && <footer className="mt-10 text-sm text-gray-500">{footer}</footer>}
      </div>
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg bg-white p-6 shadow ${className}`}>{children}</section>
  )
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success' | 'info'
  children: ReactNode
}) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-green-200 bg-green-50 text-green-800',
    info: 'border-blue-200 bg-blue-50 text-blue-800',
  }
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded border p-4 ${tones[tone]}`}>
      {children}
    </div>
  )
}
