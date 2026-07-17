import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { cli, completeArtifact, installProfile, readState, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// VC2/VC3/VC4/VC6: the ENTIRE graph driven by the CLI alone — a human faking
// every stage by hand-writing artifacts. No AI involved.
test('full fake run: CONTEXT → … → DONE with blocking, gating, crash recovery and zero repo footprint', { timeout: 120_000 }, t => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'e2e-repo')
  const slug = 'example.com-test-e2e-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', slug, 'runs', 'T-1')
  const approve = () => { const r = run(['approve']); assert.equal(r.code, 0, JSON.stringify(r)); return r }
  const advance = () => run(['advance'])

  // --- intake
  assert.equal(run(['status']).verdict, 'NO_ACTIVE_RUN')
  const created = run(['new-run', 'T-1'])
  assert.equal(created.verdict, 'CREATED')
  assert.equal(created.stage, 'CONTEXT')
  assert.ok(fs.existsSync(path.join(runDir, 'artifacts/01-context.md')), 'templates scaffolded')
  assert.equal(run(['new-run', 'T-1']).verdict, 'ERROR', 'duplicate run refused')

  // --- CONTEXT: template alone must NOT pass
  let blocked = advance()
  assert.equal(blocked.verdict, 'BLOCKED')
  assert.equal(blocked.code, 1, 'BLOCKED exits non-zero')
  assert.match(blocked.reasons.join(' '), /status 'draft'/)

  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT',
    { Requirements: 'Change app greeting.', 'Acceptance criteria': '1. app prints v2 greeting', Findings: 'src/app.sh prints it.', 'Open questions': '' })
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /'## Open questions'.*empty/, 'empty section blocks with section name')

  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT',
    { Requirements: 'Change app greeting.', 'Acceptance criteria': '1. app prints v2 greeting', Findings: 'src/app.sh prints it.', 'Open questions': 'None.' })
  let gate = advance()
  assert.equal(gate.verdict, 'GATE', 'auto_approvable gate still gates under default gated autonomy')
  assert.match(advance().reasons.join(' '), /awaiting gate approval/, 'cannot advance past an unapproved gate')
  assert.equal(approve().stage, 'PLAN')

  // --- PLAN: hallucinated path blocks
  completeArtifact(runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    Approach: 'Edit both scripts.',
    'Affected files': '- `src/app.sh`\n- `src/does-not-exist.sh`',
    Risks: 'Greeting change breaks nothing.', Subtasks: '1. app\n2. util',
    'Testing strategy': 'shell tests', 'Open questions': 'None.'
  })
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /does-not-exist\.sh.*does not exist/, 'hallucinated plan path blocked')

  completeArtifact(runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    Approach: 'Edit both scripts.',
    'Affected files': '- `src/app.sh`\n- `src/util.sh`',
    Risks: 'Greeting change breaks nothing.', Subtasks: '1. app\n2. util',
    'Testing strategy': 'shell tests', 'Open questions': 'None.'
  })
  assert.equal(advance().verdict, 'GATE')
  assert.equal(approve().stage, 'BREAKDOWN')

  // --- BREAKDOWN: cursor is enforced
  completeArtifact(runDir, 'artifacts/03-progress.md', 'T-1', 'BREAKDOWN',
    { Subtasks: '- [ ] 1. app\n- [ ] 2. util', Deviations: 'None.' })
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /set-substate subtask=/, 'missing cursor blocks with the exact command')
  assert.equal(run(['set-substate', 'subtask=1', 'of=2']).verdict, 'OK')
  assert.equal(run(['set-substate', 'autonomy=9']).verdict, 'ERROR', 'non-whitelisted substate key refused')
  assert.equal(advance().verdict, 'GATE')
  assert.equal(approve().stage, 'IMPLEMENT')

  // --- IMPLEMENT subtask 1: lint failure → boundary violation → missing commit → green
  repo.git('checkout', '-qb', 'T-1')
  repo.write('src/app.sh', 'echo LINTFAIL\n')
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /command failed/, 'red lint blocks the diff')

  repo.write('src/app.sh', 'echo app-v2\n')
  repo.write('rogue.txt', 'outside the plan\n')
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /rogue\.txt.*outside the approved plan/, 'write boundary enforced')
  fs.rmSync(path.join(repo.dir, 'rogue.txt'))

  blocked = advance()
  assert.match(blocked.reasons.join(' '), /commit your work/, 'uncommitted subtask blocks')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'T-1 subtask 1: app greeting')

  gate = advance()
  assert.equal(gate.verdict, 'GATE')
  assert.equal(gate.subtask, 1)
  let approved = approve()
  assert.equal(approved.stage, 'IMPLEMENT', 'per-subtask gate loops within the stage')
  assert.equal(approved.subtask, 2)

  // --- crash mid-IMPLEMENT: state.json deleted → reconcile rebuilds from artifacts+events (VC3)
  fs.rmSync(path.join(runDir, 'state.json'))
  const status = run(['status'])
  assert.equal(status.verdict, 'ACTIVE_RUN')
  assert.equal(status.stage, 'IMPLEMENT')
  assert.equal(status.substate.subtask, 2, 'subtask cursor recovered from events')
  assert.match(status.reconcile_notes.join(' '), /rebuilt/)

  // --- IMPLEMENT subtask 2
  repo.write('src/util.sh', 'echo util-v2\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'T-1 subtask 2: util')
  assert.equal(advance().verdict, 'GATE')
  assert.equal(approve().stage, 'TEST', 'last subtask advances out of IMPLEMENT')

  // --- TEST (profile test_targeted actually runs the repo's tests)
  completeArtifact(runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST', {
    'Coverage audit': 'src/app.sh covered by tests/app_test.sh; src/util.sh uncovered.',
    'Risk-to-test map': 'Greeting risk → tests/app_test.sh.',
    'Added tests': 'None needed.', Deferred: 'None.'
  })
  assert.equal(advance().verdict, 'GATE'); assert.equal(approve().stage, 'REVIEW')

  // --- REVIEW / PR / CI / SCRIBE
  completeArtifact(runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW', {
    Findings: 'None.', 'Fixes applied': 'None.', Disputed: 'None.', 'Plan-vs-shipped check': 'Matches plan.'
  })
  assert.equal(advance().verdict, 'GATE'); assert.equal(approve().stage, 'PR')

  completeArtifact(runDir, 'artifacts/06-pr-draft.md', 'T-1', 'PR', {
    Title: 'T-1 Update greetings', Description: 'Per plan.', 'Testing notes': 'app_test green.',
    'Ops notes': 'None.', 'Reviewer guidance': 'src/app.sh first.'
  })
  assert.equal(advance().verdict, 'GATE'); assert.equal(approve().stage, 'CI')

  completeArtifact(runDir, 'artifacts/07-ci-analysis.md', 'T-1', 'CI', {
    'Runs analyzed': 'run#1 green.', Classification: 'n/a', Fixes: 'None.', Outcome: 'green, merged by human.'
  })
  assert.equal(advance().verdict, 'GATE'); assert.equal(approve().stage, 'SCRIBE')

  completeArtifact(runDir, 'artifacts/08-retro.md', 'T-1', 'SCRIBE', {
    'Plan-vs-shipped': 'Matches.', Learnings: 'None.', Routing: 'None.'
  })
  assert.equal(advance().verdict, 'GATE')
  const done = approve()
  assert.equal(done.verdict, 'DONE')
  assert.equal(readState(runDir).stage, 'DONE')
  assert.equal(run(['status']).verdict, 'NO_ACTIVE_RUN', 'finished run no longer active')

  // --- VC6: zero repo footprint — only the intended code changes exist
  assert.equal(repo.git('status', '--porcelain').trim(), '', 'working tree clean')
  const branchFiles = repo.git('diff', '--name-only', 'master...HEAD').trim().split('\n').sort()
  assert.deepEqual(branchFiles, ['src/app.sh', 'src/util.sh'], 'branch contains ONLY the planned change')

  // --- audit trail exists for every decision
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(events.filter(e => e.event === 'gate_approved').length >= 10, 'every gate recorded')
  assert.ok(events.some(e => e.event === 'blocked'), 'blocks recorded')
})

// VC7: the SAME graph runs a structurally different repo purely via its profile.
test('repo-agnostic: second repo with different commands runs the same graph unmodified', { timeout: 60_000 }, () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'other-repo')
  // Different toolchain: lint = a word-count budget; tests live elsewhere.
  repo.write('check_budget.sh', '#!/usr/bin/env bash\nfor f in "$@"; do [ "$(wc -l < "$f")" -le 10 ] || exit 1; done\n')
  repo.write('verify/all.sh', '#!/usr/bin/env bash\nexit 0\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'toolchain')
  installProfile(home, 'example.com-test-other-repo', `
repo: git@example.com:test/other-repo.git
commands:
  lint_changed: "./check_budget.sh {changed_files}"
  test_targeted: "./verify/all.sh"
conventions: { base_branch: master }
no_touch: []
`)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', 'example.com-test-other-repo', 'runs', 'X-7')

  assert.equal(run(['new-run', 'X-7']).verdict, 'CREATED')
  completeArtifact(runDir, 'artifacts/01-context.md', 'X-7', 'CONTEXT', { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve']).stage, 'PLAN')
  completeArtifact(runDir, 'artifacts/02-plan.md', 'X-7', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Risks: 'r', Subtasks: '1. only',
    'Testing strategy': 't', 'Open questions': 'None.'
  })
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve']).stage, 'BREAKDOWN')
  completeArtifact(runDir, 'artifacts/03-progress.md', 'X-7', 'BREAKDOWN', { Subtasks: '- [ ] 1. only', Deviations: 'None.' })
  run(['set-substate', 'subtask=1', 'of=1'])
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve']).stage, 'IMPLEMENT')

  repo.git('checkout', '-qb', 'X-7')
  repo.write('src/app.sh', 'echo 1\necho 2\necho 3\necho 4\necho 5\necho 6\necho 7\necho 8\necho 9\necho 10\necho 11\n')
  const blocked = run(['advance'])
  assert.equal(blocked.verdict, 'BLOCKED', "this repo's OWN lint rule (line budget) enforced by the same graph")
  repo.write('src/app.sh', 'echo small\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'X-7 subtask 1')
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve']).stage, 'TEST')
})

// VC4: auto_approvable gates self-approve ONLY under auto_low_risk autonomy.
test('autonomy=auto_low_risk auto-approves auto_approvable gates only', { timeout: 60_000 }, () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'auto-repo')
  installProfile(home, 'example.com-test-auto-repo', STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', 'example.com-test-auto-repo', 'runs', 'A-1')

  assert.equal(run(['new-run', 'A-1', '--autonomy', 'auto_low_risk']).verdict, 'CREATED')
  completeArtifact(runDir, 'artifacts/01-context.md', 'A-1', 'CONTEXT', { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  const advanced = run(['advance'])
  assert.equal(advanced.verdict, 'ADVANCED', 'CONTEXT (auto_approvable) self-approved')
  assert.equal(advanced.stage, 'PLAN')

  completeArtifact(runDir, 'artifacts/02-plan.md', 'A-1', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Risks: 'r', Subtasks: '1. x',
    'Testing strategy': 't', 'Open questions': 'None.'
  })
  assert.equal(run(['advance']).verdict, 'GATE', 'PLAN gate (auto_approvable: false) still requires a human')
})

// Any-folder flow: NO_REPO verdict lists registered repos; --repo <slug> works from anywhere.
test('works from any folder: NO_REPO → repos registry → --repo <slug>', { timeout: 60_000 }, () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'anywhere-repo')
  installProfile(home, 'example.com-test-anywhere-repo', STANDARD_PROFILE)

  // Register the repo by touching it once from inside.
  assert.equal(cli(['status'], { home, cwd: repo.dir }).verdict, 'NO_ACTIVE_RUN')

  // From a folder that is not a git repo at all:
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  const lost = cli(['status'], { home, cwd: elsewhere })
  assert.equal(lost.verdict, 'NO_REPO')
  assert.equal(lost.known_repos.length, 1)
  assert.equal(lost.known_repos[0].slug, 'example.com-test-anywhere-repo')
  assert.ok(lost.known_repos[0].path, 'local path recorded in the registry')
  assert.ok(lost.known_repos[0].has_profile, 'profile flag reported')

  const repos = cli(['repos'], { home, cwd: elsewhere })
  assert.equal(repos.verdict, 'OK')
  assert.equal(repos.repos.length, 1)

  // Drive a run entirely from elsewhere via --repo <slug>:
  assert.equal(cli(['new-run', 'W-1', '--repo', 'example.com-test-anywhere-repo'], { home, cwd: elsewhere }).verdict, 'CREATED')
  const runDir = path.join(home, 'repos', 'example.com-test-anywhere-repo', 'runs', 'W-1')
  completeArtifact(runDir, 'artifacts/01-context.md', 'W-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  assert.equal(cli(['advance', '--repo', 'example.com-test-anywhere-repo'], { home, cwd: elsewhere }).verdict, 'GATE')
  assert.equal(cli(['approve', '--repo', 'example.com-test-anywhere-repo', '--note', 'yes, approved'], { home, cwd: elsewhere }).stage, 'PLAN')
  assert.equal(repos.repos[0].active_runs !== undefined, true, 'repos lists active runs')
})
