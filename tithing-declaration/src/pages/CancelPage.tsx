import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCancelAppointment } from '../hooks/usePublicSchedule'
import { formatSlot } from '../lib/datetime'
import { Alert, Card, PageShell } from '../components/PageShell'

/**
 * The page the cancel link in every message points at.
 *
 * This replaced a form that took a name and a phone number and told you
 * whether they matched a booking — which was, unavoidably, a way to find out
 * whether a number was booked. The token in this URL is a UUID nobody can
 * guess, and it reaches only the person who booked, so the capability goes to
 * them instead of being offered to anyone who can type.
 *
 * The token stays in the URL and is never sent anywhere else. It is worth
 * knowing that anyone the member forwards the email to can also cancel — which
 * is the same property a paper appointment card has, and the right trade for
 * not making people remember anything.
 */
export function CancelPage() {
  const { token } = useParams<{ token: string }>()
  const cancel = useCancelAppointment()
  const [confirming, setConfirming] = useState(false)

  const appointment = useQuery({
    queryKey: ['appointmentByToken', token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('appointment_by_token', {
        p_cancel_token: token,
      })
      if (error) throw error
      return (data as AppointmentByToken[])[0] ?? null
    },
    enabled: !!token,
    retry: false,
  })

  if (appointment.isLoading) {
    return <PageShell title="Your appointment"><Card>Loading…</Card></PageShell>
  }

  if (appointment.error || !appointment.data) {
    return (
      <PageShell title="Your appointment">
        <Alert>
          We couldn't find an appointment for this link. It may have been
          cancelled already, or the link may be incomplete — check that you
          copied the whole thing from your email.
        </Alert>
      </PageShell>
    )
  }

  const appt = appointment.data
  const when = formatSlot(appt.starts_at, appt.timezone)

  if (cancel.isSuccess || appt.cancelled) {
    return (
      <PageShell title="Cancelled" subtitle={appt.ward_name}>
        <Card>
          <p className="text-gray-700">
            The appointment for {appt.family_name} on {when} is cancelled, and
            the time is open for somebody else.
          </p>
          <Link
            to={`/w/${appt.ward_slug}`}
            className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Book a different time
          </Link>
        </Card>
      </PageShell>
    )
  }

  return (
    <PageShell title="Your appointment" subtitle={appt.ward_name}>
      <div className="space-y-6">
        <Card>
          <p className="text-sm uppercase tracking-wide text-gray-500">{appt.family_name}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{when}</p>
          <p className="mt-1 text-gray-600">{appt.location ?? 'At the meetinghouse'}</p>

          {appt.in_past ? (
            <p className="mt-5 text-sm text-gray-600">
              This appointment has already passed, so there's nothing left to
              cancel.
            </p>
          ) : cancel.error ? (
            <div className="mt-5">
              <Alert>{(cancel.error as Error).message}</Alert>
            </div>
          ) : confirming ? (
            <div className="mt-5 rounded border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-700">
                Cancel this appointment? The time goes back on the schedule for
                somebody else straight away.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => cancel.mutate({ cancelToken: token! })}
                  disabled={cancel.isPending}
                  className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {cancel.isPending ? 'Cancelling…' : 'Yes, cancel it'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="mt-5 rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Cancel this appointment
            </button>
          )}
        </Card>

        {(appt.contact_name || appt.contact_phone) && (
          <p className="text-sm text-gray-600">
            Need to change the time instead? Contact {appt.contact_name}
            {appt.contact_name && appt.contact_phone ? ' · ' : ''}
            {appt.contact_phone}, or{' '}
            <Link to={`/w/${appt.ward_slug}`} className="font-medium text-blue-700 underline">
              see what else is open
            </Link>
            .
          </p>
        )}
      </div>
    </PageShell>
  )
}

interface AppointmentByToken {
  family_name: string
  starts_at: string
  duration_minutes: number
  timezone: string
  location: string | null
  ward_name: string
  ward_slug: string
  contact_name: string | null
  contact_phone: string | null
  cancelled: boolean
  in_past: boolean
}
