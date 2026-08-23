import { useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useAppSettings, useWards } from '../hooks/useWards'
import { useProfile } from '../hooks/useProfile'
import { useAccessAdmin } from '../hooks/useAccessAdmin'
import { supabase } from '../lib/supabase'
import { AdminShell } from '../components/AdminShell'
import { errorMessage } from '../lib/errors'
import { Alert, Card } from '../components/PageShell'
import { Field, inputClass } from '../components/Field'
import type { Profile, Ward, WardRole, WardRoleName } from '../types'

const ROLE_LABEL: Record<WardRoleName, string> = {
  admin: 'Executive secretary',
  viewer: 'Bishopric (read-only)',
}

/** Turns "Riverbend 3rd Ward" into "riverbend-3rd-ward" for the public link. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export function AdminPage() {
  const { user } = useAuth()
  const { data: profile, isLoading } = useProfile()
  const { data: wards, refetch: refetchWards } = useWards()

  if (isLoading) {
    return <AdminShell title="Admin"><Card>Loading…</Card></AdminShell>
  }

  if (!profile?.is_super_admin) {
    return (
      <AdminShell title="Admin">
        <Alert>You don't have system admin access.</Alert>
      </AdminShell>
    )
  }

  return (
    <AdminShell title="Admin console" subtitle={user?.email} wide>
      <SiteSettings />

      <div className="grid gap-6 lg:grid-cols-2">
        <CreateWardForm currentUserId={user?.id ?? ''} onCreated={refetchWards} />
        <WardList wards={wards ?? []} />
      </div>
      <PeopleSection wards={wards ?? []} currentUserId={user?.id ?? ''} />
    </AdminShell>
  )
}

// --- Site settings ----------------------------------------------------------

function SiteSettings() {
  const { settings, update } = useAppSettings()
  const [value, setValue] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const current = value ?? settings.data?.site_url ?? ''
  const looksLocal = /localhost|127\.0\.0\.1/.test(current)

  return (
    <Card>
      <h2 className="text-lg font-semibold text-gray-900">Site address</h2>
      <p className="mb-4 mt-1 max-w-2xl text-sm text-gray-600">
        Where this app is reachable from. Every confirmation and reminder builds
        its cancel link from this, so if it's wrong the links in those emails go
        nowhere.
      </p>

      {update.error && (
        <div className="mb-4">
          <Alert onDismiss={() => update.reset()}>{(update.error as Error).message}</Alert>
        </div>
      )}
      {saved && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setSaved(false)}>
            Saved.
          </Alert>
        </div>
      )}
      {looksLocal && (
        <div className="mb-4">
          <Alert tone="info">
            This still points at a local address. Set it to the deployed URL
            before members start booking, or their cancel links won't work.
          </Alert>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setSaved(false)
          update.mutate(current, { onSuccess: () => setSaved(true) })
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-64 flex-1">
          <Field id="site-url" label="Address" required>
            <input
              id="site-url"
              type="url"
              required
              value={current}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://tithing.yourward.org"
              className={inputClass}
            />
          </Field>
        </div>
        <button
          type="submit"
          disabled={update.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Card>
  )
}

// --- Wards ------------------------------------------------------------------

function CreateWardForm({
  currentUserId,
  onCreated,
}: {
  currentUserId: string
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Denver'
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // The slug follows the name until somebody edits it, then it stops — a link
  // that has been handed out must not change because a typo in the name did.
  const [slugTouched, setSlugTouched] = useState(false)
  const effectiveSlug = slugTouched ? slug : slugify(name)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !currentUserId) return

    setBusy(true)
    setError(null)
    setSuccess(null)

    try {
      const { data, error: err } = await supabase
        .from('wards')
        .insert([
          { name: name.trim(), slug: effectiveSlug, timezone, created_by: currentUserId },
        ])
        .select()
      if (err) throw err

      // Whoever creates the ward administers it, or nobody could open it.
      if (data?.[0]) {
        await supabase.from('ward_roles').insert([
          { ward_id: data[0].id, user_id: currentUserId, granted_by: currentUserId, role: 'admin' },
        ])
      }

      setSuccess(`Created "${name.trim()}" — members book at /w/${effectiveSlug}`)
      setName('')
      setSlug('')
      setSlugTouched(false)
      onCreated()
    } catch (e) {
      setError(errorMessage(e, 'That ward could not be created.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Create a ward</h2>
      {error && (
        <div className="mb-4">
          <Alert onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}
      {success && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setSuccess(null)}>
            {success}
          </Alert>
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Field id="ward-name" label="Ward name" required>
          <input
            id="ward-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Riverbend 3rd Ward"
            className={inputClass}
          />
        </Field>

        <Field
          id="ward-slug"
          label="Booking link"
          required
          hint={`Members will book at ${window.location.origin}/w/${effectiveSlug || '…'}`}
        >
          <input
            id="ward-slug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(slugify(e.target.value))
            }}
            className={inputClass}
          />
        </Field>

        <Field
          id="ward-tz"
          label="Timezone"
          required
          hint="Every appointment time is shown in this zone, wherever the reader is."
        >
          <input
            id="ward-tz"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Denver"
            className={inputClass}
          />
        </Field>

        <button
          type="submit"
          disabled={busy || !name.trim() || !effectiveSlug}
          className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create ward'}
        </button>
      </form>
    </Card>
  )
}

function WardList({ wards }: { wards: Ward[] }) {
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Wards</h2>
      {wards.length === 0 ? (
        <p className="text-gray-600">No wards yet.</p>
      ) : (
        <ul className="space-y-2">
          {wards.map((ward) => (
            <li key={ward.id} className="rounded border border-gray-200 bg-gray-50 p-3">
              <p className="font-medium text-gray-900">{ward.name}</p>
              <p className="text-sm text-gray-600">/w/{ward.slug} · {ward.timezone}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// --- People -----------------------------------------------------------------

function PeopleSection({ wards, currentUserId }: { wards: Ward[]; currentUserId: string }) {
  const { profiles, wardRoles, setSuperAdmin, grantWardRole, revokeWardRole } = useAccessAdmin()
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const rolesByUser = useMemo(() => {
    const map = new Map<string, WardRole[]>()
    for (const role of wardRoles.data || []) {
      const list = map.get(role.user_id) ?? []
      list.push(role)
      map.set(role.user_id, list)
    }
    return map
  }, [wardRoles.data])

  const wardsById = useMemo(() => new Map(wards.map((w) => [w.id, w])), [wards])

  const people = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = profiles.data || []
    if (!needle) return list
    return list.filter((p) =>
      `${p.email ?? ''} ${p.full_name ?? ''}`.toLowerCase().includes(needle)
    )
  }, [profiles.data, search])

  const run = async (action: Promise<unknown>) => {
    setError(null)
    try {
      await action
    } catch (e) {
      setError(errorMessage(e, 'That change could not be saved.'))
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">People</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Everyone who has signed in. <strong>System admin</strong> can do anything in every
            ward. <strong>Executive secretary</strong> builds and manages one ward's schedule.{' '}
            <strong>Bishopric</strong> can see it but change nothing. There's no invite —
            somebody has to sign in once before they appear here.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-gray-500">
            Members booking an appointment need none of this. They never sign in.
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-64"
        />
      </div>

      {error && (
        <div className="mb-4">
          <Alert onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {profiles.isLoading ? (
        <p className="text-sm text-gray-500">Loading people…</p>
      ) : people.length === 0 ? (
        <p className="text-sm text-gray-500">
          {search ? 'Nobody matches that search.' : 'Nobody has signed in yet.'}
        </p>
      ) : (
        <div className="space-y-3">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              isSelf={person.id === currentUserId}
              roles={rolesByUser.get(person.id) ?? []}
              wards={wards}
              wardsById={wardsById}
              onToggleSuperAdmin={(value) =>
                run(setSuperAdmin.mutateAsync({ userId: person.id, value }))
              }
              onGrant={(wardId, role) =>
                run(grantWardRole.mutateAsync({ wardId, userId: person.id, role }))
              }
              onRevoke={(roleId) => run(revokeWardRole.mutateAsync(roleId))}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

interface PersonRowProps {
  person: Profile
  isSelf: boolean
  roles: WardRole[]
  wards: Ward[]
  wardsById: Map<string, Ward>
  onToggleSuperAdmin: (value: boolean) => void
  onGrant: (wardId: string, role: WardRoleName) => void
  onRevoke: (roleId: string) => void
}

function PersonRow({
  person,
  isSelf,
  roles,
  wards,
  wardsById,
  onToggleSuperAdmin,
  onGrant,
  onRevoke,
}: PersonRowProps) {
  const granted = new Set(roles.map((r) => r.ward_id))
  const available = wards.filter((w) => !granted.has(w.id))

  const [addingWard, setAddingWard] = useState('')
  const [addingRole, setAddingRole] = useState<WardRoleName>('viewer')

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">
            {person.email ?? '(no email on file)'}
            {isSelf && <span className="ml-2 text-xs font-normal text-gray-500">you</span>}
          </p>
          {person.full_name && (
            <p className="truncate text-sm text-gray-600">{person.full_name}</p>
          )}
          <p className="text-xs text-gray-400">
            Joined {new Date(person.created_at).toLocaleDateString()}
          </p>
        </div>

        <label
          className={`flex shrink-0 items-center gap-2 text-sm ${
            isSelf ? 'cursor-not-allowed text-gray-400' : 'cursor-pointer text-gray-700'
          }`}
          title={
            isSelf
              ? "You can't change your own system admin access — it's what stops the last admin locking themselves out."
              : 'Full access to every ward'
          }
        >
          <input
            type="checkbox"
            checked={person.is_super_admin}
            disabled={isSelf}
            onChange={(e) => onToggleSuperAdmin(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 disabled:opacity-50"
          />
          System admin
        </label>
      </div>

      <div className="mt-3">
        {person.is_super_admin ? (
          <p className="text-sm text-gray-500">
            System admins already have full access to every ward.
          </p>
        ) : (
          <>
            {roles.length === 0 ? (
              <p className="text-sm text-gray-500">No ward access.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <li
                    key={role.id}
                    className="flex items-center gap-2 rounded-full bg-gray-100 py-1 pl-3 pr-1 text-sm"
                  >
                    <span className="text-gray-900">
                      {wardsById.get(role.ward_id)?.name ?? 'Unknown ward'}
                    </span>
                    <select
                      value={role.role}
                      onChange={(e) => onGrant(role.ward_id, e.target.value as WardRoleName)}
                      aria-label={`Role in ${wardsById.get(role.ward_id)?.name ?? 'ward'}`}
                      className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs"
                    >
                      <option value="admin">{ROLE_LABEL.admin}</option>
                      <option value="viewer">{ROLE_LABEL.viewer}</option>
                    </select>
                    <button
                      onClick={() => onRevoke(role.id)}
                      aria-label={`Remove access to ${wardsById.get(role.ward_id)?.name ?? 'ward'}`}
                      className="rounded-full px-2 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {available.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={addingWard}
                  onChange={(e) => setAddingWard(e.target.value)}
                  aria-label={`Give ${person.email ?? 'this person'} access to a ward`}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">Add a ward…</option>
                  {available.map((ward) => (
                    <option key={ward.id} value={ward.id}>
                      {ward.name}
                    </option>
                  ))}
                </select>
                <select
                  value={addingRole}
                  onChange={(e) => setAddingRole(e.target.value as WardRoleName)}
                  aria-label="Role to grant"
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="viewer">{ROLE_LABEL.viewer}</option>
                  <option value="admin">{ROLE_LABEL.admin}</option>
                </select>
                <button
                  onClick={() => {
                    if (!addingWard) return
                    onGrant(addingWard, addingRole)
                    setAddingWard('')
                  }}
                  disabled={!addingWard}
                  className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Grant
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
