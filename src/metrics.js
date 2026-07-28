import { readEvents } from './state.js'

// Turn a run's append-only events.jsonl into the numbers a pilot needs to
// judge effectiveness. Everything here is derived from recorded facts — no
// self-reported guesses. The load-bearing metric is first_pass_green_rate
// (stages that passed validators with zero BLOCKED retries) and
// gate_edit_rate (how often the developer had to change an artifact before
// approving — the clearest proxy for AI output quality).

export function runMetrics(runDir, runId) {
  const events = readEvents(runDir)
  const at = e => Date.parse(e.at)
  const start = events[0] ? at(events[0]) : null
  const end = events.length ? at(events[events.length - 1]) : null

  // Walk stage instances: a stage is "entered" at run_created (first stage) or
  // at the advanced event whose `to` is it, and "left" at the advanced whose
  // `from` is it. Blocked events in between count against first-pass.
  const stages = {}
  let currentStage = null
  let enteredAt = start
  const ensure = name => (stages[name] ??= { blocked: 0, retries: 0, ms: 0, first_pass: null, reached_validate: false, entries: 0 })

  for (const e of events) {
    if (e.event === 'run_created') { currentStage = firstStageFromEvents(events); enteredAt = at(e); if (currentStage) ensure(currentStage).entries += 1 }
    else if (e.event === 'blocked') { const s = ensure(e.stage); s.blocked += 1; s.retries += 1 }
    else if (e.event === 'validated') { const s = ensure(e.stage); s.reached_validate = true; if (s.first_pass === null) s.first_pass = s.blocked === 0 }
    else if (e.event === 'advanced') {
      if (e.from && stages[e.from] && enteredAt != null) stages[e.from].ms += Math.max(0, at(e) - enteredAt)
      if (stages[e.from] && stages[e.from].first_pass === null) stages[e.from].first_pass = stages[e.from].blocked === 0
      currentStage = e.to
      enteredAt = at(e)
      if (e.to && e.to !== 'DONE') ensure(e.to).entries += 1
    }
    // A reopen re-enters an earlier stage (rework). Count the extra entry so a
    // stage that had to be redone is visible, and reset its first_pass judgment
    // so the redo has to earn green again.
    else if (e.event === 'reopened') {
      if (e.from && stages[e.from] && enteredAt != null) stages[e.from].ms += Math.max(0, at(e) - enteredAt)
      currentStage = e.to
      enteredAt = at(e)
      if (e.to) ensure(e.to).entries += 1
    }
  }

  const gates = events.filter(e => e.event === 'gate_approved')
  const validatedStages = Object.values(stages).filter(s => s.reached_validate)
  const firstPass = validatedStages.filter(s => s.first_pass === true).length

  const spawns = events.filter(e => e.event === 'agent_spawned')
  const skips = events.filter(e => e.event === 'check_skipped')
  // Classify skips so a real UNVERIFIED isn't diluted (MB-46498 retro):
  //  - real coverage gap: a REQUIRED slot is empty, OR source changed with no
  //    mirror spec ("possible coverage gap") — these should worry a pilot.
  //  - not_configured: an OPTIONAL slot (e.g. post_change_hooks) isn't set —
  //    quiet, not a gap.
  //  - no_target: "command exists but resolved to no matching files" (config/
  //    view/spec-only subtask) — expected bookkeeping.
  const reasonOf = e => e.reason || ''
  const notConfiguredSkips = skips.filter(e => /not configured/i.test(reasonOf(e))).length
  const noCommandSkips = skips.filter(e => /slot .* is empty|no .* command|possible coverage gap/i.test(reasonOf(e))).length

  return {
    run: runId,
    duration_s: start != null && end != null ? Math.round((end - start) / 1000) : null,
    stages_entered: Object.keys(stages).length,
    stages_first_pass_green: firstPass,
    first_pass_green_rate: validatedStages.length ? round(firstPass / validatedStages.length) : null,
    blocked_total: sum(Object.values(stages).map(s => s.blocked)),
    blocked_by_stage: Object.fromEntries(Object.entries(stages).filter(([, s]) => s.blocked).map(([k, s]) => [k, s.blocked])),
    gates_approved: gates.length,
    gates_by: tally(gates.map(g => g.by || 'human')),
    gate_edits: gates.filter(g => g.edited).length,
    gate_edit_rate: gates.length ? round(gates.filter(g => g.edited).length / gates.length) : null,
    // Prefer recorded substate; fall back to counting critic agent spawns, so a
    // dispatcher that ran the critic but forgot `set-substate critic_round` still
    // reports the real engagement (MB-46498: critic ran 2 rounds, substate said 0).
    critic_rounds: Math.max(maxSubstate(events, 'critic_round'), spawns.filter(e => /critic/i.test(e.label || '')).length),
    agents_spawned: spawns.length,
    agents_by_label: tally(spawns.map(e => (e.label || 'agent').replace(/-?(r?\d+|st\d+)$/i, '') || 'agent')),
    checks_skipped: skips.length,
    checks_skipped_no_command: noCommandSkips,
    checks_skipped_not_configured: notConfiguredSkips,
    checks_skipped_no_target: skips.length - noCommandSkips - notConfiguredSkips,
    // Rework: how much the run had to backtrack. reopened events are explicit
    // backward moves (e.g. a late fix at PR reopening IMPLEMENT); stage_reentries
    // counts every entry into a stage beyond its first. High rework explains a
    // high agent count on a nominally small change (MB-46498: a PR-gate reopen).
    rework_cycles: events.filter(e => e.event === 'reopened').length,
    stage_reentries: sum(Object.values(stages).map(s => Math.max(0, s.entries - 1))),
    feedback_notes: events.filter(e => e.event === 'feedback').length,
    seconds_by_stage: Object.fromEntries(Object.entries(stages).filter(([, s]) => s.ms).map(([k, s]) => [k, Math.round(s.ms / 1000)]))
  }
}

// Sample size below which the mean rates are anecdote, not trend. Kept low
// because runs are expensive; three is enough to stop one lucky/unlucky run
// from reading as a quality signal.
const MIN_TREND_RUNS = 3

export function aggregate(runsMetrics) {
  const finished = runsMetrics.length
  const withGates = runsMetrics.filter(m => m.gates_approved > 0)
  const fpRates = runsMetrics.map(m => m.first_pass_green_rate).filter(r => r != null)
  const lowSample = finished < MIN_TREND_RUNS
  return {
    runs: finished,
    low_sample: lowSample,
    mean_first_pass_green_rate: mean(fpRates),
    mean_gate_edit_rate: mean(withGates.map(m => m.gate_edit_rate).filter(r => r != null)),
    total_gate_edits: sum(runsMetrics.map(m => m.gate_edits)),
    total_blocked: sum(runsMetrics.map(m => m.blocked_total)),
    total_agents_spawned: sum(runsMetrics.map(m => m.agents_spawned)),
    total_rework_cycles: sum(runsMetrics.map(m => m.rework_cycles || 0)),
    total_feedback_notes: sum(runsMetrics.map(m => m.feedback_notes)),
    note: lowSample
      ? `only ${finished} finished run(s) — the mean rates below are anecdotal, NOT a trend; don't read a single run as a quality signal. Need ${MIN_TREND_RUNS}+ runs.`
      : 'first_pass_green_rate and gate_edit_rate are the headline quality signals; low edit + high first-pass = the AI is producing trustworthy artifacts.'
  }
}

function firstStageFromEvents(events) {
  const firstAdvance = events.find(e => e.event === 'advanced')
  // The stage we started in is the `from` of the first advance, else unknown.
  return firstAdvance?.from ?? null
}
function maxSubstate(events, key) {
  return events.filter(e => e.event === 'substate' && e.key === key).reduce((m, e) => Math.max(m, e.value || 0), 0)
}
const sum = xs => xs.reduce((a, b) => a + b, 0)
const round = n => Math.round(n * 100) / 100
const mean = xs => (xs.length ? round(sum(xs) / xs.length) : null)
const tally = xs => xs.reduce((acc, x) => ((acc[x] = (acc[x] || 0) + 1), acc), {})
