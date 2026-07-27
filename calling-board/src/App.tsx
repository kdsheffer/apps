import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { supabase } from './lib/supabase'
import type { User } from '@supabase/supabase-js'
import { LoginPage } from './pages/LoginPage'
import { WardsPage } from './pages/WardsPage'
import { AdminPage } from './pages/AdminPage'
import { BoardPage } from './pages/BoardPage'

const queryClient = new QueryClient()

function AppRoutes() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
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
