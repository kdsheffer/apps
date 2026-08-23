/**
 * The public surface: what a signed-out visitor can do, and — more to the point
 * — what they can find out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asAnon, asUser, errorFrom } from './harness.mjs'
import { seedWard } from './fixture.mjs'

/* Email is required for a public booking now — it carries the appointment
   details and the cancel link — so it defaults to something valid rather than
   null, and the tests that care about it pass their own. */
const book = (client, slug, slotId, family, phone, email = 'family@example.test') =>
  client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
    slug, slotId, family, phone, email,
  ])

test('booking', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('a stranger can see free times and book one', async () => {
    const { slots } = await seedWard(client, { slug: 'book-happy' })

    const booked = await asAnon(client, async () => {
      const { rows: free } = await client.query(
        'select * from public.public_schedule($1)', ['book-happy']
      )
      assert.equal(free.length, 8)
      assert.equal(free[0].location, "Bishop's office")

      const { rows } = await book(client, 'book-happy', free[0].slot_id, 'Pratt', '(801) 555-0111', 'pratt@example.test')
      return rows[0]
    })

    assert.ok(booked.cancel_token)
    // The link is what replaces the confirmation code and the lookup page.
    assert.ok(booked.cancel_url.endsWith(`/cancel/${booked.cancel_token}`))
    assert.equal(booked.location, "Bishop's office")

    // That time is gone from the public list, and only that one.
    const { rows: after } = await asAnon(client, () =>
      client.query('select * from public.public_schedule($1)', ['book-happy'])
    )
    assert.equal(after.length, 7)
    assert.equal(after.find((s) => s.slot_id === slots[0].id), undefined)
  })

  await t.test('the public schedule never reveals who booked', async () => {
    const { slots } = await seedWard(client, { slug: 'privacy' })
    await asAnon(client, () => book(client, 'privacy', slots[0].id, 'Kimball', '8015550122', 'kimball@example.test'))

    const { rows } = await asAnon(client, () =>
      client.query('select * from public.public_schedule($1)', ['privacy'])
    )

    // No column could carry a name even if one wanted to, and the taken slot is
    // absent rather than marked — so occupancy isn't inferable either.
    const columns = Object.keys(rows[0])
    assert.deepEqual(columns.sort(), [
      'day_id', 'duration_minutes', 'location', 'notes',
      'service_date', 'slot_id', 'starts_at',
    ])
    assert.equal(JSON.stringify(rows).includes('Kimball'), false)
  })

  await t.test('anon cannot read any table directly', async () => {
    await seedWard(client, { slug: 'notables' })

    await asAnon(client, async () => {
      for (const table of [
        'wards', 'schedule_days', 'slots', 'appointments',
        'notifications', 'ward_roles', 'profiles', 'lookup_attempts',
      ]) {
        const message = await errorFrom(() => client.query(`select * from public.${table}`))
        assert.match(message, /permission denied/i, `anon could read ${table}`)
      }
    })
  })

  await t.test('two people racing for one slot: exactly one wins', async () => {
    const { slots } = await seedWard(client, { slug: 'race' })
    const slot = slots[0].id

    await asAnon(client, () => book(client, 'race', slot, 'Snow', '8015550131', 'snow@example.test'))
    const message = await asAnon(client, () =>
      errorFrom(() => book(client, 'race', slot, 'Young', '8015550132', 'young@example.test'))
    )
    assert.match(message, /just taken/i)

    const { rows } = await client.query(
      'select count(*)::int as n from public.appointments where slot_id = $1 and cancelled_at is null',
      [slot]
    )
    assert.equal(rows[0].n, 1)
  })

  await t.test('a slot from another ward cannot be booked through this ward', async () => {
    const a = await seedWard(client, { slug: 'cross-a' })
    await seedWard(client, { slug: 'cross-b' })

    const message = await asAnon(client, () =>
      errorFrom(() => book(client, 'cross-b', a.slots[0].id, 'Woodruff', '8015550141', 'woodruff@example.test'))
    )
    assert.match(message, /not on this ward's schedule/i)
  })

  await t.test('an unpublished day is invisible and unbookable', async () => {
    const { slots } = await seedWard(client, { slug: 'draftday', published: false })

    const { rows } = await asAnon(client, () =>
      client.query('select * from public.public_schedule($1)', ['draftday'])
    )
    assert.equal(rows.length, 0)

    // Even with a slot id from somewhere else, the day still refuses.
    const message = await asAnon(client, () =>
      errorFrom(() => book(client, 'draftday', slots[0].id, 'Taylor', '8015550151', 'taylor@example.test'))
    )
    assert.match(message, /not open for booking/i)
  })

  await t.test('a blocked slot disappears from the public list', async () => {
    const { slots } = await seedWard(client, { slug: 'blocked' })
    await client.query(
      `update public.slots set blocked_at = now(), blocked_reason = 'bishopric meeting' where id = $1`,
      [slots[1].id]
    )

    const { rows } = await asAnon(client, () =>
      client.query('select * from public.public_schedule($1)', ['blocked'])
    )
    assert.equal(rows.length, 7)
    assert.equal(rows.find((s) => s.slot_id === slots[1].id), undefined)

    assert.match(
      await asAnon(client, () =>
        errorFrom(() => book(client, 'blocked', slots[1].id, 'Grant', '8015550161', 'grant@example.test'))
      ),
      /not available/i
    )
  })

  await t.test('a slot in the past cannot be booked', async () => {
    const { ward, day, admin } = await seedWard(client, { slug: 'past' })
    // Reach past generate_slots, which would refuse a time already gone.
    const { rows: [old] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() - interval '1 hour')
       returning *`,
      [day.id]
    )
    assert.ok(ward.id && admin)

    assert.match(
      await asAnon(client, () => errorFrom(() => book(client, 'past', old.id, 'Hinckley', '8015550171', 'hinckley@example.test'))),
      /already passed/i
    )

    // And it is not offered in the first place.
    const { rows } = await asAnon(client, () =>
      client.query('select * from public.public_schedule($1)', ['past'])
    )
    assert.equal(rows.find((s) => s.slot_id === old.id), undefined)
  })

  await t.test('one phone number holds one appointment per ward', async () => {
    const { slots } = await seedWard(client, { slug: 'dupe' })

    await asAnon(client, () => book(client, 'dupe', slots[0].id, 'Benson', '801-555-0181', 'benson@example.test'))
    const message = await asAnon(client, () =>
      // Same number, punctuated differently — still the same number.
      errorFrom(() => book(client, 'dupe', slots[1].id, 'Benson', '(801) 5550181', 'benson@example.test'))
    )
    assert.match(message, /already has an appointment/i)
  })

  await t.test('bad input is refused with something a person can act on', async () => {
    const { slots } = await seedWard(client, { slug: 'validation' })

    await asAnon(client, async () => {
      assert.match(
        await errorFrom(() => book(client, 'validation', slots[0].id, 'Lee', '123', 'lee@example.test')),
        /phone number we can reach you on/i
      )
      assert.match(
        await errorFrom(() => book(client, 'validation', slots[0].id, 'X', '8015550191', 'x@example.test')),
        /enter your family name/i
      )
      assert.match(
        await errorFrom(() => book(client, 'nonesuch', slots[0].id, 'Lee', '8015550191', 'lee@example.test')),
        /could not find that ward/i
      )
    })
  })

  await t.test('an email address that is not one is refused', async () => {
    const { slots } = await seedWard(client, { slug: 'bademail' })
    const message = await asAnon(client, () =>
      errorFrom(() =>
        client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
          'bademail', slots[0].id, 'McKay', '8015550201', 'not-an-address',
        ])
      )
    )
    assert.match(message, /appointments_email_check|violates check constraint/i)
  })
})
