import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export function useRealtimeSync(boardId: string | undefined) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!boardId) return

    // Subscribe to changes on all board-related tables
    const channel = supabase
      .channel(`board_${boardId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'groups', filter: `board_id=eq.${boardId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'positions',
          filter: `group_id=in.(select id from groups where board_id=eq.${boardId})`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'position_assignments',
          filter: `position_id=in.(select id from positions where group_id=in.(select id from groups where board_id=eq.${boardId}))`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'members' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log(`Realtime sync enabled for board ${boardId}`)
        }
      })

    return () => {
      channel.unsubscribe()
    }
  }, [boardId, queryClient])
}
