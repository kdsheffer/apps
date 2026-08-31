import { useAuth } from '../hooks/useAuth'
import { useMyAppointments } from '../hooks/useAppointments'
import { useCancelAppointment } from '../hooks/usePublicSchedule'
import { formatSlot } from '../lib/datetime'
import { Alert, Card, PageShell } from '../components/PageShell'
import { useState } from 'react'

/**
 * What a signed-in member sees of their own booking.
 *
 * Reached through RLS on `booked_by = auth.uid()` alone, so it works for
 * somebody with no role in the ward — which is nearly everybody who ends up
 * here. Bookings made signed out appear once they've been claimed from the
 * receipt page.
 */
export function MyAppointmentsPage() {
  const { user, signOut } = useAuth()
  const { data: appointments, isLoading } = useMyAppointments()

  return (
    <PageShell
      title="My appointment"
      subtitle={user?.email}
      footer={
        <button onClick={signOut} className="font-medium text-blue-700 underline">
          Sign out
        </button>
      }
    >
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !appointments || appointments.length === 0 ? (
        <Card>
          <h2 className="font-semibold text-gray-900">Nothing booked</h2>
          <p className="mt-2 text-gray-600">
            You don't have an upcoming tithing declaration appointment saved to
            this account. If you booked without signing in, the confirmation
            email has a link to your appointment.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {appointments.map((appointment) => (
            <MyAppointmentCard key={appointment.id} appointment={appointment} />
          ))}
        </div>
      )}
    </PageShell>
  )
}

type Row = ReturnType<typeof useMyAppointments>['data'] extends (infer T)[] | undefined ? T : never

function MyAppointmentCard({ appointment }: { appointment: Row }) {
  const cancel = useCancelAppointment()
  const [confirming, setConfirming] = useState(false)

  const timezone = appointment.ward?.timezone ?? 'America/Denver'

  if (cancel.isSuccess) {
    return (
      <Card>
        <h2 className="font-semibold text-gray-900">Cancelled</h2>
        <p className="mt-2 text-gray-600">
          Your appointment has been cancelled and the time is open again.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <p className="text-sm uppercase tracking-wide text-gray-500">
        {appointment.family_name}
      </p>
      <p className="mt-1 text-xl font-bold text-gray-900">
        {appointment.slot ? formatSlot(appointment.slot.starts_at, timezone) : 'Time unavailable'}
      </p>
      <p className="mt-1 text-gray-600">
        {appointment.slot?.day?.location ?? 'At the meetinghouse'}
        {appointment.ward ? ` · ${appointment.ward.name}` : ''}
      </p>

      {cancel.error && (
        <div className="mt-4">
          <Alert>{(cancel.error as Error).message}</Alert>
        </div>
      )}

      {confirming ? (
        <div className="mt-5 rounded border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm text-gray-700">
            Cancel this appointment? The time goes back on the schedule straight away.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => cancel.mutate({ cancelToken: appointment.cancel_token })}
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
  )
}

