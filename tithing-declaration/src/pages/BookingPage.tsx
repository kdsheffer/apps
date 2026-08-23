import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { usePublicWard, usePublicSchedule, useBookSlot, useClaimAppointment } from '../hooks/usePublicSchedule'
import { groupByDay } from '../lib/schedule'
import { formatServiceDate, formatSlot, formatTime } from '../lib/datetime'
import { isPlausibleEmail, isPlausiblePhone } from '../lib/phone'
import { Alert, Card, PageShell } from '../components/PageShell'
import { Field, errorInputClass, inputClass } from '../components/Field'
import type { BookingReceipt, PublicSlot } from '../types'

/**
 * The page nearly everybody uses, and the only one most of them ever see.
 *
 * Written for somebody standing in a chapel foyer on a phone, once a year, with
 * no account and no intention of making one. So: no navigation, one decision on
 * screen at a time, and a receipt at the end with a code on it.
 *
 * What it deliberately does not show is who else has booked. The times listed
 * are the free ones; a taken slot is absent rather than greyed out, so the page
 * carries no information about anybody else's evening.
 */
export function BookingPage() {
  const { slug } = useParams<{ slug: string }>()
  const ward = usePublicWard(slug)
  const schedule = usePublicSchedule(slug)

  const [chosen, setChosen] = useState<PublicSlot | null>(null)
  const [receipt, setReceipt] = useState<BookingReceipt | null>(null)

  const timezone = ward.data?.timezone ?? 'America/Denver'
  const days = useMemo(
    () => groupByDay(schedule.data ?? [], timezone),
    [schedule.data, timezone]
  )

  if (ward.isLoading) {
    return <PageShell title="Tithing declaration"><Card>Loading…</Card></PageShell>
  }

  if (!ward.data) {
    return (
      <PageShell title="Tithing declaration">
        <Alert>
          We couldn't find a schedule at this address. Check the link you were
          given, or ask the ward clerk for a new one.
        </Alert>
      </PageShell>
    )
  }

  if (receipt) {
    return (
      <PageShell title="You're booked" subtitle={ward.data.name}>
        <Receipt receipt={receipt} wardName={ward.data.name} slug={slug!} />
      </PageShell>
    )
  }

  if (chosen) {
    return (
      <PageShell
        title="Your details"
        subtitle={`${formatSlot(chosen.starts_at, timezone)} · ${ward.data.name}`}
      >
        <BookingForm
          slug={slug!}
          slot={chosen}
          timezone={timezone}
          onBooked={setReceipt}
          onBack={() => setChosen(null)}
        />
      </PageShell>
    )
  }

  return (
    <PageShell
      title="Tithing declaration"
      subtitle={
        <>
          <p className="font-medium text-gray-700">{ward.data.name}</p>
          {ward.data.instructions && (
            <p className="mt-2 whitespace-pre-line">{ward.data.instructions}</p>
          )}
        </>
      }
      footer={
        <div className="space-y-2">
          <p>
            Already booked? Your confirmation email has a link to cancel.
          </p>
          {(ward.data.contact_name || ward.data.contact_phone) && (
            <p>
              Questions: {ward.data.contact_name}
              {ward.data.contact_name && ward.data.contact_phone ? ' · ' : ''}
              {ward.data.contact_phone}
            </p>
          )}
        </div>
      }
    >
      {schedule.isLoading ? (
        <Card>Loading available times…</Card>
      ) : schedule.error ? (
        <Alert>We couldn't load the schedule just now. Please refresh and try again.</Alert>
      ) : days.length === 0 ? (
        <Card>
          <h2 className="font-semibold text-gray-900">No times are open yet</h2>
          <p className="mt-2 text-gray-600">
            Declaration times for {ward.data.name} haven't been posted, or every
            one has been taken. Check back shortly
            {ward.data.contact_phone ? `, or call ${ward.data.contact_phone}` : ''}.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-gray-600">
            Pick a time that works for you. Each appointment is 15 minutes.
          </p>
          {days.map((day) => (
            <Card key={day.dayId}>
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900">
                  {formatServiceDate(day.serviceDate)}
                </h2>
                <p className="text-sm text-gray-600">
                  {day.location ?? 'At the meetinghouse'} · {day.count} time
                  {day.count === 1 ? '' : 's'} open
                </p>
                {day.notes && <p className="mt-1 text-sm text-gray-600">{day.notes}</p>}
              </div>

              <div className="space-y-4">
                {day.hours.map((group) => (
                  <div key={group.hour}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {group.hour}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {group.slots.map((slot) => (
                        <button
                          key={slot.slot_id}
                          onClick={() => setChosen(slot)}
                          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-base font-medium text-gray-900 hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {formatTime(slot.starts_at, timezone)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  )
}

// --- The form ---------------------------------------------------------------

function BookingForm({
  slug,
  slot,
  timezone,
  onBooked,
  onBack,
}: {
  slug: string
  slot: PublicSlot
  timezone: string
  onBooked: (receipt: BookingReceipt) => void
  onBack: () => void
}) {
  const book = useBookSlot(slug)
  const [familyName, setFamilyName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)

  const nameError = familyName.trim().length < 2 ? 'Please enter a name.' : null
  const phoneError = !isPlausiblePhone(phone) ? 'Please enter a phone number we can reach you on.' : null
  /* Required, not optional. It carries the appointment details, the reminder
     the day before, and the link that cancels — without one this booking is a
     dead end they can't get back to. Anyone without email rings the
     clerk, who can add them by hand. */
  const emailError = !email.trim()
    ? 'We need an email address to send your appointment details and reminder.'
    : !isPlausibleEmail(email)
      ? "That doesn't look like an email address."
      : null
  const invalid = nameError || phoneError || emailError

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (invalid) return

    book.mutate(
      {
        slotId: slot.slot_id,
        familyName: familyName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        notes: notes.trim() || undefined,
      },
      { onSuccess: onBooked }
    )
  }

  return (
    <Card>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {book.error && (
          <Alert>
            {(book.error as Error).message}
            {/* A lost race is the one failure with an obvious next step. */}
            {/just been taken|just taken/i.test((book.error as Error).message) && (
              <button
                type="button"
                onClick={onBack}
                className="ml-2 font-semibold underline underline-offset-2"
              >
                Pick another time
              </button>
            )}
          </Alert>
        )}

        <Field
          id="family-name"
          label="Name"
          required
          error={touched ? nameError : null}
          hint="Your name, or your household's — whatever the bishopric should see on the schedule."
        >
          <input
            id="family-name"
            type="text"
            autoComplete="family-name"
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            className={touched && nameError ? errorInputClass : inputClass}
          />
        </Field>

        <Field
          id="phone"
          label="Phone number"
          required
          error={touched ? phoneError : null}
          hint="Used to find your appointment later, and to reach you if the schedule changes."
        >
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={touched && phoneError ? errorInputClass : inputClass}
          />
        </Field>

        <Field
          id="email"
          label="Email"
          required
          error={touched ? emailError : null}
          hint="We'll send your appointment details now and a reminder the day before. Nothing else."
        >
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={touched && emailError ? errorInputClass : inputClass}
          />
        </Field>

        <Field id="notes" label="Anything the bishopric should know">
          <textarea
            id="notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="submit"
            disabled={book.isPending}
            className="rounded-md bg-blue-600 px-5 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50 sm:flex-1"
          >
            {book.isPending ? 'Booking…' : `Book ${formatTime(slot.starts_at, timezone)}`}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-md bg-gray-200 px-5 py-3 text-base font-medium text-gray-700 hover:bg-gray-300"
          >
            Pick a different time
          </button>
        </div>
      </form>
    </Card>
  )
}

// --- The receipt ------------------------------------------------------------

function Receipt({
  receipt,
  wardName,
  slug,
}: {
  receipt: BookingReceipt
  wardName: string
  slug: string
}) {
  const claim = useClaimAppointment()

  return (
    <div className="space-y-6">
      <Card>
        <p className="text-sm uppercase tracking-wide text-gray-500">Your appointment</p>
        <p className="mt-1 text-2xl font-bold text-gray-900">
          {formatSlot(receipt.starts_at, receipt.timezone)}
        </p>
        <p className="mt-1 text-gray-600">
          {receipt.location ?? 'At the meetinghouse'} · {wardName}
        </p>

        <div className="mt-6 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          <p className="font-medium">We've emailed you the details.</p>
          <p className="mt-1">
            You'll get a reminder the day before, and both messages carry a link
            that cancels this appointment if you need to.
          </p>
        </div>

        {/* Shown here too, for the gap the email doesn't cover: somebody who
            books and changes their mind before the message arrives. */}
        <div className="mt-4">
          <Link
            to={cancelPath(receipt.cancel_url)}
            className="text-sm font-medium text-blue-700 underline"
          >
            Cancel this appointment
          </Link>
        </div>
      </Card>

      {/* Only useful to somebody with an account; claiming while signed out
          returns an error, so this offers itself and reports what happened
          rather than pretending to know whether there's a session. */}
      <Card>
        <h2 className="font-semibold text-gray-900">Have an account?</h2>
        <p className="mt-1 text-sm text-gray-600">
          Save this appointment to it and it'll show up whenever you sign in.
        </p>
        {claim.isSuccess ? (
          <p className="mt-3 text-sm text-green-800">Saved to your account.</p>
        ) : (
          <>
            <button
              onClick={() => claim.mutate(receipt.cancel_token)}
              disabled={claim.isPending}
              className="mt-3 rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              {claim.isPending ? 'Saving…' : 'Save to my account'}
            </button>
            {claim.error && (
              <p className="mt-2 text-sm text-red-700">{(claim.error as Error).message}</p>
            )}
          </>
        )}
      </Card>

      <p className="text-sm text-gray-600">
        Need a different time? Cancel above, then{' '}
        <Link to={`/w/${slug}`} className="font-medium text-blue-700 underline">
          pick another
        </Link>
        .
      </p>
    </div>
  )
}

/**
 * The path part of the absolute cancel URL the server built.
 *
 * The server returns an absolute link because that is what has to go in an
 * email. In the browser we already are on the site, and routing to the path
 * keeps it a client-side navigation — and works even if `site_url` is still
 * pointing at a stale domain.
 */
function cancelPath(cancelUrl: string): string {
  try {
    return new URL(cancelUrl).pathname
  } catch {
    return cancelUrl
  }
}
