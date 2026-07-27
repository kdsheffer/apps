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
        <div className="max-w-7xl mx-auto py-4 px-4 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">Calling Board</h1>
            <p className="text-sm text-gray-600 truncate">{user?.email}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <a
              href="/admin"
              className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-white font-medium text-center sm:flex-none"
            >
              Admin
            </a>
            <button
              onClick={signOut}
              className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium sm:flex-none"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 px-4 sm:py-12">
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
                <div
                  key={ward.id}
                  className="bg-white rounded-lg shadow hover:shadow-lg p-6 transition cursor-pointer"
                  onClick={() => navigate(`/wards/${ward.id}/board`)}
                >
                  <h3 className="text-lg font-semibold text-gray-900">{ward.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {new Date(ward.created_at).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-gray-400 mt-2">Click to view board</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
