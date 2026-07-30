# Calling Board

A tool for ward leadership to manage callings — see who's in the ward, which
callings exist, who holds them, and which are open. Boards are versioned, so you
can work through changes in a draft and publish when you're ready.

## Features

- **Board versioning** — one live board, one editable draft, and a history of the
  boards that used to be live. Promoting the draft makes it live and files the old
  live board under history.
- **Roles** — system admin (everything, everywhere), ward admin (edit one ward), ward
  viewer (read one ward). Granted from the Admin console and enforced by row-level
  security, not just by hidden buttons.
- **Organizations and subgroups** — callings nest the way the ward does: Elders Quorum
  contains its Presidency, Teachers, Ministering, Activities, and Service.
- **Flexible assignment** — a calling can hold several people (co-teachers, advisers)
  and a person can hold several callings.
- **Time in calling** — each assignment shows how long it's been held (`1y4m`), from an
  editable sustained date.
- **LCR PDF import that merges** — re-import the "Organizations and Callings" report as
  often as you like. Flags, notes, parked callings and hand-added callings survive;
  what comes across is who holds which calling.
- **Realtime sync** — changes appear live for everyone on the board, with presence
  showing who else is viewing it.
- **Multi-ward** — wards are isolated from each other by row-level security.

## Tech stack

React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · Supabase
(Postgres, Auth, Realtime) · pdf.js

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then run every file in
`supabase/migrations/` in order via the SQL editor or the Supabase CLI:

```bash
supabase db push
```

Migrations `004` and `005` seed test data — skip them for a real ward.

The migrations are covered by tests that run them against a throwaway Postgres and
check the policies and triggers actually behave. See **Scripts** below.

### 3. Configure environment

Copy the example file and fill in your project's values from
**Project Settings → API**:

```bash
cp .env.example .env.local
```

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

### 4. Grant yourself access

Sign in once so a `profiles` row is created, then promote yourself in the SQL editor:

```sql
update profiles set is_super_admin = true where id = '<your-auth-user-id>';
```

From then on the Admin console handles access: **/admin → People** lists everyone who
has signed in, toggles system admin, and grants each person Ward Admin or Ward Viewer
on any ward. There's no invite flow — somebody has to sign in once before they can be
granted anything.

You can't remove your own system admin access. That's deliberate: it's what stops the
last admin locking everyone out of the console.

### 5. Run

```bash
npm run dev
```

The app runs at `http://localhost:5173`.

## Usage

### Importing from LCR

1. In LCR, open **Reports → Organizations and Callings** and save it as a PDF.
   It must be a real PDF export — a scan or a print-to-image won't parse.
2. On the **Boards** tab, pick what to **merge into** — normally the draft you've been
   working on — then choose the file and import.
3. Review the summary, make any corrections, and promote the draft to live.

Importing never touches the live board, so it's always safe to re-run.

### What a re-import does and doesn't change

The report is merged into your draft rather than replacing it:

| | |
| --- | --- |
| Kept | Flags, notes, parked (inactive) callings, called dates, and callings you added by hand |
| Updated | Who holds each LCR calling — people in the report are called, people who've dropped out of it are released |
| Added | New organizations, callings and members the report introduces |
| Reported, never done for you | Callings that have left the report (emptied but kept), and members the report didn't mention at all |

Two rules the database enforces, whichever way you come at them: only a **vacant**
calling can be marked inactive, and an **inactive member can't hold a calling**. If the
report fills a parked calling, the calling goes active; if it calls somebody marked
inactive, they go active.

Callings you add by hand are tagged as yours and are never touched by an import — LCR
doesn't know about them, so it gets no opinion about them.

### Working with the draft

A ward has one draft. Editing the live board opens it automatically and redirects the
change into it. Promote when it's ready — that makes the draft live and moves the old
live board into history.

## How the PDF parser works

The LCR report encodes its hierarchy in layout rather than in the text itself, so
the parser reads geometry instead of pattern-matching on organization names
(`src/lib/pdfParser.ts`):

| Position | Size | Meaning |
| --- | --- | --- |
| x=34 | 12 | Organization heading |
| x=34 | 9 or 8 | Subgroup heading |
| x=35 | 8 | Callings table header — supplies the column positions |
| x=37 | 8 | Calling row: title, member, sustained date |
| x=54 | 8 | Membership roster header |
| x=34 | 8 | `Count: N`, closing the table |

Each table publishes its own column x-positions in its header row, so the calling
title, member name, and date are separated by where they sit rather than by regex.
Sections whose heading ends in "Members" are rosters and are skipped — otherwise
every name in the ward would be imported as a calling.

If LCR changes the report's layout, this is the file to revisit.

## How realtime sync works

Two settings have to be right before a single change event exists, and both fail
silently — a subscription that receives nothing looks exactly like a quiet board.
Migration `010` handles them:

- The tables have to be **in the `supabase_realtime` publication**. Outside it, Postgres
  publishes no changes at all.
- They need **`REPLICA IDENTITY FULL`**. On Postgres's default, a `DELETE` writes only the
  primary key, and Realtime matches subscription filters against the row in the payload —
  so `board_id=eq.<board>` can never match a delete, and the event is dropped. Deleting a
  calling used to sync to nobody.

On top of that, Realtime's filter grammar compares one column to a literal. There are no
joins, so "positions belonging to this board" can't be expressed — a position knows its
group, and only the group knows its board. `useRealtimeSync` therefore filters what it can
server-side (`groups.board_id`, `members.ward_id`) and matches the rest against the ids
already in the query cache (`src/lib/realtimeRelevance.ts`). When a payload can't be
identified, it refetches rather than risk dropping the change.

## Scripts

```bash
npm run dev      # dev server
npm run build    # typecheck and build to dist/
npm run preview  # serve the production build
npm test         # merge rules (pure unit tests, no database)
```

### Testing the migrations

`supabase/tests/` runs every migration against a throwaway Postgres and asserts what
the policies and triggers actually do — that a viewer can't write, that a ward admin
can't reach another ward, that an occupied calling can't be parked. It needs a local
Postgres binary, which is deliberately not an app dependency:

```bash
npm i embedded-postgres pg --prefix /tmp/pgtest
PG_TEST_MODULES=/tmp/pgtest npm run test:db
```

### Testing the merge against a real report

Unit tests only cover the cases somebody thought of. This runs the real parser and the
real planner over an actual LCR export, applies the plan, and re-merges — the property
that has to hold is that importing a report twice changes nothing the second time:

```bash
npm run verify:merge -- "path/to/Organizations and Callings.pdf"
```

Pass a second PDF to check merging across two different exports.

## Deployment

The app is a static build and deploys to Vercel as-is. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` in the project's environment variables. Add your
deployed URL to Supabase's allowed redirect URLs so sign-in works.
