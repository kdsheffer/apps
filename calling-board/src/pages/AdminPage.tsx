import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useWards } from '../hooks/useWards'
import { supabase } from '../lib/supabase'

export function AdminPage() {
  const { user, signOut } = useAuth()
  const { data: wards, refetch: refetchWards } = useWards()
  const [newWardName, setNewWardName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    const checkAdmin = async () => {
      if (!user) return

      try {
        const { data, error: err } = await supabase
          .from('profiles')
          .select('is_super_admin')
          .eq('id', user.id)
          .single()

        if (err) {
          console.error('Admin check error:', err)
          setIsAdmin(false)
        } else {
          setIsAdmin(data?.is_super_admin ?? false)
        }
      } catch (e) {
        console.error('Unexpected error:', e)
        setIsAdmin(false)
      }
    }

    checkAdmin()
  }, [user])

  if (isAdmin === null) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 mb-4">You do not have admin access.</p>
          <button
            onClick={signOut}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium"
          >
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  const handleCreateWard = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newWardName.trim() || !user) return

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const { data, error: err } = await supabase
        .from('wards')
        .insert([
          {
            name: newWardName,
            created_by: user.id,
          },
        ])
        .select()

      if (err) throw err

      setNewWardName('')
      setSuccess(`Ward "${newWardName}" created successfully`)
      refetchWards()

      // Grant self as admin for the new ward
      if (data && data[0]) {
        await supabase.from('ward_admins').insert([
          {
            ward_id: data[0].id,
            user_id: user.id,
            granted_by: user.id,
          },
        ])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ward')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-4 px-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin Console</h1>
            <p className="text-sm text-gray-600">{user?.email}</p>
          </div>
          <button
            onClick={signOut}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-12 px-4">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded text-green-700">
            {success}
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {/* Create Ward Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Create Ward</h2>
            <form onSubmit={handleCreateWard} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ward Name
                </label>
                <input
                  type="text"
                  value={newWardName}
                  onChange={(e) => setNewWardName(e.target.value)}
                  placeholder="e.g., Salt Lake City 1st Ward"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={loading || !newWardName.trim()}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Ward'}
              </button>
            </form>
          </div>

          {/* Wards List Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Wards</h2>
            {!wards || wards.length === 0 ? (
              <p className="text-gray-600">No wards created yet.</p>
            ) : (
              <div className="space-y-2">
                {wards.map((ward) => (
                  <div
                    key={ward.id}
                    className="p-3 bg-gray-50 rounded border border-gray-200 hover:border-blue-300"
                  >
                    <p className="font-medium text-gray-900">{ward.name}</p>
                    <p className="text-xs text-gray-500">{ward.id}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
          <p className="font-semibold">Phase 3 Status:</p>
          <p className="mt-1">
            Ward creation working. Next: Grant ward_admin permissions to users, then re-enable RLS.
          </p>
        </div>
      </main>
    </div>
  )
}
