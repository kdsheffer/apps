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
    // @ts-ignore - pdfjs-dist doesn't have proper TS declarations
    const pdfjs = await import('pdfjs-dist')
    const { getDocument, GlobalWorkerOptions } = pdfjs

    // Create an inline worker using a blob data URL to avoid needing a separate worker file
    // This is a workaround that creates a minimal worker inline
    try {
      const workerCode = `
        self.onmessage = async function(e) {
          // Simple message passthrough - we'll handle text extraction client-side
          self.postMessage(e.data);
        };
      `
      const blob = new Blob([workerCode], { type: 'application/javascript' })
      const workerUrl = URL.createObjectURL(blob)
      GlobalWorkerOptions.workerSrc = workerUrl
    } catch (e) {
      // If inline worker fails, just log it - we'll try anyway
      console.warn('Failed to setup inline worker:', e)
    }

    const data = await file.arrayBuffer()
    const pdf = await getDocument({ data: new Uint8Array(data) }).promise

    let fullText = ''
    const maxPages = Math.min(pdf.numPages, 20)

    for (let i = 1; i <= maxPages; i++) {
      try {
        const page = await pdf.getPage(i)
        const textContent = await page.getTextContent()
        const pageText = textContent.items
          .map((item: any) => (item.str ? item.str : ''))
          .join(' ')
        fullText += pageText + '\n'
      } catch (pageError) {
        console.warn(`Error extracting page ${i}:`, pageError)
      }
    }

    return fullText
  } catch (error) {
    console.error('PDF extraction error:', error)
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

export function parseCallingReport(text: string): ParsedBoard {
  const lines = text.split('\n').map((line) => line.trim())

  const groups: ParsedBoard['groups'] = []
  const allMembers = new Set<string>()

  let currentOrganization = ''
  let currentGroup: (typeof groups)[0] | null = null

  // Common organization headers
  const organizationPatterns = [
    /^Bishopric$/i,
    /^Elders Quorum$/i,
    /^Relief Society$/i,
    /^Young Women$/i,
    /^Young Men$/i,
    /^Primary$/i,
    /^Sunday School$/i,
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!line) continue

    // Check if this is an organization header
    const isOrg = organizationPatterns.some((pattern) => pattern.test(line))

    if (isOrg) {
      currentOrganization = line
      currentGroup = {
        name: currentOrganization,
        positions: [],
      }
      groups.push(currentGroup)
      continue
    }

    // Skip if we haven't found an organization yet
    if (!currentGroup) continue

    // Look for calling assignment patterns: "Calling Name   Person Name   Date   ✓"
    // Pattern: word(s), then multiple spaces, then name, then date
    const callingMatch = line.match(
      /^([A-Za-z\s]+?)\s{2,}([A-Za-z\s,]+?)\s{2,}(\d{1,2}\s+[A-Za-z]+\s+\d{4})/
    )

    if (callingMatch) {
      const positionName = callingMatch[1].trim()
      const memberName = callingMatch[2].trim()
      const dateStr = callingMatch[3].trim()

      // Skip vacant callings
      if (memberName.toLowerCase() === 'calling vacant') {
        continue
      }

      // Convert date format (e.g., "28 Apr 2024" -> "2024-04-28")
      const calledDate = convertDateFormat(dateStr)

      // Find or create position
      let position = currentGroup.positions.find(
        (p) => p.title.toLowerCase() === positionName.toLowerCase()
      )

      if (!position) {
        position = {
          title: positionName,
          callings: [],
        }
        currentGroup.positions.push(position)
      }

      // Add calling and member
      position.callings.push({
        memberName,
        calledDate,
      })

      allMembers.add(memberName)
    }
  }

  // Clean up empty organizations
  const filteredGroups = groups.filter((g) => g.positions.length > 0)

  return {
    groups: filteredGroups,
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
