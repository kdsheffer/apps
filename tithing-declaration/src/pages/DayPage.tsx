import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { canEditWard, useWard, useWardRole } from '../hooks/useWards'
import { useDaySlots, useScheduleDays, useScheduleMutations } from '../hooks/useSchedule'
import { useAppointmentMutations } from '../hooks/useAppointments'
import { useNotifications } from '../hooks/useNotifications'
import { formatServiceDate, formatTime, hourLabel } from '../lib/datetime'
import { formatPhone, isPlausibleEmail, isPlausiblePhone } from '../lib/phone'
import { AdminShell } from '../components/AdminShell'
import { Alert, Card } from '../components/PageShell'
import { Field, inputClass } from '../components/Field'
import { TimeWindows } from '../components/TimeWindows'
import { applyWindows, describeOutcome, firstError, newWindow } from '../lib/timeWindows'
import type { TimeWindow } from '../lib/timeWindows'
import { ConfirmDialog } from '../components/ConfirmDialog'
import type { Appointment, SlotWithAppointment } from '../types'

/**
 * One declaration evening, in full.
 *
 * This is the screen the executive secretary has open on the night: every slot
 * in order, who holds it, and one click to add somebody who has just walked in.
 * It's also the page that prints — the roster is what goes to the bishopric.
 */
export function DayPage() {
  const { wardId, dayId } = useParams<{ wardId: string; dayId: string }>()
  const navigate = useNavigate()
  const { data: ward } = useWard(wardId)
  const { data: role } = useWardRole(wardId)
  const { data: days } = useScheduleDays(wardId)
  const { data: slots, isLoading } = useDaySlots(dayId)
  const { updateDay, deleteDay, generateSlots } = useScheduleMutations(wardId)
  const notifications = useNotifications(wardId)

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [extending, setExtending] = useState(false)

  const editable = canEditWard(role)
  const day = days?.find((d) => d.id === dayId)
  const timezone = ward?.timezone ?? 'America/Denver'

  const booked = useMemo(() => (slots ?? []).filter((s) => s.appointment), [slots])
  const free = useMemo(
    () => (slots ?? []).filter((s) => !s.appointment && !s.blocked_at),
    [slots]
  )

  const hours = useMemo(() => {
    const groups: { hour: string; slots: SlotWithAppointment[] }[] = []
    for (const slot of slots ?? []) {
      const hour = hourLabel(slot.starts_at, timezone)
      const last = groups[groups.length - 1]
      if (last && last.hour === hour) last.slots.push(slot)
      else groups.push({ hour, slots: [slot] })
    }
    return groups
  }, [slots, timezone])

  if (!day || !ward) {
    return (
      <AdminShell title="Schedule">
        <Card>{isLoading ? 'Loading…' : 'That day is not available to you.'}</Card>
      </AdminShell>
    )
  }

  const run = async (action: Promise<unknown>, message?: string) => {
    setError(null)
    setNotice(null)
    try {
      await action
      if (message) setNotice(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change could not be saved.')
    }
  }

  /**
   * Apply one or more blocks of times to this day.
   *
   * Returns whether everything landed, so the caller can decide about closing
   * the form — a partial failure has to stay open with its message visible.
   */
  const addBlocks = async (windows: TimeWindow[]): Promise<boolean> => {
    setError(null)
    setNotice(null)

    const outcome = await applyWindows(windows, (window) =>
      generateSlots.mutateAsync({ dayId: day.id, start: window.start, end: window.end })
    )

    const message = describeOutcome(outcome, formatServiceDate(day.service_date))
    if (outcome.failures.length > 0) {
      setError(message)
      return false
    }
    setNotice(message)
    return true
  }

  const togglePublished = () =>
    run(
      updateDay.mutateAsync({
        id: day.id,
        published_at: day.published_at ? null : new Date().toISOString(),
      }),
      day.published_at
        ? 'Hidden from the booking page.'
        : 'Open for booking — the link now shows these times.'
    )

  /**
   * Push out whatever is already queued, without waiting for the next
   * scheduled run.
   *
   * Deliberately does *not* queue anything. Reminders go out on a schedule now,
   * a day ahead; a button that could pull them forward would mean somebody
   * pressing it and texting families at the wrong time. This is only for
   * impatience about messages that already exist — a confirmation for a booking
   * just added by hand, usually.
   */
  const sendNow = async () => {
    setError(null)
    setNotice(null)
    try {
      const result = await notifications.dispatch.mutateAsync()
      if (!result.deployed) {
        setNotice(
          "Messages are queued, but delivery isn't set up yet. They'll go out once the dispatch function is deployed."
        )
        return
      }
      setNotice(
        result.sent === 0 && result.failed === 0
          ? 'Nothing was waiting to send.'
          : `Sent ${result.sent}.` +
            (result.failed ? ` ${result.failed} failed — see the messages below.` : '')
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those messages could not be sent.')
    }
  }

  return (
    <AdminShell
      wide
      title={formatServiceDate(day.service_date)}
      subtitle={`${ward.name} · ${day.location ?? 'no location set'}`}
      actions={
        editable && (
          <>
            <button
              onClick={togglePublished}
              className={`rounded px-3 py-2 text-sm font-medium ${
                day.published_at
                  ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {day.published_at ? 'Unpublish' : 'Publish'}
            </button>
            <button
              onClick={sendNow}
              disabled={notifications.dispatch.isPending}
              title="Reminders send themselves a day ahead. This only pushes out messages already waiting."
              className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              {notifications.pending > 0 ? `Send ${notifications.pending} now` : 'Send now'}
            </button>
            <button
              onClick={() => window.print()}
              className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Print
            </button>
          </>
        )
      }
    >
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {!day.published_at && (
        <Alert tone="info">
          This day isn't published, so members can't see or book any of it yet.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Booked" value={booked.length} />
        <Stat label="Still open" value={free.length} />
        <Stat label="Total times" value={slots?.length ?? 0} />
      </div>

      {day.published_at && booked.length > 0 && (
        <p className="text-sm text-gray-600">
          Everyone who booked with an email address got a confirmation, and gets
          a reminder the day before automatically. Nothing to press.
        </p>
      )}

      {slots && slots.length === 0 ? (
        <Card>
          <h2 className="font-semibold text-gray-900">No times on this day yet</h2>
          {editable && (
            <div className="mt-3">
              <ExtendForm
                onGenerate={(windows) => addBlocks(windows)}
                pending={generateSlots.isPending}
              />
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-5">
          {hours.map((group) => (
            <Card key={group.hour} className="print:break-inside-avoid print:shadow-none">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                {group.hour}
              </h2>
              <ul className="divide-y divide-gray-200">
                {group.slots.map((slot) => (
                  <SlotRow
                    key={slot.id}
                    slot={slot}
                    dayId={day.id}
                    wardId={wardId!}
                    timezone={timezone}
                    editable={editable}
                    onError={setError}
                  />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {editable && slots && slots.length > 0 && (
        <Card className="print:hidden">
          <h2 className="font-semibold text-gray-900">Add another block of times</h2>
          <p className="mb-3 mt-1 text-sm text-gray-600">
            A day can hold as many blocks as you need — one before church and
            another after, say. Times that already exist are left alone, so this
            never disturbs a booking.
          </p>
          {extending ? (
            <ExtendForm
              onGenerate={async (windows) => {
                if (await addBlocks(windows)) setExtending(false)
              }}
              pending={generateSlots.isPending}
            />
          ) : (
            <button
              onClick={() => setExtending(true)}
              className="rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              Add another block
            </button>
          )}
        </Card>
      )}

      {editable && (
        <Card className="print:hidden">
          <h2 className="font-semibold text-gray-900">Remove this day</h2>
          <p className="mt-1 text-sm text-gray-600">
            Deletes the day and all its times. Any booking on it has to be
            cancelled first — the database refuses otherwise, so a booked family
            can't be deleted out from under themselves.
          </p>
          <button
            onClick={() => setConfirmDelete(true)}
            className="mt-3 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Delete day
          </button>
        </Card>
      )}

      {notifications.list.data && notifications.list.data.length > 0 && (
        <NotificationLog wardId={wardId!} />
      )}

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this day?"
        message={`${formatServiceDate(day.service_date)} and its ${slots?.length ?? 0} times will be removed.`}
        confirmLabel="Delete day"
        isDangerous
        isLoading={deleteDay.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await deleteDay.mutateAsync(day.id)
            navigate(`/wards/${wardId}/schedule`)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'That day could not be deleted.')
            setConfirmDelete(false)
          }
        }}
      />
    </AdminShell>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-white p-4 shadow">
      <p className="text-sm text-gray-600">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  )
}

// --- One slot ---------------------------------------------------------------

function SlotRow({
  slot,
  dayId,
  wardId,
  timezone,
  editable,
  onError,
}: {
  slot: SlotWithAppointment
  dayId: string
  wardId: string
  timezone: string
  editable: boolean
  onError: (message: string | null) => void
}) {
  const { setSlotBlocked, deleteSlot } = useScheduleMutations(wardId)
  const { cancelAppointment } = useAppointmentMutations(wardId)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const run = async (action: Promise<unknown>) => {
    onError(null)
    try {
      await action
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That change could not be saved.')
    }
  }

  const appointment = slot.appointment

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-4">
          <span className="w-20 shrink-0 font-mono text-sm font-semibold text-gray-900">
            {formatTime(slot.starts_at, timezone)}
          </span>

          {appointment ? (
            <div className="min-w-0">
              <p className="font-medium text-gray-900">
                {appointment.family_name}
                {appointment.booked_by_admin && (
                  <span className="ml-2 text-xs font-normal text-gray-500">added by clerk</span>
                )}
              </p>
              {/* A booking the secretary typed in may have neither, which is
                  the whole point of letting her add one from a name alone. */}
              {(appointment.phone || appointment.email) ? (
                <p className="text-sm text-gray-600">
                  {appointment.phone && formatPhone(appointment.phone)}
                  {appointment.phone && appointment.email && ' · '}
                  {appointment.email}
                </p>
              ) : (
                <p className="text-sm text-gray-500">No contact details</p>
              )}
              {appointment.notes && (
                <p className="mt-1 text-sm text-gray-600">{appointment.notes}</p>
              )}
            </div>
          ) : slot.blocked_at ? (
            <span className="text-sm text-gray-500">
              Blocked{slot.blocked_reason ? ` — ${slot.blocked_reason}` : ''}
            </span>
          ) : (
            <span className="text-sm text-gray-400">Open</span>
          )}
        </div>

        {editable && (
          <div className="flex shrink-0 flex-wrap gap-2 print:hidden">
            {appointment ? (
              <>
                <button
                  onClick={() => setEditing((v) => !v)}
                  className="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
                >
                  {editing ? 'Close' : 'Edit'}
                </button>
                <button
                  onClick={() => setConfirmCancel(true)}
                  className="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
                >
                  Cancel booking
                </button>
              </>
            ) : (
              <>
                {!slot.blocked_at && (
                  <button
                    onClick={() => setAdding((v) => !v)}
                    className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    {adding ? 'Close' : 'Add someone'}
                  </button>
                )}
                <button
                  onClick={() =>
                    run(
                      setSlotBlocked.mutateAsync({
                        slotId: slot.id,
                        dayId,
                        blocked: !slot.blocked_at,
                      })
                    )
                  }
                  className="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
                >
                  {slot.blocked_at ? 'Unblock' : 'Block'}
                </button>
                <button
                  onClick={() => run(deleteSlot.mutateAsync({ slotId: slot.id, dayId }))}
                  aria-label={`Remove the ${formatTime(slot.starts_at, timezone)} slot`}
                  className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {(adding || editing) && (
        <AppointmentForm
          slotId={slot.id}
          dayId={dayId}
          wardId={wardId}
          existing={editing ? appointment : null}
          onDone={() => {
            setAdding(false)
            setEditing(false)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirmCancel}
        title="Cancel this booking?"
        message={
          appointment
            ? `The ${appointment.family_name} family will be sent a cancellation if they left an email address, and the time goes back on the schedule.`
            : ''
        }
        confirmLabel="Cancel booking"
        cancelLabel="Keep it"
        isDangerous
        isLoading={cancelAppointment.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={async () => {
          if (appointment) {
            await run(
              cancelAppointment.mutateAsync({ cancelToken: appointment.cancel_token, dayId })
            )
          }
          setConfirmCancel(false)
        }}
      />
    </li>
  )
}

// --- Adding and editing by hand ---------------------------------------------

/**
 * The secretary's entry form, for somebody who rang up or walked in.
 *
 * A family name on its own is a complete booking. Phone and email are offered
 * because they're useful — an email means the family gets the same confirmation
 * and reminder as anyone who booked themselves — but neither is required, and
 * a booking with neither simply gets no messages. That's a routine outcome
 * here, unlike on the public form where a member with no email would have no
 * way back to their own appointment.
 */
function AppointmentForm({
  slotId,
  dayId,
  wardId,
  existing,
  onDone,
}: {
  slotId: string
  dayId: string
  wardId: string
  existing?: Appointment | null
  onDone: () => void
}) {
  const { addAppointment, updateAppointment } = useAppointmentMutations(wardId)
  const [familyName, setFamilyName] = useState(existing?.family_name ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [email, setEmail] = useState(existing?.email ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  const pending = addAppointment.isPending || updateAppointment.isPending

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (familyName.trim().length < 2) return setError('Enter a family name.')
    // Only checked when given — blank is the ordinary case.
    if (phone.trim() && !isPlausiblePhone(phone)) return setError('That phone number looks wrong.')
    if (email.trim() && !isPlausibleEmail(email)) return setError('That email address looks wrong.')

    try {
      if (existing) {
        await updateAppointment.mutateAsync({
          id: existing.id,
          dayId,
          family_name: familyName.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
          notes: notes.trim() || null,
        })
      } else {
        await addAppointment.mutateAsync({ slotId, dayId, familyName, phone, email, notes })
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That booking could not be saved.')
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 print:hidden"
    >
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={`name-${slotId}`} label="Family name" required>
          <input
            id={`name-${slotId}`}
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field id={`phone-${slotId}`} label="Phone">
          <input
            id={`phone-${slotId}`}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          id={`email-${slotId}`}
          label="Email"
          hint={existing ? undefined : 'Leave blank and they simply get no messages.'}
        >
          <input
            id={`email-${slotId}`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field id={`notes-${slotId}`} label="Notes">
          <input
            id={`notes-${slotId}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Saving…' : existing ? 'Save changes' : 'Add booking'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- Adding blocks of times -------------------------------------------------

function ExtendForm({
  onGenerate,
  pending,
}: {
  onGenerate: (windows: TimeWindow[]) => void | Promise<unknown>
  pending: boolean
}) {
  const [windows, setWindows] = useState<TimeWindow[]>([newWindow()])
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const invalid = firstError(windows)
        if (invalid) {
          setError(`Block ${invalid.index + 1}: ${invalid.message}`)
          return
        }
        setError(null)
        onGenerate(windows)
      }}
      className="space-y-3"
    >
      <TimeWindows windows={windows} onChange={setWindows} idPrefix="extend" disabled={pending} />

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Adding…' : 'Add times'}
      </button>
      <p className="text-xs text-gray-500">
        Three an hour at :00, :15 and :30. Existing times are left alone, so
        this is safe to run again.
      </p>
    </form>
  )
}

// --- The message log --------------------------------------------------------

function NotificationLog({ wardId }: { wardId: string }) {
  const { list } = useNotifications(wardId)
  const [open, setOpen] = useState(false)
  const rows = (list.data ?? []).slice(0, 25)

  return (
    <Card className="print:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="font-semibold text-gray-900">Messages</h2>
        <span className="text-sm text-gray-500">{open ? 'Hide' : `Show (${rows.length})`}</span>
      </button>

      {open && (
        <ul className="mt-4 divide-y divide-gray-200">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  row.status === 'sent'
                    ? 'bg-green-100 text-green-800'
                    : row.status === 'failed'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-800'
                }`}
              >
                {row.status}
              </span>
              <span className="text-gray-900">{row.to_address}</span>
              <span className="text-gray-500">{row.kind}</span>
              {row.error && <span className="w-full text-xs text-red-700">{row.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
