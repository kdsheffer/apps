-- Making "at most one of these" a database rule instead of a hopeful check.
--
-- Every place that must not send a message twice asked the same way: "does one
-- already exist?", then inserted if not. Between the question and the answer,
-- another connection can ask and get the same answer, and both insert. Under
-- READ COMMITTED that is not a rare interleaving — it is what happens whenever
-- two dispatchers run at once.
--
-- And two dispatchers run at once routinely. A single booking writes two rows —
-- the member's confirmation and the ward's alert — and each one asks the
-- dispatcher to deliver it. Two requests, arriving together, each sweeping.
--
-- The check-then-insert is replaced by a unique index. A key that must be
-- unique cannot be raced: the second insert fails, the function catches it, and
-- there is no interleaving where both survive. The old checks stay as well,
-- because failing quietly on the common path is nicer than raising and being
-- caught on it.

-- ---------------------------------------------------------------------------
-- 1. The key
--
-- Only set where "at most one, ever" is genuinely true. A reschedule notice is
-- deliberately absent: somebody may move their appointment twice, and both
-- times they should hear about it.
--
-- The index covers only live and delivered rows. A message set aside because
-- the appointment moved, or one that failed for good, must not block the
-- replacement it exists to make room for.
-- ---------------------------------------------------------------------------

alter table public.notifications add column if not exists dedupe_key text;

comment on column public.notifications.dedupe_key is
  'Identity of a message that must exist at most once — kind, what it is about, '
  'and who it is for. Null where repeats are legitimate, as with a reschedule.';

create unique index if not exists notifications_no_duplicates
  on public.notifications (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'sending', 'sent');

-- ---------------------------------------------------------------------------
-- 2. Member messages
-- ---------------------------------------------------------------------------

create or replace function public.queue_notification(
  p_appointment_id uuid,
  p_kind           text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a   public.appointments%rowtype;
  msg record;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  if a.email is null then
    return 0;
  end if;

  select * into msg from public.render_notification(p_appointment_id, p_kind);

  begin
    insert into public.notifications
      (ward_id, appointment_id, kind, to_address, subject, body, requested_by, dedupe_key)
    values
      (a.ward_id, a.id, p_kind, a.email, msg.subject, msg.body, auth.uid(),
       -- A reschedule may legitimately happen more than once.
       case when p_kind = 'reschedule' then null
            else format('%s:%s:%s', p_kind, a.id, a.email) end);
  exception when unique_violation then
    -- Somebody else queued the same message first. Nothing to do and nothing
    -- wrong: the message is on its way.
    return 0;
  end;

  return 1;
end;
$$;

revoke execute on function public.queue_notification(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Booking alerts
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
    begin
      insert into public.notifications
        (ward_id, appointment_id, kind, to_address, subject, body, dedupe_key)
      values (
        a.ward_id,
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
        ),
        -- One alert per booking per recipient, whatever else happens.
        format('booking:%s:%s', a.id, sub.email)
      );
      queued := queued + 1;
    exception when unique_violation then
      null;   -- already told
    end;
  end loop;

  return queued;
end;
$$;

revoke execute on function public.queue_booking_alerts(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The day-before report
--
-- Same key, plus an advisory lock on the sweep itself. The unique index makes
-- duplicates impossible; the lock stops a second dispatcher doing the work
-- anyway and discarding it. `pg_try_advisory_xact_lock` returns rather than
-- waits, so the loser gets on with delivering instead of blocking.
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
  -- An arbitrary constant, private to this function. Another sweep already
  -- inside it will do the work; there is nothing to gain by waiting for it.
  if not pg_try_advisory_xact_lock(hashtext('queue_day_digests')) then
    return 0;
  end if;

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
      begin
        insert into public.notifications
          (ward_id, appointment_id, day_id, kind, to_address, subject, body, dedupe_key)
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
          ),
          format('digest:%s:%s', day_row.id, sub.email)
        );
        queued := queued + 1;
      exception when unique_violation then
        null;
      end;
    end loop;
  end loop;

  return queued;
end;
$$;

revoke execute on function public.queue_day_digests() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Reminders
--
-- The same lock, for the same reason. The per-message key is set by
-- `queue_notification` above, so a reminder that slips past the lock still
-- cannot become a second copy.
-- ---------------------------------------------------------------------------

create or replace function public.queue_due_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  appt   record;
  queued integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('queue_due_reminders')) then
    return 0;
  end if;

  for appt in
    select a.id
      from public.appointments a
      join public.slots s         on s.id = a.slot_id
      join public.schedule_days d on d.id = s.day_id
      join public.wards w         on w.id = a.ward_id
     where a.cancelled_at is null
       and d.published_at is not null
       and s.starts_at > now()
       and s.starts_at <= now() + make_interval(hours => w.reminder_lead_hours)
       and not exists (
         select 1 from public.notifications n
          where n.appointment_id = a.id
            and n.kind = 'reminder'
            and n.status in ('queued', 'sending', 'sent')
       )
     order by s.starts_at
  loop
    queued := queued + public.queue_notification(appt.id, 'reminder');
  end loop;

  return queued;
end;
$$;

revoke execute on function public.queue_due_reminders() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. A message set aside stops holding its key
--
-- `reschedule_appointment` marks the old reminder 'skipped' so a fresh one can
-- be queued for the new time. The index already ignores 'skipped', so that
-- keeps working — this is only here to say the interaction was considered
-- rather than survived by luck.
-- ---------------------------------------------------------------------------

comment on index public.notifications_no_duplicates is
  'At most one live or delivered message per dedupe_key. Excludes skipped and '
  'failed rows deliberately: a reminder set aside by a reschedule, or one that '
  'failed for good, must not block the replacement that takes its place.';
