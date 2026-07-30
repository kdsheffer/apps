import { useMemo } from 'react'
import type { BoardViewContext } from './shared'
import type { BoardData } from '../../hooks/useBoardData'

type ChangeType = 'assignment_added' | 'assignment_removed'

interface Change {
  type: ChangeType
  positionId: string
  positionTitle: string
  groupName: string
  memberId: string
  memberName: string
}

function buildDiff(promoted: BoardData | undefined, draft: BoardData | undefined): Change[] {
  if (!promoted || !draft) return []

  const changes: Change[] = []

  // Group maps
  const draftGroupsById = new Map(draft.groups.map((g) => [g.id, g]))

  // For matching: draft positions have origin_id pointing to promoted position id
  const promotedById = new Map(promoted.positions.map((p) => [p.id, p]))

  // Assignment maps by position
  const promotedByPositionId = new Map<string, typeof promoted.assignments>()
  for (const a of promoted.assignments) {
    const list = promotedByPositionId.get(a.position_id) || []
    list.push(a)
    promotedByPositionId.set(a.position_id, list)
  }

  const draftByPositionId = new Map<string, typeof draft.assignments>()
  for (const a of draft.assignments) {
    const list = draftByPositionId.get(a.position_id) || []
    list.push(a)
    draftByPositionId.set(a.position_id, list)
  }

  const memberMap = new Map(draft.members.map((m) => [m.id, m]))

  // Only check assignment changes for matched positions
  for (const draftPos of draft.positions) {
    if (!draftPos.origin_id) continue

    const promotedPos = promotedById.get(draftPos.origin_id)
    if (!promotedPos) continue

    // Check assignments
    const promotedAssigns = promotedByPositionId.get(promotedPos.id) || []
    const draftAssigns = draftByPositionId.get(draftPos.id) || []

    const promotedMemberIds = new Set(promotedAssigns.map((a) => a.member_id))
    const draftMemberIds = new Set(draftAssigns.map((a) => a.member_id))

    // New assignments
    for (const memberId of draftMemberIds) {
      if (!promotedMemberIds.has(memberId)) {
        const member = memberMap.get(memberId)
        if (member) {
          changes.push({
            type: 'assignment_added',
            positionId: draftPos.id,
            positionTitle: draftPos.title,
            groupName: draftGroupsById.get(draftPos.group_id)?.name || '',
            memberId: memberId,
            memberName: member.full_name,
          })
        }
      }
    }

    // Removed assignments
    for (const memberId of promotedMemberIds) {
      if (!draftMemberIds.has(memberId)) {
        const member = memberMap.get(memberId)
        if (member) {
          changes.push({
            type: 'assignment_removed',
            positionId: draftPos.id,
            positionTitle: draftPos.title,
            groupName: draftGroupsById.get(draftPos.group_id)?.name || '',
            memberId: memberId,
            memberName: member.full_name,
          })
        }
      }
    }
  }

  return changes
}

function ChangeItem({
  change,
  ctx,
}: {
  change: Change
  ctx: BoardViewContext
}) {
  const icon = change.type === 'assignment_added' ? '→' : '←'
  const label =
    change.type === 'assignment_added'
      ? `${change.memberName} assigned to ${change.positionTitle}`
      : `${change.memberName} released from ${change.positionTitle}`
  const color =
    change.type === 'assignment_added' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
  const iconColor = change.type === 'assignment_added' ? 'text-green-600' : 'text-red-600'

  const handleUndo = async () => {
    if (!ctx.data) return

    if (change.type === 'assignment_added') {
      // Find and delete the assignment
      const assignment = ctx.data.assignments.find(
        (a) => a.position_id === change.positionId && a.member_id === change.memberId
      )
      if (assignment) {
        await ctx.actions.unassign(assignment.id)
      }
    } else {
      // Re-assign the member
      await ctx.actions.assign(change.positionId, change.memberId, 'add')
    }
  }

  return (
    <div className={`rounded border px-3 py-2 ${color}`}>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 pt-0.5 text-lg ${iconColor}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">{label}</p>
          <p className="mt-0.5 text-xs text-gray-600">in {change.groupName}</p>
        </div>
        <button
          onClick={handleUndo}
          disabled={ctx.readOnly}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          Undo
        </button>
      </div>
    </div>
  )
}

export function ProposedTab({
  ctx,
  promotedBoardData,
}: {
  ctx: BoardViewContext
  promotedBoardData: BoardData | undefined
}) {
  const changes = useMemo(
    () => buildDiff(promotedBoardData, ctx.data),
    [promotedBoardData, ctx.data]
  )


  if (!promotedBoardData || !ctx.data) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow">
        <p className="text-sm text-gray-600">Loading board data…</p>
      </div>
    )
  }

  if (changes.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center shadow">
        <div className="mb-2 text-lg font-semibold text-gray-900">No assignment changes proposed</div>
        <p className="text-sm text-gray-600">This draft has the same assignments as the live board.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">
        {changes.length} assignment change{changes.length !== 1 ? 's' : ''}
      </h2>
      <div className="space-y-2">
        {changes.map((change, i) => (
          <ChangeItem key={i} change={change} ctx={ctx} />
        ))}
      </div>
    </div>
  )
}
