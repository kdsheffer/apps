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

-- Supabase ships an empty publication of this name and expects tables to be
-- added to it. Migration 010 creates it if it's missing, but having it here
-- means the tests exercise the "already exists" path a real project takes.
do $$ begin
  create publication supabase_realtime;
exception when duplicate_object then null;
end $$;

-- Supabase grants table privileges to these roles by default, and keeps doing
-- so for tables created later. RLS is what actually restricts them.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
