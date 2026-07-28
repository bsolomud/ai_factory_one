import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { guard, main } from '../src/guard.js'
import { newState, writeState } from '../src/state.js'
import { installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// The default session used by the enforcement tests. Enforcement is opt-in per
// session, so these tests simulate a session that already engaged /pipeline.
const SESSION = 'sess-9'

// guard() is pure over (mode, hook-input, disk); AI_FACTORY_HOME points it at the sandbox.
function setup({ stage = 'PLAN', gates = [], engaged = true } = {}) {
  const { root, home } = sandbox()
  process.env.AI_FACTORY_HOME = home
  const repo = standardRepo(root, 'g-repo')
  const slug = 'example.com-test-g-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const runDir = path.join(home, 'repos', slug, 'runs', 'T-9')
  const state = newState({ runId: 'T-9', repo: slug, stage })
  state.gates = gates
  writeState(runDir, state)
  if (engaged) {
    fs.mkdirSync(path.join(home, 'active-sessions'), { recursive: true })
    fs.writeFileSync(path.join(home, 'active-sessions', SESSION), 'x\n')
  }
  return { repo, runDir, home }
}

const bash = (repo, command) => guard('bash', { cwd: repo.dir, session_id: SESSION, tool_input: { command } })
const write = (repo, file_path) => guard('write', { cwd: repo.dir, session_id: SESSION, tool_input: { file_path } })
const bashAs = (repo, session_id, command) => guard('bash', { cwd: repo.dir, session_id, tool_input: { command } })

test('fail open: not a git repo / no profile / no active run / broken stdin', () => {
  const { root, home } = sandbox()
  process.env.AI_FACTORY_HOME = home
  assert.equal(guard('bash', { cwd: root, tool_input: { command: 'git push' } }).decision, 'allow', 'not a repo')

  const repo = standardRepo(root, 'plain-repo')
  assert.equal(bash(repo, 'git push').decision, 'allow', 'no profile → normal Claude usage untouched')

  installProfile(home, 'example.com-test-plain-repo', STANDARD_PROFILE)
  assert.equal(bash(repo, 'git push').decision, 'allow', 'profile but no active run → allow')

  const result = main(['bash'], '{{{not json')
  assert.equal(result.exitCode, 0, 'unparseable hook input → fail open')
})

test('pipeline approve is allowed (chat-confirmed contract lives in the skill, audited in events)', () => {
  const { repo } = setup({ stage: 'IMPLEMENT' })
  const result = bash(repo, 'cd x && ~/.ai_factory_one/bin/pipeline approve --note "confirmed in chat"')
  assert.equal(result.decision, 'allow')
})

test('git push denied before PR gate, allowed after', () => {
  const { repo } = setup({ stage: 'IMPLEMENT' })
  const denied = bash(repo, 'git push origin HEAD')
  assert.equal(denied.decision, 'deny')
  assert.match(denied.message, /PR-stage gate/)

  const { repo: repo2 } = setup({ stage: 'PR', gates: [{ stage: 'PR', approved: true, by: 'human', at: 'x', note: '' }] })
  assert.equal(bash(repo2, 'git push origin HEAD').decision, 'allow')

  const { repo: repo3 } = setup({ stage: 'CI' })
  assert.equal(bash(repo3, 'git push').decision, 'allow', 'CI loop pushes approved fixes')
})

test('git commit only in implementation stages', () => {
  const { repo } = setup({ stage: 'PLAN' })
  assert.equal(bash(repo, 'git commit -m x').decision, 'deny')
  const { repo: repo2 } = setup({ stage: 'IMPLEMENT' })
  assert.equal(bash(repo2, 'git commit -m x').decision, 'allow')
  assert.equal(bash(repo2, 'git status').decision, 'allow', 'unrelated commands untouched')
})

test('writes: state files always denied; repo writes stage-dependent; no_touch absolute', () => {
  const { repo, runDir } = setup({ stage: 'PLAN' })
  assert.match(guard('write', { cwd: repo.dir, session_id: SESSION, tool_input: { file_path: path.join(runDir, 'state.json') } }).message, /CLI/)
  assert.equal(guard('write', { cwd: repo.dir, session_id: SESSION, tool_input: { file_path: path.join(runDir, 'artifacts/02-plan.md') } }).decision, 'allow', 'artifacts are the stage output')
  assert.match(write(repo, 'src/app.sh').message, /not allowed during the PLAN stage/)

  const { repo: repo2 } = setup({ stage: 'IMPLEMENT' })
  assert.equal(write(repo2, 'src/app.sh').decision, 'allow')
  assert.match(write(repo2, 'locked/keep.txt').message, /no_touch/)
})

// --- opt-in: pipeline never enforces unless THIS session ran /pipeline ---

test('active run does NOT enforce in a session that never ran /pipeline', () => {
  const { repo } = setup({ stage: 'IMPLEMENT', engaged: false })
  // All of these would be denied in an engaged session; here they must pass.
  assert.equal(bashAs(repo, 'other-session', 'git push').decision, 'allow', 'push allowed — not engaged')
  assert.equal(bashAs(repo, 'other-session', 'git commit -m x').decision, 'allow', 'commit allowed — not engaged')
  assert.equal(guard('write', { cwd: repo.dir, session_id: 'other-session', tool_input: { file_path: 'src/app.sh' } }).decision, 'allow')
  // and with NO session_id at all → still fail open
  assert.equal(guard('bash', { cwd: repo.dir, tool_input: { command: 'git push' } }).decision, 'allow', 'missing session id → fail open')
})

test('mark: a /pipeline prompt engages the session; ordinary prompts do not', () => {
  const { repo } = setup({ stage: 'IMPLEMENT', engaged: false })
  guard('mark', { session_id: 'S1', prompt: 'please fix the bug in foo.rb' })
  assert.equal(bashAs(repo, 'S1', 'git push').decision, 'allow', 'ordinary prompt does not engage')
  guard('mark', { session_id: 'S1', prompt: '/pipeline work' })
  const denied = bashAs(repo, 'S1', 'git push')
  assert.equal(denied.decision, 'deny', 'now engaged → enforced')
  assert.match(denied.message, /PR-stage gate/)
})

test('unmark: session end clears enforcement', () => {
  const { repo } = setup({ stage: 'IMPLEMENT', engaged: false })
  guard('mark', { session_id: 'S2', prompt: '/pipeline start MB-1' })
  assert.equal(bashAs(repo, 'S2', 'git push').decision, 'deny', 'engaged → enforced')
  guard('unmark', { session_id: 'S2' })
  assert.equal(bashAs(repo, 'S2', 'git push').decision, 'allow', 'ended → no longer enforced')
})

test('mark/unmark fail open on missing or malformed session ids', () => {
  setup({ engaged: false })
  assert.equal(guard('mark', { prompt: '/pipeline work' }).decision, 'allow', 'no session id → no crash')
  assert.equal(guard('mark', { session_id: '../evil', prompt: '/pipeline work' }).decision, 'allow', 'path-traversal id rejected, not written')
  assert.equal(guard('unmark', {}).decision, 'allow')
})
