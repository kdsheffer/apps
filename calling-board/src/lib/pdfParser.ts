export interface ParsedCalling {
  organizationName: string
  positionName: string
  memberName: string
  calledDate: string
}

export interface ParsedBoard {
  groups: Array<{
    name: string
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
  ]

  // Remove header rows first
  let cleanText = text
    .replace(/Calling\s+Name\s+Sustained\s+Set Apart/gi, ' ')
    .replace(/Calling\s+Name\s+Sustained/gi, ' ')

  // Extract all calling entries using regex
  // Pattern: Position Name (words/hyphens, no comma) + spaces + Member Name (MUST have comma for Last, First) + spaces + Date
  // The comma is the key delimiter between position and name
  // Important: Hyphen must be escaped or at start/end of character class to avoid creating ranges
  const entryRegex =
    /([A-Za-z\s\-]+?)\s{2,}([A-Za-z\s\-']+,\s*[A-Za-z\s\-']+?)\s{2,}(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*✓?/g

  let match
  const entries: Array<{ position: string; name: string; date: string; org: string }> = []

  // First pass: extract entries and find organization assignments
  const tempEntries: Array<{ position: string; name: string; date: string; index: number }> = []

  while ((match = entryRegex.exec(cleanText)) !== null) {
    let positionName = match[1].trim()
    let memberName = match[2].trim()
    const dateStr = match[3].trim()

    // Skip invalid entries
    if (
      memberName.toLowerCase() === 'calling vacant' ||
      memberName.toLowerCase().includes('calling vacant') ||
      memberName.toLowerCase().includes('name') ||
      positionName.toLowerCase().includes('calling vacant') ||
      positionName.toLowerCase().includes('calling') ||
      positionName.includes('Ward') || // Position names shouldn't start with "Ward"
      positionName.length < 2 ||
      memberName.length < 2
    ) {
      continue
    }

    tempEntries.push({
      position: positionName,
      name: memberName,
      date: dateStr,
      index: match.index!,
    })
  }

  console.log(`[Parser] Extracted ${tempEntries.length} temp entries`)

  // Second pass: assign organizations to entries
  for (const entry of tempEntries) {
    let org = 'Unknown'

    // Check if position name contains an organization name
    for (const orgName of organizationNames) {
      if (entry.position.includes(orgName)) {
        org = orgName
        // Remove org name from position if it's at the start
        if (entry.position.startsWith(orgName)) {
          entry.position = entry.position.substring(orgName.length).trim()
        }
        break
      }
    }

    // If no org found in position name, look backward in text
    if (org === 'Unknown') {
      const beforeText = cleanText.substring(0, entry.index)
      // Find the last organization name mentioned before this entry
      let lastOrgIndex = -1
      for (const orgName of organizationNames) {
        const lastIndex = beforeText.lastIndexOf(orgName)
        if (lastIndex > lastOrgIndex) {
          lastOrgIndex = lastIndex
          org = orgName
        }
      }
    }

    entries.push({
      position: entry.position,
      name: entry.name,
      date: entry.date,
      org,
    })
  }

  // Deduplicate entries (same position + name)
  const seenEntries = new Set<string>()
  const deduplicatedEntries = []

  for (const entry of entries) {
    const key = `${entry.org}|${entry.position}|${entry.name}`
    if (!seenEntries.has(key)) {
      seenEntries.add(key)
      deduplicatedEntries.push(entry)
    }
  }

  console.log(
    `[Parser] Regex found ${tempEntries.length} temp entries → ${entries.length} entries after org assignment → ${deduplicatedEntries.length} after deduplication`
  )
  console.log('[Parser] Sample entries:', deduplicatedEntries.slice(0, 3))

  // Group by organization and position
  for (const entry of deduplicatedEntries) {
    // Get or create organization group
    let group = groupMap.get(entry.org)
    if (!group) {
      group = {
        name: entry.org,
        positions: [],
      }
      groupMap.set(entry.org, group)
    }

    // Get or create position
    let position = group.positions.find(
      (p) => p.title.toLowerCase() === entry.position.toLowerCase()
    )
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

  const groups = Array.from(groupMap.values()).filter((g) => g.positions.length > 0)

  console.log(`[Parser] Parsed ${groups.length} organizations with ${allMembers.size} unique members`)
  groups.forEach((g) => {
    console.log(`  - ${g.name}: ${g.positions.length} positions`)
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
    // Default to today if parsing fails
    const today = new Date()
    return today.toISOString().split('T')[0]
  }

  const day = match[1].padStart(2, '0')
  const month = months[match[2].toLowerCase()]
  const year = match[3]

  return `${year}-${month}-${day}`
}
