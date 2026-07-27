-- Simpler test data seeding script that actually works

-- Step 1: Ensure test members exist in Meridian 16th Ward
insert into public.members (ward_id, full_name)
select w.id, 'John Smith'
from public.wards w
where w.name = 'Meridian 16th Ward'
  and not exists (
    select 1 from public.members
    where ward_id = w.id and full_name = 'John Smith'
  );

insert into public.members (ward_id, full_name)
select w.id, 'Jane Doe'
from public.wards w
where w.name = 'Meridian 16th Ward'
  and not exists (
    select 1 from public.members
    where ward_id = w.id and full_name = 'Jane Doe'
  );

insert into public.members (ward_id, full_name)
select w.id, 'Michael Johnson'
from public.wards w
where w.name = 'Meridian 16th Ward'
  and not exists (
    select 1 from public.members
    where ward_id = w.id and full_name = 'Michael Johnson'
  );

-- Step 2: Assign members to positions
-- Assign John Smith to Bishop position
insert into public.position_assignments (position_id, member_id, called_date)
select p.id, m.id, current_date - interval '1 year 3 months'
from public.positions p
join public.groups g on p.group_id = g.id
join public.boards b on g.board_id = b.id
join public.wards w on b.ward_id = w.id
join public.members m on m.ward_id = w.id
where w.name = 'Meridian 16th Ward'
  and b.status = 'promoted'
  and g.name = 'Bishopric'
  and p.title = 'Bishop'
  and m.full_name = 'John Smith'
  and not exists (
    select 1 from public.position_assignments
    where position_id = p.id and member_id = m.id
  );

-- Assign Jane Doe to Bishopric First Counselor
insert into public.position_assignments (position_id, member_id, called_date)
select p.id, m.id, current_date - interval '2 years'
from public.positions p
join public.groups g on p.group_id = g.id
join public.boards b on g.board_id = b.id
join public.wards w on b.ward_id = w.id
join public.members m on m.ward_id = w.id
where w.name = 'Meridian 16th Ward'
  and b.status = 'promoted'
  and g.name = 'Bishopric'
  and p.title = 'First Counselor'
  and m.full_name = 'Jane Doe'
  and not exists (
    select 1 from public.position_assignments
    where position_id = p.id and member_id = m.id
  );

-- Assign Michael Johnson to Elders Quorum President
insert into public.position_assignments (position_id, member_id, called_date)
select p.id, m.id, current_date - interval '6 months'
from public.positions p
join public.groups g on p.group_id = g.id
join public.boards b on g.board_id = b.id
join public.wards w on b.ward_id = w.id
join public.members m on m.ward_id = w.id
where w.name = 'Meridian 16th Ward'
  and b.status = 'promoted'
  and g.name = 'Elders Quorum'
  and p.title = 'President'
  and m.full_name = 'Michael Johnson'
  and not exists (
    select 1 from public.position_assignments
    where position_id = p.id and member_id = m.id
  );

-- Assign Jane Doe to Relief Society President
insert into public.position_assignments (position_id, member_id, called_date)
select p.id, m.id, current_date - interval '1 year 6 months'
from public.positions p
join public.groups g on p.group_id = g.id
join public.boards b on g.board_id = b.id
join public.wards w on b.ward_id = w.id
join public.members m on m.ward_id = w.id
where w.name = 'Meridian 16th Ward'
  and b.status = 'promoted'
  and g.name = 'Relief Society'
  and p.title = 'President'
  and m.full_name = 'Jane Doe'
  and not exists (
    select 1 from public.position_assignments
    where position_id = p.id and member_id = m.id
  );
