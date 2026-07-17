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
export function cli(args, { home, cwd }) {
  const bin = path.join(PACKAGE_ROOT, 'bin', 'pipeline')
  const env = { ...process.env, AI_FACTORY_HOME: home }
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

// Write an artifact with completed frontmatter + given sections (fake stage work).
export function completeArtifact(runDir, rel, run, stage, sections) {
  const body = Object.entries(sections).map(([name, text]) => `## ${name}\n${text}\n`).join('\n')
  writeFile(runDir, rel, `---\nrun: ${run}\nstage: ${stage}\nstatus: complete\n---\n\n${body}`)
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
