import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { validators } from '../src/validators.js'
import { readState as readRunState } from '../src/state.js'
import { cli, completeArtifact, installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// A pilot run: the opened PR lived only in a free-text note, and 45 failures
// inherited from a red base were re-diagnosed at CI as if they were the run's.

function started(name) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, STANDARD_PROFILE)
  const run = (args, env) => cli(args, { home, cwd: repo.dir, env })
  run(['new-run', 'R-1'])
  return { root, home, repo, run, runDir: path.join(home, 'repos', slug, 'runs', 'R-1') }
}

// A fake `gh`: `run list` and `pr list` answer from files.
function gh(root, { runs = [], prs = [] }) {
  fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify(runs))
  fs.writeFileSync(path.join(root, 'prs.json'), JSON.stringify(prs))
  const bin = path.join(root, 'gh-shim')
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in run) cat '${root}/runs.json';; pr) cat '${root}/prs.json';; *) exit 2;; esac\n`, { mode: 0o755 })
  return { PIPELINE_GH: bin }
}

test('pr-opened: the PR is recorded once and status shows it from then on', () => {
  const { run } = started('pr-repo')
  assert.equal(run(['status']).pr, null)
  assert.equal(run(['pr-opened', 'not-a-pr']).verdict, 'ERROR')
  const r = run(['pr-opened', 'https://github.com/acme/app/pull/77'])
  assert.equal(r.verdict, 'OK')
  assert.equal(r.pr.number, 77)
  assert.match(r.pr.head, /^[0-9a-f]{40}$/)
  const st = run(['status']).pr
  assert.equal(st.number, 77)
  assert.equal(st.url, 'https://github.com/acme/app/pull/77')
  run(['pr-opened', '#30300'])
  assert.equal(run(['status']).pr.number, 30300, 'a re-opened PR replaces the record')
})

test('base-health: a stacked run asks the base\'s own CI; a trunk run is not asked', () => {
  const { root, repo, run, runDir } = started('base-repo')
  assert.equal(run(['base-health']).verdict, 'NOT_STACKED')

  repo.git('branch', 'feature/base')
  const tip = repo.git('rev-parse', 'feature/base').trim()
  run(['set-base', 'feature/base'])
  const env = gh(root, {
    runs: [
      { headSha: tip, workflowName: 'RSpec', status: 'completed', conclusion: 'failure', url: 'https://ci/1' },
      { headSha: tip, workflowName: 'Lint', status: 'completed', conclusion: 'success', url: 'https://ci/2' },
      { headSha: 'older', workflowName: 'RSpec', status: 'completed', conclusion: 'success', url: 'https://ci/0' }
    ],
    prs: [{ number: 7, title: 'Repair base', url: 'u' }]
  })
  const red = run(['base-health'], env)
  assert.equal(red.verdict, 'RED')
  assert.equal(red.tip_checked, true)
  assert.deepEqual(red.red, ['RSpec: https://ci/1'], 'the latest run per workflow on the tip, not an older green one')
  assert.deepEqual(red.open_prs_into_base, ['#7 Repair base'])
  assert.match(red.next_action, /base red/)

  const green = run(['base-health'], gh(root, { runs: [{ headSha: tip, workflowName: 'RSpec', status: 'completed', conclusion: 'success', url: 'x' }] }))
  assert.equal(green.verdict, 'GREEN')
  assert.equal(run(['base-health'], gh(root, { runs: [] })).verdict, 'UNKNOWN')
  void runDir
})

test('base_health gate: stacked runs must ask, and a red base must be written up', () => {
  const { root, repo, run, runDir, home } = started('base-gate-repo')
  void home
  const ctx = () => ({
    runDir, repoDir: repo.dir, profile: { conventions: { base_branch: 'master' } },
    state: readRunState(runDir), stageDef: { output: 'artifacts/04-test-report.md' }, stageName: 'TEST', config: {}
  })
  assert.equal(validators.base_health(ctx()).ok, true, 'trunk-based run owes nothing')

  repo.git('branch', 'feature/base')
  run(['set-base', 'feature/base'])
  let r = validators.base_health(ctx())
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /pipeline base-health/)

  const tip = repo.git('rev-parse', 'feature/base').trim()
  run(['base-health'], gh(root, { runs: [{ headSha: tip, workflowName: 'RSpec', status: 'completed', conclusion: 'failure', url: 'https://ci/1' }] }))
  completeArtifact(runDir, 'artifacts/04-test-report.md', 'R-1', 'TEST', { Deferred: 'None.' })
  r = validators.base_health(ctx())
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /## Base health/)

  completeArtifact(runDir, 'artifacts/04-test-report.md', 'R-1', 'TEST', { 'Base health': 'spec/x_spec.rb fails on the base too: https://ci/1', Deferred: 'None.' })
  assert.equal(validators.base_health(ctx()).ok, true)
})

test('reconcile keeps a set-base made after the run was created', () => {
  const { repo, run, runDir } = started('rebase-repo')
  repo.git('branch', 'feature/base')
  run(['set-base', 'feature/base'])
  fs.rmSync(path.join(runDir, 'state.json'))
  run(['status'])
  assert.equal(readRunState(runDir).git.base, 'feature/base')
})

// A pilot run: a decision reversed after the PR opened left the plan
// and the PR body describing the old behaviour for a whole review round.
test('decision-changed: recorded in the plan, required in the draft, re-published to an open PR', () => {
  const { repo, run, runDir } = started('decision-repo')
  const ctx = output => ({
    runDir, repoDir: repo.dir, profile: {}, state: readRunState(runDir),
    stageDef: { output }, stageName: 'X', config: {}
  })
  completeArtifact(runDir, 'artifacts/02-plan.md', 'R-1', 'PLAN', { Amendments: 'None.' })
  const draft = desc => completeArtifact(runDir, 'artifacts/06-pr-draft.md', 'R-1', 'PR', { Description: desc })
  draft('Every configured item qualifies for the review.')
  assert.equal(validators.decisions_current(ctx('artifacts/06-pr-draft.md')).ok, true, 'nothing changed, nothing owed')
  assert.equal(validators.pr_body_current(ctx('artifacts/07-ci-analysis.md')).ok, true)

  run(['pr-opened', 'https://github.com/acme/app/pull/12'])
  assert.equal(run(['decision-changed', '--was', 'x']).verdict, 'ERROR')
  const r = run(['decision-changed', '--was', 'every configured item qualifies', '--now', 'only items with the feature enabled qualify', '--reason', 'PM ruling'])
  assert.equal(r.verdict, 'OK')
  assert.equal(r.pr, 12)
  assert.ok(r.next_steps.some(s => /gh pr edit 12/.test(s)))
  assert.match(fs.readFileSync(path.join(runDir, 'artifacts/02-plan.md'), 'utf8'),
    /Decision changed: was "every configured item qualifies" → now "only items with the feature enabled qualify" — PM ruling/)

  let v = validators.decisions_current(ctx('artifacts/06-pr-draft.md'))
  assert.equal(v.ok, false)
  assert.match(v.reasons[0], /does not say "only items with the feature enabled qualify"/)
  draft('Only items with **the feature enabled** qualify for the review.')
  assert.equal(validators.decisions_current(ctx('artifacts/06-pr-draft.md')).ok, true, 'emphasis and case ignored')

  v = validators.pr_body_current(ctx('artifacts/07-ci-analysis.md'))
  assert.equal(v.ok, false, 'the published PR predates the change')
  assert.match(v.reasons[0], /PR #12 was published before .*gh pr edit 12/)
  run(['pr-opened', 'https://github.com/acme/app/pull/12'])
  assert.equal(validators.pr_body_current(ctx('artifacts/07-ci-analysis.md')).ok, true, 're-published after the change')
})
