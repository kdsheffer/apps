import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Appointment, ScheduleDay, Slot, SlotWithAppointment } from '../types'

/**
 * The executive secretary's view: every slot on a day and whoever holds it.
 *
 * Deliberately the opposite of `usePublicSchedule`. That one hides occupancy
 * on purpose; this one is the whole point of signing in.
 */

export function useScheduleDays(wardId: string | undefined) {
  return useQuery({
    queryKey: ['scheduleDays', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('schedule_days')
        .select('*')
        .eq('ward_id', wardId!)
        .order('service_date', { ascending: false })
      if (error) throw error
      return data as ScheduleDay[]
    },
    enabled: !!wardId,
  })
}

export function useDaySlots(dayId: string | undefined) {
  return useQuery({
    queryKey: ['daySlots', dayId],
    queryFn: async (): Promise<SlotWithAppointment[]> => {
      const { data: slots, error } = await supabase
        .from('slots')
        .select('*')
        .eq('day_id', dayId!)
        .order('starts_at')
      if (error) throw error

      const ids = (slots as Slot[]).map((s) => s.id)
      if (ids.length === 0) return []

      // Fetched separately rather than through an embedded join: PostgREST
      // cannot express "only the appointment that isn't cancelled" inside one,
      // and a cancelled row leaking in would show a freed slot as taken.
      const { data: appointments, error: appointmentsError } = await supabase
        .from('appointments')
        .select('*')
        .in('slot_id', ids)
        .is('cancelled_at', null)
      if (appointmentsError) throw appointmentsError

      const bySlot = new Map(
        (appointments as Appointment[]).map((a) => [a.slot_id, a])
      )
      return (slots as Slot[]).map((slot) => ({
        ...slot,
        appointment: bySlot.get(slot.id) ?? null,
      }))
    },
    enabled: !!dayId,
  })
}

export function useScheduleMutations(wardId: string | undefined) {
  const queryClient = useQueryClient()

  const invalidate = (dayId?: string) => {
    queryClient.invalidateQueries({ queryKey: ['scheduleDays', wardId] })
    if (dayId) queryClient.invalidateQueries({ queryKey: ['daySlots', dayId] })
    else queryClient.invalidateQueries({ queryKey: ['daySlots'] })
  }

  const createDay = useMutation({
    mutationFn: async (input: { serviceDate: string; location?: string; notes?: string }) => {
      const { data: { user } } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('schedule_days')
        .insert({
          ward_id: wardId,
          service_date: input.serviceDate,
          location: input.location || null,
          notes: input.notes || null,
          created_by: user?.id,
        })
        .select()
        .single()
      if (error) throw error
      return data as ScheduleDay
    },
    onSuccess: () => invalidate(),
  })

  const updateDay = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<ScheduleDay> & { id: string }) => {
      const { error } = await supabase.from('schedule_days').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: (_d, v) => invalidate(v.id),
  })

  /**
   * Remove a day, cancelling everyone booked on it.
   *
   * Goes through `delete_schedule_day()` rather than deleting the row, because
   * a plain delete is refused while anybody holds a slot — the cascade hits the
   * guard that stops a booked slot vanishing under a family. The RPC cancels
   * each appointment and queues each family their cancellation first, which is
   * what the guard was insisting on anyway.
   *
   * Returns how many families were told.
   */
  const deleteDay = useMutation({
    mutationFn: async (input: { dayId: string; reason?: string }): Promise<number> => {
      const { data, error } = await supabase.rpc('delete_schedule_day', {
        p_day_id: input.dayId,
        p_reason: input.reason || null,
      })
      if (error) throw error
      return (data as number) ?? 0
    },
    onSuccess: () => invalidate(),
  })

  /** Wraps `generate_slots()`; returns how many were added. */
  const generateSlots = useMutation({
    mutationFn: async (input: {
      dayId: string
      start: string
      end: string
      duration?: number
      rest?: number
    }): Promise<number> => {
      // Null means "use the ward's default", which the function resolves.
      const { data, error } = await supabase.rpc('generate_slots', {
        p_day_id: input.dayId,
        p_start: input.start,
        p_end: input.end,
        p_duration: input.duration ?? null,
        p_rest: input.rest ?? null,
      })
      if (error) throw error
      return data as number
    },
    onSuccess: (_d, v) => invalidate(v.dayId),
  })

  const setSlotBlocked = useMutation({
    mutationFn: async (input: { slotId: string; dayId: string; blocked: boolean; reason?: string }) => {
      const { error } = await supabase
        .from('slots')
        .update({
          blocked_at: input.blocked ? new Date().toISOString() : null,
          blocked_reason: input.blocked ? input.reason || null : null,
        })
        .eq('id', input.slotId)
      if (error) throw error
    },
    onSuccess: (_d, v) => invalidate(v.dayId),
  })

  return { createDay, updateDay, deleteDay, generateSlots, setSlotBlocked }
}
