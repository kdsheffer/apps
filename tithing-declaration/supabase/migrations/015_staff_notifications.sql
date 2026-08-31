-- Telling the right people what is happening, without tying it to what they can do.
--
-- The obvious design is to hang notifications off roles: the executive
-- secretary gets booking alerts, the bishop gets the day-before report. It
-- reads well and falls apart on contact with a real ward. Two counsellors both
-- want the report; neither should need edit rights to get it. A secretary finds
-- an email per booking too noisy in the last week; there is no way to stop it
-- without taking away her ability to manage the schedule.
--
-- Being able to change something and wanting to hear about it are separate
-- questions, so they get separate answers. Roles keep deciding what a person
-- may *do*. A subscription decides what they are *told*.
--
-- The bishop, in this model, needs no role of his own: he is a manager who has
-- subscribed to the report.

-- ---------------------------------------------------------------------------
-- 1. Roles say what you can do — and are renamed to say so
--
-- The stored values do not change: 'admin' still means full edit and 'viewer'
-- still means read-only, so no policy, function or index moves. What changes is
-- what the console calls them. "Executive Secretary" and "Bishopric" named the
-- people expected to hold them, which stops being true the moment a bishop
-- needs edit rights or a clerk needs read.
-- ---------------------------------------------------------------------------

comment on column public.ward_roles.role is
  'What this person may do: admin (manager — full edit) or viewer (read-only). '
  'Shown as "Manager" and "Viewer". What they are *told* is a separate '
  'question, answered by notification_subscriptions.';

-- ---------------------------------------------------------------------------
-- 2. Subscriptions say what you are told
--
--   booking — one email each time somebody takes a slot, with who and when.
--   digest  — one email 24 hours before a day, listing every slot and who holds
--             it, so the bishopric can see whether to chase people, move them,
--             or stand the evening down.
--
-- Keyed on the user, not an address: only somebody with ward access should be
-- receiving a ward's booking details, and the account is what establishes that.
-- ---------------------------------------------------------------------------

create table if not exists public.notification_subscriptions (
  id         uuid primary key default uuid_generate_v4(),
  ward_id    uuid not null references public.wards on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('booking', 'digest')),
  created_at timestamptz not null default now(),
  unique (ward_id, user_id, kind)
);

create index if not exists notification_subscriptions_ward
  on public.notification_subscriptions (ward_id, kind);

alter table public.notification_subscriptions enable row level security;
revoke all on public.notification_subscriptions from anon;

-- Everybody with ward access can see who is subscribed. It is not a secret,
-- and knowing the report is already going to somebody stops it being set up
-- three times.
drop policy if exists "notification_subscriptions_select" on public.notification_subscriptions;
create policy "notification_subscriptions_select" on public.notification_subscriptions
  for select using (public.is_ward_member(ward_id));

/*
 * Whether a *given* user has access to a ward.
 *
 * `is_ward_member()` answers this about the caller, which is the wrong question
 * when the row being written names somebody else. Subscribing sends a ward's
 * booking details — names, phone numbers, email addresses — to whoever is
 * named, so the check has to be about them.
 */
create or replace function public.has_ward_access(target_user uuid, target_ward uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select target_user is not null and target_ward is not null and (
    exists (
      select 1 from public.ward_roles
       where ward_id = target_ward and user_id = target_user
    )
    or exists (
      select 1 from public.profiles where id = target_user and is_super_admin
    )
  );
$$;

/* You may subscribe yourself, and an admin may subscribe anybody who already
   has access to the ward. The check is on the *subscriber*, not the caller:
   without that an admin could point a ward's booking details at any account in
   the project. */
drop policy if exists "notification_subscriptions_insert" on public.notification_subscriptions;
create policy "notification_subscriptions_insert" on public.notification_subscriptions
  for insert with check (
    public.has_ward_access(user_id, ward_id)
    and (user_id = auth.uid() or public.is_ward_admin(ward_id))
  );

drop policy if exists "notification_subscriptions_delete" on public.notification_subscriptions;
create policy "notification_subscriptions_delete" on public.notification_subscriptions
  for delete using (
    user_id = auth.uid() or public.is_ward_admin(ward_id)
  );

-- ---------------------------------------------------------------------------
-- 3. Staff messages
--
-- `notifications.appointment_id` stays null for these: a digest is about a day
-- rather than one appointment, and a booking alert must not be swept up by
-- anything that reasons about "messages for this appointment" — the reschedule
-- logic sets aside a member's stale reminder, and it has no business touching
-- the secretary's copy.
-- ---------------------------------------------------------------------------

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('confirmation', 'reminder', 'cancellation', 'reschedule', 'booking', 'digest'));

/*
 * What a day-level message is about.
 *
 * The digest needs to know it has already reported on a day, and it cannot use
 * `appointment_id` because it is about the whole evening. Identifying the day by
 * matching a date inside the subject line would work until somebody reworded
 * the subject, at which point every ward would get a second copy of every
 * report and the cause would be three files away.
 */
alter table public.notifications
  add column if not exists day_id uuid references public.schedule_days on delete set null;

create index if not exists notifications_day
  on public.notifications (day_id, kind)
  where day_id is not null;

-- ---------------------------------------------------------------------------
-- 4. "Somebody took a slot"
--
-- Queued as its own message per subscriber rather than one with several
-- recipients, so a bad address for one person cannot cost the others their
-- copy, and each row records its own delivery.
-- ---------------------------------------------------------------------------

create or replace function public.queue_booking_alerts(p_appointment_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a       public.appointments%rowtype;
  s       public.slots%rowtype;
  d       public.schedule_days%rowtype;
  w       public.wards%rowtype;
  sub     record;
  whenish text;
  queued  integer := 0;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then return 0; end if;

  select * into s from public.slots         where id = a.slot_id;
  select * into d from public.schedule_days where id = s.day_id;
  select * into w from public.wards         where id = a.ward_id;

  whenish := public.format_slot_local(s.starts_at, w.timezone);

  for sub in
    select p.email
      from public.notification_subscriptions ns
      join public.profiles p on p.id = ns.user_id
     where ns.ward_id = a.ward_id
       and ns.kind = 'booking'
       and p.email is not null
  loop
    insert into public.notifications
      (ward_id, appointment_id, kind, to_address, subject, body)
    values (
      a.ward_id,
      -- Deliberately null: this is the ward's copy, and nothing that reasons
      -- about "messages for this appointment" should reach it.
      null,
      'booking',
      sub.email,
      format('%s booked %s', a.family_name, whenish),
      format(
        E'%s has booked a tithing declaration appointment.\n\n'
        || E'When:  %s\n'
        || E'Where: %s\n'
        || E'Phone: %s\n'
        || E'Email: %s\n'
        || E'%s\n'
        || E'— %s',
        a.family_name,
        whenish,
        coalesce(nullif(btrim(d.location), ''), 'the meetinghouse'),
        coalesce(a.phone, 'not given'),
        coalesce(a.email, 'not given'),
        case when nullif(btrim(coalesce(a.notes, '')), '') is null
             then '' else E'Notes: ' || a.notes || E'\n' end,
        w.name
      )
    );
    queued := queued + 1;
  end loop;

  return queued;
end;
$$;

revoke execute on function public.queue_booking_alerts(uuid) from public, anon, authenticated;

-- Every booking runs through `queue_notification(..., 'confirmation')`, whether
-- it came from the public form or the secretary's hand, so hanging the alert
-- off the appointment itself is what makes it impossible to miss one.
create or replace function public.alert_on_new_appointment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.queue_booking_alerts(new.id);
  return new;
exception when others then
  -- Never at the cost of the booking.
  raise warning 'Could not queue booking alerts for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists appointments_alert_staff on public.appointments;
create trigger appointments_alert_staff
  after insert on public.appointments
  for each row execute procedure public.alert_on_new_appointment();

-- ---------------------------------------------------------------------------
-- 5. The day-before report
--
-- Sent 24 hours before a day's earliest appointment, listing every slot and who
-- holds it. The empty ones are the point: the bishopric wants to know whether
-- to chase people, move them together, or stand the evening down — and an
-- evening where nobody signed up is exactly the case a per-booking alert can
-- never tell them about.
-- ---------------------------------------------------------------------------

create or replace function public.queue_day_digests()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_row record;
  sub     record;
  lines   text;
  booked  integer;
  total   integer;
  queued  integer := 0;
begin
  for day_row in
    select d.id, d.ward_id, d.service_date, d.location,
           w.name as ward_name, w.timezone,
           min(s.starts_at) as first_slot
      from public.schedule_days d
      join public.slots s on s.day_id = d.id
      join public.wards w on w.id = d.ward_id
     where d.published_at is not null
     group by d.id, d.ward_id, d.service_date, d.location, w.name, w.timezone
    having min(s.starts_at) > now()
       and min(s.starts_at) <= now() + interval '24 hours'
       -- One report per day, ever.
       and not exists (
         select 1 from public.notifications n
          where n.day_id = d.id
            and n.kind = 'digest'
            and n.status in ('queued', 'sending', 'sent')
       )
  loop
    select
      string_agg(
        format('%s  %s',
               rpad(public.format_slot_local(s.starts_at, day_row.timezone), 34),
               coalesce(a.family_name, '—')),
        E'\n' order by s.starts_at
      ),
      count(a.id)::int,
      count(*)::int
      into lines, booked, total
      from public.slots s
      left join public.appointments a
        on a.slot_id = s.id and a.cancelled_at is null
     where s.day_id = day_row.id
       and s.blocked_at is null;

    for sub in
      select p.email
        from public.notification_subscriptions ns
        join public.profiles p on p.id = ns.user_id
       where ns.ward_id = day_row.ward_id
         and ns.kind = 'digest'
         and p.email is not null
    loop
      insert into public.notifications
        (ward_id, appointment_id, day_id, kind, to_address, subject, body)
      values (
        day_row.ward_id,
        null,
        day_row.id,
        'digest',
        sub.email,
        format('Tomorrow''s tithing declarations — %s (%s of %s booked)',
               to_char(day_row.service_date, 'FMDay FMDD FMMonth'), booked, total),
        format(
          E'Tithing declarations tomorrow, %s.\n\n'
          || E'%s of %s times are booked.\n\n'
          || E'%s\n\n'
          || E'%s\n'
          || E'— %s',
          coalesce(nullif(btrim(day_row.location), ''), 'at the meetinghouse'),
          booked, total,
          coalesce(lines, 'No times on this day.'),
          case when booked = 0
               then 'Nobody has signed up. You may want to stand this evening down.'
               else 'Blank rows are times nobody has taken.' end,
          day_row.ward_name
        )
      );
      queued := queued + 1;
    end loop;
  end loop;

  return queued;
end;
$$;

comment on function public.queue_day_digests() is
  'Queues the day-before report to everybody subscribed. Idempotent — a day '
  'already reported on is skipped, so the schedule can run as often as it likes.';

revoke execute on function public.queue_day_digests() from public, anon, authenticated;

grant execute on function public.has_ward_access(uuid, uuid) to anon, authenticated;
