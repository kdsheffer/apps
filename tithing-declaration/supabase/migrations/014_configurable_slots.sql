-- Making the buffer a setting rather than a rule about the :45 mark.
--
-- Slots were generated at :00, :15 and :30 of every clock hour, with :45 left
-- as rest. That hardcodes two decisions — fifteen minutes of rest, and fifteen
-- minute appointments — and a third nobody meant to make: that a block of times
-- starts on the hour. A ward starting at 6:45pm got its first slot at 7:00 and
-- lost the quarter hour it had actually planned to use.
--
-- The pattern is now expressed properly: an hour-long cycle measured **from the
-- start of the block**, filled with back-to-back appointments until the rest
-- period at the end of it. Rest of 15 and a duration of 15 reproduce exactly
-- what the ward has now, so nothing moves unless somebody changes it.

-- ---------------------------------------------------------------------------
-- 1. Per-ward defaults
--
-- These prefill the form rather than constrain it — a one-off block can use
-- whatever it likes. They exist so the secretary sets the ward's usual shape
-- once instead of retyping it at every evening.
-- ---------------------------------------------------------------------------

alter table public.wards
  add column if not exists default_slot_minutes integer not null default 15;
alter table public.wards
  add column if not exists default_rest_minutes integer not null default 15;

do $$
begin
  alter table public.wards
    add constraint wards_default_slot_minutes_sane check (default_slot_minutes between 5 and 60);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.wards
    add constraint wards_default_rest_minutes_sane check (default_rest_minutes between 0 and 55);
exception when duplicate_object then null;
end $$;

comment on column public.wards.default_rest_minutes is
  'Minutes of buffer at the end of each hour of a block. 0 means back-to-back '
  'appointments with no gap.';

-- ---------------------------------------------------------------------------
-- 2. Generating
--
-- Two nested series. The outer one walks hour-long cycles from the start of the
-- block; the inner one lays appointments back-to-back inside each cycle until
-- the rest period. Both are bounded by the block's own end, so the last cycle
-- is simply short rather than a special case.
--
-- The reason it is measured from the block start and not the clock: a block
-- beginning at 6:45 wants its rest at 7:30–7:45, not at 6:45–7:00. "The last
-- quarter of each hour" means each hour of the block.
-- ---------------------------------------------------------------------------

create or replace function public.generate_slots(
  p_day_id   uuid,
  p_start    time,
  p_end      time,
  p_duration integer default null,
  p_rest     integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_row  public.schedule_days%rowtype;
  ward_row public.wards%rowtype;
  duration integer;
  rest     integer;
  span     integer;   -- minutes from the start of the block to its end
  added    integer;
begin
  select * into day_row from public.schedule_days where id = p_day_id;
  if not found then
    raise exception 'That day does not exist.' using errcode = 'no_data_found';
  end if;

  -- SECURITY DEFINER means RLS is not doing the checking here.
  if not public.is_ward_admin(day_row.ward_id) then
    raise exception 'Only a ward admin can change the schedule.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into ward_row from public.wards where id = day_row.ward_id;
  duration := coalesce(p_duration, ward_row.default_slot_minutes);
  rest     := coalesce(p_rest, ward_row.default_rest_minutes);

  if p_end <= p_start then
    raise exception 'The end time has to be after the start time.'
      using errcode = 'check_violation';
  end if;
  if duration not between 5 and 60 then
    raise exception 'An appointment has to be between 5 and 60 minutes.'
      using errcode = 'check_violation';
  end if;
  if rest not between 0 and 55 then
    raise exception 'Rest has to be between 0 and 55 minutes of each hour.'
      using errcode = 'check_violation';
  end if;
  if duration > 60 - rest then
    raise exception
      'A % minute appointment does not fit in an hour with % minutes of rest.',
      duration, rest
      using errcode = 'check_violation';
  end if;

  span := (extract(epoch from (p_end - p_start)) / 60)::int;

  with cycles as (
    select generate_series(0, span - 1, 60) as cycle
  ),
  offsets as (
    -- Back-to-back from the top of the cycle, stopping where rest begins.
    select generate_series(0, 60 - rest - duration, duration) as slot
  ),
  wanted as (
    select cycle + slot as minute
      from cycles cross join offsets
     -- Every appointment has to finish inside the block, not merely start in it.
     where cycle + slot + duration <= span
  ),
  inserted as (
    insert into public.slots (day_id, starts_at, duration_minutes)
    select p_day_id,
           (day_row.service_date + p_start + make_interval(mins => minute))
             at time zone ward_row.timezone,
           duration
      from wanted
    on conflict (day_id, starts_at) do nothing
    returning 1
  )
  select count(*)::int into added from inserted;

  return added;
end;
$$;

comment on function public.generate_slots(uuid, time, time, integer, integer) is
  'Fills a block with back-to-back appointments, leaving the last `rest` '
  'minutes of each hour of the block free. Idempotent — re-running extends a '
  'day without touching slots that already exist.';

/* The old four-argument form would still resolve for any caller that has not
   been updated, and would quietly use the ward default for rest instead of the
   value it was given. Better that it stops existing. */
drop function if exists public.generate_slots(uuid, time, time, integer);

revoke execute on function public.generate_slots(uuid, time, time, integer, integer)
  from public, anon;
grant execute on function public.generate_slots(uuid, time, time, integer, integer)
  to authenticated;
