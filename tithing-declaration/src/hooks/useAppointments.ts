import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Appointment } from '../types'

/**
 * Appointments as the executive secretary handles them: entered by hand for
 * somebody who rang up, corrected when a number was taken down wrong, and
 * cancelled when a family can't come.
 */
/**
 * Nudge the dispatcher after something the clerk did that queues a message.
 *
 * Without this a cancellation sits in the queue until the next scheduled run —
 * up to a quarter of an hour during which the family has heard nothing and the
 * clerk has no reason to think anything is outstanding. The scheduled run is
 * the guarantee; this is what makes it feel immediate.
 *
 * Deliberately swallows its own failure. The message is already queued and will
 * go out on the next tick regardless, so a dispatcher that isn't deployed yet
 * should not turn a successful cancellation into an error on screen.
 */
async function nudgeDispatch(wardId: string | undefined) {
  if (!wardId) return
  try {
    await supabase.functions.invoke('dispatch-notifications', { body: { ward_id: wardId } })
  } catch {
    /* queued either way */
  }
}

export function useAppointmentMutations(wardId: string | undefined) {
  const queryClient = useQueryClient()

  const invalidate = (dayId?: string) => {
    queryClient.invalidateQueries({ queryKey: ['daySlots', dayId] })
    if (!dayId) queryClient.invalidateQueries({ queryKey: ['daySlots'] })
    queryClient.invalidateQueries({ queryKey: ['notifications', wardId] })
  }

  /**
   * Add somebody by hand. This inserts directly rather than going through
   * `book_slot()`, which is what lets the secretary do the things the public
   * flow refuses — a second appointment for a household that needs one, or a
   * booking for a family whose only phone number is already on file.
   */
  const addAppointment = useMutation({
    mutationFn: async (input: {
      slotId: string
      dayId: string
      familyName: string
      phone?: string
      email?: string
      notes?: string
    }) => {
      const { data, error } = await supabase
        .from('appointments')
        .insert({
          slot_id: input.slotId,
          // Overwritten from the slot by a trigger; sent because the column is
          // NOT NULL and the insert has to satisfy it before the trigger runs.
          ward_id: wardId,
          family_name: input.familyName.trim(),
          // A family name on its own is a complete booking here. "The Wilsons
          // rang, put them down for 6:15" is the case this exists for, and
          // losing it over a missing phone number helps nobody. They just get
          // no confirmation and no reminder — queue_notification writes to
          // whatever channels exist, and none is a routine outcome.
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          notes: input.notes?.trim() || null,
          booked_by_admin: true,
        })
        .select()
        .single()
      if (error) throw error

      // Send the confirmation only if there's somewhere to send it.
      if (input.email?.trim()) {
        await supabase.rpc('queue_notification_for_admin', {
          p_appointment_id: (data as Appointment).id,
          p_kind: 'confirmation',
        })
        await nudgeDispatch(wardId)
      }

      return data as Appointment
    },
    onSuccess: (_d, v) => invalidate(v.dayId),
  })

  const updateAppointment = useMutation({
    mutationFn: async ({
      id,
      dayId: _dayId,
      ...patch
    }: Partial<Appointment> & { id: string; dayId: string }) => {
      const { error } = await supabase.from('appointments').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: (_d, v) => invalidate(v.dayId),
  })

  /**
   * Cancel through the same RPC the public page uses, so the family gets the
   * same cancellation message however it was cancelled. Deleting the row would
   * be quieter and would tell nobody.
   */
  const cancelAppointment = useMutation({
    mutationFn: async (input: { cancelToken: string; dayId: string; reason?: string }) => {
      const { error } = await supabase.rpc('cancel_appointment', {
        p_cancel_token: input.cancelToken,
        p_reason: input.reason || null,
      })
      if (error) throw error

      // The RPC queued a cancellation if the family left an email address.
      // Push it out now rather than leaving them to find out on the night.
      await nudgeDispatch(wardId)
    },
    onSuccess: (_d, v) => invalidate(v.dayId),
  })

  return { addAppointment, updateAppointment, cancelAppointment }
}

/**
 * Bookings belonging to the signed-in user — the "My appointment" page.
 *
 * RLS returns these on `booked_by = auth.uid()` alone, so this works for
 * somebody with no role in the ward at all.
 */
export function useMyAppointments() {
  return useQuery({
    queryKey: ['myAppointments'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return []

      const { data, error } = await supabase
        .from('appointments')
        .select('*, slot:slots(starts_at, duration_minutes, day:schedule_days(service_date, location)), ward:wards(name, timezone, contact_name, contact_phone)')
        .eq('booked_by', user.id)
        .is('cancelled_at', null)
      if (error) throw error

      type Row = Appointment & {
        slot: {
          starts_at: string
          duration_minutes: number
          day: { service_date: string; location: string | null }
        } | null
        ward: {
          name: string
          timezone: string
          contact_name: string | null
          contact_phone: string | null
        } | null
      }

      return (data as Row[])
        .filter((row) => row.slot && new Date(row.slot.starts_at) > new Date())
        .sort((a, b) => a.slot!.starts_at.localeCompare(b.slot!.starts_at))
    },
  })
}
