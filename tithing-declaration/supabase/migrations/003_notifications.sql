-- Reminders and confirmations.
--
-- Nothing here sends anything. Postgres cannot make an HTTP request, and the
-- browser must not hold a provider's API key, so every message is written to
-- `notifications` as a fully rendered row and the `dispatch-notifications` Edge
-- Function delivers it with the service role.
--
-- Rendering at queue time rather than at send time is what makes the table
-- worth having. The row says exactly what the family was told, and keeps saying
-- it after the appointment is cancelled, the slot is deleted, or somebody fixes
-- a typo in the ward's name.
--
-- Email is the channel that works today. SMS is written throughout and stays
-- inert until a ward turns it on — see the note on `wards.sms_enabled`.

-- ---------------------------------------------------------------------------
-- 1. Per-ward notification settings
-- ---------------------------------------------------------------------------

/*
 * Why SMS is off by default, and is a per-ward switch rather than a global one:
 *
 * US carriers require application-to-person SMS to be registered under A2P
 * 10DLC before anything will deliver. Registration is per Twilio account and
 * takes days. A ward that hasn't done it must not queue SMS rows — they would
 * every one of them fail, and the failures would look like a broken app rather
 * than paperwork nobody has filed yet.
 */
alter table public.wards
  add column if not exists sms_enabled boolean not null default false;

/*
 * How far ahead the "send reminders" button reaches. A day earlier is the
 * usual choice; a ward that declares on a weeknight may want two.
 */
alter table public.wards
  add column if not exists reminder_lead_hours integer not null default 24;

do $$
begin
  alter table public.wards
    add constraint wards_reminder_lead_sane check (reminder_lead_hours between 1 and 336);
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Rendering
-- ---------------------------------------------------------------------------

/*
 * An appointment time as the family would say it: "Sunday, October 12 at
 * 6:15 PM". Always in the ward's timezone, never the reader's — the message may
 * be read on a phone that has travelled, and the interview has not.
 */
create or replace function public.format_slot_local(p_starts_at timestamptz, p_timezone text)
returns text
language sql
immutable
as $$
  select to_char(p_starts_at at time zone p_timezone, 'FMDay, FMMonth FMDD "at" FMHH12:MI AM');
$$;

/*
 * Build the message for one appointment.
 *
 * SMS and email get different bodies from the same facts: a text message is
 * read on a lock screen and should be one sentence, while an email can carry
 * the location, the confirmation code and how to cancel. `channel` picks
 * between them; everything else is shared.
 */
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
  a       public.appointments%rowtype;
  s       public.slots%rowtype;
  d       public.schedule_days%rowtype;
  w       public.wards%rowtype;
  whenish text;
  place   text;
  contact text;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  select * into s from public.slots         where id = a.slot_id;
  select * into d from public.schedule_days where id = s.day_id;
  select * into w from public.wards         where id = a.ward_id;

  whenish := public.format_slot_local(s.starts_at, w.timezone);
  place   := coalesce(nullif(btrim(d.location), ''), 'the meetinghouse');
  contact := coalesce(
    nullif(btrim(coalesce(w.contact_name, '') || ' ' || coalesce(w.contact_phone, '')), ''),
    'the ward clerk'
  );

  if p_channel = 'sms' then
    subject := null;
    body := case p_kind
      when 'confirmation' then
        format('%s: tithing declaration for the %s family is %s at %s. Reply is not monitored — call %s to change it.',
               w.name, a.family_name, whenish, place,
               coalesce(w.contact_phone, 'the ward clerk'))
      when 'reminder' then
        format('Reminder: tithing declaration for the %s family is %s at %s (%s).',
               a.family_name, whenish, place, w.name)
      when 'cancellation' then
        format('Cancelled: the %s family''s tithing declaration on %s is no longer booked (%s).',
               a.family_name, whenish, w.name)
    end;
  else
    subject := case p_kind
      when 'confirmation' then format('Tithing declaration confirmed — %s', whenish)
      when 'reminder'     then format('Reminder: tithing declaration %s', whenish)
      when 'cancellation' then format('Tithing declaration cancelled — %s', whenish)
    end;

    -- Concatenated with an explicit `||`. Postgres joins two plain string
    -- constants separated by a newline on its own, but not once one of them is
    -- an E'' literal — and every line carrying a newline escape has to be one.
    if p_kind = 'cancellation' then
      body := format(
        E'The %s family''s tithing declaration appointment has been cancelled.\n\n'
        || E'It was scheduled for %s at %s.\n\n'
        || E'If this was a mistake, you can book another time on the ward''s '
        || E'scheduling page, or contact %s.\n\n'
        || E'— %s',
        a.family_name, whenish, place, contact, w.name
      );
    else
      body := format(
        E'%s family,\n\n'
        || E'Your tithing declaration appointment is %s at %s.\n\n'
        || E'Confirmation code: %s\n\n'
        || E'%s'
        || E'If you need to change or cancel it, use the ward''s scheduling page, '
        || E'or contact %s.\n\n'
        || E'— %s',
        a.family_name, whenish, place, a.confirmation_code,
        -- The ward's own instructions, as their own paragraph, or nothing at all.
        case when nullif(btrim(coalesce(w.instructions, '')), '') is null
             then '' else w.instructions || E'\n\n' end,
        contact, w.name
      );
    end if;
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Queueing
-- ---------------------------------------------------------------------------

/*
 * Queue one appointment's message on every channel that can carry it.
 *
 * Silent about channels it can't use: a family that gave no email address just
 * doesn't get the email. That's a routine outcome, not an error — plenty of
 * people will book with a phone number alone, and a booking must never fail
 * because a reminder couldn't be addressed.
 *
 * Returns how many rows it queued, so a caller can tell "sent nothing because
 * there was nowhere to send it" from "sent something".
 */
create or replace function public.queue_notification(
  p_appointment_id uuid,
  p_kind           text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a       public.appointments%rowtype;
  w       public.wards%rowtype;
  msg     record;
  queued  integer := 0;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  select * into w from public.wards where id = a.ward_id;

  if a.email is not null then
    select * into msg from public.render_notification(p_appointment_id, p_kind, 'email');
    insert into public.notifications
      (ward_id, appointment_id, channel, kind, to_address, subject, body, requested_by)
    values
      (a.ward_id, a.id, 'email', p_kind, a.email, msg.subject, msg.body, auth.uid());
    queued := queued + 1;
  end if;

  if w.sms_enabled and a.phone_digits is not null then
    select * into msg from public.render_notification(p_appointment_id, p_kind, 'sms');
    insert into public.notifications
      (ward_id, appointment_id, channel, kind, to_address, subject, body, requested_by)
    values
      (a.ward_id, a.id, 'sms', p_kind, a.phone, msg.subject, msg.body, auth.uid());
    queued := queued + 1;
  end if;

  return queued;
end;
$$;

/*
 * The "send reminders" button: queue a reminder for everybody still booked on
 * one day.
 *
 * Skips anybody who already has a reminder queued or sent for that appointment.
 * The secretary will press this twice — once because she isn't sure it worked,
 * once because somebody asked — and neither press should text a family at
 * eleven at night for the second time.
 */
create or replace function public.queue_day_reminders(p_day_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_row public.schedule_days%rowtype;
  appt    record;
  queued  integer := 0;
begin
  select * into day_row from public.schedule_days where id = p_day_id;
  if not found then
    raise exception 'That day does not exist.' using errcode = 'no_data_found';
  end if;

  if not public.is_ward_admin(day_row.ward_id) then
    raise exception 'Only a ward admin can send reminders.'
      using errcode = 'insufficient_privilege';
  end if;

  for appt in
    select a.id
      from public.appointments a
      join public.slots s on s.id = a.slot_id
     where s.day_id = p_day_id
       and a.cancelled_at is null
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

comment on function public.queue_day_reminders(uuid) is
  'Queues a reminder for every live appointment on a day, skipping anyone who '
  'already has one queued or sent. Safe to press twice.';
