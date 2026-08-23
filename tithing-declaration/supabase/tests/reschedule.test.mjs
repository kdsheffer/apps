/**
 * Moving an appointment.
 *
 * The property that matters most here is that the appointment keeps its
 * identity: the cancel token in a member's inbox has to go on working after a
 * move, because cancel-and-rebook would leave them holding a link to a booking
 * that no longer exists and a booking whose link they were never sent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asAnon, asUser, errorFrom } from './harness.mjs'
import { seedWard } from './fixture.mjs'

test('rescheduling', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  /* A distinct number per booking. With no request headers the rate limiter
     falls back to fingerprinting on the digits, so reusing one number across
     the file trips the six-an-hour limit partway through. */
  let phoneSeq = 0
  const booked = async (slug) => {
    const { ward, day, admin, slots } = await seedWard(client, { slug })
    phoneSeq += 1
    const { rows: [made] } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        slug, slots[0].id, 'Ellis', `801555${String(1200 + phoneSeq)}`, 'ellis@example.test',
      ])
    )
    return { ward, day, admin, slots, made }
  }

  const move = (token, slotId) =>
    client
      .query('select * from public.reschedule_appointment($1, $2)', [token, slotId])
      .then(({ rows }) => rows[0])

  await t.test('moves to another time and says so', async () => {
    const { ward, slots, made } = await booked('res-happy')

    const result = await asAnon(client, () => move(made.cancel_token, slots[4].id))
    assert.equal(new Date(result.starts_at).toISOString(), new Date(slots[4].starts_at).toISOString())

    const { rows } = await client.query(
      'select slot_id from public.appointments where id = $1',
      [made.appointment_id]
    )
    assert.equal(rows[0].slot_id, slots[4].id)

    const messages = await client.query(
      `select kind from public.notifications where ward_id = $1 order by created_at`,
      [ward.id]
    )
    assert.deepEqual(messages.rows.map((r) => r.kind), ['confirmation', 'reschedule'])
  })

  await t.test('the link already emailed keeps working', async () => {
    // The whole reason this is a move rather than cancel-and-rebook.
    const { slots, made } = await booked('res-token')
    await asAnon(client, () => move(made.cancel_token, slots[3].id))

    const { rows } = await asAnon(client, () =>
      client.query('select * from public.appointment_by_token($1)', [made.cancel_token])
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].family_name, 'Ellis')
    assert.equal(new Date(rows[0].starts_at).toISOString(), new Date(slots[3].starts_at).toISOString())
  })

  await t.test('the old time is free again and the new one is taken', async () => {
    const { slots, made } = await booked('res-frees')
    await asAnon(client, () => move(made.cancel_token, slots[2].id))

    const { rows } = await asAnon(client, () =>
      client.query('select slot_id from public.public_schedule($1)', ['res-frees'])
    )
    const free = rows.map((r) => r.slot_id)
    assert.ok(free.includes(slots[0].id), 'the vacated time should be bookable')
    assert.equal(free.includes(slots[2].id), false, 'the new time should be taken')
  })

  await t.test('a time somebody else holds is refused', async () => {
    const { slots, made } = await booked('res-taken')
    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'res-taken', slots[5].id, 'Young', '8015559002', 'young@example.test',
      ])
    )

    const message = await asAnon(client, () =>
      errorFrom(() => move(made.cancel_token, slots[5].id))
    )
    assert.match(message, /just taken/i)
  })

  await t.test('a slot in another ward is refused', async () => {
    const { made } = await booked('res-ward-a')
    const other = await seedWard(client, { slug: 'res-ward-b' })
    const message = await asAnon(client, () =>
      errorFrom(() => move(made.cancel_token, other.slots[0].id))
    )
    assert.match(message, /not on this ward's schedule/i)
  })

  await t.test('a blocked or past time is refused', async () => {
    const { day, slots, made } = await booked('res-unavailable')
    await client.query('update public.slots set blocked_at = now() where id = $1', [slots[6].id])
    assert.match(
      await asAnon(client, () => errorFrom(() => move(made.cancel_token, slots[6].id))),
      /not available/i
    )

    const { rows: [past] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() - interval '1 hour') returning *`,
      [day.id]
    )
    assert.match(
      await asAnon(client, () => errorFrom(() => move(made.cancel_token, past.id))),
      /already passed/i
    )
  })

  await t.test('a cancelled appointment cannot be moved', async () => {
    const { slots, made } = await booked('res-cancelled')
    await asAnon(client, () => client.query('select public.cancel_appointment($1)', [made.cancel_token]))

    const message = await asAnon(client, () => errorFrom(() => move(made.cancel_token, slots[2].id)))
    assert.match(message, /was cancelled/i)
  })

  await t.test('moving to the time it already has does nothing', async () => {
    const { ward, slots, made } = await booked('res-noop')
    await asAnon(client, () => move(made.cancel_token, slots[0].id))

    const { rows } = await client.query(
      `select kind from public.notifications where ward_id = $1`,
      [ward.id]
    )
    // No "moved" message about a move that did not happen.
    assert.deepEqual(rows.map((r) => r.kind), ['confirmation'])
  })

  await t.test('a reminder already sent is set aside so the new time gets one', async () => {
    /* The quiet failure this guards: moving to a later day after the reminder
       went out would leave the member reminded only about the time they are no
       longer coming to. */
    const { ward, day, admin } = await seedWard(client, { slug: 'res-reminder' })
    const { rows: [soon] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() + interval '20 hours')
       returning *`,
      [day.id]
    )
    const { rows: [later] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() + interval '21 hours')
       returning *`,
      [day.id]
    )
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, email)
       values ($1, $2, 'Woodruff', 'woodruff@example.test')`,
      [soon.id, ward.id]
    )
    assert.ok(admin)

    assert.equal((await client.query('select public.queue_due_reminders() as n')).rows[0].n, 1)
    assert.equal((await client.query('select public.queue_due_reminders() as n')).rows[0].n, 0)

    const { rows: [appt] } = await client.query(
      'select cancel_token from public.appointments where ward_id = $1',
      [ward.id]
    )
    await asAnon(client, () => move(appt.cancel_token, later.id))

    // The stale reminder is set aside, so a fresh one is due again.
    assert.equal((await client.query('select public.queue_due_reminders() as n')).rows[0].n, 1)

    const { rows } = await client.query(
      `select status, count(*)::int as n from public.notifications
        where ward_id = $1 and kind = 'reminder' group by status order by status`,
      [ward.id]
    )
    assert.deepEqual(rows, [{ status: 'queued', n: 1 }, { status: 'skipped', n: 1 }])
  })

  await t.test('the executive secretary can move somebody too', async () => {
    // Same function, reached with the token the admin can read off the row.
    const { admin, slots, made } = await booked('res-admin')
    await asUser(client, admin, () => move(made.cancel_token, slots[7].id))

    const { rows } = await client.query(
      'select slot_id from public.appointments where id = $1',
      [made.appointment_id]
    )
    assert.equal(rows[0].slot_id, slots[7].id)
  })
})
