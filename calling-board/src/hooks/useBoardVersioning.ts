import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { forkBoard } from '../lib/forkBoard'
import type { Board } from '../types'

export const WORKING_DRAFT_NAME = 'Working Draft'

/**
 * A ward has three kinds of board and only ever one of the first two:
 *
 *   promoted — the live board, read-only, what everybody sees
 *   draft    — the one editable board; every change lands here
 *   archived — boards that used to be live, kept as history
 *
 * Promoting the draft archives the outgoing live board and leaves the ward with
 * no draft until the next edit (or import) opens a fresh one.
 */
export function useBoardVersioning(wardId: string) {
  const queryClient = useQueryClient()

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
    queryClient.invalidateQueries({ queryKey: ['promotedBoard', wardId] })
    queryClient.invalidateQueries({ queryKey: ['board', wardId] })
    queryClient.invalidateQueries({ queryKey: ['draft', wardId] })
    queryClient.invalidateQueries({ queryKey: ['boardData'] })
  }

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

  const draft = useQuery({
    queryKey: ['draft', wardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'draft')
        .maybeSingle()

      if (error) throw error
      return (data as Board) ?? null
    },
    enabled: !!wardId,
  })

  /** Opens the draft by hand, rather than waiting for the first edit to do it. */
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

      const { board } = await forkBoard((promotedRes.data as Board).id, {
        name: WORKING_DRAFT_NAME,
      })
      return board
    },
    onSuccess: invalidateAll,
  })

  const promoteDraft = useMutation({
    mutationFn: async (draftBoardId: string) => {
      const currentPromotedRes = await supabase
        .from('boards')
        .select('id')
        .eq('ward_id', wardId)
        .eq('status', 'promoted')
        .maybeSingle()

      if (currentPromotedRes.error) throw currentPromotedRes.error
      const currentPromoted = currentPromotedRes.data as { id: string } | null

      // No transactions through the JS client, so this runs in the order that
      // keeps the one-promoted-per-ward index satisfied at every step.
      if (currentPromoted) {
        const archiveRes = await supabase
          .from('boards')
          .update({ status: 'archived', promoted_at: null })
          .eq('id', currentPromoted.id)

        if (archiveRes.error) throw archiveRes.error
      }

      const promoteRes = await supabase
        .from('boards')
        .update({ status: 'promoted', promoted_at: new Date().toISOString() })
        .eq('id', draftBoardId)

      if (promoteRes.error) throw promoteRes.error
      return { promotedBoardId: draftBoardId }
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
    draft,
    createDraft,
    promoteDraft,
    deleteDraft,
    renameBoard,
  }
}
