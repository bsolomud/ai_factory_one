import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { validateProfile } from '../src/profile.js'
import { cli, completeArtifact, installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

test('validateProfile: catches structural errors, warns on soft gaps', () => {
  assert.deepEqual(validateProfile(null).errors.length > 0, true)
  const bad = validateProfile({ commands: { lint_changed: [{ when: 'x/**' }] }, no_touch: 'nope', test_layout: [] })
  assert.ok(bad.errors.some(e => /has no 'run:'/.test(e)))
  assert.ok(bad.errors.some(e => /no_touch/.test(e)))
  assert.ok(bad.errors.some(e => /test_layout/.test(e)))
  const good = validateProfile({ commands: { lint_changed: 'lint {changed_files}', test_targeted: 't' }, conventions: { base_branch: 'main' }, no_touch: [] })
  assert.equal(good.errors.length, 0)
})

test('doctor: OK for a valid profile, INVALID (exit 1) for a broken one', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'doc-repo')
  installProfile(home, 'example.com-test-doc-repo', STANDARD_PROFILE)
  assert.equal(cli(['doctor'], { home, cwd: repo.dir }).verdict, 'OK')

  installProfile(home, 'example.com-test-doc-repo', 'commands:\n  lint_changed:\n    - { when: "a/**" }\n')
  const bad = cli(['doctor'], { home, cwd: repo.dir })
  assert.equal(bad.verdict, 'INVALID')
  assert.equal(bad.code, 1)
})

test('agent-start: enforces the per-run ceiling', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'cap-repo')
  installProfile(home, 'example.com-test-cap-repo', STANDARD_PROFILE)
  cli(['new-run', 'C-1'], { home, cwd: repo.dir })
  assert.equal(cli(['agent-start', 'a', '--max', '2'], { home, cwd: repo.dir }).spawned, 1)
  assert.equal(cli(['agent-start', 'b', '--max', '2'], { home, cwd: repo.dir }).spawned, 2)
  const over = cli(['agent-start', 'c', '--max', '2'], { home, cwd: repo.dir })
  assert.equal(over.verdict, 'BLOCKED')
  assert.equal(over.code, 1)
})

test('feedback + abort + show, and metrics reflect them', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'fb-repo')
  installProfile(home, 'example.com-test-fb-repo', STANDARD_PROFILE)
  const run = a => cli(a, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', 'example.com-test-fb-repo', 'runs', 'F-1')
  run(['new-run', 'F-1'])

  const show1 = run(['show'])
  assert.equal(show1.stage, 'CONTEXT')
  assert.equal(show1.current_artifact, 'artifacts/01-context.md')

  assert.equal(run(['feedback', 'the', 'questions', 'were', 'vague']).recorded, 'the questions were vague')

  // drive one gate with an edit, so metrics has a gate_edit to report
  completeArtifact(runDir, 'artifacts/01-context.md', 'F-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': '1. x', Findings: 'f', 'Open questions': 'None.' })
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve', '--edited', '--note', 'tightened criteria']).stage, 'PLAN')

  const m = run(['metrics', '--run', 'F-1'])
  assert.equal(m.feedback_notes, 1)
  assert.equal(m.gate_edits, 1)
  assert.equal(m.gate_edit_rate, 1)

  assert.equal(run(['abort']).verdict, 'ABORTED')
  assert.equal(run(['status']).verdict, 'NO_ACTIVE_RUN', 'aborted run drops out of active')
})
