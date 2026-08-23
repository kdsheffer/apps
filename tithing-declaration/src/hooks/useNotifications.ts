import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Notification } from '../types'

/**
 * Reminders.
 *
 * Reminders are not sent from here any more. A scheduled run of the
 * `dispatch-notifications` Edge Function queues everything inside its ward's
 * lead time and delivers it, so the secretary presses nothing.
 *
 * What's left for the browser is watching the queue, and a nudge to deliver
 * what's already in it — a confirmation for a booking just added by hand, say,
 * rather than waiting up to a quarter of an hour for the next tick.
 */
export function useNotifications(wardId: string | undefined) {
  const queryClient = useQueryClient()

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

  /**
   * Ask the Edge Function to drain the queue now.
   *
   * A missing deployment is reported rather than thrown: the queueing half
   * already worked, and telling the secretary "queued, but delivery isn't set
   * up" is more use than an error that makes it look like nothing happened.
   */
  const dispatch = useMutation({
    mutationFn: async (): Promise<{ sent: number; failed: number; deployed: boolean }> => {
      const { data, error } = await supabase.functions.invoke('dispatch-notifications', {
        body: { ward_id: wardId },
      })
      if (error) {
        return { sent: 0, failed: 0, deployed: false }
      }
      return { ...(data as { sent: number; failed: number }), deployed: true }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications', wardId] }),
  })

  const pending = (list.data ?? []).filter((n) => n.status === 'queued').length

  return { list, dispatch, pending }
}
