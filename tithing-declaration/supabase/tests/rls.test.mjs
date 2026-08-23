/**
 * Who can see and change what, once they're signed in.
 *
 * These build their rows through the roles under test rather than through the
 * superuser fixture, because a policy that is never exercised by the role it
 * governs is a policy nobody has checked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asUser, asAnon, refused, errorFrom, createUser } from './harness.mjs'
import { seedWard } from './fixture.mjs'

test('row-level security', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('a ward admin sees their ward and only their ward', async () => {
    const a = await seedWard(client, { slug: 'rls-a', name: 'Alpha Ward' })
    await seedWard(client, { slug: 'rls-b', name: 'Beta Ward' })

    const { rows } = await asUser(client, a.admin, () =>
      client.query('select name from public.wards order by name')
    )
    assert.deepEqual(rows, [{ name: 'Alpha Ward' }])
  })

  await t.test('a super admin sees every ward', async () => {
    const a = await seedWard(client, { slug: 'rls-super-a', name: 'Gamma Ward' })
    await seedWard(client, { slug: 'rls-super-b', name: 'Delta Ward' })

    const { rows } = await asUser(client, a.root, () =>
      client.query(`select count(*)::int as n from public.wards`)
    )
    assert.ok(rows[0].n >= 2)
  })

  await t.test('a viewer reads the schedule but changes nothing', async () => {
    const { day, viewer, slots } = await seedWard(client, { slug: 'rls-viewer' })

    const { rows } = await asUser(client, viewer, () =>
      client.query('select count(*)::int as n from public.slots')
    )
    assert.equal(rows[0].n, 8)

    await asUser(client, viewer, async () => {
      assert.ok(await refused(() =>
        client.query(`update public.slots set blocked_at = now() where id = $1`, [slots[0].id])
      ), 'viewer blocked a slot')
      assert.ok(await refused(() =>
        client.query('delete from public.schedule_days where id = $1', [day.id])
      ), 'viewer deleted a day')
      assert.ok(await refused(() =>
        client.query(
          `insert into public.appointments (slot_id, ward_id, family_name, phone)
           values ($1, $2, 'Nobody', '8015550401')`,
          [slots[0].id, day.ward_id]
        )
      ), 'viewer created an appointment')
    })
  })

  await t.test('an admin adds somebody by hand; a viewer can read it', async () => {
    const { ward, admin, viewer, slots } = await seedWard(client, { slug: 'rls-manual' })

    await asUser(client, admin, () =>
      client.query(
        `insert into public.appointments (slot_id, ward_id, family_name, phone, booked_by_admin)
         values ($1, $2, 'Whitney', '801-555-0411', true)`,
        [slots[0].id, ward.id]
      )
    )

    const { rows } = await asUser(client, viewer, () =>
      client.query('select family_name, phone from public.appointments')
    )
    assert.deepEqual(rows, [{ family_name: 'Whitney', phone: '801-555-0411' }])
  })

  await t.test("an admin of one ward cannot reach another ward's bookings", async () => {
    const a = await seedWard(client, { slug: 'rls-iso-a' })
    const b = await seedWard(client, { slug: 'rls-iso-b' })

    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone)
       values ($1, $2, 'Secret', '8015550421')`,
      [b.slots[0].id, b.ward.id]
    )

    const { rows } = await asUser(client, a.admin, () =>
      client.query('select family_name from public.appointments')
    )
    assert.deepEqual(rows, [], 'Alpha admin saw a Beta booking')
  })

  await t.test('ward_id is set from the slot, not from what the caller sent', async () => {
    const a = await seedWard(client, { slug: 'rls-wardid-a' })
    const b = await seedWard(client, { slug: 'rls-wardid-b' })

    // Insert a slot from ward B while claiming it belongs to ward A. The
    // trigger rewrites ward_id, so the row lands in B and A's admin loses it.
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone)
       values ($1, $2, 'Misfiled', '8015550431')`,
      [b.slots[0].id, a.ward.id]
    )

    const { rows } = await client.query(
      `select ward_id from public.appointments where family_name = 'Misfiled'`
    )
    assert.equal(rows[0].ward_id, b.ward.id)
  })

  await t.test('a member sees their own booking without any ward role', async () => {
    const { slots, outsider, ward } = await seedWard(client, { slug: 'rls-own' })

    await asUser(client, outsider, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'rls-own', slots[0].id, 'Cannon', '8015550441', 'cannon@example.test',
      ])
    )

    const { rows } = await asUser(client, outsider, () =>
      client.query('select family_name from public.appointments')
    )
    assert.deepEqual(rows, [{ family_name: 'Cannon' }])

    // But nothing else about the ward opens up to them.
    const wards = await asUser(client, outsider, () =>
      client.query('select * from public.wards where id = $1', [ward.id])
    )
    assert.equal(wards.rowCount, 0)
  })

  await t.test('a member can cancel their booking but not rewrite it', async () => {
    const { slots, outsider } = await seedWard(client, { slug: 'rls-scope' })
    const { rows: [made] } = await asUser(client, outsider, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'rls-scope', slots[0].id, 'Clawson', '8015550451', 'clawson@example.test',
      ])
    )

    await asUser(client, outsider, async () => {
      assert.match(
        await errorFrom(() =>
          client.query(`update public.appointments set family_name = 'Someone Else' where id = $1`, [
            made.appointment_id,
          ])
        ),
        /only the executive secretary can change its details/i
      )

      const { rowCount } = await client.query(
        'update public.appointments set cancelled_at = now() where id = $1',
        [made.appointment_id]
      )
      assert.equal(rowCount, 1, 'the member could not cancel their own booking')
    })
  })

  await t.test('nobody can grant themselves access to a ward', async () => {
    const { ward, outsider } = await seedWard(client, { slug: 'rls-selfgrant' })

    assert.ok(
      await asUser(client, outsider, () =>
        refused(() =>
          client.query(
            `insert into public.ward_roles (ward_id, user_id, role, granted_by)
             values ($1, $2, 'admin', $2)`,
            [ward.id, outsider]
          )
        )
      )
    )
  })

  await t.test('a super admin cannot drop their own super-admin bit', async () => {
    const { root } = await seedWard(client, { slug: 'rls-lastadmin' })

    const { rowCount } = await asUser(client, root, () =>
      client.query('update public.profiles set is_super_admin = false where id = $1', [root])
    )
    assert.equal(rowCount, 0)

    // But they can demote somebody else.
    const other = await createUser(client, 'other-admin@example.test', { superAdmin: true })
    const demoted = await asUser(client, root, () =>
      client.query('update public.profiles set is_super_admin = false where id = $1', [other])
    )
    assert.equal(demoted.rowCount, 1)
  })

  await t.test('a super admin cannot rewrite somebody else\'s email', async () => {
    const { root, outsider } = await seedWard(client, { slug: 'rls-emailcol' })
    const message = await asUser(client, root, () =>
      errorFrom(() =>
        client.query(`update public.profiles set email = 'hijack@example.test' where id = $1`, [
          outsider,
        ])
      )
    )
    assert.match(message, /permission denied/i)
  })

  await t.test('a ward admin sees the profiles of people in their ward, not everyone', async () => {
    const a = await seedWard(client, { slug: 'rls-profiles-a' })
    await seedWard(client, { slug: 'rls-profiles-b' })

    const { rows } = await asUser(client, a.admin, () =>
      client.query('select email from public.profiles order by email')
    )
    const emails = rows.map((r) => r.email)
    assert.ok(emails.includes('admin-rls-profiles-a@example.test'))
    assert.ok(emails.includes('viewer-rls-profiles-a@example.test'))
    assert.equal(emails.some((e) => e.includes('rls-profiles-b')), false)
  })

  await t.test('notifications are readable in-ward and writable by admins only', async () => {
    const { ward, day, admin, viewer, slots } = await seedWard(client, { slug: 'rls-notif' })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone, email)
       values ($1, $2, 'Wells', '8015550461', 'wells@example.test')`,
      [slots[0].id, ward.id]
    )

    // Through queue_day_reminders(), which is what the app actually calls —
    // queue_notification() itself is internal and not granted to anybody.
    await asUser(client, admin, () =>
      client.query('select public.queue_day_reminders($1)', [day.id])
    )

    const seen = await asUser(client, viewer, () =>
      client.query('select count(*)::int as n from public.notifications')
    )
    assert.equal(seen.rows[0].n, 1)

    // Not even an admin may move a row out of `queued` — only the Edge
    // Function's service role does that.
    assert.ok(await asUser(client, admin, () =>
      refused(() => client.query(`update public.notifications set status = 'sent'`))
    ))
  })

  await t.test('anon reaches nothing at all, signed in or not', async () => {
    await seedWard(client, { slug: 'rls-anon' })
    await asAnon(client, async () => {
      for (const table of ['wards', 'appointments', 'notifications', 'lookup_attempts']) {
        assert.match(
          await errorFrom(() => client.query(`select * from public.${table}`)),
          /permission denied/i
        )
      }
    })
  })
})

test('one ward admin, one ward', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  /**
   * The exact arrangement a ward gets: an executive secretary with `admin` on
   * their own ward and nothing anywhere else. Everything below asks whether
   * that grant leaks sideways into a ward they were never given.
   */
  const mine = await seedWard(client, { slug: 'iso-mine', name: 'Mine Ward' })
  const theirs = await seedWard(client, { slug: 'iso-theirs', name: 'Their Ward' })
  const secretary = mine.admin

  await client.query(
    `insert into public.appointments (slot_id, ward_id, family_name, phone, email)
     values ($1, $2, 'Neighbour', '8015551001', 'neighbour@example.test')`,
    [theirs.slots[0].id, theirs.ward.id]
  )

  await t.test('sees only their own ward', async () => {
    const { rows } = await asUser(client, secretary, () =>
      client.query('select name from public.wards order by name')
    )
    assert.deepEqual(rows, [{ name: 'Mine Ward' }])
  })

  await t.test('sees only their own days and slots', async () => {
    const days = await asUser(client, secretary, () =>
      client.query('select ward_id from public.schedule_days')
    )
    assert.deepEqual([...new Set(days.rows.map((r) => r.ward_id))], [mine.ward.id])

    const slots = await asUser(client, secretary, () =>
      client.query('select count(*)::int as n from public.slots')
    )
    assert.equal(slots.rows[0].n, mine.slots.length)
  })

  await t.test("cannot see the other ward's families", async () => {
    const { rows } = await asUser(client, secretary, () =>
      client.query('select family_name from public.appointments')
    )
    assert.deepEqual(rows, [], "a neighbouring ward's booking was visible")
  })

  await t.test("cannot add a day to the other ward", async () => {
    assert.ok(
      await asUser(client, secretary, () =>
        refused(() =>
          client.query(
            `insert into public.schedule_days (ward_id, service_date, created_by)
             values ($1, current_date + 30, $2)`,
            [theirs.ward.id, secretary]
          )
        )
      )
    )
  })

  await t.test("cannot generate slots on the other ward's day", async () => {
    const message = await asUser(client, secretary, () =>
      errorFrom(() =>
        client.query(`select public.generate_slots($1, '09:00'::time, '10:00'::time)`, [
          theirs.day.id,
        ])
      )
    )
    assert.match(message, /ward admin/i)
  })

  await t.test("cannot block or delete the other ward's slots", async () => {
    await asUser(client, secretary, async () => {
      assert.ok(await refused(() =>
        client.query('update public.slots set blocked_at = now() where id = $1', [
          theirs.slots[1].id,
        ])
      ))
      assert.ok(await refused(() =>
        client.query('delete from public.slots where id = $1', [theirs.slots[1].id])
      ))
    })
  })

  await t.test("cannot book into or cancel in the other ward", async () => {
    await asUser(client, secretary, async () => {
      assert.ok(await refused(() =>
        client.query(
          `insert into public.appointments (slot_id, ward_id, family_name, phone)
           values ($1, $2, 'Sneaky', '8015551002')`,
          [theirs.slots[2].id, theirs.ward.id]
        )
      ))
      assert.ok(await refused(() =>
        client.query(`update public.appointments set cancelled_at = now() where ward_id = $1`, [
          theirs.ward.id,
        ])
      ))
    })
  })

  await t.test("cannot send messages for the other ward", async () => {
    const { rows: [appt] } = await client.query(
      'select id from public.appointments where ward_id = $1',
      [theirs.ward.id]
    )
    const message = await asUser(client, secretary, () =>
      errorFrom(() =>
        client.query('select public.queue_notification_for_admin($1, $2)', [appt.id, 'reminder'])
      )
    )
    assert.match(message, /ward admin/i)

    assert.ok(await asUser(client, secretary, () =>
      refused(() => client.query('select public.queue_day_reminders($1)', [theirs.day.id]))
    ))
  })

  await t.test("cannot read the other ward's messages", async () => {
    await client.query(
      `select public.queue_notification(
         (select id from public.appointments where ward_id = $1), 'confirmation')`,
      [theirs.ward.id]
    )
    const { rows } = await asUser(client, secretary, () =>
      client.query('select to_address from public.notifications')
    )
    assert.deepEqual(rows, [])
  })

  await t.test('cannot grant themselves anything, anywhere', async () => {
    await asUser(client, secretary, async () => {
      // Not into the other ward…
      assert.ok(await refused(() =>
        client.query(
          `insert into public.ward_roles (ward_id, user_id, role, granted_by)
           values ($1, $2, 'admin', $2)`,
          [theirs.ward.id, secretary]
        )
      ))
      // …and not to system admin, which would reach every ward at once.
      const { rowCount } = await client.query(
        'update public.profiles set is_super_admin = true where id = $1',
        [secretary]
      )
      assert.equal(rowCount, 0)
    })
  })

  await t.test('can do all of it in their own ward', async () => {
    // The other half of the guarantee: the grant has to actually work.
    await asUser(client, secretary, async () => {
      const { rowCount } = await client.query(
        'update public.slots set blocked_at = now() where id = $1',
        [mine.slots[3].id]
      )
      assert.equal(rowCount, 1)

      const added = await client.query(
        `select public.generate_slots($1, '09:00'::time, '10:00'::time) as n`,
        [mine.day.id]
      )
      assert.equal(added.rows[0].n, 3)
    })
  })
})
