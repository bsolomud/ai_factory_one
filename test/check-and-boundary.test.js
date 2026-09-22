import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { AC_TABLE, COUPLING_OK, STANDARD_PROFILE, cli, completeArtifact, installProfile, readState, sandbox, standardRepo } from './helpers.js'

// The dry run and the boundary amendment — the two verbs aimed at the pilot's
// loudest number: 816 of 887 recorded block reasons were the write boundary,
// and 67 of 81 blocked events happened at stages whose agent could have found
// the same failure itself, for free, before declaring the artifact done.

const SLUG = 'example.com-test-check-repo'

// Drive a fresh run to IMPLEMENT with the standard two-file plan.
function runAtImplement(name) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', slug, 'runs', 'C-1')

  run(['new-run', 'C-1'])
  completeArtifact(runDir, 'artifacts/01-context.md', 'C-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': AC_TABLE, Decisions: 'None — fake run.', Findings: 'f', 'Open questions': 'None.' })
  run(['advance']); run(['approve'])
  completeArtifact(runDir, 'artifacts/02-plan.md', 'C-1', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Coupling: COUPLING_OK,
    Risks: 'none', Subtasks: '1. app — `src/app.sh`', 'Testing strategy': 't', 'Open questions': 'None.'
  })
  run(['advance']); run(['approve'])
  completeArtifact(runDir, 'artifacts/03-progress.md', 'C-1', 'BREAKDOWN', { Subtasks: '- [ ] 1. app', Deviations: 'None.' })
  run(['set-substate', 'subtask=1', 'of=1'])
  run(['advance']); run(['approve'])
  repo.git('checkout', '-qb', 'C-1')
  assert.equal(run(['status']).stage, 'IMPLEMENT')
  return { home, repo, run, runDir, slug }
}

test('check: same validators, zero consequences — and the finalization stamp is reported apart', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'check-repo')
  installProfile(home, SLUG, STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', SLUG, 'runs', 'C-1')
  run(['new-run', 'C-1'])

  const eventsBefore = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
  const stateBefore = fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')

  // A real failure: an empty required section.
  fs.writeFileSync(path.join(runDir, 'artifacts/01-context.md'),
    `---\nrun: C-1\nstage: CONTEXT\nstatus: draft\n---\n\n## Requirements\nr\n\n## Acceptance criteria\n${AC_TABLE}\n\n## Decisions\nd\n\n## Findings\nf\n\n## Open questions\n`)
  const red = run(['check'])
  assert.equal(red.verdict, 'RED')
  assert.equal(red.code, 1, 'a red dry run exits non-zero, like every other verdict this CLI gives')
  assert.match(red.blocking.join(' '), /'## Open questions'.*empty/)
  assert.ok(red.checks.some(c => c.check === 'sections' && c.status === 'fail'))

  // Nothing at all was recorded: no blocked event, no state write. That is the
  // whole point — self-checking must be free, or agents stop doing it.
  assert.equal(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), eventsBefore, 'check records no events')
  assert.equal(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'), stateBefore, 'check writes no state')

  // Filled in, but still draft — the runbooks mandate `status: complete` as the
  // LAST edit, so this is the expected mid-work state, not a defect.
  fs.writeFileSync(path.join(runDir, 'artifacts/01-context.md'),
    `---\nrun: C-1\nstage: CONTEXT\nstatus: draft\n---\n\n## Requirements\nr\n\n## Acceptance criteria\n${AC_TABLE}\n\n## Decisions\nd\n\n## Findings\nf\n\n## Open questions\nNone.\n`)
  const pending = run(['check'])
  assert.equal(pending.verdict, 'GREEN')
  assert.equal(pending.code, 0)
  assert.equal(pending.blocking.length, 0)
  assert.match(pending.pending_finalization.join(' '), /status 'draft'/)
  assert.match(pending.next_action, /status: complete/)

  completeArtifact(runDir, 'artifacts/01-context.md', 'C-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': AC_TABLE, Decisions: 'd', Findings: 'f', 'Open questions': 'None.' })
  const green = run(['check'])
  assert.equal(green.verdict, 'GREEN')
  assert.equal(green.pending_finalization.length, 0)
  assert.match(green.next_action, /pipeline advance/)

  // --stage looks ahead at a stage the run has not reached yet.
  assert.equal(run(['check', '--stage', 'PLAN']).verdict, 'RED')
  assert.equal(run(['check', '--stage', 'NOPE']).verdict, 'ERROR')
})

test('amend-boundary: a widening is appended, audited and honored — no_touch still wins', () => {
  const { repo, run, runDir } = runAtImplement('amend-repo')

  // The change turns out to need a file the approved plan never listed.
  repo.write('src/app.sh', 'echo app-v2\n')
  repo.write('src/util.sh', 'echo util-v2\n')
  const blocked = run(['advance'])
  assert.equal(blocked.verdict, 'BLOCKED')
  assert.match(blocked.reasons.join(' '), /src\/util\.sh.*outside the approved plan/)
  assert.match(blocked.reasons.join(' '), /pipeline amend-boundary src\/util\.sh --reason/, 'the block names the exact way out')

  assert.equal(run(['amend-boundary', 'src/util.sh']).verdict, 'ERROR', 'a widening without a reason is refused')

  const amended = run(['amend-boundary', 'src/util.sh', '--reason', 'the greeting helper moved here'])
  assert.equal(amended.verdict, 'OK')
  assert.deepEqual(amended.added, ['src/util.sh'])

  // Appended, never rewritten: the approved section is byte-for-byte intact.
  const plan = fs.readFileSync(path.join(runDir, 'artifacts/02-plan.md'), 'utf8')
  assert.match(plan, /## Affected files\n- `src\/app\.sh`/, 'the approved section is untouched')
  assert.match(plan, /## Amendments[\s\S]*- boundary: `src\/util\.sh` — the greeting helper moved here \(IMPLEMENT, \d{4}-\d{2}-\d{2}\)/)

  assert.equal(run(['advance']).verdict, 'GATE', 'the widened boundary is honored')
  assert.equal(run(['amend-boundary', 'src/util.sh', '--reason', 'again']).added.length, 0, 'idempotent — already inside the boundary')

  // The developer's no_touch rule is not the plan's to amend.
  const refused = run(['amend-boundary', 'locked/keep.txt', '--reason', 'I need it'])
  assert.equal(refused.verdict, 'BLOCKED')
  assert.match(refused.reasons.join(' '), /no_touch/)

  // Audit trail: the widening is an event, so the retro and the gate both see it.
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
  assert.match(events, /"event":"boundary_amended"/)
  assert.match(events, /"reason":"the greeting helper moved here"/)
})

test('amend-boundary refuses while the plan is still being written', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'premature-repo')
  const slug = 'example.com-test-premature-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', slug, 'runs', 'P-1')
  run(['new-run', 'P-1'])
  completeArtifact(runDir, 'artifacts/01-context.md', 'P-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': AC_TABLE, Decisions: 'd', Findings: 'f', 'Open questions': 'None.' })
  run(['advance']); run(['approve'])
  assert.equal(readState(runDir).stage, 'PLAN')
  const r = run(['amend-boundary', 'src/util.sh', '--reason', 'why not'])
  assert.equal(r.verdict, 'ERROR')
  assert.match(r.error, /still being written/)
})
