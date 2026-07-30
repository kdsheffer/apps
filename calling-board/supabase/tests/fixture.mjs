import { createUser } from './harness.mjs'

/**
 * A ward with a promoted board, one organization, two callings and two members,
 * plus one user of every kind: a system admin, a ward admin, a ward viewer, and
 * somebody with no access at all.
 */
export async function seedWard(client, { name = 'Test Ward' } = {}) {
  const superAdmin = await createUser(client, `super-${name}@example.com`, { superAdmin: true })
  const wardAdmin = await createUser(client, `admin-${name}@example.com`)
  const wardViewer = await createUser(client, `viewer-${name}@example.com`)
  const outsider = await createUser(client, `outsider-${name}@example.com`)

  const ward = (
    await client.query(
      'insert into public.wards (name, created_by) values ($1, $2) returning id',
      [name, superAdmin]
    )
  ).rows[0].id

  await client.query(
    `insert into public.ward_roles (ward_id, user_id, granted_by, role)
     values ($1::uuid, $2::uuid, $3::uuid, 'admin'),
            ($1::uuid, $4::uuid, $3::uuid, 'viewer')`,
    [ward, wardAdmin, superAdmin, wardViewer]
  )

  const board = (
    await client.query(
      `insert into public.boards (ward_id, status, name, created_by, promoted_at)
       values ($1, 'promoted', 'Live', $2, now()) returning id`,
      [ward, superAdmin]
    )
  ).rows[0].id

  const group = (
    await client.query(
      `insert into public.groups (board_id, name, sort_order) values ($1, 'Elders Quorum', 0)
       returning id`,
      [board]
    )
  ).rows[0].id

  const filled = (
    await client.query(
      `insert into public.positions (group_id, title, sort_order, source)
       values ($1, 'President', 0, 'import') returning id`,
      [group]
    )
  ).rows[0].id

  const vacant = (
    await client.query(
      `insert into public.positions (group_id, title, sort_order, source)
       values ($1, 'Secretary', 1, 'import') returning id`,
      [group]
    )
  ).rows[0].id

  const called = (
    await client.query(
      `insert into public.members (ward_id, full_name) values ($1, 'Called, Person')
       returning id`,
      [ward]
    )
  ).rows[0].id

  const spare = (
    await client.query(
      `insert into public.members (ward_id, full_name) values ($1, 'Spare, Person')
       returning id`,
      [ward]
    )
  ).rows[0].id

  await client.query(
    `insert into public.position_assignments (position_id, member_id, called_date)
     values ($1, $2, current_date)`,
    [filled, called]
  )

  return {
    ward,
    board,
    group,
    positions: { filled, vacant },
    members: { called, spare },
    users: { superAdmin, wardAdmin, wardViewer, outsider },
  }
}
