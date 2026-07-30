import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { extractRowsFromPDF, parseCallingReport } from '../lib/pdfParser'
import { emptySnapshot, planImportMerge, summarize } from '../lib/mergeImport'
import { executeMergePlan, loadSnapshot } from '../lib/applyMerge'
import { forkBoard } from '../lib/forkBoard'
import { WORKING_DRAFT_NAME } from './useBoardVersioning'
import type { MergePlan, MergeSummary } from '../lib/mergeImport'
import type { Board } from '../types'

/**
 * `null` starts from an empty board — the right choice for a ward's very first
 * import, and an escape hatch when a board has gone wrong badly enough to be
 * worth rebuilding.
 */
export type BaseBoardChoice = string | null

export interface ImportRequest {
  file: File
  baseBoardId: BaseBoardChoice
}

export interface ImportResult {
  boardId: string
  boardName: string
  summary: MergeSummary
  retired: MergePlan['retired']
  absentMembers: MergePlan['absentMembers']
}

/**
 * Imports an LCR report by merging it into the ward's editable draft.
 *
 * Everything lands in the draft, never the live board — the same rule the rest
 * of the app follows. Which board the draft *starts* from is the caller's
 * choice: merging into the existing draft keeps working on it, while any other
 * base replaces the draft with a fresh copy of that board.
 */
export function usePDFImport(wardId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ file, baseBoardId }: ImportRequest): Promise<ImportResult> => {
      console.log('[Import] Reading', file.name)
      const rows = await extractRowsFromPDF(file)
      const parsed = parseCallingReport(rows)
      console.log(
        `[Import] Parsed ${parsed.groups.length} organizations, ${parsed.allMembers.size} members`
      )

      if (parsed.groups.length === 0) {
        throw new Error(
          "No callings found in this PDF. Make sure it's the \"Organizations and Callings\" " +
            'report exported from LCR, and that it was saved as a PDF rather than scanned or printed to image.'
        )
      }

      const draftRes = await supabase
        .from('boards')
        .select('*')
        .eq('ward_id', wardId)
        .eq('status', 'draft')
        .maybeSingle()

      if (draftRes.error) throw draftRes.error
      const draft = (draftRes.data as Board) ?? null

      const target = await prepareTarget({ wardId, draft, baseBoardId, fileName: file.name })
      console.log(`[Import] Merging into board ${target.id} (${target.name})`)

      const snapshot = target.fresh ? emptySnapshot : await loadSnapshot(target.id, wardId)
      const plan = planImportMerge(parsed, snapshot)
      const summary = summarize(plan)
      console.log('[Import] Plan', summary)

      await executeMergePlan(plan, { boardId: target.id, wardId })

      // Best-effort audit trail — a failed insert here shouldn't undo a good
      // import, so it's logged rather than thrown.
      const { error: auditError } = await supabase.from('imports').insert({
        ward_id: wardId,
        uploaded_by: (await supabase.auth.getUser()).data.user?.id,
        file_name: file.name,
        status: 'complete',
        base_board_id: baseBoardId,
        resulting_board_id: target.id,
        summary,
      })
      if (auditError) console.warn('[Import] Could not record the import:', auditError.message)

      console.log('[Import] Done')
      return {
        boardId: target.id,
        boardName: target.name,
        summary,
        retired: plan.retired,
        absentMembers: plan.absentMembers,
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['draft', wardId] })
      queryClient.invalidateQueries({ queryKey: ['boardData'] })
    },
  })
}

interface TargetOptions {
  wardId: string
  draft: Board | null
  baseBoardId: BaseBoardChoice
  fileName: string
}

/**
 * Works out which board the merge writes to, and gets it into place.
 *
 * A ward holds one draft, so choosing a base other than the draft that already
 * exists means replacing it. The UI asks before it comes to that.
 */
async function prepareTarget({ wardId, draft, baseBoardId, fileName }: TargetOptions) {
  if (draft && baseBoardId === draft.id) {
    return { id: draft.id, name: draft.name, fresh: false }
  }

  if (draft) {
    const { error } = await supabase.from('boards').delete().eq('id', draft.id)
    if (error) throw new Error(`Could not replace the existing draft: ${error.message}`)
  }

  if (baseBoardId) {
    const { board } = await forkBoard(baseBoardId, { name: WORKING_DRAFT_NAME })
    return { id: board.id, name: board.name, fresh: false }
  }

  const name = `${fileName.replace(/\.pdf$/i, '')} — ${new Date().toLocaleDateString()}`
  const { data, error } = await supabase
    .from('boards')
    .insert({
      ward_id: wardId,
      status: 'draft',
      name,
      created_by: (await supabase.auth.getUser()).data.user?.id,
    })
    .select()
    .single()

  if (error || !data) throw new Error(`Could not create a board: ${error?.message}`)
  return { id: (data as Board).id, name: (data as Board).name, fresh: true }
}
