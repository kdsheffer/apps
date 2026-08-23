/**
 * Send once — and the claim that makes it true.
 *
 * The dispatcher used to select every queued row, send them, then mark them
 * sent. Anything running in the window between the select and the update saw
 * the same rows as still queued, and the family got the message twice. That
 * window was reachable in normal use: the clerk's cancel button nudges the
 * dispatcher directly while the cron job fires every fifteen minutes.
 *
 * These tests drive `claim_notifications` the way the Edge Function does,
 * including two callers claiming at the same instant on separate connections —
 * which is the only way to show `for update skip locked` doing its job.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, asAnon } from './harness.mjs'
import { seedWard } from './fixture.mjs'

const claim = (client, { wardId = null, appointmentId = null, limit = 50 } = {}) =>
  client
    .query('select * from public.claim_notifications($1, $2, $3)', [wardId, appointmentId, limit])
    .then(({ rows }) => rows)

test('dispatching', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  const bookOne = async (slug, family, email = 'family@example.test') => {
    const { ward, slots } = await seedWard(client, { slug })
    const { rows: [made] } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        slug, slots[0].id, family, '8015550951', email,
      ])
    )
    return { ward, made }
  }

  await t.test('a claimed message is no longer claimable', async () => {
    const { ward } = await bookOne('claim-once', 'Pratt')

    const first = await claim(client, { wardId: ward.id })
    assert.equal(first.length, 1, 'the confirmation should be there to claim')

    const second = await claim(client, { wardId: ward.id })
    assert.deepEqual(second, [], 'the same message was handed out twice')
  })

  await t.test('claiming marks the row in flight and counts the attempt', async () => {
    const { ward } = await bookOne('claim-marks', 'Kimball')
    const [claimed] = await claim(client, { wardId: ward.id })

    const { rows } = await client.query(
      'select status, attempts, claimed_at from public.notifications where id = $1',
      [claimed.id]
    )
    assert.equal(rows[0].status, 'sending')
    // Counted at claim time, not after the send: a run that dies mid-flight
    // must not leave a message that retries forever.
    assert.equal(rows[0].attempts, 1)
    assert.notEqual(rows[0].claimed_at, null)
  })

  await t.test('two dispatchers claiming at once take disjoint batches', async () => {
    // The real race. Both transactions open, both claim, neither commits until
    // the other has run — which is exactly the overlap `skip locked` handles.
    const { ward } = await seedWard(client, { slug: 'claim-race' })
    for (let i = 0; i < 6; i++) {
      const { rows: [slot] } = await client.query(
        `insert into public.slots (day_id, starts_at)
         values ((select id from public.schedule_days where ward_id = $1),
                 now() + make_interval(days => 2, mins => $2)) returning *`,
        [ward.id, i * 15]
      )
      await client.query(
        `insert into public.appointments (slot_id, ward_id, family_name, email)
         values ($1, $2, $3, $4)`,
        [slot.id, ward.id, `Family${i}`, `family${i}@example.test`]
      )
      await client.query(
        `select public.queue_notification(
           (select id from public.appointments where slot_id = $1), 'confirmation')`,
        [slot.id]
      )
    }

    const other = await db.newClient()

    await client.query('begin')
    await other.query('begin')
    const mine = await claim(client, { wardId: ward.id, limit: 3 })
    const theirs = await claim(other, { wardId: ward.id, limit: 3 })
    await client.query('commit')
    await other.query('commit')

    const overlap = mine.filter((m) => theirs.some((t2) => t2.id === m.id))
    assert.deepEqual(overlap, [], 'both dispatchers claimed the same message')
    assert.equal(mine.length + theirs.length, 6)
  })

  await t.test('a message abandoned in flight is reclaimed, not lost', async () => {
    const { ward } = await bookOne('claim-stuck', 'Snow')
    const [claimed] = await claim(client, { wardId: ward.id })

    // A dispatcher that died holding it. Nothing else can rescue this row —
    // the process is gone and its lock went with its transaction.
    assert.deepEqual(await claim(client, { wardId: ward.id }), [])

    await client.query(
      `update public.notifications set claimed_at = now() - interval '11 minutes' where id = $1`,
      [claimed.id]
    )

    const again = await claim(client, { wardId: ward.id })
    assert.equal(again.length, 1)
    assert.equal(again[0].id, claimed.id)
    assert.equal(again[0].attempts, 2, 'the retry has to count, or it loops forever')
  })

  await t.test('a claim can be scoped to one appointment', async () => {
    // What a member's own booking uses: their token, their message, nobody
    // else's — even though the ward has other mail waiting.
    const a = await bookOne('claim-scope-a', 'Young')
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, email)
       select s.id, $1, 'Other', 'other@example.test'
         from public.slots s
         join public.schedule_days d on d.id = s.day_id
        where d.ward_id = $1 and s.id <> (select slot_id from public.appointments where ward_id = $1)
        limit 1`,
      [a.ward.id]
    )
    await client.query(
      `select public.queue_notification(id, 'confirmation')
         from public.appointments where ward_id = $1 and family_name = 'Other'`,
      [a.ward.id]
    )

    const { rows: [appt] } = await client.query(
      'select id from public.appointments where cancel_token = $1',
      [a.made.cancel_token]
    )
    const claimed = await claim(client, { appointmentId: appt.id })

    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].to_address, 'family@example.test')

    // The other family's message is untouched and still waiting.
    const { rows } = await client.query(
      `select count(*)::int as n from public.notifications
        where ward_id = $1 and status = 'queued'`,
      [a.ward.id]
    )
    assert.equal(rows[0].n, 1)
  })

  await t.test('a reminder in flight is not queued a second time', async () => {
    // The same double-send arriving by another route: a cron tick landing while
    // the previous tick's reminder is still being delivered.
    const { ward, day } = await seedWard(client, { slug: 'claim-reminder' })
    const { rows: [slot] } = await client.query(
      `insert into public.slots (day_id, starts_at) values ($1, now() + interval '20 hours')
       returning *`,
      [day.id]
    )
    await client.query(
      `insert into public.appointments (slot_id, ward_id, family_name, email)
       values ($1, $2, 'Woodruff', 'woodruff@example.test')`,
      [slot.id, ward.id]
    )

    const first = await client.query('select public.queue_due_reminders() as n')
    assert.equal(first.rows[0].n, 1)

    await claim(client, { wardId: ward.id })   // now 'sending', not yet 'sent'

    const second = await client.query('select public.queue_due_reminders() as n')
    assert.equal(second.rows[0].n, 0, 'a reminder mid-flight was queued again')
  })

  await t.test('nobody but the dispatcher can claim', async () => {
    const { ward } = await bookOne('claim-perms', 'Taylor')
    await asAnon(client, async () => {
      let refused = false
      try {
        await client.query('select * from public.claim_notifications($1)', [ward.id])
      } catch {
        refused = true
      }
      assert.equal(refused, true, 'anon could take messages out of the queue')
    })
  })
})
