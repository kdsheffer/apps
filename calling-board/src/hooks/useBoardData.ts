import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Group, Position, Member, PositionAssignment } from '../types'

export interface BoardData {
  groups: Group[]
  positions: Position[]
  members: Member[]
  assignments: PositionAssignment[]
}

const empty: BoardData = { groups: [], positions: [], members: [], assignments: [] }

/**
 * Everything needed to render a board. Members are ward-scoped rather than
 * board-scoped, so they're fetched by ward and persist across versions.
 */
export function useBoardData(boardId: string | undefined, wardId?: string) {
  return useQuery({
    queryKey: ['boardData', boardId, wardId],
    queryFn: async (): Promise<BoardData> => {
      if (!boardId) return empty

      const groupsRes = await supabase
        .from('groups')
        .select('*')
        .eq('board_id', boardId)
        .order('sort_order')

      if (groupsRes.error) throw groupsRes.error
      const groups = (groupsRes.data || []) as Group[]

      const positionsRes = groups.length
        ? await supabase
            .from('positions')
            .select('*')
            .in('group_id', groups.map((g) => g.id))
            .order('sort_order')
        : { data: [], error: null }

      if (positionsRes.error) throw positionsRes.error
      const positions = (positionsRes.data || []) as Position[]

      const [membersRes, assignmentsRes] = await Promise.all([
        wardId
          ? supabase.from('members').select('*').eq('ward_id', wardId)
          : supabase.from('members').select('*'),
        positions.length
          ? supabase
              .from('position_assignments')
              .select('*')
              .in('position_id', positions.map((p) => p.id))
          : Promise.resolve({ data: [], error: null }),
      ])

      if (membersRes.error) throw membersRes.error
      if (assignmentsRes.error) throw assignmentsRes.error

      return {
        groups,
        positions,
        members: (membersRes.data || []) as Member[],
        assignments: (assignmentsRes.data || []) as PositionAssignment[],
      }
    },
    enabled: !!boardId,
  })
}
