/**
 * Migration 009 lands on a database that already has data in it — data the old
 * schema was happy with and the new rules are not. This runs 001–008, creates
 * exactly the states that will break, then applies 009 and checks it repaired
 * them rather than leaving a database its own triggers would reject.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createUser, startDatabase } from './harness.mjs'

let db
let before009

before(async () => {
  db = await startDatabase({ upTo: '008_restore_rls.sql' })

  const owner = await createUser(db.client, 'owner@example.com', { superAdmin: true })
  const helper = await createUser(db.client, 'helper@example.com')

  const ward = (
    await db.client.query(
      `insert into public.wards (name, created_by) values ('Legacy Ward', $1) returning id`,
      [owner]
    )
  ).rows[0].id

  await db.client.query(
    `insert into public.ward_admins (ward_id, user_id, granted_by) values ($1, $2, $3)`,
    [ward, helper, owner]
  )

  const boardOf = async (status, name, working = false) =>
    (
      await db.client.query(
        `insert into public.boards (ward_id, status, name, created_by, is_working_draft)
         values ($1, $2, $3, $4, $5) returning id`,
        [ward, status, name, owner, working]
      )
    ).rows[0].id

  const live = await boardOf('promoted', 'Live')
  const working = await boardOf('draft', 'Working Draft', true)
  const strayA = await boardOf('draft', 'Stray draft A')
  const strayB = await boardOf('draft', 'Stray draft B')

  const group = (
    await db.client.query(
      `insert into public.groups (board_id, name, sort_order) values ($1, 'Primary', 0)
       returning id`,
      [live]
    )
  ).rows[0].id

  // The old schema let a calling be parked while somebody still held it.
  const occupiedButParked = (
    await db.client.query(
      `insert into public.positions (group_id, title, sort_order, inactive_at)
       values ($1, 'Parked but filled', 0, now()) returning id`,
      [group]
    )
  ).rows[0].id

  const trulyVacant = (
    await db.client.query(
      `insert into public.positions (group_id, title, sort_order, inactive_at)
       values ($1, 'Genuinely parked', 1, now()) returning id`,
      [group]
    )
  ).rows[0].id

  // …and a member to be marked inactive while still serving.
  const servingButArchived = (
    await db.client.query(
      `insert into public.members (ward_id, full_name, archived_at)
       values ($1, 'Serving, Archived', now()) returning id`,
      [ward]
    )
  ).rows[0].id

  const genuinelyGone = (
    await db.client.query(
      `insert into public.members (ward_id, full_name, archived_at)
       values ($1, 'Genuinely, Gone', now()) returning id`,
      [ward]
    )
  ).rows[0].id

  await db.client.query(
    `insert into public.position_assignments (position_id, member_id, called_date)
     values ($1, $2, current_date)`,
    [occupiedButParked, servingButArchived]
  )

  before009 = {
    ward,
    owner,
    helper,
    live,
    working,
    strays: [strayA, strayB],
    occupiedButParked,
    trulyVacant,
    servingButArchived,
    genuinelyGone,
  }

  await db.applyRemaining()
}, { timeout: 120_000 })

after(async () => {
  await db?.stop()
})

describe('upgrading a database that already has data', () => {
  test('existing ward admins keep their access, now spelled as a role', async () => {
    const { rows } = await db.client.query(
      'select role from public.ward_roles where user_id = $1',
      [before009.helper]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'admin')
  })

  test('existing callings are labelled as LCR’s, so an import can manage them', async () => {
    const { rows } = await db.client.query('select distinct source from public.positions')
    assert.deepEqual(rows.map((r) => r.source), ['import'])
  })

  test('the working draft survives and the stray drafts become history', async () => {
    const { rows } = await db.client.query(
      'select id, status from public.boards where ward_id = $1',
      [before009.ward]
    )
    const byId = new Map(rows.map((r) => [r.id, r.status]))

    assert.equal(byId.get(before009.working), 'draft', 'the working draft is the one kept')
    for (const stray of before009.strays) {
      assert.equal(byId.get(stray), 'archived', 'other drafts are archived, not deleted')
    }
    assert.equal(rows.filter((r) => r.status === 'draft').length, 1)
  })

  test('a parked calling that somebody was holding is put back into service', async () => {
    const { rows } = await db.client.query(
      'select inactive_at from public.positions where id = $1',
      [before009.occupiedButParked]
    )
    assert.equal(rows[0].inactive_at, null)
  })

  test('a genuinely vacant parked calling stays parked', async () => {
    const { rows } = await db.client.query(
      'select inactive_at from public.positions where id = $1',
      [before009.trulyVacant]
    )
    assert.ok(rows[0].inactive_at, 'a deliberate decision must not be undone')
  })

  test('a member marked inactive while still serving is made active again', async () => {
    const { rows } = await db.client.query(
      'select archived_at from public.members where id = $1',
      [before009.servingButArchived]
    )
    assert.equal(rows[0].archived_at, null)
  })

  test('a member who really has gone stays inactive', async () => {
    const { rows } = await db.client.query(
      'select archived_at from public.members where id = $1',
      [before009.genuinelyGone]
    )
    assert.ok(rows[0].archived_at)
  })

  test('the repaired database no longer violates its own triggers', async () => {
    const violations = await db.client.query(`
      select count(*) as n
        from public.positions p
       where p.inactive_at is not null
         and exists (select 1 from public.position_assignments where position_id = p.id)
    `)
    assert.equal(Number(violations.rows[0].n), 0)

    const archivedButServing = await db.client.query(`
      select count(*) as n
        from public.members m
       where m.archived_at is not null
         and exists (
           select 1 from public.position_assignments pa
             join public.positions p on p.id = pa.position_id
             join public.groups    g on g.id = p.group_id
             join public.boards    b on b.id = g.board_id
            where pa.member_id = m.id and b.status in ('promoted', 'draft')
         )
    `)
    assert.equal(Number(archivedButServing.rows[0].n), 0)
  })

  test('existing profiles are backfilled with the email the console needs', async () => {
    const { rows } = await db.client.query(
      'select email from public.profiles where id = $1',
      [before009.helper]
    )
    assert.equal(rows[0].email, 'helper@example.com')
  })
})
