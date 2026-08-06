import fs from 'node:fs'
import YAML from 'yaml'

// Artifact = YAML frontmatter + markdown body with `## Section` headings.
// Shared by validators (completeness checks) and reconcile (completion stamps).

export function parseArtifact(file) {
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: raw }
  let frontmatter = {}
  try { frontmatter = YAML.parse(match[1]) || {} } catch { /* malformed = empty */ }
  return { frontmatter, body: match[2] }
}

export function isComplete(file) {
  return parseArtifact(file)?.frontmatter?.status === 'complete'
}

// { "Section name": "body text", ... } from `## ` headings.
// HTML comments are template guidance, not content — stripped so an untouched
// template section still counts as empty.
export function sections(body) {
  const out = {}
  const parts = body.replace(/<!--[\s\S]*?-->/g, '').split(/^## +/m).slice(1)
  for (const part of parts) {
    const newline = part.indexOf('\n')
    const name = (newline === -1 ? part : part.slice(0, newline)).trim()
    const text = newline === -1 ? '' : part.slice(newline + 1)
    out[name] = text.trim()
  }
  return out
}

// Numbered acceptance-criteria ids from a context artifact body: table rows
// (| 1 | ... |) or numbered list items. These ids are the traceability keys —
// the plan and the test report reference them as AC#<n>.
export function acceptanceCriteriaIds(body) {
  const section = sections(body)['Acceptance criteria'] ?? ''
  const ids = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*\|\s*(\d+)\s*\|/) || line.match(/^\s*(\d+)[.)]\s/)
    if (m) ids.push(parseInt(m[1], 10))
  }
  return ids
}

// The AC-reference grammar (AC#1 / AC-1 / AC1) and the accounting of which
// numbered criteria a test report covers. ONE home for the contract between
// the ac_traceability gate (blocks on `missing`) and metrics (counts tested/
// deferred) — implemented twice they would silently drift apart.
export const acRef = n => new RegExp(`AC[#-]?${n}\\b`)

export function acAccounting(ids, mapText, deferredText) {
  const tested = []
  const deferred = []
  const missing = []
  for (const n of ids) {
    const ref = acRef(n)
    if (ref.test(mapText)) tested.push(n)
    else if (ref.test(deferredText)) deferred.push(n)
    else missing.push(n)
  }
  return { tested, deferred, missing }
}

// A token cleaned to a path: trailing :123 / :123-456 line refs stripped; only
// path-like tokens (contain '/' or carry an extension) qualify.
const cleanPath = token => {
  const cleaned = token.replace(/:\d+(-\d+)?$/, '').trim()
  return cleaned.includes('/') || /\.\w+$/.test(cleaned) ? cleaned : null
}

// Backticked paths on one line — the shared extraction rule for every section
// that lists files (plan Affected files, plan Subtasks). One rule, or the
// validators comparing those sections against each other drift apart.
export function backtickPaths(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map(m => cleanPath(m[1])).filter(Boolean)
}

// Paths mentioned in a section: backticked tokens and bare path-like words.
// A line annotated "(new)" lists a file the plan will CREATE — exempt from
// existence checks. Trailing :123 line references are stripped.
export function pathsInSection(text) {
  const paths = []
  for (const line of text.split('\n')) {
    const isNew = /\(new\)/i.test(line)
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (tokens.length === 0) {
      for (const word of line.split(/[\s,]+/)) {
        if (/^[\w.@-]+(\/[\w.@-]+)+$/.test(word)) tokens.push(word)
      }
    }
    for (const token of tokens) {
      const cleaned = cleanPath(token)
      if (cleaned) paths.push({ path: cleaned, isNew })
    }
  }
  return paths
}
