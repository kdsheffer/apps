import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Notification } from '../types'

/**
 * Reminders.
 *
 * Nothing is sent from here. Confirmations and cancellations dispatch
 * themselves the moment they are written (a trigger on `notifications`), and
 * reminders go out on the schedule. All that is left for the browser is
 * watching what happened.
 */
export function useNotifications(wardId: string | undefined) {
  const list = useQuery({
    queryKey: ['notifications', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('ward_id', wardId!)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return data as Notification[]
    },
    enabled: !!wardId,
  })

  return { list }
}
