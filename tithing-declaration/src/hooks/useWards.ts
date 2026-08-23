import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { EffectiveRole, Ward, WardRoleName } from '../types'

export function useWards() {
  return useQuery({
    queryKey: ['wards'],
    queryFn: async () => {
      const { data, error } = await supabase.from('wards').select('*').order('name')
      if (error) throw error
      return data as Ward[]
    },
  })
}

export function useWard(wardId: string | undefined) {
  return useQuery({
    queryKey: ['ward', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('wards')
        .select('*')
        .eq('id', wardId!)
        .maybeSingle()
      if (error) throw error
      return data as Ward | null
    },
    enabled: !!wardId,
  })
}

/**
 * What the signed-in user may do in one ward.
 *
 * A system admin outranks any ward grant, so it's checked first. RLS enforces
 * all of this on the server too — this hook exists so the UI can hide controls
 * that would only fail, not as the security boundary.
 */
export function useWardRole(wardId: string | undefined) {
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
        .eq('ward_id', wardId!)
        .eq('user_id', user.id)
        .maybeSingle()

      if (roleRes.error) throw roleRes.error
      return (roleRes.data as { role: WardRoleName } | null)?.role ?? 'none'
    },
    enabled: !!wardId,
  })
}

export function canEditWard(role: EffectiveRole | undefined) {
  return role === 'super_admin' || role === 'admin'
}

export function useUpdateWard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<Ward> & { id: string }) => {
      const { error } = await supabase.from('wards').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['ward', variables.id] })
      queryClient.invalidateQueries({ queryKey: ['wards'] })
    },
  })
}

/**
 * The site's own address, used to build the cancel link baked into every
 * message.
 *
 * It lives in the database rather than in an env var because the link is
 * rendered at queue time, in SQL — which is what makes a notification row a
 * faithful record of what was sent. Postgres has no way to read the browser's
 * origin, so somebody has to tell it once.
 *
 * Get this wrong and every cancel link points at the wrong host. It is the one
 * setting that silently breaks something a member sees.
 */
export function useAppSettings() {
  const queryClient = useQueryClient()

  const settings = useQuery({
    queryKey: ['appSettings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('site_url')
        .maybeSingle()
      if (error) throw error
      return data as { site_url: string } | null
    },
  })

  const update = useMutation({
    mutationFn: async (siteUrl: string) => {
      const { error } = await supabase
        .from('app_settings')
        .update({ site_url: siteUrl.replace(/\/+$/, ''), updated_at: new Date().toISOString() })
        .eq('id', true)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appSettings'] }),
  })

  return { settings, update }
}
