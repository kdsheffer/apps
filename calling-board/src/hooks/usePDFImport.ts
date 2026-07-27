import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { extractTextFromPDF, parseCallingReport } from '../lib/pdfParser'
import type { Board, Group, Position } from '../types'

interface PDFImportResult {
  boardId: string
  boardName: string
  groupCount: number
  positionCount: number
  memberCount: number
}

export function usePDFImport(wardId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: File): Promise<PDFImportResult> => {
      // Extract text from PDF
      const text = await extractTextFromPDF(file)

      // Parse the calling report
      const parsed = parseCallingReport(text)

      // Get or create members
      const memberMap = new Map<string, string>() // name -> id

      // Fetch existing members for this ward
      const { data: existingMembers } = await supabase
        .from('members')
        .select('*')
        .eq('ward_id', wardId)
        .eq('archived_at', null)

      // Map existing members
      existingMembers?.forEach((member) => {
        memberMap.set(member.full_name, member.id)
      })

      // Create new members for any not found
      const newMemberNames = Array.from(parsed.allMembers).filter(
        (name) => !memberMap.has(name)
      )

      if (newMemberNames.length > 0) {
        const { data: created } = await supabase
          .from('members')
          .insert(
            newMemberNames.map((name) => ({
              ward_id: wardId,
              full_name: name,
            }))
          )
          .select()

        created?.forEach((member) => {
          memberMap.set(member.full_name, member.id)
        })
      }

      // Create draft board
      const boardName = `${file.name} - ${new Date().toLocaleDateString()}`
      const { data: boardRes, error: boardError } = await supabase
        .from('boards')
        .insert({
          ward_id: wardId,
          status: 'draft',
          name: boardName,
          created_by: (await supabase.auth.getUser()).data.user?.id,
        })
        .select()
        .single()

      if (boardError || !boardRes) {
        throw new Error(`Failed to create board: ${boardError?.message}`)
      }

      const board = boardRes as Board
      let totalPositions = 0

      // Create groups and positions
      for (const group of parsed.groups) {
        const { data: groupRes, error: groupError } = await supabase
          .from('groups')
          .insert({
            board_id: board.id,
            name: group.name,
            sort_order: parsed.groups.indexOf(group),
          })
          .select()
          .single()

        if (groupError || !groupRes) {
          throw new Error(`Failed to create group: ${groupError?.message}`)
        }

        const createdGroup = groupRes as Group

        // Create positions for this group
        for (const position of group.positions) {
          const { data: posRes, error: posError } = await supabase
            .from('positions')
            .insert({
              group_id: createdGroup.id,
              title: position.title,
              sort_order: group.positions.indexOf(position),
            })
            .select()
            .single()

          if (posError || !posRes) {
            throw new Error(`Failed to create position: ${posError?.message}`)
          }

          const createdPosition = posRes as Position
          totalPositions++

          // Create assignments for this position
          for (const calling of position.callings) {
            const memberId = memberMap.get(calling.memberName)
            if (!memberId) {
              console.warn(`Member not found: ${calling.memberName}`)
              continue
            }

            const { error: assignError } = await supabase
              .from('position_assignments')
              .insert({
                position_id: createdPosition.id,
                member_id: memberId,
                called_date: calling.calledDate,
              })

            if (assignError) {
              console.warn(`Failed to create assignment: ${assignError.message}`)
            }
          }
        }
      }

      return {
        boardId: board.id,
        boardName: board.name,
        groupCount: parsed.groups.length,
        positionCount: totalPositions,
        memberCount: parsed.allMembers.size,
      }
    },
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
      queryClient.invalidateQueries({ queryKey: ['boardData'] })
    },
  })
}
