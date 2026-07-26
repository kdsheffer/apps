import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4">
          <h1 className="text-3xl font-bold text-gray-900">Calling Board</h1>
          <p className="text-gray-600 mt-2">Ward calling management system (Phase 0 Scaffold)</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-12 px-4">
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-lg text-gray-700 mb-4">
            Welcome to Calling Board. The app is under development.
          </p>
          <button
            onClick={() => setCount(count + 1)}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded"
          >
            Count is {count}
          </button>
          <p className="text-gray-500 text-sm mt-6">
            Next: Phase 1 — Database schema & RLS
          </p>
        </div>
      </main>
    </div>
  )
}

export default App
