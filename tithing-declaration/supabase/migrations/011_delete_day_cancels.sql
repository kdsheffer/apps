-- Removing a day that people have booked.
--
-- Deleting a day was refused while anybody held a slot on it: the cascade
-- reached `slots`, whose delete trigger stops a booked slot disappearing out
-- from under a family. That guard is right for one slot deleted by a stray
-- click, and wrong for a day the ward has genuinely called off — it left the
-- secretary cancelling twenty appointments by hand before the schedule would
-- let her remove the evening.
--
-- Cancelling is the correct thing to do here, and it is exactly what the guard
-- was insisting on. So this does it: cancel every live appointment, queue each
-- family the cancellation they would have got anyway, and then remove the day.
--
-- The slot-level guard stays. Nothing about "the whole evening is off" makes it
-- safe to silently drop one family from an evening that is still happening.

create or replace function public.delete_schedule_day(
  p_day_id uuid,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  day_row   public.schedule_days%rowtype;
  appt      record;
  cancelled integer := 0;
begin
  select * into day_row from public.schedule_days where id = p_day_id;
  if not found then
    raise exception 'That day does not exist.' using errcode = 'no_data_found';
  end if;

  -- SECURITY DEFINER: RLS is not checking anything here, so this must.
  if not public.is_ward_admin(day_row.ward_id) then
    raise exception 'Only a ward admin can remove a day from the schedule.'
      using errcode = 'insufficient_privilege';
  end if;

  /* Cancelled and queued before the day goes, in that order and for that
     reason: `queue_notification` renders the message from the appointment, and
     a moment later the cascade will have deleted it. Rendering at queue time is
     what makes the notification row survive its subject — the body is already
     final text by the time `appointment_id` becomes null. */
  for appt in
    select a.id
      from public.appointments a
      join public.slots s on s.id = a.slot_id
     where s.day_id = p_day_id
       and a.cancelled_at is null
     order by s.starts_at
  loop
    update public.appointments
       set cancelled_at     = now(),
           cancelled_by     = auth.uid(),
           cancelled_reason = coalesce(
             nullif(btrim(coalesce(p_reason, '')), ''),
             'The day was removed from the schedule.'
           )
     where id = appt.id;

    perform public.queue_notification(appt.id, 'cancellation');
    cancelled := cancelled + 1;
  end loop;

  -- Now the slot guard has nothing to object to: every appointment on the day
  -- is cancelled, and a cancelled booking never blocked anything.
  delete from public.schedule_days where id = p_day_id;

  return cancelled;
end;
$$;

comment on function public.delete_schedule_day(uuid, text) is
  'Removes a day, cancelling every appointment on it and queueing each family '
  'their cancellation first. Returns how many families were told.';

revoke execute on function public.delete_schedule_day(uuid, text) from public, anon;
grant execute on function public.delete_schedule_day(uuid, text) to authenticated;
