-- Demo data. Skip this on a real ward.
--
-- Creates one ward with a published evening of slots so the public page has
-- something to show before the executive secretary has built anything. The
-- migration tests skip this file — nothing in them depends on it, and seeded
-- rows would make "no appointments exist" assertions lie.
--
-- Everything is guarded: with no auth users yet there is nobody to own a ward,
-- so the whole block is skipped rather than failing the migration run.

do $$
declare
  owner_id uuid;
  ward_id  uuid;
  day_id   uuid;
begin
  select id into owner_id from auth.users order by created_at limit 1;
  if owner_id is null then
    raise notice 'No auth users yet — skipping demo seed. Re-run after signing in once.';
    return;
  end if;

  if exists (select 1 from public.wards where slug = 'demo-ward') then
    raise notice 'Demo ward already present — skipping.';
    return;
  end if;

  insert into public.wards (name, slug, timezone, instructions, contact_name, created_by)
  values (
    'Demo Ward',
    'demo-ward',
    'America/Denver',
    'Declarations are held in the bishop''s office. Please arrive a few minutes early.',
    'Ward Clerk',
    owner_id
  )
  returning id into ward_id;

  -- Whoever seeded it administers it, or nobody could open the schedule.
  insert into public.ward_roles (ward_id, user_id, role, granted_by)
  values (ward_id, owner_id, 'admin', owner_id)
  on conflict (ward_id, user_id) do nothing;

  -- A week out, so the slots are still in the future whenever this is run.
  insert into public.schedule_days (ward_id, service_date, location, published_at, created_by)
  values (ward_id, (now() at time zone 'America/Denver')::date + 7,
          'Bishop''s office', now(), owner_id)
  returning id into day_id;

  /* Inserted directly rather than through generate_slots(), which insists on
     an authenticated ward admin. A migration has no auth.uid(), and loosening
     that check so the seed could use it would loosen it for the anon key too. */
  insert into public.slots (day_id, starts_at)
  select day_id, wall_clock at time zone 'America/Denver'
    from generate_series(
           ((now() at time zone 'America/Denver')::date + 7) + time '18:00',
           ((now() at time zone 'America/Denver')::date + 7) + time '20:15',
           interval '15 minutes'
         ) as wall_clock
   where extract(minute from wall_clock)::int in (0, 15, 30);
end $$;
