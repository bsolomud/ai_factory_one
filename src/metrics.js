import path from 'node:path'
import { acAccounting, parseArtifact, sections, acceptanceCriteriaIds } from './artifacts.js'
import { artifactFor } from './config.js'
import { readEvents } from './state.js'

// Turn a run's append-only events.jsonl into the numbers a pilot needs to
// judge effectiveness. Everything here is derived from recorded facts — no
// self-reported guesses. The load-bearing metric is first_pass_green_rate
// (stages that passed validators with zero BLOCKED retries) and
// gate_edit_rate (how often the developer had to change an artifact before
// approving — the clearest proxy for AI output quality).

// config (the loaded pipeline.yml) locates the artifacts the artifact-derived
// metrics read — the same graph-driven discovery the validators use, so the
// gate and the metric can never disagree about WHICH file is the review or
// test report. Without config those metrics are omitted.
export function runMetrics(runDir, runId, config = null) {
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
  const gateEdits = gates.filter(g => g.edited).length
  const changeRequests = events.filter(e => e.event === 'change_requested').length
  const reopens = events.filter(e => e.event === 'reopened').length

  // THE pilot target, at last measurable. A round is one pass of feedback over
  // the shipped change; the ones that decide "can this close in two?" arrive
  // from outside the run (a reviewer on the PR, a red CI). Before this ledger
  // the only counter was human_rounds, which sees in-run corrections only — so
  // a run that took two PR rounds still reported a median of 0.
  const rounds = events.filter(e => e.event === 'round_opened')
  const findings = events.filter(e => e.event === 'finding_recorded')
  const externalRounds = rounds.filter(r => r.source !== 'pre-pr').length
  // The learning loop's own pass/fail: did this run's lessons get read? A
  // complete retro means SCRIBE ran; a harvest means an aborted run was still
  // mined. 18 of 29 pilot runs were aborted, and every one of them dropped its
  // learnings on the floor — which is the asymmetry that keeps rounds permanent.
  const harvested = events.some(e => e.event === 'harvest_pending' || e.event === 'harvest_skipped')
  const reachedScribe = events.some(e => e.event === 'advanced' && e.to === 'SCRIBE')

  const spawns = events.filter(e => e.event === 'agent_spawned')
  const skips = events.filter(e => e.event === 'check_skipped')
  // Classify skips so a real UNVERIFIED isn't diluted (pilot retro finding):
  //  - real coverage gap: a REQUIRED slot is empty, OR source changed with no
  //    mirror spec ("possible coverage gap") — these should worry a pilot.
  //  - not_configured: an OPTIONAL slot (e.g. post_change_hooks) isn't set —
  //    quiet, not a gap.
  //  - no_target: "command exists but resolved to no matching files" (config/
  //    view/spec-only subtask) — expected bookkeeping.
  // New events carry a machine `kind` from the validator itself; the regex is
  // ONLY the legacy fallback for events recorded before kinds existed (their
  // prose wording is frozen in old events.jsonl files) — never extend it.
  const kindOf = e => e.kind || (
    /not configured/i.test(e.reason || '') ? 'not_configured'
      : /slot .* is empty|no .* command|possible coverage gap/i.test(e.reason || '') ? 'no_command'
        : 'no_target')
  const notConfiguredSkips = skips.filter(e => kindOf(e) === 'not_configured').length
  const noCommandSkips = skips.filter(e => kindOf(e) === 'no_command').length
  const declaredNaSkips = skips.filter(e => kindOf(e) === 'declared_na').length

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
    gate_edits: gateEdits,
    gate_edit_rate: gates.length ? round(gateEdits / gates.length) : null,
    // THE pilot target ("1–3 rounds"): times a human had to CORRECT the work
    // after seeing it — an edited artifact at a gate, an explicit change
    // request, or a backward reopen. Deliberate touchpoints (answering the
    // context interview, approving a clean gate) are decisions, not rounds.
    human_rounds: gateEdits + changeRequests + reopens,
    change_requests: changeRequests,
    // rounds_to_merge = the delivery itself, plus every external round it took.
    // The target is ≤2. null while no round was ever recorded, so a run that
    // predates the ledger reads as "unmeasured" rather than as a perfect 1.
    rounds_to_merge: rounds.length ? externalRounds + 1 : null,
    rounds_by_source: tally(rounds.map(r => r.source)),
    findings_total: findings.length,
    findings_after_pr: findings.filter(f => f.source === 'pr').length,
    findings_by_class: tally(findings.map(f => f.class || 'other')),
    // Which probe WOULD have caught each finding. The distribution is the work
    // list: every name that is not 'none' is a probe the repo's store still owes.
    findings_missed_by: tally(findings.map(f => f.missed_by || 'unrecorded')),
    learnings_captured: reachedScribe || harvested,
    // Prefer recorded substate; fall back to counting critic agent spawns, so a
    // dispatcher that ran the critic but forgot `set-substate critic_round` still
    // reports the real engagement (seen in a pilot: critic ran 2 rounds, substate said 0).
    critic_rounds: Math.max(maxSubstate(events, 'critic_round'), spawns.filter(e => /critic/i.test(e.label || '')).length),
    agents_spawned: spawns.length,
    agents_by_label: tally(spawns.map(e => (e.label || 'agent').replace(/-?(r?\d+|st\d+)$/i, '') || 'agent')),
    checks_skipped: skips.length,
    checks_skipped_no_command: noCommandSkips,
    checks_skipped_not_configured: notConfiguredSkips,
    checks_skipped_declared_na: declaredNaSkips,
    checks_skipped_no_target: skips.length - noCommandSkips - notConfiguredSkips - declaredNaSkips,
    // Rework: how much the run had to backtrack. reopened events are explicit
    // backward moves (e.g. a late fix at PR reopening IMPLEMENT); stage_reentries
    // counts every entry into a stage beyond its first. High rework explains a
    // high agent count on a nominally small change (seen in a pilot: a PR-gate reopen).
    rework_cycles: reopens,
    stage_reentries: sum(Object.values(stages).map(s => Math.max(0, s.entries - 1))),
    feedback_notes: events.filter(e => e.event === 'feedback').length,
    // Which repo assets (knowledge facts, bound skills, docs) and MCP tools the
    // run's agents actually leaned on — cross-run rollup lives in `assets`.
    assets_used: tally(events.filter(e => e.event === 'asset_used').map(e => `${e.kind}: ${e.ref}`)),
    seconds_by_stage: Object.fromEntries(Object.entries(stages).filter(([, s]) => s.ms).map(([k, s]) => [k, Math.round(s.ms / 1000)])),
    ...(acCoverage(runDir, config) ?? {}),
    ...(reviewFindings(runDir, config) ?? {})
  }
}

// Both artifact-derived helpers locate their file via artifactFor(config, …)
// — never a directory scan, which could pick up a stray/backup file the
// validators would ignore.
const artifact = (runDir, config, suffix) => {
  const rel = artifactFor(config, suffix)
  return rel ? parseArtifact(path.join(runDir, rel)) : null
}

// Review effectiveness, from the review artifact's machine-readable
// frontmatter counts (declared by the reviewer, gated by review_counts).
function reviewFindings(runDir, config) {
  const f = artifact(runDir, config, '-review.md')?.frontmatter?.findings
  if (!f || typeof f !== 'object') return null
  return {
    review_findings_blocking: f.blocking ?? null,
    review_findings_advisory: f.advisory ?? null,
    review_findings_fixed: f.fixed ?? null,
    review_findings_disputed: f.disputed ?? null
  }
}

// AC coverage, derived from the artifacts themselves (also recorded facts on
// disk): the context defines the numbered criteria, the test report accounts
// for each as AC#<n> in its map or Deferred. null (omitted) until both exist.
function acCoverage(runDir, config) {
  const context = artifact(runDir, config, '-context.md')
  if (!context) return null
  const ids = acceptanceCriteriaIds(context.body)
  if (!ids.length) return null
  const secs = sections(artifact(runDir, config, '-test-report.md')?.body ?? '')
  const { tested, deferred } = acAccounting(ids, secs['Risk-to-test map'] ?? '', secs['Deferred'] ?? '')
  return { acs_total: ids.length, acs_tested: tested.length, acs_deferred: deferred.length }
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
  const measuredRounds = runsMetrics.map(m => m.rounds_to_merge).filter(r => r != null)
  const missedBy = {}
  for (const m of runsMetrics) {
    for (const [k, v] of Object.entries(m.findings_missed_by || {})) missedBy[k] = (missedBy[k] || 0) + v
  }
  return {
    runs: finished,
    low_sample: lowSample,
    // The headline. Reported alongside its own sample size, because an
    // unmeasured run is not a run that took one round.
    median_rounds_to_merge: median(measuredRounds),
    runs_with_round_ledger: measuredRounds.length,
    total_findings_after_pr: sum(runsMetrics.map(m => m.findings_after_pr || 0)),
    findings_missed_by: missedBy,
    // Did the loop close? Every run that is not captured is a run whose lessons
    // no future run can use — the rate this pipeline's round count depends on.
    learning_capture_rate: finished ? round(runsMetrics.filter(m => m.learnings_captured).length / finished) : null,
    median_human_rounds: median(runsMetrics.map(m => m.human_rounds).filter(r => r != null)),
    mean_first_pass_green_rate: mean(fpRates),
    mean_gate_edit_rate: mean(withGates.map(m => m.gate_edit_rate).filter(r => r != null)),
    total_gate_edits: sum(runsMetrics.map(m => m.gate_edits)),
    total_blocked: sum(runsMetrics.map(m => m.blocked_total)),
    total_agents_spawned: sum(runsMetrics.map(m => m.agents_spawned)),
    total_rework_cycles: sum(runsMetrics.map(m => m.rework_cycles || 0)),
    total_feedback_notes: sum(runsMetrics.map(m => m.feedback_notes)),
    note: lowSample
      ? `only ${finished} finished run(s) — the mean rates below are anecdotal, NOT a trend; don't read a single run as a quality signal. Need ${MIN_TREND_RUNS}+ runs.`
      : `median_rounds_to_merge is THE target (aim ≤2) — read it together with runs_with_round_ledger, since runs without a recorded round are unmeasured, not clean. findings_missed_by names the probes the knowledge store still owes; learning_capture_rate says whether any of it is being written down. human_rounds/first_pass_green_rate/gate_edit_rate remain the in-run quality signals.`
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
const median = xs => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const round = n => Math.round(n * 100) / 100
const mean = xs => (xs.length ? round(sum(xs) / xs.length) : null)
const tally = xs => xs.reduce((acc, x) => ((acc[x] = (acc[x] || 0) + 1), acc), {})
