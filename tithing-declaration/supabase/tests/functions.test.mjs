/**
 * Which functions each role may execute.
 *
 * This file exists because the original revokes in migration 004 were no-ops
 * and nothing noticed. Postgres grants EXECUTE on a new function to PUBLIC, and
 * `revoke ... from anon` does not remove a grant held by PUBLIC — so `anon`
 * could call `render_notification()` and read a family's name, appointment time
 * and confirmation code out of the message it rendered.
 *
 * Testing the behaviour of each function would not have caught it; the calls
 * worked exactly as designed. What was wrong was who could make them. So this
 * asserts the *shape of the surface* — the full set of functions a role can
 * execute, compared against a list — which fails as soon as a new function
 * appears without somebody deciding who it is for.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase } from './harness.mjs'

/** Everything reachable without a session. Adding to this list is a decision. */
const ANON_MAY_EXECUTE = [
  // The public API.
  'appointment_by_token',
  'book_slot',
  'cancel_appointment',
  'public_schedule',
  'public_ward',
  'reschedule_appointment',
  // Pure helpers that touch nothing.
  'format_slot_local',
  /* Authorization helpers. These have to stay executable: an RLS policy
     expression runs with the privileges of the role running the query, so
     revoking them would break every policy that uses them. Each one reports on
     the caller, or maps an id to the ward id that owns it. */
  'is_super_admin',
  'is_ward_admin',
  'is_ward_member',
  'has_ward_access',
  'shares_administered_ward',
  'ward_of_day',
  'ward_of_slot',
]

/** Signed-in users get the above plus these; each does its own admin check. */
const AUTHENTICATED_EXTRA = [
  'claim_appointment',
  'delete_schedule_day',
  'generate_slots',
  'queue_day_reminders',
  'queue_notification_for_admin',
]

/** Callable only from inside another SECURITY DEFINER function. */
const NOBODY_ELSE = [
  'appointment_url',
  'check_rate_limit',
  'queue_booking_alerts',
  'queue_day_digests',
  'queue_due_reminders',
  'request_fingerprint',
  'site_url',
  'privileged_write',
  'prune_lookup_attempts',
  'queue_notification',
  'render_notification',
]

/**
 * Every non-trigger function in `public`, with whether `role` may execute it.
 * Trigger functions are excluded — they return `trigger`, cannot be called
 * directly, and PostgREST does not expose them.
 */
async function executableBy(client, role) {
  const { rows } = await client.query(
    `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prorettype <> 'trigger'::regtype::oid
        -- uuid-ossp installs itself into this schema; its functions are the
        -- extension's business, not part of the app's surface.
        and not exists (
          select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
        )
        and has_function_privilege($1, p.oid, 'execute')
      order by p.proname`,
    [role]
  )
  return [...new Set(rows.map((r) => r.proname))]
}

test('function execute grants', async (t) => {
  const db = await startDatabase()
  const { client } = db
  t.after(() => db.stop())

  await t.test('anon can execute exactly the public surface', async () => {
    assert.deepEqual(await executableBy(client, 'anon'), [...ANON_MAY_EXECUTE].sort())
  })

  await t.test('authenticated adds only the signed-in functions', async () => {
    assert.deepEqual(
      await executableBy(client, 'authenticated'),
      [...ANON_MAY_EXECUTE, ...AUTHENTICATED_EXTRA].sort()
    )
  })

  await t.test('the internals are reachable by neither', async () => {
    for (const role of ['anon', 'authenticated']) {
      const allowed = new Set(await executableBy(client, role))
      for (const fn of NOBODY_ELSE) {
        assert.equal(allowed.has(fn), false, `${role} can execute ${fn}()`)
      }
    }
  })

  await t.test('every internal function still exists — the list is not stale', async () => {
    const { rows } = await client.query(
      `select proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and proname = any($1)`,
      [NOBODY_ELSE]
    )
    assert.deepEqual(
      [...new Set(rows.map((r) => r.proname))].sort(),
      [...NOBODY_ELSE].sort(),
      'a function in the internals list has been renamed or removed'
    )
  })

  await t.test('the internals still work when called from inside a definer function', async () => {
    // The revokes must not have broken the callers: `book_slot` calls
    // `check_rate_limit`, `queue_notification`, `prune_lookup_attempts` and
    // `site_url`, none of which any client may call directly.
    const { seedWard } = await import('./fixture.mjs')
    const { asAnon } = await import('./harness.mjs')
    const { slots } = await seedWard(client, { slug: 'grants-smoke' })

    const { rows } = await asAnon(client, () =>
      client.query('select * from public.book_slot($1, $2, $3, $4, $5)', [
        'grants-smoke', slots[0].id, 'Hyde', '8015550601', 'hyde@example.test',
      ])
    )
    assert.match(rows[0].cancel_url, /\/appointment\/[0-9a-f-]{36}$/)

    const queued = await client.query('select count(*)::int as n from public.notifications')
    assert.equal(queued.rows[0].n, 1, 'queue_notification stopped working after the revoke')
  })
})
