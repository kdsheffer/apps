/**
 * Deciding whether a realtime change concerns the board on screen.
 *
 * Realtime's filter grammar only compares one column to a literal — `eq`, `in`
 * with a value list, and the ordering operators. It has no joins and no
 * subqueries, so "positions belonging to this board" is not expressible: a
 * position knows its group, and only the group knows its board. That check has
 * to happen on the client, which is what this file is.
 *
 * Kept separate from the hook so it can be tested directly. It is the part with
 * the edge cases; the hook around it is just wiring.
 */

/** The shape of a `postgres_changes` payload, narrowed to what matters here. */
export interface ChangePayload {
  eventType?: string
  new?: Record<string, unknown> | null
  old?: Record<string, unknown> | null
}

/**
 * True when a change touches one of `ids` through `column`.
 *
 * Both the new and the old row are checked, so a row moving *out* of the board
 * still counts — otherwise the board it left would never hear about it.
 *
 * When neither row carries the column, the answer is "yes". That happens when a
 * table is still on Postgres's default replica identity, where a delete arrives
 * as nothing but a primary key; migration 010 sets REPLICA IDENTITY FULL to
 * stop that. Refetching unnecessarily costs a query, whereas guessing "no"
 * loses the change altogether — so the fallback errs toward the refetch, and
 * the hook stays correct on a database that hasn't run migration 010 yet.
 */
export function touches(
  payload: ChangePayload,
  column: string,
  ids: ReadonlySet<string>
): boolean {
  const next = payload.new?.[column]
  const previous = payload.old?.[column]

  const known =
    (typeof next === 'string' ? next : null) ?? (typeof previous === 'string' ? previous : null)

  if (known === null) return true

  return (
    (typeof next === 'string' && ids.has(next)) ||
    (typeof previous === 'string' && ids.has(previous))
  )
}
