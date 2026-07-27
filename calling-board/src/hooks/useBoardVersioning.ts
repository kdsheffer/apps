import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Board } from '../types'

export function useBoardVersioning(wardId: string) {
  const queryClient = useQueryClient()

  // Fetch all boards (promoted + drafts + archived) for this ward
  const allBoards = useQuery({
    queryKey: ['boards', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return data as Board[]
    },
    enabled: !!wardId,
  })

  // Fetch promoted board
  const promotedBoard = useQuery({
    queryKey: ['promotedBoard', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .maybeSingle()

      if (error) throw error
      return (data as Board) ?? null
    },
    enabled: !!wardId,
  })

  // Fetch all drafts for this ward
  const drafts = useQuery({
    queryKey: ['drafts', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'draft')
        .order('created_at', { ascending: false })

      if (error) throw error
      return (data || []) as Board[]
    },
    enabled: !!wardId,
  })

  // Create new draft by copying promoted board
  const createDraft = useMutation({
    mutationFn: async () => {
      const promotedRes = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .single()

      if (promotedRes.error || !promotedRes.data) {
        throw new Error('No promoted board found to copy')
      }

      const promoted = promotedRes.data as Board

      // Create new draft board
      const draftRes = await supabase
        .from('boards')
        .insert({
          ward_id: wardId,
          status: 'draft',
          name: `${promoted.name} - Draft ${new Date().toLocaleString()}`,
          parent_board_id: promoted.id,
          created_by: (await supabase.auth.getUser()).data.user?.id,
        })
        .select()
        .single()

      if (draftRes.error || !draftRes.data) {
        throw new Error('Failed to create draft board')
      }

      const draftBoard = draftRes.data as Board

      // Copy groups
      const groupsRes = await supabase
        .from('groups')
        .select('*')
        .eq('board_id', promoted.id)

      if (groupsRes.data && groupsRes.data.length > 0) {
        const newGroups = groupsRes.data.map((g) => ({
          board_id: draftBoard.id,
          name: g.name,
          sort_order: g.sort_order,
        }))

        const insertGroupsRes = await supabase
          .from('groups')
          .insert(newGroups)
          .select()

        if (insertGroupsRes.error) throw insertGroupsRes.error

        // Copy positions and assignments for each group
        const oldPositionsRes = await supabase
          .from('positions')
          .select('*')
          .in(
            'group_id',
            groupsRes.data.map((g) => g.id)
          )

        if (oldPositionsRes.data && oldPositionsRes.data.length > 0) {
          // Build a mapping of old group IDs to new group IDs
          const groupMapping: Record<string, string> = {}
          groupsRes.data.forEach((oldGroup, idx) => {
            const newGroup = insertGroupsRes.data?.[idx]
            if (newGroup) {
              groupMapping[oldGroup.id] = newGroup.id
            }
          })

          // Create new positions
          const newPositions = oldPositionsRes.data.map((p) => ({
            group_id: groupMapping[p.group_id],
            title: p.title,
            sort_order: p.sort_order,
          }))

          const insertPositionsRes = await supabase
            .from('positions')
            .insert(newPositions)
            .select()

          if (insertPositionsRes.error) throw insertPositionsRes.error

          // Copy assignments
          const oldAssignmentsRes = await supabase
            .from('position_assignments')
            .select('*')
            .in(
              'position_id',
              oldPositionsRes.data.map((p) => p.id)
            )

          if (oldAssignmentsRes.data && oldAssignmentsRes.data.length > 0) {
            // Build a mapping of old position IDs to new position IDs
            const positionMapping: Record<string, string> = {}
            oldPositionsRes.data.forEach((oldPos, idx) => {
              const newPos = insertPositionsRes.data?.[idx]
              if (newPos) {
                positionMapping[oldPos.id] = newPos.id
              }
            })

            const newAssignments = oldAssignmentsRes.data.map((a) => ({
              position_id: positionMapping[a.position_id],
              member_id: a.member_id,
              called_date: a.called_date,
            }))

            const insertAssignmentsRes = await supabase
              .from('position_assignments')
              .insert(newAssignments)

            if (insertAssignmentsRes.error) throw insertAssignmentsRes.error
          }
        }
      }

      return draftBoard
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
    },
  })

  // Promote a draft to promoted status
  const promoteDraft = useMutation({
    mutationFn: async (draftBoardId: string) => {
      // Get current promoted board
      const currentPromotedRes = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .single()

      const currentPromoted = currentPromotedRes.data as Board | null

      // Get all other drafts to delete
      const otherDraftsRes = await supabase
        .from('boards')
        .select('id')
        .eq('ward_id', wardId)
        .eq('status', 'draft')
        .neq('id', draftBoardId)

      const otherDrafts = otherDraftsRes.data || []

      // Single transaction: archive current, promote draft, delete others
      // Since we can't do true transactions via the JS client, we do this in order
      // with careful error handling

      // 1. Archive current promoted board if it exists
      if (currentPromoted) {
        const archiveRes = await supabase
          .from('boards')
          .update({ status: 'archived', promoted_at: null })
          .eq('id', currentPromoted.id)

        if (archiveRes.error) throw archiveRes.error
      }

      // 2. Promote the draft
      const promoteRes = await supabase
        .from('boards')
        .update({
          status: 'promoted',
          promoted_at: new Date().toISOString(),
        })
        .eq('id', draftBoardId)

      if (promoteRes.error) throw promoteRes.error

      // 3. Delete all other drafts
      if (otherDrafts.length > 0) {
        const deleteRes = await supabase
          .from('boards')
          .delete()
          .in(
            'id',
            otherDrafts.map((d) => d.id)
          )

        if (deleteRes.error) throw deleteRes.error
      }

      return { promotedBoardId: draftBoardId, deletedDraftCount: otherDrafts.length }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['promotedBoard', wardId] })
      queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
      queryClient.invalidateQueries({ queryKey: ['boardData'] })
    },
  })

  // Delete a single draft
  const deleteDraft = useMutation({
    mutationFn: async (draftBoardId: string) => {
      const { error } = await supabase
        .from('boards')
        .delete()
        .eq('id', draftBoardId)

      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
    },
  })

  return {
    allBoards,
    promotedBoard,
    drafts,
    createDraft,
    promoteDraft,
    deleteDraft,
  }
}
