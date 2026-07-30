import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { forkBoard, loadIdMap } from '../lib/forkBoard'
import { WORKING_DRAFT_NAME } from './useBoardVersioning'
import type { Board } from '../types'

/**
 * The board an edit should actually be written to, plus a translator from the
 * ids the user clicked on to the ids that exist on that board.
 */
export interface EditContext {
  boardId: string
  /** Translates a source id to its counterpart on the editable board. */
  id: (sourceId: string) => string
  /** True when this edit caused (or landed in) a draft instead of the live board. */
  redirected: boolean
}

interface Options {
  wardId: string
  boardId: string
  board: Board | null | undefined
  /** False for a ward viewer, who may look but not touch. */
  canEdit: boolean
  onSwitchBoard: (boardId: string) => void
}

/**
 * Makes promoted boards immutable. Any edit attempted while viewing the live
 * board is transparently redirected into the ward's one draft — created on the
 * first edit, reused by every edit after that — and the view follows it.
 *
 * Archived boards are read-only with no redirect: they're history, and the
 * ward's draft already belongs to the live board.
 */
export function useBoardEditor({ wardId, boardId, board, canEdit, onSwitchBoard }: Options) {
  const queryClient = useQueryClient()
  const [forking, setForking] = useState(false)
  const [lastForkedTo, setLastForkedTo] = useState<string | null>(null)
  // Two quick clicks on the live board must not race into two forks.
  const inFlight = useRef<Promise<EditContext> | null>(null)

  const isLive = board?.status === 'promoted'
  const isArchived = board?.status === 'archived'
  const isReadOnly = isArchived || !canEdit

  const resolve = useCallback(async (): Promise<EditContext> => {
    if (!canEdit) {
      throw new Error('You have view-only access to this ward.')
    }
    if (isArchived) {
      throw new Error('Archived boards are read-only. Load the draft to make changes.')
    }

    if (!isLive || !board) {
      return { boardId, id: (id) => id, redirected: false }
    }

    const existingRes = await supabase
      .from('boards')
      .select('*')
      .eq('ward_id', wardId)
      .eq('status', 'draft')
      .maybeSingle()

    if (existingRes.error) throw existingRes.error

    const strict = (ids: Map<string, string>[]) => (sourceId: string) => {
      for (const map of ids) {
        const hit = map.get(sourceId)
        if (hit) return hit
      }
      // Falling back to the source id here would write straight to the live
      // board — the one thing this hook exists to prevent.
      throw new Error(
        'That item is missing from the working draft. Reload the board and try again.'
      )
    }

    if (existingRes.data) {
      const draft = existingRes.data as Board
      const ids = await loadIdMap(draft.id)
      return {
        boardId: draft.id,
        id: strict([ids.groups, ids.positions, ids.assignments]),
        redirected: true,
      }
    }

    const { board: draft, ids } = await forkBoard(board.id, { name: WORKING_DRAFT_NAME })

    return {
      boardId: draft.id,
      id: strict([ids.groups, ids.positions, ids.assignments]),
      redirected: true,
    }
  }, [board, boardId, canEdit, isArchived, isLive, wardId])

  /**
   * Runs an edit against the correct board. Wrap every mutation in this — the
   * callback receives the board id to write to and an id translator.
   */
  const edit = useCallback(
    async <T,>(run: (ctx: EditContext) => Promise<T>): Promise<T> => {
      if (!inFlight.current) {
        setForking(isLive && canEdit)
        inFlight.current = resolve().finally(() => {
          inFlight.current = null
          setForking(false)
        })
      }

      const ctx = await inFlight.current
      const result = await run(ctx)

      if (ctx.redirected) {
        queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
        queryClient.invalidateQueries({ queryKey: ['draft', wardId] })
        setLastForkedTo(ctx.boardId)
        onSwitchBoard(ctx.boardId)
      }

      return result
    },
    [canEdit, isLive, onSwitchBoard, queryClient, resolve, wardId]
  )

  return {
    edit,
    isLive,
    isArchived,
    isReadOnly,
    forking,
    lastForkedTo,
    dismissForkNotice: () => setLastForkedTo(null),
  }
}
