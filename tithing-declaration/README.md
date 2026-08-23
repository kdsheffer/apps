# Tithing Declaration

Scheduling for tithing declaration appointments. Members open a link, pick a
time, and give a family name and a phone number — no account, no sign-in. The
executive secretary builds the schedule, sees who's coming, adds people who
phoned in, and sends reminders.

## What shapes the design

Two requirements do most of the work here, and it's worth reading them before
the code:

**Most users are never signed in.** So the app has two surfaces. Everything
leadership touches goes through row-level security in the normal Supabase way.
Everything a member touches goes through a handful of `SECURITY DEFINER`
functions, and `anon` is granted nothing on any table — not a narrowed policy,
nothing. Those functions are the entire public API.

**Nobody may see anybody else's appointment.** This is why the public schedule
is a function rather than a policy. RLS filters rows but cannot hide columns, so
any policy letting a visitor read `appointments` to work out which slots are
taken would also hand them every family name and phone number in the ward. The
function returns free times and nothing else — a booked slot is *absent* rather
than greyed out, so the page carries no information about anyone else's evening.

It is also why there is no "find my appointment" page. Matching a family name
against a phone number is unavoidably an oracle: enough guesses confirm whether
a number is booked. Migration 007 removed it in favour of a cancel link in every
message, which hands the capability to the person who booked instead of offering
it to anybody who can type.

## Features

- **Public booking** — one link per ward (`/w/riverbend-3rd`). Pick a time, give
  a family name, phone number and email, and the details arrive by email. No
  account.
- **Cancel from the email** — every confirmation and reminder carries a link
  that cancels. The token in it is a UUID nobody can guess, so the capability
  goes to the person who booked rather than being offered to anyone who can
  type a phone number.
- **Signed-in members** see their appointment under **My appointment** and can
  cancel it there. A booking made signed out can be claimed onto an account.
- **Slot generation** — three appointments an hour at :00, :15 and :30, with the
  last quarter of each hour left as buffer. Nothing exists at :45.
- **Schedule management** — publish a day when it's ready, block a slot, extend
  an evening, add somebody by hand, cancel a booking, print the roster.
- **Automatic email** — a confirmation on booking, and a reminder the day
  before. Queued in Postgres, delivered by a scheduled Edge Function. Nobody
  presses anything.
- **Bookings by hand** — the secretary can add a family from a name alone, with
  phone and email optional, for somebody who rang up.
- **Roles** — system admin, executive secretary (edit one ward), bishopric
  (read one ward). Enforced by row-level security, not by hidden buttons.
- **Multi-ward** — wards are isolated from each other by RLS.

## Tech stack

React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · Supabase
(Postgres, Auth, Edge Functions) · SMTP

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then run every file in
`supabase/migrations/` in order:

```bash
supabase db push
```

Migration `005` seeds a demo ward — skip it for a real ward.

The migrations are covered by tests that run them against a throwaway Postgres
and check the policies and functions actually behave. See **Testing** below.

### 3. Configure environment

```bash
cp .env.example .env.local
```

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

### 4. Grant yourself access

Sign in once so a `profiles` row is created, then promote yourself in the SQL
editor:

```sql
update profiles set is_super_admin = true where id = '<your-auth-user-id>';
```

From then on **/admin** handles everything: create a ward, and grant each person
Executive secretary or Bishopric on it. There's no invite flow — somebody has to
sign in once before they can be granted anything.

You can't remove your own system admin access. That's deliberate: it's what
stops the last admin locking everyone out.

### 5. Run

```bash
npm run dev
```

The app runs at `http://localhost:5174`.

## Using it

### Setting up an evening

1. **/wards → Open schedule → Add a declaration day.** Give it a date, a
   location, and the hours you'll be there.
2. The times are generated: three an hour at :00, :15 and :30. The end time is
   when the evening *finishes*, so 6:00pm–8:30pm gives a last appointment at
   8:15pm.
3. Block anything you don't want bookable, then **Publish**. Until you publish,
   members can't see the day at all.
4. Copy the booking link and send it round.

### More than one block on a day

A ward often takes declarations in two sittings — before church and again after.
A date holds one `schedule_day`, and that day holds as many blocks of times as
you need.

**Add appointment times** takes as many blocks as you need in one go — press
**+ Add another block** and give each its own start and end. Picking a date that
already has a day switches the form to adding to that day rather than failing on
the duplicate.

Blocks are applied one at a time, and one that fails doesn't stop the rest: the
result says how many times were added and which block was refused. Re-running is
always safe, because the generator only ever adds times that aren't already
there — so a new block never disturbs a booking in an existing one.

### Rules the database enforces

These hold however you come at them, from the app or from the SQL editor:

| | |
| --- | --- |
| One live appointment per slot | A partial unique index, so two people tapping the same time in the same second can't both win |
| A booked slot can't be deleted or blocked | Cancel the appointment first — otherwise the family would arrive to a schedule with no room for them |
| A day with bookings can't be unpublished | Their appointments would still exist while the page said the evening wasn't happening |
| A cancelled appointment can't be reinstated | The slot may already have gone to somebody else; book it again instead |
| `appointments.ward_id` comes from the slot | Not from what the client sent, so a slot id from one ward can't be booked through another |
| A member can cancel their booking, not rewrite it | A trigger, not a column grant — the rule depends on *who* is asking, and the secretary and the member are both `authenticated` |

### What the public form requires, and what the secretary doesn't

A member booking themselves must give a family name, a phone number **and an
email address**. The email isn't a nicety: it carries their appointment details,
their reminder, and the only link that lets them cancel. Without one the booking
is a dead end they can't get back to.

The secretary is under none of that. **Add someone** on a slot takes a family
name alone — phone and email optional — because "the Wilsons rang, put them down
for 6:15" is a real thing and losing the booking over a missing number helps
nobody. A booking with no contact details simply gets no messages; one with an
email gets the same confirmation and reminder as anyone else. Bookings can also
be edited in place from the same screen.

`book_slot()` also refuses a second live booking on a phone number that already
has one. That's the forgetful case rather than an anti-abuse rule — somebody
books, loses the email, books again, and the ward ends up holding two slots for
one family. The secretary isn't subject to it, which is what's needed when a
household genuinely wants two.

## Reminders

Nothing is sent from Postgres or the browser. Messages are rendered into
`notifications` as finished text, and the `dispatch-notifications` Edge Function
delivers them with the service role — a provider API key that reaches a browser
is a provider API key that has been published.

Rendering at queue time rather than send time means the row still says what the
family was told after the appointment is cancelled or somebody fixes a typo in
the ward's name.

Two messages go out, both automatically:

| When | What |
| --- | --- |
| On booking | Confirmation with the time, the place, and a cancel link |
| 24 hours before | Reminder with the same details and the same link |

The lead time is per ward (`wards.reminder_lead_hours`, default 24). A family
booked without an email address — which only the secretary can do — gets
neither, and that is a routine outcome rather than an error.

### 1. Set the site address

**/admin → Site address.** Cancel links are built from this and baked into the
message body, so a wrong value means every link in every email points at the
wrong host. It starts as `http://localhost:5174`; the admin console warns while
it still looks local.

### 2. Deploy the function

The function is a single self-contained file with one remote import, so it can
be pasted straight into the dashboard — no CLI needed.

**Dashboard → Edge Functions → Deploy a new function → via editor.** Name it
exactly `dispatch-notifications` (the app invokes it by name), paste the
contents of `supabase/functions/dispatch-notifications/index.ts`, and deploy.

With the CLI, if you'd rather:

```bash
supabase functions deploy dispatch-notifications
```

### 3. Set up a sender

Delivery is plain **SMTP**, not one provider's API. SMTP is the thing every mail
provider speaks, so switching provider — or moving from a Gmail account to a
real domain later — is five environment variables, not a code change.

#### Gmail (no domain needed)

The path that works without owning anything. Google actually sends the mail, so
SPF and DKIM align properly and reminders land in inboxes — which is *not* true
of the "verify a sender address" tiers at SendGrid, Brevo and Mailjet, where the
mail is signed by their domain while the From says `@gmail.com`. Gmail and Yahoo
penalise that mismatch, and a reminder in spam is worse than no reminder.

1. Create a **dedicated Gmail account** for the ward — say
   `riverbend3rdtithing@gmail.com`. Not a personal one: replies land somewhere
   the secretary can see, it doesn't mix with anyone's own mail, and it hands
   over to the next secretary with the calling.
2. Turn on **2-Step Verification** on that account. App passwords don't exist
   without it.
3. **Google Account → Security → App passwords**, create one for "Mail". You get
   16 characters. Copy them — it's shown once, and it is *not* the account
   password.

Limit is around 500 recipients a day, far more than a ward sends.

#### A real domain, later

If you get one, nothing in the app changes. Point the same five variables at any
provider — Resend's SMTP is `smtp.resend.com`, username `resend`, password your
API key — and delivery moves over.

### 4. Set the secrets

Under **Dashboard → Edge Functions → Secrets**:

| Name | Gmail value |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USERNAME` | `riverbend3rdtithing@gmail.com` |
| `SMTP_PASSWORD` | the 16-character app password |
| `NOTIFICATION_FROM_EMAIL` | `Riverbend 3rd Ward <riverbend3rdtithing@gmail.com>` |

`NOTIFICATION_FROM_EMAIL` must be the same address as `SMTP_USERNAME` — Gmail
rewrites anything else, so a mismatch means members see the raw account address
instead of the ward's name. The `Name <address>` form is what shows in an inbox,
so prefer it over the bare address.

Port 465 is implicit TLS. 587 also works — the function starts plaintext and
upgrades via STARTTLS when the port isn't 465.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically; don't add those yourself.

With the CLI:

```bash
supabase secrets set SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USERNAME=you@gmail.com SMTP_PASSWORD=xxxxxxxxxxxxxxxx NOTIFICATION_FROM_EMAIL="Riverbend 3rd Ward <you@gmail.com>"
```

### 5. Schedule it

**Dashboard → Integrations → Cron → Create job.** Every 15 minutes, type
**Supabase Edge Function**, target `dispatch-notifications`.

```
*/15 * * * *
```

The one thing to get right: the request must carry the **service role key** as
`Authorization: Bearer …`, not the anon or publishable key. That header is what
puts the function into scheduled mode; with the anon key it runs as an on-demand
call with no ward and does nothing. The key is under **Project Settings → API**,
marked secret.

If your scheduler can't set that header, set a `CRON_SECRET` secret on the
function, send it as an `x-cron-secret` header instead, and turn **Verify JWT**
off for the function — otherwise the platform rejects the call before the
function sees it.

A quarter of an hour is plenty of resolution for a 24-hour lead, and running it
more often costs nothing — `queue_due_reminders()` skips anybody already queued
or sent, so extra runs find nothing to do.

The function behaves differently depending on who calls it:

| Caller | What it does |
| --- | --- |
| Service role (the cron job) | Queues everything now due, then delivers across every ward |
| A signed-in ward admin | Delivers what is already queued for their ward, and queues nothing |

That second mode is the **Send now** button on a day — for a confirmation to a
family just added by hand, rather than waiting for the next tick. It cannot pull
tomorrow's reminders forward.

### When delivery isn't set up

With the SMTP secrets unset, the function queues as normal and delivers nothing,
leaving the rows at `queued` rather than discarding them — they go out once the
secrets are added instead of vanishing into a status nobody looks at. The
**Messages** panel on a day shows the queue.

A mail server that can't be reached is treated the same way: everything stays
queued and the function reports the connection error, rather than marking
messages failed over what is usually a transient outage. Individual rejections
*are* recorded against the message and retried up to three times.

### Why email only

SMS was built and then removed (migration `008`). US carriers require
application-sent messages to be registered under **A2P 10DLC** before anything
delivers — days of paperwork, a per-message cost and a monthly number fee, for a
channel email already covers. Rather than leave an adapter sitting there inert
behind a flag nobody had set, it went, and the `channel` column and
`sms_enabled` switch went with it. Adding it back is a migration, and a shorter
one than the migration that removed it.

## Privacy

There is no way to ask this database whether a phone number has an appointment.
The public surface answers two questions — "which times are free" and "what is
the appointment behind this token" — and neither can be turned into a search.

Cancelling needs the `cancel_token`: a UUID, delivered by email to the person
who booked. Anyone they forward that email to can also cancel, which is the same
property a paper appointment card has and the right trade for not making people
remember anything.

Booking is rate limited to six completed bookings an hour from one source, so
one person cannot quietly consume an evening.

## Timezones

Slots are stored as `timestamptz` and generated against the ward's IANA zone, so
an evening either side of a daylight-saving change still starts at 6:00pm on the
clock. Every time shown — on screen and in every message — is rendered in the
ward's zone rather than the reader's, because a member visiting family out of
state would otherwise be told an hour nobody is expecting them.

## Scripts

```bash
npm run dev      # dev server on :5174
npm run build    # typecheck and build to dist/
npm run preview  # serve the production build
npm test         # pure unit tests, no database
```

### Testing the migrations

`supabase/tests/` runs every migration against a throwaway Postgres and asserts
what the policies, triggers and functions actually do — that anon reaches no
table, that a viewer can't write, that two people racing for one slot produce
exactly one booking, that a booked slot can't be deleted. It needs a local
Postgres binary, which is deliberately not an app dependency:

```bash
npm i embedded-postgres pg --prefix /tmp/pgtest
```

```bash
PG_TEST_MODULES=/tmp/pgtest npm run test:db
```

## Deployment

A static build; deploys to Vercel as-is. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` in the project's environment variables, and add
the deployed URL to Supabase's allowed redirect URLs so sign-in works.

The public booking routes (`/w/:slug`) need no session and must keep working
when session lookup fails outright — a member with cookies blocked still has to
be able to book.
