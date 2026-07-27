import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { extractTextFromPDF, parseCallingReport } from '../lib/pdfParser'
import type { Board } from '../types'

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

      // Get or create members - optimized batch operation
      const memberMap = new Map<string, string>() // name -> id

      // Fetch existing members for this ward
      const { data: existingMembers } = await supabase
        .from('members')
        .select('id, full_name')
        .eq('ward_id', wardId)
        .is('archived_at', null)

      // Map existing members
      existingMembers?.forEach((member) => {
        memberMap.set(member.full_name, member.id)
      })

      // Create new members for any not found - batch insert
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
          .select('id, full_name')

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
        .select('id')
        .single()

      if (boardError || !boardRes) {
        throw new Error(`Failed to create board: ${boardError?.message}`)
      }

      const board = boardRes as Board
      let totalPositions = 0

      // Batch create all groups
      const groupsToCreate = parsed.groups.map((group, idx) => ({
        board_id: board.id,
        name: group.name,
        sort_order: idx,
      }))

      const { data: createdGroups, error: groupsError } = await supabase
        .from('groups')
        .insert(groupsToCreate)
        .select('id, name')

      if (groupsError || !createdGroups) {
        throw new Error(`Failed to create groups: ${groupsError?.message}`)
      }

      // Map old group names to new group IDs
      const groupMap = new Map<string, string>()
      createdGroups.forEach((group, idx) => {
        groupMap.set(parsed.groups[idx].name, group.id)
      })

      // Batch create all positions
      const positionsToCreate: any[] = []
      for (let gIdx = 0; gIdx < parsed.groups.length; gIdx++) {
        const group = parsed.groups[gIdx]
        const groupId = groupMap.get(group.name)
        if (!groupId) continue

        for (let pIdx = 0; pIdx < group.positions.length; pIdx++) {
          const position = group.positions[pIdx]
          positionsToCreate.push({
            group_id: groupId,
            title: position.title,
            sort_order: pIdx,
          })
        }
      }

      const { data: createdPositions, error: posError } = await supabase
        .from('positions')
        .insert(positionsToCreate)
        .select('id, title, group_id')

      if (posError || !createdPositions) {
        throw new Error(`Failed to create positions: ${posError?.message}`)
      }

      totalPositions = createdPositions.length

      // Build position map: "GroupName:PositionTitle" -> id
      const positionMap = new Map<string, string>()
      let posIdx = 0
      for (let gIdx = 0; gIdx < parsed.groups.length; gIdx++) {
        const group = parsed.groups[gIdx]
        for (let pIdx = 0; pIdx < group.positions.length; pIdx++) {
          const position = group.positions[pIdx]
          const createdPos = createdPositions[posIdx]
          if (createdPos) {
            positionMap.set(`${group.name}:${position.title}`, createdPos.id)
          }
          posIdx++
        }
      }

      // Batch create all assignments
      const assignmentsToCreate: any[] = []
      for (let gIdx = 0; gIdx < parsed.groups.length; gIdx++) {
        const group = parsed.groups[gIdx]
        for (const position of group.positions) {
          const positionId = positionMap.get(`${group.name}:${position.title}`)
          if (!positionId) continue

          for (const calling of position.callings) {
            const memberId = memberMap.get(calling.memberName)
            if (!memberId) {
              console.warn(`Member not found: ${calling.memberName}`)
              continue
            }

            assignmentsToCreate.push({
              position_id: positionId,
              member_id: memberId,
              called_date: calling.calledDate,
            })
          }
        }
      }

      if (assignmentsToCreate.length > 0) {
        const { error: assignError } = await supabase
          .from('position_assignments')
          .insert(assignmentsToCreate)

        if (assignError) {
          console.warn(`Some assignments failed: ${assignError.message}`)
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
