import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { AC_TABLE, CLEAN_REVIEW_COUNTS, COUPLING_OK, STANDARD_PROFILE, cli, completeArtifact, contextSections, proofsFrontmatter, installProfile, readState, sandbox, standardRepo } from './helpers.js'

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
    { Requirements: 'Change app greeting.', 'Acceptance criteria': AC_TABLE, Decisions: 'Scope: greeting only.', Findings: 'src/app.sh prints it.', 'Open questions': '' })
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /'## Open questions'.*empty/, 'empty section blocks with section name')

  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT',
    { Requirements: 'Change app greeting.', 'Acceptance criteria': AC_TABLE, Decisions: 'Scope: greeting only.', Findings: 'src/app.sh prints it.', 'Open questions': 'None.' })
  let gate = advance()
  assert.equal(gate.verdict, 'GATE', 'auto_approvable gate still gates under default gated autonomy')
  assert.match(advance().reasons.join(' '), /awaiting gate approval/, 'cannot advance past an unapproved gate')
  assert.equal(approve().stage, 'PLAN')

  // --- PLAN: hallucinated path blocks
  completeArtifact(runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    Approach: 'Edit both scripts.',
    'Affected files': '- `src/app.sh`\n- `src/does-not-exist.sh`',
    Coupling: COUPLING_OK, Risks: 'Greeting change breaks nothing.', Subtasks: '1. app — `src/app.sh`\n2. util — `src/does-not-exist.sh`',
    'Testing strategy': 'shell tests', 'Open questions': 'None.'
  })
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /does-not-exist\.sh.*does not exist/, 'hallucinated plan path blocked')

  completeArtifact(runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    Approach: 'Edit both scripts.',
    'Affected files': '- `src/app.sh`\n- `src/util.sh`',
    Coupling: COUPLING_OK, Risks: 'Greeting change breaks nothing.', Subtasks: '1. app — `src/app.sh`\n2. util — `src/util.sh`',
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

  // --- IMPLEMENT subtask 1: lint failure → boundary violation → green
  // (uncommitted — commits are optional, the gate must pass without one)
  repo.git('checkout', '-qb', 'T-1')
  repo.write('src/app.sh', 'echo LINTFAIL\n')
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /command failed/, 'red lint blocks the diff')

  repo.write('src/app.sh', 'echo app-v2\n')
  repo.write('rogue.txt', 'outside the plan\n')
  blocked = advance()
  assert.match(blocked.reasons.join(' '), /rogue\.txt.*outside the approved plan/, 'write boundary enforced')
  fs.rmSync(path.join(repo.dir, 'rogue.txt'))

  gate = advance()
  assert.equal(gate.verdict, 'GATE')
  assert.equal(gate.subtask, 1)
  assert.ok(!gate.unverified.some(t => /not configured/.test(t)),
    'optional not_configured slots (post_change_hooks) never surface at a gate')
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
    'Risk-to-test map': 'Greeting risk → tests/app_test.sh. AC#1 → tests/app_test.sh.',
    'Added tests': 'None needed.', Deferred: 'None.'
  }, proofsFrontmatter(run(['proof-stamp']).proof_stamp))
  assert.equal(advance().verdict, 'GATE'); assert.equal(approve().stage, 'REVIEW')

  // --- REVIEW / PR / CI / SCRIBE
  completeArtifact(runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW', {
    'Blind pass': 'Reads as a greeting change.', Findings: 'None.', Coupling: COUPLING_OK, 'Fixes applied': 'None.', Disputed: 'None.', 'Plan-vs-shipped check': 'Matches plan.'
  }, CLEAN_REVIEW_COUNTS)
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
  completeArtifact(runDir, 'artifacts/01-context.md', 'X-7', 'CONTEXT', contextSections())
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['approve']).stage, 'PLAN')
  completeArtifact(runDir, 'artifacts/02-plan.md', 'X-7', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Coupling: COUPLING_OK, Risks: 'r', Subtasks: '1. only — `src/app.sh`',
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

// Express (Fast fix): quality gates auto-approve once validators pass; the
// irreversible gates (PR/CI, human_required) still stop for a human. Validators
// still BLOCK on red even in express.
test('express mode auto-approves quality gates, stops at PR, still blocks on red', { timeout: 90_000 }, () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'express-repo')
  installProfile(home, 'example.com-test-express-repo', STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', 'example.com-test-express-repo', 'runs', 'X-1')

  assert.equal(run(['new-run', 'X-1', '--autonomy', 'express']).verdict, 'CREATED')

  // CONTEXT: validators pass → auto-approved (no human), advances to PLAN.
  completeArtifact(runDir, 'artifacts/01-context.md', 'X-1', 'CONTEXT', contextSections())
  const ctx = run(['advance'])
  assert.equal(ctx.verdict, 'ADVANCED', 'CONTEXT auto-approved in express')
  assert.equal(ctx.stage, 'PLAN')

  // PLAN with a hallucinated path STILL blocks — validators gate regardless of mode.
  completeArtifact(runDir, 'artifacts/02-plan.md', 'X-1', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`\n- `src/ghost.sh`', Coupling: COUPLING_OK, Risks: 'r', Subtasks: '1. x — `src/app.sh`, `src/ghost.sh`',
    'Testing strategy': 't', 'Open questions': 'None.'
  })
  assert.equal(run(['advance']).verdict, 'BLOCKED', 'express does NOT bypass validators')

  // Fix the plan → auto-approves through PLAN and BREAKDOWN without a human.
  completeArtifact(runDir, 'artifacts/02-plan.md', 'X-1', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Coupling: COUPLING_OK, Risks: 'r', Subtasks: '1. only — `src/app.sh`',
    'Testing strategy': 't', 'Open questions': 'None.'
  })
  assert.equal(run(['advance']).stage, 'BREAKDOWN', 'PLAN auto-approved in express')
  completeArtifact(runDir, 'artifacts/03-progress.md', 'X-1', 'BREAKDOWN', { Subtasks: '- [ ] 1. only', Deviations: 'None.' })
  run(['set-substate', 'subtask=1', 'of=1'])
  assert.equal(run(['advance']).stage, 'IMPLEMENT', 'BREAKDOWN auto-approved in express')

  // IMPLEMENT subtask (validators run), then TEST, REVIEW all auto-approve → land at PR.
  repo.git('checkout', '-qb', 'X-1')
  repo.write('src/app.sh', 'echo v2\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'X-1 subtask 1')
  assert.equal(run(['advance']).stage, 'TEST', 'IMPLEMENT subtask auto-approved in express')
  completeArtifact(runDir, 'artifacts/04-test-report.md', 'X-1', 'TEST', { 'Coverage audit': 'c', 'Risk-to-test map': 'AC#1 covered.', 'Added tests': 'n', Deferred: 'None.' }, proofsFrontmatter(run(['proof-stamp']).proof_stamp))
  assert.equal(run(['advance']).stage, 'REVIEW', 'TEST auto-approved in express')
  completeArtifact(runDir, 'artifacts/05-review.md', 'X-1', 'REVIEW', { 'Blind pass': 'Reads as a greeting change.', Findings: 'None.', Coupling: COUPLING_OK, 'Fixes applied': 'None.', Disputed: 'None.', 'Plan-vs-shipped check': 'ok' }, CLEAN_REVIEW_COUNTS)

  // REVIEW auto-approves and advances INTO PR (in_progress; PR artifact not made yet).
  const intoPr = run(['advance'])
  assert.equal(intoPr.stage, 'PR', 'REVIEW auto-approved, now at PR')
  assert.notEqual(intoPr.verdict, 'GATE', 'advancing through REVIEW is not itself a human gate')

  // Now produce the PR artifact and advance AT PR → the human gate fires even in express.
  completeArtifact(runDir, 'artifacts/06-pr-draft.md', 'X-1', 'PR', { Title: 't', Description: 'd', 'Testing notes': 'n', 'Ops notes': 'None.', 'Reviewer guidance': 'g' })
  const prGate = run(['advance'])
  assert.equal(prGate.verdict, 'GATE', 'PR still requires a human even in express')
  assert.equal(prGate.human_required, true, 'PR gate flagged human_required')
})

test('set-autonomy switches modes mid-run', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'switch-repo')
  installProfile(home, 'example.com-test-switch-repo', STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  run(['new-run', 'S-1']) // defaults to gated
  assert.equal(run(['status']).autonomy, 'gated')
  assert.equal(run(['set-autonomy', 'express']).autonomy, 'express')
  assert.equal(run(['status']).autonomy, 'express')
  assert.equal(run(['set-autonomy', 'nonsense']).verdict, 'ERROR')
})

// A run stacked on an open feature branch must diff against THAT branch, not the trunk —
// with the trunk as base, lint/tests/boundary all take the whole feature branch as "the change".
test('set-base retargets a stacked run; new-run --base sets it up front', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'base-repo')
  installProfile(home, 'example.com-test-base-repo', STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })

  repo.git('checkout', '-q', '-b', 'feature/stacked')
  repo.write('stacked.txt', 'work\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'stacked work')

  // Asked, never decided. Detection cannot tell "the branch this work stacks
  // on" from "the branch I happen to be standing on" — an auto-applying version
  // of this cost a real run within two days of shipping (a personal wrap-up
  // branch, one commit ahead, taken as the base). So the profile convention
  // stands and the candidate is surfaced as a question.
  const created = run(['new-run', 'B-1'])
  assert.equal(created.base, 'master', 'the profile convention stands until the developer says otherwise')
  assert.equal(created.base_candidate, 'feature/stacked')
  assert.match(created.base_question, /ASK THE DEVELOPER/)
  assert.match(created.base_question, /pipeline set-base feature\/stacked/, 'the question carries the exact command that answers it')

  // Answering it is the developer's one command.
  const retarget = run(['set-base', 'feature/stacked'])
  assert.equal(retarget.from, 'master')
  assert.equal(retarget.base, 'feature/stacked')
  assert.equal(run(['set-base', 'feature/stacked']).note, 'already the run base — nothing changed', 'idempotent')
  assert.equal(run(['set-base', 'no/such/branch']).verdict, 'ERROR', 'unresolvable base is refused, not silently accepted')
  assert.equal(run(['set-base']).verdict, 'ERROR', 'missing argument is a usage error')

  // An explicit --base is an answer already given: no question is raised.
  const explicit = run(['new-run', 'B-2', '--base', 'feature/stacked'])
  assert.equal(explicit.base, 'feature/stacked')
  assert.equal(explicit.base_question, undefined)
  assert.equal(run(['status', '--run', 'B-2']).verdict, 'ACTIVE_RUN')

  // On the trunk with nothing ahead there is nothing to ask about.
  repo.git('checkout', '-q', 'master')
  const plain = run(['new-run', 'B-3'])
  assert.equal(plain.base, 'master')
  assert.equal(plain.base_candidate, undefined, 'no question when no candidate was detected')
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
    contextSections())
  assert.equal(cli(['advance', '--repo', 'example.com-test-anywhere-repo'], { home, cwd: elsewhere }).verdict, 'GATE')
  assert.equal(cli(['approve', '--repo', 'example.com-test-anywhere-repo', '--note', 'yes, approved'], { home, cwd: elsewhere }).stage, 'PLAN')
  assert.equal(repos.repos[0].active_runs !== undefined, true, 'repos lists active runs')
})

// Unverified entries are stage-scoped: a stage-local skip (no_target) shows at
// its own gate and dies at the stage transition; only real coverage gaps
// (no_command — a required slot the repo never configured) follow the run to
// later gates. Optional not_configured slots never surface at all.
test('unverified skips are scoped to their stage; only coverage gaps persist', { timeout: 120_000 }, () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'skips-repo')
  repo.write('config.txt', 'cfg-v1\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'add config')
  // lint_changed (required) missing → a genuine coverage gap; post_change_hooks
  // (optional) missing → must never reach a gate.
  installProfile(home, 'example.com-test-skips-repo', `
repo: git@example.com:test/skips-repo.git
commands:
  test_targeted: "./run_tests.sh {targeted_specs}"
test_layout: { "src/**": "tests/" }
conventions:
  base_branch: master
`)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', 'example.com-test-skips-repo', 'runs', 'N-1')
  const approve = () => { const r = run(['approve']); assert.equal(r.code, 0, JSON.stringify(r)); return r }

  run(['new-run', 'N-1'])
  completeArtifact(runDir, 'artifacts/01-context.md', 'N-1', 'CONTEXT',
    contextSections())
  assert.equal(run(['advance']).verdict, 'GATE'); approve()

  completeArtifact(runDir, 'artifacts/02-plan.md', 'N-1', 'PLAN', {
    Approach: 'Edit the config.', 'Affected files': '- `config.txt`',
    Coupling: COUPLING_OK, Risks: 'None.', Subtasks: '1. cfg — `config.txt`',
    'Testing strategy': 'none applicable', 'Open questions': 'None.'
  })
  assert.equal(run(['advance']).verdict, 'GATE'); approve()

  completeArtifact(runDir, 'artifacts/03-progress.md', 'N-1', 'BREAKDOWN',
    { Subtasks: '- [ ] 1. cfg', Deviations: 'None.' })
  assert.equal(run(['set-substate', 'subtask=1', 'of=1']).verdict, 'OK')
  assert.equal(run(['advance']).verdict, 'GATE'); approve()

  // IMPLEMENT: a config-only change → test_targeted maps to no target (stage-local
  // skip); lint_changed is a required slot with no command (coverage gap).
  repo.git('checkout', '-qb', 'N-1')
  repo.write('config.txt', 'cfg-v2\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'N-1 subtask 1: config')
  const implGate = run(['advance'])
  assert.equal(implGate.verdict, 'GATE')
  assert.ok(implGate.unverified.some(t => /lint_changed/.test(t) && /coverage gap/.test(t)),
    'missing required slot surfaces as a coverage gap')
  assert.ok(implGate.unverified.some(t => /not applicable to this change/.test(t)),
    'stage-local no_target skip surfaces at its own gate')
  assert.ok(!implGate.unverified.some(t => /not configured/.test(t)),
    'optional not_configured slot never surfaces')
  approve()

  completeArtifact(runDir, 'artifacts/04-test-report.md', 'N-1', 'TEST', {
    'Coverage audit': 'config.txt has no executable behavior.',
    'Risk-to-test map': 'AC#1 → verified manually (config value).',
    'Added tests': 'None needed.', Deferred: 'None.'
  }, proofsFrontmatter(run(['proof-stamp']).proof_stamp))
  assert.equal(run(['advance']).verdict, 'GATE'); approve()

  completeArtifact(runDir, 'artifacts/05-review.md', 'N-1', 'REVIEW', {
    'Blind pass': 'Reads as a greeting change.', Findings: 'None.', Coupling: COUPLING_OK, 'Fixes applied': 'None.', Disputed: 'None.', 'Plan-vs-shipped check': 'Matches plan.'
  }, CLEAN_REVIEW_COUNTS)
  assert.equal(run(['advance']).verdict, 'GATE'); approve()

  // PR runs no profile commands: what shows here is only what PERSISTED.
  completeArtifact(runDir, 'artifacts/06-pr-draft.md', 'N-1', 'PR', {
    Title: 'N-1 config update', Description: 'Per plan.', 'Testing notes': 'n/a',
    'Ops notes': 'None.', 'Reviewer guidance': 'config.txt.'
  })
  const prGate = run(['advance'])
  assert.equal(prGate.verdict, 'GATE')
  assert.ok(prGate.unverified.some(t => /lint_changed/.test(t) && /coverage gap/.test(t)),
    'the coverage gap follows the run to the PR gate')
  assert.ok(!prGate.unverified.some(t => /not applicable to this change/.test(t)),
    'stage-local skips do not reappear at later gates')
})
