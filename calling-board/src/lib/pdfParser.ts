export interface ParsedCalling {
  organizationName: string
  positionName: string
  memberName: string
  calledDate: string
}

export interface ParsedBoard {
  groups: Array<{
    name: string
    parentName?: string
    positions: Array<{
      title: string
      callings: Array<{
        memberName: string
        calledDate: string
      }>
    }>
  }>
  allMembers: Set<string>
}

export async function extractTextFromPDF(file: File): Promise<string> {
  try {
    console.log('[PDF] Starting text extraction from', file.name)

    // @ts-ignore - pdfjs-dist doesn't have proper TS declarations
    const pdfjs = await import('pdfjs-dist')
    const { getDocument, GlobalWorkerOptions, version } = pdfjs

    console.log('[PDF] pdfjs-dist version:', version)

    console.log('[PDF] Loading PDF document...')
    const data = await file.arrayBuffer()
    console.log('[PDF] Array buffer created, size:', data.byteLength)

    // Set worker BEFORE creating the document - use absolute path
    // @ts-ignore
    GlobalWorkerOptions.workerSrc = new URL('/pdf.worker.mjs', window.location.origin).href
    console.log('[PDF] Worker configured to:', GlobalWorkerOptions.workerSrc)

    // Add timeout wrapper around PDF loading
    const loadPromise = (async () => {
      console.log('[PDF] Creating PDF document object...')
      const doc = await getDocument({ data: new Uint8Array(data) }).promise
      console.log('[PDF] Document object created')
      return doc
    })()

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PDF loading timed out after 30 seconds')), 30000)
    )

    // @ts-ignore
    const pdf = await Promise.race([loadPromise, timeoutPromise])

    // @ts-ignore
    const pdfDoc: any = pdf
    console.log(`[PDF] PDF loaded with ${pdfDoc.numPages} pages`)

    let fullText = ''
    const maxPages = Math.min(pdfDoc.numPages, 20)
    console.log(`[PDF] Extracting text from ${maxPages} pages...`)

    for (let i = 1; i <= maxPages; i++) {
      try {
        const page = await pdfDoc.getPage(i)
        const textContent = await page.getTextContent()
        const pageText = textContent.items
          .map((item: any) => (item.str ? item.str : ''))
          .join(' ')
        fullText += pageText + '\n'

        if (i % 5 === 0) {
          console.log(`[PDF] Extracted ${i}/${maxPages} pages...`)
        }
      } catch (pageError) {
        console.warn(`[PDF] Error extracting page ${i}:`, pageError)
      }
    }

    console.log(`[PDF] Text extraction complete (${fullText.length} characters)`)
    return fullText
  } catch (error) {
    console.error('[PDF] Extraction error:', error)
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

export function parseCallingReport(text: string): ParsedBoard {
  console.log('[Parser] Starting to parse calling report...')

  const allMembers = new Set<string>()
  const groupMap = new Map<string, ParsedBoard['groups'][0]>()

  // Organization names to look for
  const organizationNames = [
    'Bishopric',
    'Elders Quorum',
    'Relief Society',
    'Young Women',
    'Young Men',
    'Primary',
    'Sunday School',
    'Aaronic Priesthood Quorums',
    'Melchizedek Priesthood',
  ]

  // Subgroup patterns - organizations that appear under parent organizations
  const subgroupPatterns = [
    { parent: 'Aaronic Priesthood Quorums', child: 'Presidency of the Aaronic Priesthood' },
    { parent: 'Aaronic Priesthood Quorums', child: 'Priests Quorum Presidency' },
    { parent: 'Aaronic Priesthood Quorums', child: 'Teachers Quorum Presidency' },
    { parent: 'Aaronic Priesthood Quorums', child: 'Teachers Quorum Adult Leaders' },
    { parent: 'Aaronic Priesthood Quorums', child: 'Deacons Quorum Presidency' },
    { parent: 'Aaronic Priesthood Quorums', child: 'Deacons Quorum Adult Leaders' },
  ]

  // Remove header rows and normalize spacing
  let cleanText = text
    .replace(/Calling\s+Name\s+Sustained\s+Set Apart/gi, ' ')
    .replace(/Calling\s+Name\s+Sustained/gi, ' ')

  // Strategy: Match "LastName, FirstName" followed by 2+ spaces and a date
  // This is more specific to avoid capturing position/org names
  const entryRegex = /([A-Za-z'-]+),\s+([A-Za-z'-]+)\s{2,}(\d{1,2}\s+[A-Za-z]+\s+\d{4})/g

  const entries: Array<{ org: string; parentOrg?: string; position: string; name: string; date: string }> = []

  let match
  const processedMatches = new Set<number>()
  let regexMatchCount = 0

  // Build a map of subgroup positions in the text
  const subgroupPositions = new Map<string, number>()
  for (const pattern of subgroupPatterns) {
    const idx = cleanText.lastIndexOf(pattern.child)
    if (idx >= 0) {
      subgroupPositions.set(pattern.child, idx)
    }
  }

  console.log('[Parser] Searching for entries with regex: LastName, FirstName + 2+ spaces + date...')
  while ((match = entryRegex.exec(cleanText)) !== null) {
    regexMatchCount++

    if (regexMatchCount <= 3) {
      console.log(`[Parser] Match ${regexMatchCount}: "${match[1]}, ${match[2]}" ... "${match[3]}"`)
    }
    const matchIndex = match.index!
    const lastName = match[1].trim()
    const firstName = match[2].trim()
    const dateStr = match[3]
    const memberName = `${lastName}, ${firstName}`

    // Skip if we've already processed this match
    if (processedMatches.has(matchIndex)) continue
    processedMatches.add(matchIndex)

    // Find position: work backwards from the name to find the position
    const beforeNameIndex = matchIndex
    const beforeNameText = cleanText.substring(Math.max(0, beforeNameIndex - 200), beforeNameIndex)

    // Extract position: words immediately before the name
    const positionMatch = beforeNameText.match(/([A-Za-z\s-]+?)(?:\s{2,})?$/)
    let positionName = positionMatch ? positionMatch[1].trim() : ''

    // Clean up subgroup patterns from position name if they appear
    for (const pattern of subgroupPatterns) {
      if (positionName.includes(pattern.child)) {
        positionName = positionName.replace(pattern.child, '').trim()
        break
      }
    }

    // Clean up position name (remove common junk)
    positionName = positionName
      .replace(/Calling$/i, '')
      .replace(/^Set Apart$/, '')
      .trim()

    // Skip if no position or invalid
    if (
      !positionName ||
      positionName.length < 2 ||
      memberName.toLowerCase().includes('calling vacant') ||
      memberName.toLowerCase().includes('name') ||
      positionName.toLowerCase().includes('calling')
    ) {
      continue
    }

    // Determine organization by looking backward in text
    let org = 'Unknown'
    let parentOrg: string | undefined

    // First, check if any subgroup header appears before this entry
    let nearestSubgroupIndex = -1
    let nearestSubgroupName = ''
    for (const [subgroupName, subgroupIndex] of subgroupPositions.entries()) {
      if (subgroupIndex < matchIndex && subgroupIndex > nearestSubgroupIndex) {
        nearestSubgroupIndex = subgroupIndex
        nearestSubgroupName = subgroupName
      }
    }

    // If we found a nearby subgroup, use it
    if (nearestSubgroupName) {
      org = nearestSubgroupName
      // Find parent org for this subgroup
      for (const pattern of subgroupPatterns) {
        if (pattern.child === nearestSubgroupName) {
          parentOrg = pattern.parent
          break
        }
      }
    } else {
      // Otherwise, find organization by looking backward in text
      const beforeEntryText = cleanText.substring(0, matchIndex)

      // Find all organization mentions before this entry
      let lastOrgIndex = -1
      let lastOrgName = ''
      for (const orgName of organizationNames) {
        const idx = beforeEntryText.lastIndexOf(orgName)
        if (idx > lastOrgIndex) {
          lastOrgIndex = idx
          lastOrgName = orgName
        }
      }

      // Use the last organization found
      if (lastOrgName) {
        org = lastOrgName
      }
    }

    entries.push({
      org,
      parentOrg,
      position: positionName,
      name: memberName,
      date: dateStr,
    })

    console.log(`[Parser] Entry: [${org}${parentOrg ? ` ← ${parentOrg}` : ''}] "${positionName}" → "${memberName}"`)
  }

  console.log(`[Parser] Regex found ${regexMatchCount} total matches, processed ${entries.length} valid entries`)

  // Group by organization
  for (const entry of entries) {
    // Ensure parent org exists if specified
    if (entry.parentOrg) {
      if (!groupMap.has(entry.parentOrg)) {
        groupMap.set(entry.parentOrg, {
          name: entry.parentOrg,
          positions: [],
        })
      }
    }

    // Get or create org group
    let group = groupMap.get(entry.org)
    if (!group) {
      group = {
        name: entry.org,
        parentName: entry.parentOrg,
        positions: [],
      }
      groupMap.set(entry.org, group)
    }

    // Get or create position
    let position = group.positions.find(p => p.title.toLowerCase() === entry.position.toLowerCase())
    if (!position) {
      position = {
        title: entry.position,
        callings: [],
      }
      group.positions.push(position)
    }

    // Add calling
    const calledDate = convertDateFormat(entry.date)
    position.callings.push({
      memberName: entry.name,
      calledDate,
    })

    allMembers.add(entry.name)
  }

  const groups = Array.from(groupMap.values()).filter(g => g.positions.length > 0)

  console.log(`[Parser] Parsed ${groups.length} organizations with ${allMembers.size} unique members`)
  groups.forEach(g => {
    console.log(`  - ${g.name}${g.parentName ? ` (under ${g.parentName})` : ''}: ${g.positions.length} positions`)
  })

  return {
    groups,
    allMembers,
  }
}

function convertDateFormat(dateStr: string): string {
  // Convert "28 Apr 2024" to "2024-04-28"
  const months: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  }

  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
  if (!match) {
    const today = new Date()
    return today.toISOString().split('T')[0]
  }

  const day = match[1].padStart(2, '0')
  const month = months[match[2].toLowerCase()]
  const year = match[3]

  return `${year}-${month}-${day}`
}
