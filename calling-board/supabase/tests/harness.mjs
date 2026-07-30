/**
 * Runs the migrations against a throwaway Postgres so their behaviour can be
 * asserted instead of assumed.
 *
 * Supabase supplies an `auth` schema, an `auth.uid()` that reads the request's
 * JWT claims, and the `anon` / `authenticated` / `service_role` roles. None of
 * that exists in a bare Postgres, so `shim.sql` recreates just enough of it:
 * `auth.uid()` reads a session GUC that `asUser()` sets, which is how a test
 * gets to "be" a particular signed-in user with their RLS policies applied.
 */
import { appendFile, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

// embedded-postgres lives in the scratch install rather than the app's
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
      `  PG_TEST_MODULES=/tmp/pgtest node --test supabase/tests\n`
  )
}

const EmbeddedPostgres = load('embedded-postgres').default ?? load('embedded-postgres')

/** Migrations that only seed a demo ward; nothing here depends on them. */
const SKIP = new Set(['004_seed_test_data.sql', '005_seed_test_data_simple.sql'])

let port = 55400 + (process.pid % 120)

/**
 * @param {object} [options]
 * @param {string} [options.upTo] Stop after this migration file, so a test can
 *   set up data the way the old schema allowed and then run the rest with
 *   `applyRemaining`. That's the only way to exercise a migration's repair of
 *   data that already broke the rules it's introducing.
 * @param {boolean} [options.logical] Turn on logical decoding, so a test can
 *   read the change stream Realtime consumes and see what a subscriber would
 *   actually receive. Off by default — it costs a slower start.
 */
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

  // Has to be set before the server starts; it can't be changed at runtime.
  if (options.logical) {
    await appendFile(join(dataDir, 'postgresql.conf'), '\nwal_level = logical\n')
  }

  await pg.start()

  const client = pg.getPgClient()
  await client.connect()

  await client.query(await readFile(join(here, 'shim.sql'), 'utf8'))

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

  const run = async (subset) => {
    for (const file of subset) {
      if (SKIP.has(file)) continue
      const sql = await readFile(join(migrationsDir, file), 'utf8')
      try {
        await client.query(sql)
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${error.message}`)
      }
    }
  }

  const stopAt = options.upTo ? files.indexOf(options.upTo) : -1
  if (options.upTo && stopAt === -1) throw new Error(`No migration named ${options.upTo}`)

  const first = stopAt === -1 ? files : files.slice(0, stopAt + 1)
  const rest = stopAt === -1 ? [] : files.slice(stopAt + 1)
  await run(first)

  return {
    client,
    applyRemaining: () => run(rest),
    async stop() {
      await client.end()
      await pg.stop()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * Runs `fn` as a signed-in user: the `authenticated` role with RLS enforced and
 * `auth.uid()` returning `userId`. Reset afterwards so the next block starts
 * from the superuser connection again.
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
