/**
 * Realtime delivers nothing unless the table is in the publication, and drops
 * deletes unless the table carries a full replica identity. Both are invisible
 * from the client — a subscription receiving nothing looks like a quiet board —
 * so they're asserted here.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase } from './harness.mjs'
import { seedWard } from './fixture.mjs'

let db

before(async () => {
  db = await startDatabase({ logical: true })
}, { timeout: 120_000 })

after(async () => {
  await db?.stop()
})

const SYNCED = ['groups', 'positions', 'position_assignments', 'members']

describe('realtime delivery', () => {
  test('every table the board reads from is in the publication', async () => {
    const { rows } = await db.client.query(
      `select tablename from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
        order by tablename`
    )
    const published = rows.map((r) => r.tablename)
    for (const table of SYNCED) {
      assert.ok(published.includes(table), `${table} must publish its changes`)
    }
  })

  test('those tables carry a full replica identity, so deletes survive filtering', async () => {
    const { rows } = await db.client.query(
      `select relname, relreplident from pg_class
        where relnamespace = 'public'::regnamespace and relname = any($1)`,
      [SYNCED]
    )
    assert.equal(rows.length, SYNCED.length)
    for (const row of rows) {
      // 'f' is FULL; 'd' is the default that reduces a delete to its key.
      assert.equal(row.relreplident, 'f', `${row.relname} must use REPLICA IDENTITY FULL`)
    }
  })

  test('re-running the migration is harmless', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const here = dirname(fileURLToPath(import.meta.url))
    const sql = await readFile(
      join(here, '..', 'migrations', '010_realtime_delivery.sql'),
      'utf8'
    )

    // Adding a table already in a publication raises, so the migration guards
    // each one. This is the check that the guard works.
    await db.client.query(sql)

    const { rows } = await db.client.query(
      `select count(*) as n from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'positions'`
    )
    assert.equal(Number(rows[0].n), 1)
  })
})

/**
 * The checks above confirm the settings; these confirm the consequence. Reading
 * the replication slot shows what a subscriber would actually be handed, which
 * is the thing that was silently broken.
 */
describe('what a subscriber actually receives', () => {
  let w
  let changes

  before(async () => {
    w = await seedWard(db.client, { name: 'Realtime Ward' })
    await db.client.query(
      `select pg_create_logical_replication_slot('board_changes', 'test_decoding')`
    )

    // Drain everything the seed produced so only the deletes below are read.
    await db.client.query(`select pg_logical_slot_get_changes('board_changes', null, null)`)

    await db.client.query('delete from public.position_assignments where position_id = $1', [
      w.positions.filled,
    ])
    await db.client.query('delete from public.positions where id = $1', [w.positions.vacant])
    await db.client.query('delete from public.groups where id = $1', [w.group])
    await db.client.query('delete from public.members where id = $1', [w.members.spare])

    const { rows } = await db.client.query(
      `select data from pg_logical_slot_get_changes('board_changes', null, null)`
    )
    changes = rows.map((r) => r.data).filter((d) => d.includes('DELETE'))
  })

  const deleteFor = (table) => changes.find((d) => d.startsWith(`table public.${table}:`))

  test('a deleted group still says which board it was on', () => {
    const row = deleteFor('groups')
    assert.ok(row, 'the delete should reach the stream at all')
    assert.match(row, /board_id\[uuid\]/, 'the groups filter matches on board_id')
  })

  test('a deleted member still says which ward it was in', () => {
    const row = deleteFor('members')
    assert.ok(row)
    assert.match(row, /ward_id\[uuid\]/, 'the members filter matches on ward_id')
  })

  test('a deleted calling still says which group it was in', () => {
    const row = deleteFor('positions')
    assert.ok(row)
    assert.match(row, /group_id\[uuid\]/, 'the client matches on group_id')
  })

  test('a deleted assignment still says which calling it was on', () => {
    const row = deleteFor('position_assignments')
    assert.ok(row)
    assert.match(row, /position_id\[uuid\]/, 'the client matches on position_id')
  })
})
