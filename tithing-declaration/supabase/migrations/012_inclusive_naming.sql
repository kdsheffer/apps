-- Wording that fits a ward, not just the households in it.
--
-- Every message addressed its reader as "the Sheffer family". Plenty of members
-- declaring tithing are not a family: single adults, widows, missionaries,
-- somebody whose household is one person. Being called a family by a form is a
-- small thing and a persistent one, and it costs nothing to stop.
--
-- The name the booking is under is unchanged — a household still types
-- "Sheffer" and an individual types their own name. What changes is that the
-- app stops asserting which of those it is.
--
-- The column keeps its name. `family_name` is an internal identifier that no
-- member ever sees, and renaming it would touch every function signature, the
-- client, and the tests for no behaviour anybody can observe. The comment below
-- is there so the next reader knows the naming is deliberate rather than left
-- over.

comment on column public.appointments.family_name is
  'The name this appointment is booked under — a household name or one '
  'person''s name. User-facing text says "name", never "family name": not '
  'everybody declaring tithing is a family.';

-- ---------------------------------------------------------------------------
-- The messages
--
-- Rewritten from migration 008 with the word removed. The greeting becomes
-- "Hello %s," which reads correctly whether the name is "Sheffer" or
-- "Sister Ellis", and the cancellation drops the possessive — "the appointment
-- for %s" avoids both "the Sheffer family's" and the awkward "Jones's".
-- ---------------------------------------------------------------------------

create or replace function public.render_notification(
  p_appointment_id uuid,
  p_kind           text
)
returns table (subject text, body text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a          public.appointments%rowtype;
  s          public.slots%rowtype;
  d          public.schedule_days%rowtype;
  w          public.wards%rowtype;
  whenish    text;
  place      text;
  contact    text;
  cancel_url text;
begin
  select * into a from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'No such appointment.' using errcode = 'no_data_found';
  end if;

  select * into s from public.slots         where id = a.slot_id;
  select * into d from public.schedule_days where id = s.day_id;
  select * into w from public.wards         where id = a.ward_id;

  whenish    := public.format_slot_local(s.starts_at, w.timezone);
  place      := coalesce(nullif(btrim(d.location), ''), 'the meetinghouse');
  contact    := coalesce(
    nullif(btrim(coalesce(w.contact_name, '') || ' ' || coalesce(w.contact_phone, '')), ''),
    'the ward clerk'
  );
  cancel_url := public.site_url() || '/cancel/' || a.cancel_token::text;

  subject := case p_kind
    when 'confirmation' then format('Tithing declaration confirmed — %s', whenish)
    when 'reminder'     then format('Tomorrow: tithing declaration %s', whenish)
    when 'cancellation' then format('Tithing declaration cancelled — %s', whenish)
  end;

  if p_kind = 'cancellation' then
    body := format(
      E'The tithing declaration appointment for %s has been cancelled.\n\n'
      || E'It was scheduled for %s at %s.\n\n'
      || E'If this was a mistake, you can book another time at %s\n'
      || E'or contact %s.\n\n'
      || E'— %s',
      a.family_name, whenish, place,
      public.site_url() || '/w/' || w.slug,
      contact, w.name
    );
  else
    body := format(
      E'Hello %s,\n\n'
      || E'%s\n\n'
      || E'Where: %s\n\n'
      || E'%s'
      || E'Need to cancel? Use this link — it works until the appointment starts:\n%s\n\n'
      || E'Questions: %s\n\n'
      || E'— %s',
      a.family_name,
      case p_kind
        when 'reminder' then 'A reminder that your tithing declaration appointment is ' || whenish || '.'
        else 'Your tithing declaration appointment is ' || whenish || '.'
      end,
      place,
      case when nullif(btrim(coalesce(w.instructions, '')), '') is null
           then '' else w.instructions || E'\n\n' end,
      cancel_url,
      contact, w.name
    );
  end if;

  return next;
end;
$$;

revoke execute on function public.render_notification(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- And the refusals
--
-- These are read by the executive secretary rather than a member, but the same
-- thing applies and they are one line each.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_slot_free_to_remove()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  held_by text;
begin
  select family_name into held_by
    from public.appointments
   where slot_id = old.id and cancelled_at is null
   limit 1;

  if held_by is not null then
    raise exception
      '% is booked at that time. Cancel that appointment before removing the slot.',
      held_by
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

create or replace function public.enforce_slot_free_to_block()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  held_by text;
begin
  if new.blocked_at is null or old.blocked_at is not null then
    return new;
  end if;

  select family_name into held_by
    from public.appointments
   where slot_id = new.id and cancelled_at is null
   limit 1;

  if held_by is not null then
    raise exception
      '% is booked at that time. Cancel that appointment before blocking the slot.',
      held_by
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
