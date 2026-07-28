export interface Ward {
  id: string
  name: string
  created_at: string
  created_by: string
}

export interface Board {
  id: string
  ward_id: string
  status: 'promoted' | 'draft' | 'archived'
  name: string
  parent_board_id: string | null
  is_working_draft: boolean
  created_by: string
  created_at: string
  promoted_at: string | null
}

export interface Group {
  id: string
  board_id: string
  name: string
  parent_id?: string | null
  /** Id of the row this was copied from when the board was forked into a draft. */
  origin_id: string | null
  sort_order: number
  created_at: string
}

export interface Position {
  id: string
  group_id: string
  title: string
  sort_order: number
  flagged: boolean
  inactive_at: string | null
  notes: string | null
  origin_id: string | null
  created_at: string
}

export interface Member {
  id: string
  ward_id: string
  full_name: string
  contact_info: Record<string, unknown> | null
  flagged: boolean
  notes: string | null
  /** Non-null means the member is inactive (moved out, unavailable, etc.). */
  archived_at: string | null
  created_at: string
}

export interface PositionAssignment {
  id: string
  position_id: string
  member_id: string
  called_date: string
  origin_id: string | null
  created_at: string
}

export interface CatalogPosition {
  id: string
  group_name: string
  position_title: string
  ward_id: string | null
  created_at: string
}

export interface Profile {
  id: string
  created_at: string
  is_super_admin: boolean
}

/** A top-level organization with its own callings and its subgroups. */
export interface GroupNode {
  group: Group
  positions: Position[]
  subgroups: { group: Group; positions: Position[] }[]
}

export type AssignAction = 'add' | 'move' | 'replace'

export interface BoardFilters {
  search: string
  groupIds: string[]
  subgroupIds: string[]
  flaggedOnly: boolean
  showInactive: boolean
  openOnly: boolean
}

export const emptyFilters: BoardFilters = {
  search: '',
  groupIds: [],
  subgroupIds: [],
  flaggedOnly: false,
  showInactive: false,
  openOnly: false,
}
