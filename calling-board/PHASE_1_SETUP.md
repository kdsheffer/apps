# Phase 1: Database Schema & RLS Setup

## Prerequisites

You should have:
1. Supabase project created at https://app.supabase.com
2. `.env.local` file with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
3. Supabase CLI installed: `npm install -g supabase` or via the agent skills

## Running migrations

### Option A: Via Supabase Dashboard (Manual)

1. Go to https://app.supabase.com → your project → SQL Editor
2. Create a new query and paste the contents of `supabase/migrations/001_initial_schema.sql`
3. Run it (Cmd+Enter)
4. Create another query and paste `supabase/migrations/002_seed_and_triggers.sql`
5. Run it

### Option B: Via Supabase CLI (Recommended)

```bash
# Link your local project to Supabase
supabase link --project-ref <your-project-ref>

# Push migrations
supabase db push
```

Your project ref is the part of your Supabase URL after `https://` and before `.supabase.co`.

## Testing RLS Isolation

Once migrations are applied, test the RLS policies by creating two test wards and verifying cross-ward queries return no data:

```sql
-- Create test ward 1
insert into public.wards (name, created_by) values ('Ward A', auth.uid())
  returning id as ward_a_id;

-- Create test ward 2
insert into public.wards (name, created_by) values ('Ward B', auth.uid())
  returning id as ward_b_id;

-- Grant yourself admin for Ward A only
insert into public.ward_admins (ward_id, user_id, granted_by)
  values ('<ward_a_id>', auth.uid(), auth.uid());

-- Query wards (should only see Ward A due to RLS)
select * from public.wards;

-- This should work (Ward A)
select * from public.groups where board_id in (
  select id from public.boards where ward_id = '<ward_a_id>'
);

-- This should fail or return empty (Ward B, no access)
select * from public.groups where board_id in (
  select id from public.boards where ward_id = '<ward_b_id>'
);
```

## Next Steps

Once migrations are applied and you've verified RLS works:
- Phase 2: Auth UI (Google/Apple sign-in, profile auto-provisioning)
- Run: `npm run dev` to start the dev server

## Troubleshooting

- **"Missing Supabase environment variables"**: Check `.env.local` has `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
- **RLS policies not working**: Ensure auth context is set (in Supabase SQL editor, you're authenticated)
- **Migration errors**: Check column names and types match — Postgres is strict about type mismatches
