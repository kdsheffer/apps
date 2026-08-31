/**
 * What the ward's own people are told.
 *
 * The design being checked here is that this is driven by subscription rather
 * than by role. A manager who has not subscribed gets nothing; a viewer who has
 * gets everything. Being able to change the schedule and wanting to hear about
 * it are separate questions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asAnon, asUser, refused } from './harness.mjs'
import { seedWard } from './fixture.mjs'

const subscribe = (client, wardId, userId, kind) =>
  client.query(
    `insert into public.notification_subscriptions (ward_id, user_id, kind)
     values ($1, $2, $3) on conflict do nothing`,
    [wardId, userId, kind]
  )

const staffMail = (client, wardId, kind) =>
  client
    .query(
      `select to_address, subject, body from public.notifications
        where ward_id = $1 and kind = $2 order by to_address`,
      [wardId, kind]
    )
    .then(({ rows }) => rows)

test('booking alerts', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('nobody subscribed means nobody is written to', async () => {
    const { ward, slots } = await seedWard(client, { slug: 'alert-none' })
    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'alert-none', slots[0].id, 'Pratt', '8015551301', 'pratt@example.test',
      ])
    )
    assert.deepEqual(await staffMail(client, ward.id, 'booking'), [])
  })

  await t.test('a subscriber gets the details they need to act on', async () => {
    const { ward, admin, slots } = await seedWard(client, { slug: 'alert-one' })
    await subscribe(client, ward.id, admin, 'booking')

    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5, $6)', [
        'alert-one', slots[1].id, 'Kimball', '801-555-1302', 'kimball@example.test',
        'Wheelchair access please',
      ])
    )

    const mail = await staffMail(client, ward.id, 'booking')
    assert.equal(mail.length, 1)
    assert.equal(mail[0].to_address, 'admin-alert-one@example.test')
    assert.match(mail[0].subject, /^Kimball booked /)
    assert.match(mail[0].body, /801-555-1302/)
    assert.match(mail[0].body, /kimball@example\.test/)
    assert.match(mail[0].body, /Wheelchair access please/)
  })

  await t.test('a viewer can subscribe; a manager who has not gets nothing', async () => {
    // The whole point of splitting this from roles.
    const { ward, viewer, slots } = await seedWard(client, { slug: 'alert-viewer' })
    await subscribe(client, ward.id, viewer, 'booking')

    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'alert-viewer', slots[0].id, 'Snow', '8015551303', 'snow@example.test',
      ])
    )

    const mail = await staffMail(client, ward.id, 'booking')
    assert.deepEqual(mail.map((m) => m.to_address), ['viewer-alert-viewer@example.test'])
  })

  await t.test('each subscriber gets their own row, not one shared', async () => {
    // A bad address for one person must not cost the others their copy.
    const { ward, admin, viewer, root, slots } = await seedWard(client, { slug: 'alert-many' })
    for (const who of [admin, viewer, root]) await subscribe(client, ward.id, who, 'booking')

    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'alert-many', slots[0].id, 'Young', '8015551304', 'young@example.test',
      ])
    )
    assert.equal((await staffMail(client, ward.id, 'booking')).length, 3)
  })

  await t.test('a booking the secretary typed in alerts too', async () => {
    const { ward, admin, slots } = await seedWard(client, { slug: 'alert-manual' })
    await subscribe(client, ward.id, admin, 'booking')

    await asUser(client, admin, () =>
      client.query(
        `insert into public.appointments (slot_id, ward_id, family_name, booked_by_admin)
         values ($1, $2, 'Taylor', true)`,
        [slots[0].id, ward.id]
      )
    )

    const mail = await staffMail(client, ward.id, 'booking')
    assert.equal(mail.length, 1)
    // Name only is a complete booking; the alert says what is missing.
    assert.match(mail[0].body, /Phone: not given/)
  })

  await t.test('the alert is not swept up by anything about the appointment', async () => {
    /* Booking alerts carry a null appointment_id on purpose. A reschedule sets
       aside the member's stale reminder, and must not touch the ward's copy. */
    const { ward, admin, slots } = await seedWard(client, { slug: 'alert-detached' })
    await subscribe(client, ward.id, admin, 'booking')
    const { rows: [made] } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'alert-detached', slots[0].id, 'Grant', '8015551305', 'grant@example.test',
      ])
    )

    await asAnon(client, () =>
      client.query('select * from public.reschedule_appointment($1, $2)', [
        made.cancel_token, slots[4].id,
      ])
    )

    const { rows } = await client.query(
      `select status from public.notifications where ward_id = $1 and kind = 'booking'`,
      [ward.id]
    )
    assert.deepEqual(rows, [{ status: 'queued' }])
  })

  await t.test('only somebody with ward access can be subscribed', async () => {
    const { ward, admin, outsider } = await seedWard(client, { slug: 'alert-perms' })

    // An admin cannot point a ward's booking details at an unrelated account.
    assert.ok(
      await asUser(client, admin, () =>
        refused(() => subscribe(client, ward.id, outsider, 'booking'))
      )
    )
    // Nor can an outsider subscribe themselves.
    assert.ok(
      await asUser(client, outsider, () =>
        refused(() => subscribe(client, ward.id, outsider, 'booking'))
      )
    )
    // A viewer may subscribe themselves.
    const { viewer } = await seedWard(client, { slug: 'alert-perms-2' })
    assert.ok(viewer)
  })
})

test('the day-before report', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  /** A published day whose first slot is `hours` away, with some of it booked. */
  const dayIn = async (slug, hours, bookings) => {
    const { ward, day, admin, viewer } = await seedWard(client, { slug })
    await client.query('delete from public.slots where day_id = $1', [day.id])

    const slots = []
    for (let i = 0; i < 4; i++) {
      const { rows: [slot] } = await client.query(
        `insert into public.slots (day_id, starts_at)
         values ($1, now() + make_interval(mins => $2)) returning *`,
        [day.id, Math.round(hours * 60) + i * 15]
      )
      slots.push(slot)
    }
    for (const [i, name] of bookings) {
      await client.query(
        `insert into public.appointments (slot_id, ward_id, family_name)
         values ($1, $2, $3)`,
        [slots[i].id, ward.id, name]
      )
    }
    return { ward, day, admin, viewer, slots }
  }

  const run = () =>
    client.query('select public.queue_day_digests() as n').then(({ rows }) => rows[0].n)

  await t.test('lists who is coming and which times are empty', async () => {
    const { ward, admin } = await dayIn('dig-listing', 20, [[0, 'Sheffer'], [2, 'Pratt']])
    await subscribe(client, ward.id, admin, 'digest')

    assert.equal(await run(), 1)
    const [mail] = await staffMail(client, ward.id, 'digest')
    assert.match(mail.subject, /2 of 4 booked/)
    // Keyed on the day itself, not on text inside the subject.
    const keyed = await client.query(
      `select day_id from public.notifications where ward_id = $1 and kind = 'digest'`,
      [ward.id]
    )
    assert.notEqual(keyed.rows[0].day_id, null)
    assert.match(mail.body, /Sheffer/)
    assert.match(mail.body, /Pratt/)
    // The empty ones are the point of the report.
    assert.match(mail.body, /—/)
  })

  await t.test('says so plainly when nobody has signed up', async () => {
    const { ward, admin } = await dayIn('dig-empty', 20, [])
    await subscribe(client, ward.id, admin, 'digest')

    await run()
    const [mail] = await staffMail(client, ward.id, 'digest')
    assert.match(mail.subject, /0 of 4 booked/)
    assert.match(mail.body, /Nobody has signed up/)
  })

  await t.test('a day further out is not reported on yet', async () => {
    const { ward, admin } = await dayIn('dig-far', 72, [[0, 'Snow']])
    await subscribe(client, ward.id, admin, 'digest')
    assert.equal(await run(), 0)
  })

  await t.test('a day already gone is never reported on', async () => {
    const { ward, day, admin } = await seedWard(client, { slug: 'dig-past' })
    await client.query('delete from public.slots where day_id = $1', [day.id])
    await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() - interval '3 hours')`,
      [day.id]
    )
    await subscribe(client, ward.id, admin, 'digest')
    assert.equal(await run(), 0)
  })

  await t.test('an unpublished day is not reported on', async () => {
    const { ward, day, admin } = await seedWard(client, { slug: 'dig-draft', published: false })
    await client.query('delete from public.slots where day_id = $1', [day.id])
    await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() + interval '20 hours')`,
      [day.id]
    )
    await subscribe(client, ward.id, admin, 'digest')
    assert.equal(await run(), 0)
  })

  await t.test('running it again reports nothing twice', async () => {
    const { ward, admin } = await dayIn('dig-once', 20, [[0, 'Woodruff']])
    await subscribe(client, ward.id, admin, 'digest')

    assert.equal(await run(), 1)
    assert.equal(await run(), 0, 'the report went out twice')
  })

  await t.test('rewording the subject cannot cause a second copy', async () => {
    // What the previous de-duplication got wrong: it matched a date inside the
    // subject line, so any change to the wording would have re-sent everything.
    const { ward, admin } = await dayIn('dig-reworded', 20, [[0, 'Lund']])
    await subscribe(client, ward.id, admin, 'digest')
    assert.equal(await run(), 1)

    await client.query(
      `update public.notifications set subject = 'Something else entirely'
        where ward_id = $1 and kind = 'digest'`,
      [ward.id]
    )
    assert.equal(await run(), 0)
  })

  await t.test('everybody subscribed gets a copy', async () => {
    const { ward, admin, viewer } = await dayIn('dig-many', 20, [[1, 'Ivins']])
    await subscribe(client, ward.id, admin, 'digest')
    await subscribe(client, ward.id, viewer, 'digest')

    assert.equal(await run(), 2)
    assert.deepEqual(
      (await staffMail(client, ward.id, 'digest')).map((m) => m.to_address),
      ['admin-dig-many@example.test', 'viewer-dig-many@example.test']
    )
  })

  await t.test('booking and digest are separate subscriptions', async () => {
    const { ward, admin, slots } = await dayIn('dig-separate', 20, [])
    await subscribe(client, ward.id, admin, 'digest')

    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name)
       values ($1, $2, 'Clark')`,
      [slots[0].id, ward.id]
    )
    // Subscribed to the report, not to per-booking alerts.
    assert.deepEqual(await staffMail(client, ward.id, 'booking'), [])
    assert.equal(await run(), 1)
  })
})
