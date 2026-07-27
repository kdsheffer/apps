import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export function useBoardMutations(boardId: string) {
  const queryClient = useQueryClient()

  const invalidateBoard = () => {
    queryClient.invalidateQueries({ queryKey: ['boardData', boardId] })
  }

  // Groups
  const addGroup = useMutation({
    mutationFn: async (name: string) => {
      const maxSort = await supabase
        .from('groups')
        .select('sort_order', { count: 'exact' })
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)

      const nextSort = (maxSort.data?.[0]?.sort_order ?? 0) + 1

      const { data, error } = await supabase
        .from('groups')
        .insert({ board_id: boardId, name, sort_order: nextSort })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  const renameGroup = useMutation({
    mutationFn: async ({ groupId, name }: { groupId: string; name: string }) => {
      const { data, error } = await supabase
        .from('groups')
        .update({ name })
        .eq('id', groupId)
        .select()
        .single()

      if (error) throw error
      return data
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

  // Positions
  const addPosition = useMutation({
    mutationFn: async ({ groupId, title }: { groupId: string; title: string }) => {
      const maxSort = await supabase
        .from('positions')
        .select('sort_order', { count: 'exact' })
        .eq('group_id', groupId)
        .order('sort_order', { ascending: false })
        .limit(1)

      const nextSort = (maxSort.data?.[0]?.sort_order ?? 0) + 1

      const { data, error } = await supabase
        .from('positions')
        .insert({ group_id: groupId, title, sort_order: nextSort })
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  const renamePosition = useMutation({
    mutationFn: async ({ positionId, title }: { positionId: string; title: string }) => {
      const { data, error } = await supabase
        .from('positions')
        .update({ title })
        .eq('id', positionId)
        .select()
        .single()

      if (error) throw error
      return data
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

  // Members
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

  const archiveMember = useMutation({
    mutationFn: async (memberId: string) => {
      const { data, error } = await supabase
        .from('members')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', memberId)
        .select()
        .single()

      if (error) throw error
      return data
    },
    onSuccess: invalidateBoard,
  })

  // Assignments
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

  const updateAssignmentDate = useMutation({
    mutationFn: async ({
      assignmentId,
      calledDate,
    }: {
      assignmentId: string
      calledDate: string
    }) => {
      const { data, error } = await supabase
        .from('position_assignments')
        .update({ called_date: calledDate })
        .eq('id', assignmentId)
        .select()
        .single()

      if (error) throw error
      return data
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
    addMember,
    archiveMember,
    createAssignment,
    updateAssignmentDate,
    deleteAssignment,
  }
}
