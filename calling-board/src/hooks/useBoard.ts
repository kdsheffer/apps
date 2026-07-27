import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Board } from '../types'

export function useBoard(wardId: string) {
  return useQuery({
    queryKey: ['board', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .maybeSingle()

      // A ward with no promoted board yet is a normal state, not an error —
      // it's where every new ward starts, and where a wiped ward returns to.
      if (error) throw error
      return (data as Board) ?? null
    },
    enabled: !!wardId,
  })
}
