import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { asUser, createUser, refused, startDatabase } from './harness.mjs'
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

const count = async (sql, params = []) => {
  const { rows } = await db.client.query(sql, params)
  return rows.length
}

describe('ward viewer', () => {
  test('sees the whole board', async () => {
    await asUser(db.client, w.users.wardViewer, async () => {
      assert.equal(await count('select id from public.wards'), 1)
      assert.equal(await count('select id from public.boards'), 1)
      assert.equal(await count('select id from public.groups'), 1)
      assert.equal(await count('select id from public.positions'), 2)
      assert.equal(await count('select id from public.members'), 2)
      assert.equal(await count('select id from public.position_assignments'), 1)
    })
  })

  test('cannot change anything', async () => {
    await asUser(db.client, w.users.wardViewer, async () => {
      assert.ok(
        await refused(() =>
          db.client.query(`update public.positions set title = 'Hijacked' where id = $1`, [
            w.positions.vacant,
          ])
        ),
        'a viewer must not rename a calling'
      )
      assert.ok(
        await refused(() =>
          db.client.query(
            `insert into public.position_assignments (position_id, member_id, called_date)
             values ($1, $2, current_date)`,
            [w.positions.vacant, w.members.spare]
          )
        ),
        'a viewer must not fill a calling'
      )
      assert.ok(
        await refused(() =>
          db.client.query(`delete from public.members where id = $1`, [w.members.spare])
        ),
        'a viewer must not delete a member'
      )
      assert.ok(
        await refused(() =>
          db.client.query(
            `insert into public.boards (ward_id, status, name, created_by)
             values ($1, 'draft', 'Sneaky', $2)`,
            [w.ward, w.users.wardViewer]
          )
        ),
        'a viewer must not create a board'
      )
    })

    const title = await db.client.query('select title from public.positions where id = $1', [
      w.positions.vacant,
    ])
    assert.equal(title.rows[0].title, 'Secretary')
  })

  test('cannot promote themselves to ward admin', async () => {
    await asUser(db.client, w.users.wardViewer, async () => {
      assert.ok(
        await refused(() =>
          db.client.query(`update public.ward_roles set role = 'admin' where user_id = $1`, [
            w.users.wardViewer,
          ])
        )
      )
    })
  })
})

describe('ward admin', () => {
  test('can edit the ward', async () => {
    await asUser(db.client, w.users.wardAdmin, async () => {
      const res = await db.client.query(
        `update public.positions set notes = 'looked at' where id = $1 returning id`,
        [w.positions.vacant]
      )
      assert.equal(res.rowCount, 1)
    })
  })

  test('can grant access to their own ward but not another', async () => {
    const other = await seedWard(db.client, { name: 'Other Ward' })
    const newcomer = await createUser(db.client, 'newcomer@example.com')

    await asUser(db.client, w.users.wardAdmin, async () => {
      const granted = await db.client.query(
        `insert into public.ward_roles (ward_id, user_id, granted_by, role)
         values ($1, $2, $3, 'viewer') returning id`,
        [w.ward, newcomer, w.users.wardAdmin]
      )
      assert.equal(granted.rowCount, 1)

      assert.ok(
        await refused(() =>
          db.client.query(
            `insert into public.ward_roles (ward_id, user_id, granted_by, role)
             values ($1, $2, $3, 'admin')`,
            [other.ward, w.users.wardAdmin, w.users.wardAdmin]
          )
        ),
        'a ward admin must not grant themselves another ward'
      )
    })
  })

  test('cannot make themselves a system admin', async () => {
    await asUser(db.client, w.users.wardAdmin, async () => {
      assert.ok(
        await refused(() =>
          db.client.query('update public.profiles set is_super_admin = true where id = $1', [
            w.users.wardAdmin,
          ])
        )
      )
    })
    const { rows } = await db.client.query(
      'select is_super_admin from public.profiles where id = $1',
      [w.users.wardAdmin]
    )
    assert.equal(rows[0].is_super_admin, false)
  })
})

describe('outsider', () => {
  test('sees nothing', async () => {
    await asUser(db.client, w.users.outsider, async () => {
      assert.equal(await count('select id from public.wards'), 0)
      assert.equal(await count('select id from public.boards'), 0)
      assert.equal(await count('select id from public.members'), 0)
      assert.equal(await count('select id from public.position_assignments'), 0)
    })
  })

  test('sees only their own profile', async () => {
    await asUser(db.client, w.users.outsider, async () => {
      const { rows } = await db.client.query('select id from public.profiles')
      assert.deepEqual(
        rows.map((r) => r.id),
        [w.users.outsider]
      )
    })
  })
})

describe('system admin', () => {
  test('sees every user and every ward', async () => {
    await asUser(db.client, w.users.superAdmin, async () => {
      const profiles = await count('select id from public.profiles')
      assert.ok(profiles >= 5, `expected the whole user list, saw ${profiles}`)
      assert.ok((await count('select id from public.wards')) >= 2)
    })
  })

  test('can promote and demote somebody else', async () => {
    await asUser(db.client, w.users.superAdmin, async () => {
      const up = await db.client.query(
        'update public.profiles set is_super_admin = true where id = $1 returning id',
        [w.users.wardAdmin]
      )
      assert.equal(up.rowCount, 1)

      const down = await db.client.query(
        'update public.profiles set is_super_admin = false where id = $1 returning id',
        [w.users.wardAdmin]
      )
      assert.equal(down.rowCount, 1)
    })
  })

  test('cannot demote themselves, so the last admin cannot lock themselves out', async () => {
    await asUser(db.client, w.users.superAdmin, async () => {
      assert.ok(
        await refused(() =>
          db.client.query(
            'update public.profiles set is_super_admin = false where id = $1',
            [w.users.superAdmin]
          )
        )
      )
    })
    const { rows } = await db.client.query(
      'select is_super_admin from public.profiles where id = $1',
      [w.users.superAdmin]
    )
    assert.equal(rows[0].is_super_admin, true)
  })

  test('cannot rewrite somebody else’s email', async () => {
    await asUser(db.client, w.users.superAdmin, async () => {
      assert.ok(
        await refused(() =>
          db.client.query(`update public.profiles set email = 'stolen@example.com' where id = $1`, [
            w.users.wardAdmin,
          ])
        ),
        'only is_super_admin is writable from the client'
      )
    })
  })
})

describe('ward admins and the people they manage', () => {
  test('a ward admin can read the profiles of their own ward’s users', async () => {
    await asUser(db.client, w.users.wardAdmin, async () => {
      const { rows } = await db.client.query('select id from public.profiles')
      const ids = rows.map((r) => r.id)
      assert.ok(ids.includes(w.users.wardViewer), 'should see the viewer they granted')
      assert.ok(!ids.includes(w.users.outsider), 'should not see unrelated users')
    })
  })
})
