-- Moving an appointment instead of cancelling and rebooking.
--
-- "Can you come at seven instead?" is the most common thing that happens to a
-- booking after it exists, and until now the only answer was to cancel and book
-- again. That loses the appointment's identity — and with it the cancel token
-- in the member's inbox, so the link in their confirmation would stop working
-- and the new booking would have a link they had never been sent.
--
-- Moving keeps the row. The token stays valid, the link in every message
-- already delivered keeps working, and the member is told the time changed.

-- ---------------------------------------------------------------------------
-- 0. One place that knows the link
--
-- The token's page stops being "/cancel" here, because cancelling is no longer
-- all it does. Two callers build that URL — `book_slot` for the receipt and
-- `render_notification` for every message — and a path that lives in two places
-- is a path that eventually differs between them.
-- ---------------------------------------------------------------------------

create or replace function public.appointment_url(p_cancel_token uuid)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.site_url() || '/appointment/' || p_cancel_token::text;
$$;

revoke execute on function public.appointment_url(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. A message for it
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('confirmation', 'reminder', 'cancellation', 'reschedule'));

create or replace function public.render_notification(
  p_appointment_id uuid,
  p_kind           text
)
returns table (subject text, body text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a          public.appointments%rowtype;
  s          public.slots%rowtype;
  d          public.schedule_days%rowtype;
  w          public.wards%rowtype;
  whenish    text;
  place      text;
  contact    text;
  cancel_url text;
  opening    text;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  select * into s from public.slots         where id = a.slot_id;
  select * into d from public.schedule_days where id = s.day_id;
  select * into w from public.wards         where id = a.ward_id;

  whenish    := public.format_slot_local(s.starts_at, w.timezone);
  place      := coalesce(nullif(btrim(d.location), ''), 'the meetinghouse');
  contact    := coalesce(
    nullif(btrim(coalesce(w.contact_name, '') || ' ' || coalesce(w.contact_phone, '')), ''),
    'the ward clerk'
  );
  cancel_url := public.site_url() || '/appointment/' || a.cancel_token::text;

  subject := case p_kind
    when 'confirmation' then format('Tithing declaration confirmed — %s', whenish)
    when 'reminder'     then format('Tomorrow: tithing declaration %s', whenish)
    when 'reschedule'   then format('Tithing declaration moved — %s', whenish)
    when 'cancellation' then format('Tithing declaration cancelled — %s', whenish)
  end;

  if p_kind = 'cancellation' then
    body := format(
      E'The tithing declaration appointment for %s has been cancelled.\n\n'
      || E'It was scheduled for %s at %s.\n\n'
      || E'If this was a mistake, you can book another time at %s\n'
      || E'or contact %s.\n\n'
      || E'— %s',
      a.family_name, whenish, place,
      public.site_url() || '/w/' || w.slug,
      contact, w.name
    );
  else
    /* The three surviving kinds differ by one sentence. Splitting them into
       three templates would mean the same address, instructions and link
       maintained in triplicate — and the version that drifts is always the one
       nobody was looking at. */
    opening := case p_kind
      when 'reminder'   then 'A reminder that your tithing declaration appointment is ' || whenish || '.'
      when 'reschedule' then 'Your tithing declaration appointment has moved. It is now ' || whenish || '.'
      else 'Your tithing declaration appointment is ' || whenish || '.'
    end;

    body := format(
      E'Hello %s,\n\n'
      || E'%s\n\n'
      || E'Where: %s\n\n'
      || E'%s'
      || E'Need to change or cancel it? Use this link — it works until the appointment starts:\n%s\n\n'
      || E'Questions: %s\n\n'
      || E'— %s',
      a.family_name, opening, place,
      case when nullif(btrim(coalesce(w.instructions, '')), '') is null
           then '' else w.instructions || E'\n\n' end,
      cancel_url, contact, w.name
    );
  end if;

  return next;
end;
$$;

revoke execute on function public.render_notification(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Moving it
--
-- The same token that cancels. Somebody who can call this off can equally move
-- it, and forcing them through cancel-then-rebook only risks losing the slot to
-- somebody else in between.
-- ---------------------------------------------------------------------------

create or replace function public.reschedule_appointment(
  p_cancel_token uuid,
  p_new_slot_id  uuid
)
returns table (starts_at timestamptz, timezone text, location text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.appointments%rowtype;
  s public.slots%rowtype;
  d public.schedule_days%rowtype;
  w public.wards%rowtype;
begin
  select * into a from public.appointments where cancel_token = p_cancel_token;
  if not found then
    raise exception 'We could not find that appointment.' using errcode = 'no_data_found';
  end if;

  if a.cancelled_at is not null then
    raise exception 'That appointment was cancelled. Book a new time instead.'
      using errcode = 'check_violation';
  end if;

  select * into s from public.slots where id = p_new_slot_id;
  if not found then
    raise exception 'That time is no longer on the schedule.' using errcode = 'no_data_found';
  end if;

  select * into d from public.schedule_days where id = s.day_id;
  select * into w from public.wards         where id = a.ward_id;

  -- Same ward. Without this a slot id from another ward would move somebody
  -- onto a schedule nobody is expecting them at.
  if d.ward_id <> a.ward_id then
    raise exception 'That time is not on this ward''s schedule.' using errcode = 'check_violation';
  end if;

  if p_new_slot_id = a.slot_id then
    -- Already there. Say so rather than sending a "moved" message about a
    -- move that did not happen.
    return query select s.starts_at, w.timezone, d.location;
    return;
  end if;

  if d.published_at is null then
    raise exception 'That day is not open for booking.' using errcode = 'check_violation';
  end if;
  if s.blocked_at is not null then
    raise exception 'That time is not available.' using errcode = 'check_violation';
  end if;
  if s.starts_at <= now() then
    raise exception 'That time has already passed.' using errcode = 'check_violation';
  end if;

  /* `slot_id` is one of the columns a member may not change directly — the
     member-scope trigger guards it, and moving an appointment is precisely what
     this function exists to do. Same transaction-local flag `claim_appointment`
     uses. */
  perform set_config('app.privileged_write', 'on', true);

  begin
    update public.appointments set slot_id = p_new_slot_id where id = a.id;
  exception when unique_violation then
    -- The partial index refused it: somebody took that time in between.
    raise exception 'Sorry — that time was just taken. Please pick another.'
      using errcode = 'unique_violation';
  end;

  /* A reminder already queued or sent was about the old time. Setting it aside
     lets `queue_due_reminders` treat this appointment as un-reminded, so a
     fresh one goes out for the new time — otherwise moving to a later day would
     silently cost the member their reminder. */
  update public.notifications
     set status = 'skipped',
         error  = 'The appointment moved; superseded by the new time.'
   where appointment_id = a.id
     and kind = 'reminder'
     and status in ('queued', 'sending', 'sent');

  perform public.queue_notification(a.id, 'reschedule');

  return query select s.starts_at, w.timezone, d.location;
end;
$$;

comment on function public.reschedule_appointment(uuid, uuid) is
  'Moves an appointment to another slot in the same ward, keeping its identity '
  'and cancel token so links already emailed keep working.';

grant execute on function public.reschedule_appointment(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The receipt links to the same page
--
-- Redefined only to route its link through `appointment_url`. Everything else
-- is migration 007's `book_slot` unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.book_slot(
  p_slug        text,
  p_slot_id     uuid,
  p_family_name text,
  p_phone       text,
  p_email       text default null,
  p_notes       text default null
)
returns table (
  appointment_id uuid,
  cancel_token   uuid,
  cancel_url     text,
  starts_at      timestamptz,
  timezone       text,
  location       text
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
    raise exception 'Please enter a name.' using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'Please enter an email address so we can send your appointment details.'
      using errcode = 'check_violation';
  end if;

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

  if exists (
    select 1 from public.appointments
     where ward_id = w.id and phone_digits = digits and cancelled_at is null
  ) then
    raise exception
      'That phone number already has an appointment. Check your email for the details, or contact the ward clerk.'
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
    raise exception 'Sorry — that time was just taken. Please pick another.'
      using errcode = 'unique_violation';
  end;

  perform public.queue_notification(new_id, 'confirmation');
  perform public.prune_lookup_attempts();

  return query
    select a.id, a.cancel_token, public.appointment_url(a.cancel_token),
           s.starts_at, w.timezone, d.location
      from public.appointments a
     where a.id = new_id;
end;
$$;

grant execute on function public.book_slot(text, uuid, text, text, text, text) to anon, authenticated;
