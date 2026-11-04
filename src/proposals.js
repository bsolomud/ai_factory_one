import fs from 'node:fs'
import path from 'node:path'
import * as paths from './paths.js'

// The framework-proposals ledger: what runs learned about the pipeline itself,
// written by SCRIBE and knowledge-harvest, read by whoever maintains the tool.
// It grew as one heading per sighting, so a defect hit five times read as five
// unrelated notes and nobody could say which hurt most. Now one entry per
// defect, a recurrence is a line under it, and strikes are counted:
//
//   ## P7 · <date> · <run id> — <title>
//   **Status: open | partial | shipped | declined | merged <date> (<commit>) — <note>**
//   <body>
//   - Recurrence <date> · <run id>: <one line>
//
// A missing Status line reads as open; `merged into P3` folds an old duplicate
// into the entry that carries its strikes.
export const frameworkProposalsFile = () => path.join(paths.home(), 'framework-proposals.md')

const HEADING = /^## (?:P(\d+) · )?(\d{4}-\d{2}-\d{2}) · (.+?) — (.+)$/
const STATUS = /^\*\*Status: (open|partial|shipped|declined|merged)\b(.*)$/
const RECURRENCE = /^- Recurrence (\d{4}-\d{2}-\d{2}) · ([^:]+): (.*)$/
export const OPEN = ['open', 'partial']

export function parseProposals(text) {
  const lines = text.split('\n')
  const entries = []
  let cur = null
  lines.forEach((line, i) => {
    const h = line.match(HEADING)
    if (h) {
      cur = { id: h[1] ? Number(h[1]) : null, date: h[2], run: h[3], title: h[4], line: i, status: 'open', status_line: undefined, status_date: null, status_note: '', merged_into: [], recurrences: [], body: [] }
      entries.push(cur)
      return
    }
    if (!cur) return
    cur.body.push(line)
    const s = line.match(STATUS)
    if (s && cur.status_line === undefined) {
      cur.status = s[1]
      cur.status_line = i
      cur.status_date = (s[2].match(/\d{4}-\d{2}-\d{2}/) || [null])[0]
      cur.status_note = s[2].replace(/\*\*\s*$/, '').replace(/^[^—]*—\s*/, '').replace(/\*\*/g, '').trim()
      cur.merged_into = s[1] === 'merged' ? [...s[2].matchAll(/P(\d+)/g)].map(m => Number(m[1])) : []
      return
    }
    const r = line.match(RECURRENCE)
    if (r) cur.recurrences.push({ date: r[1], run: r[2].trim(), note: r[3].trim() })
  })
  return entries.map(e => {
    const dates = [e.date, ...e.recurrences.map(r => r.date)].sort()
    const last = dates.at(-1)
    return {
      ...e,
      body: e.body.join('\n').trim(),
      strikes: 1 + e.recurrences.length,
      last_seen: last,
      // Shipped, then seen again: the fix did not hold, or did not cover it.
      recurred_after_ship: e.status === 'shipped' && Boolean(e.status_date) && e.recurrences.some(r => r.date > e.status_date)
    }
  })
}

export const nextId = entries => 1 + Math.max(0, ...entries.map(e => e.id || 0))

// Give every unnumbered heading the next id, in file order. Ids never move:
// an entry is never renumbered once it has one.
export function numberProposals(text) {
  const entries = parseProposals(text)
  let next = nextId(entries)
  const lines = text.split('\n')
  const numbered = []
  for (const e of entries) {
    if (e.id) continue
    lines[e.line] = lines[e.line].replace(/^## /, `## P${next} · `)
    numbered.push({ id: next, title: e.title })
    next++
  }
  return { text: lines.join('\n'), numbered }
}

export function summary(e) {
  return {
    id: e.id ? `P${e.id}` : null,
    title: e.title,
    status: e.status,
    strikes: e.strikes,
    first_seen: e.date,
    last_seen: e.last_seen,
    ...(e.status_note && { note: e.status_note }),
    ...(e.recurred_after_ship && { recurred_after_ship: true }),
    ...(e.merged_into?.length && { merged_into: e.merged_into.map(n => `P${n}`) })
  }
}

// What still needs work, the most-hit first: open and partial entries, plus a
// shipped one that recurred after shipping.
export function openProposals(entries) {
  return entries
    .filter(e => OPEN.includes(e.status) || e.recurred_after_ship)
    .sort((a, b) => b.strikes - a.strikes || b.last_seen.localeCompare(a.last_seen) || (a.id || 0) - (b.id || 0))
}

export function tally(entries) {
  const t = {}
  for (const e of entries) t[e.status] = (t[e.status] || 0) + 1
  return t
}

export function readProposals(file = frameworkProposalsFile()) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}
