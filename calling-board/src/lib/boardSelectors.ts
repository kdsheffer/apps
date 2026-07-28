import type { BoardData } from '../hooks/useBoardData'
import type { BoardFilters, Group, GroupNode, Member, Position, PositionAssignment } from '../types'

export interface AssignedMember {
  member: Member | undefined
  assignment: PositionAssignment
}

/** Everything the UI needs about one position, precomputed once per render. */
export interface PositionView {
  position: Position
  group: Group
  parentGroup: Group | null
  assigned: AssignedMember[]
  isOpen: boolean
  isInactive: boolean
}

export interface BoardIndex {
  /** position id -> assignments on it */
  byPosition: Map<string, AssignedMember[]>
  /** member id -> every assignment they hold on this board */
  byMember: Map<string, PositionAssignment[]>
  membersById: Map<string, Member>
  groupsById: Map<string, Group>
  positionsById: Map<string, Position>
  assignmentsById: Map<string, PositionAssignment>
}

export function buildIndex(data: BoardData | undefined): BoardIndex {
  const index: BoardIndex = {
    byPosition: new Map(),
    byMember: new Map(),
    membersById: new Map(),
    groupsById: new Map(),
    positionsById: new Map(),
    assignmentsById: new Map(),
  }

  if (!data) return index

  for (const member of data.members) index.membersById.set(member.id, member)
  for (const group of data.groups) index.groupsById.set(group.id, group)
  for (const position of data.positions) index.positionsById.set(position.id, position)

  for (const assignment of data.assignments) {
    index.assignmentsById.set(assignment.id, assignment)

    const forPosition = index.byPosition.get(assignment.position_id) ?? []
    forPosition.push({
      member: index.membersById.get(assignment.member_id),
      assignment,
    })
    index.byPosition.set(assignment.position_id, forPosition)

    const forMember = index.byMember.get(assignment.member_id) ?? []
    forMember.push(assignment)
    index.byMember.set(assignment.member_id, forMember)
  }

  for (const list of index.byPosition.values()) {
    list.sort((a, b) => (a.member?.full_name || '').localeCompare(b.member?.full_name || ''))
  }

  return index
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function positionMatchesSearch(view: PositionView, search: string) {
  const needle = normalize(search)
  if (!needle) return true

  const haystacks = [
    view.position.title,
    view.position.notes || '',
    view.group.name,
    view.parentGroup?.name || '',
    ...view.assigned.map((a) => a.member?.full_name || ''),
  ]

  return haystacks.some((h) => h.toLowerCase().includes(needle))
}

export function makePositionView(
  position: Position,
  index: BoardIndex,
): PositionView {
  const group = index.groupsById.get(position.group_id)!
  const parentGroup = group?.parent_id ? index.groupsById.get(group.parent_id) ?? null : null
  const assigned = index.byPosition.get(position.id) ?? []

  return {
    position,
    group,
    parentGroup,
    assigned,
    isOpen: assigned.length === 0,
    isInactive: !!position.inactive_at,
  }
}

export function positionPassesFilters(view: PositionView, filters: BoardFilters) {
  if (!filters.showInactive && view.isInactive) return false
  if (filters.openOnly && !view.isOpen) return false

  if (filters.flaggedOnly) {
    const memberFlagged = view.assigned.some((a) => a.member?.flagged)
    if (!view.position.flagged && !memberFlagged) return false
  }

  return positionMatchesSearch(view, filters.search)
}

export interface FilteredNode extends GroupNode {
  /** Counts reflect what's visible after filtering. */
  filled: number
  total: number
}

/**
 * The organization tree, filtered. A group survives if it still has a visible
 * calling, or if it was explicitly selected in the group filter — an empty
 * organization you just created still needs somewhere to add callings.
 */
export function buildGroupTree(
  data: BoardData | undefined,
  index: BoardIndex,
  filters: BoardFilters,
): FilteredNode[] {
  if (!data) return []

  const filtersActive =
    !!filters.search ||
    filters.flaggedOnly ||
    filters.openOnly ||
    filters.groupIds.length > 0 ||
    filters.subgroupIds.length > 0

  const visiblePositions = (groupId: string) =>
    data.positions
      .filter((p) => p.group_id === groupId)
      .map((p) => makePositionView(p, index))
      .filter((v) => positionPassesFilters(v, filters))
      .map((v) => v.position)

  const parents = data.groups
    .filter((g) => !g.parent_id)
    .filter((g) => filters.groupIds.length === 0 || filters.groupIds.includes(g.id))
    .sort((a, b) => a.sort_order - b.sort_order)

  return parents
    .map((group) => {
      const subgroups = data.groups
        .filter((c) => c.parent_id === group.id)
        .filter((c) => filters.subgroupIds.length === 0 || filters.subgroupIds.includes(c.id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((subgroup) => ({ group: subgroup, positions: visiblePositions(subgroup.id) }))
        .filter((s) => s.positions.length > 0 || !filtersActive)

      // Selecting subgroups means you're asking about those subgroups, not the
      // organization's own callings.
      const positions = filters.subgroupIds.length > 0 ? [] : visiblePositions(group.id)

      const all = [...positions, ...subgroups.flatMap((s) => s.positions)]
      const filled = all.filter((p) => (index.byPosition.get(p.id) ?? []).length > 0).length

      return {
        group,
        positions,
        subgroups,
        filled,
        total: all.length,
      }
    })
    .filter((node) => node.total > 0 || !filtersActive)
}

// --- Members ----------------------------------------------------------------

export function memberIsActive(member: Member) {
  return !member.archived_at
}

/** Members holding no calling on the current board. */
export function unassignedMembers(data: BoardData | undefined, index: BoardIndex) {
  return (data?.members || [])
    .filter((m) => !(index.byMember.get(m.id)?.length))
    .sort(byName)
}

export function byName(a: Member, b: Member) {
  return a.full_name.localeCompare(b.full_name)
}

/**
 * Matches on any word in the name, so "smi", "john", and "john s" all find
 * "John Smith". Exact prefix matches sort ahead of interior matches; ties fall
 * back to alphabetical.
 */
export function searchMembers(members: Member[], query: string, limit = 20) {
  const needle = normalize(query)
  if (!needle) return [...members].sort(byName).slice(0, limit)

  const terms = needle.split(/\s+/).filter(Boolean)

  const scored = members
    .map((member) => {
      const name = member.full_name.toLowerCase()
      const words = name.split(/[\s,]+/).filter(Boolean)

      const matchesEveryTerm = terms.every(
        (term) => words.some((w) => w.startsWith(term)) || name.includes(term)
      )
      if (!matchesEveryTerm) return null

      const startsWord = terms.every((term) => words.some((w) => w.startsWith(term)))
      return { member, rank: startsWord ? 0 : 1 }
    })
    .filter((x): x is { member: Member; rank: number } => x !== null)

  scored.sort((a, b) => a.rank - b.rank || byName(a.member, b.member))
  return scored.slice(0, limit).map((s) => s.member)
}

// --- Stats ------------------------------------------------------------------

export interface BoardStats {
  callings: number
  open: number
  flagged: number
  members: number
  unassigned: number
  inactive: number
}

export function boardStats(data: BoardData | undefined, index: BoardIndex): BoardStats {
  const positions = data?.positions || []
  const active = positions.filter((p) => !p.inactive_at)
  const members = (data?.members || []).filter(memberIsActive)

  return {
    callings: active.length,
    open: active.filter((p) => !(index.byPosition.get(p.id)?.length)).length,
    flagged:
      active.filter((p) => p.flagged).length + members.filter((m) => m.flagged).length,
    members: members.length,
    unassigned: members.filter((m) => !(index.byMember.get(m.id)?.length)).length,
    inactive:
      positions.filter((p) => p.inactive_at).length +
      (data?.members || []).filter((m) => !memberIsActive(m)).length,
  }
}
