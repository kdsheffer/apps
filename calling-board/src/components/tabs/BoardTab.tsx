import { useState } from 'react'
import { Accordion, useExpandedSections } from '../Accordion'
import { PositionCard } from '../PositionCard'
import { makePositionView } from '../../lib/boardSelectors'
import type { BoardViewContext } from './shared'
import type { Group } from '../../types'

interface BoardTabProps {
  ctx: BoardViewContext
  boardId: string
}

function CountBadge({ filled, total }: { filled: number; total: number }) {
  const complete = total > 0 && filled === total
  return (
    <span
      className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
        complete ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
      }`}
      title={`${filled} of ${total} filled`}
    >
      {filled}/{total}
    </span>
  )
}

export function BoardTab({ ctx, boardId }: BoardTabProps) {
  const { tree, index, actions, readOnly, filters } = ctx
  const sections = useExpandedSections(`calling-board:expanded:${boardId}`)
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; name: string } | null>(null)
  const [newGroupName, setNewGroupName] = useState('')

  const allSectionIds = tree.flatMap((node) => [
    node.group.id,
    ...node.subgroups.map((s) => s.group.id),
  ])

  const deleteGroup = (group: Group) =>
    ctx.confirm({
      title: `Delete ${group.name}?`,
      message:
        'This deletes the group along with its subgroups, callings, and assignments. This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => actions.deleteGroup(group.id),
    })

  const groupActions = (group: Group) =>
    readOnly ? null : (
      <>
        <button
          onClick={() => setRenamingGroup({ id: group.id, name: group.name })}
          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200"
        >
          Rename
        </button>
        <button
          onClick={() => deleteGroup(group)}
          className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100"
        >
          Delete
        </button>
      </>
    )

  const renameForm = (group: Group) => (
    <div className="flex flex-1 gap-2" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={renamingGroup?.name ?? ''}
        onChange={(e) => setRenamingGroup({ id: group.id, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && renamingGroup?.name.trim()) {
            actions.renameGroup(group.id, renamingGroup.name.trim())
            setRenamingGroup(null)
          }
          if (e.key === 'Escape') setRenamingGroup(null)
        }}
        className="flex-1 rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        onClick={() => {
          if (renamingGroup?.name.trim()) actions.renameGroup(group.id, renamingGroup.name.trim())
          setRenamingGroup(null)
        }}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        Save
      </button>
      <button
        onClick={() => setRenamingGroup(null)}
        className="rounded bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300"
      >
        Cancel
      </button>
    </div>
  )

  const renderPositions = (positionIds: { id: string }[]) => (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {positionIds.map((p) => {
        const position = index.positionsById.get(p.id)
        if (!position) return null
        const view = makePositionView(position, index)

        return (
          <PositionCard
            key={position.id}
            view={view}
            members={ctx.visibleMembers}
            unassigned={ctx.unassigned}
            servingElsewhere={ctx.servingElsewhere}
            readOnly={readOnly}
            onAssign={(memberId) => actions.assign(position.id, memberId, 'add')}
            onUnassign={(assignmentId) => actions.unassign(assignmentId)}
            onSetDate={(assignmentId, date) => actions.setAssignmentDate(assignmentId, date)}
            onRename={(title) => actions.renamePosition(position.id, title)}
            onToggleFlag={() => actions.togglePositionFlag(position)}
            onSetNotes={(notes) => actions.setPositionNotes(position.id, notes)}
            onMemberContextMenu={(e, member, assignmentId) =>
              ctx.openMemberMenu(e, member, assignmentId)
            }
            onPositionContextMenu={(e, handlers) =>
              ctx.openPositionMenu(e, position, handlers)
            }
          />
        )
      })}
    </div>
  )

  const newPositionInput = (groupId: string, label: string) =>
    !readOnly && (
      <input
        type="text"
        placeholder={label}
        onKeyDown={(e) => {
          const value = e.currentTarget.value.trim()
          if (e.key === 'Enter' && value) {
            actions.addPosition(groupId, value)
            e.currentTarget.value = ''
          }
        }}
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 print:hidden"
      />
    )

  const filtersActive =
    !!filters.search ||
    filters.flaggedOnly ||
    filters.openOnly ||
    filters.groupIds.length > 0 ||
    filters.subgroupIds.length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <p className="text-sm text-gray-500">
          {tree.length} {tree.length === 1 ? 'organization' : 'organizations'}
          {filtersActive && ' matching your filters'}
        </p>
        <div className="flex gap-2">
          <button
            onClick={sections.expandAll}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Expand all
          </button>
          <button
            onClick={() => sections.collapseAll(allSectionIds)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Collapse all
          </button>
        </div>
      </div>

      {tree.length === 0 && (
        <div className="rounded-lg bg-white p-8 text-center shadow">
          <h2 className="text-lg font-semibold text-gray-900">
            {filtersActive ? 'Nothing matches those filters' : 'This board is empty'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {filtersActive
              ? 'Try clearing a filter, or turn on "Show inactive" if you were looking for something you deactivated.'
              : 'Import an LCR "Organizations and Callings" PDF from the Boards tab, or add an organization below.'}
          </p>
        </div>
      )}

      {tree.map((node) => (
        <Accordion
          key={node.group.id}
          isOpen={sections.isOpen(node.group.id)}
          onToggle={() => sections.toggle(node.group.id)}
          title={
            renamingGroup?.id === node.group.id ? renameForm(node.group) : node.group.name
          }
          meta={
            renamingGroup?.id === node.group.id ? null : (
              <CountBadge filled={node.filled} total={node.total} />
            )
          }
          actions={renamingGroup?.id === node.group.id ? null : groupActions(node.group)}
        >
          {node.subgroups.map((sub) => {
            const filled = sub.positions.filter(
              (p) => (index.byPosition.get(p.id) ?? []).length > 0
            ).length

            return (
              <Accordion
                key={sub.group.id}
                level="subgroup"
                isOpen={sections.isOpen(sub.group.id)}
                onToggle={() => sections.toggle(sub.group.id)}
                title={
                  renamingGroup?.id === sub.group.id ? renameForm(sub.group) : sub.group.name
                }
                meta={
                  renamingGroup?.id === sub.group.id ? null : (
                    <CountBadge filled={filled} total={sub.positions.length} />
                  )
                }
                actions={renamingGroup?.id === sub.group.id ? null : groupActions(sub.group)}
              >
                {sub.positions.length === 0 ? (
                  <p className="text-sm text-gray-500">No callings in this subgroup yet.</p>
                ) : (
                  renderPositions(sub.positions)
                )}
                {newPositionInput(sub.group.id, `New calling in ${sub.group.name}…`)}
              </Accordion>
            )
          })}

          {node.positions.length > 0 && renderPositions(node.positions)}

          {node.positions.length === 0 && node.subgroups.length === 0 && (
            <p className="text-sm text-gray-500">No callings here yet.</p>
          )}

          {newPositionInput(node.group.id, `New calling in ${node.group.name}…`)}
        </Accordion>
      ))}

      {!readOnly && (
        <div className="rounded-lg bg-white p-6 shadow print:hidden">
          <h3 className="mb-3 font-semibold text-gray-900">Add an organization</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Organization name…"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newGroupName.trim()) {
                  actions.addGroup(newGroupName.trim())
                  setNewGroupName('')
                }
              }}
              className="flex-1 rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => {
                if (newGroupName.trim()) {
                  actions.addGroup(newGroupName.trim())
                  setNewGroupName('')
                }
              }}
              className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
