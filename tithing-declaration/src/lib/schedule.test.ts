import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { groupByDay } from './schedule.ts'
import { formatServiceDate, formatSlot, formatTime, todayInZone } from './datetime.ts'
import type { PublicSlot } from '../types/index.ts'

const TZ = 'America/Denver'

// 12 October 2026 is a Monday. 18:00 MDT is 00:00 UTC the next day, which is
// exactly the off-by-one these functions exist to avoid.
const slot = (dayId: string, iso: string): PublicSlot => ({
  day_id: dayId,
  service_date: '2026-10-12',
  location: "Bishop's office",
  notes: null,
  slot_id: `slot-${iso}`,
  starts_at: iso,
  duration_minutes: 15,
})

describe('grouping the public schedule', () => {
  test('splits an evening into hours in the ward timezone', () => {
    const days = groupByDay(
      [
        slot('d1', '2026-10-13T00:00:00Z'), // 6:00 PM MDT
        slot('d1', '2026-10-13T00:15:00Z'),
        slot('d1', '2026-10-13T00:30:00Z'),
        slot('d1', '2026-10-13T01:00:00Z'), // 7:00 PM MDT
        slot('d1', '2026-10-13T01:15:00Z'),
      ],
      TZ
    )

    assert.equal(days.length, 1)
    assert.equal(days[0].count, 5)
    assert.deepEqual(days[0].hours.map((h) => h.hour), ['6 PM', '7 PM'])
    assert.deepEqual(days[0].hours.map((h) => h.slots.length), [3, 2])
  })

  test('keeps separate days separate', () => {
    const days = groupByDay(
      [slot('d1', '2026-10-13T00:00:00Z'), slot('d2', '2026-10-20T00:00:00Z')],
      TZ
    )
    assert.deepEqual(days.map((d) => d.dayId), ['d1', 'd2'])
  })

  test('an empty schedule is an empty list, not a day with nothing in it', () => {
    assert.deepEqual(groupByDay([], TZ), [])
  })

  test('the reader\'s timezone does not move the times', () => {
    const [denver] = groupByDay([slot('d1', '2026-10-13T00:00:00Z')], TZ)
    const [honolulu] = groupByDay([slot('d1', '2026-10-13T00:00:00Z')], 'Pacific/Honolulu')

    // Same instant, two wards: each shows its own wall clock, and neither
    // shows whatever the machine running this happens to be set to.
    assert.equal(denver.hours[0].hour, '6 PM')
    assert.equal(honolulu.hours[0].hour, '2 PM')
  })
})

describe('formatting', () => {
  test('a slot reads the way the confirmation email says it', () => {
    assert.equal(formatSlot('2026-10-13T00:15:00Z', TZ), 'Monday, October 12 at 6:15 PM')
  })

  test('a time is rendered in the ward zone, not the machine zone', () => {
    assert.equal(formatTime('2026-10-13T00:15:00Z', TZ), '6:15 PM')
    assert.equal(formatTime('2026-10-13T00:15:00Z', 'America/New_York'), '8:15 PM')
  })

  test('a bare service date does not slip back a day', () => {
    // The bug this guards: new Date('2026-10-12') is UTC midnight, which is
    // 11 October in every American timezone.
    assert.equal(formatServiceDate('2026-10-12'), 'Monday, October 12, 2026')
    assert.equal(formatServiceDate('2026-01-01'), 'Thursday, January 1, 2026')
  })

  test('today in a zone is a date the date input accepts', () => {
    assert.match(todayInZone(TZ), /^\d{4}-\d{2}-\d{2}$/)
  })
})
