import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { forkBoard } from '../lib/forkBoard'
import type { Board } from '../types'

export const WORKING_DRAFT_NAME = 'Working Draft'

export function useBoardVersioning(wardId: string) {
  const queryClient = useQueryClient()

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
    queryClient.invalidateQueries({ queryKey: ['promotedBoard', wardId] })
    queryClient.invalidateQueries({ queryKey: ['board', wardId] })
    queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
    queryClient.invalidateQueries({ queryKey: ['boardData'] })
  }

  // Every board (promoted + drafts + archived) for this ward
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

  /** Manual "+ New Draft" — a named, timestamped copy of the live board. */
  const createDraft = useMutation({
    mutationFn: async () => {
      const promotedRes = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .maybeSingle()

      if (promotedRes.error) throw promotedRes.error
      if (!promotedRes.data) throw new Error('No live board to copy from')

      const promoted = promotedRes.data as Board
      const { board } = await forkBoard(promoted.id, {
        name: `${promoted.name} — Draft ${new Date().toLocaleString()}`,
      })
      return board
    },
    onSuccess: invalidateAll,
  })

  const promoteDraft = useMutation({
    mutationFn: async (draftBoardId: string) => {
      const currentPromotedRes = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .maybeSingle()

      const currentPromoted = (currentPromotedRes.data as Board) ?? null

      const otherDraftsRes = await supabase
        .from('boards')
        .select('id')
        .eq('ward_id', wardId)
        .eq('status', 'draft')
        .neq('id', draftBoardId)

      const otherDrafts = otherDraftsRes.data || []

      // No true transactions through the JS client, so this runs in the order
      // that keeps the one-promoted-per-ward index satisfied at every step.
      if (currentPromoted) {
        const archiveRes = await supabase
          .from('boards')
          .update({ status: 'archived', promoted_at: null, is_working_draft: false })
          .eq('id', currentPromoted.id)

        if (archiveRes.error) throw archiveRes.error
      }

      // Clearing is_working_draft matters: the partial unique index would
      // otherwise keep the ward from ever opening a new working draft.
      const promoteRes = await supabase
        .from('boards')
        .update({
          status: 'promoted',
          promoted_at: new Date().toISOString(),
          is_working_draft: false,
        })
        .eq('id', draftBoardId)

      if (promoteRes.error) throw promoteRes.error

      if (otherDrafts.length > 0) {
        const deleteRes = await supabase
          .from('boards')
          .delete()
          .in('id', otherDrafts.map((d) => d.id))

        if (deleteRes.error) throw deleteRes.error
      }

      return { promotedBoardId: draftBoardId, deletedDraftCount: otherDrafts.length }
    },
    onSuccess: invalidateAll,
  })

  const deleteDraft = useMutation({
    mutationFn: async (draftBoardId: string) => {
      const { error } = await supabase.from('boards').delete().eq('id', draftBoardId)
      if (error) throw error
    },
    onSuccess: invalidateAll,
  })

  const renameBoard = useMutation({
    mutationFn: async ({ boardId, name }: { boardId: string; name: string }) => {
      const { error } = await supabase.from('boards').update({ name }).eq('id', boardId)
      if (error) throw error
    },
    onSuccess: invalidateAll,
  })

  return {
    allBoards,
    promotedBoard,
    drafts,
    createDraft,
    promoteDraft,
    deleteDraft,
    renameBoard,
  }
}
