import { useAuth } from '../hooks/useAuth'
import { useWards } from '../hooks/useWards'
import { useNavigate } from 'react-router-dom'

export function WardsPage() {
  const { user, signOut } = useAuth()
  const { data: wards, isLoading, error } = useWards()
  const navigate = useNavigate()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading wards...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-4 px-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Calling Board</h1>
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
            Error loading wards: {error.message}
          </div>
        )}

        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Select a Ward</h2>
          {!wards || wards.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-6 text-center text-gray-600">
              <p>No wards available. Contact an administrator to be added to a ward.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {wards.map((ward) => (
                <button
                  key={ward.id}
                  onClick={() => navigate(`/wards/${ward.id}/board`)}
                  className="bg-white rounded-lg shadow hover:shadow-lg p-6 text-left transition"
                >
                  <h3 className="text-lg font-semibold text-gray-900">{ward.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {new Date(ward.created_at).toLocaleDateString()}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
          <p className="font-semibold">Phase 2 Status:</p>
          <p className="mt-1">Auth UI is working. Next: Phase 3 — Ward & permission admin.</p>
        </div>
      </main>
    </div>
  )
}
