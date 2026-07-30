import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { EffectiveRole, WardRoleName } from '../types'

/**
 * What the signed-in user may do in one ward.
 *
 * A system admin outranks any ward grant, so it's checked first. RLS enforces
 * all of this on the server too — this hook exists so the UI can hide controls
 * that would only fail, not as the security boundary.
 */
export function useWardRole(wardId: string) {
  return useQuery({
    queryKey: ['wardRole', wardId],
    queryFn: async (): Promise<EffectiveRole> => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return 'none'

      const profileRes = await supabase
        .from('profiles')
        .select('is_super_admin')
        .eq('id', user.id)
        .maybeSingle()

      if (profileRes.data?.is_super_admin) return 'super_admin'

      const roleRes = await supabase
        .from('ward_roles')
        .select('role')
        .eq('ward_id', wardId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (roleRes.error) throw roleRes.error
      const role = (roleRes.data as { role: WardRoleName } | null)?.role
      return role ?? 'none'
    },
    enabled: !!wardId,
  })
}

export function canEditWard(role: EffectiveRole | undefined) {
  return role === 'super_admin' || role === 'admin'
}
