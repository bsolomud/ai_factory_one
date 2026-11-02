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

// Every artifact is two documents in one file. Above this line: what a
// developer reads — plain words, one screen, no pipeline vocabulary. Below it:
// what the stage agents and the gates read — tables, paths, evidence commands.
// The marker is an H1 so the `## ` section parser never sees it as a section.
export const HUMAN_MARKER = /^# Pipeline details\s*$/m

// { human, pipeline, hasMarker }: the body split at the marker, HTML comments
// (template guidance) stripped from both halves. No marker → the whole body is
// the human part, which is right for an artifact that has no agent-only half.
export function humanPart(body) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '')
  const m = clean.match(HUMAN_MARKER)
  if (!m) return { human: clean, pipeline: '', hasMarker: false }
  return { human: clean.slice(0, m.index), pipeline: clean.slice(m.index + m[0].length), hasMarker: true }
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
// path-like tokens (contain '/' or carry an extension) qualify. A token with
// whitespace or shell/glob characters is a command or pattern, never a path —
// backticked commands in plan prose false-blocked real runs (FP-2).
//
// Three pilot runs lost a whole PLAN round each to prose read as paths (28,
// 10 and 16 false reasons): method chains (`a.session_keys`), constants
// (`A::B.site`), URL paths (`/sso`), rule ids and `try/catch`. So: no `::`, no
// leading `/`, no URL; a token without a `/` is a file only when its extension
// is a known file extension.
const FILE_EXTENSIONS = new Set(('rb rake ru gemspec erb haml slim builder jbuilder js mjs cjs ts tsx jsx vue svelte json yml yaml ' +
  'md mdx rst adoc txt csv tsv html htm xml svg css scss sass less sql sh bash zsh fish ps1 bat py pyi go rs java kt kts scala ' +
  'php ex exs eex heex leex c h cc cpp hpp cs swift m mm dart lua pl pm r toml ini cfg conf env lock log properties gradle ' +
  'tf hcl proto graphql gql po pot mo png jpg jpeg gif webp ico pdf keep example sample template tpl dockerfile gitignore ' +
  'gitattributes editorconfig rspec rubocop nvmrc tool-versions ruby-version node-version').split(' '))
const cleanPath = token => {
  const cleaned = token.replace(/:\d+(-\d+)?$/, '').trim()
  if (/[\s*{}$]/.test(cleaned) || cleaned.includes('::') || cleaned.startsWith('/') || /^\w+:\/\//.test(cleaned)) return null
  if (cleaned.includes('/')) return cleaned
  const ext = cleaned.match(/\.([\w-]+)$/)
  return ext && FILE_EXTENSIONS.has(ext[1].toLowerCase()) ? cleaned : null
}

// The first cell of a markdown table row; a pipe inside backticks or escaped
// as \| does not end it.
function firstCell(line) {
  const body = line.replace(/^\s*\|/, '')
  let inTick = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '`') inTick = !inTick
    else if (c === '\\' && body[i + 1] === '|') i++
    else if (c === '|' && !inTick) return body.slice(0, i)
  }
  return body
}

// Backticked paths on one line — the shared extraction rule for every section
// that lists files (plan Affected files, plan Subtasks). One rule, or the
// validators comparing those sections against each other drift apart.
export function backtickPaths(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map(m => cleanPath(m[1])).filter(Boolean)
}

// Path claims live on table rows and list items — the shapes the plan template
// mandates for machine-parsed sections. A prose sentence mentioning `GEM/specs`
// or a backticked command is explanation, not a claim; extracting from it
// false-blocked 17/18 pilot runs at PLAN (FP-2).
const carriesPathClaims = line => /^\s*(\||[-*]\s|\d+[.)]\s)/.test(line)

// Paths the run's approved plan gained AFTER approval, via `pipeline
// amend-boundary`. The approved sections are frozen — an amendment appends,
// never rewrites — so the write boundary is 'Affected files' ∪ these.
// Deliberately keyed to a machine marker (`- boundary:`) rather than any
// backticked path in '## Amendments': an amendment narrative naming a file must
// never widen the boundary by accident. Only the CLI writes these lines.
export const BOUNDARY_MARKER = /^\s*[-*]\s*boundary:/i

export function boundaryAmendments(body) {
  const text = sections(body)['Amendments'] ?? ''
  const paths = []
  for (const line of text.split('\n')) {
    if (BOUNDARY_MARKER.test(line)) paths.push(...backtickPaths(line))
  }
  return [...new Set(paths)]
}

// Paths mentioned in a section: backticked tokens and bare path-like words.
// A line annotated "(new)" lists a file the plan will CREATE — exempt from
// existence checks. Trailing :123 line references are stripped.
// On a table row only the FIRST cell is the claim (the template's Path
// column): the Change column is prose about the file, and its backticked
// method names and commands were read as paths.
export function pathsInSection(text) {
  const paths = []
  for (const line of text.split('\n')) {
    if (!carriesPathClaims(line)) continue
    const isNew = /\(new\)/i.test(line)
    const claim = /^\s*\|/.test(line) ? firstCell(line) : line
    const tokens = [...claim.matchAll(/`([^`]+)`/g)].map(m => m[1])
    if (tokens.length === 0) {
      for (const word of claim.split(/[\s,]+/)) {
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
