import { useCallback, useState } from 'react'
import { useBoardEditor, type EditContext } from './useBoardEditor'
import { useBoardMutations } from './useBoardMutations'
import { useHistory, type HistoryEntry } from './useHistory'
import type { BoardIndex } from '../lib/boardSelectors'
import type { AssignAction, Board, Member, Position } from '../types'

interface Options {
  wardId: string
  boardId: string
  board: Board | null | undefined
  index: BoardIndex
  canEdit: boolean
  onSwitchBoard: (boardId: string) => void
}

const today = () => new Date().toISOString().split('T')[0]

/** The shape an assignment needs to be recreated after being released. */
interface RestorableAssignment {
  position_id: string
  member_id: string
  called_date: string
}

/**
 * The single place the UI talks to. Every board-scoped change goes through
 * `editor.edit`, which redirects it into the working draft when the live board
 * is on screen and rewrites the ids to match.
 *
 * Each action also records how to reverse itself. The inverse is built *after*
 * the redirect, so it captures the ids the change actually landed on rather
 * than the ones the user clicked.
 */
export function useBoardActions({
  wardId,
  boardId,
  board,
  index,
  canEdit,
  onSwitchBoard,
}: Options) {
  const editor = useBoardEditor({ wardId, boardId, board, canEdit, onSwitchBoard })
  const mutations = useBoardMutations()
  const history = useHistory()
  const [error, setError] = useState<string | null>(null)

  const describe = (e: unknown) =>
    setError(e instanceof Error ? e.message : 'Something went wrong saving that change.')

  const run = useCallback(
    async (fn: (ctx: EditContext) => Promise<HistoryEntry | void>) => {
      try {
        const entry = await editor.edit(fn)
        if (entry) history.push(entry)
      } catch (e) {
        describe(e)
      }
    },
    [editor, history]
  )

  // Members are ward-scoped: editing one is not editing the live board, so
  // these bypass the draft machinery entirely — including its permission check,
  // which is why they repeat it here.
  const runDirect = useCallback(
    async (fn: () => Promise<HistoryEntry | void>) => {
      try {
        if (!canEdit) throw new Error('You have view-only access to this ward.')
        const entry = await fn()
        if (entry) history.push(entry)
      } catch (e) {
        describe(e)
      }
    },
    [canEdit, history]
  )

  /**
   * Undo/redo for an assignment change: something was created, and possibly
   * some existing assignments were released to make room. Both sets come back
   * with new ids when restored, so the entry tracks them as it goes.
   */
  const assignmentEntry = (
    label: string,
    createdId: string,
    replay: () => Promise<{ id: string }>,
    released: RestorableAssignment[]
  ): HistoryEntry => {
    let currentCreatedId = createdId
    let restoredIds: string[] = []

    return {
      label,
      undo: async () => {
        await mutations.deleteAssignments.mutateAsync([currentCreatedId])
        if (released.length > 0) {
          const rows = await mutations.restoreAssignments.mutateAsync(released)
          restoredIds = rows.map((r) => r.id)
        }
      },
      redo: async () => {
        if (restoredIds.length > 0) {
          await mutations.deleteAssignments.mutateAsync(restoredIds)
          restoredIds = []
        }
        const row = await replay()
        currentCreatedId = row.id
      },
    }
  }

  const memberName = (memberId: string) =>
    index.membersById.get(memberId)?.full_name ?? 'member'

  return {
    editor,
    mutations,
    history,
    error,
    clearError: () => setError(null),

    undo: async () => {
      try {
        await history.undo()
      } catch (e) {
        describe(e)
      }
    },
    redo: async () => {
      try {
        await history.redo()
      } catch (e) {
        describe(e)
      }
    },

    // --- Groups -------------------------------------------------------------
    addGroup: (name: string, parentSourceId?: string) =>
      run(async (ctx) => {
        const parentId = parentSourceId ? ctx.id(parentSourceId) : null
        const created = await mutations.addGroup.mutateAsync({
          boardId: ctx.boardId,
          name,
          parentId,
        })

        let currentId = (created as { id: string }).id
        return {
          label: `add ${name}`,
          undo: () => mutations.deleteGroup.mutateAsync(currentId),
          redo: async () => {
            const again = await mutations.addGroup.mutateAsync({
              boardId: ctx.boardId,
              name,
              parentId,
            })
            currentId = (again as { id: string }).id
          },
        }
      }),

    renameGroup: (groupId: string, name: string) =>
      run(async (ctx) => {
        const id = ctx.id(groupId)
        const previous = index.groupsById.get(groupId)?.name
        await mutations.renameGroup.mutateAsync({ groupId: id, name })
        if (previous === undefined) return

        return {
          label: `rename ${previous}`,
          undo: () => mutations.renameGroup.mutateAsync({ groupId: id, name: previous }),
          redo: () => mutations.renameGroup.mutateAsync({ groupId: id, name }),
        }
      }),

    // Deleting a group takes its subgroups, callings and assignments with it.
    // Rebuilding that tree is a restore, not an inverse, so it isn't offered as
    // undo — the confirmation dialog is the guard here.
    deleteGroup: (groupId: string) =>
      run(async (ctx) => {
        await mutations.deleteGroup.mutateAsync(ctx.id(groupId))
      }),

    // --- Positions ----------------------------------------------------------
    addPosition: (groupId: string, title: string) =>
      run(async (ctx) => {
        const mappedGroupId = ctx.id(groupId)
        const created = await mutations.addPosition.mutateAsync({
          groupId: mappedGroupId,
          title,
        })

        let currentId = (created as { id: string }).id
        return {
          label: `add ${title}`,
          undo: () => mutations.deletePosition.mutateAsync(currentId),
          redo: async () => {
            const again = await mutations.addPosition.mutateAsync({
              groupId: mappedGroupId,
              title,
            })
            currentId = (again as { id: string }).id
          },
        }
      }),

    renamePosition: (positionId: string, title: string) =>
      run(async (ctx) => {
        const id = ctx.id(positionId)
        const previous = index.positionsById.get(positionId)?.title
        await mutations.renamePosition.mutateAsync({ positionId: id, title })
        if (previous === undefined) return

        return {
          label: `rename ${previous}`,
          undo: () => mutations.renamePosition.mutateAsync({ positionId: id, title: previous }),
          redo: () => mutations.renamePosition.mutateAsync({ positionId: id, title }),
        }
      }),

    deletePosition: (positionId: string) =>
      run(async (ctx) => {
        await mutations.deletePosition.mutateAsync(ctx.id(positionId))
      }),

    togglePositionFlag: (position: Position) =>
      run(async (ctx) => {
        const id = ctx.id(position.id)
        const flagged = !position.flagged
        await mutations.updatePosition.mutateAsync({ positionId: id, flagged })

        return {
          label: `${flagged ? 'flag' : 'unflag'} ${position.title}`,
          undo: () =>
            mutations.updatePosition.mutateAsync({ positionId: id, flagged: !flagged }),
          redo: () => mutations.updatePosition.mutateAsync({ positionId: id, flagged }),
        }
      }),

    // Only a vacant calling can be parked — the database enforces it too, but
    // saying so up front beats surfacing a constraint error.
    togglePositionActive: (position: Position) =>
      run(async (ctx) => {
        const occupants = index.byPosition.get(position.id) || []
        if (!position.inactive_at && occupants.length > 0) {
          throw new Error(
            `Release ${occupants
              .map((o) => o.member?.full_name ?? 'whoever holds it')
              .join(' and ')} from ${position.title} before marking it inactive.`
          )
        }

        const id = ctx.id(position.id)
        const previous = position.inactive_at
        const inactive_at = previous ? null : new Date().toISOString()
        await mutations.updatePosition.mutateAsync({ positionId: id, inactive_at })

        return {
          label: `${inactive_at ? 'deactivate' : 'reactivate'} ${position.title}`,
          undo: () =>
            mutations.updatePosition.mutateAsync({ positionId: id, inactive_at: previous }),
          redo: () => mutations.updatePosition.mutateAsync({ positionId: id, inactive_at }),
        }
      }),

    setPositionNotes: (positionId: string, notes: string) =>
      run(async (ctx) => {
        const id = ctx.id(positionId)
        const position = index.positionsById.get(positionId)
        const previous = position?.notes ?? null
        const next = notes.trim() || null
        await mutations.updatePosition.mutateAsync({ positionId: id, notes: next })

        return {
          label: `note on ${position?.title ?? 'calling'}`,
          undo: () => mutations.updatePosition.mutateAsync({ positionId: id, notes: previous }),
          redo: () => mutations.updatePosition.mutateAsync({ positionId: id, notes: next }),
        }
      }),

    // --- Assignments --------------------------------------------------------

    /**
     * add: leaves other callings alone.
     * move: releases the member from everything else they hold.
     * replace: releases whoever currently holds the target calling.
     */
    assign: (positionId: string, memberId: string, action: AssignAction = 'add') =>
      run(async (ctx) => {
        const sources =
          action === 'move'
            ? index.byMember.get(memberId) || []
            : action === 'replace'
              ? (index.byPosition.get(positionId) || []).map((a) => a.assignment)
              : []

        // A move onto the calling the member already holds is a no-op, not a
        // delete-then-reinsert that resets their called date.
        const alreadyHere = (index.byPosition.get(positionId) || []).some(
          (a) => a.assignment.member_id === memberId
        )
        if (alreadyHere && action !== 'replace') return

        const mappedPositionId = ctx.id(positionId)
        const released: RestorableAssignment[] = sources.map((a) => ({
          position_id: ctx.id(a.position_id),
          member_id: a.member_id,
          called_date: a.called_date,
        }))

        const created = await mutations.assignMember.mutateAsync({
          positionId: mappedPositionId,
          memberId,
          calledDate: today(),
          removeAssignmentIds: sources.map((a) => ctx.id(a.id)),
        })

        return assignmentEntry(
          `assign ${memberName(memberId)}`,
          (created as { id: string }).id,
          () =>
            mutations.assignMember.mutateAsync({
              positionId: mappedPositionId,
              memberId,
              calledDate: today(),
            }) as Promise<{ id: string }>,
          released
        )
      }),

    /**
     * Drag-and-drop move. Unlike `assign(..., 'move')` this releases only the
     * calling that was dragged, leaving the member's other callings alone.
     */
    moveAssignment: (assignmentId: string, toPositionId: string, memberId: string) =>
      run(async (ctx) => {
        const source = index.assignmentsById.get(assignmentId)
        const mappedPositionId = ctx.id(toPositionId)
        const released: RestorableAssignment[] = source
          ? [
              {
                position_id: ctx.id(source.position_id),
                member_id: source.member_id,
                called_date: source.called_date,
              },
            ]
          : []

        const created = await mutations.assignMember.mutateAsync({
          positionId: mappedPositionId,
          memberId,
          calledDate: today(),
          removeAssignmentIds: [ctx.id(assignmentId)],
        })

        return assignmentEntry(
          `move ${memberName(memberId)}`,
          (created as { id: string }).id,
          () =>
            mutations.assignMember.mutateAsync({
              positionId: mappedPositionId,
              memberId,
              calledDate: today(),
            }) as Promise<{ id: string }>,
          released
        )
      }),

    unassign: (assignmentId: string) =>
      run(async (ctx) => {
        const id = ctx.id(assignmentId)
        const source = index.assignmentsById.get(assignmentId)
        await mutations.deleteAssignment.mutateAsync(id)
        if (!source) return

        const row: RestorableAssignment = {
          position_id: ctx.id(source.position_id),
          member_id: source.member_id,
          called_date: source.called_date,
        }

        let restoredId: string | null = null
        return {
          label: `release ${memberName(source.member_id)}`,
          undo: async () => {
            const [created] = await mutations.restoreAssignments.mutateAsync([row])
            restoredId = created?.id ?? null
          },
          redo: async () => {
            if (restoredId) await mutations.deleteAssignments.mutateAsync([restoredId])
            restoredId = null
          },
        }
      }),

    setAssignmentDate: (assignmentId: string, calledDate: string) =>
      run(async (ctx) => {
        const id = ctx.id(assignmentId)
        const previous = index.assignmentsById.get(assignmentId)?.called_date
        await mutations.updateAssignmentDate.mutateAsync({ assignmentId: id, calledDate })
        if (!previous) return

        return {
          label: 'change called date',
          undo: () =>
            mutations.updateAssignmentDate.mutateAsync({
              assignmentId: id,
              calledDate: previous,
            }),
          redo: () =>
            mutations.updateAssignmentDate.mutateAsync({ assignmentId: id, calledDate }),
        }
      }),

    // --- Members (ward-scoped) ----------------------------------------------
    addMember: (full_name: string) =>
      runDirect(async () => {
        const created = await mutations.addMember.mutateAsync({ wardId, full_name })
        let currentId = (created as { id: string }).id

        return {
          label: `add ${full_name}`,
          undo: () => mutations.deleteMember.mutateAsync(currentId),
          redo: async () => {
            const again = await mutations.addMember.mutateAsync({ wardId, full_name })
            currentId = (again as { id: string }).id
          },
        }
      }),

    renameMember: (memberId: string, full_name: string) =>
      runDirect(async () => {
        const previous = index.membersById.get(memberId)?.full_name
        await mutations.updateMember.mutateAsync({ memberId, full_name })
        if (previous === undefined) return

        return {
          label: `rename ${previous}`,
          undo: () => mutations.updateMember.mutateAsync({ memberId, full_name: previous }),
          redo: () => mutations.updateMember.mutateAsync({ memberId, full_name }),
        }
      }),

    toggleMemberFlag: (member: Member) =>
      runDirect(async () => {
        const flagged = !member.flagged
        await mutations.updateMember.mutateAsync({ memberId: member.id, flagged })

        return {
          label: `${flagged ? 'flag' : 'unflag'} ${member.full_name}`,
          undo: () =>
            mutations.updateMember.mutateAsync({ memberId: member.id, flagged: !flagged }),
          redo: () => mutations.updateMember.mutateAsync({ memberId: member.id, flagged }),
        }
      }),

    // Same rule from the other side: somebody serving can't be marked inactive.
    toggleMemberActive: (member: Member) =>
      runDirect(async () => {
        const held = index.byMember.get(member.id) || []
        if (!member.archived_at && held.length > 0) {
          const titles = held
            .map((a) => index.positionsById.get(a.position_id)?.title)
            .filter(Boolean)
            .join(', ')
          throw new Error(
            `Release ${member.full_name} from ${titles || 'their calling'} before marking them inactive.`
          )
        }

        const previous = member.archived_at
        const archived_at = previous ? null : new Date().toISOString()
        await mutations.updateMember.mutateAsync({ memberId: member.id, archived_at })

        return {
          label: `${archived_at ? 'deactivate' : 'reactivate'} ${member.full_name}`,
          undo: () =>
            mutations.updateMember.mutateAsync({ memberId: member.id, archived_at: previous }),
          redo: () => mutations.updateMember.mutateAsync({ memberId: member.id, archived_at }),
        }
      }),

    setMemberNotes: (memberId: string, notes: string) =>
      runDirect(async () => {
        const member = index.membersById.get(memberId)
        const previous = member?.notes ?? null
        const next = notes.trim() || null
        await mutations.updateMember.mutateAsync({ memberId, notes: next })

        return {
          label: `note on ${member?.full_name ?? 'member'}`,
          undo: () => mutations.updateMember.mutateAsync({ memberId, notes: previous }),
          redo: () => mutations.updateMember.mutateAsync({ memberId, notes: next }),
        }
      }),
  }
}

export type BoardActions = ReturnType<typeof useBoardActions>
