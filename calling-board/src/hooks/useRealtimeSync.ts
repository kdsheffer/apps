import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { touches, type ChangePayload } from '../lib/realtimeRelevance'
import type { BoardData } from './useBoardData'

/**
 * Keeps the loaded board in step with what everyone else is doing to it.
 *
 * Realtime filters compare one column to a literal — there are no joins — so
 * how far a subscription can be narrowed on the server varies by table:
 *
 *   groups              board_id is right there. Filtered server-side.
 *   members             ward-scoped, same. Filtered server-side.
 *   positions           only their group knows the board, so these arrive
 *   position_assignments unfiltered and are matched against the ids already in
 *                       the query cache.
 *
 * Interpolating the ids as `in.(…)` was the alternative, but a ward's board has
 * hundreds of positions — a filter string that size, rebuilt and resubscribed
 * every time a calling is added, is worse than a set lookup.
 */
export function useRealtimeSync(boardId: string | undefined, wardId?: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!boardId) return

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
    }

    /**
     * Read live from the cache on each event rather than closing over a
     * snapshot: a calling added a moment ago has to be recognised without
     * tearing down the subscription and building it again.
     */
    const currentIds = () => {
      const groups = new Set<string>()
      const positions = new Set<string>()

      for (const [, data] of queryClient.getQueriesData<BoardData>({
        queryKey: ['boardData', boardId],
      })) {
        if (!data) continue
        for (const group of data.groups) groups.add(group.id)
        for (const position of data.positions) positions.add(position.id)
      }

      return { groups, positions }
    }

    const channel = supabase
      .channel(`board_${boardId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'groups', filter: `board_id=eq.${boardId}` },
        invalidate
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'positions' },
        (payload) => {
          // A calling in a group this board doesn't have belongs to another
          // board — most often this ward's draft while the live board is up.
          if (touches(payload as ChangePayload, 'group_id', currentIds().groups)) invalidate()
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'position_assignments' },
        (payload) => {
          if (touches(payload as ChangePayload, 'position_id', currentIds().positions)) {
            invalidate()
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'members',
          // Members are ward-scoped and shared by every version of the board,
          // so the ward is the right scope. Without a ward id — nothing calls
          // it that way today — take them all rather than miss one.
          ...(wardId ? { filter: `ward_id=eq.${wardId}` } : {}),
        },
        invalidate
      )
      .subscribe()

    return () => {
      // Drop the channel rather than only unsubscribing: leaving it registered
      // leaks a channel per board switch, and the socket eventually refuses to
      // add more.
      supabase.removeChannel(channel)
    }
  }, [boardId, queryClient, wardId])
}
