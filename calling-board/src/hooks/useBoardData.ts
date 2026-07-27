import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Group, Position, Member, PositionAssignment } from '../types'

interface BoardData {
  groups: Group[]
  positions: Position[]
  members: Member[]
  assignments: PositionAssignment[]
}

export function useBoardData(boardId: string | undefined) {
  return useQuery({
    queryKey: ['boardData', boardId],
    queryFn: async (): Promise<BoardData> => {
      if (!boardId) return { groups: [], positions: [], members: [], assignments: [] }

      const [groupsRes, positionsRes, membersRes, assignmentsRes] = await Promise.all([
        supabase.from('groups').select('*').eq('board_id', boardId),
        supabase.from('positions').select('*').in(
          'group_id',
          (await supabase.from('groups').select('id').eq('board_id', boardId)).data?.map(g => g.id) || []
        ),
        supabase.from('members').select('*'),
        supabase.from('position_assignments').select('*').in(
          'position_id',
          (await supabase.from('positions').select('id').in(
            'group_id',
            (await supabase.from('groups').select('id').eq('board_id', boardId)).data?.map(g => g.id) || []
          )).data?.map(p => p.id) || []
        ),
      ])

      return {
        groups: groupsRes.data || [],
        positions: positionsRes.data || [],
        members: membersRes.data || [],
        assignments: assignmentsRes.data || [],
      }
    },
    enabled: !!boardId,
  })
}
