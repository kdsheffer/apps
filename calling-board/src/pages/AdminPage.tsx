import { useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useWards } from '../hooks/useWards'
import { useProfile } from '../hooks/useProfile'
import { useAccessAdmin } from '../hooks/useAccessAdmin'
import { supabase } from '../lib/supabase'
import type { Profile, Ward, WardRole, WardRoleName } from '../types'
import { ThemeToggle } from '../components/ThemeToggle'

const ROLE_LABEL: Record<WardRoleName, string> = {
  admin: 'Ward Admin',
  viewer: 'Ward Viewer',
}

export function AdminPage() {
  const { user, signOut } = useAuth()
  const { data: profile, isLoading: profileLoading } = useProfile()
  const { data: wards, refetch: refetchWards } = useWards()

  const [newWardName, setNewWardName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const isAdmin = profile?.is_super_admin ?? false

  if (profileLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-gray-600">Loading…</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="mb-4 text-gray-600">You do not have admin access.</p>
          <button
            onClick={signOut}
            className="rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300"
          >
            Sign Out
          </button>
        </div>
      </div>
    )
  }

  const handleCreateWard = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newWardName.trim() || !user) return

    setCreating(true)
    setError(null)
    setSuccess(null)

    try {
      const { data, error: err } = await supabase
        .from('wards')
        .insert([{ name: newWardName.trim(), created_by: user.id }])
        .select()

      if (err) throw err

      // Whoever creates the ward administers it, or nobody could open it.
      if (data && data[0]) {
        await supabase
          .from('ward_roles')
          .insert([
            { ward_id: data[0].id, user_id: user.id, granted_by: user.id, role: 'admin' },
          ])
      }

      setSuccess(`Ward "${newWardName.trim()}" created`)
      setNewWardName('')
      refetchWards()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ward')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin Console</h1>
            <p className="text-sm text-gray-600">{user?.email}</p>
          </div>
          <div className="flex gap-2">
            <a
              href="/wards"
              className="rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300"
            >
              Wards
            </a>
            <button
              onClick={signOut}
              className="rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300"
            >
              Sign Out
            </button>
            <ThemeToggle className="bg-gray-200" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-4 py-8">
        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>
        )}
        {success && (
          <div className="rounded border border-green-200 bg-green-50 p-4 text-green-700">
            {success}
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-xl font-semibold text-gray-900">Create Ward</h2>
            <form onSubmit={handleCreateWard} className="space-y-4">
              <div>
                <label
                  htmlFor="ward-name"
                  className="mb-1 block text-sm font-medium text-gray-700"
                >
                  Ward Name
                </label>
                <input
                  id="ward-name"
                  type="text"
                  value={newWardName}
                  onChange={(e) => setNewWardName(e.target.value)}
                  placeholder="e.g., Salt Lake City 1st Ward"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={creating || !newWardName.trim()}
                className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create Ward'}
              </button>
            </form>
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-4 text-xl font-semibold text-gray-900">Wards</h2>
            {!wards || wards.length === 0 ? (
              <p className="text-gray-600">No wards created yet.</p>
            ) : (
              <div className="space-y-2">
                {wards.map((ward) => (
                  <div
                    key={ward.id}
                    className="rounded border border-gray-200 bg-gray-50 p-3 hover:border-blue-300"
                  >
                    <p className="font-medium text-gray-900">{ward.name}</p>
                    <p className="text-xs text-gray-500">{ward.id}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <PeopleSection wards={wards || []} currentUserId={user?.id ?? ''} />
      </main>
    </div>
  )
}

// --- People -------------------------------------------------------------------

function PeopleSection({
  wards,
  currentUserId,
}: {
  wards: Ward[]
  currentUserId: string
}) {
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
      setError(e instanceof Error ? e.message : 'That change could not be saved.')
    }
  }

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">People</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            Everyone who has signed in. <strong>System admin</strong> can do anything in every
            ward. <strong>Ward Admin</strong> can edit one ward. <strong>Ward Viewer</strong> can
            see one ward but change nothing. There's no invite — somebody has to sign in once
            before they appear here.
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
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
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
    </div>
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
                      onChange={(e) =>
                        onGrant(role.ward_id, e.target.value as WardRoleName)
                      }
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
