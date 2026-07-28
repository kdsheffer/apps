import { useState } from 'react'
import { MemberChip } from '../MemberChip'
import { byName, searchMembers } from '../../lib/boardSelectors'
import type { BoardViewContext } from './shared'

export function MembersTab({ ctx }: { ctx: BoardViewContext }) {
  const { data, index, filters, actions } = ctx
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [editingNotes, setEditingNotes] = useState<{ id: string; notes: string } | null>(null)

  const all = (data?.members || [])
    .filter((m) => filters.showInactive || !m.archived_at)
    .filter((m) => !filters.flaggedOnly || m.flagged)
    .filter((m) => !filters.openOnly || !index.byMember.get(m.id)?.length)

  const members = filters.search ? searchMembers(all, filters.search, 500) : [...all].sort(byName)

  const inactiveCount = (data?.members || []).filter((m) => m.archived_at).length

  return (
    <div className="space-y-4">
      {!ctx.readOnly && (
        <div className="rounded-lg bg-white p-4 shadow sm:p-6 print:hidden">
          <h3 className="mb-3 font-semibold text-gray-900">Add a member</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Full name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  actions.addMember(newName.trim())
                  setNewName('')
                }
              }}
              className="flex-1 rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => {
                if (newName.trim()) {
                  actions.addMember(newName.trim())
                  setNewName('')
                }
              }}
              className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              Add
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Members belong to the ward, not to a board version — adding or flagging someone here
            doesn't create a draft.
          </p>
        </div>
      )}

      <div className="rounded-lg bg-white p-4 shadow sm:p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Members</h2>
          <span className="text-sm text-gray-500">
            {members.length} shown
            {!filters.showInactive && inactiveCount > 0 && ` · ${inactiveCount} inactive hidden`}
          </span>
        </div>

        {members.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">
            No members match. Add them above, or import an LCR PDF from the Boards tab.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {members.map((member) => {
              const callings = (index.byMember.get(member.id) || [])
                .map((a) => index.positionsById.get(a.position_id)?.title)
                .filter(Boolean) as string[]

              if (renaming?.id === member.id) {
                return (
                  <div
                    key={member.id}
                    className="flex gap-2 rounded border border-blue-200 bg-white p-3"
                  >
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: member.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renaming.name.trim()) {
                          actions.renameMember(member.id, renaming.name.trim())
                          setRenaming(null)
                        }
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => {
                        if (renaming.name.trim())
                          actions.renameMember(member.id, renaming.name.trim())
                        setRenaming(null)
                      }}
                      className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setRenaming(null)}
                      className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                )
              }

              return (
                <MemberChip
                  key={member.id}
                  member={member}
                  drag={{ type: 'member', memberId: member.id, name: member.full_name }}
                  onToggleFlag={() => actions.toggleMemberFlag(member)}
                  onContextMenu={(e) => ctx.openMemberMenu(e, member)}
                  detail={
                    editingNotes?.id === member.id ? (
                      <div className="mt-2">
                        <textarea
                          autoFocus
                          rows={2}
                          value={editingNotes.notes}
                          onChange={(e) =>
                            setEditingNotes({ id: member.id, notes: e.target.value })
                          }
                          placeholder="Availability, callings considered…"
                          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <div className="mt-1 flex gap-2">
                          <button
                            onClick={() => {
                              actions.setMemberNotes(member.id, editingNotes.notes)
                              setEditingNotes(null)
                            }}
                            className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
                          >
                            Save note
                          </button>
                          <button
                            onClick={() => setEditingNotes(null)}
                            className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-gray-500">
                        {callings.length > 0 ? callings.join(', ') : 'No calling'}
                      </p>
                    )
                  }
                  actions={
                    editingNotes?.id === member.id || ctx.readOnly ? null : (
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={() => setRenaming({ id: member.id, name: member.full_name })}
                          className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => setEditingNotes({ id: member.id, notes: member.notes || '' })}
                          className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
                        >
                          Note
                        </button>
                        <button
                          onClick={() => actions.toggleMemberActive(member)}
                          className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
                        >
                          {member.archived_at ? 'Reactivate' : 'Deactivate'}
                        </button>
                      </div>
                    )
                  }
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
