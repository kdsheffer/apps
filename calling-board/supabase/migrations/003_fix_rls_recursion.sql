-- Fix infinite recursion in RLS policies by simplifying the wards policy

-- Drop the problematic policy
drop policy if exists "wards_readable_by_admins" on public.wards;

-- Create a simplified policy that checks ward_admins without recursion
create policy "wards_readable_by_admins" on public.wards
  for select using (
    exists (
      select 1 from public.ward_admins
      where ward_id = wards.id
        and user_id = auth.uid()
    )
    or
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
