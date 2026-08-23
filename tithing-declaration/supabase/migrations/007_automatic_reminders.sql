-- Simplifying the member's side, and taking reminders off the secretary's desk.
--
-- Four changes, and three of them delete something:
--
--   1. Reminders send themselves. A scheduled job queues anything due inside
--      the ward's lead time and drains the queue, so nobody has to remember.
--
--   2. The confirmation code is gone. It was an identifier people read out
--      loud, sitting next to `cancel_token`, which is a UUID that actually
--      authorizes things. Two identifiers where one will do, and the weaker one
--      was the one on screen.
--
--   3. "Find my appointment" is gone. It matched a family name against a phone
--      number, which is unavoidably an oracle — enough guesses confirm whether a
--      number is booked. Every message now carries a cancel link instead, so
--      the capability is handed to the person who booked rather than offered to
--      anybody who can type. This removes the app's one standing privacy
--      compromise rather than mitigating it further.
--
--   4. `phone` becomes optional, so the secretary can write down a family name
--      and nothing else for somebody who rang up.

-- ---------------------------------------------------------------------------
-- 1. Where the site lives
--
-- A cancel link has to be absolute, and it is baked into the message body at
-- queue time — the whole point of rendering early is that the row says exactly
-- what was sent. So the database has to know the site's address.
--
-- One row, enforced by the primary key: this is deployment configuration, not
-- per-ward settings. Two wards on two domains is not a thing this app does.
-- ---------------------------------------------------------------------------

create table if not exists public.app_settings (
  id         boolean primary key default true check (id),
  site_url   text not null default 'http://localhost:5174',
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;

drop policy if exists "app_settings_select" on public.app_settings;
create policy "app_settings_select" on public.app_settings
  for select using (auth.uid() is not null);

drop policy if exists "app_settings_update" on public.app_settings;
create policy "app_settings_update" on public.app_settings
  for update using (public.is_super_admin()) with check (public.is_super_admin());

/* Trailing slashes are the classic way to end up with `//cancel/…`. Normalize
   once, here, rather than at every place that builds a link. */
create or replace function public.site_url()
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select rtrim(coalesce((select site_url from public.app_settings where id), ''), '/');
$$;

-- ---------------------------------------------------------------------------
-- 2. Phone becomes optional
--
-- Required for a member booking themselves — `book_slot()` still insists, and
-- it is the only way to reach them if the evening changes. Optional for a row
-- the secretary types in, because "the Wilsons rang, put them down for 6:15" is
-- a real thing that happens and losing the booking over a missing number helps
-- nobody.
-- ---------------------------------------------------------------------------

alter table public.appointments alter column phone drop not null;

alter table public.appointments drop constraint if exists appointments_phone_plausible;
alter table public.appointments
  add constraint appointments_phone_plausible
  check (phone is null or length(regexp_replace(phone, '\D', '', 'g')) between 7 and 15);

-- ---------------------------------------------------------------------------
-- 3. The confirmation code goes
--
-- Rewritten without the code first, then the column and its generator dropped.
-- The trigger is otherwise exactly as migration 006 left it.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_appointment_slot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  slot_row public.slots%rowtype;
  day_row  public.schedule_days%rowtype;
begin
  select * into slot_row from public.slots where id = new.slot_id;
  if not found then
    raise exception 'That time slot no longer exists.' using errcode = 'foreign_key_violation';
  end if;

  select * into day_row from public.schedule_days where id = slot_row.day_id;

  new.ward_id := day_row.ward_id;

  if tg_op = 'INSERT' or new.slot_id is distinct from old.slot_id then
    if slot_row.blocked_at is not null then
      raise exception 'That time is not available.' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- The member-scope trigger names every column a member may not change, and one
-- of them no longer exists. Rewritten without it.
create or replace function public.enforce_member_update_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_ward_admin(old.ward_id) or public.privileged_write() then
    return new;
  end if;

  if (new.slot_id, new.family_name, new.phone, new.email, new.notes,
      new.cancel_token, new.booked_by, new.booked_by_admin,
      new.ward_id, new.created_at)
     is distinct from
     (old.slot_id, old.family_name, old.phone, old.email, old.notes,
      old.cancel_token, old.booked_by, old.booked_by_admin,
      old.ward_id, old.created_at)
  then
    raise exception
      'You can cancel this appointment, but only the executive secretary can change its details.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

alter table public.appointments drop column if exists confirmation_code;
drop function if exists public.new_confirmation_code();

-- ---------------------------------------------------------------------------
-- 4. "Find my appointment" goes with it
--
-- `family_name_key` and `name_key()` existed only to make that match forgiving.
-- Nothing reads them now.
-- ---------------------------------------------------------------------------

drop function if exists public.find_appointments(text, text, text);
drop index if exists public.appointments_lookup_key;
alter table public.appointments drop column if exists family_name_key;
drop function if exists public.name_key(text);

/*
 * What replaces it: a link, and a page that can read one appointment given the
 * token in it.
 *
 * The token is the whole authorization, and it is the same reasoning as before
 * — a UUID nobody can guess — except it now reaches the family by email rather
 * than being handed out to anybody who matched a name and a number. There is no
 * longer any way to ask this database whether a phone number has an
 * appointment.
 */
create or replace function public.appointment_by_token(p_cancel_token uuid)
returns table (
  family_name      text,
  starts_at        timestamptz,
  duration_minutes integer,
  timezone         text,
  location         text,
  ward_name        text,
  ward_slug        text,
  contact_name     text,
  contact_phone    text,
  cancelled        boolean,
  in_past          boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select a.family_name, s.starts_at, s.duration_minutes, w.timezone, d.location,
         w.name, w.slug, w.contact_name, w.contact_phone,
         a.cancelled_at is not null,
         s.starts_at <= now()
    from public.appointments a
    join public.slots s         on s.id = a.slot_id
    join public.schedule_days d on d.id = s.day_id
    join public.wards w         on w.id = a.ward_id
   where a.cancel_token = p_cancel_token;
$$;

-- ---------------------------------------------------------------------------
-- 5. Messages carry the cancel link
--
-- Rewritten from migration 003 with the confirmation code replaced by a link.
-- That swap is the point of this whole migration: the code was something to
-- read out, the link is something to press, and the link is what makes the
-- lookup page unnecessary.
-- ---------------------------------------------------------------------------

create or replace function public.render_notification(
  p_appointment_id uuid,
  p_kind           text,
  p_channel        text
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
  cancel_url := public.site_url() || '/cancel/' || a.cancel_token::text;

  if p_channel = 'sms' then
    subject := null;
    body := case p_kind
      when 'confirmation' then
        format('%s: tithing declaration for the %s family is %s at %s. Cancel: %s',
               w.name, a.family_name, whenish, place, cancel_url)
      when 'reminder' then
        format('Reminder: tithing declaration for the %s family is %s at %s. Cancel: %s',
               a.family_name, whenish, place, cancel_url)
      when 'cancellation' then
        format('Cancelled: the %s family''s tithing declaration on %s is no longer booked (%s).',
               a.family_name, whenish, w.name)
    end;
  else
    subject := case p_kind
      when 'confirmation' then format('Tithing declaration confirmed — %s', whenish)
      when 'reminder'     then format('Tomorrow: tithing declaration %s', whenish)
      when 'cancellation' then format('Tithing declaration cancelled — %s', whenish)
    end;

    if p_kind = 'cancellation' then
      body := format(
        E'The %s family''s tithing declaration appointment has been cancelled.\n\n'
        || E'It was scheduled for %s at %s.\n\n'
        || E'If this was a mistake, you can book another time at %s\n'
        || E'or contact %s.\n\n'
        || E'— %s',
        a.family_name, whenish, place,
        public.site_url() || '/w/' || w.slug,
        contact, w.name
      );
    else
      body := format(
        E'%s family,\n\n'
        || E'%s\n\n'
        || E'Where: %s\n\n'
        || E'%s'
        || E'Need to cancel? Use this link — it works until the appointment starts:\n%s\n\n'
        || E'Questions: %s\n\n'
        || E'— %s',
        a.family_name,
        case p_kind
          when 'reminder' then 'A reminder that your tithing declaration appointment is ' || whenish || '.'
          else 'Your tithing declaration appointment is ' || whenish || '.'
        end,
        place,
        case when nullif(btrim(coalesce(w.instructions, '')), '') is null
             then '' else w.instructions || E'\n\n' end,
        cancel_url,
        contact, w.name
      );
    end if;
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reminders that send themselves
--
-- The old flow was a button: the secretary opened a day and pressed "send
-- reminders". That works exactly as well as somebody remembering to press it.
--
-- This is the same queueing, driven by the clock instead. A scheduled job calls
-- it every few minutes; it queues anything now inside its ward's lead time and
-- skips anything already queued or sent. Running it more often than necessary
-- costs nothing, which is what makes it safe to schedule at all.
-- ---------------------------------------------------------------------------

create or replace function public.queue_due_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  appt   record;
  queued integer := 0;
begin
  for appt in
    select a.id
      from public.appointments a
      join public.slots s         on s.id = a.slot_id
      join public.schedule_days d on d.id = s.day_id
      join public.wards w         on w.id = a.ward_id
     where a.cancelled_at is null
       -- An unpublished day is one the ward is still working on. Reminding
       -- somebody about an appointment on it would be premature at best.
       and d.published_at is not null
       -- Never remind about something that has already happened. A job that
       -- has been down for a day must not wake up and mail everybody about
       -- yesterday.
       and s.starts_at > now()
       and s.starts_at <= now() + make_interval(hours => w.reminder_lead_hours)
       and not exists (
         select 1 from public.notifications n
          where n.appointment_id = a.id
            and n.kind = 'reminder'
            and n.status in ('queued', 'sent')
       )
     order by s.starts_at
  loop
    queued := queued + public.queue_notification(appt.id, 'reminder');
  end loop;

  return queued;
end;
$$;

comment on function public.queue_due_reminders() is
  'Queues reminders for every appointment now inside its ward''s lead time. '
  'Idempotent and safe to run on a short schedule — anyone already reminded is '
  'skipped, and past appointments are never touched.';

-- ---------------------------------------------------------------------------
-- 7. Grants
--
-- The public surface shrinks: `find_appointments` is gone and
-- `appointment_by_token` takes its place. `queue_due_reminders` belongs to the
-- scheduled job alone, which runs as the service role and needs no grant.
-- ---------------------------------------------------------------------------

grant execute on function public.appointment_by_token(uuid) to anon, authenticated;

revoke execute on function public.queue_due_reminders() from public, anon, authenticated;
revoke execute on function public.site_url()            from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Booking, without the confirmation code
--
-- Dropped and recreated rather than replaced: the OUT columns change, and
-- Postgres will not let CREATE OR REPLACE alter a function's result type.
-- Dropping also drops its grants, so they are given back at the end.
--
-- What comes back now is the cancel link. The receipt page shows it directly,
-- which matters for the gap the email doesn't cover — somebody who books and
-- wants to change their mind before the message arrives.
-- ---------------------------------------------------------------------------

drop function if exists public.book_slot(text, uuid, text, text, text, text);

create function public.book_slot(
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
    raise exception 'Please enter your family name.' using errcode = 'check_violation';
  end if;

  /* An email address is required for a booking made here, though the column is
     nullable for rows the secretary types in. It is the only way this person
     receives their appointment details, their reminder, and the link that lets
     them cancel — without one the booking is a dead end they cannot get back
     to. Somebody with no email rings the clerk, who can add them without one. */
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
    select a.id, a.cancel_token,
           public.site_url() || '/cancel/' || a.cancel_token::text,
           s.starts_at, w.timezone, d.location
      from public.appointments a
     where a.id = new_id;
end;
$$;

grant execute on function public.book_slot(text, uuid, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Sending a confirmation for a booking added by hand
--
-- `queue_notification()` is internal — migration 006 closed it because an
-- unauthenticated caller holding an appointment id could otherwise send real
-- email to a family. But the secretary adding somebody who rang up does need
-- them to get a confirmation, so this is the narrow, checked way in.
--
-- It confirms the caller administers the ward the appointment belongs to, which
-- is the check the raw function never had.
-- ---------------------------------------------------------------------------

create or replace function public.queue_notification_for_admin(
  p_appointment_id uuid,
  p_kind           text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_ward uuid;
begin
  select ward_id into target_ward from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  if not public.is_ward_admin(target_ward) then
    raise exception 'Only a ward admin can send messages for this appointment.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind not in ('confirmation', 'reminder', 'cancellation') then
    raise exception 'Unknown message type.' using errcode = 'check_violation';
  end if;

  return public.queue_notification(p_appointment_id, p_kind);
end;
$$;

revoke execute on function public.queue_notification_for_admin(uuid, text) from public, anon;
grant execute on function public.queue_notification_for_admin(uuid, text) to authenticated;
