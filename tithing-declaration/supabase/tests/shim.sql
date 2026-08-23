-- The parts of Supabase the migrations depend on, recreated for a bare
-- Postgres so the migrations can be run and tested locally.
--
-- Only what the migrations actually touch is here: the `auth.users` columns
-- they read, `auth.uid()`, and the roles policies are granted to. `auth.uid()`
-- reads a session GUC rather than a real JWT, which is what lets a test switch
-- identities with `set_config('request.jwt.claim.sub', ...)`.

create extension if not exists "uuid-ossp";

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default uuid_generate_v4(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

-- Supabase grants table privileges to these roles by default, and keeps doing
-- so for tables created later. RLS is what actually restricts them — which is
-- why migration 001's explicit `revoke ... from anon` is load-bearing, and why
-- this default has to be here for the tests to prove it.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
