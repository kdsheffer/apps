-- Close the internal functions that were never actually closed.
--
-- Migration 004 ended with a block of `revoke execute ... from anon,
-- authenticated`, and every one of them was a no-op. Postgres grants EXECUTE on
-- a new function to the pseudo-role PUBLIC, and revoking from a *member* role
-- does not remove a grant held by PUBLIC — `anon` kept its access through the
-- back door the whole time.
--
-- The observable result on a real project: `render_notification()` would return
-- a family's name, appointment time and confirmation code to an unauthenticated
-- caller holding an appointment id, and `queue_notification()` would send them
-- real email. Both needed a UUID nobody can guess, so this was a hole rather
-- than a breach — but it was open.
--
-- The fix is `from public` first. It is also why the public surface is granted
-- back explicitly below: revoking from PUBLIC takes the grant away from every
-- role at once, including the ones that are supposed to have it.

-- ---------------------------------------------------------------------------
-- 1. Close the internals
--
-- These are called only from inside other SECURITY DEFINER functions, which run
-- as the owner and keep their access regardless of what is revoked here.
-- ---------------------------------------------------------------------------

revoke execute on function public.check_rate_limit(uuid, text, integer, interval, text)
  from public, anon, authenticated;
revoke execute on function public.prune_lookup_attempts()
  from public, anon, authenticated;
revoke execute on function public.render_notification(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.queue_notification(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.new_confirmation_code()
  from public, anon, authenticated;
revoke execute on function public.privileged_write()
  from public, anon, authenticated;
revoke execute on function public.request_fingerprint(text)
  from public, anon, authenticated;

/*
 * The signed-in functions have the same problem in the other direction. Each
 * one does its own authorization check, so an anonymous caller was refused on
 * arrival rather than let through — but "the function turns them away" is a
 * weaker statement than "the function is not theirs to call", and only the
 * second survives somebody editing the check later.
 */
revoke execute on function public.claim_appointment(uuid)                   from public, anon;
revoke execute on function public.generate_slots(uuid, time, time, integer) from public, anon;
revoke execute on function public.queue_day_reminders(uuid)                 from public, anon;

-- ---------------------------------------------------------------------------
-- 2. Grant the public surface back, explicitly
--
-- This list is the entire API available without a session. Anything not named
-- here should be unreachable, and `functions.test.mjs` asserts exactly that.
-- ---------------------------------------------------------------------------

grant execute on function public.public_ward(text)                             to anon, authenticated;
grant execute on function public.public_schedule(text)                         to anon, authenticated;
grant execute on function public.book_slot(text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.find_appointments(text, text, text)           to anon, authenticated;
grant execute on function public.cancel_appointment(uuid, text)                to anon, authenticated;

-- Signed-in only.
grant execute on function public.claim_appointment(uuid)                       to authenticated;
grant execute on function public.generate_slots(uuid, time, time, integer)     to authenticated;
grant execute on function public.queue_day_reminders(uuid)                     to authenticated;

/*
 * The authorization helpers stay executable, and deliberately so: a policy
 * expression is evaluated with the privileges of the role running the query, so
 * revoking these from `authenticated` would break every RLS policy that uses
 * them and lock signed-in users out of their own ward.
 *
 * They leak nothing on their own — each one reports on the caller, or maps an
 * id to the ward id it belongs to.
 */
grant execute on function public.is_super_admin()                to anon, authenticated;
grant execute on function public.is_ward_admin(uuid)             to anon, authenticated;
grant execute on function public.is_ward_member(uuid)            to anon, authenticated;
grant execute on function public.shares_administered_ward(uuid)  to anon, authenticated;
grant execute on function public.ward_of_day(uuid)               to anon, authenticated;
grant execute on function public.ward_of_slot(uuid)              to anon, authenticated;

-- Pure formatting helpers with no access to anything.
grant execute on function public.name_key(text)                     to anon, authenticated;
grant execute on function public.format_slot_local(timestamptz, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stop the confirmation code needing a grant at all
--
-- `appointments.confirmation_code` defaulted to `new_confirmation_code()`, and
-- a column default is evaluated as the role doing the INSERT — not as the owner
-- of anything. So revoking that function above broke the one path that inserts
-- directly: the executive secretary adding a family who rang up. `book_slot()`
-- kept working and hid the problem, because it is SECURITY DEFINER and runs as
-- the owner either way.
--
-- Granting the function back to `authenticated` would fix it and leave a
-- function on the surface that exists only to satisfy a default. Moving the
-- call into the BEFORE INSERT trigger — which is already SECURITY DEFINER and
-- already runs on every insert — fixes it and needs no grant to anybody.
-- ---------------------------------------------------------------------------

alter table public.appointments alter column confirmation_code drop default;

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

  -- Allocated here rather than as a column default, so no caller needs EXECUTE
  -- on the generator. NOT NULL is checked after this runs, so a client that
  -- omits the column still gets a code.
  if new.confirmation_code is null then
    new.confirmation_code := public.new_confirmation_code();
  end if;

  -- Only ever checked when a booking is created or moved. Cancelling a
  -- booking on a slot that has since been blocked has to keep working.
  if tg_op = 'INSERT' or new.slot_id is distinct from old.slot_id then
    if slot_row.blocked_at is not null then
      raise exception 'That time is not available.' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;
