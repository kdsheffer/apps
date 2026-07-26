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
  created_by: string
  created_at: string
  promoted_at: string | null
}

export interface Group {
  id: string
  board_id: string
  name: string
  sort_order: number
  created_at: string
}

export interface Position {
  id: string
  group_id: string
  title: string
  sort_order: number
  created_at: string
}

export interface Member {
  id: string
  ward_id: string
  full_name: string
  contact_info: Record<string, unknown> | null
  archived_at: string | null
  created_at: string
}

export interface PositionAssignment {
  id: string
  position_id: string
  member_id: string
  called_date: string
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
