/**
 * The database half of the import merge: reads the board a merge will run
 * against, and writes out the plan `planImportMerge` produced.
 *
 * Kept apart from the planner so the rules can be tested without a database,
 * and so everything here is mechanical — this file makes no decisions.
 */

import { supabase } from './supabase'
import type { BoardSnapshot, MergePlan, Ref } from './mergeImport'
import type {
  ExistingAssignment,
  ExistingGroup,
  ExistingMember,
  ExistingPosition,
} from './mergeImport'

/** Everything the planner needs to know about the board it's merging into. */
export async function loadSnapshot(
  boardId: string,
  wardId: string
): Promise<BoardSnapshot> {
  const groupsRes = await supabase
    .from('groups')
    .select('id, name, parent_id')
    .eq('board_id', boardId)

  if (groupsRes.error) throw groupsRes.error
  const groups = (groupsRes.data || []) as ExistingGroup[]

  const positionsRes = groups.length
    ? await supabase
        .from('positions')
        .select('id, group_id, title, sort_order, inactive_at, source')
        .in('group_id', groups.map((g) => g.id))
    : { data: [], error: null }

  if (positionsRes.error) throw positionsRes.error
  const positions = (positionsRes.data || []) as ExistingPosition[]

  const [assignmentsRes, membersRes] = await Promise.all([
    positions.length
      ? supabase
          .from('position_assignments')
          .select('id, position_id, member_id')
          .in('position_id', positions.map((p) => p.id))
      : Promise.resolve({ data: [], error: null }),
    supabase.from('members').select('id, full_name, archived_at').eq('ward_id', wardId),
  ])

  if (assignmentsRes.error) throw assignmentsRes.error
  if (membersRes.error) throw membersRes.error

  return {
    groups,
    positions,
    assignments: (assignmentsRes.data || []) as ExistingAssignment[],
    members: (membersRes.data || []) as ExistingMember[],
  }
}

function resolver(created: Map<string, string>) {
  return (ref: Ref): string => {
    if ('existing' in ref) return ref.existing
    const id = created.get(ref.created)
    if (!id) throw new Error(`Import merge lost track of "${ref.created}"`)
    return id
  }
}

export interface ApplyTarget {
  boardId: string
  wardId: string
}

export async function executeMergePlan(plan: MergePlan, target: ApplyTarget): Promise<void> {
  const memberIds = new Map<string, string>()
  const groupIds = new Map<string, string>()
  const positionIds = new Map<string, string>()

  // --- Members --------------------------------------------------------------
  if (plan.createMembers.length > 0) {
    const { data, error } = await supabase
      .from('members')
      .insert(plan.createMembers.map((full_name) => ({ ward_id: target.wardId, full_name })))
      .select('id, full_name')

    if (error) throw new Error(`Could not add members: ${error.message}`)
    // Keyed by the exact string the plan used, so `{ created: name }` resolves.
    plan.createMembers.forEach((name, index) => {
      const row = (data || [])[index]
      if (row) memberIds.set(name, row.id)
    })
  }

  // Before any assignment lands, so the board never briefly shows an inactive
  // member holding a calling. A database trigger does this too — belt and
  // braces, because the rule matters more than where it's enforced.
  if (plan.reactivateMembers.length > 0) {
    const { error } = await supabase
      .from('members')
      .update({ archived_at: null })
      .in('id', plan.reactivateMembers)

    if (error) throw new Error(`Could not reactivate members: ${error.message}`)
  }

  // --- Groups ---------------------------------------------------------------
  // A subgroup's parent has to exist first. The plan lists parents before
  // children, so inserting in waves of "everything whose parent is known" both
  // respects that and keeps the round trips down.
  let pending = [...plan.createGroups]
  let nextGroupSort = 0

  if (pending.length > 0) {
    // New organizations sort after whatever the board already had.
    const { data } = await supabase
      .from('groups')
      .select('sort_order')
      .eq('board_id', target.boardId)
      .order('sort_order', { ascending: false })
      .limit(1)

    nextGroupSort = ((data?.[0]?.sort_order as number | undefined) ?? -1) + 1
  }

  while (pending.length > 0) {
    const ready = pending.filter(
      (g) => !g.parentRef || 'existing' in g.parentRef || groupIds.has(g.parentRef.created)
    )
    if (ready.length === 0) {
      throw new Error('Import merge could not resolve the organization hierarchy')
    }

    const { data, error } = await supabase
      .from('groups')
      .insert(
        ready.map((g, index) => ({
          board_id: target.boardId,
          name: g.name,
          parent_id: g.parentRef
            ? 'existing' in g.parentRef
              ? g.parentRef.existing
              : groupIds.get(g.parentRef.created)!
            : null,
          sort_order: nextGroupSort + index,
        }))
      )
      .select('id')

    if (error) throw new Error(`Could not add organizations: ${error.message}`)
    ready.forEach((g, index) => {
      const row = (data || [])[index]
      if (row) groupIds.set(g.key, row.id)
    })
    nextGroupSort += ready.length

    pending = pending.filter((g) => !groupIds.has(g.key))
  }

  const groupRef = resolver(groupIds)

  // --- Positions ------------------------------------------------------------
  if (plan.createPositions.length > 0) {
    const { data, error } = await supabase
      .from('positions')
      .insert(
        plan.createPositions.map((p) => ({
          group_id: groupRef(p.groupRef),
          title: p.title,
          sort_order: p.sortOrder,
          source: 'import',
        }))
      )
      .select('id')

    if (error) throw new Error(`Could not add callings: ${error.message}`)
    plan.createPositions.forEach((p, index) => {
      const row = (data || [])[index]
      if (row) positionIds.set(p.key, row.id)
    })
  }

  // --- Releases -------------------------------------------------------------
  // Ahead of the new assignments so a calling is never briefly double-filled.
  for (const batch of chunk(plan.releaseAssignments, 100)) {
    const { error } = await supabase.from('position_assignments').delete().in('id', batch)
    if (error) throw new Error(`Could not release callings: ${error.message}`)
  }

  // --- Parked callings coming back ------------------------------------------
  if (plan.reactivatePositions.length > 0) {
    const { error } = await supabase
      .from('positions')
      .update({ inactive_at: null })
      .in('id', plan.reactivatePositions)

    if (error) throw new Error(`Could not reactivate callings: ${error.message}`)
  }

  // --- New assignments ------------------------------------------------------
  const positionRef = resolver(positionIds)
  const memberRef = resolver(memberIds)

  const rows = plan.createAssignments.map((a) => ({
    position_id: 'existing' in a.positionRef ? a.positionRef.existing : positionRef(a.positionRef),
    member_id: 'existing' in a.memberRef ? a.memberRef.existing : memberRef(a.memberRef),
    called_date: a.calledDate,
  }))

  for (const batch of chunk(rows, 200)) {
    const { error } = await supabase.from('position_assignments').insert(batch)
    if (error) throw new Error(`Could not record callings: ${error.message}`)
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}
