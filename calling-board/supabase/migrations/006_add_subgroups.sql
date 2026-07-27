-- Add parent_group_id to support hierarchical groups (subgroups)
alter table if exists public.groups
add column parent_id uuid references public.groups(id) on delete cascade;

-- Add index for efficient subgroup lookups
create index if not exists idx_groups_parent_id on public.groups(parent_id);

-- Add index for sorting groups by parent
create index if not exists idx_groups_parent_sort on public.groups(parent_id, sort_order);
