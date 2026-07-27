-- Wipe a ward's board data and members so it can be re-imported from scratch.
--
-- Run in the Supabase SQL editor. This does NOT touch the ward itself, your admin
-- access, sign-in, or the shared calling catalog — only the boards and members
-- belonging to the ward named below.
--
-- Foreign keys cascade, so two deletes cover everything:
--   boards  -> groups -> positions -> position_assignments
--   members -> position_assignments
--
-- Edit the ward name in ONE place: the `target` CTE in each statement below.
-- Run the statements one at a time, checking each result before moving on.


-- Step 1 — confirm the ward name matches exactly (should return one row).
select id, name, created_at from public.wards where name = 'Meridian 16th Ward';


-- Step 2 — preview what will be removed.
with target as (select id from public.wards where name = 'Meridian 16th Ward')
select
  (select count(*) from public.boards  where ward_id in (select id from target)) as boards,
  (select count(*) from public.members where ward_id in (select id from target)) as members,
  (select count(*) from public.positions p
     join public.groups g on g.id = p.group_id
     join public.boards b on b.id = g.board_id
    where b.ward_id in (select id from target))                                  as positions,
  (select count(*) from public.position_assignments pa
     join public.positions p on p.id = pa.position_id
     join public.groups g    on g.id = p.group_id
     join public.boards b    on b.id = g.board_id
    where b.ward_id in (select id from target))                                  as assignments;


-- Step 3 — delete. Imports reference boards via `on delete set null`, so clear
-- the import history rather than leaving rows pointing at nothing.
with target as (select id from public.wards where name = 'Meridian 16th Ward')
delete from public.imports where ward_id in (select id from target);

with target as (select id from public.wards where name = 'Meridian 16th Ward')
delete from public.boards where ward_id in (select id from target);

with target as (select id from public.wards where name = 'Meridian 16th Ward')
delete from public.members where ward_id in (select id from target);


-- Step 4 — verify. Both counts should be 0.
with target as (select id from public.wards where name = 'Meridian 16th Ward')
select
  (select count(*) from public.boards  where ward_id in (select id from target)) as boards_left,
  (select count(*) from public.members where ward_id in (select id from target)) as members_left;
