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

// --- P3: honest signal at small N ---

test('aggregate flags low_sample and caveats the note below the trend threshold', () => {
  const one = aggregate([{ first_pass_green_rate: 1, gate_edit_rate: 0, gates_approved: 3, gate_edits: 0, blocked_total: 0, agents_spawned: 4, feedback_notes: 1 }])
  assert.equal(one.low_sample, true)
  assert.match(one.note, /anecdotal|NOT a trend/i)

  const many = aggregate(Array.from({ length: 3 }, () => ({ first_pass_green_rate: 1, gate_edit_rate: 0, gates_approved: 1, gate_edits: 0, blocked_total: 0, agents_spawned: 1, feedback_notes: 0 })))
  assert.equal(many.low_sample, false)
  assert.doesNotMatch(many.note, /anecdotal/i)
})

// --- P3: optional-slot skip bucket ---

test('checks_skipped: optional not-configured slot is its own bucket, not a coverage gap', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'check_skipped', stage: 'IMPLEMENT', reason: "optional slot 'post_change_hooks' is not configured for this repo — not applicable, recorded as UNVERIFIED (not a coverage gap)" },
    { event: 'check_skipped', stage: 'TEST', reason: "profile slot 'lint_changed' is empty for this repo — recorded as UNVERIFIED (a real coverage gap)" }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.checks_skipped, 2)
  assert.equal(m.checks_skipped_no_command, 1, 'the empty required slot is a real gap')
  assert.equal(m.checks_skipped_not_configured, 1, 'the optional slot is quietly not-configured')
  assert.equal(m.checks_skipped_no_target, 0)
})

test('checks_skipped: a source-with-no-spec skip counts as a real coverage gap', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'check_skipped', stage: 'IMPLEMENT', reason: "slot 'test_targeted': source files changed with NO mirror spec: src/util.rb — add a spec; recorded as UNVERIFIED (possible coverage gap)" }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.checks_skipped_no_command, 1, 'a missing-spec gap is not benign bookkeeping')
})

// --- P4: rework signal ---

test('rework_cycles and stage_reentries surface backtracking (reopened events)', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'validated', stage: 'CONTEXT' },
    { event: 'advanced', from: 'CONTEXT', to: 'PLAN' },
    { event: 'validated', stage: 'PLAN' },
    { event: 'advanced', from: 'PLAN', to: 'IMPLEMENT' },
    { event: 'advanced', from: 'IMPLEMENT', to: 'PR' },
    // late fix at PR reopens IMPLEMENT, then re-advances back through to PR
    { event: 'reopened', from: 'PR', to: 'IMPLEMENT' },
    { event: 'advanced', from: 'IMPLEMENT', to: 'PR' }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.rework_cycles, 1, 'one reopen')
  assert.equal(m.stage_reentries, 2, 'IMPLEMENT entered twice and PR entered twice → 2 extra entries')
})

test('a clean run has zero rework', () => {
  const { root } = sandbox()
  const runDir = eventsRun(root, [
    { event: 'run_created', run: 'R', base: 'master' },
    { event: 'validated', stage: 'CONTEXT' },
    { event: 'advanced', from: 'CONTEXT', to: 'PLAN' },
    { event: 'advanced', from: 'PLAN', to: 'DONE' }
  ])
  const m = runMetrics(runDir, 'R')
  assert.equal(m.rework_cycles, 0)
  assert.equal(m.stage_reentries, 0)
})
