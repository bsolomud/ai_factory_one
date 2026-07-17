import fs from 'node:fs'
import path from 'node:path'
import { loadProfile } from './profile.js'
import { matchesAny } from './profile.js'
import { readState } from './state.js'
import * as paths from './paths.js'

// PreToolUse hook: enforcement OUTSIDE the model. Exit 0 = allow,
// exit 2 = deny (stderr is fed back to the model, so every denial says why
// and what to do instead).
//
// HARD REQUIREMENT: fail OPEN. These are user-level hooks firing on all normal
// Claude usage — any internal error, missing profile, or absent run must never
// break a non-pipeline session.

// Repo writes are allowed only in stages that legitimately change code
// (IMPLEMENT/TEST plus the REVIEW/CI fix loops; SCRIBE may apply a
// human-approved doc diff).
const WRITE_STAGES = ['IMPLEMENT', 'TEST', 'REVIEW', 'CI', 'SCRIBE']
const COMMIT_STAGES = ['IMPLEMENT', 'TEST', 'REVIEW', 'CI']

export function guard(mode, input) {
  try {
    const cwd = input.cwd || process.cwd()
    const repoDir = paths.gitRoot(cwd)
    if (!repoDir) return allow()
    const slug = paths.repoSlug(repoDir)
    const profile = loadProfile(paths.profilePath(slug))
    if (!profile) return allow() // not a pipeline-onboarded repo
    const run = activeRun(slug)
    if (!run) return allow() // no run in flight — normal Claude usage
    if (mode === 'bash') return guardBash(input.tool_input?.command || '', run)
    if (mode === 'write') return guardWrite(input.tool_input?.file_path || '', { repoDir, profile, run, cwd })
    return allow()
  } catch {
    return allow() // fail open, always
  }
}

function guardBash(command, { state }) {
  // Note: `pipeline approve` is NOT hook-blocked. The gate contract lives in
  // the skill: the model may only run it after presenting the gate summary
  // and receiving the developer's explicit confirmation in chat; every
  // approval is recorded in gates[] + events.jsonl for audit.
  if (/\bgit\s+push\b/.test(command)) {
    const prApproved = state.gates.some(g => g.stage === 'PR' && g.approved) || ['CI', 'SCRIBE', 'DONE'].includes(state.stage)
    if (!prApproved) {
      return deny(`git push is blocked until the PR-stage gate is approved (run is at ${state.stage}). Finish the pipeline stages; the developer approves the PR draft, then pushing is allowed.`)
    }
  }
  if (/\bgit\s+commit\b/.test(command) && !COMMIT_STAGES.includes(state.stage)) {
    return deny(`git commit is not allowed during the ${state.stage} stage — code changes happen in ${COMMIT_STAGES.join('/')}. If this change is needed, it belongs to a subtask (or a plan amendment).`)
  }
  return allow()
}

// Canonicalize a possibly-not-yet-existing path (macOS: /var → /private/var
// symlinks break naive prefix comparison against git's resolved toplevel).
function realish(p) {
  let head = p
  const tail = []
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head)
    if (parent === head) return p
    tail.unshift(path.basename(head))
    head = parent
  }
  return path.join(fs.realpathSync.native(head), ...tail)
}

function guardWrite(filePath, { repoDir, profile, run, cwd }) {
  if (!filePath) return allow()
  const abs = realish(path.resolve(realish(cwd), filePath))
  repoDir = realish(repoDir)
  run = { ...run, runDir: realish(run.runDir) }

  // Pipeline state is CLI-written ONLY — a model editing its own state file is
  // how these systems corrupt themselves.
  const base = path.basename(abs)
  if (abs.startsWith(run.runDir + path.sep) && (base === 'state.json' || base === 'events.jsonl')) {
    return deny(`${base} is written only by the pipeline CLI — never edit it directly. Use 'pipeline advance' / 'pipeline set-substate' instead.`)
  }
  if (!abs.startsWith(repoDir + path.sep)) return allow() // outside the repo (incl. run artifacts)

  const rel = path.relative(repoDir, abs)
  if (matchesAny(rel, profile.no_touch || [])) {
    return deny(`${rel} matches a no_touch rule in this repo's pipeline profile — the pipeline must never modify it. If the change is genuinely required, the developer must make it manually.`)
  }
  if (!WRITE_STAGES.includes(run.state.stage)) {
    return deny(`repo writes are not allowed during the ${run.state.stage} stage (pipeline run ${run.state.run_id} is active). ${run.state.stage} only produces its artifact in the run directory; code changes happen in IMPLEMENT.`)
  }
  return allow()
}

function activeRun(slug) {
  const runsDir = path.join(paths.repoHome(slug), 'runs')
  if (!fs.existsSync(runsDir)) return null
  for (const id of fs.readdirSync(runsDir)) {
    const runDir = path.join(runsDir, id)
    try {
      const state = readState(runDir)
      if (state.stage !== 'DONE') return { state, runDir }
    } catch { /* corrupt state → reconcile's job, not the guard's */ }
  }
  return null
}

const allow = () => ({ decision: 'allow', exitCode: 0 })
const deny = message => ({ decision: 'deny', exitCode: 2, message })

export function main(argv, stdinText) {
  let input = {}
  try { input = JSON.parse(stdinText || '{}') } catch { /* fail open */ }
  const result = guard(argv[0], input)
  if (result.decision === 'deny') process.stderr.write(result.message + '\n')
  process.exitCode = result.exitCode
  return result
}
