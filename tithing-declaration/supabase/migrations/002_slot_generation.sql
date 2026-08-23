-- Building an evening's slots, and protecting the bookings already in them.
--
-- The pattern the ward asked for is three interviews an hour — :00, :15 and
-- :30 — with the last quarter of every hour left as buffer so a long interview
-- doesn't push the whole evening back. The buffer is not a slot that happens to
-- be unbookable; it is simply not generated. Nothing exists at :45.
--
-- Doing the generation in the database rather than the browser is deliberate.
-- The times have to be right across a daylight-saving change, which means
-- resolving a wall clock against a named timezone, and Postgres knows the
-- timezone database. The browser knows the *visitor's* timezone, which is not
-- the same question and is wrong whenever the secretary is travelling.

-- ---------------------------------------------------------------------------
-- 1. Generating slots
-- ---------------------------------------------------------------------------

/*
 * Fill a day with slots between two wall-clock times.
 *
 * `p_end` is when the evening finishes, not when the last interview starts: a
 * slot is generated only if it *ends* by then. Asking for 6:00pm–8:30pm gives a
 * last slot of 8:15pm, which is what somebody writing "we're done at 8:30"
 * means.
 *
 * Safe to run twice. Existing slots at the same time are left alone, so the
 * secretary can extend an evening by re-running it with a later end time
 * without disturbing anything already booked into it.
 *
 * Returns the number of slots actually added.
 */
create or replace function public.generate_slots(
  p_day_id   uuid,
  p_start    time,
  p_end      time,
  p_duration integer default 15
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_row  public.schedule_days%rowtype;
  ward_tz  text;
  added    integer;
begin
  select * into day_row from public.schedule_days where id = p_day_id;
  if not found then
    raise exception 'That day does not exist.' using errcode = 'no_data_found';
  end if;

  -- SECURITY DEFINER means RLS is not doing the checking here, so the function
  -- has to. Everything below runs with the policies bypassed.
  if not public.is_ward_admin(day_row.ward_id) then
    raise exception 'Only a ward admin can change the schedule.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_end <= p_start then
    raise exception 'The end time has to be after the start time.'
      using errcode = 'check_violation';
  end if;

  if p_duration not between 5 and 120 then
    raise exception 'An appointment has to be between 5 and 120 minutes.'
      using errcode = 'check_violation';
  end if;

  select timezone into ward_tz from public.wards where id = day_row.ward_id;

  with candidates as (
    select generate_series(
             day_row.service_date + p_start,
             -- Back the window off by one appointment so the series stops at
             -- the last slot that finishes inside it.
             (day_row.service_date + p_end) - make_interval(mins => p_duration),
             interval '15 minutes'
           ) as wall_clock
  ),
  wanted as (
    select wall_clock
      from candidates
     -- The buffer: :45 never appears.
     where extract(minute from wall_clock)::int in (0, 15, 30)
  ),
  inserted as (
    insert into public.slots (day_id, starts_at, duration_minutes)
    select p_day_id, wall_clock at time zone ward_tz, p_duration
      from wanted
    on conflict (day_id, starts_at) do nothing
    returning 1
  )
  select count(*)::int into added from inserted;

  return added;
end;
$$;

comment on function public.generate_slots(uuid, time, time, integer) is
  'Fills a schedule day with slots at :00, :15 and :30 of each hour, leaving '
  ':45 as buffer. Idempotent — re-running extends a day without touching '
  'slots that already exist.';

-- ---------------------------------------------------------------------------
-- 2. Protecting booked slots
--
-- `appointments.slot_id` cascades on delete, which is right for tearing down a
-- day that was created by mistake and badly wrong for a stray click on a slot
-- somebody has booked: the booking would disappear without a word, and the
-- family would arrive to a schedule with no room for them.
--
-- Both triggers below turn that silence into a refusal the secretary can act
-- on. Cancel the appointment first, and the slot frees up.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_slot_free_to_remove()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  held_by text;
begin
  select family_name into held_by
    from public.appointments
   where slot_id = old.id and cancelled_at is null
   limit 1;

  if held_by is not null then
    raise exception
      'The % family is booked at that time. Cancel their appointment before removing the slot.',
      held_by
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists slots_free_before_delete on public.slots;
create trigger slots_free_before_delete
  before delete on public.slots
  for each row execute procedure public.enforce_slot_free_to_remove();

/*
 * Same rule for blocking. A blocked slot is one nobody may book, so blocking
 * one that is already booked would leave an appointment in a time the schedule
 * says isn't open — the sort of inconsistency that only surfaces on the night.
 */
create or replace function public.enforce_slot_free_to_block()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  held_by text;
begin
  if new.blocked_at is null or old.blocked_at is not null then
    return new;   -- unblocking, or already blocked: nothing to check
  end if;

  select family_name into held_by
    from public.appointments
   where slot_id = new.id and cancelled_at is null
   limit 1;

  if held_by is not null then
    raise exception
      'The % family is booked at that time. Cancel their appointment before blocking the slot.',
      held_by
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists slots_free_before_block on public.slots;
create trigger slots_free_before_block
  before update of blocked_at on public.slots
  for each row execute procedure public.enforce_slot_free_to_block();

-- ---------------------------------------------------------------------------
-- 3. Un-publishing a day
--
-- Publishing opens a day to the public page. Un-publishing takes it back, which
-- is fine while nobody has booked and misleading once somebody has: their
-- appointment would still exist while the page told them the evening wasn't
-- happening. Cancel the bookings — which notifies the families — or leave the
-- day published.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_day_empty_to_unpublish()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  booked integer;
begin
  if new.published_at is not null or old.published_at is null then
    return new;
  end if;

  select count(*) into booked
    from public.appointments a
    join public.slots s on s.id = a.slot_id
   where s.day_id = new.id and a.cancelled_at is null;

  if booked > 0 then
    raise exception
      'This day has % booked appointment(s). Cancel them before hiding it.', booked
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists schedule_days_empty_to_unpublish on public.schedule_days;
create trigger schedule_days_empty_to_unpublish
  before update of published_at on public.schedule_days
  for each row execute procedure public.enforce_day_empty_to_unpublish();
