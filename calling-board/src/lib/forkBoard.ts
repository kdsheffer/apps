import { supabase } from './supabase'
import type { Board, Group, Position, PositionAssignment } from '../types'

/**
 * Maps ids on the source board to the ids of their copies on the fork. Every
 * copied row carries `origin_id`, so the map is built from what the database
 * actually wrote rather than from the order rows came back in.
 */
export interface IdMap {
  groups: Map<string, string>
  positions: Map<string, string>
  assignments: Map<string, string>
  /** Translates any source id to its copy, or returns the id unchanged. */
  map: (id: string) => string
}

export interface ForkResult {
  board: Board
  ids: IdMap
}

function buildMap<T extends { id: string; origin_id: string | null }>(rows: T[]) {
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.origin_id) map.set(row.origin_id, row.id)
  }
  return map
}

/**
 * Deep-copies a board — groups (including the subgroup tree), positions with
 * their flags/notes/inactive state, and assignments — into a new board row.
 *
 * Members are deliberately not copied: they're ward-scoped and shared across
 * every version of the board.
 */
export async function forkBoard(
  sourceBoardId: string,
  options: { name: string; status?: 'draft'; isWorkingDraft?: boolean }
): Promise<ForkResult> {
  const sourceRes = await supabase
    .from('boards')
    .select('*')
    .eq('id', sourceBoardId)
    .single()

  if (sourceRes.error || !sourceRes.data) {
    throw new Error('Could not read the board to copy from')
  }
  const source = sourceRes.data as Board

  const userId = (await supabase.auth.getUser()).data.user?.id

  const boardRes = await supabase
    .from('boards')
    .insert({
      ward_id: source.ward_id,
      status: options.status ?? 'draft',
      name: options.name,
      parent_board_id: source.id,
      is_working_draft: options.isWorkingDraft ?? false,
      created_by: userId,
    })
    .select()
    .single()

  if (boardRes.error || !boardRes.data) {
    throw new Error(boardRes.error?.message || 'Failed to create the draft board')
  }
  const board = boardRes.data as Board

  const ids: IdMap = {
    groups: new Map(),
    positions: new Map(),
    assignments: new Map(),
    map: (id) => id,
  }

  const groupsRes = await supabase.from('groups').select('*').eq('board_id', source.id)
  if (groupsRes.error) throw groupsRes.error
  const sourceGroups = (groupsRes.data || []) as Group[]

  if (sourceGroups.length > 0) {
    // Parents first: a subgroup's parent_id has to point at a row that already
    // exists on the new board.
    const parents = sourceGroups.filter((g) => !g.parent_id)
    const children = sourceGroups.filter((g) => g.parent_id)

    const parentsRes = await supabase
      .from('groups')
      .insert(
        parents.map((g) => ({
          board_id: board.id,
          name: g.name,
          parent_id: null,
          sort_order: g.sort_order,
          origin_id: g.id,
        }))
      )
      .select()

    if (parentsRes.error) throw parentsRes.error
    ids.groups = buildMap((parentsRes.data || []) as Group[])

    if (children.length > 0) {
      const childrenRes = await supabase
        .from('groups')
        .insert(
          children.map((g) => ({
            board_id: board.id,
            name: g.name,
            parent_id: g.parent_id ? ids.groups.get(g.parent_id) ?? null : null,
            sort_order: g.sort_order,
            origin_id: g.id,
          }))
        )
        .select()

      if (childrenRes.error) throw childrenRes.error
      for (const [origin, copy] of buildMap((childrenRes.data || []) as Group[])) {
        ids.groups.set(origin, copy)
      }
    }

    const positionsRes = await supabase
      .from('positions')
      .select('*')
      .in('group_id', sourceGroups.map((g) => g.id))

    if (positionsRes.error) throw positionsRes.error
    const sourcePositions = (positionsRes.data || []) as Position[]

    if (sourcePositions.length > 0) {
      const insertPositionsRes = await supabase
        .from('positions')
        .insert(
          sourcePositions.map((p) => ({
            group_id: ids.groups.get(p.group_id) ?? p.group_id,
            title: p.title,
            sort_order: p.sort_order,
            flagged: p.flagged,
            inactive_at: p.inactive_at,
            notes: p.notes,
            origin_id: p.id,
          }))
        )
        .select()

      if (insertPositionsRes.error) throw insertPositionsRes.error
      ids.positions = buildMap((insertPositionsRes.data || []) as Position[])

      const assignmentsRes = await supabase
        .from('position_assignments')
        .select('*')
        .in('position_id', sourcePositions.map((p) => p.id))

      if (assignmentsRes.error) throw assignmentsRes.error
      const sourceAssignments = (assignmentsRes.data || []) as PositionAssignment[]

      if (sourceAssignments.length > 0) {
        const insertAssignmentsRes = await supabase
          .from('position_assignments')
          .insert(
            sourceAssignments.map((a) => ({
              position_id: ids.positions.get(a.position_id) ?? a.position_id,
              member_id: a.member_id,
              called_date: a.called_date,
              origin_id: a.id,
            }))
          )
          .select()

        if (insertAssignmentsRes.error) throw insertAssignmentsRes.error
        ids.assignments = buildMap(
          (insertAssignmentsRes.data || []) as PositionAssignment[]
        )
      }
    }
  }

  ids.map = (id: string) =>
    ids.groups.get(id) ?? ids.positions.get(id) ?? ids.assignments.get(id) ?? id

  return { board, ids }
}

/**
 * Rebuilds the id map for a board that was forked earlier, by reading the
 * `origin_id` each copied row already carries.
 */
export async function loadIdMap(boardId: string): Promise<IdMap> {
  const groupsRes = await supabase
    .from('groups')
    .select('id, origin_id')
    .eq('board_id', boardId)

  if (groupsRes.error) throw groupsRes.error
  const groupRows = (groupsRes.data || []) as { id: string; origin_id: string | null }[]

  const positionsRes = groupRows.length
    ? await supabase
        .from('positions')
        .select('id, origin_id')
        .in('group_id', groupRows.map((g) => g.id))
    : { data: [], error: null }

  if (positionsRes.error) throw positionsRes.error
  const positionRows = (positionsRes.data || []) as {
    id: string
    origin_id: string | null
  }[]

  const assignmentsRes = positionRows.length
    ? await supabase
        .from('position_assignments')
        .select('id, origin_id')
        .in('position_id', positionRows.map((p) => p.id))
    : { data: [], error: null }

  if (assignmentsRes.error) throw assignmentsRes.error

  const ids: IdMap = {
    groups: buildMap(groupRows),
    positions: buildMap(positionRows),
    assignments: buildMap(
      (assignmentsRes.data || []) as { id: string; origin_id: string | null }[]
    ),
    map: (id) => id,
  }

  ids.map = (id: string) =>
    ids.groups.get(id) ?? ids.positions.get(id) ?? ids.assignments.get(id) ?? id

  return ids
}
