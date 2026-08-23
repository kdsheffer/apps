-- Dropping SMS.
--
-- It was written throughout and never turned on: US carriers require A2P 10DLC
-- registration before application SMS delivers, which is days of paperwork for
-- a channel email already covers. Rather than leave the adapter sitting there
-- inert, it goes.
--
-- The generality goes with it. A `channel` column with one legal value and a
-- `sms_enabled` flag nobody sets are not flexibility — they are two things
-- every reader has to understand before they can conclude neither matters.
-- Adding SMS back later is a migration, and a shorter one than this.

-- ---------------------------------------------------------------------------
-- 1. Nothing is queued for a channel that no longer exists
--
-- There should be none — `sms_enabled` defaults to false and nothing in the app
-- ever set it — but a row left behind would be undeliverable and permanently
-- stuck at `queued`, which is exactly the sort of thing that gets noticed
-- months later.
-- ---------------------------------------------------------------------------

update public.notifications
   set status = 'skipped',
       error  = 'SMS was removed from this app before this message was sent.'
 where channel = 'sms' and status = 'queued';

-- ---------------------------------------------------------------------------
-- 2. The column and the switch go
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_channel_check;
alter table public.notifications drop column if exists channel;

alter table public.wards drop column if exists sms_enabled;

comment on table public.notifications is
  'Messages rendered at queue time and delivered by the dispatch-notifications '
  'Edge Function. Email only.';

-- ---------------------------------------------------------------------------
-- 3. Rendering, without the branch
--
-- Dropped and recreated because the signature loses its channel argument.
-- Dropping also drops the revoke migration 006 put on it, so it is reapplied at
-- the end — this function reads a family's name, appointment time and cancel
-- link out of one appointment id, and must not be callable by anybody.
-- ---------------------------------------------------------------------------

drop function if exists public.render_notification(uuid, text, text);

create function public.render_notification(
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

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Queueing, without the loop over channels
--
-- Still silent about a family it cannot write to. A booking the secretary typed
-- in from a name alone has no email address, and that is a routine outcome — it
-- must never be an error, and it must never stop the booking.
-- ---------------------------------------------------------------------------

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
  a   public.appointments%rowtype;
  msg record;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  if a.email is null then
    return 0;
  end if;

  select * into msg from public.render_notification(p_appointment_id, p_kind);

  insert into public.notifications
    (ward_id, appointment_id, kind, to_address, subject, body, requested_by)
  values
    (a.ward_id, a.id, p_kind, a.email, msg.subject, msg.body, auth.uid());

  return 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
--
-- `render_notification` was dropped and recreated, so it has a fresh grant to
-- PUBLIC that has to come off again. This is the same trap migration 006 was
-- written to fix, and `functions.test.mjs` is what catches it.
-- ---------------------------------------------------------------------------

revoke execute on function public.render_notification(uuid, text) from public, anon, authenticated;
revoke execute on function public.queue_notification(uuid, text)  from public, anon, authenticated;
