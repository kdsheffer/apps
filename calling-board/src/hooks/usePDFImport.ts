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
      console.log('[Import] Starting PDF import process')
      console.log('[Import] File:', file.name, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`)

      // Extract text from PDF
      console.log('[Import] Step 1: Extracting text from PDF...')
      const text = await extractTextFromPDF(file)

      // Parse the calling report
      console.log('[Import] Step 2: Parsing calling report...')
      const parsed = parseCallingReport(text)
      console.log(`[Import] Parsed: ${parsed.groups.length} groups, ${parsed.allMembers.size} members`)

      // Get or create members - optimized batch operation
      console.log('[Import] Step 3: Managing members...')
      const memberMap = new Map<string, string>() // name -> id

      // Fetch existing members for this ward
      console.log('[Import] Fetching existing members...')
      const { data: existingMembers } = await supabase
        .from('members')
        .select('id, full_name')
        .eq('ward_id', wardId)
        .is('archived_at', null)

      // Map existing members
      existingMembers?.forEach((member) => {
        memberMap.set(member.full_name, member.id)
      })
      console.log(`[Import] Found ${existingMembers?.length || 0} existing members`)

      // Create new members for any not found - batch insert
      const newMemberNames = Array.from(parsed.allMembers).filter(
        (name) => !memberMap.has(name)
      )

      console.log(`[Import] Creating ${newMemberNames.length} new members...`)
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
        console.log(`[Import] Created ${created?.length || 0} new members`)
      }
      console.log(`[Import] Total members available: ${memberMap.size}`)

      // Create draft board
      console.log('[Import] Step 4: Creating draft board...')
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
      console.log(`[Import] Created board: ${boardRes.id}`)
      let totalPositions = 0

      // Batch create all groups
      console.log(`[Import] Step 5: Creating ${parsed.groups.length} organizations...`)
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
      console.log(`[Import] Created ${createdGroups?.length || 0} organizations`)

      // Map old group names to new group IDs
      const groupMap = new Map<string, string>()
      createdGroups.forEach((group, idx) => {
        groupMap.set(parsed.groups[idx].name, group.id)
      })

      // Batch create all positions
      console.log('[Import] Step 6: Creating positions and callings...')
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

      console.log(`[Import] Creating ${positionsToCreate.length} positions...`)
      const { data: createdPositions, error: posError } = await supabase
        .from('positions')
        .insert(positionsToCreate)
        .select('id, title, group_id')

      if (posError || !createdPositions) {
        throw new Error(`Failed to create positions: ${posError?.message}`)
      }

      totalPositions = createdPositions.length
      console.log(`[Import] Created ${totalPositions} positions`)

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
      console.log('[Import] Step 7: Creating member assignments...')
      const assignmentsToCreate: any[] = []
      for (let gIdx = 0; gIdx < parsed.groups.length; gIdx++) {
        const group = parsed.groups[gIdx]
        for (const position of group.positions) {
          const positionId = positionMap.get(`${group.name}:${position.title}`)
          if (!positionId) continue

          for (const calling of position.callings) {
            const memberId = memberMap.get(calling.memberName)
            if (!memberId) {
              console.warn(`[Import] Member not found: ${calling.memberName}`)
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

      console.log(`[Import] Creating ${assignmentsToCreate.length} assignments...`)
      if (assignmentsToCreate.length > 0) {
        const { error: assignError } = await supabase
          .from('position_assignments')
          .insert(assignmentsToCreate)

        if (assignError) {
          console.warn(`[Import] Some assignments failed: ${assignError.message}`)
        } else {
          console.log(`[Import] Created ${assignmentsToCreate.length} assignments`)
        }
      }

      console.log('[Import] ✅ Import complete!')
      console.log(`[Import] Summary: ${parsed.groups.length} organizations, ${totalPositions} positions, ${parsed.allMembers.size} members`)

      return {
        boardId: board.id,
        boardName: board.name,
        groupCount: parsed.groups.length,
        positionCount: totalPositions,
        memberCount: parsed.allMembers.size,
      }
    },
    onSuccess: (data) => {
      // Invalidate relevant queries - be specific about which board was imported
      queryClient.invalidateQueries({ queryKey: ['boards', wardId] })
      queryClient.invalidateQueries({ queryKey: ['drafts', wardId] })
      queryClient.invalidateQueries({ queryKey: ['boardData', data.boardId] })
    },
  })
}
