-- Roles, a single editable draft, and the invariants the LCR merge depends on.
--
-- Three things happen here, and they are related:
--
--   1. Access becomes a three-role model — system admin, ward admin, ward
--      viewer — so `ward_admins` grows a role and is renamed `ward_roles`.
--      Read policies now accept viewers; write policies still require an admin.
--
--   2. Board versioning collapses to one editable draft per ward plus a history
--      of promoted boards. `boards.is_working_draft` goes away: a ward's draft
--      *is* the working draft, and a partial unique index makes that true.
--
--   3. Active state gets real invariants. A calling with somebody in it can't be
--      inactive, and an inactive member can't hold a calling. Assigning somebody
--      reactivates both sides rather than failing. The import merge leans on
--      this: it can assign freely and let the database keep the rules.

-- ---------------------------------------------------------------------------
-- 1. Profiles carry the identity the admin console needs
--
-- auth.users isn't readable through the anon key, so the console has nothing to
-- show but UUIDs. Mirror email and name onto the profile instead, kept in sync
-- by the same trigger that provisions the row.
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, is_super_admin, email, full_name)
  values (
    new.id,
    false,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    )
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- A changed email (or a name filled in on first social sign-in) has to reach
-- the profile too, or the console shows a stale address forever.
create or replace function public.handle_user_updated()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles
     set email     = new.email,
         full_name = coalesce(
           new.raw_user_meta_data ->> 'full_name',
           new.raw_user_meta_data ->> 'name',
           full_name
         )
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute procedure public.handle_user_updated();

-- Backfill everyone who signed up before the columns existed.
update public.profiles p
   set email     = u.email,
       full_name = coalesce(
         u.raw_user_meta_data ->> 'full_name',
         u.raw_user_meta_data ->> 'name',
         p.full_name
       )
  from auth.users u
 where u.id = p.id
   and (p.email is distinct from u.email or p.full_name is null);

-- And provision a profile for any auth user that predates the trigger.
insert into public.profiles (id, is_super_admin, email, full_name)
select u.id,
       false,
       u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------------------------------------------------------------------------
-- 2. ward_admins becomes ward_roles
--
-- The table already answers "who may touch this ward"; it just needs to answer
-- "and in what capacity". Renaming keeps the rows, the foreign keys, and the
-- policies attached to them.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'ward_admins')
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'ward_roles')
  then
    alter table public.ward_admins rename to ward_roles;
  end if;
end $$;

alter table public.ward_roles
  add column if not exists role text not null default 'admin';

do $$
begin
  alter table public.ward_roles
    add constraint ward_roles_role_check check (role in ('admin', 'viewer'));
exception when duplicate_object then null;
end $$;

comment on table public.ward_roles is
  'Who may see or change a ward. role=admin can edit; role=viewer is read-only. '
  'Site-wide access is profiles.is_super_admin instead.';

-- ---------------------------------------------------------------------------
-- 3. Authorization helpers
--
-- Same SECURITY DEFINER approach migration 008 introduced — they read the
-- tables with RLS bypassed so an authorization check can't re-enter the policy
-- that is using it. `is_ward_admin` now means "may write"; `is_ward_member`
-- means "may read".
-- ---------------------------------------------------------------------------

create or replace function public.is_ward_admin(target_ward uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select target_ward is not null and (
    exists (
      select 1 from public.ward_roles
      where ward_id = target_ward and user_id = auth.uid() and role = 'admin'
    )
    or public.is_super_admin()
  );
$$;

create or replace function public.is_ward_member(target_ward uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select target_ward is not null and (
    exists (
      select 1 from public.ward_roles
      where ward_id = target_ward and user_id = auth.uid()
    )
    or public.is_super_admin()
  );
$$;

/*
 * True when the caller administers a ward the target user also belongs to.
 * This is what lets a ward admin see the email addresses of the people they
 * granted access to, without opening up the whole user list.
 */
create or replace function public.shares_administered_ward(target_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.ward_roles theirs
      join public.ward_roles mine on mine.ward_id = theirs.ward_id
     where theirs.user_id = target_user
       and mine.user_id = auth.uid()
       and mine.role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Policies
--
-- Reads widen to ward members; writes stay with ward admins. Every policy is
-- dropped by name first so the migration is safe to re-run.
-- ---------------------------------------------------------------------------

-- profiles ------------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;

create policy "profiles_select" on public.profiles
  for select using (
    id = auth.uid()
    or public.is_super_admin()
    or public.shares_administered_ward(id)
  );

-- Super admins promote and demote other people from the admin console. The
-- `id <> auth.uid()` clause is the safety catch: nobody can drop their own
-- super-admin bit, so the last admin can't lock themselves out by misclick.
create policy "profiles_update" on public.profiles
  for update using (public.is_super_admin() and id <> auth.uid())
  with check (public.is_super_admin() and id <> auth.uid());

-- The policy says *which rows*; this says *which column*. Without it a super
-- admin could rewrite anyone's email out from under auth.users.
revoke update on public.profiles from authenticated;
grant update (is_super_admin) on public.profiles to authenticated;

-- Rows still come from the on_auth_user_created trigger only.

-- wards ---------------------------------------------------------------------
drop policy if exists "wards_select" on public.wards;
create policy "wards_select" on public.wards
  for select using (public.is_ward_member(id));

-- ward_roles ----------------------------------------------------------------
drop policy if exists "ward_admins_select" on public.ward_roles;
drop policy if exists "ward_admins_insert" on public.ward_roles;
drop policy if exists "ward_admins_delete" on public.ward_roles;
drop policy if exists "ward_roles_select" on public.ward_roles;
drop policy if exists "ward_roles_insert" on public.ward_roles;
drop policy if exists "ward_roles_update" on public.ward_roles;
drop policy if exists "ward_roles_delete" on public.ward_roles;

create policy "ward_roles_select" on public.ward_roles
  for select using (public.is_ward_member(ward_id));

create policy "ward_roles_insert" on public.ward_roles
  for insert with check (public.is_ward_admin(ward_id));

create policy "ward_roles_update" on public.ward_roles
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));

create policy "ward_roles_delete" on public.ward_roles
  for delete using (public.is_ward_admin(ward_id));

-- catalog_positions ---------------------------------------------------------
drop policy if exists "catalog_positions_select" on public.catalog_positions;
create policy "catalog_positions_select" on public.catalog_positions
  for select using (
    (ward_id is null and auth.uid() is not null)
    or public.is_ward_member(ward_id)
  );

-- boards --------------------------------------------------------------------
drop policy if exists "boards_select" on public.boards;
create policy "boards_select" on public.boards
  for select using (public.is_ward_member(ward_id));

-- groups --------------------------------------------------------------------
drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups
  for select using (public.is_ward_member(public.ward_of_board(board_id)));

-- positions -----------------------------------------------------------------
drop policy if exists "positions_select" on public.positions;
create policy "positions_select" on public.positions
  for select using (public.is_ward_member(public.ward_of_group(group_id)));

-- members -------------------------------------------------------------------
drop policy if exists "members_select" on public.members;
drop policy if exists "members_deletable_by_ward_admin" on public.members;
drop policy if exists "members_delete" on public.members;

create policy "members_select" on public.members
  for select using (public.is_ward_member(ward_id));

create policy "members_delete" on public.members
  for delete using (public.is_ward_admin(ward_id));

-- position_assignments ------------------------------------------------------
drop policy if exists "position_assignments_select" on public.position_assignments;
create policy "position_assignments_select" on public.position_assignments
  for select using (public.is_ward_member(public.ward_of_position(position_id)));

-- imports -------------------------------------------------------------------
drop policy if exists "imports_select" on public.imports;
create policy "imports_select" on public.imports
  for select using (public.is_ward_member(ward_id));

alter table public.ward_roles enable row level security;

-- ---------------------------------------------------------------------------
-- 5. One editable draft per ward
--
-- Existing wards may hold several drafts from the old model. Rather than throw
-- that work away, keep one — the working draft if there is one, otherwise the
-- newest — and archive the rest so they stay reachable as history.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'boards'
       and column_name = 'is_working_draft'
  ) then
    with ranked as (
      select id,
             row_number() over (
               partition by ward_id
               order by is_working_draft desc, created_at desc
             ) as rank
        from public.boards
       where status = 'draft'
    )
    update public.boards
       set status = 'archived'
     where id in (select id from ranked where rank > 1);

    drop index if exists public.boards_one_working_draft_per_ward;
    alter table public.boards drop column is_working_draft;
  end if;
end $$;

create unique index if not exists boards_one_draft_per_ward
  on public.boards (ward_id)
  where status = 'draft';

-- ---------------------------------------------------------------------------
-- 6. Where a calling came from
--
-- The merge treats callings from LCR as the report's to manage: if one drops
-- out of the report, whoever held it was released. Callings somebody added by
-- hand aren't in LCR at all and must survive every import untouched — so each
-- position records which it is. Everything that exists today came from an
-- import, so that's the backfill.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'positions'
       and column_name = 'source'
  ) then
    -- Added with 'import' as the default so every existing row is backfilled by
    -- the ALTER itself, then switched to 'manual' for everything created after.
    -- Doing it this way makes the backfill impossible to re-run: a second pass
    -- finds the column already there and skips the block entirely, so callings
    -- added by hand later can never be relabelled as LCR's.
    alter table public.positions add column source text not null default 'import';
    alter table public.positions alter column source set default 'manual';
  end if;
end $$;

do $$
begin
  alter table public.positions
    add constraint positions_source_check check (source in ('import', 'manual'));
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Active-state invariants
--
-- "Inactive" means "this seat is deliberately not being filled" for a calling,
-- and "this person isn't available" for a member. Neither survives contact with
-- an assignment, so the database enforces it in both directions:
--
--   * marking a calling inactive fails while somebody holds it
--   * marking a member inactive fails while they hold a calling
--   * assigning somebody reactivates the calling and the member
--
-- The last one is a reactivation rather than an error on purpose: it's what an
-- LCR import should do when a seat the ward had parked comes back filled.
-- ---------------------------------------------------------------------------

-- Data written before these rules existed can already break them. Repair it
-- first, or the invariants would be true only of rows touched from now on.
update public.positions p
   set inactive_at = null
 where p.inactive_at is not null
   and exists (select 1 from public.position_assignments where position_id = p.id);

update public.members m
   set archived_at = null
 where m.archived_at is not null
   and exists (
     select 1
       from public.position_assignments pa
       join public.positions p on p.id = pa.position_id
       join public.groups    g on g.id = p.group_id
       join public.boards    b on b.id = g.board_id
      where pa.member_id = m.id
        and b.status in ('promoted', 'draft')
   );

create or replace function public.enforce_position_inactive_vacant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Only a calling being *made* inactive is checked. Clearing inactive_at is
  -- always allowed, which is what lets the assignment trigger below reactivate.
  if new.inactive_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.inactive_at is not null then
    return new;
  end if;

  if exists (select 1 from public.position_assignments where position_id = new.id) then
    raise exception
      'Release everyone from "%" before marking it inactive — only a vacant calling can be inactive.',
      new.title
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists positions_inactive_must_be_vacant on public.positions;
create trigger positions_inactive_must_be_vacant
  before insert or update on public.positions
  for each row execute procedure public.enforce_position_inactive_vacant();

create or replace function public.enforce_member_active_when_called()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  holding text;
begin
  if new.archived_at is not null and old.archived_at is null then
    select string_agg(p.title, ', ')
      into holding
      from public.position_assignments pa
      join public.positions p on p.id = pa.position_id
      join public.groups    g on g.id = p.group_id
      join public.boards    b on b.id = g.board_id
     where pa.member_id = new.id
       and b.status in ('promoted', 'draft');

    if holding is not null then
      raise exception
        'Release % from % before marking them inactive.', new.full_name, holding
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists members_inactive_must_be_uncalled on public.members;
create trigger members_inactive_must_be_uncalled
  before update on public.members
  for each row execute procedure public.enforce_member_active_when_called();

/* The reactivating half. Giving a parked calling somebody puts it back in
   service, and calling an inactive member brings them back — which is exactly
   what an import should do, without the caller having to remember to. */
create or replace function public.reactivate_on_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.positions
     set inactive_at = null
   where id = new.position_id and inactive_at is not null;

  update public.members
     set archived_at = null
   where id = new.member_id and archived_at is not null;

  return new;
end;
$$;

drop trigger if exists assignments_reactivate on public.position_assignments;
create trigger assignments_reactivate
  after insert on public.position_assignments
  for each row execute procedure public.reactivate_on_assignment();

-- ---------------------------------------------------------------------------
-- 8. Import bookkeeping
--
-- The merge needs somewhere to record what it did, and which board it merged
-- against, so a surprising result can be traced back to its report.
-- ---------------------------------------------------------------------------

alter table public.imports add column if not exists base_board_id uuid
  references public.boards on delete set null;
alter table public.imports add column if not exists summary jsonb;

drop policy if exists "imports_update" on public.imports;
create policy "imports_update" on public.imports
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));
