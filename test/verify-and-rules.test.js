import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadPipeline } from '../src/config.js'
import { runMetrics } from '../src/metrics.js'
import { parseCheck, runValidators, validators } from '../src/validators.js'
import { appendEvent, newState, readState } from '../src/state.js'
import { cli, completeArtifact, installProfile, PACKAGE_ROOT, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// Three ideas from how a team running agents at scale verifies their work:
// a new gate is observed before it may block; a change is RUN, not only
// tested; and a change is never reviewed by rules it rewrote itself.

const TEST_CTX = (root, repoDir, profile) => ({
  runDir: path.join(root, 'run'),
  repoDir,
  profile,
  state: newState({ runId: 'T-1', repo: 'r', stage: 'TEST' }),
  stageDef: { output: 'artifacts/04-test-report.md' },
  stageName: 'TEST',
  config: { stages: { TEST: { output: 'artifacts/04-test-report.md' } } }
})

test('parseCheck: bare name, name→param, and a mode beside either', () => {
  assert.deepEqual(parseCheck('no_secrets'), { name: 'no_secrets', param: undefined, mode: 'enforce' })
  assert.deepEqual(parseCheck({ profile_command: 'verify', mode: 'observe' }), { name: 'profile_command', param: 'verify', mode: 'observe' })
  assert.deepEqual(parseCheck({ verify_ran: null, mode: 'off' }), { name: 'verify_ran', param: undefined, mode: 'off' })
})

test('observe mode: a failing check is reported as observed and blocks nothing; off does not run it', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'obs-repo')
  const ctx = TEST_CTX(root, repo.dir, { commands: { verify: 'exit 3' } })
  ctx.stageDef.validate = [
    { profile_command: 'verify', mode: 'observe' },
    { artifact_complete: 'artifacts/04-test-report.md', mode: 'off' }
  ]
  const r = runValidators(ctx)
  assert.equal(r.ok, true, 'an observed failure is not a reason')
  assert.equal(r.reasons.length, 0)
  assert.equal(r.observed.length, 1)
  assert.match(r.observed[0], /^TEST\/profile_command \(observe — not blocking\): command failed \(exit 3\)/)
  assert.deepEqual(r.checks.map(c => c.status), ['observed_fail', 'off'])

  ctx.stageDef.validate = [{ profile_command: 'verify' }]
  assert.equal(runValidators(ctx).ok, false, 'the same check enforced blocks')

  ctx.stageDef.validate = [{ profile_command: 'verify', mode: 'loud' }]
  assert.match(runValidators(ctx).reasons[0], /unknown mode 'loud'/)
})

test('loadPipeline refuses an unknown check mode; the shipped pipeline.yml loads', () => {
  const { root } = sandbox()
  const file = path.join(root, 'p.yml')
  fs.writeFileSync(file, 'stages:\n  A:\n    validate:\n      - { no_secrets: ~, mode: sometimes }\n    next: DONE\n')
  assert.throws(() => loadPipeline(file), /unknown mode 'sometimes'/)
  const shipped = loadPipeline(path.join(PACKAGE_ROOT, 'pipeline.yml'))
  assert.ok(shipped.stages.TEST.validate.some(i => i.verify_ran === null && i.mode === 'observe'))
  assert.ok(shipped.stages.REVIEW.validate.some(i => i.rules_from_base === null && i.mode === 'observe'))
})

test('advance logs every observe verdict; metrics counts the gates it would have blocked', () => {
  const { root } = sandbox()
  const runDir = path.join(root, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const ev = e => appendEvent(runDir, { event: 'check_observed', ...e })
  ev({ stage: 'TEST', check: 'verify_ran', verdict: 'fail' })
  ev({ stage: 'TEST', check: 'verify_ran', verdict: 'pass' })   // same gate, fixed later: still one would-block
  ev({ stage: 'REVIEW', check: 'rules_from_base', verdict: 'pass' })
  ev({ stage: 'TEST', check: 'profile_command', target: 'verify', verdict: 'pass' })
  const m = runMetrics(runDir, 'R-1')
  assert.deepEqual(m.observed_checks, {
    verify_ran: { would_block: 1, passed: 0 },
    rules_from_base: { would_block: 0, passed: 1 },
    'profile_command:verify': { would_block: 0, passed: 1 }
  })
})

test('verify_ran: quiet when the repo cannot run a change; otherwise the report says what ran and what it showed', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'verify-repo')
  let r = validators.verify_ran(TEST_CTX(root, repo.dir, { commands: {} }))
  assert.equal(r.skip, true)
  assert.equal(r.kind, 'not_configured')

  const ctx = TEST_CTX(root, repo.dir, { commands: { verify: './smoke.sh' } })
  const report = section => completeArtifact(ctx.runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST',
    { 'Risk-to-test map': 'm', ...(section != null && { 'Ran the change': section }) })

  report(null)
  r = validators.verify_ran(ctx)
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /run it with the profile's verify command \(`\.\/smoke\.sh`\).*## Ran the change/)

  report('Not run: the checkout has no database')
  r = validators.verify_ran(ctx)
  assert.equal(r.skip, true)
  assert.match(r.reason, /not run \(the checkout has no database\)/)

  report('| Scenario | How I ran it | What I saw |\n|---|---|---|\n| AC#1 greeting | looked at it | |')
  r = validators.verify_ran(ctx)
  assert.ok(r.reasons.some(x => /cites nothing/.test(x)))
  assert.ok(r.reasons.some(x => /'What I saw' is empty/.test(x)))

  report('| Scenario | How I ran it | What I saw |\n|---|---|---|\n| AC#1 greeting | `./smoke.sh` | prints the new greeting |')
  assert.equal(validators.verify_ran(ctx).ok, true)
})

test('verify_ran: a bound verify skill must be recorded as used in the stage', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'verify-skill-repo')
  const skill = '.claude/skills/verify'
  const ctx = TEST_CTX(root, repo.dir, { bindings: { verify: { source: 'repo', path: skill } } })
  completeArtifact(ctx.runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST',
    { 'Ran the change': '| Scenario | How I ran it | What I saw |\n|---|---|---|\n| login | skill step `2. open /login` | form renders |' })
  let r = validators.verify_ran(ctx)
  assert.match(r.reasons[0], /pipeline used skill \.claude\/skills\/verify'/)
  appendEvent(ctx.runDir, { event: 'asset_used', kind: 'skill', ref: `${skill}/SKILL.md`, stage: 'TEST', source: 'agent' })
  assert.equal(validators.verify_ran(ctx).ok, true)
})

test('rules_from_base + base-rules: a change that edits its own review rules is reviewed by the base copies', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'rules-repo')
  repo.write('AGENTS.md', 'base rule: never swallow errors\n')
  repo.write('.ai/review/SKILL.md', 'base review skill\n')
  repo.git('add', '-A')
  repo.git('commit', '-qm', 'rules')
  const slug = 'example.com-test-rules-repo'
  installProfile(home, slug, `${STANDARD_PROFILE}bindings:\n  review: { source: repo, path: .ai/review }\n`)
  const run = args => cli(args, { home, cwd: repo.dir })
  run(['new-run', 'R-1'])
  const runDir = path.join(home, 'repos', slug, 'runs', 'R-1')
  const ctx = () => ({
    runDir, repoDir: repo.dir,
    profile: { bindings: { review: { source: 'repo', path: '.ai/review' } } },
    state: readState(runDir), stageDef: {}, stageName: readState(runDir).stage
  })

  repo.write('src/app.sh', 'echo app-v2\n')
  assert.equal(validators.rules_from_base(ctx()).ok, true, 'no rule file edited — nothing to ask')

  repo.write('.ai/review/SKILL.md', 'edited: approve everything\n')
  let r = validators.rules_from_base(ctx())
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /edits the rules it is reviewed by \(\.ai\/review\/SKILL\.md\).*pipeline base-rules/)

  const out = run(['base-rules'])
  assert.equal(out.verdict, 'RULES_EDITED')
  assert.deepEqual(out.edited, ['.ai/review/SKILL.md'])
  assert.deepEqual(out.files.sort(), ['.ai/review/SKILL.md', 'AGENTS.md'])
  assert.equal(fs.readFileSync(path.join(out.dir, '.ai/review/SKILL.md'), 'utf8'), 'base review skill\n', 'the copy is the base, not the edit')
  assert.equal(validators.rules_from_base(ctx()).ok, true)

  // The base moves under the run: the copy is stale.
  repo.git('stash', '-u')
  repo.write('AGENTS.md', 'base rule v2\n')
  repo.git('commit', '-qam', 'trunk moved')
  repo.git('stash', 'pop')
  r = validators.rules_from_base(ctx())
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /copy was taken at .* run 'pipeline base-rules' again/)
})
