import { Link } from 'react-router-dom'
import { useWards } from '../hooks/useWards'
import { useProfile } from '../hooks/useProfile'
import { AdminShell } from '../components/AdminShell'
import { Card } from '../components/PageShell'

/**
 * The wards this person can work on. For most people that is exactly one, so
 * this page is mostly a signpost — but it is also where the public link for a
 * ward is copied from, which is the thing the executive secretary actually
 * needs to hand round.
 */
export function WardsPage() {
  const { data: wards, isLoading } = useWards()
  const { data: profile } = useProfile()

  return (
    <AdminShell title="Wards">
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !wards || wards.length === 0 ? (
        <Card>
          <h2 className="font-semibold text-gray-900">No wards yet</h2>
          <p className="mt-2 text-gray-600">
            {profile?.is_super_admin
              ? 'Create one from the Admin console, then give yourself access to it.'
              : "You don't have access to a ward yet. Ask whoever set this up to grant it from the Admin console."}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {wards.map((ward) => (
            <Card key={ward.id}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-gray-900">{ward.name}</h2>
                  <p className="mt-1 text-sm text-gray-600">{ward.timezone}</p>
                  <PublicLink slug={ward.slug} />
                </div>
                <Link
                  to={`/wards/${ward.id}/schedule`}
                  className="shrink-0 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Open schedule
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </AdminShell>
  )
}

/**
 * The link members are given. Shown in full rather than behind a "copy" button
 * alone, because it gets read out in ward council and printed in a bulletin as
 * often as it gets pasted.
 */
export function PublicLink({ slug }: { slug: string }) {
  const url = `${window.location.origin}/w/${slug}`

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        Booking link for members
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="break-all text-sm text-gray-700">{url}</code>
        <button
          onClick={() => navigator.clipboard?.writeText(url)}
          className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
        >
          Copy
        </button>
      </div>
    </div>
  )
}
