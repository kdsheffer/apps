-- Making "send once" true rather than merely likely.
--
-- The dispatcher selected every row with status 'queued', sent them, and marked
-- them 'sent' afterwards. Between the select and the update there is a window,
-- and anything else running in that window sees the same rows as still queued.
--
-- That window is not hypothetical. The clerk's cancel button nudges the
-- dispatcher directly, and the cron job fires every fifteen minutes; a
-- cancellation at the wrong moment has both of them holding the same message.
-- The family gets it twice.
--
-- The fix is to claim rows atomically instead of reading them. `claim_notifications`
-- flips a batch to 'sending' and returns it in one statement, and
-- `for update skip locked` means a second caller running at the same instant
-- takes different rows rather than waiting for the first or duplicating it.

-- ---------------------------------------------------------------------------
-- 1. A status for "in flight"
--
-- Without it there is nowhere to record that a message has been picked up but
-- not yet delivered — which is the entire state the race happens in.
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_status_check;
alter table public.notifications
  add constraint notifications_status_check
  check (status in ('queued', 'sending', 'sent', 'failed', 'skipped'));

alter table public.notifications add column if not exists claimed_at timestamptz;

comment on column public.notifications.claimed_at is
  'When a dispatcher took this message. Used to recover rows left in "sending" '
  'by a run that died mid-flight.';

-- ---------------------------------------------------------------------------
-- 2. Claiming
--
-- The `skip locked` is what makes concurrent dispatchers safe: each takes rows
-- the other has not, rather than blocking or overlapping.
--
-- `attempts` is incremented here, at claim time, rather than after the send.
-- A run that dies between claiming and updating would otherwise leave a message
-- that gets retried forever; counting the attempt when it is taken means even a
-- crash loop terminates at MAX_ATTEMPTS.
--
-- A row stuck in 'sending' is reclaimed after ten minutes. Nothing else can
-- rescue it: the process that owned it is gone, and it holds no lock once its
-- transaction ended.
-- ---------------------------------------------------------------------------

create or replace function public.claim_notifications(
  p_ward_id        uuid default null,
  p_appointment_id uuid default null,
  p_limit          integer default 50
)
returns table (
  id         uuid,
  to_address text,
  subject    text,
  body       text,
  attempts   integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.notifications n
     set status     = 'sending',
         attempts   = n.attempts + 1,
         claimed_at = now()
   where n.id in (
     select c.id
       from public.notifications c
      where (
              c.status = 'queued'
              -- Left behind by a dispatcher that died holding it.
              or (c.status = 'sending' and c.claimed_at < now() - interval '10 minutes')
            )
        and (p_ward_id is null or c.ward_id = p_ward_id)
        and (p_appointment_id is null or c.appointment_id = p_appointment_id)
      order by c.created_at
      for update skip locked
      limit p_limit
   )
  returning n.id, n.to_address, n.subject, n.body, n.attempts;
end;
$$;

comment on function public.claim_notifications(uuid, uuid, integer) is
  'Atomically takes a batch of messages for delivery. Two dispatchers running '
  'at once take disjoint batches, which is what makes send-once true.';

-- Only the dispatcher calls this, and it runs as the service role, which needs
-- no grant. Nobody else has any business marking messages as being sent.
revoke execute on function public.claim_notifications(uuid, uuid, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A message in flight is not a message to re-queue
--
-- The reminder de-duplication asked whether one was already 'queued' or 'sent'.
-- With the new status in between, a reminder claimed by a dispatcher and not
-- yet delivered matched neither — so a cron tick landing at that moment would
-- queue a second one. That is the same double-send arriving by another route.
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
       and d.published_at is not null
       and s.starts_at > now()
       and s.starts_at <= now() + make_interval(hours => w.reminder_lead_hours)
       and not exists (
         select 1 from public.notifications n
          where n.appointment_id = a.id
            and n.kind = 'reminder'
            and n.status in ('queued', 'sending', 'sent')
       )
     order by s.starts_at
  loop
    queued := queued + public.queue_notification(appt.id, 'reminder');
  end loop;

  return queued;
end;
$$;

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
            and n.status in ('queued', 'sending', 'sent')
       )
     order by s.starts_at
  loop
    queued := queued + public.queue_notification(appt.id, 'reminder');
  end loop;

  return queued;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Letting a member's own booking send at once
--
-- A confirmation queued by `book_slot()` waited for the next scheduled run,
-- because the only way to nudge the dispatcher was as a ward admin and the
-- person who just booked is nobody. Up to a quarter of an hour staring at an
-- inbox is the worst first impression this app can make, and it is the most
-- common path through it.
--
-- This authorizes a nudge the same way cancelling is authorized: with the
-- cancel token. It reveals nothing — the answer is an appointment id the caller
-- already effectively holds — and it lets the dispatcher scope delivery to that
-- one appointment.
-- ---------------------------------------------------------------------------

create or replace function public.appointment_id_for_token(p_cancel_token uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id from public.appointments where cancel_token = p_cancel_token;
$$;

revoke execute on function public.appointment_id_for_token(uuid)
  from public, anon, authenticated;
