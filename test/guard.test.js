import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { guard, main } from '../src/guard.js'
import { newState, writeState } from '../src/state.js'
import { installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// guard() is pure over (mode, hook-input, disk); AI_PIPELINE_HOME points it at the sandbox.
function setup({ stage = 'PLAN', gates = [] } = {}) {
  const { root, home } = sandbox()
  process.env.AI_PIPELINE_HOME = home
  const repo = standardRepo(root, 'g-repo')
  const slug = 'example.com-test-g-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const runDir = path.join(home, 'repos', slug, 'runs', 'T-9')
  const state = newState({ runId: 'T-9', repo: slug, stage })
  state.gates = gates
  writeState(runDir, state)
  return { repo, runDir }
}

const bash = (repo, command) => guard('bash', { cwd: repo.dir, tool_input: { command } })
const write = (repo, file_path) => guard('write', { cwd: repo.dir, tool_input: { file_path } })

test('fail open: not a git repo / no profile / no active run / broken stdin', () => {
  const { root, home } = sandbox()
  process.env.AI_PIPELINE_HOME = home
  assert.equal(guard('bash', { cwd: root, tool_input: { command: 'git push' } }).decision, 'allow', 'not a repo')

  const repo = standardRepo(root, 'plain-repo')
  assert.equal(bash(repo, 'git push').decision, 'allow', 'no profile → normal Claude usage untouched')

  installProfile(home, 'example.com-test-plain-repo', STANDARD_PROFILE)
  assert.equal(bash(repo, 'git push').decision, 'allow', 'profile but no active run → allow')

  const result = main(['bash'], '{{{not json')
  assert.equal(result.exitCode, 0, 'unparseable hook input → fail open')
})

test('pipeline approve is human-only, in any stage', () => {
  const { repo } = setup({ stage: 'IMPLEMENT' })
  const result = bash(repo, 'cd x && ~/.ai-pipeline/bin/pipeline approve --note ok')
  assert.equal(result.decision, 'deny')
  assert.match(result.message, /human-only/)
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
  assert.match(guard('write', { cwd: repo.dir, tool_input: { file_path: path.join(runDir, 'state.json') } }).message, /CLI/)
  assert.equal(guard('write', { cwd: repo.dir, tool_input: { file_path: path.join(runDir, 'artifacts/02-plan.md') } }).decision, 'allow', 'artifacts are the stage output')
  assert.match(write(repo, 'src/app.sh').message, /not allowed during the PLAN stage/)

  const { repo: repo2 } = setup({ stage: 'IMPLEMENT' })
  assert.equal(write(repo2, 'src/app.sh').decision, 'allow')
  assert.match(write(repo2, 'locked/keep.txt').message, /no_touch/)
})
