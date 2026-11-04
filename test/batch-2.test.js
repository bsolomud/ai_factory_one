import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { guard } from '../src/guard.js'
import { substitute } from '../src/profile.js'
import { readState } from '../src/state.js'
import { validators } from '../src/validators.js'
import { cli, completeArtifact, installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

function started(name, profile = STANDARD_PROFILE) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, profile)
  const run = (args, env) => cli(args, { home, cwd: repo.dir, env })
  return { root, home, repo, slug, run, runDir: id => path.join(home, 'repos', slug, 'runs', id) }
}

// Two strikes: a ticket that shipped outside its run, and a superseded run
// that stayed open, both read as plain "aborted".
test('abort says how the run ended; metrics count outcomes and the time of the stage it ended in', () => {
  const { run, runDir } = started('abort-repo')
  run(['new-run', 'TK-1'])
  assert.match(run(['abort', '--run', 'TK-1']).error, /--outcome <abandoned\|superseded/)
  run(['new-run', 'TK-1-retry'])
  assert.match(run(['abort', '--run', 'TK-1', '--outcome', 'superseded']).error, /needs --by/)
  const a = run(['abort', '--run', 'TK-1', '--outcome', 'superseded', '--by', 'TK-1-retry', '--reason', 'restarted with a worktree', '--no-harvest', 'restart'])
  assert.equal(a.outcome, 'superseded')
  const st = readState(runDir('TK-1'))
  assert.equal(st.outcome, 'superseded')
  assert.equal(st.superseded_by, 'TK-1-retry')

  const m = run(['metrics', '--run', 'TK-1'])
  assert.equal(m.outcome, 'superseded')
  const agg = run(['metrics'])
  assert.equal(agg.summary.outcomes.superseded, 1)
})

test('new-run names another open run for the same ticket, so it can be closed as superseded', () => {
  const { run } = started('same-ticket-repo')
  run(['new-run', 'ABC-77'])
  const r = run(['new-run', 'ABC-77-rework'])
  assert.deepEqual(r.open_runs_same_ticket, ['ABC-77'])
  assert.match(r.ask, /pipeline abort --run <old> --outcome superseded --by ABC-77-rework/)
  assert.equal(run(['new-run', 'ABC-78']).open_runs_same_ticket, undefined)
})

test('guard: a run idle for a week is parked — it no longer claims the session, unless the session works in its worktree', () => {
  const { home, repo, run, runDir } = started('parked-repo')
  process.env.AI_FACTORY_HOME = home
  run(['new-run', 'P-1'])
  fs.mkdirSync(path.join(home, 'active-sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'active-sessions', 's1'), 'x\n')
  const observe = () => guard('observe', { cwd: repo.dir, session_id: 's1', tool_name: 'Skill', tool_input: { skill: 'x' } })
  const events = () => fs.readFileSync(path.join(runDir('P-1'), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length
  const before = events()
  observe()
  assert.ok(events() > before, 'an active run collects the session\'s usage')
  const old = (Date.now() - 8 * 24 * 3600e3) / 1000
  fs.utimesSync(path.join(runDir('P-1'), 'events.jsonl'), old, old)
  const parked = events()
  observe()
  assert.equal(events(), parked, 'a parked run does not')
})

test('worktree runs get their own environment number, in commands and in reconcile; removal frees it', () => {
  const profile = STANDARD_PROFILE.replace('commands:', 'commands:\n  worktree_setup: "createdb app_test{env_number}"')
  const { run, runDir } = started('env-repo', profile)
  const a = run(['new-run', 'E-1', '--worktree'])
  assert.equal(a.env_number, 1)
  assert.deepEqual(a.worktree_setup, ['createdb app_test1'])
  assert.equal(run(['new-run', 'E-2', '--worktree']).env_number, 2)
  assert.equal(run(['status', '--run', 'E-2']).env_number, 2)

  assert.equal(substitute('rspec {targeted_specs} -e {env_number}', { tests: ['a_spec.rb'], envNumber: 3 }).cmd, "rspec 'a_spec.rb' -e 3")
  assert.equal(substitute('db{env_number}', {}).cmd, 'db', 'outside a worktree run: the default environment')

  fs.rmSync(path.join(runDir('E-1'), 'state.json'))
  assert.equal(run(['status', '--run', 'E-1']).env_number, 1, 'a lost state is rebuilt with it, from the worktree_created event')

  const removed = run(['worktree', 'remove', '--run', 'E-1', '--force'])
  assert.equal(removed.verdict, 'OK')
  assert.equal(readState(runDir('E-1')).env_number, null)
  assert.equal(run(['new-run', 'E-3', '--worktree']).env_number, 1, 'the freed number is reused')
  const again = run(['worktree', 'add', '--run', 'E-1'])
  assert.equal(again.setup_required, true)
  assert.equal(again.env_number, 3)
  assert.match(again.note, /this tree is new/)
})

// Five strikes on wording; among them identifiers the developer had never seen.
test('plain_language: a code term in the developer\'s half is explained in brackets at least once', () => {
  const { root } = sandbox()
  const runDir = path.join(root, 'run')
  const ctx = { runDir, stageDef: { output: 'artifacts/01-context.md' }, stageName: 'CONTEXT' }
  const write = text => completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', { "What we're doing": text, Findings: 'f' })
  write('The import fails when `retries_exhausted` is set, and Rails.logger shows nothing. Acme and GitHub are fine; see github.com.')
  const v = validators.plain_language(ctx)
  assert.equal(v.ok, false)
  assert.match(v.reasons.at(-1), /2 code term\(s\).*'retries_exhausted', 'Rails.logger'/)
  write('The import fails when `retries_exhausted` (the job gave up after its last retry) is set; Rails.logger (the app log) shows nothing, and retries_exhausted stays set.')
  assert.equal(validators.plain_language(ctx).ok, true)
})

test('metrics: the stage a run was aborted in keeps its time', async () => {
  const { runMetrics } = await import('../src/metrics.js')
  const t = m => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString()
  const { root } = sandbox()
  fs.writeFileSync(path.join(root, 'events.jsonl'), [
    { event: 'run_created', at: t(0) },
    { event: 'advanced', from: 'CONTEXT', to: 'PLAN', at: t(10) },
    { event: 'run_aborted', from: 'PLAN', outcome: 'merged-outside-run', at: t(40) }
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const m = runMetrics(root, 'X-1')
  assert.deepEqual(m.seconds_by_stage, { CONTEXT: 600, PLAN: 1800 })
  assert.equal(m.outcome, 'merged-outside-run')
})
