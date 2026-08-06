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
      const cleaned = token.replace(/:\d+(-\d+)?$/, '').trim()
      if (cleaned.includes('/') || /\.\w+$/.test(cleaned)) paths.push({ path: cleaned, isNew })
    }
  }
  return paths
}
