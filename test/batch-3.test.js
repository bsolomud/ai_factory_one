import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { guard } from '../src/guard.js'
import { appendEvent, newState, readState, writeState } from '../src/state.js'
import { validators } from '../src/validators.js'
import { cli, completeArtifact, installProfile, sandbox, standardRepo, STANDARD_PROFILE, writeFile } from './helpers.js'

function started(name, profile = STANDARD_PROFILE) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, profile)
  const run = (args, env) => cli(args, { home, cwd: repo.dir, env })
  run(['new-run', 'R-1'])
  return { root, home, repo, slug, run, runDir: path.join(home, 'repos', slug, 'runs', 'R-1') }
}

const SCRIBE = { 'Plan-vs-shipped': 'Matches.', Learnings: 'None new.', Routing: 'None.' }
const toStage = (runDir, stage) => { const s = readState(runDir); s.stage = stage; s.stage_status = 'in_progress'; writeState(runDir, s) }

test('--help never runs the command', () => {
  const { run, runDir } = started('help-repo')
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
  assert.equal(run(['advance', '--help']).verdict, 'HELP')
  assert.equal(run(['abort', '-h']).verdict, 'HELP')
  assert.equal(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), before, 'nothing recorded')
})

test('advance on a stage whose artifact is still the template says so in one line', () => {
  const { run } = started('notstarted-repo')
  const r = run(['advance'])
  assert.equal(r.verdict, 'NOT_STARTED')
  assert.match(r.note, /has not been worked on yet/)
})

// A pilot run re-ran TEST, REVIEW and PR in full over a byte-identical tree.
test('recertify restores a reset stage only when its code and artifact are what it certified', () => {
  const { repo, run, runDir } = started('recert-repo')
  toStage(runDir, 'SCRIBE')
  completeArtifact(runDir, 'artifacts/08-retro.md', 'R-1', 'SCRIBE', SCRIBE)
  assert.equal(run(['advance']).verdict, 'GATE')
  assert.equal(run(['reopen', 'CI', '--reason', 'a decision was reworded']).verdict, 'REOPENED')
  toStage(runDir, 'SCRIBE') // back on the way forward
  assert.match(fs.readFileSync(path.join(runDir, 'artifacts/08-retro.md'), 'utf8'), /status: draft/)
  const r = run(['recertify'])
  assert.equal(r.verdict, 'RECERTIFIED')
  assert.match(fs.readFileSync(path.join(runDir, 'artifacts/08-retro.md'), 'utf8'), /status: complete/)
  assert.equal(run(['advance']).verdict, 'GATE', 'its checks still run and its gate is still owed')

  run(['reopen', 'CI']); toStage(runDir, 'SCRIBE')
  repo.write('src/app.sh', 'echo changed\n')
  assert.equal(run(['recertify']).verdict, 'CHANGED', 'the code moved: the stage is redone')
})

test('agent ceiling grows with each PR round and warns at 80%', () => {
  const { run } = started('ceiling-repo', STANDARD_PROFILE + 'limits: { max_agents_per_run: 5, agents_per_pr_round: 5 }\n')
  for (let i = 0; i < 3; i++) assert.equal(run(['agent-start', `a${i}`]).warning, undefined)
  assert.match(run(['agent-start', 'a3']).warning, /4 of 5 agents used/)
  run(['agent-start', 'a4'])
  assert.equal(run(['agent-start', 'a5']).verdict, 'BLOCKED')
  run(['round', 'open', 'pr', '--ref', 'https://example.com/acme/app/pull/77']); run(['round', 'close'])
  const r = run(['agent-start', 'a5'])
  assert.equal(r.verdict, 'OK')
  assert.equal(r.ceiling, 10)
})

// Four proposals: the knowledge store read as dead weight while its probes were in every plan.
test('a learned probe re-run by a passing Coupling table is recorded as used; used refs are normalized', () => {
  const { home, run, runDir, slug } = started('ledger-repo')
  writeFile(path.join(home, 'repos', slug, 'knowledge'), 'sibling-writers.md', [
    '---', 'probe:', '  - when: ["src/**"]', '    run: "git grep -n app-v1 -- src"', '    asks: "who else writes this greeting?"', '---', '# x', ''
  ].join('\n'))
  toStage(runDir, 'SCRIBE')
  completeArtifact(runDir, 'artifacts/08-retro.md', 'R-1', 'SCRIBE', { ...SCRIBE, Coupling: '| Subject | Evidence command | Hits | Disposition |\n|---|---|---|---|\n| greeting | `git grep -n app-v1 -- src` | 1 | fine |' })
  assert.equal(run(['advance']).verdict, 'GATE')
  const used = () => fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e => e.event === 'asset_used')
  assert.deepEqual(used().map(e => [e.kind, e.ref, e.source]), [['knowledge', 'sibling-writers', 'coupling']])

  assert.deepEqual(run(['used', 'knowledge', './knowledge/sibling-writers.md']).recorded, [{ kind: 'knowledge', ref: 'sibling-writers' }])
  assert.deepEqual(run(['used', 'doc', 'doc/a.md, doc/b.md']).recorded.map(r => r.ref), ['doc/a.md', 'doc/b.md'])
})

test('secret scan: a plain-word fixture in a test file passes; a file can be cleared for the run', () => {
  const { repo, run, runDir } = started('secret-repo')
  const ctx = () => ({ runDir, repoDir: repo.dir, profile: {}, state: readState(runDir), stageDef: {}, stageName: 'IMPLEMENT' })
  repo.write('tests/hold_test.sh', "hold token: 'window-alpha'\n")
  assert.equal(validators.no_secrets(ctx()).ok, true, 'a fixture word is not a secret')
  repo.write('src/conf.sh', "api_key: 'Zq81kPx0vT3mN7'\n")
  const v = validators.no_secrets(ctx())
  assert.equal(v.ok, false)
  assert.match(v.reasons[0], /pipeline allow-secret src\/conf\.sh/)
  assert.equal(run(['allow-secret', 'src/conf.sh']).verdict, 'ERROR', 'a reason is required')
  run(['allow-secret', 'src/conf.sh', '--reason', 'documented sandbox key'])
  assert.equal(validators.no_secrets(ctx()).ok, true)
})

test('a command stopped by its timeout is reported as a timeout, and a command can carry its own', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'timeout-repo')
  repo.write('src/app.sh', 'echo v2\n')
  const ctx = { runDir: path.join(root, 'run'), repoDir: repo.dir, state: newState({ runId: 'T-1', repo: 'r', stage: 'IMPLEMENT' }), stageDef: {}, stageName: 'IMPLEMENT',
    profile: { commands: { lint_changed: [{ run: 'sleep 5; echo {changed_files}', timeout: 1 }] } } }
  const v = validators.profile_command(ctx, 'lint_changed')
  assert.equal(v.ok, false)
  assert.match(v.reasons[0], /TIMED OUT after 1s \(it did not fail/)
})

test('guard: a block names the run whose rules applied', () => {
  const { root, home } = sandbox()
  process.env.AI_FACTORY_HOME = home
  const repo = standardRepo(root, 'g-name-repo')
  installProfile(home, 'example.com-test-g-name-repo', STANDARD_PROFILE)
  const runDir = path.join(home, 'repos', 'example.com-test-g-name-repo', 'runs', 'N-1')
  writeState(runDir, newState({ runId: 'N-1', repo: 'r', stage: 'IMPLEMENT' }))
  appendEvent(runDir, { event: 'run_created', run: 'N-1' })
  fs.mkdirSync(path.join(home, 'active-sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'active-sessions', 's1'), 'x\n')
  const r = guard('bash', { cwd: repo.dir, session_id: 's1', tool_input: { command: 'git push origin HEAD' } })
  assert.equal(r.decision, 'deny')
  assert.match(r.message, /^\[run N-1\] /)
})
