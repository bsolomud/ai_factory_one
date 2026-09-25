import fs from 'node:fs'
import path from 'node:path'

export class StateError extends Error {}

const REQUIRED_KEYS = ['schema_version', 'run_id', 'repo', 'stage', 'stage_status', 'substate', 'gates']
const STAGE_STATUSES = ['in_progress', 'awaiting_gate', 'complete']

// The skip-kind taxonomy check_skipped events persist into events.jsonl.
// Owned HERE because it is a cross-file protocol: validators write kinds,
// metrics buckets by them, and events are frozen on disk — a typo'd kind
// would be a permanently misclassified event no writer-side fix can repair.
export const SKIP_KINDS = ['no_command', 'not_configured', 'no_target', 'declared_na', 'other']

// The round ledger's vocabulary — the same reason SKIP_KINDS lives here: these
// strings are frozen into events.jsonl, and metrics buckets by them.
//
// A ROUND is one pass of feedback over the shipped change. The pilot target
// ("close any task in ≤2 rounds") is about the rounds that arrive from OUTSIDE
// the run — a reviewer on the PR, a red CI — and until this ledger existed the
// metrics counted only in-run corrections, so a run with two PR rounds still
// reported human_rounds: 0. You cannot drive to ≤2 a number nobody records.
export const ROUND_SOURCES = ['pre-pr', 'pr', 'ci']

// What a finding was ABOUT, which is the same question as "which probe would
// have caught it". `missed_by` names that probe (or 'none' when nothing
// reasonably could) — that pairing is what turns a round into a probe the next
// run runs, instead of a lesson nobody can act on.
export const FINDING_CLASSES = ['coupling', 'population', 'proof', 'correctness', 'style', 'scope', 'other']

export function newState({ runId, repo, stage, base, branch, baselineUntracked, worktree, startSha }) {
  return {
    schema_version: 1,
    run_id:         runId,
    repo,
    stage,
    stage_status:   'in_progress',
    substate:       { critic_round: 0, subtask: null, of: null },
    autonomy:       'gated',
    gates:          [],
    // start_sha: where HEAD stood when the run was created. The base says what
    // "this change" is diffed FROM; start_sha says what existed BEFORE the run
    // touched anything — which is the only way to tell a file this run changed
    // from a file that was already different when it began. Used to diagnose a
    // wrong base at the moment it hurts. Absent on runs created before it
    // existed; every reader treats that as "unknown", never as "nothing".
    git:            { branch: branch || null, base: base || 'master', start_sha: startSha || null, worktree: worktree || null, last_sha: null, baseline_untracked: baselineUntracked || [] },
    session_ids:    {},
    unverified:     [],
    // Slots the developer declared not-applicable for this run's shape (e.g. a
    // lockfile-only dependency bump), via `declare-na`. Only re-labels a skip
    // that would happen anyway — never silences a runnable check.
    slots_na:       {}
  }
}

export function statePath(runDir) {
  return path.join(runDir, 'state.json')
}

// Throws StateError on missing/corrupt state — callers route that to reconcile.
export function readState(runDir) {
  const file = statePath(runDir)
  if (!fs.existsSync(file)) throw new StateError(`state.json not found in ${runDir}`)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new StateError(`state.json is corrupt: ${e.message}`)
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) throw new StateError(`state.json missing required key '${key}'`)
  }
  if (parsed.schema_version !== 1) throw new StateError(`unsupported schema_version ${parsed.schema_version}`)
  if (!STAGE_STATUSES.includes(parsed.stage_status) && parsed.stage !== 'DONE') {
    throw new StateError(`invalid stage_status '${parsed.stage_status}'`)
  }
  return parsed
}

// Atomic: a crash never leaves a half-written state file.
export function writeState(runDir, state) {
  fs.mkdirSync(runDir, { recursive: true })
  const file = statePath(runDir)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function appendEvent(runDir, event) {
  fs.mkdirSync(runDir, { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), line + '\n')
}

// Tolerant reader: a torn final line must never make the audit log unreadable.
export function readEvents(runDir) {
  const file = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* torn write — skip */ }
  }
  return events
}
