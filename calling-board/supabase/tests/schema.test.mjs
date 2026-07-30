import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase } from './harness.mjs'

let db

before(async () => {
  db = await startDatabase()
}, { timeout: 120_000 })

after(async () => {
  await db?.stop()
})

describe('migrations', () => {
  test('every migration applies cleanly', async () => {
    const { rows } = await db.client.query(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`
    )
    const tables = rows.map((r) => r.tablename)

    assert.ok(tables.includes('ward_roles'), 'ward_admins should be renamed to ward_roles')
    assert.ok(!tables.includes('ward_admins'), 'the old table name should be gone')
  })

  test('boards no longer carry is_working_draft', async () => {
    const { rows } = await db.client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'boards'`
    )
    const columns = rows.map((r) => r.column_name)
    assert.ok(!columns.includes('is_working_draft'))
  })

  test('positions default to manual, so hand-added callings survive an import', async () => {
    const { rows } = await db.client.query(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'positions' and column_name = 'source'`
    )
    assert.match(rows[0].column_default, /manual/)
  })

  test('a ward can hold only one draft', async () => {
    const { rows } = await db.client.query(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'boards_one_draft_per_ward'`
    )
    assert.equal(rows.length, 1)
    assert.match(rows[0].indexdef, /UNIQUE/)
  })

  test('signing up mirrors email onto the profile', async () => {
    const { rows } = await db.client.query(
      `insert into auth.users (email, raw_user_meta_data)
       values ('mirror@example.com', '{"full_name": "Mirror Person"}'::jsonb)
       returning id`
    )
    const profile = await db.client.query('select * from public.profiles where id = $1', [
      rows[0].id,
    ])
    assert.equal(profile.rows[0].email, 'mirror@example.com')
    assert.equal(profile.rows[0].full_name, 'Mirror Person')
    assert.equal(profile.rows[0].is_super_admin, false)
  })

  test('changing an email updates the profile', async () => {
    const { rows } = await db.client.query(
      `insert into auth.users (email) values ('before@example.com') returning id`
    )
    await db.client.query(`update auth.users set email = 'after@example.com' where id = $1`, [
      rows[0].id,
    ])
    const profile = await db.client.query('select email from public.profiles where id = $1', [
      rows[0].id,
    ])
    assert.equal(profile.rows[0].email, 'after@example.com')
  })
})
