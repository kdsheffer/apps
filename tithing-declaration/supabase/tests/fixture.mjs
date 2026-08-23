/**
 * A ward with people in it and an evening on the schedule — the starting point
 * almost every test needs.
 *
 * Setup runs as the superuser, which bypasses RLS. That is deliberate: a test
 * about booking should fail because booking is broken, not because the fixture
 * tripped over a policy. The policies themselves are the subject of
 * `rls.test.mjs`, which builds its own rows through the roles under test.
 */
import { asUser, createUser } from './harness.mjs'

export const TZ = 'America/Denver'

/** A date far enough out that its slots are always still in the future. */
export function futureDate(daysAhead = 7) {
  const d = new Date(Date.now() + daysAhead * 86_400_000)
  return d.toISOString().slice(0, 10)
}

export async function seedWard(client, options = {}) {
  const {
    slug = 'riverbend-3rd',
    name = 'Riverbend 3rd Ward',
    published = true,
    serviceDate = futureDate(),
    start = '18:00',
    end = '20:30',
  } = options

  const root   = await createUser(client, `root-${slug}@example.test`, { superAdmin: true })
  const admin  = await createUser(client, `admin-${slug}@example.test`)
  const viewer = await createUser(client, `viewer-${slug}@example.test`)
  const outsider = await createUser(client, `outsider-${slug}@example.test`)

  const { rows: [ward] } = await client.query(
    `insert into public.wards (name, slug, timezone, created_by)
     values ($1, $2, $3, $4) returning *`,
    [name, slug, TZ, root]
  )

  await client.query(
    `insert into public.ward_roles (ward_id, user_id, role, granted_by)
     values ($1, $2, 'admin', $3), ($1, $4, 'viewer', $3)`,
    [ward.id, admin, root, viewer]
  )

  const { rows: [day] } = await client.query(
    `insert into public.schedule_days (ward_id, service_date, location, published_at, created_by)
     values ($1, $2, 'Bishop''s office', $3, $4) returning *`,
    [ward.id, serviceDate, published ? new Date().toISOString() : null, admin]
  )

  const added = await asUser(client, admin, async () => {
    const { rows } = await client.query('select public.generate_slots($1, $2, $3) as n', [
      day.id,
      start,
      end,
    ])
    return rows[0].n
  })

  const { rows: slots } = await client.query(
    'select * from public.slots where day_id = $1 order by starts_at',
    [day.id]
  )

  return { ward, day, slots, added, root, admin, viewer, outsider }
}

/** The wall-clock time of a slot in the ward's timezone, as "18:15". */
export function localTime(client, startsAt, tz = TZ) {
  return client
    .query(`select to_char($1::timestamptz at time zone $2, 'HH24:MI') as t`, [startsAt, tz])
    .then(({ rows }) => rows[0].t)
}
