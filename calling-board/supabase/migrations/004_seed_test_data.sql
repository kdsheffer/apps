-- Seed test data for Phase 4 board view testing
-- This script finds existing ward/board/positions and adds members + assignments

-- Get the Meridian 16th Ward ID
with meridian_ward as (
  select id from public.wards where name = 'Meridian 16th Ward' limit 1
),

-- Get or create promoted board for that ward
promoted_board as (
  select id from public.boards
  where ward_id = (select id from meridian_ward)
    and status = 'promoted'
  limit 1
),

-- Insert test members if they don't exist
new_members as (
  insert into public.members (ward_id, full_name)
  select (select id from meridian_ward), 'John Smith'
  where not exists (
    select 1 from public.members
    where ward_id = (select id from meridian_ward)
      and full_name = 'John Smith'
  )
  union all
  select (select id from meridian_ward), 'Jane Doe'
  where not exists (
    select 1 from public.members
    where ward_id = (select id from meridian_ward)
      and full_name = 'Jane Doe'
  )
  union all
  select (select id from meridian_ward), 'Michael Johnson'
  where not exists (
    select 1 from public.members
    where ward_id = (select id from meridian_ward)
      and full_name = 'Michael Johnson'
  )
  returning id, full_name
)

-- Insert assignments to positions
insert into public.position_assignments (position_id, member_id, called_date)
select
  p.id as position_id,
  m.id as member_id,
  current_date - interval '1 year 3 months' as called_date
from public.positions p
cross join public.members m
where p.group_id in (
  select id from public.groups
  where board_id = (select id from promoted_board)
)
  and m.ward_id = (select id from meridian_ward)
  and m.full_name in ('John Smith', 'Jane Doe', 'Michael Johnson')
  and not exists (
    select 1 from public.position_assignments
    where position_id = p.id and member_id = m.id
  )
on conflict do nothing;
