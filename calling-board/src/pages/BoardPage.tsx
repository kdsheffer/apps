import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useAuth } from '../hooks/useAuth'
import { useBoard } from '../hooks/useBoard'
import { useBoardData } from '../hooks/useBoardData'
import { useBoardActions } from '../hooks/useBoardActions'
import { useBoardVersioning } from '../hooks/useBoardVersioning'
import { useBoardSelection } from '../hooks/useBoardSelection'
import { useRealtimeSync } from '../hooks/useRealtimeSync'
import { usePresence } from '../hooks/usePresence'
import {
  boardStats,
  buildGroupTree,
  buildIndex,
  unassignedMembers,
} from '../lib/boardSelectors'
import { buildAssignMenu } from '../lib/buildAssignMenu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ActiveUsers } from '../components/ActiveUsers'
import { PDFUpload } from '../components/PDFUpload'
import { Tabs } from '../components/Tabs'
import { FilterBar } from '../components/FilterBar'
import { Toast } from '../components/Toast'
import { ContextMenu, type ContextMenuState, type MenuItem } from '../components/ContextMenu'
import { BoardTab } from '../components/tabs/BoardTab'
import { AssignTab } from '../components/tabs/AssignTab'
import { MembersTab } from '../components/tabs/MembersTab'
import { BoardsTab } from '../components/tabs/BoardsTab'
import type { BoardViewContext, ConfirmRequest } from '../components/tabs/shared'
import type { DragData, DropData } from '../lib/dnd'
import { emptyFilters, type BoardFilters, type Member, type Position } from '../types'

type TabId = 'board' | 'assign' | 'members' | 'boards'

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
const modifierKey = isMac ? '⌘' : 'Ctrl+'

/** Typing in a field owns its own undo — don't steal the shortcut from it. */
function isTextEntry(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
  )
}

export function BoardPage() {
  const { wardId = '' } = useParams<{ wardId: string }>()
  const navigate = useNavigate()
  const { signOut } = useAuth()

  const { data: liveBoard, isLoading: boardLoading, error: boardError } = useBoard(wardId)
  const versioning = useBoardVersioning(wardId)

  const [tab, setTab] = useState<TabId>('board')
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [dragging, setDragging] = useState<DragData | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)

  const boards = versioning.allBoards.data
  const workingDraft = boards?.find((b) => b.is_working_draft) ?? null

  // The board you last loaded wins, and survives refreshes. It falls back to the
  // working draft, then the live board, then whatever exists — that's the path a
  // ward takes before anything has been loaded by hand, and after the remembered
  // board has been promoted away or deleted.
  const { selected: selectedBoardId, select: setSelectedBoardId } = useBoardSelection(
    wardId,
    boards
  )
  const defaultBoardId = workingDraft?.id || liveBoard?.id || boards?.[0]?.id || ''
  const boardId = selectedBoardId || defaultBoardId

  useRealtimeSync(boardId)
  const { activeUsers } = usePresence(boardId)

  const { data, isLoading: dataLoading } = useBoardData(boardId || undefined, wardId)
  const board = boards?.find((b) => b.id === boardId) ?? null

  const index = useMemo(() => buildIndex(data), [data])
  const tree = useMemo(() => buildGroupTree(data, index, filters), [data, index, filters])
  const stats = useMemo(() => boardStats(data, index), [data, index])

  const actions = useBoardActions({
    wardId,
    boardId,
    board,
    index,
    onSwitchBoard: setSelectedBoardId,
  })

  const servingElsewhere = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const [memberId, assignments] of index.byMember) {
      const titles = assignments
        .map((a) => index.positionsById.get(a.position_id)?.title)
        .filter((t): t is string => !!t)
      if (titles.length > 0) map.set(memberId, titles)
    }
    return map
  }, [index])

  const visibleMembers = useMemo(
    () => (data?.members || []).filter((m) => filters.showInactive || !m.archived_at),
    [data, filters.showInactive]
  )

  const unassigned = useMemo(
    () =>
      unassignedMembers(data, index).filter((m) => filters.showInactive || !m.archived_at),
    [data, index, filters.showInactive]
  )

  // Loading a different version by hand leaves the history pointing at rows on
  // the board you just left, so it starts over. The automatic redirect into a
  // working draft deliberately doesn't clear it — undoing the edit that caused
  // the fork is exactly what you'd reach for.
  const loadBoard = useCallback(
    (id: string) => {
      actions.history.clear()
      setSelectedBoardId(id)
    },
    [actions.history, setSelectedBoardId]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      if (isTextEntry(event.target)) return

      event.preventDefault()
      if (event.shiftKey) actions.redo()
      else actions.undo()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [actions])

  const sensors = useSensors(
    // A small threshold keeps clicks on the chip's buttons working.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // --- Context menus --------------------------------------------------------

  const openMemberMenu = (event: React.MouseEvent, member: Member, assignmentId?: string) => {
    event.preventDefault()
    event.stopPropagation()

    const currentTitle = assignmentId
      ? index.positionsById.get(
          (index.byMember.get(member.id) || []).find((a) => a.id === assignmentId)?.position_id ||
            ''
        )?.title
      : undefined

    const items: MenuItem[] = [
      {
        kind: 'action',
        icon: '★',
        label: member.flagged ? 'Remove flag' : 'Flag this person',
        onSelect: () => actions.toggleMemberFlag(member),
      },
    ]

    if (!actions.editor.isReadOnly) {
      items.push({ kind: 'separator' })
      items.push(
        buildAssignMenu({
          tree,
          index,
          memberId: member.id,
          memberName: member.full_name,
          onAssign: (positionId, action) => actions.assign(positionId, member.id, action),
        })
      )

      if (assignmentId) {
        items.push({
          kind: 'action',
          icon: '−',
          label: currentTitle ? `Release from ${currentTitle}` : 'Release from this calling',
          danger: true,
          onSelect: () => actions.unassign(assignmentId),
        })
      }
    }

    items.push({ kind: 'separator' })
    items.push({
      kind: 'action',
      icon: member.archived_at ? '↺' : '⊘',
      label: member.archived_at ? 'Mark active' : 'Mark inactive',
      onSelect: () => actions.toggleMemberActive(member),
    })

    setMenu({ x: event.clientX, y: event.clientY, title: member.full_name, items })
  }

  const openPositionMenu = (
    event: React.MouseEvent,
    position: Position,
    handlers?: { onRename?: () => void }
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const occupants = index.byPosition.get(position.id) || []

    const items: MenuItem[] = [
      {
        kind: 'action',
        icon: '★',
        label: position.flagged ? 'Remove flag' : 'Flag this calling',
        onSelect: () => actions.togglePositionFlag(position),
      },
      {
        kind: 'action',
        icon: position.inactive_at ? '↺' : '⊘',
        label: position.inactive_at ? 'Mark active' : 'Mark inactive',
        disabled: actions.editor.isReadOnly,
        onSelect: () => actions.togglePositionActive(position),
      },
    ]

    if (handlers?.onRename && !actions.editor.isReadOnly) {
      items.push({
        kind: 'action',
        icon: '✎',
        label: 'Rename calling',
        onSelect: handlers.onRename,
      })
    }

    if (occupants.length > 0 && !actions.editor.isReadOnly) {
      items.push({ kind: 'separator' })
      items.push({ kind: 'header', label: 'Currently serving' })
      for (const { member, assignment } of occupants) {
        if (!member) continue
        items.push({
          kind: 'action',
          icon: '−',
          label: `Release ${member.full_name}`,
          danger: true,
          onSelect: () => actions.unassign(assignment.id),
        })
      }
    }

    if (!actions.editor.isReadOnly) {
      items.push({ kind: 'separator' })
      items.push({
        kind: 'action',
        icon: '🗑',
        label: 'Delete calling',
        danger: true,
        onSelect: () =>
          setConfirmRequest({
            title: `Delete ${position.title}?`,
            message: 'The calling and its assignments will be removed. This cannot be undone.',
            confirmLabel: 'Delete',
            onConfirm: () => actions.deletePosition(position.id),
          }),
      })
    }

    setMenu({ x: event.clientX, y: event.clientY, title: position.title, items })
  }

  // --- Drag and drop --------------------------------------------------------

  const onDragStart = (event: DragStartEvent) => {
    setDragging((event.active.data.current as DragData) ?? null)
  }

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const drag = event.active.data.current as DragData | undefined
    const drop = event.over?.data.current as DropData | undefined
    if (!drag || !drop) return

    if (drop.type === 'position') {
      if (drag.type === 'assignment') {
        if (drag.positionId === drop.positionId) return
        actions.moveAssignment(drag.assignmentId, drop.positionId, drag.memberId)
      } else {
        actions.assign(drop.positionId, drag.memberId, 'add')
      }
      return
    }

    if (drop.type === 'unassigned' && drag.type === 'assignment') {
      actions.unassign(drag.assignmentId)
    }
  }

  // --- Guards ---------------------------------------------------------------

  if (!wardId) return <div className="py-8 text-center">Ward not found</div>

  if (boardLoading || versioning.allBoards.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-gray-600">Loading board…</div>
      </div>
    )
  }

  if (boardError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="mb-4 text-gray-600">Couldn't load this ward's board.</p>
          <p className="mb-4 text-sm text-gray-500">{boardError.message}</p>
          <button
            onClick={() => navigate('/wards')}
            className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            Back to Wards
          </button>
        </div>
      </div>
    )
  }

  const header = (
    <header className="bg-white shadow print:hidden">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Calling Board</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-sm text-gray-600">{board?.name || liveBoard?.name}</p>
            {board?.status === 'promoted' && (
              <span className="rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-800">
                Live · read-only
              </span>
            )}
            {board?.status === 'draft' && (
              <span className="rounded bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-800">
                {board.is_working_draft ? 'Working draft' : 'Draft'}
              </span>
            )}
            {board?.status === 'archived' && (
              <span className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-600">
                Archived · read-only
              </span>
            )}
            {activeUsers.length > 0 && <ActiveUsers activeUsers={activeUsers} />}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={actions.undo}
            disabled={!actions.history.canUndo || actions.history.busy}
            title={
              actions.history.undoLabel
                ? `Undo ${actions.history.undoLabel} (${modifierKey}Z)`
                : 'Nothing to undo'
            }
            className="rounded bg-gray-200 px-3 py-2 font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-40"
          >
            ↶
          </button>
          <button
            onClick={actions.redo}
            disabled={!actions.history.canRedo || actions.history.busy}
            title={
              actions.history.redoLabel
                ? `Redo ${actions.history.redoLabel} (${modifierKey}⇧Z)`
                : 'Nothing to redo'
            }
            className="rounded bg-gray-200 px-3 py-2 font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-40"
          >
            ↷
          </button>
          <button
            onClick={() => window.print()}
            className="flex-1 rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300 sm:flex-none"
          >
            Print
          </button>
          <button
            onClick={() => navigate('/wards')}
            className="flex-1 rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300 sm:flex-none"
          >
            Wards
          </button>
          <button
            onClick={signOut}
            className="flex-1 rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300 sm:flex-none"
          >
            Sign Out
          </button>
        </div>
      </div>
    </header>
  )

  // Nothing exists for this ward yet — offer the import rather than dead-ending.
  if (!boardId) {
    return (
      <div className="min-h-screen bg-gray-50">
        {header}
        <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:py-12">
          <div className="rounded-lg bg-white p-8 text-center shadow">
            <h2 className="text-lg font-semibold text-gray-900">No board yet</h2>
            <p className="mt-2 text-sm text-gray-600">
              Import the "Organizations and Callings" report from LCR to build this ward's first
              board. It comes in as a draft you can review before promoting it.
            </p>
          </div>
          <PDFUpload wardId={wardId} onSuccess={loadBoard} />
        </main>
      </div>
    )
  }

  const ctx: BoardViewContext = {
    wardId,
    data,
    index,
    tree,
    actions,
    filters,
    servingElsewhere,
    visibleMembers,
    unassigned,
    readOnly: actions.editor.isReadOnly,
    openMemberMenu,
    openPositionMenu,
    confirm: setConfirmRequest,
  }

  const topLevelGroups = (data?.groups || []).filter((g) => !g.parent_id)
  const subgroupOptions = (data?.groups || []).filter(
    (g) =>
      !!g.parent_id &&
      (filters.groupIds.length === 0 || filters.groupIds.includes(g.parent_id))
  )

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="min-h-screen bg-gray-50">
        {header}

        <main className="mx-auto max-w-7xl px-4 py-4 sm:py-6">
          <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 print:mb-2">
            <span>
              <strong className="text-gray-900">{stats.callings}</strong> callings
            </span>
            <span>
              <strong className="text-gray-900">{stats.open}</strong> open
            </span>
            <span>
              <strong className="text-gray-900">{stats.flagged}</strong> flagged
            </span>
            <span>
              <strong className="text-gray-900">{stats.members}</strong> members ·{' '}
              {stats.unassigned} unassigned
            </span>
            {stats.inactive > 0 && <span>{stats.inactive} inactive</span>}
          </div>

          <Tabs
            tabs={[
              { id: 'board', label: 'Board' },
              { id: 'assign', label: 'Assign', badge: stats.open },
              { id: 'members', label: 'Members', badge: stats.members },
              { id: 'boards', label: 'Boards' },
            ]}
            active={tab}
            onChange={setTab}
          />

          <div className="pt-4">
            {tab !== 'boards' && (
              <FilterBar
                filters={filters}
                onChange={setFilters}
                groups={topLevelGroups}
                subgroups={subgroupOptions}
                openToggle={
                  tab === 'board'
                    ? { label: 'Open only', title: 'Show only callings with nobody in them' }
                    : tab === 'members'
                      ? { label: 'No calling', title: 'Show only members who hold no calling' }
                      : undefined
                }
                showFlaggedToggle={tab !== 'assign'}
              />
            )}

            {dataLoading ? (
              <p className="py-12 text-center text-gray-500">Loading…</p>
            ) : (
              <>
                {tab === 'board' && <BoardTab ctx={ctx} boardId={boardId} />}
                {tab === 'assign' && <AssignTab ctx={ctx} />}
                {tab === 'members' && <MembersTab ctx={ctx} />}
                {tab === 'boards' && (
                  <BoardsTab
                    wardId={wardId}
                    currentBoardId={boardId}
                    onLoadBoard={loadBoard}
                    confirm={setConfirmRequest}
                  />
                )}
              </>
            )}
          </div>
        </main>

        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="rounded border border-blue-400 bg-white px-3 py-2 text-sm font-medium text-gray-900 shadow-lg">
              {dragging.name}
            </div>
          )}
        </DragOverlay>

        <ContextMenu state={menu} onClose={() => setMenu(null)} />

        <ConfirmDialog
          isOpen={!!confirmRequest}
          title={confirmRequest?.title || ''}
          message={confirmRequest?.message || ''}
          confirmLabel={confirmRequest?.confirmLabel}
          isDangerous
          onConfirm={async () => {
            await confirmRequest?.onConfirm()
            setConfirmRequest(null)
          }}
          onCancel={() => setConfirmRequest(null)}
        />

        {actions.error && (
          <Toast tone="error" onDismiss={actions.clearError}>
            {actions.error}
          </Toast>
        )}

        {!actions.error && actions.editor.lastForkedTo && (
          <Toast
            onDismiss={actions.editor.dismissForkNotice}
            action={{ label: 'Board versions', onClick: () => setTab('boards') }}
          >
            The live board is read-only, so your change went into the working draft. You're editing
            it now — promote it when you're ready.
          </Toast>
        )}

        {actions.editor.forking && (
          <Toast onDismiss={() => {}}>Creating a working draft from the live board…</Toast>
        )}
      </div>
    </DndContext>
  )
}
