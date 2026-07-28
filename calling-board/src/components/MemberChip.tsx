import { useDraggable } from '@dnd-kit/core'
import { dragId, type DragData } from '../lib/dnd'
import type { Member } from '../types'

interface MemberChipProps {
  member: Member
  drag: DragData
  onContextMenu?: (event: React.MouseEvent) => void
  onToggleFlag?: () => void
  detail?: React.ReactNode
  actions?: React.ReactNode
  compact?: boolean
}

export function MemberChip({
  member,
  drag,
  onContextMenu,
  onToggleFlag,
  detail,
  actions,
  compact = false,
}: MemberChipProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId(drag),
    data: drag,
  })

  return (
    <div
      ref={setNodeRef}
      onContextMenu={onContextMenu}
      className={`rounded border bg-white shadow-sm transition-opacity ${
        compact ? 'px-2.5 py-2' : 'p-3'
      } ${member.archived_at ? 'border-gray-200 opacity-60' : 'border-blue-200'} ${
        isDragging ? 'opacity-30' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          {...listeners}
          {...attributes}
          title="Drag onto a calling to assign"
          className="mt-0.5 shrink-0 cursor-grab text-gray-300 hover:text-gray-500 active:cursor-grabbing print:hidden"
          aria-label={`Drag ${member.full_name}`}
        >
          ⠿
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {onToggleFlag ? (
              <button
                onClick={onToggleFlag}
                title={member.flagged ? 'Remove flag' : 'Flag this person'}
                className={`shrink-0 ${
                  member.flagged ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'
                }`}
              >
                ★
              </button>
            ) : (
              member.flagged && <span className="shrink-0 text-amber-500">★</span>
            )}
            <p className="truncate font-medium text-gray-900" title={member.full_name}>
              {member.full_name}
            </p>
            {member.archived_at && (
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                Inactive
              </span>
            )}
          </div>
          {member.notes && (
            <p className="mt-0.5 truncate text-xs italic text-gray-500">{member.notes}</p>
          )}
          {detail}
        </div>

        {actions && <div className="flex shrink-0 items-center gap-1 print:hidden">{actions}</div>}
      </div>
    </div>
  )
}
