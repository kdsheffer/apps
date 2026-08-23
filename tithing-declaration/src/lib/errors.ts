/**
 * Getting a usable sentence out of whatever was thrown.
 *
 * The obvious `e instanceof Error ? e.message : fallback` is wrong here, and
 * quietly so. supabase-js only constructs a real `PostgrestError` — which does
 * extend `Error` — when it is configured to throw. A query that returns
 * `{ data, error }` hands back the parsed response body: a plain object with a
 * `message`, and no prototype in sight.
 *
 * So every database error reached the `instanceof` check, failed it, and was
 * replaced by a generic fallback. "That day could not be deleted" instead of
 * "The Pratt family is booked at that time. Cancel their appointment first" —
 * the difference between a dead end and an instruction.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error

  if (error && typeof error === 'object') {
    const { message, details, hint } = error as {
      message?: unknown
      details?: unknown
      hint?: unknown
    }

    if (typeof message === 'string' && message.trim()) {
      // Postgres puts the actionable half in `hint` often enough to be worth
      // carrying, and `details` names the constraint when the message doesn't.
      const extra = [details, hint].find(
        (part) => typeof part === 'string' && part.trim() && part !== message
      )
      return extra ? `${message} ${extra as string}` : message
    }

    if (typeof details === 'string' && details.trim()) return details
  }

  return fallback
}
