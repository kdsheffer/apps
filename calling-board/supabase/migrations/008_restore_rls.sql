-- Restore row level security.
--
-- RLS had been switched off on every table. Because the publishable key ships
-- inside the deployed JavaScript bundle, that left the whole database readable
-- AND writable by anyone who opened the site — including profiles.is_super_admin.
--
-- The original policies recursed: the policy on `profiles` queried `profiles`,
-- and policies on child tables reached through `boards`/`groups`, which have
-- policies of their own. Migration 003 patched one case. This replaces the
-- approach with SECURITY DEFINER helpers, which run with RLS bypassed, so an
-- authorization check can never re-enter the policy it is being used by.

-- ---------------------------------------------------------------------------
-- Authorization helpers
--
-- SECURITY DEFINER + a pinned search_path: these read the tables they need
-- without triggering RLS, which is what breaks the recursion. They reveal only
-- whether the *calling* user is authorized, so they are safe to expose.
-- ---------------------------------------------------------------------------

create or replace function public.is_super_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_super_admin
  );
$$;

create or replace function public.is_ward_admin(target_ward uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select target_ward is not null and (
    exists (
      select 1 from public.ward_admins
      where ward_id = target_ward and user_id = auth.uid()
    )
    or public.is_super_admin()
  );
$$;

-- Child rows don't carry a ward_id, so each level resolves its owning ward.
create or replace function public.ward_of_board(target_board uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select ward_id from public.boards where id = target_board;
$$;

create or replace function public.ward_of_group(target_group uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select b.ward_id
  from public.groups g
  join public.boards b on b.id = g.board_id
  where g.id = target_group;
$$;

create or replace function public.ward_of_position(target_position uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select b.ward_id
  from public.positions p
  join public.groups g on g.id = p.group_id
  join public.boards b on b.id = g.board_id
  where p.id = target_position;
$$;

-- ---------------------------------------------------------------------------
-- Replace every policy, then turn RLS back on.
--
-- Policies are dropped by name first so this migration is safe to re-run and
-- doesn't depend on which of the earlier definitions survived.
-- ---------------------------------------------------------------------------

-- profiles ------------------------------------------------------------------
drop policy if exists "profiles_readable_by_self" on public.profiles;
drop policy if exists "profiles_super_admin_can_see_all" on public.profiles;
drop policy if exists "profiles_select" on public.profiles;

create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.is_super_admin());

-- Deliberately no insert/update/delete policy. Rows are created by the
-- on_auth_user_created trigger, and is_super_admin must never be self-granted
-- from the client — that is a SQL editor / service role operation.

-- wards ---------------------------------------------------------------------
drop policy if exists "wards_readable_by_admins" on public.wards;
drop policy if exists "wards_insertable_by_super_admin" on public.wards;
drop policy if exists "wards_select" on public.wards;
drop policy if exists "wards_insert" on public.wards;
drop policy if exists "wards_update" on public.wards;
drop policy if exists "wards_delete" on public.wards;

create policy "wards_select" on public.wards
  for select using (public.is_ward_admin(id));

create policy "wards_insert" on public.wards
  for insert with check (public.is_super_admin());

create policy "wards_update" on public.wards
  for update using (public.is_super_admin());

create policy "wards_delete" on public.wards
  for delete using (public.is_super_admin());

-- ward_admins ---------------------------------------------------------------
drop policy if exists "ward_admins_readable_by_admin" on public.ward_admins;
drop policy if exists "ward_admins_insertable_by_super_admin_or_ward_admin" on public.ward_admins;
drop policy if exists "ward_admins_deletable_by_super_admin_or_ward_admin" on public.ward_admins;
drop policy if exists "ward_admins_select" on public.ward_admins;
drop policy if exists "ward_admins_insert" on public.ward_admins;
drop policy if exists "ward_admins_delete" on public.ward_admins;

create policy "ward_admins_select" on public.ward_admins
  for select using (public.is_ward_admin(ward_id));

create policy "ward_admins_insert" on public.ward_admins
  for insert with check (public.is_ward_admin(ward_id));

create policy "ward_admins_delete" on public.ward_admins
  for delete using (public.is_ward_admin(ward_id));

-- catalog_positions ---------------------------------------------------------
drop policy if exists "catalog_positions_readable_by_ward_admin_or_global" on public.catalog_positions;
drop policy if exists "catalog_positions_insertable_by_ward_admin" on public.catalog_positions;
drop policy if exists "catalog_positions_select" on public.catalog_positions;
drop policy if exists "catalog_positions_insert" on public.catalog_positions;

-- The global catalog (ward_id is null) is reference data, not ward data, but
-- it is still only offered to signed-in users.
create policy "catalog_positions_select" on public.catalog_positions
  for select using (
    (ward_id is null and auth.uid() is not null)
    or public.is_ward_admin(ward_id)
  );

create policy "catalog_positions_insert" on public.catalog_positions
  for insert with check (public.is_ward_admin(ward_id));

-- boards --------------------------------------------------------------------
drop policy if exists "boards_readable_by_ward_admin" on public.boards;
drop policy if exists "boards_insertable_by_ward_admin" on public.boards;
drop policy if exists "boards_updatable_by_ward_admin" on public.boards;
drop policy if exists "boards_deletable_by_ward_admin" on public.boards;
drop policy if exists "boards_select" on public.boards;
drop policy if exists "boards_insert" on public.boards;
drop policy if exists "boards_update" on public.boards;
drop policy if exists "boards_delete" on public.boards;

create policy "boards_select" on public.boards
  for select using (public.is_ward_admin(ward_id));

create policy "boards_insert" on public.boards
  for insert with check (public.is_ward_admin(ward_id));

create policy "boards_update" on public.boards
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));

create policy "boards_delete" on public.boards
  for delete using (public.is_ward_admin(ward_id));

-- groups --------------------------------------------------------------------
drop policy if exists "groups_readable_by_ward_admin" on public.groups;
drop policy if exists "groups_insertable_by_ward_admin" on public.groups;
drop policy if exists "groups_updatable_by_ward_admin" on public.groups;
drop policy if exists "groups_deletable_by_ward_admin" on public.groups;
drop policy if exists "groups_select" on public.groups;
drop policy if exists "groups_insert" on public.groups;
drop policy if exists "groups_update" on public.groups;
drop policy if exists "groups_delete" on public.groups;

create policy "groups_select" on public.groups
  for select using (public.is_ward_admin(public.ward_of_board(board_id)));

create policy "groups_insert" on public.groups
  for insert with check (public.is_ward_admin(public.ward_of_board(board_id)));

create policy "groups_update" on public.groups
  for update using (public.is_ward_admin(public.ward_of_board(board_id)))
  with check (public.is_ward_admin(public.ward_of_board(board_id)));

create policy "groups_delete" on public.groups
  for delete using (public.is_ward_admin(public.ward_of_board(board_id)));

-- positions -----------------------------------------------------------------
drop policy if exists "positions_readable_by_ward_admin" on public.positions;
drop policy if exists "positions_insertable_by_ward_admin" on public.positions;
drop policy if exists "positions_updatable_by_ward_admin" on public.positions;
drop policy if exists "positions_deletable_by_ward_admin" on public.positions;
drop policy if exists "positions_select" on public.positions;
drop policy if exists "positions_insert" on public.positions;
drop policy if exists "positions_update" on public.positions;
drop policy if exists "positions_delete" on public.positions;

create policy "positions_select" on public.positions
  for select using (public.is_ward_admin(public.ward_of_group(group_id)));

create policy "positions_insert" on public.positions
  for insert with check (public.is_ward_admin(public.ward_of_group(group_id)));

create policy "positions_update" on public.positions
  for update using (public.is_ward_admin(public.ward_of_group(group_id)))
  with check (public.is_ward_admin(public.ward_of_group(group_id)));

create policy "positions_delete" on public.positions
  for delete using (public.is_ward_admin(public.ward_of_group(group_id)));

-- members -------------------------------------------------------------------
drop policy if exists "members_readable_by_ward_admin" on public.members;
drop policy if exists "members_insertable_by_ward_admin" on public.members;
drop policy if exists "members_updatable_by_ward_admin" on public.members;
drop policy if exists "members_deletable_by_ward_admin" on public.members;
drop policy if exists "members_select" on public.members;
drop policy if exists "members_insert" on public.members;
drop policy if exists "members_update" on public.members;
drop policy if exists "members_delete" on public.members;

create policy "members_select" on public.members
  for select using (public.is_ward_admin(ward_id));

create policy "members_insert" on public.members
  for insert with check (public.is_ward_admin(ward_id));

create policy "members_update" on public.members
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));

create policy "members_delete" on public.members
  for delete using (public.is_ward_admin(ward_id));

-- position_assignments ------------------------------------------------------
-- Keyed off the position's board rather than the member's ward: the assignment
-- belongs to a board, and that is what decides who may change it.
drop policy if exists "position_assignments_readable_by_ward_admin" on public.position_assignments;
drop policy if exists "position_assignments_insertable_by_ward_admin" on public.position_assignments;
drop policy if exists "position_assignments_updatable_by_ward_admin" on public.position_assignments;
drop policy if exists "position_assignments_deletable_by_ward_admin" on public.position_assignments;
drop policy if exists "position_assignments_select" on public.position_assignments;
drop policy if exists "position_assignments_insert" on public.position_assignments;
drop policy if exists "position_assignments_update" on public.position_assignments;
drop policy if exists "position_assignments_delete" on public.position_assignments;

create policy "position_assignments_select" on public.position_assignments
  for select using (public.is_ward_admin(public.ward_of_position(position_id)));

create policy "position_assignments_insert" on public.position_assignments
  for insert with check (public.is_ward_admin(public.ward_of_position(position_id)));

create policy "position_assignments_update" on public.position_assignments
  for update using (public.is_ward_admin(public.ward_of_position(position_id)))
  with check (public.is_ward_admin(public.ward_of_position(position_id)));

create policy "position_assignments_delete" on public.position_assignments
  for delete using (public.is_ward_admin(public.ward_of_position(position_id)));

-- imports -------------------------------------------------------------------
drop policy if exists "imports_readable_by_ward_admin" on public.imports;
drop policy if exists "imports_insertable_by_ward_admin" on public.imports;
drop policy if exists "imports_select" on public.imports;
drop policy if exists "imports_insert" on public.imports;

create policy "imports_select" on public.imports
  for select using (public.is_ward_admin(ward_id));

create policy "imports_insert" on public.imports
  for insert with check (public.is_ward_admin(ward_id));

-- ---------------------------------------------------------------------------
-- Arm it. This is the line that was missing.
-- ---------------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.wards                enable row level security;
alter table public.ward_admins          enable row level security;
alter table public.catalog_positions    enable row level security;
alter table public.boards               enable row level security;
alter table public.groups               enable row level security;
alter table public.positions            enable row level security;
alter table public.members              enable row level security;
alter table public.position_assignments enable row level security;
alter table public.imports              enable row level security;
