import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useBoard } from '../hooks/useBoard'
import { useBoardData } from '../hooks/useBoardData'
import { useBoardMutations } from '../hooks/useBoardMutations'
import { useBoardVersioning } from '../hooks/useBoardVersioning'
import { useRealtimeSync } from '../hooks/useRealtimeSync'
import { usePresence } from '../hooks/usePresence'
import { formatTimeInCalling } from '../lib/timeInCalling'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { BoardVersioning } from '../components/BoardVersioning'
import { ActiveUsers } from '../components/ActiveUsers'
import type { Group, Position, Member } from '../types'

export function BoardPage() {
  const { wardId } = useParams<{ wardId: string }>()
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const { data: board, isLoading: boardLoading, error: boardError } = useBoard(wardId || '')
  const { isLoading: dataLoading } = useBoardData(board?.id)
  const versioning = useBoardVersioning(wardId || '')

  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null)

  // Determine which board to edit
  const editingBoardId = currentBoardId || board?.id || ''

  // Enable realtime sync for the editing board
  useRealtimeSync(editingBoardId)

  // Track active users viewing this board
  const { activeUsers } = usePresence(editingBoardId)
  const mutations = useBoardMutations(editingBoardId)
  const { data: editingBoardData, isLoading: editingDataLoading } = useBoardData(editingBoardId)

  const [newGroupName, setNewGroupName] = useState('')
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string } | null>(null)
  const [editingPosition, setEditingPosition] = useState<{ id: string; title: string } | null>(null)
  const [editingAssignmentDate, setEditingAssignmentDate] = useState<{
    id: string
    date: string
  } | null>(null)
  const [newMemberName, setNewMemberName] = useState('')

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean
    title: string
    message: string
    action: (() => Promise<void>) | null
  }>({
    isOpen: false,
    title: '',
    message: '',
    action: null,
  })

  if (!wardId) {
    return <div className="text-center py-8">Ward not found</div>
  }

  if (boardLoading || dataLoading || editingDataLoading) {
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

  const groupedPositions = editingBoardData?.groups.map((group) => ({
    group,
    positions: (editingBoardData?.positions || []).filter((p) => p.group_id === group.id),
  })) || []

  const getMembersForPosition = (positionId: string) => {
    const assignments = editingBoardData?.assignments.filter((a) => a.position_id === positionId) || []
    return assignments.map((a) => {
      const member = editingBoardData?.members.find((m) => m.id === a.member_id)
      return { member, assignment: a }
    })
  }

  const handleAddGroup = async () => {
    if (!newGroupName.trim()) return
    await mutations.addGroup.mutateAsync(newGroupName)
    setNewGroupName('')
  }

  const handleRenameGroup = async () => {
    if (!editingGroup) return
    await mutations.renameGroup.mutateAsync({
      groupId: editingGroup.id,
      name: editingGroup.name,
    })
    setEditingGroup(null)
  }

  const handleDeleteGroup = (group: Group) => {
    setConfirmDialog({
      isOpen: true,
      title: `Delete ${group.name}?`,
      message: `This will delete the group and all its positions. This cannot be undone.`,
      action: () => mutations.deleteGroup.mutateAsync(group.id),
    })
  }

  const handleAddPosition = async (groupId: string, title: string) => {
    if (!title.trim()) return
    await mutations.addPosition.mutateAsync({ groupId, title })
  }

  const handleRenamePosition = async () => {
    if (!editingPosition) return
    await mutations.renamePosition.mutateAsync({
      positionId: editingPosition.id,
      title: editingPosition.title,
    })
    setEditingPosition(null)
  }

  const handleDeletePosition = (position: Position) => {
    setConfirmDialog({
      isOpen: true,
      title: `Delete ${position.title}?`,
      message: 'This will delete the position and all its assignments. This cannot be undone.',
      action: () => mutations.deletePosition.mutateAsync(position.id),
    })
  }

  const handleAddMember = async () => {
    if (!newMemberName.trim()) return
    await mutations.addMember.mutateAsync({ wardId: board.ward_id, full_name: newMemberName })
    setNewMemberName('')
  }

  const handleArchiveMember = (member: Member) => {
    setConfirmDialog({
      isOpen: true,
      title: `Archive ${member.full_name}?`,
      message: 'They can be reinstated later. Their assignments will remain.',
      action: () => mutations.archiveMember.mutateAsync(member.id),
    })
  }

  const handleUnassign = (assignmentId: string) => {
    mutations.deleteAssignment.mutate(assignmentId)
  }

  const handleUpdateAssignmentDate = async () => {
    if (!editingAssignmentDate) return
    await mutations.updateAssignmentDate.mutateAsync({
      assignmentId: editingAssignmentDate.id,
      calledDate: editingAssignmentDate.date,
    })
    setEditingAssignmentDate(null)
  }

  const activeMembers = (editingBoardData?.members || []).filter((m) => !m.archived_at)

  const editingBoard = versioning.allBoards.data?.find((b) => b.id === editingBoardId)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-4 px-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Calling Board</h1>
            <div className="mt-1 space-y-2">
              <div className="flex items-center gap-3">
                <p className="text-sm text-gray-600">{editingBoard?.name || board.name}</p>
                {editingBoard?.status === 'draft' && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                    Draft
                  </span>
                )}
                {editingBoard?.status === 'promoted' && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
                    Live
                  </span>
                )}
              </div>
              {activeUsers.length > 0 && (
                <div className="flex items-center gap-2">
                  <ActiveUsers activeUsers={activeUsers} />
                </div>
              )}
            </div>
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
          {/* Board Versioning */}
          <BoardVersioning
            wardId={wardId || ''}
            currentBoardId={editingBoardId}
            onSwitchBoard={setCurrentBoardId}
          />

          {/* Groups */}
          {groupedPositions.map(({ group, positions }) => (
            <div key={group.id} className="bg-white rounded-lg shadow p-6">
              {/* Group header */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex-1">
                  {editingGroup?.id === group.id ? (
                    <div className="flex gap-2">
                      <input
                        autoFocus
                        type="text"
                        value={editingGroup.name}
                        onChange={(e) =>
                          setEditingGroup({ ...editingGroup, name: e.target.value })
                        }
                        className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        onClick={handleRenameGroup}
                        className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingGroup(null)}
                        className="px-3 py-2 bg-gray-300 hover:bg-gray-400 text-gray-700 rounded font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <h2 className="text-xl font-semibold text-gray-900">{group.name}</h2>
                  )}
                </div>
                {!editingGroup?.id && (
                  <div className="flex gap-2 ml-4">
                    <button
                      onClick={() => setEditingGroup({ id: group.id, name: group.name })}
                      className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 text-gray-700 rounded"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleDeleteGroup(group)}
                      className="px-3 py-1 text-sm bg-red-100 hover:bg-red-200 text-red-700 rounded"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>

              {/* Positions grid */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 mb-6">
                {positions.map((position) => {
                  const members = getMembersForPosition(position.id)
                  const isOpen = members.length === 0

                  return (
                    <div
                      key={position.id}
                      className="border border-gray-200 rounded-lg p-4 bg-gray-50"
                    >
                      {/* Position header */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          {editingPosition?.id === position.id ? (
                            <div className="flex flex-col gap-2">
                              <input
                                autoFocus
                                type="text"
                                value={editingPosition.title}
                                onChange={(e) =>
                                  setEditingPosition({
                                    ...editingPosition,
                                    title: e.target.value,
                                  })
                                }
                                className="px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={handleRenamePosition}
                                  className="px-2 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingPosition(null)}
                                  className="px-2 py-1 text-sm bg-gray-300 hover:bg-gray-400 text-gray-700 rounded"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <h3 className="font-semibold text-gray-900">{position.title}</h3>
                          )}
                        </div>
                        {!editingPosition?.id && (
                          <div className="flex gap-1 ml-2">
                            <button
                              onClick={() =>
                                setEditingPosition({ id: position.id, title: position.title })
                              }
                              className="px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => handleDeletePosition(position)}
                              className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Members in position */}
                      {isOpen ? (
                        <div className="text-center py-6 text-gray-500 mb-3">
                          <p className="text-sm">Open Calling</p>
                        </div>
                      ) : (
                        <div className="space-y-2 mb-3">
                          {members.map(({ member, assignment }) => (
                            <div
                              key={assignment.id}
                              className="bg-white rounded p-3 border border-blue-200 shadow-sm"
                            >
                              <p className="font-medium text-gray-900">{member?.full_name}</p>
                              {editingAssignmentDate?.id === assignment.id ? (
                                <div className="mt-2 flex gap-2">
                                  <input
                                    type="date"
                                    value={editingAssignmentDate.date}
                                    onChange={(e) =>
                                      setEditingAssignmentDate({
                                        ...editingAssignmentDate,
                                        date: e.target.value,
                                      })
                                    }
                                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                  <button
                                    onClick={handleUpdateAssignmentDate}
                                    className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => setEditingAssignmentDate(null)}
                                    className="px-2 py-1 text-xs bg-gray-300 hover:bg-gray-400 text-gray-700 rounded"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className="mt-2 flex items-center justify-between">
                                  <p
                                    className="text-xs text-gray-500 cursor-pointer hover:text-blue-600"
                                    onClick={() =>
                                      setEditingAssignmentDate({
                                        id: assignment.id,
                                        date: assignment.called_date,
                                      })
                                    }
                                  >
                                    {formatTimeInCalling(assignment.called_date)}
                                  </p>
                                  <button
                                    onClick={() => handleUnassign(assignment.id)}
                                    className="px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded"
                                  >
                                    Unassign
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add member to position */}
                      <div className="border-t border-gray-200 pt-3">
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              mutations.createAssignment.mutate({
                                positionId: position.id,
                                memberId: e.target.value,
                                calledDate: new Date().toISOString().split('T')[0],
                              })
                              e.target.value = ''
                            }
                          }}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">+ Assign member</option>
                          {activeMembers.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.full_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Add position to group */}
              <div className="border-t border-gray-200 pt-4">
                <input
                  type="text"
                  placeholder="New position name..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddPosition(group.id, e.currentTarget.value)
                      e.currentTarget.value = ''
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          ))}

          {/* Add group section */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Add New Group</h3>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Group name..."
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddGroup()
                  }
                }}
                className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleAddGroup}
                disabled={mutations.addGroup.isPending}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50"
              >
                Add Group
              </button>
            </div>
          </div>

          {/* Members management */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Members</h3>

            <div className="mb-6">
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  placeholder="New member name..."
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddMember()
                    }
                  }}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleAddMember}
                  disabled={mutations.addMember.isPending}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50"
                >
                  Add Member
                </button>
              </div>

              <div className="space-y-2">
                {activeMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded border border-gray-200"
                  >
                    <span className="font-medium text-gray-900">{member.full_name}</span>
                    <button
                      onClick={() => handleArchiveMember(member)}
                      className="px-3 py-1 text-sm bg-red-100 hover:bg-red-200 text-red-700 rounded"
                    >
                      Archive
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
            <p className="font-semibold">Phase 6 Status:</p>
            <p className="mt-1">✅ Groups/positions CRUD working</p>
            <p>✅ Members management working</p>
            <p>✅ Date editing inline</p>
            <p>✅ Draft creation (deep copy of promoted board)</p>
            <p>✅ Switch between drafts</p>
            <p>✅ Promote draft with confirmation (archives old, deletes other drafts)</p>
            <p className="mt-2">Next: Phase 7 — Realtime sync</p>
          </div>
        </div>
      </main>

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        isDangerous
        isLoading={
          mutations.deleteGroup.isPending ||
          mutations.deletePosition.isPending ||
          mutations.archiveMember.isPending
        }
        onConfirm={async () => {
          if (confirmDialog.action) {
            await confirmDialog.action()
            setConfirmDialog({ isOpen: false, title: '', message: '', action: null })
          }
        }}
        onCancel={() =>
          setConfirmDialog({ isOpen: false, title: '', message: '', action: null })
        }
      />
    </div>
  )
}
