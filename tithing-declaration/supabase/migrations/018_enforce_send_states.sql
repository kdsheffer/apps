-- Making a dispatcher that skips the claim fail loudly instead of duplicating.
--
-- A message is only ever sent once because the dispatcher *claims* it first:
-- one statement moves it from 'queued' to 'sending', and `for update skip
-- locked` means a second dispatcher takes different rows. That is the whole
-- guarantee.
--
-- Which means it is a guarantee held entirely in the Edge Function. A
-- dispatcher that selects queued rows, sends them, and marks them afterwards
-- works perfectly in testing, produces no error, and quietly sends every
-- message twice whenever two of them overlap. That is exactly what happened:
-- an older deployment stayed live through several migrations, and the first
-- symptom was a bishopric inbox with two copies of the same alert.
--
-- Nothing in the database was in a position to notice, because 'queued' →
-- 'sent' is a perfectly ordinary UPDATE. So this makes it not ordinary. The
-- states are now a state machine, and the only road to 'sent' runs through
-- 'sending' — which is to say, through the claim.
--
-- Run this *after* deploying the current dispatcher. It turns a silent
-- duplicate into a loud refusal, which is the right trade, but only once
-- something is there to take the legal path.

create or replace function public.enforce_notification_states()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  /*
   * queued  → sending   a dispatcher claimed it
   *         → skipped   set aside before anybody tried
   * sending → sent      delivered
   *         → queued    failed, and worth another go
   *         → failed    failed enough times
   *         → skipped   superseded mid-flight, as by a reschedule
   * sent    → skipped   superseded after delivery; the reminder for a time
   *                     that has since moved
   * failed  → skipped   tidying up
   */
  if not (
    (old.status = 'queued'  and new.status in ('sending', 'skipped'))
    or (old.status = 'sending' and new.status in ('sent', 'queued', 'failed', 'skipped'))
    or (old.status = 'sent'    and new.status = 'skipped')
    or (old.status = 'failed'  and new.status = 'skipped')
  ) then
    raise exception
      'A message cannot go from % to %. Delivery must claim a message first — '
      'see claim_notifications(). A dispatcher that marks queued messages sent '
      'without claiming them will send some of them twice.',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_state_machine on public.notifications;
create trigger notifications_state_machine
  before update of status on public.notifications
  for each row execute procedure public.enforce_notification_states();

comment on function public.enforce_notification_states() is
  'The only road to "sent" runs through "sending", which is to say through the '
  'claim. Turns a dispatcher that skips claiming from a silent source of '
  'duplicates into an immediate, obvious failure.';
