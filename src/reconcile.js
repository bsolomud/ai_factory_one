import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isComplete } from './artifacts.js'
import { newState, readEvents, readState, StateError, writeState } from './state.js'

// Crash recovery, run automatically by `status`. Priority of truth:
// git > artifacts > state.json > session memory. Nothing "remembers" across
// sessions; every session reconstructs the world from disk.
export function reconcile({ runDir, repoDir, config, runId, repoSlug }) {
  const notes = []
  let state
  let rebuilt = false

  try {
    state = readState(runDir)
  } catch (e) {
    if (!(e instanceof StateError)) throw e
    state = rebuildState({ runDir, config, runId, repoSlug })
    rebuilt = true
    notes.push(`state.json was ${fs.existsSync(path.join(runDir, 'state.json')) ? 'corrupt' : 'missing'} — rebuilt from artifacts and events.jsonl (${e.message})`)
    writeState(runDir, state)
  }

  // Crash between artifact completion and `advance`.
  const def = config.stages[state.stage]
  if (def?.output && state.stage_status === 'in_progress' && isComplete(path.join(runDir, def.output))) {
    notes.push(`the ${state.stage} output artifact is stamped complete — the stage looks finished; run 'pipeline advance'`)
  }

  // IMPLEMENT reconciliation: git wins over the cursor.
  if (def?.per_subtask && state.substate.subtask != null && repoDir) {
    const base = state.git?.base || 'master'
    let commits = null
    try {
      commits = parseInt(execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: repoDir, encoding: 'utf8' }).trim(), 10)
    } catch { /* branch missing — the stage prompt will surface it */ }
    if (commits !== null) {
      if (commits >= state.substate.subtask) {
        notes.push(`git shows ${commits} commit(s) — subtask ${state.substate.subtask} appears committed; run 'pipeline advance' to verify and gate it`)
      } else {
        notes.push(`git shows ${commits} commit(s), below the subtask cursor (${state.substate.subtask}) — subtask ${state.substate.subtask} was interrupted mid-work`)
      }
      if (dirtyTree(repoDir)) {
        notes.push(`the working tree has uncommitted changes — review them against subtask ${state.substate.subtask} before continuing`)
      }
    }
  }

  return { state, notes, rebuilt }
}

// Plan §7: highest-numbered artifact stamped complete → its stage; whether we
// sit AT that stage (awaiting gate) or PAST it comes from events.jsonl gates.
function rebuildState({ runDir, config, runId, repoSlug }) {
  let lastComplete = null
  for (const name of config.order) {
    const def = config.stages[name]
    if (def.output && isComplete(path.join(runDir, def.output))) lastComplete = name
  }

  const events = readEvents(runDir)
  const gates = events.filter(e => e.event === 'gate_approved')
    .map(e => ({ stage: e.stage, subtask: e.subtask ?? null, approved: true, by: e.by || 'human', at: e.at, note: e.note || '' }))
  const base = events.find(e => e.event === 'run_created')?.base || 'master'

  const state = newState({ runId, repo: repoSlug, stage: config.first, base })
  state.gates = gates

  if (lastComplete) {
    const approved = gates.some(g => g.stage === lastComplete)
    if (approved) {
      const next = config.stages[lastComplete].next
      state.stage = next
      state.stage_status = next === 'DONE' ? 'complete' : 'in_progress'
      if (next === 'DONE') state.stage = 'DONE'
    } else {
      state.stage = lastComplete
      state.stage_status = 'awaiting_gate'
    }
  }
  // Restore substate counters from the last recorded substate events.
  for (const e of events) {
    if (e.event === 'substate' && e.key in state.substate) state.substate[e.key] = e.value
  }
  return state
}

function dirtyTree(repoDir) {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}
