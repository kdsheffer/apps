-- Two things the audit turned up, both from features outgrowing older code.
--
--   1. The immediate-dispatch trigger names the message kinds it acts on, and
--      that list stopped being complete. `reschedule` arrived in migration 013
--      and `booking` in 015, and neither was added — so a member who just moved
--      their appointment, and the secretary who wants to know somebody booked,
--      both waited up to a quarter of an hour for the scheduled sweep.
--
--      Naming the exceptions instead of the members fixes the class of bug: a
--      kind added later is immediate unless somebody decides otherwise, which
--      is the right default and fails safe rather than silently.
--
--   2. That trigger identified its message by `appointment_id`, which the staff
--      messages do not have — a booking alert belongs to the ward, and a digest
--      to a whole day. With no id to send, the dispatcher fell back to a full
--      sweep on every booking. Harmless but wasteful, and it meant a staff
--      alert's delivery was never really scoped to itself.

-- ---------------------------------------------------------------------------
-- 1. Claiming one specific message
-- ---------------------------------------------------------------------------

create or replace function public.claim_notifications(
  p_ward_id         uuid default null,
  p_appointment_id  uuid default null,
  p_limit           integer default 50,
  p_notification_id uuid default null
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
              or (c.status = 'sending' and c.claimed_at < now() - interval '10 minutes')
            )
        and (p_ward_id is null or c.ward_id = p_ward_id)
        and (p_appointment_id is null or c.appointment_id = p_appointment_id)
        and (p_notification_id is null or c.id = p_notification_id)
      order by c.created_at
      for update skip locked
      limit p_limit
   )
  returning n.id, n.to_address, n.subject, n.body, n.attempts;
end;
$$;

revoke execute on function public.claim_notifications(uuid, uuid, integer, uuid)
  from public, anon, authenticated;

-- The four-argument form replaces the three-argument one; leaving the old
-- signature resolvable would mean a stale caller silently claiming a whole
-- ward's queue when it meant to claim one message.
drop function if exists public.claim_notifications(uuid, uuid, integer);

-- ---------------------------------------------------------------------------
-- 2. Everything is immediate except the two things that are on a clock
--
-- `reminder` and `digest` are queued by the scheduled sweep, which delivers
-- them in the same run — dispatching them here would be redundant at best, and
-- at worst would send a reminder at whatever hour the sweep happened to wake.
-- Everything else is a response to something a person just did, and should
-- arrive while they are still looking at the screen.
-- ---------------------------------------------------------------------------

create or replace function public.dispatch_notification_now()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  url text;
  key text;
begin
  if new.kind in ('reminder', 'digest') then
    return new;
  end if;

  select dispatch_url into url from public.app_settings where id;
  select value into key from public.app_secrets where name = 'dispatch_key';

  if url is null or key is null then
    return new;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return new;
  end if;

  begin
    execute
      'select net.http_post(url := $1, headers := $2, body := $3)'
      using
        url,
        jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || key
        ),
        -- The row itself, not its appointment. Staff messages have no
        -- appointment, and scoping to this one message is more precise than
        -- scoping to the appointment even when there is one.
        jsonb_build_object('notification_id', new.id);
  exception when others then
    -- Never at the cost of the booking. The message is already queued and the
    -- schedule is the guarantee; this was only ever the fast path.
    raise warning 'Could not dispatch notification %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke execute on function public.dispatch_notification_now() from public, anon, authenticated;
