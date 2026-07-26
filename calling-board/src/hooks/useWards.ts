import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Ward } from '../types'

export function useWards() {
  return useQuery({
    queryKey: ['wards'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('wards')
        .select('*')
        .order('name')

      if (error) throw error
      return data as Ward[]
    },
    enabled: true,
  })
}
