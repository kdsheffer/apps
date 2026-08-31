import {
  SUBSCRIPTION_HINT,
  SUBSCRIPTION_LABEL,
  useSubscriptions,
  type SubscriptionKind,
} from '../hooks/useSubscriptions'
import { errorMessage } from '../lib/errors'
import { Alert } from './PageShell'
import { useState } from 'react'

const KINDS: SubscriptionKind[] = ['booking', 'digest']

/**
 * Two switches per person: whether they hear about each booking, and whether
 * they get the day-before report.
 *
 * Shown against people who already have access to this ward, because that is
 * who may be subscribed — the database refuses anything else, since a
 * subscription sends out family names, phone numbers and email addresses.
 */
export function NotificationSwitches({
  wardId,
  userId,
  label,
  canEdit,
}: {
  wardId: string
  userId: string
  label: string
  /** Somebody may always change their own; an admin may change anybody's. */
  canEdit: boolean
}) {
  const { list, subscribe, unsubscribe } = useSubscriptions(wardId)
  const [error, setError] = useState<string | null>(null)

  const mine = (list.data ?? []).filter((s) => s.user_id === userId)

  const toggle = async (kind: SubscriptionKind) => {
    setError(null)
    const existing = mine.find((s) => s.kind === kind)
    try {
      if (existing) await unsubscribe.mutateAsync(existing.id)
      else await subscribe.mutateAsync({ userId, kind })
    } catch (e) {
      setError(errorMessage(e, 'That could not be changed.'))
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {KINDS.map((kind) => (
          <label
            key={kind}
            title={SUBSCRIPTION_HINT[kind]}
            className={`flex items-center gap-2 text-sm ${
              canEdit ? 'cursor-pointer text-gray-700' : 'cursor-not-allowed text-gray-400'
            }`}
          >
            <input
              type="checkbox"
              checked={mine.some((s) => s.kind === kind)}
              disabled={!canEdit}
              onChange={() => toggle(kind)}
              aria-label={`${SUBSCRIPTION_LABEL[kind]} for ${label}`}
              className="h-4 w-4 rounded border-gray-300 disabled:opacity-50"
            />
            {SUBSCRIPTION_LABEL[kind]}
          </label>
        ))}
      </div>
      {error && (
        <div className="mt-2">
          <Alert onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}
    </div>
  )
}
