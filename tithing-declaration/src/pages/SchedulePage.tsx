import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { canEditWard, useUpdateWard, useWard, useWardRole } from '../hooks/useWards'
import { useDaySlots, useScheduleDays, useScheduleMutations } from '../hooks/useSchedule'
import { formatServiceDate, formatTime, todayInZone } from '../lib/datetime'
import { AdminShell } from '../components/AdminShell'
import { errorMessage } from '../lib/errors'
import { Alert, Card } from '../components/PageShell'
import { Field, inputClass } from '../components/Field'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { TimeWindows } from '../components/TimeWindows'
import { applyWindows, describeOutcome, firstError, newWindow } from '../lib/timeWindows'
import type { TimeWindow } from '../lib/timeWindows'
import { PublicLink } from './WardsPage'
import type { ScheduleDay, Ward } from '../types'

/**
 * A ward's declaration evenings.
 *
 * Days are listed newest first with the upcoming ones separated out, because
 * the executive secretary is nearly always working on the next one and only
 * occasionally looking back at who came in November.
 */
export function SchedulePage() {
  const { wardId } = useParams<{ wardId: string }>()
  const { data: ward, isLoading } = useWard(wardId)
  const { data: role } = useWardRole(wardId)
  const { data: days } = useScheduleDays(wardId)
  const editable = canEditWard(role)

  const [showSettings, setShowSettings] = useState(false)

  if (isLoading) return <AdminShell title="Schedule"><Card>Loading…</Card></AdminShell>
  if (!ward) {
    return (
      <AdminShell title="Schedule">
        <Alert>That ward isn't available to you.</Alert>
      </AdminShell>
    )
  }

  const today = todayInZone(ward.timezone)
  const upcoming = (days ?? []).filter((d) => d.service_date >= today)
  const past = (days ?? []).filter((d) => d.service_date < today)

  return (
    <AdminShell
      title={ward.name}
      subtitle="Tithing declaration schedule"
      actions={
        editable && (
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded bg-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
          >
            {showSettings ? 'Hide settings' : 'Ward settings'}
          </button>
        )
      }
    >
      {!editable && (
        <Alert tone="info">
          You have read-only access to this ward. You can see the schedule and
          who's booked, but not change anything.
        </Alert>
      )}

      {showSettings && editable && <WardSettings ward={ward} />}

      <Card>
        <PublicLink slug={ward.slug} />
      </Card>

      {editable && <NewDayForm wardId={wardId!} timezone={ward.timezone} />}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Upcoming</h2>
        {upcoming.length === 0 ? (
          <Card>
            <p className="text-gray-600">
              Nothing on the schedule yet.
              {editable && ' Add a day above, then generate its times.'}
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {[...upcoming].reverse().map((day) => (
              <DayRow
                key={day.id}
                day={{ ...day, timezone: ward.timezone }}
                wardId={wardId!}
                editable={editable}
              />
            ))}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Past</h2>
          <div className="space-y-3">
            {past.map((day) => (
              <DayRow
                key={day.id}
                day={{ ...day, timezone: ward.timezone }}
                wardId={wardId!}
                editable={editable}
              />
            ))}
          </div>
        </section>
      )}
    </AdminShell>
  )
}

/**
 * One evening on the ward's schedule.
 *
 * Three things happen here rather than behind a drill-down, because all three
 * are what the secretary does most: seeing whether a day is open for booking,
 * opening it, and glancing at who has signed up. The row expands in place for
 * the last of those; **Open** goes to the full page where slots are managed.
 */
function DayRow({
  day,
  wardId,
  editable,
}: {
  /* The ward's timezone rides along so the quick view can render slot times
     without every row fetching the ward again. */
  day: ScheduleDay & { timezone: string }
  wardId: string
  editable: boolean
}) {
  const { updateDay } = useScheduleMutations(wardId)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  const published = day.published_at !== null

  const setPublished = async (open: boolean) => {
    setError(null)
    try {
      await updateDay.mutateAsync({
        id: day.id,
        published_at: open ? new Date().toISOString() : null,
      })
    } catch (e) {
      // Unpublishing a day with bookings is refused by the database, and the
      // reason it gives is the one worth showing.
      setError(errorMessage(e, 'That could not be changed.'))
    }
  }

  return (
    <div className="rounded-lg bg-white shadow">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            aria-hidden="true"
            className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-gray-900">
              {formatServiceDate(day.service_date)}
            </span>
            <span className="block text-sm text-gray-600">
              {day.location ?? 'No location set'}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              published ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
            }`}
          >
            {published ? 'Open for booking' : 'Not published'}
          </span>

          {editable && (
            <button
              onClick={() => (published ? setConfirmUnpublish(true) : setPublished(true))}
              disabled={updateDay.isPending}
              className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                published
                  ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  : 'bg-green-600 text-white hover:bg-green-700'
              }`}
            >
              {published ? 'Unpublish' : 'Publish'}
            </button>
          )}

          <Link
            to={`/wards/${wardId}/schedule/${day.id}`}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open
          </Link>
        </div>
      </div>

      {error && (
        <div className="px-4 pb-4">
          <Alert onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {expanded && <DayQuickView dayId={day.id} timezone={day.timezone} />}

      <ConfirmDialog
        isOpen={confirmUnpublish}
        title="Hide this day from members?"
        message="It disappears from the booking page and nobody new can take a time. Anyone already booked keeps their appointment and is not told."
        confirmLabel="Unpublish"
        cancelLabel="Leave it open"
        isLoading={updateDay.isPending}
        onCancel={() => setConfirmUnpublish(false)}
        onConfirm={async () => {
          await setPublished(false)
          setConfirmUnpublish(false)
        }}
      />
    </div>
  )
}

/**
 * Who is coming, at a glance.
 *
 * Loaded only once the row is open — a ward with a season's worth of days would
 * otherwise fetch every slot on the schedule to show a list nobody expanded.
 */
function DayQuickView({ dayId, timezone }: { dayId: string; timezone: string }) {
  const { data: slots, isLoading } = useDaySlots(dayId)

  if (isLoading) {
    return <p className="border-t border-gray-200 px-4 py-3 text-sm text-gray-500">Loading…</p>
  }

  if (!slots || slots.length === 0) {
    return (
      <p className="border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
        No times on this day yet. Open it to add some.
      </p>
    )
  }

  const booked = slots.filter((s) => s.appointment).length
  const open = slots.filter((s) => !s.appointment && !s.blocked_at).length

  return (
    <div className="border-t border-gray-200 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        {booked} booked · {open} open
      </p>
      <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {slots.map((slot) => (
          <li key={slot.id} className="flex items-baseline gap-3 text-sm">
            <span className="w-20 shrink-0 font-mono text-gray-900">
              {formatTime(slot.starts_at, timezone)}
            </span>
            {slot.appointment ? (
              <span className="truncate text-gray-900">{slot.appointment.family_name}</span>
            ) : slot.blocked_at ? (
              <span className="text-gray-500">Blocked</span>
            ) : (
              <span className="text-gray-400">Open</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Adding a day -----------------------------------------------------------

/**
 * Adding times to a date.
 *
 * A ward holds at most one `schedule_day` per date, but often runs more than
 * one block of appointments on it — before church and after, say. So this form
 * is not really "add a day": it's "add times to this date", and whether that
 * means creating the day or adding another block to one that already exists is
 * something it works out rather than something the secretary has to know.
 *
 * Getting this wrong was the original behaviour. Picking a date that already
 * had a day failed on the unique constraint with a raw duplicate-key error,
 * and the only working path was a button labelled "Extend this evening" at the
 * bottom of the day page, which doesn't sound like it means an afternoon
 * session.
 */
function NewDayForm({ wardId, timezone }: { wardId: string; timezone: string }) {
  const { createDay, generateSlots } = useScheduleMutations(wardId)
  const { data: days } = useScheduleDays(wardId)
  const [open, setOpen] = useState(false)
  const [serviceDate, setServiceDate] = useState(todayInZone(timezone))
  const [location, setLocation] = useState("Bishop's office")
  const [windows, setWindows] = useState<TimeWindow[]>([newWindow()])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const existing = days?.find((d) => d.service_date === serviceDate)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Add appointment times
      </button>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setResult(null)

    // Checked before the day is created, so a typo in the second block doesn't
    // leave an empty day behind on the schedule.
    const invalid = firstError(windows)
    if (invalid) {
      setError(`Block ${invalid.index + 1}: ${invalid.message}`)
      return
    }

    try {
      // Creating the day and filling it are one action as far as the secretary
      // is concerned — an empty day is never what somebody wanted. And a date
      // that already has a day gets more blocks rather than an error.
      const day = existing ?? (await createDay.mutateAsync({ serviceDate, location }))

      const outcome = await applyWindows(windows, (window) =>
        generateSlots.mutateAsync({ dayId: day.id, start: window.start, end: window.end })
      )

      const dateLabel = formatServiceDate(serviceDate)
      const publishNote = existing
        ? existing.published_at
          ? " They're bookable now."
          : ' Publish the day to open them.'
        : " The day isn't open for booking until you publish it."

      setResult(describeOutcome(outcome, dateLabel) + (outcome.failures.length ? '' : publishNote))

      if (outcome.failures.length === 0) {
        setOpen(false)
        setWindows([newWindow()])
      }
    } catch (e) {
      setError(errorMessage(e, 'Those times could not be added.'))
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Add appointment times</h2>
      {error && (
        <div className="mb-4">
          <Alert onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}
      {result && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setResult(null)}>
            {result}
          </Alert>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="service-date" label="Date" required>
            <input
              id="service-date"
              type="date"
              required
              value={serviceDate}
              onChange={(e) => setServiceDate(e.target.value)}
              className={inputClass}
            />
          </Field>
          {existing ? (
            <div className="flex items-end">
              <p className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                Already on the schedule. These times will be <strong>added</strong> to that day —
                which is how you run one block before church and another after.
              </p>
            </div>
          ) : (
            <Field id="location" label="Where">
              <input
                id="location"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className={inputClass}
              />
            </Field>
          )}
        </div>

        <TimeWindows windows={windows} onChange={setWindows} idPrefix="new-day" />

        <p className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          Three appointments an hour, at :00, :15 and :30. The last quarter of
          each hour is left as buffer, so nothing is scheduled at :45.
          <br />
          Need a morning block and an afternoon one? Add the first, then come
          back and add the second to the same date.
        </p>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={createDay.isPending || generateSlots.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {createDay.isPending || generateSlots.isPending
              ? 'Adding…'
              : existing
                ? 'Add these times'
                : 'Add day and times'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  )
}

// --- Ward settings ----------------------------------------------------------

function WardSettings({ ward }: { ward: Ward }) {
  const update = useUpdateWard()
  const [instructions, setInstructions] = useState(ward.instructions ?? '')
  const [contactName, setContactName] = useState(ward.contact_name ?? '')
  const [contactPhone, setContactPhone] = useState(ward.contact_phone ?? '')
  const [saved, setSaved] = useState(false)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setSaved(false)
    update.mutate(
      {
        id: ward.id,
        instructions: instructions.trim() || null,
        contact_name: contactName.trim() || null,
        contact_phone: contactPhone.trim() || null,
      },
      { onSuccess: () => setSaved(true) }
    )
  }

  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Ward settings</h2>
      <p className="mb-4 text-sm text-gray-600">
        These appear on the public booking page and in every confirmation and
        reminder message.
      </p>

      {update.error && (
        <div className="mb-4">
          <Alert onDismiss={() => update.reset()}>{(update.error as Error).message}</Alert>
        </div>
      )}
      {saved && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setSaved(false)}>
            Saved.
          </Alert>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Field
          id="instructions"
          label="Instructions for members"
          hint="Where to come, what to bring, anything else worth saying up front."
        >
          <textarea
            id="instructions"
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="contact-name" label="Who to contact">
            <input
              id="contact-name"
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="contact-phone" label="Their phone number">
            <input
              id="contact-phone"
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          <p>
            <strong className="text-gray-900">Timezone:</strong> {ward.timezone}. Every time in
            this app — on screen and in messages — is shown in it, whatever
            timezone the reader is in.
          </p>
          <p className="mt-2">
            <strong className="text-gray-900">Reminders:</strong> sent by email{' '}
            {ward.reminder_lead_hours} hours before each appointment, automatically.
            Anyone booked without an email address gets none.
          </p>
        </div>

        <button
          type="submit"
          disabled={update.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </Card>
  )
}
