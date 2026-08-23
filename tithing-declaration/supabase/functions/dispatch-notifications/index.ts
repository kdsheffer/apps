/**
 * Queues anything due, then delivers everything queued.
 *
 * Runs in two modes, told apart by who is calling:
 *
 *   **Scheduled** — a cron job invokes this with the service role key. It calls
 *   `queue_due_reminders()` first, which queues a reminder for every
 *   appointment now inside its ward's lead time, then drains the queue across
 *   every ward. This is the mode that matters: nobody has to remember to send
 *   anything.
 *
 *   **On demand** — the app invokes it with a signed-in user's token, to push
 *   out whatever is queued for one ward without waiting for the next tick. It
 *   queues nothing and touches no other ward.
 *
 * Delivery lives here rather than in Postgres because Postgres cannot make an
 * HTTP request, and here rather than in the browser because a provider API key
 * that reaches a browser is a provider API key that has been published.
 *
 * Email only. SMS was written and removed in migration 008 — US carriers
 * require A2P 10DLC registration before application messages deliver, which is
 * days of paperwork for a channel this already covers.
 *
 * Sending is Resend's HTTP API. This was briefly plain SMTP, on the argument
 * that every provider speaks it and switching would cost nothing — true, but
 * the price was five environment variables to get right instead of two, and a
 * TCP connection to manage. With the provider settled that trade stopped paying
 * for itself. Moving to another provider means rewriting `sendEmail` and
 * nothing else; everything below it is provider-agnostic.
 *
 * Deploy:  supabase functions deploy dispatch-notifications
 *          (or paste into Dashboard → Edge Functions → via editor)
 * Secrets: RESEND_API_KEY, NOTIFICATION_FROM_EMAIL,
 *          and optionally NOTIFICATION_REPLY_TO
 * Schedule: every 15 minutes — see the README.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** How many to take in one invocation, so a long queue can't time the function out. */
const BATCH = 50

/** Give up on a message after this many tries and mark it failed for good. */
const MAX_ATTEMPTS = 3

interface NotificationRow {
  id: string
  to_address: string
  subject: string | null
  body: string
  attempts: number
}

const env = (name: string) => Deno.env.get(name) ?? ''

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function sendEmail(row: NotificationRow): Promise<void> {
  /* A reply-to worth setting when the From address is on a domain that receives
   * no mail. Members reply to appointment reminders whatever the message says —
   * "do not reply" has never stopped anybody — and a reply that bounces is
   * worse than one nobody answers. Point it at an inbox a human opens.
   *
   * Optional: with no value, replies go to the From address, which is right
   * when that address can actually receive them. */
  const replyTo = env('NOTIFICATION_REPLY_TO')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env('NOTIFICATION_FROM_EMAIL'),
      to: [row.to_address],
      subject: row.subject ?? 'Tithing declaration',
      text: row.body,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })

  if (!response.ok) {
    // Truncated because this is stored on the row and read by a person in the
    // Messages panel, not parsed. Resend's message names the actual problem —
    // usually a From address that isn't on the verified domain.
    throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const configured = Boolean(env('RESEND_API_KEY') && env('NOTIFICATION_FROM_EMAIL'))

  let wardId: string | undefined
  try {
    wardId = (await request.json().catch(() => ({})))?.ward_id
  } catch {
    wardId = undefined
  }

  const authorization = request.headers.get('Authorization') ?? ''
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')

  /* What makes a request the scheduler's.
   *
   * Normally the service role key in the Authorization header: that is what
   * Supabase Cron sends, and the platform has already verified it as a JWT
   * before this function runs. Compared explicitly rather than inferred from a
   * missing ward_id, so nobody gets scheduler powers by leaving a field out.
   *
   * `CRON_SECRET` is the escape hatch for a scheduler that cannot set an
   * Authorization header. Setting it means you must also turn off this
   * function's JWT verification — otherwise the platform rejects the call
   * before any of this runs — so it is opt-in and off unless a value exists. */
  const cronSecret = env('CRON_SECRET')
  const scheduled =
    (Boolean(serviceKey) && authorization === `Bearer ${serviceKey}`) ||
    (Boolean(cronSecret) && request.headers.get('x-cron-secret') === cronSecret)

  const admin = createClient(env('SUPABASE_URL'), serviceKey)

  if (!scheduled) {
    if (!wardId) return json({ error: 'ward_id is required.' }, 400)

    // Asked as the caller, not as the service role — which would answer for the
    // service role, and the answer is always yes.
    const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
    })
    const { data: allowed, error: authError } = await asCaller.rpc('is_ward_admin', {
      target_ward: wardId,
    })
    if (authError) return json({ error: authError.message }, 500)
    if (!allowed) return json({ error: 'Only a ward admin can send messages.' }, 403)
  }

  // Only the scheduled run creates work. An impatient admin sends what is
  // already queued; they do not get to pull tomorrow's reminders forward.
  let queued = 0
  if (scheduled) {
    const { data, error } = await admin.rpc('queue_due_reminders')
    if (error) return json({ error: `Could not queue reminders: ${error.message}` }, 500)
    queued = (data as number) ?? 0
  }

  // Nothing is sent without credentials, and nothing is discarded either — the
  // rows stay queued and go out once the secrets are set, rather than vanishing
  // into a status nobody looks at.
  if (!configured) {
    return json({
      mode: scheduled ? 'scheduled' : 'on-demand',
      queued,
      sent: 0,
      failed: 0,
      configured: false,
      error: 'Set RESEND_API_KEY and NOTIFICATION_FROM_EMAIL to deliver messages.',
    })
  }

  let query = admin
    .from('notifications')
    .select('id, to_address, subject, body, attempts')
    .eq('status', 'queued')
    .order('created_at')
    .limit(BATCH)

  if (!scheduled) query = query.eq('ward_id', wardId!)

  const { data: rows, error } = await query
  if (error) return json({ error: error.message }, 500)

  let sent = 0
  let failed = 0

  for (const row of (rows ?? []) as NotificationRow[]) {
    try {
      await sendEmail(row)
      await admin
        .from('notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: row.attempts + 1 })
        .eq('id', row.id)
      sent += 1
    } catch (sendError) {
      const attempts = row.attempts + 1
      await admin
        .from('notifications')
        .update({
          // Kept queued for another go until it has clearly stopped working —
          // most delivery failures are a provider having a bad minute, and the
          // next scheduled run is only minutes away.
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          attempts,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        })
        .eq('id', row.id)
      failed += 1
    }
  }

  return json({ mode: scheduled ? 'scheduled' : 'on-demand', queued, sent, failed, configured: true })
})
