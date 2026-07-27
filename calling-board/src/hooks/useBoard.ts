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
        .single()

      if (error) throw error
      return data as Board
    },
    enabled: !!wardId,
  })
}
