import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '../hooks/useAuth'
import { useProfile } from '../hooks/useProfile'

/**
 * The frame around the signed-in pages.
 *
 * Separate from `PageShell` because the two audiences want opposite things: a
 * member gets one column and no navigation, while the executive secretary is
 * moving between wards, days and the admin console all evening.
 */
export function AdminShell({
  title,
  subtitle,
  actions,
  children,
  wide = false,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  const { user, signOut } = useAuth()
  const { data: profile } = useProfile()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow print:hidden">
        <div className={`mx-auto flex ${wide ? 'max-w-7xl' : 'max-w-5xl'} flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between`}>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-gray-900">{title}</h1>
            {subtitle && <div className="truncate text-sm text-gray-600">{subtitle}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            <Link
              to="/wards"
              className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Wards
            </Link>
            {profile?.is_super_admin && (
              <Link
                to="/admin"
                className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
              >
                Admin
              </Link>
            )}
            <button
              onClick={signOut}
              title={user?.email ?? undefined}
              className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Sign out
            </button>
            <ThemeToggle className="bg-gray-200" />
          </div>
        </div>
      </header>

      <main className={`mx-auto ${wide ? 'max-w-7xl' : 'max-w-5xl'} space-y-6 px-4 py-6`}>
        {children}
      </main>
    </div>
  )
}
