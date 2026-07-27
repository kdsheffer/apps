import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { extractRowsFromPDF, parseCallingReport } from '../lib/pdfParser'
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
      const rows = await extractRowsFromPDF(file)

      // Parse the calling report
      console.log('[Import] Step 2: Parsing calling report...')
      const parsed = parseCallingReport(rows)
      console.log(`[Import] Parsed: ${parsed.groups.length} groups, ${parsed.allMembers.size} members`)

      if (parsed.groups.length === 0) {
        throw new Error(
          "No callings found in this PDF. Make sure it's the \"Organizations and Callings\" " +
            'report exported from LCR, and that it was saved as a PDF rather than scanned or printed to image.'
        )
      }

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

      console.log(`[Import] Step 5: Creating organizations and subgroups...`)

      // Top-level names are unique across the report, but subgroup names are not
      // — "Teachers" and "Music" each appear under several organizations — so
      // subgroups are keyed by parent as well as name.
      const subgroupKey = (parentName: string, name: string) => `${parentName} › ${name}`

      // An organization that only holds subgroups has no callings of its own, so
      // it never shows up as a parsed group. Create those parents anyway.
      const topLevelNames = new Set<string>()
      for (const group of parsed.groups) {
        topLevelNames.add(group.parentName ?? group.name)
      }

      const topLevelIds = new Map<string, string>()
      const { data: createdParents, error: parentError } = await supabase
        .from('groups')
        .insert(
          Array.from(topLevelNames).map((name, idx) => ({
            board_id: board.id,
            name,
            sort_order: idx,
          }))
        )
        .select('id, name')

      if (parentError || !createdParents) {
        throw new Error(`Failed to create organizations: ${parentError?.message}`)
      }
      createdParents.forEach((g) => topLevelIds.set(g.name, g.id))
      console.log(`[Import] Created ${createdParents.length} organizations`)

      // Create subgroups, pointing each at its parent organization.
      const childGroups = parsed.groups.filter((g) => g.parentName)
      const subgroupIds = new Map<string, string>()

      if (childGroups.length > 0) {
        const { data: createdChildren, error: childError } = await supabase
          .from('groups')
          .insert(
            childGroups.map((group, idx) => ({
              board_id: board.id,
              name: group.name,
              parent_id: topLevelIds.get(group.parentName!) ?? null,
              sort_order: idx,
            }))
          )
          .select('id, name')

        if (childError || !createdChildren) {
          throw new Error(`Failed to create subgroups: ${childError?.message}`)
        }

        // Insert order is preserved, so zip the results back onto the parsed
        // groups; matching by name alone would collide on repeated subgroups.
        createdChildren.forEach((created, idx) => {
          const source = childGroups[idx]
          subgroupIds.set(subgroupKey(source.parentName!, source.name), created.id)
        })
        console.log(`[Import] Created ${createdChildren.length} subgroups`)
      }

      const groupIdFor = (group: (typeof parsed.groups)[number]) =>
        group.parentName
          ? subgroupIds.get(subgroupKey(group.parentName, group.name))
          : topLevelIds.get(group.name)

      // Batch create all positions
      console.log('[Import] Step 6: Creating positions and callings...')

      // A title can repeat within a group — four "Teachers Quorum Adviser" seats,
      // for example — so keep an ordered list of the parsed positions alongside
      // the insert payload and pair them up by index afterwards.
      const positionsToCreate: any[] = []
      const positionSources: (typeof parsed.groups)[number]['positions'] = []

      for (const group of parsed.groups) {
        const groupId = groupIdFor(group)
        if (!groupId) continue

        group.positions.forEach((position, pIdx) => {
          positionsToCreate.push({
            group_id: groupId,
            title: position.title,
            sort_order: pIdx,
          })
          positionSources.push(position)
        })
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

      // Batch create all assignments
      console.log('[Import] Step 7: Creating member assignments...')
      const assignmentsToCreate: any[] = []
      createdPositions.forEach((createdPosition, idx) => {
        const source = positionSources[idx]
        if (!source) return

        for (const calling of source.callings) {
          const memberId = memberMap.get(calling.memberName)
          if (!memberId) {
            console.warn(`[Import] Member not found: ${calling.memberName}`)
            continue
          }

          assignmentsToCreate.push({
            position_id: createdPosition.id,
            member_id: memberId,
            called_date: calling.calledDate,
          })
        }
      })

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
        groupCount: topLevelNames.size + childGroups.length,
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
