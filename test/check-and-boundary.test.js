import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { COUPLING_OK, STANDARD_PROFILE, artifactBody, cli, completeArtifact, contextSections, installProfile, readState, sandbox, standardRepo } from './helpers.js'

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
    contextSections())
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
    `---\nrun: C-1\nstage: CONTEXT\nstatus: draft\n---\n\n${artifactBody('CONTEXT', contextSections({ Decisions: 'd', 'Open questions': '' }))}`)
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
    `---\nrun: C-1\nstage: CONTEXT\nstatus: draft\n---\n\n${artifactBody('CONTEXT', contextSections({ Decisions: 'd' }))}`)
  const pending = run(['check'])
  assert.equal(pending.verdict, 'GREEN')
  assert.equal(pending.code, 0)
  assert.equal(pending.blocking.length, 0)
  assert.match(pending.pending_finalization.join(' '), /status 'draft'/)
  assert.match(pending.next_action, /status: complete/)

  completeArtifact(runDir, 'artifacts/01-context.md', 'C-1', 'CONTEXT',
    contextSections({ Decisions: 'd' }))
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

// A pilot run: the developer asked for generated files under no_touch to be
// regenerated and committed; base..HEAD then failed every later check, and the
// only way out was deleting the rule from the profile by hand.
test('allow-touch: a developer-authorized commit is exempt from no_touch — exactly its content, nothing after', () => {
  const { repo, run, runDir } = runAtImplement('touch-repo')
  repo.write('src/app.sh', 'echo app-v2\n')
  repo.git('commit', '-qam', 'app')
  const appSha = repo.git('rev-parse', 'HEAD').trim()
  repo.write('locked/keep.txt', 'regenerated at the developer\'s request\n')
  repo.git('add', 'locked/keep.txt')
  repo.git('commit', '-qm', 'regen')
  const sha = repo.git('rev-parse', 'HEAD').trim()

  const red = run(['advance'])
  assert.equal(red.verdict, 'BLOCKED', 'no_touch judges the whole branch')
  assert.match(red.reasons.join(' '), /locked\/keep\.txt.*no_touch.*pipeline allow-touch --commit/, 'the block names the way out')

  assert.equal(run(['allow-touch', '--commit', sha]).verdict, 'ERROR', 'no reason → refused')
  assert.equal(run(['allow-touch', '--commit', 'nope', '--reason', 'r']).verdict, 'ERROR', 'unknown commit → refused')
  assert.equal(run(['allow-touch', 'src/app.sh', '--commit', sha, '--reason', 'r']).verdict, 'ERROR', 'a path the commit did not change → refused')
  assert.equal(run(['allow-touch', '--commit', appSha, '--reason', 'r']).verdict, 'ERROR', 'a commit with no no_touch path → nothing to exempt')

  const ok = run(['allow-touch', '--commit', sha, '--reason', 'developer asked to regenerate keep.txt'])
  assert.equal(ok.verdict, 'OK')
  assert.deepEqual(ok.exempt, ['locked/keep.txt'])
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"event":"touch_allowed"/)
  assert.match(fs.readFileSync(path.join(runDir, 'artifacts/02-plan.md'), 'utf8'), /## Amendments[\s\S]*- no_touch exemption at commit `[0-9a-f]{11}`: `locked\/keep\.txt` — developer asked/)
  assert.equal(run(['check']).checks.find(c => c.check === 'git_clean_within')?.status, 'pass', 'exempt while the content matches the commit')

  // An edit on top of the authorized content is the pipeline's own — caught again.
  repo.write('locked/keep.txt', 'hand-edited afterwards\n')
  const again = run(['check'])
  assert.equal(again.checks.find(c => c.check === 'git_clean_within')?.status, 'fail')
  assert.ok(again.blocking.some(r => /locked\/keep\.txt.*no_touch/.test(r)), 'the block names the edited file')

  // amend-boundary still refuses no_touch — the exemption is a separate, commit-keyed verb.
  assert.equal(run(['amend-boundary', 'locked/keep.txt', '--reason', 'x']).verdict, 'BLOCKED')
})

// The failure this diagnostic exists for: a run based on the trunk whose work
// stacks on a feature branch reports every file in that branch as out-of-plan.
// Hundreds of reasons, none of them the run's doing — and unreadable as such by
// anyone who does not already know the failure mode.
test('the boundary block names a wrong base instead of blaming the change', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'wrongbase-repo')
  const slug = 'example.com-test-wrongbase-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const run = args => cli(args, { home, cwd: repo.dir })
  const runDir = path.join(home, 'repos', slug, 'runs', 'W-1')

  // A feature branch with work of its own, landed BEFORE this run exists.
  repo.git('checkout', '-qb', 'feature/big')
  repo.write('src/util.sh', 'echo util-from-the-feature-branch\n')
  repo.write('other.sh', 'echo also-from-the-feature-branch\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'feature branch work')

  // The run is created here and keeps the profile base (master) — the question
  // was surfaced and, as happens, nobody answered it.
  assert.equal(run(['new-run', 'W-1']).base, 'master')
  completeArtifact(runDir, 'artifacts/01-context.md', 'W-1', 'CONTEXT',
    contextSections({ Decisions: 'd' }))
  run(['advance']); run(['approve'])
  completeArtifact(runDir, 'artifacts/02-plan.md', 'W-1', 'PLAN', {
    Approach: 'a', 'Affected files': '- `src/app.sh`', Coupling: COUPLING_OK,
    Risks: 'none', Subtasks: '1. app — `src/app.sh`', 'Testing strategy': 't', 'Open questions': 'None.'
  })
  run(['advance']); run(['approve'])
  completeArtifact(runDir, 'artifacts/03-progress.md', 'W-1', 'BREAKDOWN', { Subtasks: '- [ ] 1. app', Deviations: 'None.' })
  run(['set-substate', 'subtask=1', 'of=1'])
  run(['advance']); run(['approve'])

  // The run's OWN work: one file, inside the plan.
  repo.write('src/app.sh', 'echo app-v2\n')
  const blocked = run(['advance'])
  assert.equal(blocked.verdict, 'BLOCKED')
  const all = blocked.reasons.join('\n')
  // The feature branch's files are reported as out-of-plan — that is the raw
  // symptom, and on a real branch there are hundreds of these.
  assert.match(all, /other\.sh.*outside the approved plan/)
  // …and the diagnosis names the actual cause rather than leaving the reader to
  // conclude their one-file change is wildly out of scope.
  assert.match(all, /BASE CHECK — 2 of the 2 out-of-plan file\(s\)/)
  assert.match(all, /have not changed since this run started/)
  assert.match(all, /pipeline set-base/)

  // Answer the base question and the noise is gone — which is the proof that
  // the diagnosis was right.
  assert.equal(run(['set-base', 'feature/big']).base, 'feature/big')
  assert.equal(run(['advance']).verdict, 'GATE')
})

test('the base diagnostic stays silent when the run really did touch the files', () => {
  const { repo, run } = runAtImplement('touched-repo')
  // An out-of-plan file the run itself wrote: a real boundary violation, and
  // blaming the base here would send the developer down the wrong path.
  repo.write('src/app.sh', 'echo app-v2\n')
  repo.write('src/util.sh', 'echo written-by-this-run\n')
  const blocked = run(['advance'])
  assert.equal(blocked.verdict, 'BLOCKED')
  const all = blocked.reasons.join('\n')
  assert.match(all, /src\/util\.sh.*outside the approved plan/)
  assert.ok(!all.includes('BASE CHECK'), 'a file this run wrote is never blamed on the base')
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
    contextSections({ Decisions: 'd' }))
  run(['advance']); run(['approve'])
  assert.equal(readState(runDir).stage, 'PLAN')
  const r = run(['amend-boundary', 'src/util.sh', '--reason', 'why not'])
  assert.equal(r.verdict, 'ERROR')
  assert.match(r.error, /still being written/)
})
