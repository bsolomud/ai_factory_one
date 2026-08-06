import fs from 'node:fs'
import path from 'node:path'
import { currentBranch, loadProfile, matchesAny } from './profile.js'
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

// Pipeline enforcement is OPT-IN PER SESSION. It applies only after the
// developer runs a `/pipeline` command in this session (UserPromptSubmit →
// `guard mark`), and is cleared when the session ends (SessionEnd →
// `guard unmark`). Without this, a leftover active run would hijack every
// unrelated session in the same repo — the developer must never be forced into
// pipeline mode without asking for it. The TTL is only a leak guard for when
// SessionEnd doesn't fire; active `/pipeline` use refreshes the marker.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

function markerPath(sessionId) {
  // Sanitize: session ids are host-generated, but never build a path from an
  // id containing separators or traversal.
  if (!sessionId || typeof sessionId !== 'string' || /[^\w.-]/.test(sessionId)) return null
  return path.join(paths.home(), 'active-sessions', sessionId)
}

function sessionEngaged(sessionId) {
  const p = markerPath(sessionId)
  if (!p) return false
  try {
    const st = fs.statSync(p) // throws if absent → not engaged
    if (Date.now() - st.mtimeMs > MARKER_TTL_MS) { fs.rmSync(p, { force: true }); return false }
    return true
  } catch {
    return false
  }
}

export function guard(mode, input) {
  // Session bookkeeping modes run regardless of repo/run state.
  if (mode === 'mark') return markSession(input)
  if (mode === 'unmark') return unmarkSession(input)
  try {
    const cwd = input.cwd || process.cwd()
    const repoDir = paths.gitRoot(cwd)
    if (!repoDir) return allow()
    const slug = paths.repoSlug(repoDir)
    const profile = loadProfile(paths.profilePath(slug))
    if (!profile) return allow() // not a pipeline-onboarded repo
    const run = activeRun(slug, repoDir)
    if (!run) return allow() // no run in flight — normal Claude usage
    // The decisive gate: enforce ONLY if this session engaged the pipeline.
    if (!sessionEngaged(input.session_id)) return allow()
    if (mode === 'bash') return guardBash(input.tool_input?.command || '', run)
    if (mode === 'write') return guardWrite(input.tool_input?.file_path || '', { repoDir, profile, run, cwd })
    return allow()
  } catch {
    return allow() // fail open, always
  }
}

// UserPromptSubmit hook: a prompt containing a `/pipeline` command engages the
// pipeline for this session. Anything else leaves the session untouched.
function markSession(input) {
  try {
    if (!/\/pipeline\b/.test(input.prompt || '')) return allow()
    const p = markerPath(input.session_id)
    if (p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${new Date().toISOString()}\n`) }
  } catch { /* fail open — never break prompt submission */ }
  return allow()
}

// SessionEnd hook: drop the marker so enforcement never outlives the session.
function unmarkSession(input) {
  try {
    const p = markerPath(input.session_id)
    if (p) fs.rmSync(p, { force: true })
  } catch { /* best effort; TTL is the backstop */ }
  return allow()
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

// Resolve the run this session is actually working in. One active run is
// unambiguous. With several coding in the same clone, match the checked-out
// branch against each run's recorded working branch (`branch_recorded` at the
// first post-BREAKDOWN advance) — enforcement keyed to an arbitrary run applies
// the WRONG run's stage rules. No single match → fail open, never guess.
function activeRun(slug, repoDir) {
  const runsDir = path.join(paths.repoHome(slug), 'runs')
  if (!fs.existsSync(runsDir)) return null
  const active = []
  for (const id of fs.readdirSync(runsDir)) {
    const runDir = path.join(runsDir, id)
    try {
      const state = readState(runDir)
      if (state.stage !== 'DONE') active.push({ state, runDir })
    } catch { /* corrupt state → reconcile's job, not the guard's */ }
  }
  if (active.length <= 1) return active[0] ?? null
  const branch = currentBranch(repoDir)
  const matches = branch ? active.filter(r => r.state.git?.branch === branch) : []
  return matches.length === 1 ? matches[0] : null
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
