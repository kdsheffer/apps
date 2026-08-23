/**
 * A block of appointment times: "6:00pm until 8:30pm".
 *
 * A ward often runs two or three of these on one day — before church and after
 * — so the schedule forms edit a list of them rather than a single pair, and
 * these are the rules that list has to satisfy before it is worth submitting.
 *
 * Times are the `HH:MM` strings an `<input type="time">` produces, compared as
 * strings throughout. That works because the format is zero-padded and
 * lexicographic order matches clock order; it also keeps the whole file free of
 * dates, which is the point — a window is a pair of wall-clock times and knows
 * nothing about which day it lands on or what timezone that day is in.
 */

import { errorMessage } from './errors.ts'

export interface TimeWindow {
  /** Stable across re-renders so React can key the row while it's being edited. */
  id: string
  start: string
  end: string
}

let nextId = 0

export function newWindow(start = '18:00', end = '20:30'): TimeWindow {
  nextId += 1
  return { id: `w${nextId}`, start, end }
}

/** Why this window can't be used, or null if it's fine. */
export function windowError(window: TimeWindow): string | null {
  if (!window.start || !window.end) return 'Give this block a start and an end time.'
  if (window.end <= window.start) return 'The end time has to be after the start time.'
  // The generator needs room for at least one appointment, and the end time is
  // when the block finishes — so a 10-minute block produces nothing at all and
  // would otherwise report "0 times added" without saying why.
  if (minutesBetween(window.start, window.end) < 15) {
    return 'A block needs to be at least 15 minutes long.'
  }
  return null
}

export function minutesBetween(start: string, end: string): number {
  return toMinutes(end) - toMinutes(start)
}

function toMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * The first problem in the list, with the window that has it and where it sits.
 *
 * The index is what the message uses to point at the block. Naming it by its
 * times would be friendlier when they're valid, but the whole reason a block is
 * in here is that its times aren't — "6:00 PM – NaN:aN" identifies nothing.
 */
export function firstError(
  windows: TimeWindow[]
): { window: TimeWindow; index: number; message: string } | null {
  for (const [index, window] of windows.entries()) {
    const message = windowError(window)
    if (message) return { window, index, message }
  }
  return null
}

/**
 * Windows that cover some of the same time.
 *
 * Not an error — generating into an overlap is harmless, since existing times
 * are left alone — but almost always a typo, so the form says so rather than
 * silently adding fewer times than the secretary expected.
 */
export function overlapping(windows: TimeWindow[]): boolean {
  const usable = windows.filter((w) => !windowError(w))
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      if (usable[i].start < usable[j].end && usable[j].start < usable[i].end) return true
    }
  }
  return false
}

/** "6:00 PM" from "18:00". */
export function formatClock(clock: string): string {
  const [hours, minutes] = clock.split(':').map(Number)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

/** "6:00 PM – 8:30 PM" */
export function describeWindow(window: TimeWindow): string {
  return `${formatClock(window.start)} – ${formatClock(window.end)}`
}

/** What applying a list of windows actually did. */
export interface GenerateOutcome {
  added: number
  /** Blocks the server refused, each with the reason. Usually empty. */
  failures: { window: TimeWindow; message: string }[]
}

/**
 * Apply every window, and keep going if one of them fails.
 *
 * Each `generate_slots()` call is its own transaction, so a list can be applied
 * only in part. Stopping at the first failure would leave the day half built
 * with nothing said about it; carrying on and reporting both halves is more
 * use, and re-running is safe because the generator only ever adds times that
 * aren't already there.
 */
export async function applyWindows(
  windows: TimeWindow[],
  generate: (window: TimeWindow) => Promise<number>
): Promise<GenerateOutcome> {
  let added = 0
  const failures: GenerateOutcome['failures'] = []

  for (const window of windows) {
    try {
      added += await generate(window)
    } catch (error) {
      failures.push({
        window,
        message: errorMessage(error, 'That block could not be added.'),
      })
    }
  }

  return { added, failures }
}

/** The sentence the form shows once the windows have been applied. */
export function describeOutcome(outcome: GenerateOutcome, dateLabel: string): string {
  const { added, failures } = outcome

  const good =
    added === 0
      ? `No new times were added to ${dateLabel} — they were already there.`
      : `Added ${added} time${added === 1 ? '' : 's'} to ${dateLabel}.`

  if (failures.length === 0) return good

  const bad = failures
    .map((f) => `${describeWindow(f.window)} — ${f.message}`)
    .join('; ')

  return `${good} ${failures.length} block${failures.length === 1 ? '' : 's'} failed: ${bad}`
}
