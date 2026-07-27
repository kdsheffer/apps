# Calling Board

A tool for ward leadership to manage callings — see who's in the ward, which
callings exist, who holds them, and which are open. Boards are versioned, so you
can work through changes in a draft and publish when you're ready.

## Features

- **Board versioning** — one promoted (live) board plus editable drafts. Promoting a
  draft archives the old live board and clears the other drafts.
- **Organizations and subgroups** — callings nest the way the ward does: Elders Quorum
  contains its Presidency, Teachers, Ministering, Activities, and Service.
- **Flexible assignment** — a calling can hold several people (co-teachers, advisers)
  and a person can hold several callings.
- **Time in calling** — each assignment shows how long it's been held (`1y4m`), from an
  editable sustained date.
- **LCR PDF import** — upload the "Organizations and Callings" report and get a draft
  board with organizations, callings, vacancies, and members already filled in.
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

Create a project at [supabase.com](https://supabase.com), then run the migrations in
`supabase/migrations/` in order (001 → 006) via the SQL editor or the Supabase CLI:

```bash
supabase db push
```

Migrations `004` and `005` seed test data — skip them for a real ward.

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

Super admins can create wards and grant ward-admin access from the Admin page.

### 5. Run

```bash
npm run dev
```

The app runs at `http://localhost:5173`.

## Usage

### Importing from LCR

1. In LCR, open **Reports → Organizations and Callings** and save it as a PDF.
   It must be a real PDF export — a scan or a print-to-image won't parse.
2. On the board page, choose the file under **Import from LCR PDF** and import.
3. The import creates a *draft* board. Review it, make any corrections, then
   promote it to live.

Importing never touches the live board, so it's safe to re-run.

### Working with drafts

Create a draft from the live board, edit freely, and promote when it's ready.
Promoting archives the previous live board and deletes the other outstanding
drafts, so coordinate before promoting if others are mid-edit.

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

## Scripts

```bash
npm run dev      # dev server
npm run build    # typecheck and build to dist/
npm run preview  # serve the production build
```

## Deployment

The app is a static build and deploys to Vercel as-is. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` in the project's environment variables. Add your
deployed URL to Supabase's allowed redirect URLs so sign-in works.
