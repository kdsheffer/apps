/**
 * Building a schedule: the slot pattern, the timezone, and the guards that stop
 * the secretary deleting a booking by clicking the wrong X.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asUser, errorFrom } from './harness.mjs'
import { seedWard, futureDate, localTime, TZ } from './fixture.mjs'

test('the schedule', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('generates three slots an hour and leaves :45 as buffer', async () => {
    const { slots } = await seedWard(client, { slug: 'buffer', start: '18:00', end: '20:30' })

    const times = []
    for (const slot of slots) times.push(await localTime(client, slot.starts_at))

    assert.deepEqual(times, [
      '18:00', '18:15', '18:30',
      '19:00', '19:15', '19:30',
      '20:00', '20:15',
    ])

    // The buffer is an absence, not an unbookable row.
    assert.equal(times.filter((t) => t.endsWith(':45')).length, 0)
  })

  await t.test('the end time is when the evening finishes, not when the last slot starts', async () => {
    const { slots } = await seedWard(client, { slug: 'endtime', start: '09:00', end: '10:00' })
    const times = []
    for (const slot of slots) times.push(await localTime(client, slot.starts_at))

    // 9:30 runs to 9:45 and fits; there is no 9:45 anyway, and 10:00 is past the end.
    assert.deepEqual(times, ['09:00', '09:15', '09:30'])
  })

  await t.test('re-running extends a day without disturbing what is there', async () => {
    const { day, admin, slots } = await seedWard(client, {
      slug: 'rerun', start: '18:00', end: '19:00',
    })
    assert.equal(slots.length, 3)
    const firstId = slots[0].id

    const added = await asUser(client, admin, async () => {
      const { rows } = await client.query(
        `select public.generate_slots($1, '18:00'::time, '20:00'::time) as n`,
        [day.id]
      )
      return rows[0].n
    })

    // Three new slots in the added hour; the original three untouched.
    assert.equal(added, 3)
    const { rows } = await client.query(
      'select id from public.slots where day_id = $1 order by starts_at',
      [day.id]
    )
    assert.equal(rows.length, 6)
    assert.equal(rows[0].id, firstId, 'the existing 18:00 slot was reused, not replaced')
  })

  await t.test('a day can hold two separate blocks of times', async () => {
    // The real case: a ward taking declarations before church and again after,
    // on the same Sunday. Two disjoint windows on one day, not one long one.
    const { day, admin } = await seedWard(client, {
      slug: 'twoblocks', start: '08:00', end: '09:00',
    })

    const added = await asUser(client, admin, async () => {
      const { rows } = await client.query(
        `select public.generate_slots($1, '13:00'::time, '14:30'::time) as n`,
        [day.id]
      )
      return rows[0].n
    })
    // Five, not six: :45 is buffer, and 14:30 is the finish so nothing starts there.
    assert.equal(added, 5)

    const { rows } = await client.query(
      'select starts_at from public.slots where day_id = $1 order by starts_at',
      [day.id]
    )
    const times = []
    for (const row of rows) times.push(await localTime(client, row.starts_at))

    assert.deepEqual(times, [
      '08:00', '08:15', '08:30',
      '13:00', '13:15', '13:30', '14:00', '14:15',
    ])

    // Nothing is generated in the gap between the blocks.
    assert.equal(times.some((t) => t.startsWith('09') || t.startsWith('11')), false)
  })

  await t.test('a second block does not disturb a booking in the first', async () => {
    const { ward, day, admin, slots } = await seedWard(client, {
      slug: 'blockssafe', start: '08:00', end: '09:00',
    })
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone)
       values ($1, $2, 'Partridge', '8015550701')`,
      [slots[0].id, ward.id]
    )

    await asUser(client, admin, () =>
      client.query(`select public.generate_slots($1, '13:00'::time, '14:00'::time)`, [day.id])
    )

    const { rows } = await client.query(
      `select a.family_name, a.slot_id from public.appointments a where a.ward_id = $1`,
      [ward.id]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].slot_id, slots[0].id, 'the booking moved or was recreated')
  })

  await t.test('slot times survive a daylight-saving change', async () => {
    // 2 November 2025 is the Sunday US mountain time falls back. An evening
    // either side of it must still start at 6pm on the clock.
    const before = await seedWard(client, { slug: 'dst-before', serviceDate: '2025-10-26',
                                            start: '18:00', end: '18:45' })
    const after  = await seedWard(client, { slug: 'dst-after',  serviceDate: '2025-11-09',
                                            start: '18:00', end: '18:45' })

    assert.equal(await localTime(client, before.slots[0].starts_at), '18:00')
    assert.equal(await localTime(client, after.slots[0].starts_at), '18:00')

    // Same wall clock, different UTC offset — which is the whole point.
    const utc = (ts) => new Date(ts).toISOString().slice(11, 16)
    assert.equal(utc(before.slots[0].starts_at), '00:00') // MDT, UTC-6
    assert.equal(utc(after.slots[0].starts_at), '01:00')  // MST, UTC-7
  })

  await t.test('only a ward admin can generate slots', async () => {
    const { day, viewer, outsider } = await seedWard(client, { slug: 'genperms' })

    for (const who of [viewer, outsider]) {
      const message = await asUser(client, who, () =>
        errorFrom(() =>
          client.query(`select public.generate_slots($1, '09:00'::time, '10:00'::time)`, [day.id])
        )
      )
      assert.match(message, /ward admin/i)
    }
  })

  await t.test('an end time before the start time is refused', async () => {
    const { day, admin } = await seedWard(client, { slug: 'backwards' })
    const message = await asUser(client, admin, () =>
      errorFrom(() =>
        client.query(`select public.generate_slots($1, '20:00'::time, '18:00'::time)`, [day.id])
      )
    )
    assert.match(message, /after the start time/i)
  })

  await t.test('a nonsense timezone is refused when the ward is saved', async () => {
    const message = await errorFrom(() =>
      client.query(`update public.wards set timezone = 'America/Nowhere' where slug = 'buffer'`)
    )
    assert.match(message, /not a known timezone/i)
  })

  await t.test('a booked slot cannot be deleted, blocked, or hidden', async () => {
    const { ward, day, slots } = await seedWard(client, { slug: 'guards' })
    const slot = slots[0]

    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, phone)
       values ($1, $2, 'Whitmer', '801-555-0143')`,
      [slot.id, ward.id]
    )

    assert.match(
      await errorFrom(() => client.query('delete from public.slots where id = $1', [slot.id])),
      /Whitmer family is booked/
    )
    assert.match(
      await errorFrom(() =>
        client.query('update public.slots set blocked_at = now() where id = $1', [slot.id])
      ),
      /Whitmer family is booked/
    )
    assert.match(
      await errorFrom(() =>
        client.query('update public.schedule_days set published_at = null where id = $1', [day.id])
      ),
      /1 booked appointment/
    )

    // Cancel it and all three become possible again.
    await client.query(
      'update public.appointments set cancelled_at = now() where slot_id = $1',
      [slot.id]
    )
    await client.query('update public.schedule_days set published_at = null where id = $1', [day.id])
    await client.query('delete from public.slots where id = $1', [slot.id])
  })

  await t.test('an empty slot is deleted without complaint', async () => {
    const { slots } = await seedWard(client, { slug: 'emptyslot' })
    const { rowCount } = await client.query('delete from public.slots where id = $1', [slots[0].id])
    assert.equal(rowCount, 1)
  })

  await t.test('two days in one ward cannot share a date', async () => {
    const { ward, admin } = await seedWard(client, { slug: 'onedayperdate' })
    const message = await errorFrom(() =>
      client.query(
        `insert into public.schedule_days (ward_id, service_date, created_by)
         values ($1, (select service_date from public.schedule_days where ward_id = $1 limit 1), $2)`,
        [ward.id, admin]
      )
    )
    assert.match(message, /duplicate key|unique/i)
  })

  await t.test('a day with no date collision in another ward is fine', async () => {
    const shared = futureDate(21)
    await seedWard(client, { slug: 'ward-a', serviceDate: shared })
    const b = await seedWard(client, { slug: 'ward-b', serviceDate: shared })
    assert.equal(b.slots.length, 8)
    assert.equal(b.ward.timezone, TZ)
  })
})
