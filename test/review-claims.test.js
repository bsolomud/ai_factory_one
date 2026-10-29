import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { validators } from '../src/validators.js'
import { appendEvent, newState } from '../src/state.js'
import { completeArtifact, sandbox, standardRepo } from './helpers.js'

// REVIEW proves claims instead of repeating them. A pilot run: a 'not tested'
// row of the test report ("a single sync only clears the status") was re-read,
// agreed with, and repeated in the PR — and was wrong. Another: the bound team
// review skill was read, not executed, and its real pass found a blocker.

const CONFIG = {
  stages: {
    TEST: { output: 'artifacts/04-test-report.md' },
    REVIEW: { output: 'artifacts/05-review.md' },
    PR: { output: 'artifacts/06-pr-draft.md' }
  }
}

function setup({ profile = {} } = {}) {
  const { root } = sandbox()
  const repo = standardRepo(root, 'claims-repo')
  const runDir = path.join(root, 'run')
  const ctx = output => ({
    runDir,
    repoDir: repo.dir,
    profile: { test_layout: { 'src/**': 'tests/' }, ...profile },
    state: newState({ runId: 'T-1', repo: 'r', stage: 'REVIEW' }),
    stageDef: { output },
    stageName: output.includes('review') ? 'REVIEW' : 'PR',
    config: CONFIG
  })
  return { repo, runDir, review: ctx('artifacts/05-review.md'), pr: ctx('artifacts/06-pr-draft.md') }
}

const MAP = `| Risk | Test | Coverage |
|------|------|----------|
| Greeting changes on every page | tests/app_test.sh | covered |
| A single **sync** clears the status until the next full run | — | not tested because it is accepted behaviour |
| AC#1 — greeting reads v2 | tests/app_test.sh | covered |`

const review = (runDir, claims) => completeArtifact(runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW',
  { Findings: 'None.', ...(claims !== undefined && { 'Untested claims': claims }) })

test('untested_claims: every not-tested row is accounted for — proven by an existing test, or carried as Not verified', () => {
  const { runDir, review: ctx } = setup()
  completeArtifact(runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST', { 'Risk-to-test map': MAP })

  review(runDir)
  let r = validators.untested_claims(ctx)
  assert.equal(r.ok, false, 'section missing while the report has an untested row')
  assert.match(r.reasons[0], /1 row\(s\) 'not tested'.*## Untested claims/)

  review(runDir, '| Claim | Proof | PR note |\n|---|---|---|\n| Greeting changes on every page | `tests/app_test.sh` | |')
  r = validators.untested_claims(ctx)
  assert.equal(r.ok, false, 'a row for a different claim does not count')
  assert.match(r.reasons[0], /no row for "A single \*\*sync\*\* clears/)

  const row = proof => review(runDir, `| Claim | Proof | PR note |\n|---|---|---|\n| A single sync clears the status until the next full run | ${proof} |`)
  row('read `src/app.sh:3`, holds | |')
  r = validators.untested_claims(ctx)
  assert.equal(r.ok, false, 'reading the code is not proof')
  assert.match(r.reasons[0], /existing test file/)

  row('`tests/missing_test.sh` | |')
  assert.equal(validators.untested_claims(ctx).ok, false, 'a test file that does not exist is not proof')

  row('`tests/app_test.sh:1` | |')
  assert.equal(validators.untested_claims(ctx).ok, true, 'an existing test file, wording matched ignoring emphasis')

  row('Not verified | — |')
  r = validators.untested_claims(ctx)
  assert.equal(r.ok, false, 'Not verified needs a PR note')
  assert.match(r.reasons[0], /no PR note/)

  row('Not verified | Pressing Sync on one user was not tested. |')
  assert.equal(validators.untested_claims(ctx).ok, true, 'Not verified never blocks once it is carried')
})

test('untested_claims: nothing to account for when the report has no untested rows, or no report', () => {
  const { runDir, review: ctx } = setup()
  assert.equal(validators.untested_claims(ctx).ok, true, 'no test report')
  completeArtifact(runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST', {
    'Risk-to-test map': '| Risk | Test | Coverage |\n|---|---|---|\n| x | tests/app_test.sh | covered |'
  })
  review(runDir)
  assert.equal(validators.untested_claims(ctx).ok, true, 'section not required')
})

test('untested_in_pr: each Not verified note reaches Testing notes word for word', () => {
  const { runDir, pr: ctx } = setup()
  review(runDir, '| Claim | Proof | PR note |\n|---|---|---|\n| a | Not verified | Pressing Sync on one user was not tested. |\n| b | `tests/app_test.sh` | |')
  const draft = notes => completeArtifact(runDir, 'artifacts/06-pr-draft.md', 'T-1', 'PR', { 'Testing notes': notes })

  draft('Run the app and look at the greeting.')
  const r = validators.untested_in_pr(ctx)
  assert.equal(r.ok, false)
  assert.equal(r.reasons.length, 1, 'only the Not verified row is owed')
  assert.match(r.reasons[0], /Pressing Sync on one user was not tested\./)

  draft('Run the app and look at the greeting.\n\nPressing Sync on one   user was **not** tested.')
  assert.equal(validators.untested_in_pr(ctx).ok, true, 'spacing and emphasis ignored')
})

test('skill_trace: a bound repo review skill is executed and traced, not read', () => {
  const skill = '.ai/skills/reviewer'
  const { repo, runDir, review: ctx } = setup({ profile: { bindings: { review: { source: 'repo', path: skill } } } })
  repo.write(`${skill}/SKILL.md`, '# reviewer\n')
  repo.write(`${skill}/re-reviews.md`, '# re-reviews\n')

  review(runDir)
  let r = validators.skill_trace(ctx)
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /binds its own review skill.*## Team skill trace/)

  const trace = rows => completeArtifact(runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW',
    { Findings: 'None.', 'Team skill trace': `| Step | What the skill asks | What I did |\n|---|---|---|\n${rows}` })
  trace('| 1. Diff | read the diff | looked at it |')
  r = validators.skill_trace(ctx)
  assert.ok(r.reasons.some(x => /cites nothing/.test(x)), 'a step with no file:line or command')
  assert.ok(r.reasons.some(x => /pipeline used skill \.ai\/skills\/reviewer'/.test(x)), 'skill use not recorded')

  appendEvent(runDir, { event: 'asset_used', kind: 'skill', ref: skill, stage: 'REVIEW', source: 'agent' })
  trace('| 1. Diff | read the diff | `git diff master` |\n| 9. Verdict | `re-reviews.md` | applied to `src/app.sh:1` |')
  r = validators.skill_trace(ctx)
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /cites \.ai\/skills\/reviewer\/re-reviews\.md but it was not recorded/)

  appendEvent(runDir, { event: 'asset_used', kind: 'skill', ref: `${skill}/re-reviews.md`, stage: 'REVIEW', source: 'agent' })
  assert.equal(validators.skill_trace(ctx).ok, true)

  trace('| 1. Diff | read the diff | `git diff master` |\n| 9. Verdict | approve | nothing new found |')
  assert.equal(validators.skill_trace(ctx).ok, true, 'the verdict step sums up; it cites nothing of its own')
})

test('skill_trace: no repo binding → nothing required', () => {
  const { runDir, review: ctx } = setup({ profile: { bindings: { review: { source: 'builtin' } } } })
  review(runDir)
  assert.equal(validators.skill_trace(ctx).ok, true)
})
