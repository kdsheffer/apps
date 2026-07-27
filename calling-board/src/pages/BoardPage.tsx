import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useBoard } from '../hooks/useBoard'
import { useBoardData } from '../hooks/useBoardData'
import { formatTimeInCalling } from '../lib/timeInCalling'

export function BoardPage() {
  const { wardId } = useParams<{ wardId: string }>()
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const { data: board, isLoading: boardLoading, error: boardError } = useBoard(wardId || '')
  const { data: boardData, isLoading: dataLoading } = useBoardData(board?.id)

  if (!wardId) {
    return <div className="text-center py-8">Ward not found</div>
  }

  if (boardLoading || dataLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-600">Loading board...</div>
      </div>
    )
  }

  if (boardError || !board) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 mb-4">No promoted board found for this ward.</p>
          <button
            onClick={() => navigate('/wards')}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium"
          >
            Back to Wards
          </button>
        </div>
      </div>
    )
  }

  const groupedPositions = boardData?.groups.map((group) => ({
    group,
    positions: (boardData?.positions || []).filter((p) => {
      const position = boardData?.positions.find((pos) => pos.id === p.id)
      const posGroup = boardData?.groups.find((g) => g.id === position?.group_id)
      return posGroup?.id === group.id
    }),
  })) || []

  const getMembersForPosition = (positionId: string) => {
    const assignments = boardData?.assignments.filter((a) => a.position_id === positionId) || []
    return assignments.map((a) => {
      const member = boardData?.members.find((m) => m.id === a.member_id)
      return { member, assignment: a }
    })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-4 px-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Calling Board</h1>
            <p className="text-sm text-gray-600">{board.name}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate('/wards')}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium"
            >
              Back to Wards
            </button>
            <button
              onClick={signOut}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-12 px-4">
        <div className="space-y-8">
          {groupedPositions.map(({ group, positions }) => (
            <div key={group.id} className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-6">{group.name}</h2>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {positions.map((position) => {
                  const members = getMembersForPosition(position.id)
                  const isOpen = members.length === 0

                  return (
                    <div
                      key={position.id}
                      className="border border-gray-200 rounded-lg p-4 bg-gray-50 hover:bg-gray-100 transition"
                    >
                      <h3 className="font-semibold text-gray-900 mb-3">{position.title}</h3>

                      {isOpen ? (
                        <div className="text-center py-6 text-gray-500">
                          <p className="text-sm">Open Calling</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {members.map(({ member, assignment }) => (
                            <div
                              key={assignment.id}
                              className="bg-white rounded p-3 border border-blue-200 shadow-sm"
                            >
                              <p className="font-medium text-gray-900">{member?.full_name}</p>
                              <p className="text-xs text-gray-500">
                                {formatTimeInCalling(assignment.called_date)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
          <p className="font-semibold">Phase 4 Status:</p>
          <p className="mt-1">Read-only board view working. Next: Phase 5 — Editing (drag-and-drop, CRUD).</p>
        </div>
      </main>
    </div>
  )
}
