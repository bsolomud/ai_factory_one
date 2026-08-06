import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

// The command slots whose absence is a genuine verification gap. Any OTHER slot
// (e.g. post_change_hooks) is optional infrastructure — its absence is
// "not configured", not an UNVERIFIED coverage hole.
export const REQUIRED_SLOTS = ['lint_changed', 'test_targeted']

export function loadProfile(file) {
  if (!fs.existsSync(file)) return null
  return YAML.parse(fs.readFileSync(file, 'utf8'))
}

// Plain-language schema check (the `doctor` command). Returns {errors, warnings}
// so a hand-written profile fails fast and legibly instead of deep inside a stage.
export function validateProfile(profile) {
  const errors = []
  const warnings = []
  if (!profile || typeof profile !== 'object') return { errors: ['profile is empty or not a YAML mapping'], warnings }

  if (!('commands' in profile)) errors.push("missing 'commands:' — add it (an empty mapping is fine; slots left empty become UNVERIFIED checks)")
  else if (profile.commands && typeof profile.commands === 'object') {
    for (const slot of REQUIRED_SLOTS) {
      if (!(slot in profile.commands)) warnings.push(`no '${slot}' command — that check will be recorded UNVERIFIED (a real coverage gap) at every gate`)
    }
    for (const [slot, val] of Object.entries(profile.commands)) {
      const entries = Array.isArray(val) ? val : [val]
      for (const e of entries) {
        const cmd = typeof e === 'string' ? e : e?.run
        if (e && !cmd) errors.push(`commands.${slot}: list item has no 'run:' string`)
        if (typeof e === 'object' && e && 'when' in e && typeof e.when !== 'string') errors.push(`commands.${slot}: 'when' must be a glob string`)
      }
    }
  }

  if ('no_touch' in profile && !Array.isArray(profile.no_touch)) errors.push("'no_touch' must be a list of globs")
  if ('test_layout' in profile && (typeof profile.test_layout !== 'object' || Array.isArray(profile.test_layout))) errors.push("'test_layout' must be a mapping of src-glob → test-dir")
  if ('test_file_pattern' in profile) {
    if (typeof profile.test_file_pattern !== 'string') errors.push("'test_file_pattern' must be a string (a JS regex)")
    else try { new RegExp(profile.test_file_pattern) } catch (e) { errors.push(`'test_file_pattern' is not a valid regex: ${e.message}`) }
  }
  const base = profile.conventions?.base_branch
  if (!base) warnings.push("no conventions.base_branch — defaulting to 'master'; set it if the repo uses 'main'")

  for (const [cap, b] of Object.entries(profile.bindings || {})) {
    if (!b || typeof b !== 'object') { errors.push(`bindings.${cap} must be a mapping`); continue }
    if (!['repo', 'builtin'].includes(b.source)) errors.push(`bindings.${cap}.source must be 'repo' or 'builtin' (got '${b.source}')`)
    if (b.source === 'repo' && !b.path) errors.push(`bindings.${cap}: source 'repo' needs a 'path'`)
    if (b.source === 'repo' && !b.sha) warnings.push(`bindings.${cap}: no content hash — staleness of this binding cannot be detected`)
  }
  return { errors, warnings }
}

// A slot value may be: a string, a list of strings, or a list of
// { when: <glob>, run: <cmd> } hooks. Normalized to [{ run, when? }].
export function resolveSlot(profile, slot) {
  const raw = profile?.commands?.[slot]
  if (raw == null || raw === '') return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .map(entry => (typeof entry === 'string' ? { run: entry } : entry))
    .filter(e => e && e.run)
}

// Files changed vs the base branch — what "this change" means. By default TRACKED
// changes only (`git diff --name-only <base>` covers committed + uncommitted edits
// to tracked files). Ambient untracked files (stray .md/.json, editor scratch) are
// NOT the change and must never be fed to a linter — MB-46745 hit exactly this:
// untracked files were globbed into rubocop, which errored parsing them as Ruby
// and blocked the gate. The write-boundary check opts INTO untracked
// (`includeUntracked: true`) because a run's brand-new, not-yet-committed file is
// legitimately a boundary concern.
// The repo's currently-untracked files (respecting .gitignore / .git/info/exclude
// via --exclude-standard). Snapshotted at run start into state.git.baseline_untracked
// so the write-boundary check can leave the developer's ambient scratch alone: the
// pipeline only owns the untracked files IT creates during the run, never files that
// were already sitting untracked in the working tree before the run began.
export function untrackedFiles(repoDir) {
  try {
    return execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoDir, encoding: 'utf8' })
      .split('\n').map(f => f.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function changedFiles(repoDir, base, { includeUntracked = false } = {}) {
  const out = new Set()
  const run = args => {
    try {
      return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  for (const f of run(['diff', '--name-only', base]).split('\n')) if (f.trim()) out.add(f.trim())
  if (includeUntracked) {
    for (const f of run(['ls-files', '--others', '--exclude-standard']).split('\n')) if (f.trim()) out.add(f.trim())
  }
  return [...out]
}

// What counts as a runnable test file. Extension-agnostic (foo_spec.rb,
// foo_test.sh, bar.test.js, bar.spec.tsx) but deliberately excludes the
// non-runnable inhabitants of test dirs — factories, rails_helper.rb,
// spec/support/**, Jest setup files. Feeding those to the runner errors the
// whole invocation (MB-47027: a changed spec/factories/*.rb passed to rspec →
// FactoryBot::DuplicateDefinitionError → gate false-BLOCKED). Repos with
// other conventions (e.g. Python's test_*.py) set profile.test_file_pattern.
const DEFAULT_TEST_FILE_RE = /(_test|_spec|\.test|\.spec)\.[^./]+$/

// Targeted tests for the changed files, via the profile's test_layout mapping
// (src-prefix glob → test dir). Conservative: only returns test files that
// actually exist — resolving nothing yields [] and the caller records UNVERIFIED
// rather than accidentally running an entire suite.
export function targetedTests(repoDir, files, profile) {
  const layout = profile?.test_layout || {}
  const found = new Set()
  const testRe = profile?.test_file_pattern
    ? new RegExp(profile.test_file_pattern)
    : DEFAULT_TEST_FILE_RE
  // dir + '/' so a test dir 'spec' can't prefix-match a sibling like
  // 'spec_helper.rb' or 'specs_old/'.
  const testDirs = Object.values(layout).map(d => (d.endsWith('/') ? d : d + '/'))
  for (const file of files) {
    if (testDirs.some(dir => file.startsWith(dir))) { // changed file IS under a test dir
      if (testRe.test(file)) found.add(file)          // ...but only runnable tests run
      continue                                        // helpers/factories contribute nothing
    }
    for (const [srcGlob, testDir] of Object.entries(layout)) {
      const prefix = srcGlob.split('*')[0]
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const stem = path.join(testDir, rest.replace(/\.[^./]+$/, ''))
      const dir = path.join(repoDir, path.dirname(stem))
      if (!fs.existsSync(dir)) continue
      const base = path.basename(stem)
      for (const candidate of fs.readdirSync(dir)) {
        if ((candidate.startsWith(base + '_') || candidate.startsWith(base + '.')) && testRe.test(candidate)) {
          found.add(path.join(path.dirname(stem), candidate))
        }
      }
    }
  }
  return [...found]
}

// Changed SOURCE files that map to a test_layout entry but have no existing
// mirror spec — a genuine coverage gap, distinct from config/view/spec-only
// changes that legitimately run no test. Used to make the UNVERIFIED signal
// honest without ever auto-running a forbidden full suite.
export function sourceFilesNeedingSpecs(repoDir, files, profile) {
  const layout = profile?.test_layout || {}
  const testDirs = Object.values(layout)
  const srcPrefixes = Object.keys(layout).map(g => g.split('*')[0])
  return files.filter(file => {
    if (testDirs.some(dir => file.startsWith(dir))) return false // the file IS a test
    const isSource = srcPrefixes.some(p => file.startsWith(p))
    if (!isSource) return false                                  // config/view/etc — not expected to have a spec
    return targetedTests(repoDir, [file], profile).length === 0  // maps to a src-glob but no spec exists
  })
}

const shellQuote = f => `'${f.replace(/'/g, `'\\''`)}'`

// {placeholder} substitution. Returns null (→ skip the command) when a
// placeholder resolves to nothing — never run a command with a hole in it.
export function substitute(cmd, { files, tests }) {
  const values = {
    changed_files:  files,
    changed_haml:   files.filter(f => f.endsWith('.haml')),
    changed_js:     files.filter(f => /\.(js|jsx|ts|tsx)$/.test(f)),
    targeted_specs: tests,
    targeted_tests: tests
  }
  let empty = null
  const out = cmd.replace(/\{(\w+)\}/g, (m, key) => {
    const val = values[key]
    if (val === undefined) { empty = `unknown placeholder {${key}}`; return m }
    if (val.length === 0) { empty = `{${key}} resolved to no files`; return m }
    return val.map(shellQuote).join(' ')
  })
  return empty ? { skip: empty } : { cmd: out }
}

// Minimal glob → RegExp for no_touch/when patterns.
// Supports **, *, ? and the segment negation !(a|b).
export function globToRegex(glob) {
  const segments = glob.split('/').map(seg => {
    if (seg === '**') return ' GLOBSTAR '
    let out = ''
    for (let i = 0; i < seg.length; i++) {
      if (seg.startsWith('!(', i)) {
        const end = seg.indexOf(')', i)
        const alternatives = seg.slice(i + 2, end).split('|').map(escapeRe).join('|')
        out += `(?!(?:${alternatives})(?:/|$))[^/]+` // anchor to segment end, not string end
        i = end
      } else if (seg[i] === '*') out += '[^/]*'
      else if (seg[i] === '?') out += '[^/]'
      else out += escapeRe(seg[i])
    }
    return out
  })
  let pattern = segments
    .join('/')
    .replaceAll(' GLOBSTAR /', '(?:[^/]+/)*')
    .replaceAll(' GLOBSTAR ', '.*')
  return new RegExp(`^${pattern}$`)
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function matchesAny(file, globs) {
  return (globs || []).some(g => globToRegex(g).test(file))
}
