// Runs the real parser and the real merge planner against a real LCR export.
//
// Synthetic fixtures can only test the cases somebody thought of. This applies
// a plan to an in-memory board and re-merges the same report, which is the one
// property that has to hold on real data: importing a report you have already
// imported must change nothing.
//
// Usage: node scripts/verify-merge.mjs <report.pdf> [second-report.pdf]
//
// Passing a second report checks the merge across two different exports — most
// usefully the roster-less variant, which names far fewer people. That case has
// to leave the missing people alone rather than sweeping them off the board.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import esbuild from 'esbuild'

async function loadModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' })
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

const { parseCallingReport } = await loadModule('../src/lib/pdfParser.ts')
const { planImportMerge, summarize, emptySnapshot } = await loadModule('../src/lib/mergeImport.ts')

// --- Read the PDF the same way the browser does ------------------------------

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/verify-merge.mjs <report.pdf>')
  process.exit(1)
}

async function read(path) {
  const data = new Uint8Array(readFileSync(path))
  const pdf = await getDocument({ data }).promise

  const rows = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    const buckets = []
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue
      const y = item.transform[5]
      const x = Math.round(item.transform[4])
      const height = Math.round(item.height ?? 0)
      let b = buckets.find((b) => Math.abs(b.y - y) <= 2)
      if (!b) {
        b = { y, height, cells: [] }
        buckets.push(b)
      }
      b.height = Math.max(b.height, height)
      b.cells.push({ x, text: item.str.trim() })
    }
    buckets.sort((a, b) => b.y - a.y)
    for (const b of buckets) {
      b.cells.sort((a, b) => a.x - b.x)
      rows.push({ height: b.height, cells: b.cells })
    }
  }

  return parseCallingReport(rows)
}

const parsed = await read(file)

// --- Apply a plan to an in-memory board --------------------------------------
// Mirrors what applyMerge.ts does against Postgres, minus the network.

let seq = 0
const newId = (prefix) => `${prefix}-${++seq}`

function apply(plan, board) {
  const next = {
    groups: board.groups.map((g) => ({ ...g })),
    positions: board.positions.map((p) => ({ ...p })),
    assignments: board.assignments.map((a) => ({ ...a })),
    members: board.members.map((m) => ({ ...m })),
  }

  const memberIds = new Map()
  for (const name of plan.createMembers) {
    const id = newId('member')
    memberIds.set(name, id)
    next.members.push({ id, full_name: name, archived_at: null })
  }

  for (const id of plan.reactivateMembers) {
    const member = next.members.find((m) => m.id === id)
    if (member) member.archived_at = null
  }

  const groupIds = new Map()
  for (const group of plan.createGroups) {
    const id = newId('group')
    groupIds.set(group.key, id)
    const parent = group.parentRef
      ? 'existing' in group.parentRef
        ? group.parentRef.existing
        : groupIds.get(group.parentRef.created)
      : null
    assert.ok(
      !group.parentRef || parent,
      `parent of ${group.name} must already exist — plan ordering is wrong`
    )
    next.groups.push({ id, name: group.name, parent_id: parent ?? null })
  }

  const positionIds = new Map()
  for (const position of plan.createPositions) {
    const id = newId('position')
    positionIds.set(position.key, id)
    const groupId =
      'existing' in position.groupRef
        ? position.groupRef.existing
        : groupIds.get(position.groupRef.created)
    assert.ok(groupId, `group for ${position.title} must exist`)
    next.positions.push({
      id,
      group_id: groupId,
      title: position.title,
      sort_order: position.sortOrder,
      inactive_at: null,
      source: 'import',
    })
  }

  const released = new Set(plan.releaseAssignments)
  next.assignments = next.assignments.filter((a) => !released.has(a.id))

  for (const id of plan.reactivatePositions) {
    const position = next.positions.find((p) => p.id === id)
    if (position) position.inactive_at = null
  }

  for (const assignment of plan.createAssignments) {
    const positionId =
      'existing' in assignment.positionRef
        ? assignment.positionRef.existing
        : positionIds.get(assignment.positionRef.created)
    const memberId =
      'existing' in assignment.memberRef
        ? assignment.memberRef.existing
        : memberIds.get(assignment.memberRef.created)
    assert.ok(positionId && memberId, 'every assignment must resolve to real rows')
    next.assignments.push({ id: newId('assignment'), position_id: positionId, member_id: memberId })
  }

  return next
}

const check = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    console.error(`  ✗ ${label}\n    ${error.message}`)
    process.exitCode = 1
  }
}

// --- 1. First import ----------------------------------------------------------

console.log(`\nReport: ${file}`)
console.log(
  `Parsed ${parsed.groups.length} organizations, ` +
    `${parsed.groups.reduce((n, g) => n + g.positions.length, 0)} callings, ` +
    `${parsed.allMembers.size} members\n`
)

const first = planImportMerge(parsed, emptySnapshot)
const board = apply(first, emptySnapshot)
console.log('First import:', summarize(first))

check('every calling in the report reaches the board', () => {
  const expected = parsed.groups.reduce((n, g) => n + g.positions.length, 0)
  assert.equal(board.positions.length, expected)
})

check('everyone named in the report is on the board', () => {
  assert.equal(board.members.length, parsed.allMembers.size)
})

check('nothing is released on a first import', () => {
  assert.equal(first.releaseAssignments.length, 0)
})

// --- 2. Re-import the identical report ----------------------------------------

const again = planImportMerge(parsed, board)
console.log('\nRe-import of the same report:', summarize(again))

check('re-importing an unchanged report changes nothing', () => {
  assert.deepEqual(
    {
      groups: again.createGroups.length,
      positions: again.createPositions.length,
      members: again.createMembers.length,
      called: again.createAssignments.length,
      released: again.releaseAssignments.length,
      retired: again.retired.length,
      absent: again.absentMembers.length,
      reactivatedPositions: again.reactivatePositions.length,
      reactivatedMembers: again.reactivateMembers.length,
    },
    {
      groups: 0,
      positions: 0,
      members: 0,
      called: 0,
      released: 0,
      retired: 0,
      absent: 0,
      reactivatedPositions: 0,
      reactivatedMembers: 0,
    }
  )
})

check('every existing assignment is recognised as unchanged', () => {
  assert.equal(again.keptAssignments, board.assignments.length)
})

// --- 3. Re-import over hand edits ---------------------------------------------
// The scenario the merge exists for: a ward has been working on the board, then
// pulls a fresh report.

const edited = {
  groups: board.groups.map((g) => ({ ...g })),
  positions: board.positions.map((p) => ({ ...p })),
  assignments: board.assignments.map((a) => ({ ...a })),
  members: board.members.map((m) => ({ ...m })),
}

const parked = edited.positions.find(
  (p) => !edited.assignments.some((a) => a.position_id === p.id)
)
assert.ok(parked, 'the report should contain at least one vacant calling')
parked.inactive_at = '2026-01-01T00:00:00Z'

const manual = {
  id: 'manual-position',
  group_id: edited.groups[0].id,
  title: 'Ward Website Coordinator',
  sort_order: 999,
  inactive_at: null,
  source: 'manual',
}
edited.positions.push(manual)
edited.members.push({ id: 'manual-member', full_name: 'Volunteer, Local', archived_at: null })
edited.assignments.push({
  id: 'manual-assignment',
  position_id: manual.id,
  member_id: 'manual-member',
})

const third = planImportMerge(parsed, edited)
console.log('\nRe-import over hand edits:', summarize(third))

check('a calling parked by hand stays parked when the report agrees it is vacant', () => {
  assert.ok(!third.reactivatePositions.includes(parked.id))
})

check('the hand-added calling keeps its person', () => {
  assert.ok(!third.releaseAssignments.includes('manual-assignment'))
})

check('the hand-added calling is not reported as retired', () => {
  assert.ok(!third.retired.some((r) => r.id === manual.id))
})

check('the hand-added member is reported as absent from the report, not archived', () => {
  assert.ok(third.absentMembers.some((m) => m.id === 'manual-member'))
})

check('nothing else is disturbed', () => {
  assert.equal(third.createPositions.length, 0)
  assert.equal(third.createGroups.length, 0)
  assert.equal(third.releaseAssignments.length, 0)
})

// --- 4. A report with real changes in it --------------------------------------

const changed = structuredClone({
  groups: parsed.groups,
  allMembers: [...parsed.allMembers],
})
changed.allMembers = new Set(changed.allMembers)

// Release the first person the report shows in a calling, and give the calling
// to somebody new.
outer: for (const group of changed.groups) {
  for (const position of group.positions) {
    if (position.callings.length > 0) {
      position.callings = [{ memberName: 'Brand, New', calledDate: '2026-07-01' }]
      changed.allMembers.add('Brand, New')
      break outer
    }
  }
}

const fourth = planImportMerge(changed, board)
console.log('\nReport with one calling reassigned:', summarize(fourth))

check('exactly one person is released and one is called', () => {
  assert.equal(fourth.releaseAssignments.length, 1)
  assert.equal(fourth.createAssignments.length, 1)
  assert.deepEqual(fourth.createMembers, ['Brand, New'])
})

check('the seat is reused rather than duplicated', () => {
  assert.equal(fourth.createPositions.length, 0)
})

// --- 5. A second, different export --------------------------------------------
// The roster-less export names only the people holding callings. Merging it
// over a board built from the full export must not touch everybody else.

const secondFile = process.argv[3]
if (secondFile) {
  const other = await read(secondFile)
  const fifth = planImportMerge(other, board)
  console.log(`\nCross-import of ${secondFile}:`, summarize(fifth))

  check('a report that names fewer people releases nobody it does not contradict', () => {
    assert.equal(fifth.releaseAssignments.length, 0)
    assert.equal(fifth.createAssignments.length, 0)
  })

  check('the people it never mentions are reported, never archived', () => {
    assert.ok(
      fifth.absentMembers.length > 0,
      'the roster-less export should leave plenty of members unmentioned'
    )
    // The plan has no way to archive anybody — that is the whole safeguard.
    assert.ok(!('archiveMembers' in fifth))
  })
}

console.log(
  process.exitCode ? '\nSome checks failed.\n' : '\nAll checks passed against the real report.\n'
)
