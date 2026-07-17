import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadPipeline } from '../src/config.js'
import { reconcile } from '../src/reconcile.js'
import { appendEvent, newState, writeState } from '../src/state.js'
import { completeArtifact, PACKAGE_ROOT, sandbox, standardRepo } from './helpers.js'

const config = loadPipeline(path.join(PACKAGE_ROOT, 'pipeline.yml'))

function scaffoldRun(root) {
  const runDir = path.join(root, 'run')
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true })
  appendEvent(runDir, { event: 'run_created', run: 'T-1', base: 'master' })
  return runDir
}

test('missing state.json: rebuilt at first stage when no artifacts exist', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  const { state, rebuilt, notes } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(rebuilt, true)
  assert.equal(state.stage, 'CONTEXT')
  assert.equal(state.stage_status, 'in_progress')
  assert.match(notes[0], /rebuilt from artifacts/)
})

test('rebuild: complete-but-unapproved artifact → awaiting_gate at that stage', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  const { state } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(state.stage, 'CONTEXT')
  assert.equal(state.stage_status, 'awaiting_gate')
})

test('rebuild: approved gate in events → next stage in_progress, gates restored', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  appendEvent(runDir, { event: 'gate_approved', stage: 'CONTEXT', by: 'human' })
  const { state } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(state.stage, 'PLAN')
  assert.equal(state.stage_status, 'in_progress')
  assert.equal(state.gates.length, 1)
  assert.equal(state.gates[0].stage, 'CONTEXT')
})

test('rebuild: substate counters restored from events', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  appendEvent(runDir, { event: 'substate', key: 'subtask', value: 2 })
  appendEvent(runDir, { event: 'substate', key: 'of', value: 3 })
  const { state } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(state.substate.subtask, 2)
  assert.equal(state.substate.of, 3)
})

test('corrupt state.json is replaced, not fatal', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  fs.writeFileSync(path.join(runDir, 'state.json'), 'not json at all')
  const { rebuilt } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(rebuilt, true)
})

test('crash between artifact completion and advance → "ready to advance" note', () => {
  const { root } = sandbox()
  const runDir = scaffoldRun(root)
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'CONTEXT' })
  writeState(runDir, state)
  completeArtifact(runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', { Requirements: 'r', 'Acceptance criteria': '1. works', Findings: 'f', 'Open questions': 'None.' })
  const { notes, rebuilt } = reconcile({ runDir, repoDir: null, config, runId: 'T-1', repoSlug: 'r' })
  assert.equal(rebuilt, false)
  assert.match(notes.join(' '), /stamped complete.*pipeline advance/)
})

test('IMPLEMENT: git wins — committed subtask vs interrupted subtask reported', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'rec-repo')
  repo.git('checkout', '-qb', 'T-1')
  const runDir = scaffoldRun(root)
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'IMPLEMENT' })
  state.substate.subtask = 1
  state.substate.of = 2
  writeState(runDir, state)

  let result = reconcile({ runDir, repoDir: repo.dir, config, runId: 'T-1', repoSlug: 'r' })
  assert.match(result.notes.join(' '), /interrupted mid-work/)

  repo.write('src/app.sh', 'echo v2\n')
  result = reconcile({ runDir, repoDir: repo.dir, config, runId: 'T-1', repoSlug: 'r' })
  assert.match(result.notes.join(' '), /uncommitted changes/)

  repo.git('add', '-A'); repo.git('commit', '-qm', 'subtask 1')
  result = reconcile({ runDir, repoDir: repo.dir, config, runId: 'T-1', repoSlug: 'r' })
  assert.match(result.notes.join(' '), /appears committed.*pipeline advance/)
})
