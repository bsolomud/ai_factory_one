import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Every test gets an isolated pipeline home + scratch repos in a temp dir.
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifactory-'))
  return { root, home: path.join(root, 'pipeline-home') }
}

export function makeRepo(root, name, { base = 'master' } = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', base)
  git('config', 'user.email', 'test@test.test')
  git('config', 'user.name', 'Test')
  // origin URL makes the slug deterministic per repo name
  git('remote', 'add', 'origin', `git@example.com:test/${name}.git`)
  return { dir, git, write: (rel, content) => writeFile(dir, rel, content) }
}

export function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  if (rel.endsWith('.sh')) fs.chmodSync(abs, 0o755)
  return abs
}

// Hand-written profile (plan P1.5 — onboarding is out of MVP scope).
export function installProfile(home, slug, profile) {
  const file = path.join(home, 'repos', slug, 'profile.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, profile)
}

// Run the real executable, exactly as the model would.
export function cli(args, { home, cwd, env: extraEnv = {} }) {
  const bin = path.join(PACKAGE_ROOT, 'bin', 'pipeline')
  const env = { ...process.env, AI_FACTORY_HOME: home, ...extraEnv }
  try {
    const stdout = execFileSync('node', [bin, ...args], { cwd, env, encoding: 'utf8' })
    return { code: 0, ...JSON.parse(stdout) }
  } catch (e) {
    const out = (e.stdout || '').toString()
    let parsed = {}
    try { parsed = JSON.parse(out) } catch { parsed = { raw: out, stderr: (e.stderr || '').toString() } }
    return { code: e.status ?? 1, ...parsed }
  }
}

// Canonical fake artifact inputs. One home, so adding a required section (the
// Decisions gate did this — it forced edits at every call site) is a one-line
// change here, not a sweep across the test files.
export const contextSections = (over = {}) => ({ Requirements: 'r', 'Acceptance criteria': AC_TABLE, Decisions: 'None — fake run.', Findings: 'f', 'Open questions': 'None.', ...over })
export const CLEAN_REVIEW_COUNTS = 'findings: { blocking: 0, advisory: 0, fixed: 0, disputed: 0 }'

// A criterion table that satisfies ac_population: numbered rows, and a 4th
// column naming the population the criterion is about.
export const AC_TABLE = [
  '| # | Criterion | Verified by | Population |',
  '|---|-----------|-------------|------------|',
  '| 1 | the thing is true | `tests/app_test.sh` | both |'
].join('\n')

// A coupling row evidence_verified can re-run in any repo state: the token
// appears nowhere, so the command always prints 0 lines. That is not a degenerate
// fixture — a 0-hit row is the shape that PROVES absence ("nothing else writes
// this"), which is the row that catches a missing backfill.
export const COUPLING_OK = [
  '| Subject | Evidence command | Hits | Disposition |',
  '|---------|------------------|------|-------------|',
  '| `app-v1` writers | `git grep -n AIFACTORY_ABSENT_TOKEN` | 0 | no other writer — nothing downstream to update |'
].join('\n')

// Proof-ledger frontmatter for the single AC in AC_TABLE. The stamp is NOT
// hardcodable — it hashes the plan's affected files as they are on disk — so
// callers pass what `pipeline proof-stamp` returned.
export const proofsFrontmatter = stamp =>
  `proofs:\n  - { ac: 1, test: 'tests/app_test.sh:1', mutation: 'reverted the change in src/app.sh' }\nproof_stamp: ${stamp}`

// Write an artifact with completed frontmatter + given sections (fake stage work).
// extraFrontmatter: raw YAML lines appended to the frontmatter (e.g. the review
// artifact's machine-read findings counts).
export function completeArtifact(runDir, rel, run, stage, sections, extraFrontmatter = '') {
  const extra = extraFrontmatter ? `${extraFrontmatter.trim()}\n` : ''
  const body = Object.entries(sections).map(([name, text]) => `## ${name}\n${text}\n`).join('\n')
  writeFile(runDir, rel, `---\nrun: ${run}\nstage: ${stage}\nstatus: complete\n${extra}---\n\n${body}`)
}

export function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'))
}

// The standard fixture: a tiny shell-based "codebase" whose lint/test commands
// have real pass/fail behavior, plus a no_touch zone. Deliberately not any
// mainstream ecosystem — proves repo-agnosticism.
export function standardRepo(root, name) {
  const repo = makeRepo(root, name)
  repo.write('lint.sh', '#!/usr/bin/env bash\nfor f in "$@"; do grep -q LINTFAIL "$f" && { echo "lint: $f contains LINTFAIL"; exit 1; }; done\nexit 0\n')
  repo.write('run_tests.sh', '#!/usr/bin/env bash\nfor f in "$@"; do bash "$f" || exit 1; done\nexit 0\n')
  repo.write('src/app.sh', 'echo app-v1\n')
  repo.write('src/util.sh', 'echo util-v1\n')
  repo.write('tests/app_test.sh', '#!/usr/bin/env bash\nexit 0\n')
  repo.write('locked/keep.txt', 'never touch\n')
  repo.git('add', '-A')
  repo.git('commit', '-qm', 'initial')
  return repo
}

export const STANDARD_PROFILE = `
repo: git@example.com:test/REPO.git
commands:
  lint_changed: "./lint.sh {changed_files}"
  test_targeted: "./run_tests.sh {targeted_specs}"
  post_change_hooks: []
test_layout: { "src/**": "tests/" }
conventions:
  base_branch: master
  branch_pattern: "T-<id>"
no_touch:
  - "locked/**"
`
