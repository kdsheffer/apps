import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Profile, WardRole, WardRoleName } from '../types'

/**
 * The admin console's view of who can get in.
 *
 * `profiles` is the list of people who have signed in at least once — there's
 * no invite flow, so an account has to exist before it can be granted anything.
 * RLS decides what comes back: a system admin sees everyone, a ward admin sees
 * only the people who share a ward with them.
 */
export function useAccessAdmin() {
  const queryClient = useQueryClient()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['adminProfiles'] })
    queryClient.invalidateQueries({ queryKey: ['adminWardRoles'] })
    queryClient.invalidateQueries({ queryKey: ['wardRole'] })
    queryClient.invalidateQueries({ queryKey: ['profile'] })
  }

  const profiles = useQuery({
    queryKey: ['adminProfiles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, created_at, is_super_admin, email, full_name')
        .order('email')

      if (error) throw error
      return (data || []) as Profile[]
    },
  })

  const wardRoles = useQuery({
    queryKey: ['adminWardRoles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ward_roles')
        .select('id, ward_id, user_id, role, granted_by, granted_at')

      if (error) throw error
      return (data || []) as WardRole[]
    },
  })

  const setSuperAdmin = useMutation({
    mutationFn: async ({ userId, value }: { userId: string; value: boolean }) => {
      const { data, error } = await supabase
        .from('profiles')
        .update({ is_super_admin: value })
        .eq('id', userId)
        .select('id')

      if (error) throw error
      // RLS refuses silently by matching no rows — most often because this is
      // the admin's own account, which they deliberately can't demote.
      if (!data || data.length === 0) {
        throw new Error(
          "That change was refused. You can't change your own system admin access."
        )
      }
    },
    onSuccess: invalidate,
  })

  const grantWardRole = useMutation({
    mutationFn: async ({
      wardId,
      userId,
      role,
    }: {
      wardId: string
      userId: string
      role: WardRoleName
    }) => {
      const granted_by = (await supabase.auth.getUser()).data.user?.id
      const { error } = await supabase
        .from('ward_roles')
        .upsert(
          { ward_id: wardId, user_id: userId, role, granted_by },
          { onConflict: 'ward_id,user_id' }
        )

      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const revokeWardRole = useMutation({
    mutationFn: async (roleId: string) => {
      const { error } = await supabase.from('ward_roles').delete().eq('id', roleId)
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  return { profiles, wardRoles, setSuperAdmin, grantWardRole, revokeWardRole }
}
