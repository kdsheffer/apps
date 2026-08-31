/**
 * Every time in this app belongs to the ward, not to the person reading it.
 *
 * A slot is stored as an instant, and the browser would happily render it in
 * whatever zone the device is set to. That is wrong here in a way that matters:
 * a member visiting family out of state, or a phone that never left airplane
 * mode, would be told an hour that nobody is expecting them. So every formatter
 * below takes the ward's IANA zone and passes it to Intl explicitly.
 */

const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(options)
  let found = cache.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { ...options, timeZone })
    cache.set(key, found)
  }
  return found
}

/** "6:15 PM" */
export function formatTime(iso: string, timeZone: string): string {
  return formatter(timeZone, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

/** "Sunday, October 12" */
export function formatDayLong(iso: string, timeZone: string): string {
  return formatter(timeZone, { weekday: 'long', month: 'long', day: 'numeric' }).format(
    new Date(iso)
  )
}


/** "Sunday, October 12 at 6:15 PM" — the phrasing the emails use. */
export function formatSlot(iso: string, timeZone: string): string {
  return `${formatDayLong(iso, timeZone)} at ${formatTime(iso, timeZone)}`
}

/**
 * A `service_date` is a bare date with no zone attached. Reading it with
 * `new Date('2026-10-12')` gets UTC midnight, which in the Americas is the
 * evening *before* — so the schedule would show every day one off. Splitting
 * the string and building a local date avoids the round trip entirely.
 */
export function formatServiceDate(serviceDate: string): string {
  const [year, month, day] = serviceDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(year, month - 1, day))
}

/** Today in the ward's zone, as `YYYY-MM-DD` — the default for a new day. */
export function todayInZone(timeZone: string): string {
  const parts = formatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The hour a slot falls in, for grouping: "6 PM". */
export function hourLabel(iso: string, timeZone: string): string {
  return formatter(timeZone, { hour: 'numeric' }).format(new Date(iso))
}
