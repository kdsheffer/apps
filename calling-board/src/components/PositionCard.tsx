import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { MemberChip } from './MemberChip'
import { MemberCombobox } from './MemberCombobox'
import { formatTimeInCalling } from '../lib/timeInCalling'
import { dropId } from '../lib/dnd'
import type { PositionView } from '../lib/boardSelectors'
import type { Member } from '../types'

interface PositionCardProps {
  view: PositionView
  members: Member[]
  unassigned: Member[]
  /** member id -> the other callings they hold, for the double-booking warning */
  servingElsewhere: Map<string, string[]>
  readOnly?: boolean
  onAssign: (memberId: string) => void
  onUnassign: (assignmentId: string) => void
  onSetDate: (assignmentId: string, date: string) => void
  onRename: (title: string) => void
  onToggleFlag: () => void
  onSetNotes: (notes: string) => void
  onMemberContextMenu: (event: React.MouseEvent, member: Member, assignmentId: string) => void
  onPositionContextMenu: (event: React.MouseEvent, handlers: { onRename: () => void }) => void
}

export function PositionCard({
  view,
  members,
  unassigned,
  servingElsewhere,
  readOnly = false,
  onAssign,
  onUnassign,
  onSetDate,
  onRename,
  onToggleFlag,
  onSetNotes,
  onMemberContextMenu,
  onPositionContextMenu,
}: PositionCardProps) {
  const { position, assigned, isOpen, isInactive } = view
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [editingDate, setEditingDate] = useState<{ id: string; date: string } | null>(null)

  const openMenu = (event: React.MouseEvent) =>
    onPositionContextMenu(event, { onRename: () => setEditingTitle(position.title) })

  const { setNodeRef, isOver } = useDroppable({
    id: dropId({ type: 'position', positionId: position.id }),
    data: { type: 'position', positionId: position.id },
    disabled: readOnly,
  })

  return (
    <div
      ref={setNodeRef}
      onContextMenu={openMenu}
      className={`rounded-lg border p-4 transition-colors print:break-inside-avoid ${
        isOver
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-300'
          : isInactive
            ? 'border-dashed border-gray-300 bg-gray-100/70'
            : position.flagged
              ? 'border-amber-300 bg-amber-50/50'
              : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editingTitle !== null ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editingTitle.trim()) {
                    onRename(editingTitle.trim())
                    setEditingTitle(null)
                  }
                  if (e.key === 'Escape') setEditingTitle(null)
                }}
                className="rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (editingTitle.trim()) onRename(editingTitle.trim())
                    setEditingTitle(null)
                  }}
                  className="rounded bg-blue-600 px-2 py-1 text-sm text-white hover:bg-blue-700"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingTitle(null)}
                  className="rounded bg-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                onClick={onToggleFlag}
                disabled={readOnly}
                title={position.flagged ? 'Remove flag' : 'Flag this calling'}
                className={`shrink-0 disabled:opacity-40 ${
                  position.flagged ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'
                }`}
              >
                ★
              </button>
              <h3 className="truncate font-semibold text-gray-900" title={position.title}>
                {position.title}
              </h3>
              {isInactive && (
                <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600">
                  Inactive
                </span>
              )}
            </div>
          )}
        </div>

        {editingTitle === null && !readOnly && (
          // Rename / deactivate / delete live in the menu so the title has room.
          <button
            onClick={openMenu}
            title="Calling options"
            aria-label={`Options for ${position.title}`}
            className="shrink-0 rounded px-2 py-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 print:hidden"
          >
            ⋯
          </button>
        )}
      </div>

      {isOpen ? (
        <div
          className={`mb-3 rounded border-2 border-dashed py-5 text-center text-sm ${
            isOver ? 'border-blue-400 text-blue-700' : 'border-gray-200 text-gray-500'
          }`}
        >
          {isOver ? 'Drop to assign' : 'Open calling'}
        </div>
      ) : (
        <div className="mb-3 space-y-2">
          {assigned.map(({ member, assignment }) => {
            if (!member) return null
            const elsewhere = (servingElsewhere.get(member.id) || []).filter(
              (title) => title !== position.title
            )

            return (
              <MemberChip
                key={assignment.id}
                member={member}
                compact
                drag={{
                  type: 'assignment',
                  memberId: member.id,
                  name: member.full_name,
                  assignmentId: assignment.id,
                  positionId: position.id,
                }}
                onContextMenu={(e) => onMemberContextMenu(e, member, assignment.id)}
                detail={
                  editingDate?.id === assignment.id ? (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="date"
                        autoFocus
                        value={editingDate.date}
                        onChange={(e) => setEditingDate({ ...editingDate, date: e.target.value })}
                        className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        onClick={() => {
                          onSetDate(assignment.id, editingDate.date)
                          setEditingDate(null)
                        }}
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingDate(null)}
                        className="rounded bg-gray-300 px-2 py-1 text-xs text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-0.5">
                      <button
                        disabled={readOnly}
                        onClick={() =>
                          setEditingDate({ id: assignment.id, date: assignment.called_date })
                        }
                        className="text-xs text-gray-500 hover:text-blue-600 disabled:hover:text-gray-500"
                      >
                        {formatTimeInCalling(assignment.called_date)}
                      </button>
                      {elsewhere.length > 0 && (
                        <p className="text-xs text-amber-700">
                          Also serving as {elsewhere.join(', ')}
                        </p>
                      )}
                    </div>
                  )
                }
                actions={
                  !readOnly && editingDate?.id !== assignment.id ? (
                    <button
                      onClick={() => onUnassign(assignment.id)}
                      className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300"
                    >
                      Release
                    </button>
                  ) : null
                }
              />
            )
          })}
        </div>
      )}

      {/* Notes */}
      {editingNotes !== null ? (
        <div className="mb-3">
          <textarea
            autoFocus
            rows={2}
            value={editingNotes}
            onChange={(e) => setEditingNotes(e.target.value)}
            placeholder="Candidates considered, interview status…"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => {
                onSetNotes(editingNotes)
                setEditingNotes(null)
              }}
              className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
            >
              Save note
            </button>
            <button
              onClick={() => setEditingNotes(null)}
              className="rounded bg-gray-300 px-2 py-1 text-xs text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : position.notes ? (
        <button
          disabled={readOnly}
          onClick={() => setEditingNotes(position.notes || '')}
          className="mb-3 block w-full rounded bg-amber-50 px-2 py-1.5 text-left text-xs italic text-amber-900 hover:bg-amber-100 disabled:hover:bg-amber-50"
        >
          {position.notes}
        </button>
      ) : (
        !readOnly && (
          <button
            onClick={() => setEditingNotes('')}
            className="mb-3 text-xs text-gray-400 hover:text-blue-600 print:hidden"
          >
            + Add note
          </button>
        )
      )}

      {!readOnly && (
        <div className="border-t border-gray-200 pt-3">
          <MemberCombobox
            members={members}
            suggested={unassigned}
            servingElsewhere={servingElsewhere}
            onSelect={(member) => onAssign(member.id)}
          />
        </div>
      )}
    </div>
  )
}
