-- Sending confirmations and cancellations the moment they are written.
--
-- These were queued and then nudged from the browser, which does not work and
-- was never going to work reliably. A signed-out member carries a publishable
-- key, and the new key format is not a JWT — so with the function's JWT
-- verification on, Supabase's gateway refuses the call before the function
-- runs. The nudge swallowed the refusal, the booking succeeded, and the
-- confirmation sat in the queue until the next scheduled run.
--
-- Doing it from Postgres removes every one of those failure modes at once:
-- there is no browser, no CORS, no gateway, and no anonymous caller. A trigger
-- on `notifications` asks pg_net to POST to the dispatcher, with the service
-- role key, the instant a message is written.
--
-- Reminders are deliberately excluded. They stay the cron job's work, because a
-- reminder sent the moment it is queued is a reminder sent at whatever hour the
-- scheduler happened to wake up.

-- ---------------------------------------------------------------------------
-- 1. Somewhere to keep the key
--
-- The dispatcher needs the service role key to authenticate, and the database
-- needs somewhere to keep it. `app_settings` is the wrong home: its select
-- policy admits any signed-in user, which would hand the service role key to
-- every ward viewer in the project.
--
-- This table has RLS enabled and *no policies at all* — the same pattern
-- `lookup_attempts` uses. With no policy, no row is visible to anyone through
-- PostgREST, whatever role they hold. Only SECURITY DEFINER functions and the
-- service role can read it.
-- ---------------------------------------------------------------------------

create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

comment on table public.app_secrets is
  'Server-side secrets. RLS is on with no policies, so nothing here is readable '
  'through the API by any role — only by SECURITY DEFINER functions.';

-- Where the dispatcher lives. Not a secret, so it sits with the other settings.
alter table public.app_settings add column if not exists dispatch_url text;

-- ---------------------------------------------------------------------------
-- 2. The trigger
--
-- Three things it must never do, all learned from what it replaces:
--
--   * It must not fail a booking. A confirmation that cannot be dispatched is a
--     confirmation that goes out on the next scheduled run — an inconvenience.
--     An exception here would roll back the appointment itself, which is a
--     member turning up to no slot. Everything is wrapped accordingly.
--   * It must not require pg_net. A project without the extension, or the test
--     harness's bare Postgres, has to keep working. The call is made through
--     dynamic SQL so the function body does not even name `net` unless it is
--     there to be named.
--   * It must not fire for reminders. Those belong to the schedule.
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
  if new.kind not in ('confirmation', 'cancellation') then
    return new;
  end if;

  select dispatch_url into url from public.app_settings where id;
  select value into key from public.app_secrets where name = 'dispatch_key';

  -- Not configured yet, or no pg_net on this project: leave it queued. The
  -- scheduled run collects it, which is exactly the old behaviour.
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
        jsonb_build_object('appointment_id', new.appointment_id);
  exception when others then
    -- Never at the cost of the booking. The message is already queued and the
    -- schedule is the guarantee; this was only ever the fast path.
    raise warning 'Could not dispatch notification %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists notifications_dispatch_now on public.notifications;
create trigger notifications_dispatch_now
  after insert on public.notifications
  for each row execute procedure public.dispatch_notification_now();

comment on function public.dispatch_notification_now() is
  'Asks the dispatcher to deliver a confirmation or cancellation immediately. '
  'Silent and harmless when unconfigured — the scheduled run is the guarantee.';

revoke execute on function public.dispatch_notification_now() from public, anon, authenticated;
