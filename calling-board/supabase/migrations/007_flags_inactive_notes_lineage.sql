-- Phase 10: flagging, inactive state, notes, and draft lineage.
--
-- Lineage (origin_id) is what makes promoted boards immutable. When a promoted
-- board is forked into a draft, every copied row records the id of the row it
-- came from. That lets the app take "the position the user just clicked on the
-- live board" and find its counterpart in the draft, so the click can be
-- replayed against the draft instead of being lost.

-- ---------------------------------------------------------------------------
-- Lineage
-- ---------------------------------------------------------------------------

alter table if exists public.groups
  add column if not exists origin_id uuid;

alter table if exists public.positions
  add column if not exists origin_id uuid;

alter table if exists public.position_assignments
  add column if not exists origin_id uuid;

create index if not exists idx_groups_origin_id on public.groups(origin_id);
create index if not exists idx_positions_origin_id on public.positions(origin_id);
create index if not exists idx_position_assignments_origin_id
  on public.position_assignments(origin_id);

-- One auto-created working draft per ward: edits to the live board always land
-- in the same draft rather than piling up a new one per change.
alter table if exists public.boards
  add column if not exists is_working_draft boolean not null default false;

create unique index if not exists boards_one_working_draft_per_ward
  on public.boards (ward_id)
  where is_working_draft;

-- ---------------------------------------------------------------------------
-- Flags, inactive state, notes
-- ---------------------------------------------------------------------------

-- Positions are board-scoped, so these travel with the board when it's copied.
alter table if exists public.positions
  add column if not exists flagged boolean not null default false;

alter table if exists public.positions
  add column if not exists inactive_at timestamp with time zone;

alter table if exists public.positions
  add column if not exists notes text;

-- Members are ward-scoped, so flags and notes persist across board versions.
-- archived_at already exists and is what "inactive" means for a member.
alter table if exists public.members
  add column if not exists flagged boolean not null default false;

alter table if exists public.members
  add column if not exists notes text;

create index if not exists idx_positions_flagged on public.positions(flagged) where flagged;
create index if not exists idx_members_flagged on public.members(flagged) where flagged;

-- ---------------------------------------------------------------------------
-- Members need a delete policy for the members tab, and positions/groups need
-- sort_order updates for reordering. RLS policies for these tables already
-- cover select/insert/update; add the missing delete on members.
-- ---------------------------------------------------------------------------

drop policy if exists "members_deletable_by_ward_admin" on public.members;

create policy "members_deletable_by_ward_admin" on public.members
  for delete using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = members.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
