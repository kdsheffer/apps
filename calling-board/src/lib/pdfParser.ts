/**
 * Parser for LCR "Organizations and Callings" PDF reports.
 *
 * The report's layout encodes its own hierarchy, so we read structure from
 * geometry rather than guessing from the text:
 *
 *   x=34, height 12   organization header      e.g. "Elders Quorum"
 *   x=34, height  9   subgroup header          e.g. "Elders Quorum Presidency"
 *   x=35, height  8   table header row         "Calling | Name | Sustained | Set Apart"
 *   x=37, height  8   calling row              title | member | date | checkmark
 *   x=54, height  8   roster table header      "Name | Age | Birth Date | ..."
 *   x=34, height  8   "Count: N" — ends the current table
 *
 * Sections whose header ends in "Members" are membership rosters, so they don't
 * contribute groups or callings — but they are the only place unassigned members
 * appear, so their Name column is harvested into `allMembers`.
 */

export interface PDFCell {
  x: number
  text: string
}

export interface PDFRow {
  height: number
  cells: PDFCell[]
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

const HEADER_X = 34
const X_TOLERANCE = 4
const GROUP_HEIGHT = 12
/** Subgroups come in two sizes; nested ones share the body text height. */
const SUBGROUP_HEIGHTS = [9, 8]
const BODY_HEIGHT = 8

export async function extractRowsFromPDF(file: File): Promise<PDFRow[]> {
  console.log('[PDF] Starting extraction from', file.name)

  // @ts-ignore - pdfjs-dist ships its own types under a subpath we don't reference
  const pdfjs = await import('pdfjs-dist')
  const { getDocument, GlobalWorkerOptions, version } = pdfjs
  console.log('[PDF] pdfjs-dist version:', version)

  // @ts-ignore
  GlobalWorkerOptions.workerSrc = new URL('/pdf.worker.mjs', window.location.origin).href

  const data = await file.arrayBuffer()
  const pdf: any = await getDocument({ data: new Uint8Array(data) }).promise
  console.log(`[PDF] Loaded ${pdf.numPages} pages`)

  const rows: PDFRow[] = []

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()

    // Bucket items into rows by their baseline Y, allowing a small tolerance so
    // that cells nudged a fraction of a point still land on the same row.
    const buckets: Array<{ y: number; height: number; cells: PDFCell[] }> = []

    for (const item of textContent.items as any[]) {
      if (!item.str || !item.str.trim()) continue

      const y = item.transform[5]
      const x = Math.round(item.transform[4])
      const height = Math.round(item.height ?? 0)

      let bucket = buckets.find((b) => Math.abs(b.y - y) <= 2)
      if (!bucket) {
        bucket = { y, height, cells: [] }
        buckets.push(bucket)
      }
      bucket.height = Math.max(bucket.height, height)
      bucket.cells.push({ x, text: item.str.trim() })
    }

    buckets.sort((a, b) => b.y - a.y)
    for (const bucket of buckets) {
      bucket.cells.sort((a, b) => a.x - b.x)
      rows.push({ height: bucket.height, cells: bucket.cells })
    }
  }

  console.log(`[PDF] Extracted ${rows.length} rows`)
  return rows
}

/**
 * Headings sit alone in the left margin, one indent step out from table rows.
 *
 * Primary and Nursery classes pin a room number to the far right of the heading
 * row ("Nursery … Room: 24-26"). It's an annotation on the heading rather than a
 * second column, so a heading is still a heading with one alongside it — without
 * this, those classes go unrecognized and their callings fall onto the parent
 * organization.
 */
function isHeadingSlot(row: PDFRow): boolean {
  const first = row.cells[0]
  if (!first || Math.abs(first.x - HEADER_X) > X_TOLERANCE) return false
  return row.cells.length === 1 || (row.cells.length === 2 && /^Room:/i.test(row.cells[1].text))
}

/** Roster sections list membership, not callings. */
function isRosterHeading(name: string): boolean {
  return /\bMembers$/i.test(name)
}

/**
 * A roster's Name column, located from its "Name | Age | …" header row. Roster
 * tables come in two shapes (with and without a Gender column), so the second
 * column's x is read off the header rather than assumed.
 */
interface RosterColumns {
  nameX: number
  secondX: number
}

/**
 * Pulls the name out of a roster row. Rows carry a "*" or "**" footnote marker
 * in the left margin that would otherwise be read as part of the name, and a
 * name too long for its cell wraps onto its own row with no other cells.
 */
function rosterNameFragment(row: PDFRow, roster: RosterColumns): string {
  const cells = row.cells.filter(
    (c) => c.x >= roster.nameX - 3 && c.x < roster.secondX - 10 && !/^\*+$/.test(c.text)
  )
  return cells.map((c) => c.text).join(' ')
}

export function parseCallingReport(rows: PDFRow[]): ParsedBoard {
  console.log('[Parser] Parsing calling report...')

  const allMembers = new Set<string>()
  const groupMap = new Map<string, ParsedBoard['groups'][0]>()

  let currentGroup = ''
  let currentSubgroup = ''
  // Column x-positions captured from the active "Calling | Name | Sustained" header.
  let columns: number[] | null = null
  // Set while a membership roster is open, cleared by anything that ends a table.
  let roster: RosterColumns | null = null
  // A wrapped name isn't complete until we've seen the row after it, so hold it
  // back rather than adding the first half to the set.
  let pendingName: string | null = null

  const commitPendingName = () => {
    if (pendingName) allMembers.add(pendingName)
    pendingName = null
  }

  const endTable = () => {
    commitPendingName()
    columns = null
    roster = null
  }

  const keyFor = (group: string, subgroup: string) =>
    subgroup ? `${group} › ${subgroup}` : group

  for (const row of rows) {
    const first = row.cells[0]
    if (!first) continue

    // --- Organization header -------------------------------------------------
    if (isHeadingSlot(row) && row.height === GROUP_HEIGHT) {
      endTable()
      // A roster heading ("Elders Quorum Members") introduces no callings, but
      // the roster table under it still gets read — that's driven by its own
      // "Name | Age | …" header below, not by this heading.
      if (isRosterHeading(first.text)) continue
      currentGroup = first.text
      currentSubgroup = ''
      console.log(`[Parser] Organization: ${currentGroup}`)
      continue
    }

    // --- Table boundaries ----------------------------------------------------
    if (first.text === 'Calling' && row.cells.length > 1) {
      // Column positions vary per table, so read them off each header row.
      endTable()
      columns = row.cells.map((c) => c.x)
      continue
    }

    // A roster header also repeats at the top of each page the roster spills
    // onto, which is what lets a roster resume after the page furniture.
    if (first.text === 'Name' && row.cells.length > 1) {
      endTable()
      roster = { nameX: first.x, secondX: row.cells[1].x }
      continue
    }

    // Row counts and footnotes close out a table. Both sit in the heading slot,
    // which keeps them from swallowing custom callings or roster rows — those
    // are marked with a leading asterisk too, but have cells beside it.
    if (isHeadingSlot(row) && (/^Count:/.test(first.text) || first.text.startsWith('*'))) {
      endTable()
      continue
    }

    // --- Subgroup header -----------------------------------------------------
    if (isHeadingSlot(row) && SUBGROUP_HEIGHTS.includes(row.height)) {
      endTable()
      currentSubgroup = isRosterHeading(first.text) ? '' : first.text
      if (currentSubgroup) console.log(`[Parser]   Subgroup: ${currentSubgroup}`)
      continue
    }

    // Page headers and footers share the subgroup text size, so require body
    // height here to keep them out of either table.
    if (row.height !== BODY_HEIGHT) continue

    // --- Roster row ----------------------------------------------------------
    // Rosters are the only place members without a calling appear, so harvest
    // the names even though the section contributes no groups or positions.
    if (roster) {
      const fragment = rosterNameFragment(row, roster)
      if (!fragment) continue

      // Every LCR name is "Last, First" — a fragment with no comma is the tail
      // of the name above it, which wrapped onto its own row.
      if (fragment.includes(',')) {
        commitPendingName()
        pendingName = fragment
      } else if (pendingName) {
        pendingName = `${pendingName} ${fragment}`
      }
      continue
    }

    // --- Calling row ---------------------------------------------------------
    if (!columns || !currentGroup) continue

    // Assign each cell to its nearest column.
    const byColumn: string[] = []
    for (const cell of row.cells) {
      let nearest = 0
      let bestDistance = Infinity
      for (let c = 0; c < columns.length; c++) {
        const distance = Math.abs(cell.x - columns[c])
        if (distance < bestDistance) {
          bestDistance = distance
          nearest = c
        }
      }
      byColumn[nearest] = byColumn[nearest] ? `${byColumn[nearest]} ${cell.text}` : cell.text
    }

    const title = (byColumn[0] ?? '').replace(/^\*\s*/, '').trim()
    const memberName = (byColumn[1] ?? '').trim()
    const dateStr = (byColumn[2] ?? '').trim()

    if (!title) continue

    const groupName = currentSubgroup || currentGroup
    const parentName = currentSubgroup ? currentGroup : undefined
    const key = keyFor(currentGroup, currentSubgroup)

    let group = groupMap.get(key)
    if (!group) {
      group = { name: groupName, parentName, positions: [] }
      groupMap.set(key, group)
    }

    // The same title can appear several times (multiple teachers, advisers, and
    // so on); each occurrence is a distinct seat, so give it its own position.
    const position = { title, callings: [] as Array<{ memberName: string; calledDate: string }> }
    group.positions.push(position)

    if (memberName && !/^Calling Vacant$/i.test(memberName)) {
      position.callings.push({ memberName, calledDate: convertDateFormat(dateStr) })
      allMembers.add(memberName)
    }
  }

  // A roster that runs to the last row of the document has no terminator.
  commitPendingName()

  const groups = Array.from(groupMap.values()).filter((g) => g.positions.length > 0)

  console.log(`[Parser] Parsed ${groups.length} groups with ${allMembers.size} unique members`)
  groups.forEach((g) => {
    console.log(
      `  - ${g.parentName ? `${g.parentName} › ` : ''}${g.name}: ${g.positions.length} positions`
    )
  })

  return { groups, allMembers }
}

function convertDateFormat(dateStr: string): string {
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }

  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
  if (!match) {
    return new Date().toISOString().split('T')[0]
  }

  const day = match[1].padStart(2, '0')
  const month = months[match[2].slice(0, 3).toLowerCase()] ?? '01'
  return `${match[3]}-${month}-${day}`
}
