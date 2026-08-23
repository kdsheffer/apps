-- Core schema: who can get in, when declarations are held, and who booked what.
--
-- The shape of this app is unusual for a Supabase project, and the whole design
-- follows from one requirement: **most of the people who use it are never
-- signed in**. A member opens a link, picks a time, types a name and a phone
-- number, and leaves. Only the executive secretary and the bishopric ever
-- authenticate.
--
-- That splits the database into two surfaces:
--
--   * The **authenticated surface** — every table below — is reached directly
--     with row-level security, exactly the way calling-board works. `anon` is
--     granted nothing at all here. Not a narrowed policy: nothing.
--
--   * The **public surface** is a handful of SECURITY DEFINER functions added
--     in migration 003. They are the only way a signed-out visitor touches any
--     of this, and each one returns the smallest possible answer — "this time
--     is free", never "the Andersons have 6:15".
--
-- Doing it with functions rather than permissive policies is what makes the
-- privacy requirement enforceable. RLS filters rows but cannot hide columns, so
-- any policy letting anon read `appointments` to work out which slots are taken
-- would also hand them every family name and phone number in the ward. A
-- function returns a boolean instead, and there is no column to leak.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. Identity
--
-- Same pattern calling-board settled on: a `profiles` row mirrors each auth
-- user, because auth.users isn't readable through the publishable key and the
-- admin console has nothing to show but UUIDs otherwise.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id             uuid primary key references auth.users on delete cascade,
  created_at     timestamptz not null default now(),
  is_super_admin boolean not null default false,
  email          text,
  full_name      text
);

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

-- ---------------------------------------------------------------------------
-- 2. Wards
--
-- `slug` is what appears in the link handed round the ward
-- (/w/riverbend-3rd), so it is stable, lowercase, and unique across the site.
--
-- `timezone` is not decoration. Slots are stored as `timestamptz`, but the
-- executive secretary thinks in "6:00pm to 8:30pm on the 12th", and 6:00pm
-- means different instants either side of a daylight-saving change. Generating
-- slots against a named zone is the only way an evening that crosses one still
-- lands on the right wall-clock times.
-- ---------------------------------------------------------------------------

create table if not exists public.wards (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null check (length(btrim(name)) between 2 and 120),
  slug          text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  timezone      text not null default 'America/Denver',
  -- Free text shown at the top of the public booking page: where to come, what
  -- to bring, who to call. Optional.
  instructions  text,
  contact_name  text,
  contact_phone text,
  created_at    timestamptz not null default now(),
  created_by    uuid not null references auth.users on delete restrict
);

-- A bad timezone name would not fail until slot generation ran, by which point
-- the ward looks fine and the schedule silently isn't. Reject it at write time.
create or replace function public.assert_valid_timezone()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception '% is not a known timezone name (try America/Denver).', new.timezone
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists wards_timezone_valid on public.wards;
create trigger wards_timezone_valid
  before insert or update of timezone on public.wards
  for each row execute procedure public.assert_valid_timezone();

-- ---------------------------------------------------------------------------
-- 3. Roles
--
-- Two roles, the same two calling-board uses, because the same people are
-- involved and a third would only be a role nobody remembers the meaning of.
--
--   admin  — the executive secretary. Builds the schedule, sees every booking,
--            adds people by hand, sends reminders.
--   viewer — bishopric and clerks. Sees the schedule, changes nothing.
--
-- Site-wide access is `profiles.is_super_admin`, which outranks both.
-- ---------------------------------------------------------------------------

create table if not exists public.ward_roles (
  id         uuid primary key default uuid_generate_v4(),
  ward_id    uuid not null references public.wards on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null default 'admin' check (role in ('admin', 'viewer')),
  granted_by uuid not null references auth.users on delete restrict,
  granted_at timestamptz not null default now(),
  unique (ward_id, user_id)
);

comment on table public.ward_roles is
  'Who may see or change a ward''s schedule. role=admin can edit and sees '
  'contact details; role=viewer is read-only. Site-wide access is '
  'profiles.is_super_admin instead.';

-- ---------------------------------------------------------------------------
-- 4. Authorization helpers
--
-- SECURITY DEFINER so they read the role tables with RLS bypassed. Without
-- that, a policy on `ward_roles` that consults `ward_roles` recurses.
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
 * True when the caller administers a ward the target user also belongs to —
 * what lets a ward admin see the email addresses of the people they granted
 * access to, without opening up the whole user list.
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
-- 5. The schedule
--
-- A `schedule_day` is one evening (or morning) of declarations, and it owns the
-- slots inside it. Grouping them buys two things worth the extra table:
--
--   * `published_at`. The executive secretary builds a day, looks at it, fixes
--     it, and only then opens it. An unpublished day is invisible to the public
--     surface, so nobody books into a half-built evening.
--   * Somewhere for the things that are true of the whole evening — where it
--     is, and any note about it — instead of repeating them on 40 slots.
-- ---------------------------------------------------------------------------

create table if not exists public.schedule_days (
  id           uuid primary key default uuid_generate_v4(),
  ward_id      uuid not null references public.wards on delete cascade,
  service_date date not null,
  location     text,
  notes        text,
  -- Non-null means the public booking page will show it. There is no third
  -- state: a day is either open for booking or it is the secretary's business.
  published_at timestamptz,
  created_by   uuid not null references auth.users on delete restrict,
  created_at   timestamptz not null default now(),
  unique (ward_id, service_date)
);

/*
 * One appointment slot.
 *
 * `starts_at` is an instant; the ward's timezone turns it back into a time on a
 * clock. `duration_minutes` is what the interview is *scheduled* for — the
 * fifteen minutes of buffer that follow are simply not modelled. Three slots an
 * hour at :00, :15 and :30 leaves :45 unrepresented, and a gap in the table is
 * a better way to say "nothing happens then" than a row nobody may book.
 *
 * `blocked_at` is the exception the secretary needs anyway: a slot that exists,
 * sits in the middle of the evening, and is deliberately not bookable.
 */
create table if not exists public.slots (
  id               uuid primary key default uuid_generate_v4(),
  day_id           uuid not null references public.schedule_days on delete cascade,
  starts_at        timestamptz not null,
  duration_minutes integer not null default 15 check (duration_minutes between 5 and 120),
  blocked_at       timestamptz,
  blocked_reason   text,
  created_at       timestamptz not null default now(),
  unique (day_id, starts_at)
);

create index if not exists slots_day_starts_at on public.slots (day_id, starts_at);

-- Which ward a slot or day belongs to, for the policies below. SECURITY
-- DEFINER for the same reason as the role helpers: a policy on `slots` that
-- reaches through `schedule_days` would otherwise need a policy on that too.
create or replace function public.ward_of_day(target_day uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select ward_id from public.schedule_days where id = target_day;
$$;

create or replace function public.ward_of_slot(target_slot uuid)
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select d.ward_id
    from public.slots s
    join public.schedule_days d on d.id = s.day_id
   where s.id = target_slot;
$$;

-- ---------------------------------------------------------------------------
-- 6. Appointments
--
-- One family, one slot. `slot_id` is not unique on its own because a cancelled
-- booking stays on the row as history — the partial index below is what makes
-- "one at a time" true while still remembering who cancelled.
--
-- Two identifiers, doing different jobs:
--
--   confirmation_code  short, readable, said out loud over the phone. Unique so
--                      the secretary can search by it, but *never* sufficient
--                      to cancel — six characters is guessable.
--   cancel_token       a UUID, handed back only to somebody who has already
--                      proved they know the family name and the phone number.
--                      This is what actually authorizes a cancellation.
-- ---------------------------------------------------------------------------

create table if not exists public.appointments (
  id                uuid primary key default uuid_generate_v4(),
  slot_id           uuid not null references public.slots on delete cascade,
  -- Denormalized from the slot's day so policies and the admin schedule can
  -- filter by ward without a join. A trigger keeps it honest.
  ward_id           uuid not null references public.wards on delete cascade,

  family_name       text not null check (length(btrim(family_name)) between 2 and 80),
  phone             text not null,
  -- The comparison key for lookups: 8015550123, (801) 555-0123 and
  -- 801-555-0123 are the same number and a member will not retype it the way
  -- they first typed it.
  phone_digits      text generated always as (regexp_replace(phone, '\D', '', 'g')) stored,
  email             text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  notes             text,

  confirmation_code text not null unique,
  cancel_token      uuid not null default uuid_generate_v4(),

  -- Set when the booking was made by somebody signed in, which is what lets
  -- them see and cancel it from "My appointment" later.
  booked_by         uuid references auth.users on delete set null,
  -- True when the secretary entered it on somebody's behalf. Kept because it
  -- changes what a reminder should say, and who to chase if it's wrong.
  booked_by_admin   boolean not null default false,

  cancelled_at      timestamptz,
  cancelled_by      uuid references auth.users on delete set null,
  cancelled_reason  text,

  created_at        timestamptz not null default now()
);

-- A phone number is the only handle most bookings have. Something shaped like
-- one is required; anything more specific would reject a legitimate number.
do $$
begin
  alter table public.appointments
    add constraint appointments_phone_plausible
    check (length(regexp_replace(phone, '\D', '', 'g')) between 7 and 15);
exception when duplicate_object then null;
end $$;

/* The rule the whole booking flow rests on: a slot holds at most one live
   appointment. Enforced here rather than in the booking function because two
   people tapping "Book" in the same second both pass any check the function
   could make, and only the index is atomic. */
create unique index if not exists appointments_one_live_per_slot
  on public.appointments (slot_id)
  where cancelled_at is null;

create index if not exists appointments_ward_lookup
  on public.appointments (ward_id, phone_digits)
  where cancelled_at is null;

create index if not exists appointments_slot on public.appointments (slot_id);

/*
 * Keep `ward_id` equal to the slot's ward, and refuse a booking whose slot
 * cannot take one.
 *
 * The checks are here, not only in the booking function, because the secretary
 * inserts rows directly through PostgREST when adding somebody by hand. A rule
 * that lives in one of two write paths is a rule that holds half the time.
 */
create or replace function public.enforce_appointment_slot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  slot_row   public.slots%rowtype;
  day_row    public.schedule_days%rowtype;
begin
  select * into slot_row from public.slots where id = new.slot_id;
  if not found then
    raise exception 'That time slot no longer exists.' using errcode = 'foreign_key_violation';
  end if;

  select * into day_row from public.schedule_days where id = slot_row.day_id;

  new.ward_id := day_row.ward_id;

  -- Only ever checked when a booking is created or moved. Cancelling a
  -- booking on a slot that has since been blocked has to keep working.
  if tg_op = 'INSERT' or new.slot_id is distinct from old.slot_id then
    if slot_row.blocked_at is not null then
      raise exception 'That time is not available.' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_slot_consistent on public.appointments;
create trigger appointments_slot_consistent
  before insert or update on public.appointments
  for each row execute procedure public.enforce_appointment_slot();

/*
 * Cancellation is a state change, not a delete, and it only goes one way.
 * Un-cancelling would quietly re-take a slot somebody else may already have
 * booked — the partial unique index would refuse it anyway, but with an error
 * about an index rather than one a person can act on.
 */
create or replace function public.enforce_cancellation_final()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.cancelled_at is not null and new.cancelled_at is null then
    raise exception
      'A cancelled appointment cannot be reinstated — book the slot again instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_cancellation_final on public.appointments;
create trigger appointments_cancellation_final
  before update on public.appointments
  for each row execute procedure public.enforce_cancellation_final();

/*
 * A short code people can read to each other. The alphabet drops the
 * characters that get misheard or mistyped — no O/0, no I/1, no S/5 — because
 * this code's whole job is to survive being said over the phone.
 *
 * It is an identifier, not a secret. Cancelling needs the cancel_token.
 */
create or replace function public.new_confirmation_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
  candidate text;
  attempt   integer := 0;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    exit when not exists (
      select 1 from public.appointments where confirmation_code = candidate
    );

    attempt := attempt + 1;
    if attempt > 50 then
      -- 30^6 is about 700 million; fifty collisions means something is wrong
      -- with the random source, not that the space is full.
      raise exception 'Could not allocate a confirmation code.';
    end if;
  end loop;

  return candidate;
end;
$$;

alter table public.appointments
  alter column confirmation_code set default public.new_confirmation_code();

-- ---------------------------------------------------------------------------
-- 7. Notifications
--
-- A queue, not a send. Postgres cannot make an HTTP request, and neither can
-- the browser without putting a provider API key in front of the public — so
-- rows land here and the `dispatch-notifications` Edge Function drains them.
--
-- Queueing rather than calling also means the record of what was sent survives
-- the provider being down, misconfigured, or swapped out. `status` tells the
-- secretary which of those happened instead of leaving her wondering whether
-- the reminder went.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id             uuid primary key default uuid_generate_v4(),
  ward_id        uuid not null references public.wards on delete cascade,
  appointment_id uuid references public.appointments on delete set null,

  channel        text not null check (channel in ('email', 'sms')),
  kind           text not null check (kind in ('confirmation', 'reminder', 'cancellation')),
  -- Copied, not joined. What was sent should still read correctly after the
  -- appointment is cancelled or the family fixes a typo in their number.
  to_address     text not null,
  subject        text,
  body           text not null,

  status         text not null default 'queued'
                   check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts       integer not null default 0,
  error          text,
  sent_at        timestamptz,

  requested_by   uuid references auth.users on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists notifications_pending
  on public.notifications (ward_id, created_at)
  where status = 'queued';

create index if not exists notifications_appointment
  on public.notifications (appointment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. Lookup attempts
--
-- "Find my appointment" takes a family name and a phone number and gives back
-- a booking. That is, unavoidably, an oracle: enough guesses would confirm
-- whether a given number is booked.
--
-- This table is the brake. Migration 003 counts recent rows before answering,
-- so a client that starts working through numbers is cut off. It is a speed
-- limit rather than a wall — the honest mitigation for the real thing is a
-- one-time code sent to the number, which is exactly what the SMS channel
-- above unlocks when it goes live.
-- ---------------------------------------------------------------------------

create table if not exists public.lookup_attempts (
  id           bigserial primary key,
  ward_id      uuid references public.wards on delete cascade,
  -- Whatever the request could be tied to — forwarded IP if the platform gave
  -- us one, otherwise the digits that were searched for. Never the raw name.
  fingerprint  text not null,
  succeeded    boolean not null,
  attempted_at timestamptz not null default now()
);

create index if not exists lookup_attempts_recent
  on public.lookup_attempts (fingerprint, attempted_at desc);

-- ---------------------------------------------------------------------------
-- 9. Row-level security
--
-- Every table is protected, and `anon` is granted nothing anywhere. Signed-out
-- visitors reach the app only through the functions in migration 003.
--
-- Read access follows the roles: a ward member (admin or viewer) sees their
-- ward's schedule and bookings. Write access requires admin. The one deliberate
-- widening is `appointments_select`, which also matches a booking's own owner
-- so a signed-in member can find their time without being in the ward's roles.
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.wards           enable row level security;
alter table public.ward_roles      enable row level security;
alter table public.schedule_days   enable row level security;
alter table public.slots           enable row level security;
alter table public.appointments    enable row level security;
alter table public.notifications   enable row level security;
alter table public.lookup_attempts enable row level security;

-- Supabase grants table privileges to these roles by default. Revoke anon's
-- outright: the public surface is functions, and a policy accidentally written
-- as `using (true)` later should still not open a table to the world.
revoke all on public.wards           from anon;
revoke all on public.schedule_days   from anon;
revoke all on public.slots           from anon;
revoke all on public.appointments    from anon;
revoke all on public.notifications   from anon;
revoke all on public.lookup_attempts from anon;
revoke all on public.ward_roles      from anon;
revoke all on public.profiles        from anon;

-- profiles ------------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (
    id = auth.uid()
    or public.is_super_admin()
    or public.shares_administered_ward(id)
  );

-- Super admins promote and demote from the admin console. `id <> auth.uid()`
-- is the safety catch: nobody can drop their own super-admin bit, so the last
-- admin can't lock everyone out by misclick.
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (public.is_super_admin() and id <> auth.uid())
  with check (public.is_super_admin() and id <> auth.uid());

-- The policy says which rows; this says which column. Without it a super admin
-- could rewrite anyone's email out from under auth.users.
revoke update on public.profiles from authenticated;
grant update (is_super_admin) on public.profiles to authenticated;

-- Rows come from the on_auth_user_created trigger only.

-- wards ---------------------------------------------------------------------
drop policy if exists "wards_select" on public.wards;
create policy "wards_select" on public.wards
  for select using (public.is_ward_member(id));

drop policy if exists "wards_insert" on public.wards;
create policy "wards_insert" on public.wards
  for insert with check (public.is_super_admin());

drop policy if exists "wards_update" on public.wards;
create policy "wards_update" on public.wards
  for update using (public.is_ward_admin(id))
  with check (public.is_ward_admin(id));

drop policy if exists "wards_delete" on public.wards;
create policy "wards_delete" on public.wards
  for delete using (public.is_super_admin());

-- ward_roles ----------------------------------------------------------------
drop policy if exists "ward_roles_select" on public.ward_roles;
create policy "ward_roles_select" on public.ward_roles
  for select using (public.is_ward_member(ward_id));

drop policy if exists "ward_roles_insert" on public.ward_roles;
create policy "ward_roles_insert" on public.ward_roles
  for insert with check (public.is_ward_admin(ward_id));

drop policy if exists "ward_roles_update" on public.ward_roles;
create policy "ward_roles_update" on public.ward_roles
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));

drop policy if exists "ward_roles_delete" on public.ward_roles;
create policy "ward_roles_delete" on public.ward_roles
  for delete using (public.is_ward_admin(ward_id));

-- schedule_days -------------------------------------------------------------
drop policy if exists "schedule_days_select" on public.schedule_days;
create policy "schedule_days_select" on public.schedule_days
  for select using (public.is_ward_member(ward_id));

drop policy if exists "schedule_days_insert" on public.schedule_days;
create policy "schedule_days_insert" on public.schedule_days
  for insert with check (public.is_ward_admin(ward_id));

drop policy if exists "schedule_days_update" on public.schedule_days;
create policy "schedule_days_update" on public.schedule_days
  for update using (public.is_ward_admin(ward_id))
  with check (public.is_ward_admin(ward_id));

drop policy if exists "schedule_days_delete" on public.schedule_days;
create policy "schedule_days_delete" on public.schedule_days
  for delete using (public.is_ward_admin(ward_id));

-- slots ---------------------------------------------------------------------
drop policy if exists "slots_select" on public.slots;
create policy "slots_select" on public.slots
  for select using (public.is_ward_member(public.ward_of_day(day_id)));

drop policy if exists "slots_insert" on public.slots;
create policy "slots_insert" on public.slots
  for insert with check (public.is_ward_admin(public.ward_of_day(day_id)));

drop policy if exists "slots_update" on public.slots;
create policy "slots_update" on public.slots
  for update using (public.is_ward_admin(public.ward_of_day(day_id)))
  with check (public.is_ward_admin(public.ward_of_day(day_id)));

drop policy if exists "slots_delete" on public.slots;
create policy "slots_delete" on public.slots
  for delete using (public.is_ward_admin(public.ward_of_day(day_id)));

-- appointments --------------------------------------------------------------
/* Ward members see their ward's bookings; anyone else sees only bookings they
   made while signed in. The second half is what "if they are authenticated
   they should be able to see their appointment time" means in policy terms. */
drop policy if exists "appointments_select" on public.appointments;
create policy "appointments_select" on public.appointments
  for select using (
    booked_by = auth.uid()
    or public.is_ward_member(ward_id)
  );

-- Direct inserts are the secretary adding somebody by hand. A member booking
-- for themselves goes through book_slot() in migration 003 instead, which is
-- also the only path open to somebody who isn't signed in.
drop policy if exists "appointments_insert" on public.appointments;
create policy "appointments_insert" on public.appointments
  for insert with check (public.is_ward_admin(ward_id));

/* An admin may edit any booking in their ward. A signed-in member may touch
   their own — but only to cancel it, which the trigger below enforces.
   The policy picks the row; the trigger picks the columns. Without it, "cancel
   my appointment" would also be "rewrite my appointment's phone number".

   This is a trigger rather than a column grant because the rule depends on who
   is asking. Grants attach to the role, and both the secretary and the member
   are `authenticated` — narrowing the columns there would lock the secretary
   out of the edits she is supposed to make. */
drop policy if exists "appointments_update" on public.appointments;
create policy "appointments_update" on public.appointments
  for update using (
    booked_by = auth.uid()
    or public.is_ward_admin(ward_id)
  )
  with check (
    booked_by = auth.uid()
    or public.is_ward_admin(ward_id)
  );

drop policy if exists "appointments_delete" on public.appointments;
create policy "appointments_delete" on public.appointments
  for delete using (public.is_ward_admin(ward_id));

/*
 * A transaction-local escape hatch for the trigger below.
 *
 * `claim_appointment()` in migration 004 exists precisely to set `booked_by`,
 * which is one of the columns the trigger refuses to let a member touch — so
 * without this the two rules cancel each other out and claiming always fails.
 *
 * The flag is set with `is_local => true`, so it lives for one transaction and
 * PostgREST gives each request its own. A client cannot set it: it can only
 * reach the database through the RPCs, and the ones that raise it do their own
 * authorization first. Even granting it away would buy nothing — RLS still
 * restricts the update to the caller's own booking, which the secretary could
 * edit for them anyway.
 */
create or replace function public.privileged_write()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.privileged_write', true), '') = 'on';
$$;

/*
 * What a member may change about their own booking: whether it is cancelled,
 * and nothing else. Admins are unaffected.
 */
create or replace function public.enforce_member_update_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_ward_admin(old.ward_id) or public.privileged_write() then
    return new;
  end if;

  if (new.slot_id, new.family_name, new.phone, new.email, new.notes,
      new.confirmation_code, new.cancel_token, new.booked_by, new.booked_by_admin,
      new.ward_id, new.created_at)
     is distinct from
     (old.slot_id, old.family_name, old.phone, old.email, old.notes,
      old.confirmation_code, old.cancel_token, old.booked_by, old.booked_by_admin,
      old.ward_id, old.created_at)
  then
    raise exception
      'You can cancel this appointment, but only the executive secretary can change its details.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_member_update_scope on public.appointments;
create trigger appointments_member_update_scope
  before update on public.appointments
  for each row execute procedure public.enforce_member_update_scope();

-- notifications -------------------------------------------------------------
drop policy if exists "notifications_select" on public.notifications;
create policy "notifications_select" on public.notifications
  for select using (public.is_ward_member(ward_id));

drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (public.is_ward_admin(ward_id));

/* Nothing else may update a notification. The Edge Function marks rows sent or
   failed with the service role, which bypasses RLS — letting a browser move a
   row out of `queued` would let it quietly suppress a reminder. */

-- lookup_attempts -----------------------------------------------------------
/* No policies at all. Rows are written by the SECURITY DEFINER lookup function
   and read by nobody through PostgREST — a rate-limit ledger that clients can
   read is a rate-limit ledger that tells an attacker how close they are. */
