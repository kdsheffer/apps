import type { PublicSlot } from '../types'
import { hourLabel } from './datetime.ts'

/**
 * Shaping the flat list `public_schedule()` returns into the two levels the
 * booking page shows: an evening, and the hours inside it.
 *
 * Grouping by hour is not decoration. Three slots an hour with a gap at :45
 * reads as an undifferentiated column of times when it is flat, and a member
 * scanning for "sometime after seven" has to read every row. Under an hour
 * heading they can skip straight to it.
 */

export interface SlotGroup {
  hour: string
  slots: PublicSlot[]
}

export interface DayGroup {
  dayId: string
  serviceDate: string
  location: string | null
  notes: string | null
  hours: SlotGroup[]
  count: number
}

export function groupByDay(slots: PublicSlot[], timeZone: string): DayGroup[] {
  const days = new Map<string, DayGroup>()

  for (const slot of slots) {
    let day = days.get(slot.day_id)
    if (!day) {
      day = {
        dayId: slot.day_id,
        serviceDate: slot.service_date,
        location: slot.location,
        notes: slot.notes,
        hours: [],
        count: 0,
      }
      days.set(slot.day_id, day)
    }

    const hour = hourLabel(slot.starts_at, timeZone)
    // The rows arrive ordered by time, so the hour being added to is always the
    // last one — no need to search the list.
    const current = day.hours[day.hours.length - 1]
    if (current && current.hour === hour) {
      current.slots.push(slot)
    } else {
      day.hours.push({ hour, slots: [slot] })
    }
    day.count += 1
  }

  return [...days.values()]
}
