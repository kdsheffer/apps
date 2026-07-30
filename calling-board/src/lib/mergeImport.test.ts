import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { emptySnapshot, planImportMerge, summarize } from './mergeImport.ts'
import type { BoardSnapshot, ExistingPosition, MergePlan } from './mergeImport.ts'
import type { ParsedBoard } from './pdfParser.ts'

// --- Builders ----------------------------------------------------------------

let seq = 0
const id = (prefix: string) => `${prefix}-${++seq}`

interface SeatSpec {
  title: string
  member?: string
  date?: string
}

function report(
  groups: Array<{ name: string; parent?: string; seats: SeatSpec[] }>,
  extraMembers: string[] = []
): ParsedBoard {
  const allMembers = new Set<string>(extraMembers)
  const parsed: ParsedBoard = { groups: [], allMembers }

  for (const group of groups) {
    parsed.groups.push({
      name: group.name,
      parentName: group.parent,
      positions: group.seats.map((seat) => {
        if (seat.member) allMembers.add(seat.member)
        return {
          title: seat.title,
          callings: seat.member
            ? [{ memberName: seat.member, calledDate: seat.date ?? '2024-01-01' }]
            : [],
        }
      }),
    })
  }

  return parsed
}

interface BoardSpec {
  name: string
  parent?: string
  seats: Array<{
    title: string
    member?: string
    inactive?: boolean
    source?: 'import' | 'manual'
  }>
}

function board(specs: BoardSpec[], looseMembers: Array<{ name: string; inactive?: boolean }> = []) {
  const snapshot: BoardSnapshot = {
    groups: [],
    positions: [],
    assignments: [],
    members: [],
  }

  const groupIds = new Map<string, string>()
  const memberIds = new Map<string, string>()

  const memberId = (name: string, inactive = false) => {
    let existing = memberIds.get(name)
    if (!existing) {
      existing = id('member')
      memberIds.set(name, existing)
      snapshot.members.push({
        id: existing,
        full_name: name,
        archived_at: inactive ? '2024-06-01T00:00:00Z' : null,
      })
    }
    return existing
  }

  const groupId = (name: string, parent?: string) => {
    const path = parent ? `${parent} › ${name}` : name
    let existing = groupIds.get(path)
    if (!existing) {
      existing = id('group')
      groupIds.set(path, existing)
      snapshot.groups.push({
        id: existing,
        name,
        parent_id: parent ? groupId(parent) : null,
      })
    }
    return existing
  }

  for (const member of looseMembers) memberId(member.name, member.inactive)

  for (const spec of specs) {
    const group = groupId(spec.name, spec.parent)
    spec.seats.forEach((seat, index) => {
      const position: ExistingPosition = {
        id: id('position'),
        group_id: group,
        title: seat.title,
        sort_order: index,
        inactive_at: seat.inactive ? '2024-06-01T00:00:00Z' : null,
        source: seat.source ?? 'import',
      }
      snapshot.positions.push(position)

      if (seat.member) {
        snapshot.assignments.push({
          id: id('assignment'),
          position_id: position.id,
          member_id: memberId(seat.member),
        })
      }
    })
  }

  return snapshot
}

const positionTitle = (snapshot: BoardSnapshot, positionId: string) =>
  snapshot.positions.find((p) => p.id === positionId)?.title

const releasedNames = (plan: MergePlan, snapshot: BoardSnapshot) =>
  plan.releaseAssignments.map((assignmentId) => {
    const assignment = snapshot.assignments.find((a) => a.id === assignmentId)!
    return snapshot.members.find((m) => m.id === assignment.member_id)!.full_name
  })

const calledNames = (plan: MergePlan, snapshot: BoardSnapshot) =>
  plan.createAssignments.map((a) => {
    const ref = a.memberRef
    if ('created' in ref) return ref.created
    return snapshot.members.find((m) => m.id === ref.existing)!.full_name
  })

// --- Tests -------------------------------------------------------------------

describe('first import', () => {
  test('builds the whole board from nothing', () => {
    const plan = planImportMerge(
      report(
        [
          { name: 'Bishopric', seats: [{ title: 'Bishop', member: 'Young, Brigham' }] },
          {
            name: 'Elders Quorum Presidency',
            parent: 'Elders Quorum',
            seats: [{ title: 'President', member: 'Pratt, Parley' }],
          },
        ],
        ['Nobody, Called']
      ),
      emptySnapshot
    )

    const s = summarize(plan)
    assert.equal(s.groupsAdded, 3, 'Bishopric, Elders Quorum, and its presidency')
    assert.equal(s.callingsAdded, 2)
    assert.equal(s.membersAdded, 3, 'the roster-only member comes across too')
    assert.equal(s.called, 2)
    assert.equal(s.released, 0)

    const presidency = plan.createGroups.find((g) => g.name === 'Elders Quorum Presidency')!
    assert.deepEqual(presidency.parentRef, { created: 'Elders Quorum' })
  })
})

describe('re-importing an unchanged report', () => {
  test('changes nothing at all', () => {
    const spec = [
      {
        name: 'Bishopric',
        seats: [
          { title: 'Bishop', member: 'Young, Brigham' },
          { title: 'First Counselor', member: 'Kimball, Heber' },
        ],
      },
    ]
    const snapshot = board(spec)
    const plan = planImportMerge(
      report([
        {
          name: 'Bishopric',
          seats: [
            { title: 'Bishop', member: 'Young, Brigham' },
            { title: 'First Counselor', member: 'Kimball, Heber' },
          ],
        },
      ]),
      snapshot
    )

    const s = summarize(plan)
    assert.deepEqual(
      {
        groupsAdded: s.groupsAdded,
        callingsAdded: s.callingsAdded,
        membersAdded: s.membersAdded,
        called: s.called,
        released: s.released,
        retired: s.callingsRetired,
      },
      { groupsAdded: 0, callingsAdded: 0, membersAdded: 0, called: 0, released: 0, retired: 0 }
    )
    assert.equal(s.unchanged, 2, 'both people stay put, keeping their called dates')
  })
})

describe('releases', () => {
  test('somebody missing from the report is released from that calling', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'President', member: 'Old, Holder' }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'President' }] }]),
      snapshot
    )

    assert.deepEqual(releasedNames(plan, snapshot), ['Old, Holder'])
    assert.equal(plan.createAssignments.length, 0)
    assert.equal(plan.createPositions.length, 0, 'the calling itself stays')
  })

  test('a replacement releases the outgoing person and calls the new one', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'President', member: 'Old, Holder' }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'President', member: 'New, Holder' }] }]),
      snapshot
    )

    assert.deepEqual(releasedNames(plan, snapshot), ['Old, Holder'])
    assert.deepEqual(calledNames(plan, snapshot), ['New, Holder'])
    assert.equal(plan.createPositions.length, 0, 'the same seat is reused')
  })

  test('a calling that has left the report is emptied but kept', () => {
    const snapshot = board([
      {
        name: 'Sunday School',
        seats: [
          { title: 'President', member: 'Stays, Put' },
          { title: 'Discontinued Role', member: 'Was, Serving' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([{ name: 'Sunday School', seats: [{ title: 'President', member: 'Stays, Put' }] }]),
      snapshot
    )

    assert.deepEqual(releasedNames(plan, snapshot), ['Was, Serving'])
    assert.deepEqual(
      plan.retired.map((r) => r.title),
      ['Discontinued Role']
    )
  })

  test('a whole organization leaving the report empties its callings', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'President', member: 'Stays, Put' }] },
      { name: 'Old Committee', seats: [{ title: 'Chair', member: 'Was, Serving' }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'President', member: 'Stays, Put' }] }]),
      snapshot
    )

    assert.deepEqual(releasedNames(plan, snapshot), ['Was, Serving'])
    assert.deepEqual(
      plan.retired.map((r) => r.title),
      ['Chair']
    )
  })
})

describe('hand-added callings', () => {
  test('are never touched, even though LCR has never heard of them', () => {
    const snapshot = board([
      {
        name: 'Ward Council',
        seats: [
          { title: 'Website Coordinator', member: 'Custom, Person', source: 'manual' },
          { title: 'Clerk', member: 'Imported, Person' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([{ name: 'Ward Council', seats: [{ title: 'Clerk', member: 'Imported, Person' }] }]),
      snapshot
    )

    assert.equal(plan.releaseAssignments.length, 0, 'the manual calling keeps its person')
    assert.equal(plan.retired.length, 0, 'and is not reported as retired')
    assert.equal(plan.untouchedManual, 1)
    assert.equal(summarize(plan).unchanged, 1)
  })

  test('a manual calling with the same title as an LCR one is still left alone', () => {
    const snapshot = board([
      {
        name: 'Primary',
        seats: [
          { title: 'Teacher', member: 'Lcr, Person' },
          { title: 'Teacher', member: 'Manual, Person', source: 'manual' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Lcr, Person' }] }]),
      snapshot
    )

    assert.equal(plan.releaseAssignments.length, 0)
    assert.equal(plan.retired.length, 0)
  })
})

describe('parked callings', () => {
  test('stay parked when the report still shows them vacant', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'Music Leader', inactive: true }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Music Leader' }] }]),
      snapshot
    )

    assert.deepEqual(plan.reactivatePositions, [])
    assert.equal(plan.createPositions.length, 0)
    assert.equal(plan.releaseAssignments.length, 0)
  })

  test('come back into service when the report fills them', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'Music Leader', inactive: true }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Music Leader', member: 'New, Leader' }] }]),
      snapshot
    )

    assert.equal(plan.reactivatePositions.length, 1)
    assert.equal(positionTitle(snapshot, plan.reactivatePositions[0]), 'Music Leader')
    assert.deepEqual(calledNames(plan, snapshot), ['New, Leader'])
  })

  test('an active empty seat is used before a parked one', () => {
    const snapshot = board([
      {
        name: 'Primary',
        seats: [
          { title: 'Teacher', inactive: true },
          { title: 'Teacher' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher', member: 'One, Only' }] }]),
      snapshot
    )

    assert.deepEqual(plan.reactivatePositions, [], 'the parked seat is left parked')
    assert.equal(plan.createAssignments.length, 1)
  })
})

describe('inactive members', () => {
  test('are reactivated when the report gives them a calling', () => {
    const snapshot = board(
      [{ name: 'Primary', seats: [{ title: 'Teacher' }] }],
      [{ name: 'Came, Back', inactive: true }]
    )
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Came, Back' }] }]),
      snapshot
    )

    assert.equal(plan.reactivateMembers.length, 1)
    assert.equal(
      snapshot.members.find((m) => m.id === plan.reactivateMembers[0])!.full_name,
      'Came, Back'
    )
  })

  test('stay inactive when they only appear on the roster', () => {
    const snapshot = board(
      [{ name: 'Primary', seats: [{ title: 'Teacher' }] }],
      [{ name: 'Still, Away', inactive: true }]
    )
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher' }] }], ['Still, Away']),
      snapshot
    )

    assert.deepEqual(plan.reactivateMembers, [], 'being on the roster is not a calling')
  })
})

describe('members', () => {
  test('new names in the report are created once, calling or not', () => {
    const plan = planImportMerge(
      report(
        [{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Called, Person' }] }],
        ['Roster, Person']
      ),
      emptySnapshot
    )

    assert.deepEqual(plan.createMembers.sort(), ['Called, Person', 'Roster, Person'])
  })

  test('someone in two callings is only created once', () => {
    const plan = planImportMerge(
      report([
        {
          name: 'Primary',
          seats: [
            { title: 'Teacher', member: 'Busy, Person' },
            { title: 'Pianist', member: 'Busy, Person' },
          ],
        },
      ]),
      emptySnapshot
    )

    assert.deepEqual(plan.createMembers, ['Busy, Person'])
    assert.equal(plan.createAssignments.length, 2)
  })

  test('members the report never mentions are reported, not archived', () => {
    const snapshot = board(
      [{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Stays, Put' }] }],
      [{ name: 'Moved, Away' }]
    )
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Stays, Put' }] }]),
      snapshot
    )

    assert.deepEqual(
      plan.absentMembers.map((m) => m.full_name),
      ['Moved, Away']
    )
  })
})

describe('repeated titles', () => {
  test('people who stay keep their own seat while the rest are reshuffled', () => {
    const snapshot = board([
      {
        name: 'Young Men',
        seats: [
          { title: 'Adviser', member: 'Stays, Alice' },
          { title: 'Adviser', member: 'Leaves, Bob' },
          { title: 'Adviser' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([
        {
          name: 'Young Men',
          seats: [
            { title: 'Adviser', member: 'Arrives, Carol' },
            { title: 'Adviser', member: 'Stays, Alice' },
            { title: 'Adviser', member: 'Arrives, Dave' },
          ],
        },
      ]),
      snapshot
    )

    assert.equal(summarize(plan).unchanged, 1, 'Alice is untouched despite moving down the list')
    assert.deepEqual(releasedNames(plan, snapshot), ['Leaves, Bob'])
    assert.deepEqual(calledNames(plan, snapshot).sort(), ['Arrives, Carol', 'Arrives, Dave'])
    assert.equal(plan.createPositions.length, 0, 'three seats existed, three were needed')
  })

  test('extra seats in the report are created', () => {
    const snapshot = board([
      { name: 'Young Men', seats: [{ title: 'Adviser', member: 'Stays, Alice' }] },
    ])
    const plan = planImportMerge(
      report([
        {
          name: 'Young Men',
          seats: [
            { title: 'Adviser', member: 'Stays, Alice' },
            { title: 'Adviser', member: 'Arrives, Bob' },
          ],
        },
      ]),
      snapshot
    )

    assert.equal(plan.createPositions.length, 1)
    assert.equal(plan.createPositions[0].sortOrder, 1, 'sorted after the seat already there')
    assert.deepEqual(calledNames(plan, snapshot), ['Arrives, Bob'])
  })

  test('seats the report no longer needs are emptied and reported', () => {
    const snapshot = board([
      {
        name: 'Young Men',
        seats: [
          { title: 'Adviser', member: 'Stays, Alice' },
          { title: 'Adviser', member: 'Leaves, Bob' },
        ],
      },
    ])
    const plan = planImportMerge(
      report([{ name: 'Young Men', seats: [{ title: 'Adviser', member: 'Stays, Alice' }] }]),
      snapshot
    )

    assert.deepEqual(releasedNames(plan, snapshot), ['Leaves, Bob'])
    assert.equal(plan.retired.length, 1)
  })
})

describe('subgroups', () => {
  test('the same subgroup name under two organizations stays distinct', () => {
    const snapshot = board([
      { name: 'Teachers', parent: 'Primary', seats: [{ title: 'Teacher', member: 'A, One' }] },
      { name: 'Teachers', parent: 'Sunday School', seats: [{ title: 'Teacher', member: 'B, Two' }] },
    ])
    const plan = planImportMerge(
      report([
        { name: 'Teachers', parent: 'Primary', seats: [{ title: 'Teacher', member: 'A, One' }] },
        {
          name: 'Teachers',
          parent: 'Sunday School',
          seats: [{ title: 'Teacher', member: 'B, Two' }],
        },
      ]),
      snapshot
    )

    assert.equal(plan.createGroups.length, 0, 'both subgroups are recognised')
    assert.equal(plan.releaseAssignments.length, 0)
    assert.equal(summarize(plan).unchanged, 2)
  })
})

describe('name matching', () => {
  test('shrugs off stray whitespace and casing', () => {
    const snapshot = board([
      { name: 'Primary', seats: [{ title: 'Teacher', member: 'Smith, John' }] },
    ])
    const plan = planImportMerge(
      report([{ name: 'Primary', seats: [{ title: 'Teacher', member: 'Smith,  John ' }] }]),
      snapshot
    )

    assert.equal(plan.createMembers.length, 0)
    assert.equal(plan.releaseAssignments.length, 0)
    assert.equal(summarize(plan).unchanged, 1)
  })
})
