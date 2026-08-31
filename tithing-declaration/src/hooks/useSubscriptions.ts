import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export type SubscriptionKind = 'booking' | 'digest'

export interface NotificationSubscription {
  id: string
  ward_id: string
  user_id: string
  kind: SubscriptionKind
  created_at: string
}

export const SUBSCRIPTION_LABEL: Record<SubscriptionKind, string> = {
  booking: 'Every booking',
  digest: 'Day-before report',
}

export const SUBSCRIPTION_HINT: Record<SubscriptionKind, string> = {
  booking: 'An email each time somebody takes a time, with their details.',
  digest: 'One email 24 hours before each day, listing every time and who has it.',
}

/**
 * Who gets told what, for one ward.
 *
 * Deliberately not derived from roles. Being able to change the schedule and
 * wanting an email about every booking are different questions: both counsellors
 * may want the day-before report without either needing edit rights, and a
 * secretary may find per-booking email too noisy in the last week without
 * wanting to give up managing the schedule.
 */
export function useSubscriptions(wardId: string | undefined) {
  const queryClient = useQueryClient()

  const list = useQuery({
    queryKey: ['subscriptions', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notification_subscriptions')
        .select('*')
        .eq('ward_id', wardId!)
      if (error) throw error
      return data as NotificationSubscription[]
    },
    enabled: !!wardId,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['subscriptions', wardId] })

  const subscribe = useMutation({
    mutationFn: async (input: { userId: string; kind: SubscriptionKind }) => {
      const { error } = await supabase
        .from('notification_subscriptions')
        .insert({ ward_id: wardId, user_id: input.userId, kind: input.kind })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const unsubscribe = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('notification_subscriptions')
        .delete()
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  return { list, subscribe, unsubscribe }
}

/**
 * Everybody with access to one ward.
 *
 * The list the notification switches are drawn against, because those are the
 * only people who may be subscribed — a notification carries family names,
 * phone numbers and email addresses, and the database refuses to send them to
 * an account with no business in the ward.
 */
export function useWardPeople(wardId: string | undefined) {
  return useQuery({
    queryKey: ['wardPeople', wardId],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()

      const { data: roles, error } = await supabase
        .from('ward_roles')
        .select('user_id, role')
        .eq('ward_id', wardId!)
      if (error) throw error

      const ids = (roles as { user_id: string; role: string }[]).map((r) => r.user_id)
      if (ids.length === 0) return []

      // RLS decides which of these come back; a ward admin sees the people who
      // share their ward, which is exactly this set.
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .in('id', ids)
      if (profilesError) throw profilesError

      type Row = { id: string; email: string | null; full_name: string | null }
      const people = (profiles as Row[]).map((p) => ({ ...p, isSelf: p.id === user?.id }))

      /* A system admin has access to every ward without holding a role in any
       * of them, so they never appear in this list — and could not subscribe
       * themselves to a ward they administer. Add them when they're missing;
       * the database is the authority on whether the subscription is allowed. */
      if (user && !people.some((p) => p.id === user.id)) {
        const { data: me } = await supabase
          .from('profiles')
          .select('id, email, full_name, is_super_admin')
          .eq('id', user.id)
          .maybeSingle()
        const self = me as (Row & { is_super_admin: boolean }) | null
        if (self?.is_super_admin) {
          people.push({
            id: self.id,
            email: self.email,
            full_name: self.full_name,
            isSelf: true,
          })
        }
      }

      return people.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))
    },
    enabled: !!wardId,
  })
}
