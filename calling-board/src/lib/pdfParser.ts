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
  // Pattern: Position Name (words/hyphens, no comma) + spaces + Member Name (with comma) + spaces + Date + optional checkmark
  // The key is that names typically have a comma (Last, First format)
  const entryRegex =
    /([A-Za-z\s-]+?)\s{2,}([A-Za-z\s,'-]+?)\s{2,}(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*✓?/g

  let match
  const entries: Array<{ position: string; name: string; date: string; org: string }> = []

  // Find all entries
  while ((match = entryRegex.exec(cleanText)) !== null) {
    let positionName = match[1].trim()
    let memberName = match[2].trim()
    const dateStr = match[3].trim()

    // Skip invalid entries
    if (
      memberName.toLowerCase() === 'calling vacant' ||
      memberName.toLowerCase().includes('name') ||
      positionName.toLowerCase().includes('calling') ||
      positionName.length < 2 ||
      memberName.length < 2
    ) {
      continue
    }

    // Determine which organization this entry belongs to by looking at text before it
    let org = 'Unknown'
    const beforeText = cleanText.substring(0, match.index)

    // Find the last organization name mentioned before this entry
    for (const orgName of organizationNames) {
      const lastIndex = beforeText.lastIndexOf(orgName)
      if (lastIndex !== -1) {
        org = orgName
        break
      }
    }

    entries.push({
      position: positionName,
      name: memberName,
      date: dateStr,
      org,
    })
  }

  console.log(`[Parser] Found ${entries.length} calling entries`)

  // Group by organization and position
  for (const entry of entries) {
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
