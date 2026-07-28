import { useState } from 'react'
import { supabase } from '../lib/supabase'

type Mode = 'signin' | 'signup'

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reset = () => {
    setError(null)
    setNotice(null)
  }

  const handleGoogleSignIn = async () => {
    setLoading(true)
    reset()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}`,
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  const handleEmailSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    reset()

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      // The session lands through onAuthStateChange, so there's nothing to do
      // on success — the app swaps to the ward list on its own.
      if (error) setError(error.message)
      setLoading(false)
      return
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}` },
    })

    if (error) {
      setError(error.message)
    } else if (data.session) {
      // Email confirmation is switched off for this project; already signed in.
      setNotice(null)
    } else {
      setNotice(
        `Check ${email} for a confirmation link. You'll be able to sign in once you've clicked it.`
      )
    }
    setLoading(false)
  }

  const handleForgotPassword = async () => {
    reset()
    if (!email.trim()) {
      setError('Enter your email address first, then choose "Forgot password".')
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}`,
    })
    if (error) setError(error.message)
    else setNotice(`If an account exists for ${email}, a reset link is on its way.`)
    setLoading(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-10">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Calling Board</h1>
          <p className="mt-2 text-gray-600">Ward calling management</p>
        </div>

        {error && (
          <div className="mb-6 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {notice && (
          <div className="mb-6 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
            {notice}
          </div>
        )}

        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-3 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="currentColor"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="currentColor"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="currentColor"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Sign in with Google
        </button>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-gray-200" />
          <span className="text-xs uppercase tracking-wide text-gray-400">or</span>
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {mode === 'signup' && (
              <p className="mt-1 text-xs text-gray-500">At least 8 characters.</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading
              ? 'Working…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              reset()
            }}
            className="text-blue-600 hover:underline"
          >
            {mode === 'signin' ? 'Create an account' : 'Have an account? Sign in'}
          </button>

          {mode === 'signin' && (
            <button
              onClick={handleForgotPassword}
              disabled={loading}
              className="text-gray-500 hover:text-gray-700 hover:underline disabled:opacity-50"
            >
              Forgot password?
            </button>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">
          A new account can't see any board until a ward admin grants it access.
        </p>
      </div>
    </div>
  )
}
