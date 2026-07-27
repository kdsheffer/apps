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
    { parent: 'Aaronic Priesthood Quorums', child: 'Deacons Quorum Presidency' },
  ]

  // Remove header rows and normalize spacing
  let cleanText = text
    .replace(/Calling\s+Name\s+Sustained\s+Set Apart/gi, ' ')
    .replace(/Calling\s+Name\s+Sustained/gi, ' ')

  // Strategy: Find all names (things with commas in "Last, First" format) followed by dates
  // Then work backwards to find the position name
  const entryRegex = /([A-Za-z\s,'-]+?)\s{2,}(\d{1,2}\s+[A-Za-z]+\s+\d{4})/g
  const dateRegex = /\d{1,2}\s+[A-Za-z]+\s+\d{4}/

  const entries: Array<{ org: string; parentOrg?: string; position: string; name: string; date: string }> = []

  let match
  const processedMatches = new Set<number>()

  while ((match = entryRegex.exec(cleanText)) !== null) {
    const fullMatch = match[0]
    const matchIndex = match.index!
    const dateStr = match[2]

    // Skip if we've already processed this match
    if (processedMatches.has(matchIndex)) continue
    processedMatches.add(matchIndex)

    // Extract the name/position text before the date
    const nameAndPositionText = match[1].trim()

    // Split by comma to separate name from potential position info
    const parts = nameAndPositionText.split(',').map(p => p.trim())

    if (parts.length < 2) continue

    // Last name part is parts[0], first name is parts[1]
    // Position name is everything before the name
    const firstName = parts[1]
    const lastName = parts[0]
    const memberName = `${lastName}, ${firstName}`

    // Find position: work backwards from the name to find the position
    const beforeNameIndex = matchIndex
    const beforeNameText = cleanText.substring(Math.max(0, beforeNameIndex - 200), beforeNameIndex)

    // Extract position: words immediately before the name
    const positionMatch = beforeNameText.match(/([A-Za-z\s-]+?)(?:\s{2,})?$/)
    let positionName = positionMatch ? positionMatch[1].trim() : ''

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

    // Check if position name contains a subgroup pattern
    for (const pattern of subgroupPatterns) {
      if (positionName.includes(pattern.child)) {
        org = pattern.child
        parentOrg = pattern.parent
        // Remove subgroup name from position if it's at start
        positionName = positionName.replace(pattern.child, '').trim()
        break
      }
    }

    // If not a subgroup, use the last organization found
    if (org === 'Unknown' && lastOrgName) {
      org = lastOrgName
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

  console.log(`[Parser] Found ${entries.length} entries`)

  // Group by organization
  for (const entry of entries) {
    // Get or create parent org if it exists
    let parentOrgGroup: ParsedBoard['groups'][0] | null = null
    if (entry.parentOrg) {
      if (!groupMap.has(entry.parentOrg)) {
        groupMap.set(entry.parentOrg, {
          name: entry.parentOrg,
          positions: [],
        })
      }
      parentOrgGroup = groupMap.get(entry.parentOrg)!
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
