import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { BookingReceipt, PublicSlot, PublicWard } from '../types'

/**
 * The signed-out half of the app.
 *
 * Every call here is an RPC, because that is the only surface `anon` has — the
 * tables themselves are revoked from it in migration 001. If one of these
 * starts failing with "permission denied", the cause is a policy change, not a
 * missing session.
 */

/**
 * Push out the message this appointment just queued, rather than leaving it for
 * the next scheduled run.
 *
 * Authorized by the cancel token, which the caller already holds — knowing it is
 * what authorizes cancelling, so scoping a send to the same appointment is
 * strictly less. Without this a member waits up to a quarter of an hour staring
 * at an empty inbox after booking, which is the worst first impression this app
 * can make and the most common path through it.
 *
 * Swallows its own failure: the message is queued either way and the schedule
 * will collect it, so a dispatcher that isn't deployed must not turn a
 * successful booking into an error on screen.
 */
async function nudgeDispatch(cancelToken: string) {
  try {
    await supabase.functions.invoke('dispatch-notifications', {
      body: { appointment_token: cancelToken },
    })
  } catch {
    /* queued either way */
  }
}

export function usePublicWard(slug: string | undefined) {
  return useQuery({
    queryKey: ['publicWard', slug],
    queryFn: async (): Promise<PublicWard | null> => {
      const { data, error } = await supabase.rpc('public_ward', { p_slug: slug })
      if (error) throw error
      return (data as PublicWard[])[0] ?? null
    },
    enabled: !!slug,
  })
}

export function usePublicSchedule(slug: string | undefined) {
  return useQuery({
    queryKey: ['publicSchedule', slug],
    queryFn: async (): Promise<PublicSlot[]> => {
      const { data, error } = await supabase.rpc('public_schedule', { p_slug: slug })
      if (error) throw error
      return (data as PublicSlot[]) ?? []
    },
    enabled: !!slug,
    // Somebody else may take the slot being looked at. Short and refetched on
    // focus, so a tab left open over dinner doesn't offer times that have gone.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useBookSlot(slug: string | undefined) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: {
      slotId: string
      familyName: string
      phone: string
      email?: string
      notes?: string
    }): Promise<BookingReceipt> => {
      const { data, error } = await supabase.rpc('book_slot', {
        p_slug: slug,
        p_slot_id: input.slotId,
        p_family_name: input.familyName,
        p_phone: input.phone,
        p_email: input.email || null,
        p_notes: input.notes || null,
      })
      if (error) throw error

      const receipt = (data as BookingReceipt[])[0]
      await nudgeDispatch(receipt.cancel_token)
      return receipt
    },
    // Whether it worked or not, what's free has changed — a success took a
    // slot, and a "just taken" means somebody else did.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['publicSchedule', slug] }),
  })
}

export function useCancelAppointment(slug?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: { cancelToken: string; reason?: string }) => {
      const { error } = await supabase.rpc('cancel_appointment', {
        p_cancel_token: input.cancelToken,
        p_reason: input.reason || null,
      })
      if (error) throw error

      await nudgeDispatch(input.cancelToken)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publicSchedule', slug] })
      queryClient.invalidateQueries({ queryKey: ['myAppointments'] })
      queryClient.invalidateQueries({ queryKey: ['appointmentByToken'] })
    },
  })
}

/**
 * Attach a booking made while signed out to the account now signed in, so it
 * shows up under "My appointment" from here on.
 */
export function useClaimAppointment() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (cancelToken: string) => {
      const { error } = await supabase.rpc('claim_appointment', { p_cancel_token: cancelToken })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['myAppointments'] }),
  })
}
