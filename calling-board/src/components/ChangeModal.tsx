import { useMemo } from 'react'
import type { BoardData } from '../hooks/useBoardData'
import type { Board } from '../types'

type ChangeType = 'assignment_added' | 'assignment_removed'

interface Change {
  type: ChangeType
  positionId: string
  positionTitle: string
  groupName: string
  memberId: string
  memberName: string
}

function buildDiff(before: BoardData | undefined, after: BoardData | undefined): Change[] {
  if (!before || !after) return []

  const changes: Change[] = []

  // Group maps
  const afterGroupsById = new Map(after.groups.map((g) => [g.id, g]))

  // For matching: after positions have origin_id pointing to before position id
  const beforeById = new Map(before.positions.map((p) => [p.id, p]))

  // Assignment maps by position
  const beforeByPositionId = new Map<string, typeof before.assignments>()
  for (const a of before.assignments) {
    const list = beforeByPositionId.get(a.position_id) || []
    list.push(a)
    beforeByPositionId.set(a.position_id, list)
  }

  const afterByPositionId = new Map<string, typeof after.assignments>()
  for (const a of after.assignments) {
    const list = afterByPositionId.get(a.position_id) || []
    list.push(a)
    afterByPositionId.set(a.position_id, list)
  }

  const memberMap = new Map(after.members.map((m) => [m.id, m]))

  // Only check assignment changes for matched positions
  for (const afterPos of after.positions) {
    if (!afterPos.origin_id) continue

    const beforePos = beforeById.get(afterPos.origin_id)
    if (!beforePos) continue

    // Check assignments
    const beforeAssigns = beforeByPositionId.get(beforePos.id) || []
    const afterAssigns = afterByPositionId.get(afterPos.id) || []

    const beforeMemberIds = new Set(beforeAssigns.map((a) => a.member_id))
    const afterMemberIds = new Set(afterAssigns.map((a) => a.member_id))

    // New assignments
    for (const memberId of afterMemberIds) {
      if (!beforeMemberIds.has(memberId)) {
        const member = memberMap.get(memberId)
        if (member) {
          changes.push({
            type: 'assignment_added',
            positionId: afterPos.id,
            positionTitle: afterPos.title,
            groupName: afterGroupsById.get(afterPos.group_id)?.name || '',
            memberId: memberId,
            memberName: member.full_name,
          })
        }
      }
    }

    // Removed assignments
    for (const memberId of beforeMemberIds) {
      if (!afterMemberIds.has(memberId)) {
        const member = memberMap.get(memberId)
        if (member) {
          changes.push({
            type: 'assignment_removed',
            positionId: afterPos.id,
            positionTitle: afterPos.title,
            groupName: afterGroupsById.get(afterPos.group_id)?.name || '',
            memberId: memberId,
            memberName: member.full_name,
          })
        }
      }
    }
  }

  return changes
}

function ChangeItem({ change }: { change: Change }) {
  const icon = change.type === 'assignment_added' ? '→' : '←'
  const label =
    change.type === 'assignment_added'
      ? `${change.memberName} assigned to ${change.positionTitle}`
      : `${change.memberName} released from ${change.positionTitle}`
  const color =
    change.type === 'assignment_added' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
  const iconColor = change.type === 'assignment_added' ? 'text-green-600' : 'text-red-600'

  return (
    <div className={`rounded border px-3 py-2 ${color}`}>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 pt-0.5 text-lg ${iconColor}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">{label}</p>
          <p className="mt-0.5 text-xs text-gray-600">in {change.groupName}</p>
        </div>
      </div>
    </div>
  )
}

export function ChangeModal({
  board,
  beforeData,
  afterData,
  onClose,
}: {
  board: Board
  beforeData: BoardData | undefined
  afterData: BoardData | undefined
  onClose: () => void
}) {
  const changes = useMemo(() => buildDiff(beforeData, afterData), [beforeData, afterData])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg bg-white shadow-xl">
        <div className="sticky top-0 border-b border-gray-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Changes in "{board.name}"</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-6">
          {changes.length === 0 ? (
            <div className="rounded-lg bg-gray-50 p-8 text-center">
              <p className="text-sm text-gray-600">No assignment changes in this revision.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {changes.map((change, i) => (
                <ChangeItem key={i} change={change} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
