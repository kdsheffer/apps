/**
 * What gets queued, for whom, and how often.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asUser, asAnon, errorFrom } from './harness.mjs'
import { seedWard } from './fixture.mjs'

const queued = (client, wardId) =>
  client
    .query(
      `select kind, to_address, subject, body, status
         from public.notifications where ward_id = $1 order by created_at`,
      [wardId]
    )
    .then(({ rows }) => rows)

test('notifications', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('booking with an email queues a confirmation', async () => {
    const { ward, slots } = await seedWard(client, { slug: 'notif-email' })
    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'notif-email', slots[0].id, 'Richards', '8015550501', 'richards@example.test',
      ])
    )

    const rows = await queued(client, ward.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'confirmation')
    assert.equal(rows[0].to_address, 'richards@example.test')
    assert.equal(rows[0].status, 'queued')
    assert.match(rows[0].subject, /Tithing declaration confirmed/)
    assert.match(rows[0].body, /Richards family,/)
    assert.match(rows[0].body, /\/cancel\/[0-9a-f-]{36}/)
    assert.match(rows[0].body, /Bishop's office/)
    // Real newlines, not the characters backslash and n.
    assert.ok(rows[0].body.includes('\n\n'))
    assert.equal(rows[0].body.includes('\\n'), false)
  })

  await t.test('the public form insists on an email address', async () => {
    const { slots } = await seedWard(client, { slug: 'notif-needsemail' })
    const message = await asAnon(client, () =>
      errorFrom(() =>
        client.query('select * from public.book_slot($1, $2, $3, $4)', [
          'notif-needsemail', slots[0].id, 'Woodruff', '8015550511',
        ])
      )
    )
    assert.match(message, /enter an email address/i)
  })

  await t.test('a family the secretary added with no email is simply not written to', async () => {
    // Name only is a legitimate booking — somebody rang up. It just has no
    // channel, and that must never be an error.
    const { ward, slots } = await seedWard(client, { slug: 'notif-nameonly' })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, booked_by_admin)
       values ($1, $2, 'Woodruff', true)`,
      [slots[0].id, ward.id]
    )
    const { rows } = await client.query(
      `select public.queue_notification(
         (select id from public.appointments where family_name = 'Woodruff'), 'confirmation') as n`
    )
    assert.equal(rows[0].n, 0)
    assert.deepEqual(await queued(client, ward.id), [])
  })

  await t.test('a family with a phone number but no email gets nothing', async () => {
    // Email is the only channel now. A number on the row is for the secretary
    // to ring, not for the app to write to.
    const { ward, slots } = await seedWard(client, { slug: 'notif-phoneonly' })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, booked_by_admin)
       values ($1, $2, 'Taylor', '8015550531', true)`,
      [slots[0].id, ward.id]
    )
    const { rows } = await client.query(
      `select public.queue_notification(
         (select id from public.appointments where family_name = 'Taylor'), 'confirmation') as n`
    )
    assert.equal(rows[0].n, 0)
    assert.deepEqual(await queued(client, ward.id), [])
  })

  await t.test('cancelling queues a cancellation', async () => {
    const { ward, slots } = await seedWard(client, { slug: 'notif-cancel' })
    const { rows: [made] } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'notif-cancel', slots[0].id, 'Snow', '8015550541', 'snow@example.test',
      ])
    )
    await asAnon(client, () =>
      client.query('select public.cancel_appointment($1)', [made.cancel_token])
    )

    const rows = await queued(client, ward.id)
    assert.deepEqual(rows.map((r) => r.kind), ['confirmation', 'cancellation'])
    assert.match(rows[1].body, /has been cancelled/)
    assert.match(rows[1].subject, /cancelled/i)
  })

  await t.test('a cancellation by the clerk notifies the family', async () => {
    // The clerk's Cancel button goes through the same RPC as the link in the
    // member's email, deliberately — so a family finds out their appointment is
    // gone however it went, rather than only when they turn up.
    const { ward, admin, slots } = await seedWard(client, { slug: 'notif-clerkcancel' })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, email, booked_by_admin)
       values ($1, $2, 'Hinckley', '8015550901', 'hinckley@example.test', true)`,
      [slots[0].id, ward.id]
    )
    const { rows: [appt] } = await client.query(
      'select id, cancel_token from public.appointments where ward_id = $1',
      [ward.id]
    )

    await asUser(client, admin, () =>
      client.query('select public.cancel_appointment($1, $2)', [
        appt.cancel_token,
        'Bishopric meeting ran over',
      ])
    )

    const rows = await queued(client, ward.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'cancellation')
    assert.equal(rows[0].to_address, 'hinckley@example.test')
    assert.match(rows[0].body, /has been cancelled/)

    // And it records who did it, which the family's own cancellation does not.
    const { rows: [after] } = await client.query(
      'select cancelled_by, cancelled_reason from public.appointments where id = $1',
      [appt.id]
    )
    assert.equal(after.cancelled_by, admin)
    assert.equal(after.cancelled_reason, 'Bishopric meeting ran over')
  })

  await t.test('cancelling a family with no email address is silent, not an error', async () => {
    // The name-only booking the clerk typed in. There is nowhere to write to,
    // and that must not stop the cancellation going through.
    const { ward, admin, slots } = await seedWard(client, { slug: 'notif-cancelnoemail' })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, booked_by_admin)
       values ($1, $2, 'Monson', true)`,
      [slots[0].id, ward.id]
    )
    const { rows: [appt] } = await client.query(
      'select cancel_token from public.appointments where ward_id = $1',
      [ward.id]
    )

    await asUser(client, admin, () =>
      client.query('select public.cancel_appointment($1)', [appt.cancel_token])
    )

    assert.deepEqual(await queued(client, ward.id), [])
    const { rows } = await client.query(
      'select cancelled_at from public.appointments where ward_id = $1',
      [ward.id]
    )
    assert.notEqual(rows[0].cancelled_at, null, 'the cancellation itself must still happen')
  })

  await t.test('queueing reminders twice does not send twice', async () => {
    const { ward, day, admin, slots } = await seedWard(client, { slug: 'notif-remind' })

    for (const [i, name] of [[0, 'Grant'], [1, 'Ivins'], [2, 'Clark']]) {
      await asAnon(client, () =>
        client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
          'notif-remind', slots[i].id, name, `801555055${i}`, `${name.toLowerCase()}@example.test`,
        ])
      )
    }

    const first = await asUser(client, admin, () =>
      client.query('select public.queue_day_reminders($1) as n', [day.id])
    )
    assert.equal(first.rows[0].n, 3)

    const second = await asUser(client, admin, () =>
      client.query('select public.queue_day_reminders($1) as n', [day.id])
    )
    assert.equal(second.rows[0].n, 0, 'a second press re-texted everybody')

    const reminders = (await queued(client, ward.id)).filter((r) => r.kind === 'reminder')
    assert.equal(reminders.length, 3)
  })

  await t.test('reminders skip cancelled appointments', async () => {
    const { day, admin, slots } = await seedWard(client, { slug: 'notif-skipcancelled' })
    const { rows: [made] } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'notif-skipcancelled', slots[0].id, 'Lund', '8015550561', 'lund@example.test',
      ])
    )
    await asAnon(client, () => client.query('select public.cancel_appointment($1)', [made.cancel_token]))

    const { rows } = await asUser(client, admin, () =>
      client.query('select public.queue_day_reminders($1) as n', [day.id])
    )
    assert.equal(rows[0].n, 0)
  })

  await t.test('only a ward admin can send reminders', async () => {
    const { day, viewer, outsider } = await seedWard(client, { slug: 'notif-perms' })
    for (const who of [viewer, outsider]) {
      const message = await asUser(client, who, () =>
        errorFrom(() => client.query('select public.queue_day_reminders($1)', [day.id]))
      )
      assert.match(message, /ward admin/i)
    }
  })

  await t.test('the message carries the ward timezone, not the reader\'s', async () => {
    const { ward, slots } = await seedWard(client, { slug: 'notif-tz' })
    await client.query(`update public.wards set timezone = 'Pacific/Honolulu' where id = $1`, [ward.id])

    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'notif-tz', slots[0].id, 'Cowdery', '8015550571', 'cowdery@example.test',
      ])
    )

    const [row] = await queued(client, ward.id)
    const { rows: [expected] } = await client.query(
      `select public.format_slot_local($1, 'Pacific/Honolulu') as t`,
      [slots[0].starts_at]
    )
    assert.ok(row.body.includes(expected.t), `body should say "${expected.t}"`)
  })

  await t.test('the ward\'s own instructions ride along in the email', async () => {
    const { ward, slots } = await seedWard(client, { slug: 'notif-instructions' })
    await client.query(
      `update public.wards set instructions = 'Enter by the north doors.' where id = $1`,
      [ward.id]
    )
    await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'notif-instructions', slots[0].id, 'Phelps', '8015550581', 'phelps@example.test',
      ])
    )

    const [row] = await queued(client, ward.id)
    assert.match(row.body, /Enter by the north doors\./)
  })
})

test('reminders that send themselves', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  /**
   * A booking whose slot starts `hours` from now. Reaches past generate_slots
   * so a test can put an appointment exactly on the edge of the lead window.
   */
  const bookingIn = async (slug, hours, family, email = 'family@example.test') => {
    const { ward, day } = await seedWard(client, { slug })
    const { rows: [slot] } = await client.query(
      `insert into public.slots (day_id, starts_at)
       values ($1, now() + make_interval(mins => $2)) returning *`,
      [day.id, Math.round(hours * 60)]
    )
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, email)
       values ($1, $2, $3, '8015550801', $4)`,
      [slot.id, ward.id, family, email]
    )
    return { ward, day, slot }
  }

  const due = async () =>
    (await client.query('select public.queue_due_reminders() as n')).rows[0].n

  await t.test('an appointment inside the lead time gets one', async () => {
    await bookingIn('due-inside', 20, 'Pratt')
    assert.equal(await due(), 1)
  })

  await t.test('an appointment beyond the lead time is left alone', async () => {
    // The ward's default lead is 24 hours; this one is three days out.
    await bookingIn('due-outside', 72, 'Kimball')
    assert.equal(await due(), 0)
  })

  await t.test('running it again sends nothing more', async () => {
    await bookingIn('due-twice', 20, 'Snow')
    assert.equal(await due(), 1)
    assert.equal(await due(), 0, 'a second run re-reminded everybody')
  })

  await t.test('a job that has been down does not mail about the past', async () => {
    // The failure worth guarding: the scheduler stops for a day, comes back,
    // and texts everybody about appointments that already happened.
    const { ward, day } = await seedWard(client, { slug: 'due-past' })
    const { rows: [slot] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() - interval '2 hours')
       returning *`,
      [day.id]
    )
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, email)
       values ($1, $2, 'Woodruff', '8015550811', 'woodruff@example.test')`,
      [slot.id, ward.id]
    )
    assert.equal(await due(), 0)
  })

  await t.test('an unpublished day is never reminded about', async () => {
    const { ward, day } = await seedWard(client, { slug: 'due-draft', published: false })
    const { rows: [slot] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() + interval '3 hours')
       returning *`,
      [day.id]
    )
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, email)
       values ($1, $2, 'Taylor', '8015550821', 'taylor@example.test')`,
      [slot.id, ward.id]
    )
    assert.equal(await due(), 0)
  })

  await t.test('a cancelled appointment is not reminded about', async () => {
    const { ward } = await bookingIn('due-cancelled', 20, 'Grant')
    await client.query('update public.appointments set cancelled_at = now() where ward_id = $1', [
      ward.id,
    ])
    assert.equal(await due(), 0)
  })

  await t.test('a longer lead time reaches further out', async () => {
    const { ward } = await bookingIn('due-lead', 40, 'Benson')
    assert.equal(await due(), 0, '40 hours out is beyond the default 24')

    await client.query('update public.wards set reminder_lead_hours = 48 where id = $1', [ward.id])
    assert.equal(await due(), 1)
  })

  await t.test('the reminder carries a working cancel link', async () => {
    const { ward } = await bookingIn('due-link', 20, 'Rasband')
    await client.query(
      `update public.app_settings set site_url = 'https://tithing.example.org/' where id`
    )
    await due()

    const { rows } = await client.query(
      `select n.body, a.cancel_token
         from public.notifications n
         join public.appointments a on a.id = n.appointment_id
        where n.ward_id = $1 and n.kind = 'reminder'`,
      [ward.id]
    )
    // The trailing slash on the setting must not become a double slash.
    assert.ok(
      rows[0].body.includes(`https://tithing.example.org/cancel/${rows[0].cancel_token}`),
      rows[0].body
    )
    assert.equal(rows[0].body.includes('//cancel/'), false)
  })

  await t.test('the link cancels, and reads back before it is used', async () => {
    const { ward } = await bookingIn('due-cancel-flow', 20, 'Eyring')
    const { rows: [appt] } = await client.query(
      'select cancel_token from public.appointments where ward_id = $1',
      [ward.id]
    )

    const before = await asAnon(client, () =>
      client.query('select * from public.appointment_by_token($1)', [appt.cancel_token])
    )
    assert.equal(before.rows[0].family_name, 'Eyring')
    assert.equal(before.rows[0].cancelled, false)
    assert.equal(before.rows[0].in_past, false)

    await asAnon(client, () =>
      client.query('select public.cancel_appointment($1)', [appt.cancel_token])
    )

    const after = await asAnon(client, () =>
      client.query('select * from public.appointment_by_token($1)', [appt.cancel_token])
    )
    assert.equal(after.rows[0].cancelled, true)
  })

  await t.test('a token nobody issued reads back as nothing', async () => {
    const { rows } = await asAnon(client, () =>
      client.query('select * from public.appointment_by_token($1)', [
        '00000000-0000-4000-8000-000000000000',
      ])
    )
    assert.deepEqual(rows, [])
  })

  await t.test('there is no longer any way to ask whether a number is booked', async () => {
    const { rows } = await client.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('find_appointments', 'name_key')`
    )
    assert.equal(rows.length, 0, 'the lookup oracle is still reachable')
  })
})
