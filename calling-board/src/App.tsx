import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { supabase } from './lib/supabase'
import type { User } from '@supabase/supabase-js'
import { LoginPage } from './pages/LoginPage'
import { SetPasswordPage } from './pages/SetPasswordPage'
import { WardsPage } from './pages/WardsPage'
import { AdminPage } from './pages/AdminPage'
import { BoardPage } from './pages/BoardPage'

const queryClient = new QueryClient()

// How long to wait for getSession() before giving up on it. Blocked storage or
// a request that never returns can leave the promise unsettled, and without a
// deadline the app sits on "Loading..." with nothing to show the user.
const SESSION_TIMEOUT_MS = 10_000

function AppRoutes() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    // A failed OAuth redirect comes back with the reason in the URL fragment,
    // and supabase-js strips the hash as it initializes, so read it first.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const redirectError = hash.get('error_description') ?? hash.get('error')

    let settled = false
    const finish = (nextUser: User | null, message: string | null) => {
      if (settled) return
      settled = true
      if (message) console.error('[auth] sign-in failed:', message)
      setUser(nextUser)
      setAuthError(message)
      setLoading(false)
    }

    const timer = setTimeout(() => {
      finish(
        null,
        redirectError ??
          "This browser didn't finish reading your session. If it has cross-site tracking prevention or cookies blocked, allow them for this site and try again."
      )
    }, SESSION_TIMEOUT_MS)

    supabase.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        finish(session?.user ?? null, session ? null : redirectError ?? error?.message ?? null)
      })
      .catch((error: unknown) => {
        finish(null, redirectError ?? (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => clearTimeout(timer))

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
      // A reset link signs the user in before this fires, so the password form
      // has to take over the whole app until they've actually set one.
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })

    return () => {
      clearTimeout(timer)
      subscription?.unsubscribe()
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    )
  }

  if (recovering) {
    return <SetPasswordPage onDone={() => setRecovering(false)} />
  }

  return (
    <Routes>
      <Route path="/" element={user ? <Navigate to="/wards" /> : <LoginPage authError={authError} />} />
      <Route path="/wards" element={user ? <WardsPage /> : <Navigate to="/" />} />
      <Route path="/wards/:wardId/board" element={user ? <BoardPage /> : <Navigate to="/" />} />
      <Route path="/admin" element={user ? <AdminPage /> : <Navigate to="/" />} />
      <Route path="*" element={<Navigate to={user ? '/wards' : '/'} />} />
    </Routes>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
