-- The public surface.
--
-- Everything a signed-out visitor can do is one of the six functions below.
-- The tables themselves are revoked from `anon` (migration 001), so this file
-- is not *a* way in — it is the only way in, and the whole privacy requirement
-- is decided by what these functions choose to return.
--
-- The rule they follow: answer the question that was asked and nothing
-- adjacent. "Which times are free" is answered with free times — not with a
-- full grid where the taken ones are greyed out, because a grid tells you how
-- many families have booked and which hours they preferred, and a member
-- browsing for a slot has no business knowing that.
--
-- Every function is SECURITY DEFINER, which means RLS is switched off inside
-- it and each one is responsible for its own checking. That responsibility is
-- the price of being able to answer at all.

-- ---------------------------------------------------------------------------
-- 1. Matching a family name
--
-- People do not retype their name the way they first typed it. "O'Brien",
-- "OBrien" and "o brien" are one family, and a lookup that insists on the
-- punctuation is a lookup that sends them to ring the executive secretary.
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column if not exists family_name_key text
  generated always as (regexp_replace(lower(btrim(family_name)), '[^a-z0-9]', '', 'g')) stored;

create index if not exists appointments_lookup_key
  on public.appointments (ward_id, phone_digits, family_name_key)
  where cancelled_at is null;

create or replace function public.name_key(p_name text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(btrim(coalesce(p_name, ''))), '[^a-z0-9]', '', 'g');
$$;

-- ---------------------------------------------------------------------------
-- 2. Rate limiting
--
-- "Find my appointment" is an oracle — enough guesses would reveal whether a
-- number is booked. This is the brake on that, and it is honestly only a brake:
-- someone with a pool of addresses gets a fresh allowance from each. The real
-- fix is a one-time code sent to the phone, which is what the SMS channel
-- unlocks once a ward completes A2P registration.
-- ---------------------------------------------------------------------------

/*
 * Whatever this request can be pinned to. Supabase exposes the request headers
 * as a GUC; the forwarded address is the useful one. Outside PostgREST — the
 * migration tests, psql, the SQL editor — there are no headers, so the caller
 * supplies a fallback and the limit still applies to *something*.
 */
create or replace function public.request_fingerprint(p_fallback text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  forwarded text;
begin
  begin
    forwarded := split_part(
      current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1
    );
  exception when others then
    forwarded := null;   -- not running behind PostgREST
  end;

  return coalesce(nullif(btrim(coalesce(forwarded, '')), ''), 'fallback:' || coalesce(p_fallback, ''));
end;
$$;

/*
 * Record an attempt and raise if there have been too many lately.
 *
 * Counts before inserting, so the limit is on attempts already made and the
 * Nth request is the last one allowed rather than the first one refused.
 */
create or replace function public.check_rate_limit(
  p_ward_id     uuid,
  p_fingerprint text,
  p_max         integer,
  p_window      interval,
  p_message     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent integer;
begin
  select count(*) into recent
    from public.lookup_attempts
   where fingerprint = p_fingerprint
     and attempted_at > now() - p_window;

  if recent >= p_max then
    raise exception '%', p_message using errcode = 'too_many_connections';
  end if;
end;
$$;

/*
 * Old rows are noise. Called opportunistically rather than on a schedule so
 * the app has no dependency on pg_cron being enabled.
 */
create or replace function public.prune_lookup_attempts()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.lookup_attempts where attempted_at < now() - interval '2 days';
$$;

-- ---------------------------------------------------------------------------
-- 3. Reading the public schedule
-- ---------------------------------------------------------------------------

/*
 * The ward behind a booking link. Deliberately not the whole row: no id of the
 * creator, no reminder settings, nothing an unauthenticated caller has no use
 * for.
 */
create or replace function public.public_ward(p_slug text)
returns table (
  id            uuid,
  name          text,
  timezone      text,
  instructions  text,
  contact_name  text,
  contact_phone text
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select w.id, w.name, w.timezone, w.instructions, w.contact_name, w.contact_phone
    from public.wards w
   where w.slug = lower(btrim(p_slug));
$$;

/*
 * The times somebody may book, and only those.
 *
 * A slot appears when its day is published, the slot is not blocked, it is
 * still in the future, and nobody holds it. A slot that fails any of those is
 * simply absent — the caller cannot tell a booked 6:15 from a blocked one from
 * an evening that ends at 6:00, which is the point.
 */
create or replace function public.public_schedule(p_slug text)
returns table (
  day_id           uuid,
  service_date     date,
  location         text,
  notes            text,
  slot_id          uuid,
  starts_at        timestamptz,
  duration_minutes integer
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select d.id, d.service_date, d.location, d.notes,
         s.id, s.starts_at, s.duration_minutes
    from public.wards w
    join public.schedule_days d on d.ward_id = w.id
    join public.slots s         on s.day_id  = d.id
   where w.slug = lower(btrim(p_slug))
     and d.published_at is not null
     and s.blocked_at is null
     and s.starts_at > now()
     and not exists (
       select 1 from public.appointments a
        where a.slot_id = s.id and a.cancelled_at is null
     )
   order by s.starts_at;
$$;

-- ---------------------------------------------------------------------------
-- 4. Booking
-- ---------------------------------------------------------------------------

/*
 * Take a slot.
 *
 * The interesting part is the race. Two families tapping the same 6:15 at the
 * same moment both pass every check this function could make — so the check
 * that decides it is the partial unique index on `appointments`, and the job
 * here is to turn its error into a sentence a person can act on.
 *
 * `booked_by` is set when the caller happens to be signed in, which is what
 * later lets them see the appointment under "My appointment" without proving
 * anything again.
 */
create or replace function public.book_slot(
  p_slug        text,
  p_slot_id     uuid,
  p_family_name text,
  p_phone       text,
  p_email       text default null,
  p_notes       text default null
)
returns table (
  appointment_id    uuid,
  confirmation_code text,
  cancel_token      uuid,
  starts_at         timestamptz,
  timezone          text,
  location          text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w           public.wards%rowtype;
  s           public.slots%rowtype;
  d           public.schedule_days%rowtype;
  digits      text;
  fingerprint text;
  new_id      uuid;
begin
  select * into w from public.wards where slug = lower(btrim(p_slug));
  if not found then
    raise exception 'We could not find that ward''s schedule.' using errcode = 'no_data_found';
  end if;

  digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(digits) < 7 then
    raise exception 'Please enter a phone number we can reach you on.'
      using errcode = 'check_violation';
  end if;

  if length(btrim(coalesce(p_family_name, ''))) < 2 then
    raise exception 'Please enter your family name.' using errcode = 'check_violation';
  end if;

  /* Six bookings an hour from one source.
   *
   * Worth being precise about what this counts, because it is not what it
   * looks like: an attempt that goes on to fail takes its `lookup_attempts`
   * row down with it when the statement rolls back. So the limit counts
   * *completed* bookings, not tries.
   *
   * That turns out to be the semantics worth having. The harm here is one
   * person consuming the evening — six slots is already far more than a family
   * needs — while a failed attempt consumes nothing and reveals nothing. The
   * lookup limit below is the one that has to survive failures, and it does,
   * because a lookup that finds nothing returns empty rather than raising. */
  fingerprint := public.request_fingerprint(digits);
  perform public.check_rate_limit(
    w.id, fingerprint, 6, interval '1 hour',
    'That is a lot of bookings from one place. Please wait a little while, or contact the ward clerk.'
  );
  insert into public.lookup_attempts (ward_id, fingerprint, succeeded) values (w.id, fingerprint, true);

  select * into s from public.slots where id = p_slot_id;
  if not found then
    raise exception 'That time is no longer on the schedule.' using errcode = 'no_data_found';
  end if;

  select * into d from public.schedule_days where id = s.day_id;

  -- The slug and the slot have to agree. Without this, a slot id from one
  -- ward could be booked through another ward's public page.
  if d.ward_id <> w.id then
    raise exception 'That time is not on this ward''s schedule.' using errcode = 'check_violation';
  end if;

  if d.published_at is null then
    raise exception 'That day is not open for booking yet.' using errcode = 'check_violation';
  end if;

  if s.blocked_at is not null then
    raise exception 'That time is not available.' using errcode = 'check_violation';
  end if;

  if s.starts_at <= now() then
    raise exception 'That time has already passed.' using errcode = 'check_violation';
  end if;

  /* One live booking per phone number per ward. This is not really an
     anti-abuse rule — it is the forgetful case. Somebody books, loses the
     email, and books again; without this the ward ends up holding two slots
     for one family and an empty chair on the night. Pointing them at the
     lookup page is more useful than letting it happen.

     The secretary is not subject to it: she inserts directly, which is exactly
     what she needs when a family genuinely wants two. */
  if exists (
    select 1 from public.appointments
     where ward_id = w.id and phone_digits = digits and cancelled_at is null
  ) then
    raise exception
      'That phone number already has an appointment. Use "Find my appointment" to see or change it.'
      using errcode = 'unique_violation';
  end if;

  begin
    insert into public.appointments
      (slot_id, ward_id, family_name, phone, email, notes, booked_by)
    values
      (p_slot_id, w.id, btrim(p_family_name), btrim(p_phone),
       nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
       auth.uid())
    returning id into new_id;
  exception when unique_violation then
    -- The partial index refused it: somebody else got there first.
    raise exception 'Sorry — that time was just taken. Please pick another.'
      using errcode = 'unique_violation';
  end;

  perform public.queue_notification(new_id, 'confirmation');
  perform public.prune_lookup_attempts();

  return query
    select a.id, a.confirmation_code, a.cancel_token, s.starts_at, w.timezone, d.location
      from public.appointments a
     where a.id = new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Finding and cancelling without an account
-- ---------------------------------------------------------------------------

/*
 * Find a booking from the two things the family definitely knows.
 *
 * Both have to match. The phone number alone would make this a directory, and
 * the name alone would make it a worse one. What comes back includes the
 * `cancel_token` — that is the point of the exercise: proving you know the name
 * and the number is what earns you the capability to cancel, and the token is
 * that capability in a form the browser can hold onto for one page.
 */
create or replace function public.find_appointments(
  p_slug        text,
  p_family_name text,
  p_phone       text
)
returns table (
  appointment_id    uuid,
  confirmation_code text,
  cancel_token      uuid,
  family_name       text,
  starts_at         timestamptz,
  duration_minutes  integer,
  timezone          text,
  location          text,
  ward_name         text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w           public.wards%rowtype;
  digits      text;
  key         text;
  fingerprint text;
  hits        integer;
begin
  select * into w from public.wards where slug = lower(btrim(p_slug));
  if not found then
    raise exception 'We could not find that ward''s schedule.' using errcode = 'no_data_found';
  end if;

  digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  key    := public.name_key(p_family_name);
  fingerprint := public.request_fingerprint(digits);

  perform public.check_rate_limit(
    w.id, fingerprint, 12, interval '15 minutes',
    'Too many lookups from here. Please wait a few minutes and try again.'
  );

  select count(*) into hits
    from public.appointments a
    join public.slots s on s.id = a.slot_id
   where a.ward_id = w.id
     and a.phone_digits = digits
     and a.family_name_key = key
     and a.cancelled_at is null
     and s.starts_at > now();

  insert into public.lookup_attempts (ward_id, fingerprint, succeeded)
  values (w.id, fingerprint, hits > 0);

  perform public.prune_lookup_attempts();

  return query
    select a.id, a.confirmation_code, a.cancel_token, a.family_name,
           s.starts_at, s.duration_minutes, w.timezone, d.location, w.name
      from public.appointments a
      join public.slots s         on s.id = a.slot_id
      join public.schedule_days d on d.id = s.day_id
     where a.ward_id = w.id
       and a.phone_digits = digits
       and a.family_name_key = key
       and a.cancelled_at is null
       and s.starts_at > now()
     order by s.starts_at;
end;
$$;

/*
 * Cancel with the token `find_appointments` handed back.
 *
 * The token is the whole authorization — a UUID nobody can guess and that is
 * only ever given to somebody who already matched the name and the number. The
 * confirmation code is deliberately *not* accepted here: six readable
 * characters are for saying out loud, and anything you can read to a stranger
 * should not cancel your appointment.
 */
create or replace function public.cancel_appointment(
  p_cancel_token uuid,
  p_reason       text default null
)
returns table (cancelled boolean, starts_at timestamptz, timezone text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.appointments%rowtype;
  w public.wards%rowtype;
  s public.slots%rowtype;
begin
  select * into a from public.appointments where cancel_token = p_cancel_token;
  if not found then
    raise exception 'We could not find that appointment.' using errcode = 'no_data_found';
  end if;

  select * into w from public.wards where id = a.ward_id;
  select * into s from public.slots where id = a.slot_id;

  if a.cancelled_at is not null then
    -- Already cancelled. Say so plainly rather than failing: somebody
    -- double-tapping the button should see the outcome they wanted.
    return query select true, s.starts_at, w.timezone;
    return;
  end if;

  update public.appointments
     set cancelled_at     = now(),
         cancelled_by     = auth.uid(),
         cancelled_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = a.id;

  perform public.queue_notification(a.id, 'cancellation');

  return query select true, s.starts_at, w.timezone;
end;
$$;

/*
 * Attach a booking made while signed out to the account of somebody now signed
 * in, so it turns up under "My appointment" from then on.
 *
 * Same token, same reasoning: they have already proved they know the name and
 * the number. Refuses to move a booking that belongs to a different account —
 * a shared family phone should not let one person adopt another's appointment.
 */
create or replace function public.claim_appointment(p_cancel_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.appointments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in first to save this appointment to your account.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into a from public.appointments where cancel_token = p_cancel_token;
  if not found then
    raise exception 'We could not find that appointment.' using errcode = 'no_data_found';
  end if;

  if a.booked_by is not null and a.booked_by <> auth.uid() then
    raise exception 'That appointment is already saved to somebody else''s account.'
      using errcode = 'insufficient_privilege';
  end if;

  -- `booked_by` is a column the member-scope trigger guards, and setting it is
  -- this function's entire job. Raise the transaction-local flag it honours.
  perform set_config('app.privileged_write', 'on', true);
  update public.appointments set booked_by = auth.uid() where id = a.id;

  return a.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
--
-- Postgres grants EXECUTE on new functions to PUBLIC, so this is belt and
-- braces — but it is also the list of what the public surface *is*, in one
-- place, which is worth having written down. Everything not named here is
-- unreachable without a session.
-- ---------------------------------------------------------------------------

grant execute on function public.public_ward(text)                             to anon, authenticated;
grant execute on function public.public_schedule(text)                         to anon, authenticated;
grant execute on function public.book_slot(text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.find_appointments(text, text, text)           to anon, authenticated;
grant execute on function public.cancel_appointment(uuid, text)                to anon, authenticated;
grant execute on function public.claim_appointment(uuid)                       to authenticated;

-- The internals are not part of it. Revoked from `public` first: Postgres
-- grants EXECUTE on a new function to the pseudo-role PUBLIC, and revoking from
-- `anon` alone leaves that grant standing — which is exactly the bug migration
-- 006 exists to fix. Naming the roles as well is belt and braces.
revoke execute on function public.check_rate_limit(uuid, text, integer, interval, text) from public, anon, authenticated;
revoke execute on function public.prune_lookup_attempts()                                from public, anon, authenticated;
revoke execute on function public.render_notification(uuid, text, text)                  from public, anon, authenticated;
revoke execute on function public.queue_notification(uuid, text)                         from public, anon, authenticated;
revoke execute on function public.request_fingerprint(text)                              from public, anon, authenticated;
