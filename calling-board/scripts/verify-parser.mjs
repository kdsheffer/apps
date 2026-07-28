// Runs the app's real parser (not a reimplementation) against a PDF.
// Usage: node verify-parser.mjs "public/Organizations and Callings.pdf"
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync } from 'node:fs'
import esbuild from 'esbuild'

const source = readFileSync(new URL('../src/lib/pdfParser.ts', import.meta.url), 'utf8')
const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' })
const { parseCallingReport } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
)

const data = new Uint8Array(readFileSync(process.argv[2]))
const pdf = await getDocument({ data }).promise

const rows = []
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const tc = await page.getTextContent()
  const buckets = []
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue
    const y = item.transform[5]
    const x = Math.round(item.transform[4])
    const height = Math.round(item.height ?? 0)
    let b = buckets.find((b) => Math.abs(b.y - y) <= 2)
    if (!b) { b = { y, height, cells: [] }; buckets.push(b) }
    b.height = Math.max(b.height, height)
    b.cells.push({ x, text: item.str.trim() })
  }
  buckets.sort((a, b) => b.y - a.y)
  for (const b of buckets) {
    b.cells.sort((a, b) => a.x - b.x)
    rows.push({ height: b.height, cells: b.cells })
  }
}

const log = console.log
console.log = () => {}
const parsed = parseCallingReport(rows)
console.log = log

const names = [...parsed.allMembers].sort()
const assigned = new Set()
for (const g of parsed.groups) {
  for (const p of g.positions) for (const c of p.callings) assigned.add(c.memberName)
}

console.log('groups          :', parsed.groups.length)
console.log('positions       :', parsed.groups.reduce((n, g) => n + g.positions.length, 0))
console.log('assignments     :', parsed.groups.reduce((n, g) => n + g.positions.reduce((m, p) => m + p.callings.length, 0), 0))
console.log('members assigned:', assigned.size)
console.log('allMembers      :', names.length)
console.log('=> unassigned   :', names.length - assigned.size)

const bad = names.filter(
  (n) => !n.includes(',') || /^\*/.test(n) || /^(Name|Age|Count|Email|Phone|Gender|Birth)/.test(n) || n.length > 55
)
console.log('\nsuspicious names:', bad.length)
bad.forEach((n) => console.log('  ' + JSON.stringify(n)))

const missingFromRoster = [...assigned].filter((n) => !parsed.allMembers.has(n))
console.log('\nassigned names missing from allMembers:', missingFromRoster.length)
missingFromRoster.forEach((n) => console.log('  ' + n))

console.log('\nnames of 4+ words (wrap reconstructions):')
names.filter((n) => n.split(/\s+/).length >= 4).forEach((n) => console.log('  ' + n))

console.log('\nfirst 3:', names.slice(0, 3).join(' | '))
console.log('last  3:', names.slice(-3).join(' | '))

console.log('\nGROUPS:')
parsed.groups.forEach((g) => console.log(`  ${g.parentName ? g.parentName + ' > ' : ''}${g.name} (${g.positions.length})`))
