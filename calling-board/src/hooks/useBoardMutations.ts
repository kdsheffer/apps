import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export function useBoardMutations() {
  const queryClient = useQueryClient()

  // Edits can be redirected into a freshly forked draft, so which board they
  // land on isn't known ahead of time — invalidate the whole board cache.
  const invalidateBoard = () => {
    queryClient.invalidateQueries({ queryKey: ['boardData'] })
  }

  const nextSortOrder = async (
    table: 'groups' | 'positions',
    column: 'board_id' | 'group_id',
    value: string
  ) => {
    const res = await supabase
      .from(table)
      .select('sort_order')
      .eq(column, value)
      .order('sort_order', { ascending: false })
      .limit(1)

    return (res.data?.[0]?.sort_order ?? 0) + 1
  }

  // --- Groups ---------------------------------------------------------------

  const addGroup = useMutation({
    mutationFn: async ({
      boardId,
      name,
      parentId,
    }: {
      boardId: string
      name: string
      parentId?: string | null
    }) => {
      const sort_order = await nextSortOrder('groups', 'board_id', boardId)

      const { data, error } = await supabase
        .from('groups')
        .insert({ board_id: boardId, name, parent_id: parentId ?? null, sort_order })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  const renameGroup = useMutation({
    mutationFn: async ({ groupId, name }: { groupId: string; name: string }) => {
      const { error } = await supabase.from('groups').update({ name }).eq('id', groupId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  const deleteGroup = useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await supabase.from('groups').delete().eq('id', groupId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  // --- Positions ------------------------------------------------------------

  const addPosition = useMutation({
    mutationFn: async ({ groupId, title }: { groupId: string; title: string }) => {
      const sort_order = await nextSortOrder('positions', 'group_id', groupId)

      const { data, error } = await supabase
        .from('positions')
        .insert({ group_id: groupId, title, sort_order })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  const renamePosition = useMutation({
    mutationFn: async ({ positionId, title }: { positionId: string; title: string }) => {
      const { error } = await supabase.from('positions').update({ title }).eq('id', positionId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  const deletePosition = useMutation({
    mutationFn: async (positionId: string) => {
      const { error } = await supabase.from('positions').delete().eq('id', positionId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  const updatePosition = useMutation({
    mutationFn: async ({
      positionId,
      ...fields
    }: {
      positionId: string
      flagged?: boolean
      inactive_at?: string | null
      notes?: string | null
    }) => {
      const { error } = await supabase.from('positions').update(fields).eq('id', positionId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  // --- Members --------------------------------------------------------------
  // Members are ward-scoped, so these never need a draft: they're shared by
  // every version of the board and editing one isn't editing the live board.

  const addMember = useMutation({
    mutationFn: async ({ wardId, full_name }: { wardId: string; full_name: string }) => {
      const { data, error } = await supabase
        .from('members')
        .insert({ ward_id: wardId, full_name })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  const updateMember = useMutation({
    mutationFn: async ({
      memberId,
      ...fields
    }: {
      memberId: string
      full_name?: string
      flagged?: boolean
      archived_at?: string | null
      notes?: string | null
    }) => {
      const { error } = await supabase.from('members').update(fields).eq('id', memberId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  /** Only used to undo adding a member; releasing one is `archived_at`. */
  const deleteMember = useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await supabase.from('members').delete().eq('id', memberId)
      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  // --- Assignments ----------------------------------------------------------

  const createAssignment = useMutation({
    mutationFn: async ({
      positionId,
      memberId,
      calledDate,
    }: {
      positionId: string
      memberId: string
      calledDate: string
    }) => {
      const { data, error } = await supabase
        .from('position_assignments')
        .insert({ position_id: positionId, member_id: memberId, called_date: calledDate })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  /**
   * One call covers add / move / replace: `removeAssignmentIds` is whatever the
   * caller decided should go away first — the member's current callings for a
   * move, the position's current occupants for a replace, nothing for an add.
   */
  const assignMember = useMutation({
    mutationFn: async ({
      positionId,
      memberId,
      calledDate,
      removeAssignmentIds = [],
    }: {
      positionId: string
      memberId: string
      calledDate: string
      removeAssignmentIds?: string[]
    }) => {
      if (removeAssignmentIds.length > 0) {
        const { error } = await supabase
          .from('position_assignments')
          .delete()
          .in('id', removeAssignmentIds)

        if (error) throw error
      }

      const { data, error } = await supabase
        .from('position_assignments')
        .insert({ position_id: positionId, member_id: memberId, called_date: calledDate })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  /** Puts released assignments back, for undo. The restored rows get new ids. */
  const restoreAssignments = useMutation({
    mutationFn: async (
      rows: { position_id: string; member_id: string; called_date: string }[]
    ) => {
      if (rows.length === 0) return []

      const { data, error } = await supabase
        .from('position_assignments')
        .insert(rows)
        .select()

      if (error) throw error
      return data as { id: string }[]
    },
    onSuccess: invalidateBoard,
  })

  const deleteAssignments = useMutation({
    mutationFn: async (assignmentIds: string[]) => {
      if (assignmentIds.length === 0) return

      const { error } = await supabase
        .from('position_assignments')
        .delete()
        .in('id', assignmentIds)

      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  const updateAssignmentDate = useMutation({
    mutationFn: async ({
      assignmentId,
      calledDate,
    }: {
      assignmentId: string
      calledDate: string
    }) => {
      const { error } = await supabase
        .from('position_assignments')
        .update({ called_date: calledDate })
        .eq('id', assignmentId)

      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  const deleteAssignment = useMutation({
    mutationFn: async (assignmentId: string) => {
      const { error } = await supabase
        .from('position_assignments')
        .delete()
        .eq('id', assignmentId)

      if (error) throw error
    },
    onSuccess: invalidateBoard,
  })

  return {
    addGroup,
    renameGroup,
    deleteGroup,
    addPosition,
    renamePosition,
    deletePosition,
    updatePosition,
    addMember,
    updateMember,
    deleteMember,
    createAssignment,
    assignMember,
    restoreAssignments,
    deleteAssignments,
    updateAssignmentDate,
    deleteAssignment,
  }
}
