-- Seed global catalog positions with standard LDS ward organizations
insert into public.catalog_positions (group_name, position_title, ward_id) values
  ('Bishopric', 'Bishop', null),
  ('Bishopric', 'First Counselor', null),
  ('Bishopric', 'Second Counselor', null),
  ('High Council', 'Member', null),
  ('Elders Quorum', 'President', null),
  ('Elders Quorum', 'First Counselor', null),
  ('Elders Quorum', 'Second Counselor', null),
  ('Elders Quorum', 'Secretary', null),
  ('Relief Society', 'President', null),
  ('Relief Society', 'First Counselor', null),
  ('Relief Society', 'Second Counselor', null),
  ('Relief Society', 'Secretary', null),
  ('Young Men', 'President', null),
  ('Young Men', 'First Counselor', null),
  ('Young Men', 'Second Counselor', null),
  ('Young Men', 'Secretary', null),
  ('Young Women', 'President', null),
  ('Young Women', 'First Counselor', null),
  ('Young Women', 'Second Counselor', null),
  ('Young Women', 'Secretary', null),
  ('Primary', 'President', null),
  ('Primary', 'First Counselor', null),
  ('Primary', 'Second Counselor', null),
  ('Sunday School', 'President', null),
  ('Sunday School', 'First Counselor', null),
  ('Sunday School', 'Second Counselor', null),
  ('Nursery', 'Leader', null),
  ('Ward Clerk', 'Ward Clerk', null),
  ('Ward Counselor', 'Ward Counselor', null),
  ('Music Director', 'Director', null)
on conflict (group_name, position_title, ward_id) do nothing;

-- Trigger: auto-provision a profile for new auth.users
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, is_super_admin)
  values (new.id, false);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
