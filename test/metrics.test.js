import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { aggregate, runMetrics } from '../src/metrics.js'
import { appendEvent } from '../src/state.js'
import { sandbox } from './helpers.js'

// Build a synthetic events.jsonl and assert the derived numbers. (Timestamps
// come from appendEvent's own clock; we assert counts/rates, not durations.)
function eventsRun(root, seq) {
  const runDir = path.join(root, 'run')
  for (const e of seq) appendEvent(runDir, e)
  return runDir
}

test('first_pass_green_rate: a stage with a BLOCKED retry is not first-pass', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    // CONTEXT: clean
    { event: 'validated', stage: 'CONTEXT' },
    { event: 'gate_approved', stage: 'CONTEXT', by: 'human' },
    { event: 'advanced', from: 'CONTEXT', to: 'PLAN' },
    // PLAN: one block then pass → NOT first-pass
    { event: 'blocked', stage: 'PLAN', reasons: 2 },
    { event: 'validated', stage: 'PLAN' },
    { event: 'gate_approved', stage: 'PLAN', by: 'human', edited: true },
    { event: 'advanced', from: 'PLAN', to: 'BREAKDOWN' }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.stages_first_pass_green, 1, 'only CONTEXT was first-pass')
  assert.equal(m.first_pass_green_rate, 0.5, '1 of 2 validated stages')
  assert.equal(m.blocked_total, 1)
  assert.deepEqual(m.blocked_by_stage, { PLAN: 1 })
  assert.equal(m.gates_approved, 2)
  assert.equal(m.gate_edits, 1)
  assert.equal(m.gate_edit_rate, 0.5)
})

test('counts critic rounds, agents, feedback, skipped checks', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'agent_spawned', stage: 'PLAN', label: 'planner' },
    { event: 'substate', key: 'critic_round', value: 1 },
    { event: 'agent_spawned', stage: 'PLAN', label: 'critic' },
    { event: 'substate', key: 'critic_round', value: 2 },
    { event: 'check_skipped', stage: 'IMPLEMENT', reason: 'no test cmd' },
    { event: 'feedback', note: 'plan was solid' }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.critic_rounds, 2)
  assert.equal(m.agents_spawned, 2)
  assert.equal(m.checks_skipped, 1)
  assert.equal(m.feedback_notes, 1)
})

test('aggregate averages the headline rates across runs', () => {
  const agg = aggregate([
    { first_pass_green_rate: 1, gate_edit_rate: 0, gates_approved: 3, gate_edits: 0, blocked_total: 0, agents_spawned: 4, feedback_notes: 1 },
    { first_pass_green_rate: 0.5, gate_edit_rate: 0.5, gates_approved: 4, gate_edits: 2, blocked_total: 3, agents_spawned: 6, feedback_notes: 2 }
  ])
  assert.equal(agg.runs, 2)
  assert.equal(agg.mean_first_pass_green_rate, 0.75)
  assert.equal(agg.mean_gate_edit_rate, 0.25)
  assert.equal(agg.total_gate_edits, 2)
  assert.equal(agg.total_agents_spawned, 10)
})
