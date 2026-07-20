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
    { event: 'check_skipped', stage: 'IMPLEMENT', reason: "slot 'test_targeted' is empty for this repo — recorded as UNVERIFIED" },
    { event: 'feedback', note: 'plan was solid' }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.critic_rounds, 2)
  assert.equal(m.agents_spawned, 2)
  assert.equal(m.checks_skipped, 1)
  assert.equal(m.checks_skipped_no_command, 1, 'empty-slot skip counts as a real gap')
  assert.equal(m.feedback_notes, 1)
})

test('critic_rounds falls back to critic agent spawns when substate was not recorded (MB-46498)', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'agent_spawned', stage: 'PLAN', label: 'plan-draft' },
    { event: 'agent_spawned', stage: 'PLAN', label: 'plan-critic-r1' },
    { event: 'agent_spawned', stage: 'PLAN', label: 'plan-critic-r2' },
    { event: 'agent_spawned', stage: 'IMPLEMENT', label: 'implement-st1' }
    // note: NO substate critic_round events — the dispatcher forgot to record them
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.critic_rounds, 2, 'derived from the two critic agent spawns, not the missing substate')
  assert.deepEqual(m.agents_by_label, { 'plan-draft': 1, 'plan-critic': 2, implement: 1 })
})

test('checks_skipped splits real gaps (no command) from benign no-target skips', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'check_skipped', stage: 'IMPLEMENT', reason: "slot 'test_targeted': not applicable to this change — the changed files map to no test_targeted target. Expected for config/view/spec-only changes; recorded as UNVERIFIED" },
    { event: 'check_skipped', stage: 'TEST', reason: "profile slot 'lint_changed' is empty for this repo — recorded as UNVERIFIED" }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.checks_skipped, 2)
  assert.equal(m.checks_skipped_no_command, 1, 'the empty-slot one is a real gap')
  assert.equal(m.checks_skipped_no_target, 1, 'the no-matching-files one is benign bookkeeping')
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
