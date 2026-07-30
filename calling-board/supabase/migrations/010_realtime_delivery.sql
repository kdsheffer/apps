-- Make realtime sync actually deliver.
--
-- Two things were stopping it, both invisible from the client — a subscription
-- that receives nothing looks exactly like a quiet board.
--
-- 1. Nothing ever added these tables to the `supabase_realtime` publication.
--    A table outside the publication produces no change events at all.
--
-- 2. Every table was on Postgres's default replica identity, which writes only
--    the primary key for a DELETE. Verified against the logical decoding
--    stream:
--
--      default:  DELETE: id[integer]:1
--      full:     DELETE: id[integer]:2 parent_id[integer]:9 label[text]:'y'
--
--    Realtime matches subscription filters against the row in the payload, so
--    with only an id there, a filter like `board_id=eq.<board>` can never match
--    a delete and the event is dropped. Deleting a calling synced to nobody.
--    FULL also gives UPDATE a complete `old` record, which is what lets the
--    client tell whether a row that moved *out* of the board still concerns it.
--
-- The cost is a larger WAL record per update and delete. On a few hundred
-- narrow rows per ward that is not worth measuring.

-- ---------------------------------------------------------------------------
-- Replica identity
-- ---------------------------------------------------------------------------

alter table public.groups               replica identity full;
alter table public.positions            replica identity full;
alter table public.position_assignments replica identity full;
alter table public.members              replica identity full;

-- ---------------------------------------------------------------------------
-- Publication membership
--
-- Supabase ships an empty `supabase_realtime` publication and expects tables to
-- be added to it (the dashboard's "Enable Realtime" toggle does exactly this).
-- Adding a table that is already a member is an error rather than a no-op, so
-- each one is checked first and the whole thing stays re-runnable.
-- ---------------------------------------------------------------------------

do $$
declare
  target text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach target in array array['groups', 'positions', 'position_assignments', 'members']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = target
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target);
    end if;
  end loop;
end $$;
