/**
 * Runs the migrations against a throwaway Postgres so their behaviour can be
 * asserted instead of assumed.
 *
 * Supabase supplies an `auth` schema, an `auth.uid()` that reads the request's
 * JWT claims, and the `anon` / `authenticated` / `service_role` roles. None of
 * that exists in a bare Postgres, so `shim.sql` recreates just enough of it:
 * `auth.uid()` reads a session GUC that `asUser()` sets, which is how a test
 * gets to "be" a particular signed-in user with their RLS policies applied.
 *
 * `asAnon()` is the one this app leans on hardest. Most of its users are never
 * signed in, so "what can a stranger reach" is a behaviour with tests rather
 * than an assumption in a comment.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

// embedded-postgres lives in a scratch install rather than the app's
// dependencies — it pulls down a platform-specific Postgres build, which has no
// business in a Vercel deploy.
const require = createRequire(import.meta.url)
function load(name) {
  const roots = [here, process.env.PG_TEST_MODULES].filter(Boolean)
  for (const root of roots) {
    try {
      return require(require.resolve(name, { paths: [root] }))
    } catch {
      /* try the next root */
    }
  }
  throw new Error(
    `Cannot find "${name}". These tests need a local Postgres:\n` +
      `  npm i embedded-postgres pg --prefix /tmp/pgtest\n` +
      `  PG_TEST_MODULES=/tmp/pgtest npm run test:db\n`
  )
}

const EmbeddedPostgres = load('embedded-postgres').default ?? load('embedded-postgres')

/** Migrations that only seed demo data; nothing here depends on them. */
const SKIP = new Set(['005_seed_demo.sql'])

let port = 55600 + (process.pid % 120)

export async function startDatabase(options = {}) {
  const dataDir = join(here, `.pgdata-${process.pid}-${port}`)
  await rm(dataDir, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: port++,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  })

  await pg.initialise()
  await pg.start()

  const client = pg.getPgClient()
  await client.connect()

  await client.query(await readFile(join(here, 'shim.sql'), 'utf8'))

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    if (SKIP.has(file) && !options.includeSeed) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    try {
      await client.query(sql)
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${error.message}`)
    }
  }

  const extras = []

  return {
    client,

    /**
     * A second connection to the same database.
     *
     * Needed to test anything that only goes wrong when two callers overlap —
     * `for update skip locked` cannot be exercised from one connection, because
     * a single session never contends with itself.
     */
    async newClient() {
      const extra = pg.getPgClient()
      await extra.connect()
      extras.push(extra)
      return extra
    },

    async stop() {
      for (const extra of extras) await extra.end().catch(() => {})
      await client.end()
      await pg.stop()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * Runs `fn` as a signed-in user: the `authenticated` role with RLS enforced and
 * `auth.uid()` returning `userId`.
 */
export async function asUser(client, userId, fn) {
  await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId])
  await client.query('set role authenticated')
  try {
    return await fn()
  } finally {
    await client.query('reset role')
    await client.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

/**
 * Runs `fn` as a signed-out visitor: the `anon` role, no JWT subject. This is
 * the majority of this app's traffic, and the role every table is revoked from.
 */
export async function asAnon(client, fn) {
  await client.query(`select set_config('request.jwt.claim.sub', '', false)`)
  await client.query('set role anon')
  try {
    return await fn()
  } finally {
    await client.query('reset role')
  }
}

/** Creates an auth user (which the trigger mirrors into `profiles`). */
export async function createUser(client, email, { superAdmin = false } = {}) {
  const { rows } = await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1::text, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, email.split('@')[0]]
  )
  const id = rows[0].id
  if (superAdmin) {
    await client.query('update public.profiles set is_super_admin = true where id = $1', [id])
  }
  return id
}

/** Asserts that `fn` is refused — either by RLS (0 rows) or by a raised error. */
export async function refused(fn) {
  try {
    const result = await fn()
    return result?.rowCount === 0
  } catch {
    return true
  }
}

/** The message from a call that was expected to fail. Fails the test if it didn't. */
export async function errorFrom(fn) {
  try {
    await fn()
  } catch (error) {
    return error.message
  }
  throw new Error('Expected that to be refused, but it succeeded.')
}
