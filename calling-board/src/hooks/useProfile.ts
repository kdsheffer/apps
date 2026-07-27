import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return null

      const { data, error } = await supabase
        .from('profiles')
        .select('id, created_at, is_super_admin')
        .eq('id', user.id)
        .single()

      if (error) {
        console.error('Profile fetch error:', error)
        return null
      }
      return data as Profile
    },
    retry: 3,
  })
}
