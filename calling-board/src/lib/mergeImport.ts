/**
 * Reconciles a freshly parsed LCR report against a board that already exists.
 *
 * The point is that re-importing must not cost you anything you did by hand.
 * Flags, notes, parked callings, hand-added callings and everyone's history all
 * survive; what comes across from LCR is *who is in which calling*.
 *
 * The rules, in the order they matter:
 *
 *   • A calling the ward added by hand (`source: 'manual'`) is never touched.
 *     LCR doesn't know about it, so LCR has no opinion about it.
 *
 *   • For callings that came from LCR, the report is the truth about occupancy.
 *     Somebody on the board but not in the report was released; somebody in the
 *     report but not on the board was called.
 *
 *   • Somebody already in the calling they hold in the report stays put, keeping
 *     their called date. Re-importing an unchanged report changes nothing.
 *
 *   • A parked calling that comes back filled goes active again, and a member
 *     marked inactive who turns up holding a calling is active again too. Both
 *     directions of "inactive means vacant / uncalled" are also enforced by
 *     database triggers, so this can't drift.
 *
 *   • A calling that has left the report keeps its row — deleting it would take
 *     its notes and flags with it — but its occupants are released, and it's
 *     reported so somebody can decide whether to delete it.
 *
 * The planner is pure: it reads a snapshot and returns the writes to make.
 * `executeMergePlan` in `applyMerge.ts` is what talks to the database.
 */

import type { ParsedBoard } from './pdfParser'

// --- What the planner is given ----------------------------------------------

export interface ExistingGroup {
  id: string
  name: string
  parent_id: string | null
}

export interface ExistingPosition {
  id: string
  group_id: string
  title: string
  sort_order: number
  inactive_at: string | null
  source: 'import' | 'manual'
}

export interface ExistingAssignment {
  id: string
  position_id: string
  member_id: string
}

export interface ExistingMember {
  id: string
  full_name: string
  archived_at: string | null
}

/** The board being merged into. Empty for a first import. */
export interface BoardSnapshot {
  groups: ExistingGroup[]
  positions: ExistingPosition[]
  assignments: ExistingAssignment[]
  members: ExistingMember[]
}

export const emptySnapshot: BoardSnapshot = {
  groups: [],
  positions: [],
  assignments: [],
  members: [],
}

// --- What it produces --------------------------------------------------------

/**
 * Points either at a row that already exists or at one this plan creates.
 * Rows the plan creates have no id yet, so they're named by key and resolved by
 * the executor once the insert comes back.
 */
export type Ref = { existing: string } | { created: string }

export interface PlannedGroup {
  key: string
  name: string
  parentRef: Ref | null
}

export interface PlannedPosition {
  key: string
  groupRef: Ref
  title: string
  sortOrder: number
}

export interface PlannedAssignment {
  positionRef: Ref
  memberRef: Ref
  calledDate: string
}

export interface MergePlan {
  createGroups: PlannedGroup[]
  createPositions: PlannedPosition[]
  /** Full names, exactly as the report spells them. */
  createMembers: string[]
  /** Ids of inactive members the report shows holding a calling. */
  reactivateMembers: string[]
  /** Ids of parked callings the report shows filled. */
  reactivatePositions: string[]
  /** Assignment ids for people the report no longer shows in that calling. */
  releaseAssignments: string[]
  createAssignments: PlannedAssignment[]
  /** People already in the right calling — left alone, called date and all. */
  keptAssignments: number
  /** Hand-added callings the merge deliberately skipped. */
  untouchedManual: number
  /** LCR callings that have dropped out of the report, now vacant. */
  retired: { id: string; title: string }[]
  /** Members on the board the report didn't mention at all. */
  absentMembers: { id: string; full_name: string }[]
}

export interface MergeSummary {
  groupsAdded: number
  callingsAdded: number
  membersAdded: number
  called: number
  released: number
  unchanged: number
  membersReactivated: number
  callingsReactivated: number
  callingsRetired: number
  membersAbsent: number
  manualKept: number
}

export function summarize(plan: MergePlan): MergeSummary {
  return {
    groupsAdded: plan.createGroups.length,
    callingsAdded: plan.createPositions.length,
    membersAdded: plan.createMembers.length,
    called: plan.createAssignments.length,
    released: plan.releaseAssignments.length,
    unchanged: plan.keptAssignments,
    membersReactivated: plan.reactivateMembers.length,
    callingsReactivated: plan.reactivatePositions.length,
    callingsRetired: plan.retired.length,
    membersAbsent: plan.absentMembers.length,
    manualKept: plan.untouchedManual,
  }
}

// --- Planning ----------------------------------------------------------------

/** LCR spells names consistently, but whitespace and case shouldn't decide identity. */
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** Subgroup names repeat across organizations, so a group is keyed by its path. */
const pathOf = (parentName: string | undefined, name: string) =>
  parentName ? `${parentName} › ${name}` : name

export function planImportMerge(parsed: ParsedBoard, board: BoardSnapshot): MergePlan {
  const plan: MergePlan = {
    createGroups: [],
    createPositions: [],
    createMembers: [],
    reactivateMembers: [],
    reactivatePositions: [],
    releaseAssignments: [],
    createAssignments: [],
    keptAssignments: 0,
    untouchedManual: board.positions.filter((p) => p.source === 'manual').length,
    retired: [],
    absentMembers: [],
  }

  // --- Members -------------------------------------------------------------

  const membersByName = new Map<string, ExistingMember>()
  for (const member of board.members) membersByName.set(nameKey(member.full_name), member)

  const memberRefs = new Map<string, Ref>()
  const reactivating = new Set<string>()

  /**
   * A member reference for a name in the report, creating the member if the
   * ward has never seen them. `calling` marks the ones that must be active:
   * merely appearing on the roster isn't grounds for undoing a manual
   * "inactive" mark, but being given a calling is.
   */
  const memberRef = (fullName: string, calling: boolean): Ref => {
    const key = nameKey(fullName)
    const existing = membersByName.get(key)

    if (existing) {
      if (calling && existing.archived_at && !reactivating.has(existing.id)) {
        reactivating.add(existing.id)
        plan.reactivateMembers.push(existing.id)
      }
      return { existing: existing.id }
    }

    let ref = memberRefs.get(key)
    if (!ref) {
      ref = { created: fullName }
      memberRefs.set(key, ref)
      plan.createMembers.push(fullName)
    }
    return ref
  }

  // Everyone the report names exists afterwards, calling or not — the roster is
  // the only place a member with no calling appears.
  for (const name of parsed.allMembers) memberRef(name, false)

  // --- Groups ---------------------------------------------------------------

  const groupsById = new Map(board.groups.map((g) => [g.id, g]))
  const groupPath = (group: ExistingGroup) =>
    pathOf(group.parent_id ? groupsById.get(group.parent_id)?.name : undefined, group.name)

  const groupsByPath = new Map<string, ExistingGroup>()
  for (const group of board.groups) groupsByPath.set(groupPath(group), group)

  const groupRefs = new Map<string, Ref>()

  const groupRef = (parentName: string | undefined, name: string): Ref => {
    const path = pathOf(parentName, name)

    const existing = groupsByPath.get(path)
    if (existing) return { existing: existing.id }

    const already = groupRefs.get(path)
    if (already) return already

    // A parent has to exist before the child can point at it.
    const parentRef = parentName ? groupRef(undefined, parentName) : null

    const ref: Ref = { created: path }
    groupRefs.set(path, ref)
    plan.createGroups.push({ key: path, name, parentRef })
    return ref
  }

  // --- Positions ------------------------------------------------------------

  const occupantsOf = new Map<string, ExistingAssignment[]>()
  for (const assignment of board.assignments) {
    const list = occupantsOf.get(assignment.position_id) ?? []
    list.push(assignment)
    occupantsOf.set(assignment.position_id, list)
  }

  const membersById = new Map(board.members.map((m) => [m.id, m]))
  const nameOfMemberId = (id: string) => {
    const name = membersById.get(id)?.full_name
    return name ? nameKey(name) : null
  }

  const positionsByGroup = new Map<string, ExistingPosition[]>()
  // Sort order has to clear every calling in the group, hand-added ones
  // included, even though only LCR's are candidates for reconciliation.
  const lastSortInGroup = new Map<string, number>()

  for (const position of board.positions) {
    lastSortInGroup.set(
      position.group_id,
      Math.max(lastSortInGroup.get(position.group_id) ?? -1, position.sort_order)
    )
    if (position.source !== 'import') continue
    const list = positionsByGroup.get(position.group_id) ?? []
    list.push(position)
    positionsByGroup.set(position.group_id, list)
  }

  /** Import-sourced positions the report still accounts for. */
  const matched = new Set<string>()
  let nextKey = 0

  for (const group of parsed.groups) {
    const ref = groupRef(group.parentName, group.name)
    const existingGroup = 'existing' in ref ? ref.existing : null

    const pool = existingGroup ? positionsByGroup.get(existingGroup) ?? [] : []
    let nextSort = (existingGroup ? lastSortInGroup.get(existingGroup) ?? -1 : -1) + 1

    // A title can legitimately repeat — four "Teachers Quorum Adviser" seats —
    // so seats are reconciled a title at a time rather than one by one.
    const seatsByTitle = new Map<string, ParsedBoard['groups'][0]['positions']>()
    for (const seat of group.positions) {
      const list = seatsByTitle.get(seat.title) ?? []
      list.push(seat)
      seatsByTitle.set(seat.title, list)
    }

    for (const [title, seats] of seatsByTitle) {
      const candidates = pool.filter((p) => p.title === title && !matched.has(p.id))
      const taken = new Set<string>()
      const pairing = new Map<number, ExistingPosition>()

      // Pass 1 — keep people where they are. Pairing a seat to the position its
      // occupant already holds is what makes an unchanged report a no-op.
      seats.forEach((seat, index) => {
        const wanted = seat.callings.map((c) => nameKey(c.memberName))
        if (wanted.length === 0) return

        const held = candidates.find(
          (p) =>
            !taken.has(p.id) &&
            (occupantsOf.get(p.id) ?? []).some((a) => {
              const name = nameOfMemberId(a.member_id)
              return !!name && wanted.includes(name)
            })
        )
        if (held) {
          taken.add(held.id)
          pairing.set(index, held)
        }
      })

      // Pass 2 — everything else takes a free seat, preferring one that's
      // already empty and active so a parked seat isn't disturbed needlessly
      // and an occupant isn't shuffled for nothing.
      const free = candidates
        .filter((p) => !taken.has(p.id))
        .sort((a, b) => rank(a, occupantsOf) - rank(b, occupantsOf) || a.sort_order - b.sort_order)

      let freeIndex = 0
      seats.forEach((_seat, index) => {
        if (pairing.has(index)) return
        const next = free[freeIndex]
        if (next) {
          freeIndex += 1
          taken.add(next.id)
          pairing.set(index, next)
        }
      })

      // Reconcile each pairing, and create a position for any seat left over.
      seats.forEach((seat, index) => {
        const wanted = seat.callings
        const target = pairing.get(index)

        if (!target) {
          const key = `position:${nextKey++}`
          plan.createPositions.push({
            key,
            groupRef: ref,
            title,
            sortOrder: nextSort++,
          })
          for (const calling of wanted) {
            plan.createAssignments.push({
              positionRef: { created: key },
              memberRef: memberRef(calling.memberName, true),
              calledDate: calling.calledDate,
            })
          }
          return
        }

        matched.add(target.id)

        const current = occupantsOf.get(target.id) ?? []
        const wantedKeys = wanted.map((c) => nameKey(c.memberName))

        for (const assignment of current) {
          const name = nameOfMemberId(assignment.member_id)
          if (name && wantedKeys.includes(name)) {
            plan.keptAssignments += 1
          } else {
            // On the board, gone from the report: they were released.
            plan.releaseAssignments.push(assignment.id)
          }
        }

        const currentKeys = new Set(
          current.map((a) => nameOfMemberId(a.member_id)).filter((n): n is string => !!n)
        )
        const arriving = wanted.filter((c) => !currentKeys.has(nameKey(c.memberName)))

        if (arriving.length > 0 && target.inactive_at) {
          plan.reactivatePositions.push(target.id)
        }

        for (const calling of arriving) {
          plan.createAssignments.push({
            positionRef: { existing: target.id },
            memberRef: memberRef(calling.memberName, true),
            calledDate: calling.calledDate,
          })
        }
      })
    }
  }

  // --- Callings that have left the report -----------------------------------
  // The row stays (its notes and flags are the ward's, not LCR's), but nobody
  // holds a calling that no longer exists.

  for (const position of board.positions) {
    if (position.source !== 'import' || matched.has(position.id)) continue

    const current = occupantsOf.get(position.id) ?? []
    for (const assignment of current) plan.releaseAssignments.push(assignment.id)
    plan.retired.push({ id: position.id, title: position.title })
  }

  // --- Members the report didn't mention ------------------------------------
  // Reported rather than archived: a report that's missing a roster section
  // would otherwise sweep half the ward away.

  const reported = new Set(Array.from(parsed.allMembers, nameKey))
  for (const member of board.members) {
    if (!reported.has(nameKey(member.full_name))) {
      plan.absentMembers.push({ id: member.id, full_name: member.full_name })
    }
  }

  return plan
}

/** Empty-and-active first, then parked, then occupied. */
function rank(position: ExistingPosition, occupants: Map<string, ExistingAssignment[]>) {
  const filled = (occupants.get(position.id) ?? []).length > 0
  if (filled) return 2
  return position.inactive_at ? 1 : 0
}
