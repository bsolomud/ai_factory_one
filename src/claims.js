import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isTestFile, matchesAny } from './profile.js'

// Claims the change itself writes down. A code comment, a doc sentence or a
// user-visible message is read later as a fact about the code, and no gate
// checked them: in the pilot retro, five reviewer comments in two PRs were
// sentences of this kind that said more than the code does ("every branch
// repeats the lookup", "ignores any body it cannot store", a note saying a
// record was updated when, in one account state, it was not) — two merged
// unfixed. The test report's untested claims are covered by untested_claims;
// these are the claims nobody listed.
//
// A claim here is an ADDED line that is a comment, a doc line or a message
// line, and that carries a universal or outcome word. Tests are excluded:
// a test's description is proved by the test.

const UNIVERSAL = /\b(any|every|all|each|never|always|only|same|cannot|can't|none|no longer|guarantee[sd]?|ensures?|updated|is the only)\b/i

const DOC_GLOBS = ['**/*.md', '**/*.rst', '**/*.adoc', 'doc/**', 'docs/**']
const MESSAGE_GLOBS = ['config/locales/**', 'locales/**', '**/locales/**', '**/*.po', '**/i18n/**']

// Comment syntax by extension; the line must START with the marker.
const COMMENT = [
  [/\.(rb|rake|py|sh|bash|zsh|ya?ml|toml|coffee|pl|r|ex|exs|tf|conf|gemspec)$|(^|\/)(Gemfile|Rakefile|Dockerfile|Makefile)$/i, /^\s*#(?!!)/],
  [/\.(js|mjs|cjs|ts|tsx|jsx|java|kt|go|rs|c|h|cc|cpp|cs|php|swift|scala|scss|less|css|dart|vue|svelte)$/i, /^\s*(\/\/|\/\*|\*(?!\/))/],
  [/\.haml$/i, /^\s*(-#|\/)/],
  [/\.(erb|eex)$/i, /<%#/],
  [/\.slim$/i, /^\s*\/(?!\/)/],
  [/\.sql$/i, /^\s*--/],
  [/\.(html|htm|xml|svg)$/i, /<!--/]
]

const run = (repoDir, args) => {
  try { return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 1 << 28 }) } catch { return '' }
}

// Added lines vs `base`, with their new line numbers; untracked files that
// were not there when the run began count as wholly added.
function addedLines(repoDir, base, ambient) {
  const out = []
  let file = null
  let line = 0
  for (const l of run(repoDir, ['diff', '-U0', '--no-color', '--no-ext-diff', base]).split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue }
    const hunk = l.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/)
    if (hunk) { line = Number(hunk[1]); continue }
    if (file && l.startsWith('+') && !l.startsWith('+++')) { out.push({ file, line, text: l.slice(1) }); line++ }
  }
  for (const f of run(repoDir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    if (ambient.has(f)) continue
    let text
    try { text = fs.readFileSync(path.join(repoDir, f), 'utf8') } catch { continue }
    if (text.includes('\0')) continue
    text.split('\n').forEach((t, i) => out.push({ file: f, line: i + 1, text: t }))
  }
  return out
}

export function writtenClaims(repoDir, base, profile = {}, ambient = new Set()) {
  const docs = profile?.claims?.doc_globs || DOC_GLOBS
  const messages = profile?.claims?.message_globs || MESSAGE_GLOBS
  return addedLines(repoDir, base, ambient).filter(({ file, text }) => {
    if (!text.trim() || !UNIVERSAL.test(text) || isTestFile(file, profile)) return false
    if (matchesAny(file, docs) || matchesAny(file, messages)) return true
    const syntax = COMMENT.find(([ext]) => ext.test(file))
    return Boolean(syntax && syntax[1].test(text))
  }).map(c => ({ ...c, text: c.text.trim() }))
}

// `path:12` or `path:10-40` — the lines a row of '## Claims written' covers.
export function claimRef(cell) {
  const m = String(cell).replace(/`/g, '').trim().match(/^(.+?):(\d+)(?:\s*[-–]\s*(\d+))?$/)
  return m ? { file: m[1].trim(), from: Number(m[2]), to: Number(m[3] || m[2]) } : null
}
