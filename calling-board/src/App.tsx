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

function AppRoutes() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
      // A reset link signs the user in before this fires, so the password form
      // has to take over the whole app until they've actually set one.
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })

    return () => subscription?.unsubscribe()
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
      <Route path="/" element={user ? <Navigate to="/wards" /> : <LoginPage />} />
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
