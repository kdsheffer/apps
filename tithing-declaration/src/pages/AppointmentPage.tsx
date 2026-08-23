import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import {
  useCancelAppointment,
  usePublicSchedule,
  useRescheduleAppointment,
} from '../hooks/usePublicSchedule'
import { groupByDay } from '../lib/schedule'
import { formatServiceDate, formatSlot, formatTime } from '../lib/datetime'
import { errorMessage } from '../lib/errors'

import { Alert, Card, PageShell } from '../components/PageShell'

/**
 * The page every message links to.
 *
 * This replaced a form that took a name and a phone number and told you
 * whether they matched a booking — which was, unavoidably, a way to find out
 * whether a number was booked. The token in this URL is a UUID nobody can
 * guess, and it reaches only the person who booked, so the capability goes to
 * them instead of being offered to anyone who can type.
 *
 * It offers moving as well as cancelling, and moving is the better answer to
 * "I can't make six fifteen" — cancel-and-rebook risks losing the slot to
 * somebody else in the gap, and leaves the member holding a link to a booking
 * that no longer exists.
 *
 * The token stays in the URL and is never sent anywhere else. It is worth
 * knowing that anyone the member forwards the email to can also use it — the
 * same property a paper appointment card has, and the right trade for not
 * making people remember anything.
 */
export function AppointmentPage() {
  const { token } = useParams<{ token: string }>()
  const cancel = useCancelAppointment()
  const [confirming, setConfirming] = useState(false)
  const [moving, setMoving] = useState(false)

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
              change.
            </p>
          ) : (
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setMoving((v) => !v)
                  setConfirming(false)
                }}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {moving ? 'Keep this time' : 'Change my time'}
              </button>
              <button
                onClick={() => {
                  setConfirming(true)
                  setMoving(false)
                }}
                className="rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
              >
                Cancel appointment
              </button>
            </div>
          )}

          {cancel.error && (
            <div className="mt-4">
              <Alert>{errorMessage(cancel.error, 'That could not be cancelled.')}</Alert>
            </div>
          )}

          {confirming && (
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
          )}
        </Card>

        {moving && !appt.in_past && (
          <TimePicker
            slug={appt.ward_slug}
            timezone={appt.timezone}
            token={token!}
            onDone={() => setMoving(false)}
          />
        )}

        {(appt.contact_name || appt.contact_phone) && (
          <p className="text-sm text-gray-600">
            Need something else? Contact {appt.contact_name}
            {appt.contact_name && appt.contact_phone ? ' · ' : ''}
            {appt.contact_phone}.
          </p>
        )}
      </div>
    </PageShell>
  )
}

/**
 * The free times, for somebody choosing a new one.
 *
 * Deliberately the same `public_schedule()` the booking page uses, so it shows
 * free times and nothing else — moving an appointment is not a reason to learn
 * who else is coming.
 */
function TimePicker({
  slug,
  timezone,
  token,
  onDone,
}: {
  slug: string
  timezone: string
  token: string
  onDone: () => void
}) {
  const schedule = usePublicSchedule(slug)
  const reschedule = useRescheduleAppointment(slug)
  const days = useMemo(() => groupByDay(schedule.data ?? [], timezone), [schedule.data, timezone])

  if (schedule.isLoading) return <Card>Loading available times…</Card>

  if (days.length === 0) {
    return (
      <Card>
        <p className="text-gray-700">
          There are no other times open at the moment. Your current appointment
          is unchanged.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <h2 className="font-semibold text-gray-900">Pick a new time</h2>
      <p className="mb-4 mt-1 text-sm text-gray-600">
        Your current time is released as soon as you choose.
      </p>

      {reschedule.error && (
        <div className="mb-4">
          <Alert>{errorMessage(reschedule.error, 'That time could not be taken.')}</Alert>
        </div>
      )}

      <div className="space-y-5">
        {days.map((day) => (
          <div key={day.dayId}>
            <h3 className="mb-2 text-sm font-semibold text-gray-900">
              {formatServiceDate(day.serviceDate)}
            </h3>
            {day.hours.map((group) => (
              <div key={group.hour} className="mb-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {group.hour}
                </p>
                <div className="flex flex-wrap gap-2">
                  {group.slots.map((slot) => (
                    <button
                      key={slot.slot_id}
                      disabled={reschedule.isPending}
                      onClick={() =>
                        reschedule.mutate(
                          { cancelToken: token, slotId: slot.slot_id },
                          { onSuccess: onDone }
                        )
                      }
                      className="rounded-md border border-gray-300 bg-white px-4 py-2 text-base font-medium text-gray-900 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {formatTime(slot.starts_at, timezone)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <button
        onClick={onDone}
        className="mt-2 rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
      >
        Keep my current time
      </button>
    </Card>
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
