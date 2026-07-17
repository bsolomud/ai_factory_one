import fs from 'node:fs'
import path from 'node:path'

export class StateError extends Error {}

const REQUIRED_KEYS = ['schema_version', 'run_id', 'repo', 'stage', 'stage_status', 'substate', 'gates']
const STAGE_STATUSES = ['in_progress', 'awaiting_gate', 'complete']

export function newState({ runId, repo, stage, base, branch }) {
  return {
    schema_version: 1,
    run_id:         runId,
    repo,
    stage,
    stage_status:   'in_progress',
    substate:       { critic_round: 0, subtask: null, of: null },
    autonomy:       'gated',
    gates:          [],
    git:            { branch: branch || null, base: base || 'master', last_sha: null },
    session_ids:    {},
    unverified:     []
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
