import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeWindow,
  firstError,
  formatClock,
  minutesBetween,
  newWindow,
  overlapping,
  windowError,
} from './timeWindows.ts'

const w = (start: string, end: string) => newWindow(start, end)

describe('validating a block of times', () => {
  test('a normal block is fine', () => {
    assert.equal(windowError(w('18:00', '20:30')), null)
    assert.equal(windowError(w('08:00', '08:15')), null)
  })

  test('an end at or before the start is refused', () => {
    assert.match(windowError(w('20:00', '18:00')) ?? '', /after the start time/)
    assert.match(windowError(w('18:00', '18:00')) ?? '', /after the start time/)
  })

  test('a block too short to hold one appointment is refused', () => {
    // The generator would otherwise return "0 times added" with no explanation.
    assert.match(windowError(w('18:00', '18:10')) ?? '', /at least 15 minutes/)
  })

  test('an empty field is refused before it reaches the server', () => {
    assert.match(windowError(w('', '20:30')) ?? '', /start and an end/)
  })

  test('firstError points at the offending block, not just the message', () => {
    const bad = w('20:00', '19:00')
    const found = firstError([w('08:00', '09:00'), bad, w('13:00', '14:00')])
    assert.equal(found?.window.id, bad.id)
    assert.equal(found?.index, 1, 'the index is what the message uses to name the block')
    assert.match(found?.message ?? '', /after the start time/)
  })

  test('a list with nothing wrong reports nothing', () => {
    assert.equal(firstError([w('08:00', '09:00'), w('13:00', '14:00')]), null)
  })
})

describe('overlapping blocks', () => {
  test('before church and after church do not overlap', () => {
    assert.equal(overlapping([w('08:00', '09:00'), w('13:00', '14:30')]), false)
  })

  test('blocks that touch end-to-start do not overlap', () => {
    assert.equal(overlapping([w('08:00', '09:00'), w('09:00', '10:00')]), false)
  })

  test('a genuine overlap is caught whichever order they are entered in', () => {
    assert.equal(overlapping([w('08:00', '10:00'), w('09:00', '11:00')]), true)
    assert.equal(overlapping([w('09:00', '11:00'), w('08:00', '10:00')]), true)
  })

  test('a block fully inside another counts', () => {
    assert.equal(overlapping([w('08:00', '12:00'), w('09:00', '10:00')]), true)
  })

  test('invalid blocks are ignored — they have their own error to report', () => {
    assert.equal(overlapping([w('20:00', '18:00'), w('19:00', '21:00')]), false)
  })
})

describe('describing a block', () => {
  test('renders 12-hour times the way the rest of the app does', () => {
    assert.equal(formatClock('18:00'), '6:00 PM')
    assert.equal(formatClock('08:05'), '8:05 AM')
  })

  test('midnight and noon do not come out as zero', () => {
    assert.equal(formatClock('00:00'), '12:00 AM')
    assert.equal(formatClock('12:00'), '12:00 PM')
    assert.equal(formatClock('12:30'), '12:30 PM')
  })

  test('a window reads as a range', () => {
    assert.equal(describeWindow(w('13:00', '14:30')), '1:00 PM – 2:30 PM')
  })

  test('length is measured in minutes', () => {
    assert.equal(minutesBetween('18:00', '20:30'), 150)
    assert.equal(minutesBetween('08:00', '08:15'), 15)
  })
})

describe('applying a list of blocks', () => {
  test('adds up what every block contributed', async () => {
    const { applyWindows } = await import('./timeWindows.ts')
    const outcome = await applyWindows([w('08:00', '09:00'), w('13:00', '14:00')], async () => 3)
    assert.equal(outcome.added, 6)
    assert.deepEqual(outcome.failures, [])
  })

  test('a failing block does not stop the others', async () => {
    const { applyWindows } = await import('./timeWindows.ts')
    const bad = w('20:00', '21:00')
    const outcome = await applyWindows([w('08:00', '09:00'), bad, w('13:00', '14:00')], async (win) => {
      if (win.id === bad.id) throw new Error('Only a ward admin can change the schedule.')
      return 3
    })

    // The two good blocks still applied — stopping at the first failure would
    // leave the day half built with nothing said about it.
    assert.equal(outcome.added, 6)
    assert.equal(outcome.failures.length, 1)
    assert.equal(outcome.failures[0].window.id, bad.id)
  })
})

describe('reporting what happened', () => {
  test('the ordinary case names the count and the date', async () => {
    const { describeOutcome } = await import('./timeWindows.ts')
    assert.equal(
      describeOutcome({ added: 8, failures: [] }, 'Sunday, October 12'),
      'Added 8 times to Sunday, October 12.'
    )
  })

  test('one time is not "1 times"', async () => {
    const { describeOutcome } = await import('./timeWindows.ts')
    assert.match(describeOutcome({ added: 1, failures: [] }, 'today'), /Added 1 time to today\./)
  })

  test('adding nothing says why rather than looking broken', async () => {
    const { describeOutcome } = await import('./timeWindows.ts')
    assert.match(
      describeOutcome({ added: 0, failures: [] }, 'today'),
      /No new times.*already there/
    )
  })

  test('a partial failure reports both halves', async () => {
    const { describeOutcome } = await import('./timeWindows.ts')
    const message = describeOutcome(
      { added: 3, failures: [{ window: w('20:00', '21:00'), message: 'Nope.' }] },
      'today'
    )
    assert.match(message, /Added 3 times/)
    assert.match(message, /1 block failed: 8:00 PM – 9:00 PM — Nope\./)
  })
})
