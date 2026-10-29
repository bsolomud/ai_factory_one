import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as paths from './paths.js'

// What may leave a project, and what may not.
//
// The pipeline is a universal tool; the projects it runs on are under NDA. A
// lesson the pipeline learns from a project's review ("a fix was proven on one
// input, not its class") is the tool's to keep; the ticket, the repo, the
// people, the paths and the identifiers it was learned on are not. This module
// is the mechanical half of that line. Two modes:
//
//   strict — text meant to improve the tool (retro proposals). Besides the
//            hard patterns, no code fence, no URL, no path the tool does not
//            ship, and no identifier or uncommon word that occurs in a
//            project's tracked files unless the tool's own text uses it too.
//   self   — the tool's own source. Hard patterns and the named terms only:
//            the tool's vocabulary cannot be its own allowlist.
//
// Hard patterns, both modes: ticket keys, PR numbers, e-mail addresses, and
// the names of every onboarded project's org, repo, and the people seen in its
// reviews, plus the local list in <home>/nda-terms.txt (one term per line; it
// never leaves this machine, so it may name what must not be named).

const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d{2,}\b/g
// Public standards and the tool's own placeholders, not tickets.
const TICKET_OK = /^(UTF|SHA|ISO|RFC|CVE|ABC|PROJ)-/
const PR_REF = /(^|[\s(])#\d{3,}\b|\/pull\/\d{3,}/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g
const URL = /\bhttps?:\/\/\S+/g
const FILE_EXT = /\.(rb|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|php|cs|haml|erb|slim|vue|svelte|css|scss|sql|yml|yaml|json|xml|html|sh|rake|md|txt|lock|toml|ini)$/i

export const termsFile = () => path.join(paths.home(), 'nda-terms.txt')
export const seenFile = () => path.join(paths.home(), 'retro', 'people.json')

const readLines = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) } catch { return [] }
}

// Org and repo names of every onboarded project, from its remote when the
// checkout is present, else from the slug (<host>-<org>-<repo>).
function projectNames() {
  const names = new Set()
  for (const r of paths.knownRepos()) {
    let remote = ''
    if (r.path) {
      try { remote = execFileSync('git', ['-C', r.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() } catch { /* no remote */ }
    }
    const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/)
    if (m) { names.add(m[1]); names.add(m[2]) } else {
      const parts = r.slug.split('-').slice(1)
      if (parts.length >= 2) { names.add(parts[0]); names.add(parts.slice(1).join('-')) }
    }
    if (r.path) names.add(path.basename(r.path))
  }
  return names
}

export function namedTerms() {
  let people = []
  try { people = JSON.parse(fs.readFileSync(seenFile(), 'utf8')) } catch { /* none yet */ }
  return [...new Set([...projectNames(), ...people, ...readLines(termsFile())])].filter(t => t.length >= 3)
}

export function rememberPeople(logins) {
  const file = seenFile()
  let known = []
  try { known = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first */ }
  const all = [...new Set([...known, ...logins.filter(Boolean)])].sort()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
}

let dict = null
function dictionary() {
  if (dict) return dict
  dict = new Set()
  for (const f of ['/usr/share/dict/words', '/usr/dict/words']) {
    try { fs.readFileSync(f, 'utf8').split('\n').forEach(w => w && dict.add(w.toLowerCase())); break } catch { /* next */ }
  }
  return dict
}

// An ordinary English word (any inflection the dictionary can explain).
function ordinary(word) {
  const d = dictionary()
  const w = word.toLowerCase()
  if (!d.size) return /^[a-z]+$/.test(word) // no dictionary: only lowercase words pass as ordinary
  if (d.has(w)) return true
  for (const [suffix, repl] of [['ies', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['er', ''], ['ers', ''], ['ly', ''], ['ness', ''], ['able', ''], ['ation', 'e']]) {
    if (w.endsWith(suffix) && d.has(w.slice(0, -suffix.length) + repl)) return true
  }
  return false
}

const identifierShaped = w => /_|::|[a-z][A-Z]|[A-Za-z]\d|\d[A-Za-z]/.test(w)
const candidate = w => w.length >= 4 && (identifierShaped(w) || !ordinary(w))
const WORD = /[A-Za-z][A-Za-z0-9_]*(?:::[A-Za-z][A-Za-z0-9_]*)*/g

// Of `words`, those that occur in some onboarded project's tracked files.
function inProjects(words) {
  const want = new Set(words)
  const found = new Set()
  if (!want.size) return found
  for (const r of paths.knownRepos().filter(r => r.path)) {
    let files = []
    try { files = execFileSync('git', ['-C', r.path, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 30_000 }).split('\0').filter(Boolean) } catch { continue }
    // Paths name things too: a file called after a domain concept is one.
    for (const m of files.join('\n').matchAll(WORD)) if (want.has(m[0])) found.add(m[0])
    for (const f of files) {
      let text
      try {
        const abs = path.join(r.path, f)
        if (fs.statSync(abs).size > 2_000_000) continue
        text = fs.readFileSync(abs, 'utf8')
      } catch { continue }
      for (const m of text.matchAll(WORD)) if (want.has(m[0])) found.add(m[0])
      if (found.size === want.size) return found
    }
  }
  return found
}

// The tool's public vocabulary: every word and path in what it ships to any
// project. A retro proposal may use these freely — they name the tool.
export function toolVocabulary(root = paths.packageRoot()) {
  const words = new Set()
  const shipped = new Set()
  const walk = (rel) => {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) return
    if (fs.statSync(abs).isDirectory()) {
      for (const e of fs.readdirSync(abs)) if (e !== 'node_modules') walk(path.join(rel, e))
      return
    }
    shipped.add(rel)
    shipped.add(path.basename(rel))
    for (const m of fs.readFileSync(abs, 'utf8').matchAll(WORD)) words.add(m[0])
  }
  for (const rel of ['pipeline.yml', 'stages', 'templates', 'src', 'adapters', 'README.md']) walk(rel)
  return { words, shipped }
}

export function ndaCheck(text, { mode = 'strict', terms = namedTerms(), vocabulary = null } = {}) {
  const violations = []
  const lines = String(text).split('\n')
  const add = (i, rule, match, hint) => violations.push({ line: i + 1, rule, match, hint })
  const termRes = terms.map(t => ({ t, re: new RegExp(`(^|[^A-Za-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`, 'i') }))
  const vocab = mode === 'strict' ? (vocabulary || toolVocabulary()) : null
  let fenced = false
  const pending = new Map() // candidate word -> first line

  lines.forEach((line, i) => {
    for (const m of line.matchAll(TICKET)) if (!TICKET_OK.test(m[0])) add(i, 'ticket', m[0], 'name the kind of change, not the ticket')
    for (const m of line.matchAll(PR_REF)) add(i, 'pr', m[0].trim(), 'say "a pilot PR", not which one')
    for (const m of line.matchAll(EMAIL)) if (!/noreply@|@example\.(com|org)$|\.test$/.test(m[0])) add(i, 'email', m[0], 'no addresses')
    for (const { t, re } of termRes) if (re.test(line)) add(i, 'term', t, 'a project, org, person or listed term — describe it generically')
    if (mode !== 'strict') return

    if (/^\s*```/.test(line)) { fenced = !fenced; add(i, 'code', '```', 'no code blocks — describe the mechanism in words') ; return }
    if (fenced) return
    for (const m of line.matchAll(URL)) add(i, 'url', m[0], 'no links')
    for (const tok of line.match(/[\w.-]*\/[\w./-]+|[\w-]+\.[A-Za-z]{1,5}\b/g) || []) {
      const clean = tok.replace(/[.,;:]+$/, '')
      const shipped = vocab.shipped.has(clean) || [...vocab.shipped].some(s => s.endsWith('/' + clean.replace(/^\.?\//, '')))
      if ((clean.includes('/') || FILE_EXT.test(clean)) && !shipped && !/^\d/.test(clean) && clean.length > 3) {
        if (FILE_EXT.test(clean) || clean.split('/').filter(Boolean).length >= 2) add(i, 'path', clean, 'only the tool\'s own files may be named')
      }
    }
    for (const m of line.matchAll(WORD)) {
      const w = m[0]
      if (candidate(w) && !vocab.words.has(w) && !pending.has(w)) pending.set(w, i)
    }
  })

  if (mode === 'strict' && pending.size) {
    for (const w of inProjects([...pending.keys()])) {
      add(pending.get(w), 'project-word', w, 'this word occurs in a project\'s code — use a generic description')
    }
  }
  return violations.sort((a, b) => a.line - b.line)
}
