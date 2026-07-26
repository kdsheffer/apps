-- Phase 1: Core schema and RLS policies for calling-board

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- Profiles table (mirrors auth.users, adds admin flag)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  created_at timestamp with time zone not null default now(),
  is_super_admin boolean not null default false
);

alter table public.profiles enable row level security;

create policy "profiles_readable_by_self" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_super_admin_can_see_all" on public.profiles
  for select using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Wards table (one row per ward)
create table if not exists public.wards (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_at timestamp with time zone not null default now(),
  created_by uuid not null references auth.users on delete restrict
);

alter table public.wards enable row level security;

create policy "wards_readable_by_admins" on public.wards
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = wards.id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "wards_insertable_by_super_admin" on public.wards
  for insert with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Ward admins join table (who can edit a specific ward)
create table if not exists public.ward_admins (
  id uuid primary key default uuid_generate_v4(),
  ward_id uuid not null references public.wards on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  granted_by uuid not null references auth.users on delete restrict,
  granted_at timestamp with time zone not null default now(),
  unique (ward_id, user_id)
);

alter table public.ward_admins enable row level security;

create policy "ward_admins_readable_by_admin" on public.ward_admins
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = ward_admins.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "ward_admins_insertable_by_super_admin_or_ward_admin" on public.ward_admins
  for insert with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
    or
    exists (
      select 1 from public.ward_admins wa
      where wa.ward_id = ward_admins.ward_id and wa.user_id = auth.uid()
    )
  );

create policy "ward_admins_deletable_by_super_admin_or_ward_admin" on public.ward_admins
  for delete using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
    or
    exists (
      select 1 from public.ward_admins wa
      where wa.ward_id = ward_admins.ward_id and wa.user_id = auth.uid()
    )
  );

-- Catalog positions (reusable standard positions + ward-specific additions)
create table if not exists public.catalog_positions (
  id uuid primary key default uuid_generate_v4(),
  group_name text not null,
  position_title text not null,
  ward_id uuid references public.wards on delete cascade,
  created_at timestamp with time zone not null default now(),
  unique (group_name, position_title, ward_id)
);

alter table public.catalog_positions enable row level security;

create policy "catalog_positions_readable_by_ward_admin_or_global" on public.catalog_positions
  for select using (
    ward_id is null
    or
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = catalog_positions.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "catalog_positions_insertable_by_ward_admin" on public.catalog_positions
  for insert with check (
    (ward_id is not null and
     auth.uid() in (
       select user_id from public.ward_admins where ward_id = catalog_positions.ward_id
     ))
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Boards (versions: promoted, draft, archived)
create type board_status as enum ('promoted', 'draft', 'archived');

create table if not exists public.boards (
  id uuid primary key default uuid_generate_v4(),
  ward_id uuid not null references public.wards on delete cascade,
  status board_status not null default 'draft',
  name text not null,
  parent_board_id uuid references public.boards on delete set null,
  created_by uuid not null references auth.users on delete restrict,
  created_at timestamp with time zone not null default now(),
  promoted_at timestamp with time zone
);

alter table public.boards enable row level security;

-- Partial unique index: only one promoted board per ward
create unique index if not exists boards_one_promoted_per_ward
  on public.boards (ward_id)
  where status = 'promoted';

create policy "boards_readable_by_ward_admin" on public.boards
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = boards.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "boards_insertable_by_ward_admin" on public.boards
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = boards.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "boards_updatable_by_ward_admin" on public.boards
  for update using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = boards.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "boards_deletable_by_ward_admin" on public.boards
  for delete using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = boards.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Groups (organizations like Bishopric, Elders Quorum, etc.)
create table if not exists public.groups (
  id uuid primary key default uuid_generate_v4(),
  board_id uuid not null references public.boards on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now()
);

alter table public.groups enable row level security;

create policy "groups_readable_by_ward_admin" on public.groups
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (select ward_id from public.boards where id = groups.board_id)
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "groups_insertable_by_ward_admin" on public.groups
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (select ward_id from public.boards where id = groups.board_id)
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "groups_updatable_by_ward_admin" on public.groups
  for update using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (select ward_id from public.boards where id = groups.board_id)
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "groups_deletable_by_ward_admin" on public.groups
  for delete using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (select ward_id from public.boards where id = groups.board_id)
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Positions (callings within a group)
create table if not exists public.positions (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups on delete cascade,
  title text not null,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now()
);

alter table public.positions enable row level security;

create policy "positions_readable_by_ward_admin" on public.positions
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select ward_id from public.boards
        where id = (select board_id from public.groups where id = positions.group_id)
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "positions_insertable_by_ward_admin" on public.positions
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select ward_id from public.boards
        where id = (select board_id from public.groups where id = positions.group_id)
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "positions_updatable_by_ward_admin" on public.positions
  for update using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select ward_id from public.boards
        where id = (select board_id from public.groups where id = positions.group_id)
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "positions_deletable_by_ward_admin" on public.positions
  for delete using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select ward_id from public.boards
        where id = (select board_id from public.groups where id = positions.group_id)
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Members (ward members, not board-scoped so they persist across draft copies)
create table if not exists public.members (
  id uuid primary key default uuid_generate_v4(),
  ward_id uuid not null references public.wards on delete cascade,
  full_name text not null,
  contact_info jsonb,
  archived_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

alter table public.members enable row level security;

create policy "members_readable_by_ward_admin" on public.members
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = members.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "members_insertable_by_ward_admin" on public.members
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = members.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "members_updatable_by_ward_admin" on public.members
  for update using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = members.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Position assignments (many-to-many join with called_date)
create table if not exists public.position_assignments (
  id uuid primary key default uuid_generate_v4(),
  position_id uuid not null references public.positions on delete cascade,
  member_id uuid not null references public.members on delete cascade,
  called_date date not null default current_date,
  created_at timestamp with time zone not null default now()
);

alter table public.position_assignments enable row level security;

create policy "position_assignments_readable_by_ward_admin" on public.position_assignments
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select members.ward_id from public.members
        where id = position_assignments.member_id
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "position_assignments_insertable_by_ward_admin" on public.position_assignments
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select members.ward_id from public.members
        where id = position_assignments.member_id
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "position_assignments_updatable_by_ward_admin" on public.position_assignments
  for update using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select members.ward_id from public.members
        where id = position_assignments.member_id
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "position_assignments_deletable_by_ward_admin" on public.position_assignments
  for delete using (
    auth.uid() in (
      select user_id from public.ward_admins
      where ward_id = (
        select members.ward_id from public.members
        where id = position_assignments.member_id
      )
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

-- Imports tracking
create table if not exists public.imports (
  id uuid primary key default uuid_generate_v4(),
  ward_id uuid not null references public.wards on delete cascade,
  uploaded_by uuid not null references auth.users on delete restrict,
  file_name text not null,
  status text not null default 'pending',
  resulting_board_id uuid references public.boards on delete set null,
  raw_text text,
  created_at timestamp with time zone not null default now()
);

alter table public.imports enable row level security;

create policy "imports_readable_by_ward_admin" on public.imports
  for select using (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = imports.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "imports_insertable_by_ward_admin" on public.imports
  for insert with check (
    auth.uid() in (
      select user_id from public.ward_admins where ward_id = imports.ward_id
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
