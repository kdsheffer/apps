import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase } from './harness.mjs'
import { seedWard } from './fixture.mjs'

let db
let w

before(async () => {
  db = await startDatabase()
  w = await seedWard(db.client)
}, { timeout: 120_000 })

after(async () => {
  await db?.stop()
})

const rejects = async (fn, pattern) => {
  await assert.rejects(fn, (error) => {
    assert.match(error.message, pattern)
    return true
  })
}

describe('only a vacant calling can be inactive', () => {
  test('marking an occupied calling inactive is refused', async () => {
    await rejects(
      () =>
        db.client.query('update public.positions set inactive_at = now() where id = $1', [
          w.positions.filled,
        ]),
      /Release everyone from "President"/
    )
  })

  test('a vacant calling can be marked inactive', async () => {
    const res = await db.client.query(
      'update public.positions set inactive_at = now() where id = $1 returning inactive_at',
      [w.positions.vacant]
    )
    assert.ok(res.rows[0].inactive_at)
  })

  test('filling an inactive calling brings it back into service', async () => {
    await db.client.query(
      `insert into public.position_assignments (position_id, member_id, called_date)
       values ($1, $2, current_date)`,
      [w.positions.vacant, w.members.spare]
    )

    const { rows } = await db.client.query(
      'select inactive_at from public.positions where id = $1',
      [w.positions.vacant]
    )
    assert.equal(rows[0].inactive_at, null)
  })
})

describe('an inactive member cannot hold a calling', () => {
  test('marking a called member inactive is refused', async () => {
    await rejects(
      () =>
        db.client.query('update public.members set archived_at = now() where id = $1', [
          w.members.called,
        ]),
      /Release Called, Person from President/
    )
  })

  test('a member holding nothing can be marked inactive', async () => {
    const loose = (
      await db.client.query(
        `insert into public.members (ward_id, full_name) values ($1, 'Loose, End') returning id`,
        [w.ward]
      )
    ).rows[0].id

    const res = await db.client.query(
      'update public.members set archived_at = now() where id = $1 returning archived_at',
      [loose]
    )
    assert.ok(res.rows[0].archived_at)
    return loose
  })

  test('calling an inactive member reactivates them', async () => {
    const returning = (
      await db.client.query(
        `insert into public.members (ward_id, full_name, archived_at)
         values ($1, 'Returned, Home', now()) returning id`,
        [w.ward]
      )
    ).rows[0].id

    const seat = (
      await db.client.query(
        `insert into public.positions (group_id, title, sort_order, source)
         values ($1, 'Instructor', 5, 'import') returning id`,
        [w.group]
      )
    ).rows[0].id

    await db.client.query(
      `insert into public.position_assignments (position_id, member_id, called_date)
       values ($1, $2, current_date)`,
      [seat, returning]
    )

    const { rows } = await db.client.query(
      'select archived_at from public.members where id = $1',
      [returning]
    )
    assert.equal(rows[0].archived_at, null)
  })

  test('a calling held only on an archived board does not block deactivation', async () => {
    const history = (
      await db.client.query(
        `insert into public.boards (ward_id, status, name, created_by)
         values ($1, 'archived', 'Last year', $2) returning id`,
        [w.ward, w.users.superAdmin]
      )
    ).rows[0].id

    const oldGroup = (
      await db.client.query(
        `insert into public.groups (board_id, name, sort_order) values ($1, 'Primary', 0)
         returning id`,
        [history]
      )
    ).rows[0].id

    const oldSeat = (
      await db.client.query(
        `insert into public.positions (group_id, title, sort_order, source)
         values ($1, 'Chorister', 0, 'import') returning id`,
        [oldGroup]
      )
    ).rows[0].id

    const departed = (
      await db.client.query(
        `insert into public.members (ward_id, full_name) values ($1, 'Moved, Away') returning id`,
        [w.ward]
      )
    ).rows[0].id

    await db.client.query(
      `insert into public.position_assignments (position_id, member_id, called_date)
       values ($1, $2, current_date)`,
      [oldSeat, departed]
    )

    const res = await db.client.query(
      'update public.members set archived_at = now() where id = $1 returning archived_at',
      [departed]
    )
    assert.ok(res.rows[0].archived_at, 'history should not pin somebody active forever')
  })
})

describe('one editable draft per ward', () => {
  test('a second draft is refused', async () => {
    await db.client.query(
      `insert into public.boards (ward_id, status, name, created_by)
       values ($1, 'draft', 'Working draft', $2)`,
      [w.ward, w.users.wardAdmin]
    )

    await rejects(
      () =>
        db.client.query(
          `insert into public.boards (ward_id, status, name, created_by)
           values ($1, 'draft', 'Another draft', $2)`,
          [w.ward, w.users.wardAdmin]
        ),
      /boards_one_draft_per_ward/
    )
  })
})
